'use strict';

const oracledb = require('oracledb');
const { query } = require('./db');

// node-fetch v3 is ESM-only; cache the dynamic import so we pay the cost once.
let _fetch = null;
async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default;
  return _fetch;
}

const BASE_URLS = {
  test:       'https://api-test.informatika.si/mojelektro/v1',
  production: 'https://api.informatika.si/mojelektro/v1',
};

const READING_TYPES = {
  'A+': {
    readingType: '32.0.2.4.1.2.12.0.0.0.0.0.0.0.0.3.72.0',
    unit: 'kWh',
    intervalMinutes: 15,
  },
  'A-': {
    readingType: '32.0.2.4.19.2.12.0.0.0.0.0.0.0.0.3.72.0',
    unit: 'kWh',
    intervalMinutes: 15,
  },
  'R+': {
    readingType: '32.0.2.4.1.2.12.0.0.0.0.0.0.0.0.3.73.0',
    unit: 'kVArh',
    intervalMinutes: 15,
  },
  'R-': {
    readingType: '32.0.2.4.19.2.12.0.0.0.0.0.0.0.0.3.73.0',
    unit: 'kVArh',
    intervalMinutes: 15,
  },
  'P+': {
    readingType: '32.0.2.4.1.2.37.0.0.0.0.0.0.0.0.3.38.0',
    unit: 'kW',
    intervalMinutes: 15,
  },
  'P-': {
    readingType: '32.0.2.4.19.2.37.0.0.0.0.0.0.0.0.3.38.0',
    unit: 'kW',
    intervalMinutes: 15,
  },
  'Q+': {
    readingType: '32.0.2.4.1.2.37.0.0.0.0.0.0.0.0.3.63.0',
    unit: 'kVAr',
    intervalMinutes: 15,
  },
  'Q-': {
    readingType: '32.0.2.4.19.2.37.0.0.0.0.0.0.0.0.3.63.0',
    unit: 'kVAr',
    intervalMinutes: 15,
  },
  'A+_T0': {
    readingType: '8.0.4.1.1.2.12.0.0.0.0.0.0.0.0.3.72.0',
    unit: 'kWh',
    intervalMinutes: 1440,
  },
  'A+_T1': {
    readingType: '8.0.4.1.1.2.12.0.0.0.0.1.0.0.0.3.72.0',
    unit: 'kWh',
    intervalMinutes: 1440,
  },
  'A+_T2': {
    readingType: '8.0.4.1.1.2.12.0.0.0.0.2.0.0.0.3.72.0',
    unit: 'kWh',
    intervalMinutes: 1440,
  },
};

const REGISTER_ALIASES = {
  '1.8.0': 'A+',
  '2.8.0': 'A-',
};

function getBaseUrl() {
  const env = (process.env.MOJELEKTRO_ENV || 'test').toLowerCase();
  return BASE_URLS[env] || BASE_URLS.test;
}

function getHeaders() {
  return {
    'X-API-TOKEN': process.env.MOJELEKTRO_API_KEY,
    'Accept':      'application/json',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Generic fetch wrapper with audit logging. */
async function apiFetch(path, params = {}) {
  const url = new URL(getBaseUrl() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const retryDelaysMs = [0, 700, 1600];

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const startMs = Date.now();
    let httpStatus = null;
    let errorMessage = null;

    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    try {
      const fetch = await getFetch();
      const res = await fetch(url.toString(), { headers: getHeaders() });
      httpStatus = res.status;

      const responseMs = Date.now() - startMs;
      logRequest(path, params, httpStatus, responseMs, null).catch(() => {});

      if (!res.ok) {
        const body = await res.text();
        const error = Object.assign(new Error(`API error ${res.status}`), { status: res.status, body });
        if (res.status === 429 && attempt < retryDelaysMs.length - 1) {
          continue;
        }
        throw error;
      }

      return res.json();
    } catch (err) {
      errorMessage = err.message;
      logRequest(path, params, httpStatus, Date.now() - startMs, errorMessage).catch(() => {});

      if ((err.status === 429 || httpStatus === 429) && attempt < retryDelaysMs.length - 1) {
        continue;
      }

      throw err;
    }
  }
}

function normalizeRegisterCode(registerCode) {
  const normalized = String(registerCode || 'A+').trim().toUpperCase();
  const canonical = REGISTER_ALIASES[normalized] || normalized;

  if (!READING_TYPES[canonical]) {
    throw Object.assign(
      new Error('Unsupported registerCode. Use one of: A+, A-, R+, R-, P+, P-, Q+, Q-, A+_T0, A+_T1, A+_T2.'),
      { status: 400 }
    );
  }

  return canonical;
}

async function logRequest(endpoint, params, httpStatus, responseMs, errorMessage) {
  try {
    await query(
      `INSERT INTO api_request_log (endpoint, params_json, http_status, response_ms, error_message)
       VALUES (:endpoint, :params_json, :http_status, :response_ms, :error_message)`,
      {
        endpoint:      { val: endpoint,              type: oracledb.STRING },
        params_json:   { val: JSON.stringify(params), type: oracledb.STRING },
        http_status:   { val: httpStatus,             type: oracledb.NUMBER },
        response_ms:   { val: responseMs,             type: oracledb.NUMBER },
        error_message: { val: errorMessage,           type: oracledb.STRING },
      }
    );
  } catch (_) { /* never let logging crash the app */ }
}

// ----------------------------------------------------------------
// Public API methods
// ----------------------------------------------------------------

async function getMeterReadings({ usagePoint, startDate, endDate, registerCode }) {
  const normalizedRegister = normalizeRegisterCode(registerCode);
  const metadata = READING_TYPES[normalizedRegister];

  const data = await apiFetch('/meter-readings', {
    usagePoint,
    startTime: startDate,
    endTime: endDate,
    option: `ReadingType=${metadata.readingType}`,
  });

  return {
    usagePoint,
    registerCode: normalizedRegister,
    intervalBlocks: (data.intervalBlocks || []).map(block => ({
      readingType: block.readingType,
      registerCode: normalizedRegister,
      unit: metadata.unit,
      intervalMinutes: metadata.intervalMinutes,
      intervalReadings: block.intervalReadings || [],
    })),
  };
}

async function getMerilnoMesto(identifikator) {
  return apiFetch(`/merilno-mesto/${encodeURIComponent(identifikator)}`);
}

async function getMerilnaTocka(gsrn) {
  return apiFetch(`/merilna-tocka/${encodeURIComponent(gsrn)}`);
}

async function getReadingQualities() {
  return apiFetch('/reading-qualities');
}

async function getReadingTypes() {
  return apiFetch('/reading-type');
}

module.exports = {
  getMeterReadings,
  getMerilnoMesto,
  getMerilnaTocka,
  getReadingQualities,
  getReadingTypes,
  normalizeRegisterCode,
};
