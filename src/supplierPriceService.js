'use strict';

const oracledb = require('oracledb');
const db = require('./db');

let _fetch = null;
async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default;
  return _fetch;
}

const CACHE_TTL_HOURS = 12;

// In-memory fallback if DB is temporarily unavailable
const memCache = new Map();

async function getCurrentSupplierPrices({ supplier }) {
  if (!supplier) {
    throw Object.assign(new Error('Supplier is not available for this usage point.'), { status: 404 });
  }

  const normalizedSupplier = normalizeSupplierName(supplier);

  if (normalizedSupplier.includes('GEN-I')) {
    return getGenIHouseholdTariffs();
  }

  throw Object.assign(
    new Error(`Automatic web price lookup is not implemented for supplier "${supplier}".`),
    { status: 404 }
  );
}

async function getGenIHouseholdTariffs() {
  const supplierKey = 'gen-i:household:regular';

  // 1. Check DB cache
  try {
    const cached = await db.query(
      `SELECT supplier_name, tariff_name, source_url, valid_from,
              vt_price_per_kwh, mt_price_per_kwh,
              TO_CHAR(fetched_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS fetched_at
         FROM supplier_prices
        WHERE supplier_key = :supplierKey
          AND fetched_at > SYSTIMESTAMP - INTERVAL '${CACHE_TTL_HOURS}' HOUR
        ORDER BY fetched_at DESC
        FETCH FIRST 1 ROWS ONLY`,
      { supplierKey: { val: supplierKey, type: oracledb.STRING } }
    );

    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      return {
        supplier:       row.SUPPLIER_NAME,
        tariffName:     row.TARIFF_NAME,
        sourceUrl:      row.SOURCE_URL,
        validFrom:      row.VALID_FROM,
        vtPricePerKwh:  Number(row.VT_PRICE_PER_KWH),
        mtPricePerKwh:  Number(row.MT_PRICE_PER_KWH),
        fetchedAt:      row.FETCHED_AT,
      };
    }
  } catch (_) {
    // DB unavailable — fall through to memory cache or web scrape
  }

  // 2. In-memory fallback cache
  const mem = memCache.get(supplierKey);
  if (mem && (Date.now() - mem.ts) < CACHE_TTL_HOURS * 60 * 60 * 1000) {
    return mem.value;
  }

  // 3. Scrape from web
  const sourceUrl = 'https://gen-i.si/dom/elektricna-energija/ceniki-in-akcije/redni-cenik-elektricne-energije-za-gospodinjske-odjemalce/';
  const html = await fetchText(sourceUrl);
  const text = htmlToText(html);
  const vtPricePerKwh = extractDecimal(text, /Višja tarifa\s*:\s*([0-9]+,[0-9]+)/i);
  const mtPricePerKwh = extractDecimal(text, /Manjša tarifa\s*:\s*([0-9]+,[0-9]+)/i);

  if (!Number.isFinite(vtPricePerKwh) || vtPricePerKwh <= 0 ||
      !Number.isFinite(mtPricePerKwh) || mtPricePerKwh <= 0) {
    throw Object.assign(new Error('Could not parse valid tariff prices from supplier page.'), { status: 502 });
  }

  const validFrom = extractDate(text);
  const supplierName = 'GEN-I D.O.O.';
  const tariffName = 'Redni cenik električne energije za gospodinjske odjemalce';

  const value = {
    supplier:      supplierName,
    tariffName,
    sourceUrl,
    validFrom,
    vtPricePerKwh,
    mtPricePerKwh,
    fetchedAt:     new Date().toISOString(),
  };

  // 4. Persist to DB (each scrape is a new row = history)
  try {
    await db.query(
      `INSERT INTO supplier_prices
         (supplier_key, supplier_name, tariff_name, source_url, valid_from, vt_price_per_kwh, mt_price_per_kwh)
       VALUES (:supplierKey, :supplierName, :tariffName, :sourceUrl, :validFrom, :vtPrice, :mtPrice)`,
      {
        supplierKey:  { val: supplierKey,   type: oracledb.STRING },
        supplierName: { val: supplierName,  type: oracledb.STRING },
        tariffName:   { val: tariffName,    type: oracledb.STRING },
        sourceUrl:    { val: sourceUrl,     type: oracledb.STRING },
        validFrom:    { val: validFrom,     type: oracledb.STRING },
        vtPrice:      { val: vtPricePerKwh, type: oracledb.NUMBER },
        mtPrice:      { val: mtPricePerKwh, type: oracledb.NUMBER },
      }
    );
  } catch (_) { /* never let persistence crash the response */ }

  // 5. Update memory cache
  memCache.set(supplierKey, { value, ts: Date.now() });

  return value;
}

async function getSupplierPricesHistory() {
  const result = await db.query(
    `SELECT supplier_key, supplier_name, tariff_name, valid_from,
            vt_price_per_kwh, mt_price_per_kwh,
            TO_CHAR(fetched_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS fetched_at
       FROM supplier_prices
      ORDER BY fetched_at DESC
      FETCH FIRST 200 ROWS ONLY`
  );
  return result.rows;
}

async function fetchText(url) {
  const fetch = await getFetch();
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'EMA/1.0 (+supplier tariff lookup)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Supplier price fetch failed with ${response.status}`), { status: 502 });
  }

  return response.text();
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDecimal(text, pattern) {
  const match = text.match(pattern);
  if (!match) {
    throw Object.assign(new Error('Could not parse supplier tariff page.'), { status: 502 });
  }

  return Number(match[1].replace(',', '.'));
}

function extractDate(text) {
  const match = text.match(/veljavne od\s+(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/i)
    || text.match(/velja od vključno\s+(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/i)
    || text.match(/velja od\s+(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/i);

  return match ? match[1].replace(/\s+/g, '') : null;
}

function normalizeSupplierName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[.,]/g, '')
    .trim();
}

module.exports = {
  getCurrentSupplierPrices,
  getSupplierPricesHistory,
};
