'use strict';

const oracledb = require('oracledb');
const db       = require('./db');
const api      = require('./mojelektroClient');
const supplierPriceService = require('./supplierPriceService');

const VAT_RATE = 0.22;
const OPERATOR_MARKET_FEE_PER_KWH = 0.00013;
const ENERGY_EFFICIENCY_FEE_PER_KWH = 0.00080;
const EXCISE_DUTY_PER_KWH = 0.00153;
const OVE_SPTE_FEE_PER_KW_MONTH = 0.77562;
const DEFAULT_VT_PRICE_PER_KWH = 0.11990;
const DEFAULT_MT_PRICE_PER_KWH = 0.09790;
const DEFAULT_MONTHLY_FEE = 1.99;
const DEFAULT_MONTHLY_DISCOUNT = -1.00;
const MAX_API_RANGE_DAYS = 30;

const NETWORK_TARIFFS_2026 = {
  validFrom: '2026-01-01',
  highSeason: {
    powerPerKwMonth: { 1: 1.71126, 2: 0.91224, 3: 0.16297, 4: 0.00407, 5: 0 },
    energyPerKwh: { 1: 0.01998, 2: 0.01833, 3: 0.01809, 4: 0.01855, 5: 0 },
    activeBlocks: [1, 2, 3, 4],
    ovespteBlock: 1,
  },
  lowSeason: {
    powerPerKwMonth: { 1: 0, 2: 1.09230, 3: 0.28902, 4: 0.02436, 5: 0.00245 },
    energyPerKwh: { 1: 0, 2: 0.01998, 3: 0.01717, 4: 0.01805, 5: 0.01299 },
    activeBlocks: [2, 3, 4, 5],
    ovespteBlock: 2,
  },
};

// ----------------------------------------------------------------
// Usage Points
// ----------------------------------------------------------------

async function listUsagePoints() {
  const result = await db.query(
    `SELECT id, identifier, gsrn, label, created_at
       FROM usage_points
      ORDER BY created_at DESC`
  );
  return result.rows;
}

async function saveUsagePoint({ identifier, gsrn, label }) {
  await db.query(
    `MERGE INTO usage_points dst
     USING (SELECT :identifier AS identifier FROM dual) src
        ON (dst.identifier = src.identifier)
      WHEN MATCHED THEN
           UPDATE SET gsrn = :gsrn, label = :label
      WHEN NOT MATCHED THEN
           INSERT (identifier, gsrn, label) VALUES (:identifier2, :gsrn2, :label2)`,
    {
      identifier:  { val: identifier, type: oracledb.STRING },
      gsrn:        { val: gsrn || null, type: oracledb.STRING },
      label:       { val: label || null, type: oracledb.STRING },
      identifier2: { val: identifier, type: oracledb.STRING },
      gsrn2:       { val: gsrn || null, type: oracledb.STRING },
      label2:      { val: label || null, type: oracledb.STRING },
    }
  );
}

async function syncUsagePointGsrn(identifier, gsrn) {
  if (!identifier || !gsrn) return;

  await db.query(
    `UPDATE usage_points
        SET gsrn = :gsrn
      WHERE identifier = :identifier
        AND NVL(gsrn, '_') <> :gsrn`,
    {
      identifier: { val: identifier, type: oracledb.STRING },
      gsrn: { val: gsrn, type: oracledb.STRING },
    }
  );
}

async function deleteUsagePoint(identifier) {
  await db.query(
    `DELETE FROM usage_points WHERE identifier = :identifier`,
    { identifier: { val: identifier, type: oracledb.STRING } }
  );
}

// ----------------------------------------------------------------
// Merilno Mesto (cache 1 hour)
// ----------------------------------------------------------------

async function getMerilnoMesto(identifier) {
  const cached = await db.query(
    `SELECT raw_json, fetched_at
       FROM merilna_mesta
      WHERE identifier = :id
        AND fetched_at > SYSTIMESTAMP - INTERVAL '1' HOUR`,
    { id: { val: identifier, type: oracledb.STRING } }
  );

  if (cached.rows.length > 0) {
    const data = JSON.parse(cached.rows[0].RAW_JSON);
    await syncUsagePointGsrn(identifier, extractOmtoGsrn(data));
    return data;
  }

  const data = await api.getMerilnoMesto(identifier);

  await db.query(
    `MERGE INTO merilna_mesta dst
     USING (SELECT :id AS identifier FROM dual) src
        ON (dst.identifier = src.identifier)
      WHEN MATCHED THEN
           UPDATE SET raw_json = :json, fetched_at = SYSTIMESTAMP
      WHEN NOT MATCHED THEN
           INSERT (identifier, raw_json) VALUES (:id2, :json2)`,
    {
      id:    { val: identifier,         type: oracledb.STRING },
      json:  { val: JSON.stringify(data), type: oracledb.STRING },
      id2:   { val: identifier,         type: oracledb.STRING },
      json2: { val: JSON.stringify(data), type: oracledb.STRING },
    }
  );

  await syncUsagePointGsrn(identifier, extractOmtoGsrn(data));

  return data;
}

// ----------------------------------------------------------------
// Merilna Tocka (cache 1 hour)
// ----------------------------------------------------------------

async function getMerilnaTocka(gsrn) {
  const cached = await db.query(
    `SELECT raw_json
       FROM merilne_tocke
      WHERE gsrn = :gsrn
        AND fetched_at > SYSTIMESTAMP - INTERVAL '1' HOUR`,
    { gsrn: { val: gsrn, type: oracledb.STRING } }
  );

  if (cached.rows.length > 0) {
    return JSON.parse(cached.rows[0].RAW_JSON);
  }

  const data = await api.getMerilnaTocka(gsrn);

  await db.query(
    `MERGE INTO merilne_tocke dst
     USING (SELECT :gsrn AS gsrn FROM dual) src
        ON (dst.gsrn = src.gsrn)
      WHEN MATCHED THEN
           UPDATE SET raw_json = :json, fetched_at = SYSTIMESTAMP
      WHEN NOT MATCHED THEN
           INSERT (gsrn, raw_json) VALUES (:gsrn2, :json2)`,
    {
      gsrn:  { val: gsrn,              type: oracledb.STRING },
      json:  { val: JSON.stringify(data), type: oracledb.STRING },
      gsrn2: { val: gsrn,              type: oracledb.STRING },
      json2: { val: JSON.stringify(data), type: oracledb.STRING },
    }
  );

  return data;
}

// ----------------------------------------------------------------
// Meter Readings
// ----------------------------------------------------------------

/**
 * Fetch readings from Oracle if fully cached, otherwise fetch from API,
 * persist to Oracle, and return.
 */
async function getMeterReadings({ usagePoint, startDate, endDate, registerCode }) {
  const normalizedRegisterCode = api.normalizeRegisterCode(registerCode);
  await ensureReadingsAvailable({ usagePoint, startDate, endDate, registerCode: normalizedRegisterCode });
  return queryReadingsFromDb({ usagePoint, startDate, endDate, registerCode: normalizedRegisterCode });
}

async function ensureReadingsAvailable({ usagePoint, startDate, endDate, registerCode }) {
  const cached = await hasFetchedWindow({ usagePoint, startDate, endDate, registerCode });
  if (cached) {
    const hasRows = await hasStoredReadings({ usagePoint, startDate, endDate, registerCode });
    if (hasRows) return;
  }

  const windows = splitDateRangeIntoWindows(startDate, endDate, MAX_API_RANGE_DAYS);

  for (const window of windows) {
    const windowCached = await hasFetchedWindow({
      usagePoint,
      startDate: window.startDate,
      endDate: window.endDate,
      registerCode,
    });

    if (windowCached) {
      const hasRows = await hasStoredReadings({
        usagePoint,
        startDate: window.startDate,
        endDate: window.endDate,
        registerCode,
      });
      if (hasRows) continue;
    }

    const apiData = await api.getMeterReadings({
      usagePoint,
      startDate: window.startDate,
      endDate: window.endDate,
      registerCode,
    });
    await persistReadings(usagePoint, apiData);
    await recordFetchedWindow({
      usagePoint,
      startDate: window.startDate,
      endDate: window.endDate,
      registerCode,
    });
  }
}

async function hasFetchedWindow({ usagePoint, startDate, endDate, registerCode }) {
  const result = await db.query(
    `SELECT COUNT(*) AS cnt
       FROM reading_fetch_windows
      WHERE usage_point = :usagePoint
        AND start_date <= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND end_date   >= TO_DATE(:endDate,   'YYYY-MM-DD')
        AND (
          (:registerCode IS NULL AND register_code IS NULL)
          OR
          (:registerCode IS NOT NULL AND (register_code = :registerCode OR register_code IS NULL))
        )`,
    {
      usagePoint:   { val: usagePoint,          type: oracledb.STRING },
      startDate:    { val: startDate,            type: oracledb.STRING },
      endDate:      { val: endDate,              type: oracledb.STRING },
      registerCode: { val: registerCode || null, type: oracledb.STRING },
    }
  );

  return result.rows[0].CNT > 0;
}

async function recordFetchedWindow({ usagePoint, startDate, endDate, registerCode }) {
  await db.query(
    `MERGE INTO reading_fetch_windows dst
     USING (
       SELECT
         :usagePoint   AS usage_point,
         :registerCode AS register_code,
         TO_DATE(:startDate, 'YYYY-MM-DD') AS start_date,
         TO_DATE(:endDate,   'YYYY-MM-DD') AS end_date
       FROM dual
     ) src
        ON (dst.usage_point = src.usage_point
            AND NVL(dst.register_code, '_') = NVL(src.register_code, '_')
            AND dst.start_date = src.start_date
            AND dst.end_date = src.end_date)
      WHEN MATCHED THEN
           UPDATE SET fetched_at = SYSTIMESTAMP
      WHEN NOT MATCHED THEN
           INSERT (usage_point, register_code, start_date, end_date)
           VALUES (src.usage_point, src.register_code, src.start_date, src.end_date)`,
    {
      usagePoint:   { val: usagePoint,          type: oracledb.STRING },
      registerCode: { val: registerCode || null, type: oracledb.STRING },
      startDate:    { val: startDate,            type: oracledb.STRING },
      endDate:      { val: endDate,              type: oracledb.STRING },
    }
  );
}

async function hasStoredReadings({ usagePoint, startDate, endDate, registerCode }) {
  const dateColumn = isDailyStateRegister(registerCode) ? 'interval_end' : 'interval_start';
  const result = await db.query(
    `SELECT COUNT(*) AS cnt
       FROM meter_readings
      WHERE usage_point = :usagePoint
        AND ${dateColumn} >= TO_TIMESTAMP(:startDate, 'YYYY-MM-DD')
        AND interval_end   <= TO_TIMESTAMP(:endDate,   'YYYY-MM-DD') + INTERVAL '1' DAY
        AND register_code = :registerCode`,
    {
      usagePoint:   { val: usagePoint,   type: oracledb.STRING },
      startDate:    { val: startDate,     type: oracledb.STRING },
      endDate:      { val: endDate,       type: oracledb.STRING },
      registerCode: { val: registerCode,  type: oracledb.STRING },
    }
  );

  return result.rows[0].CNT > 0;
}

async function persistReadings(usagePoint, apiData) {
  const rows = [];

  for (const block of (apiData?.intervalBlocks || [])) {
    const readingType = block.readingType || null;
    const unit = block.unit || null;
    const registerCode = block.registerCode || null;
    const intervalMinutes = Number(block.intervalMinutes || 15);

    for (const reading of (block.intervalReadings || [])) {
      const endTs = reading.timestamp || null;
      const startTs = shiftIsoTimestamp(endTs, -intervalMinutes);
      const value = reading.value != null ? Number(reading.value) : null;
      const qualityCode = Array.isArray(reading.readingQualities) && reading.readingQualities.length
        ? reading.readingQualities.map(item => item.code || item).join(',')
        : null;

      rows.push({ usagePoint, startTs, endTs, registerCode, value, unit, qualityCode, readingType });
    }
  }

  if (rows.length) {
    // batchErrors:true suppresses ORA-00001 duplicate-key errors per row without aborting the batch.
    await db.executeMany(
      `INSERT INTO meter_readings
         (usage_point, interval_start, interval_end, register_code, value, unit, quality_code, reading_type)
       VALUES
         (:usagePoint,
          TO_TIMESTAMP_TZ(:startTs, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM'),
          TO_TIMESTAMP_TZ(:endTs,   'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM'),
          :registerCode, :value, :unit, :qualityCode, :readingType)`,
      rows,
      { batchErrors: true }
    );
  }

  await refreshDailyAggregates(usagePoint);
}

async function queryReadingsFromDb({ usagePoint, startDate, endDate, registerCode }) {
  const dateColumn = isDailyStateRegister(registerCode) ? 'interval_end' : 'interval_start';
  const result = await db.query(
    `SELECT
       TO_CHAR(interval_start, 'YYYY-MM-DD"T"HH24:MI:SS') AS interval_start,
       TO_CHAR(interval_end,   'YYYY-MM-DD"T"HH24:MI:SS') AS interval_end,
       register_code,
       value,
       unit,
       quality_code,
       reading_type
     FROM meter_readings
    WHERE usage_point = :usagePoint
      AND ${dateColumn} >= TO_TIMESTAMP(:startDate, 'YYYY-MM-DD')
      AND interval_end   <= TO_TIMESTAMP(:endDate,   'YYYY-MM-DD') + INTERVAL '1' DAY
      AND (:registerCode IS NULL OR register_code = :registerCode)
    ORDER BY interval_start`,
    {
      usagePoint:   { val: usagePoint,          type: oracledb.STRING },
      startDate:    { val: startDate,            type: oracledb.STRING },
      endDate:      { val: endDate,              type: oracledb.STRING },
      registerCode: { val: registerCode || null, type: oracledb.STRING },
    }
  );
  return result.rows;
}

async function refreshDailyAggregates(usagePoint) {
  await db.query(
    `MERGE INTO daily_aggregates dst
     USING (
       SELECT
         usage_point,
         TRUNC(interval_start) AS reading_date,
         register_code,
         SUM(value)            AS total_kwh,
         MIN(value)            AS min_value,
         MAX(value)            AS max_value,
         AVG(value)            AS avg_value,
         COUNT(*)              AS reading_count
       FROM meter_readings
       WHERE usage_point = :usagePoint
       GROUP BY usage_point, TRUNC(interval_start), register_code
     ) src
        ON (dst.usage_point = src.usage_point
            AND dst.reading_date = src.reading_date
            AND NVL(dst.register_code,'_') = NVL(src.register_code,'_'))
      WHEN MATCHED THEN
           UPDATE SET total_kwh     = src.total_kwh,
                      min_value     = src.min_value,
                      max_value     = src.max_value,
                      avg_value     = src.avg_value,
                      reading_count = src.reading_count,
                      updated_at    = SYSTIMESTAMP
      WHEN NOT MATCHED THEN
           INSERT (usage_point, reading_date, register_code,
                   total_kwh, min_value, max_value, avg_value, reading_count)
           VALUES (src.usage_point, src.reading_date, src.register_code,
                   src.total_kwh, src.min_value, src.max_value, src.avg_value, src.reading_count)`,
    { usagePoint: { val: usagePoint, type: oracledb.STRING } }
  );
}

async function getDailyAggregates({ usagePoint, startDate, endDate, registerCode }) {
  const normalizedRegisterCode = api.normalizeRegisterCode(registerCode);
  await ensureReadingsAvailable({ usagePoint, startDate, endDate, registerCode: normalizedRegisterCode });

  const result = await db.query(
    `SELECT
       TO_CHAR(reading_date, 'YYYY-MM-DD') AS reading_date,
       register_code,
       total_kwh,
       min_value,
       max_value,
       avg_value,
       reading_count
     FROM daily_aggregates
    WHERE usage_point = :usagePoint
      AND reading_date >= TO_DATE(:startDate, 'YYYY-MM-DD')
      AND reading_date <= TO_DATE(:endDate,   'YYYY-MM-DD')
      AND (:registerCode IS NULL OR register_code = :registerCode)
    ORDER BY reading_date`,
    {
      usagePoint:   { val: usagePoint,          type: oracledb.STRING },
      startDate:    { val: startDate,            type: oracledb.STRING },
      endDate:      { val: endDate,              type: oracledb.STRING },
      registerCode: { val: normalizedRegisterCode, type: oracledb.STRING },
    }
  );
  return result.rows;
}

async function getCostEstimate({ usagePoint, startDate, endDate, vtPricePerKwh, mtPricePerKwh, monthlyFee, monthlyDiscount }) {
  const registerCode = api.normalizeRegisterCode('A+');
  await ensureReadingsAvailable({ usagePoint, startDate, endDate, registerCode });

  const readings = await queryReadingsFromDb({ usagePoint, startDate, endDate, registerCode });
  const merilnoMesto = await getMerilnoMesto(usagePoint);
  const gsrn = extractOmtoGsrn(merilnoMesto);
  const merilnaTocka = gsrn ? await getMerilnaTocka(gsrn) : null;
  const activePowerAgreement = getActivePowerAgreement(merilnaTocka?.dogovorjeneMoci || [], endDate);
  const vtPrice = normalizePrice(vtPricePerKwh, DEFAULT_VT_PRICE_PER_KWH);
  const mtPrice = normalizePrice(mtPricePerKwh, DEFAULT_MT_PRICE_PER_KWH);
  const fixedMonthlyFee = normalizePrice(monthlyFee, DEFAULT_MONTHLY_FEE);
  const fixedMonthlyDiscount = normalizePrice(monthlyDiscount, DEFAULT_MONTHLY_DISCOUNT);
  const supplierConsumption = await getSupplierConsumptionWithFallback({
    usagePoint,
    startDate,
    endDate,
    intervalReadings: readings,
  });

  const measuredConsumption = calculateBlockConsumption(readings);
  const powerCosts = calculatePowerCosts(activePowerAgreement, startDate, endDate);
  const meteredTotalKwh = readings.reduce((sum, row) => sum + Number(row.VALUE || 0), 0);
  const billedTotalKwh = (supplierConsumption.vtKwh || 0) + (supplierConsumption.mtKwh || 0);
  const totalKwh = billedTotalKwh || meteredTotalKwh;
  const blockConsumption = scaleBlockConsumption(measuredConsumption, meteredTotalKwh, totalKwh);
  const networkEnergyCosts = calculateNetworkEnergyCostsFromBlocks(blockConsumption, endDate);

  const supplyCostVT = roundCurrency((supplierConsumption.vtKwh || 0) * vtPrice);
  const supplyCostMT = roundCurrency((supplierConsumption.mtKwh || 0) * mtPrice);
  const supplyCost = roundCurrency(supplyCostVT + supplyCostMT);
  const ovespteFee = roundCurrency(calculateOvespteFee(activePowerAgreement, startDate, endDate));
  const operatorFee = roundCurrency(totalKwh * OPERATOR_MARKET_FEE_PER_KWH);
  const efficiencyFee = roundCurrency(totalKwh * ENERGY_EFFICIENCY_FEE_PER_KWH);
  const exciseDuty = roundCurrency(totalKwh * EXCISE_DUTY_PER_KWH);
  const networkPowerCost = roundCurrency(powerCosts.total);
  const networkEnergyCost = roundCurrency(networkEnergyCosts.total);
  const serviceFee = roundCurrency(calculateMonthlyFixedCharge(startDate, endDate, fixedMonthlyFee));
  const serviceDiscount = roundCurrency(calculateMonthlyFixedCharge(startDate, endDate, fixedMonthlyDiscount));

  const subtotalExVat = roundCurrency(
    supplyCost +
    networkPowerCost +
    networkEnergyCost +
    ovespteFee +
    operatorFee +
    efficiencyFee +
    exciseDuty +
    serviceFee +
    serviceDiscount
  );
  const vatAmount = roundCurrency(subtotalExVat * VAT_RATE);
  const totalInclVat = roundCurrency(subtotalExVat + vatAmount);

  return {
    usagePoint,
    gsrn,
    supplier: merilnaTocka?.dobavitelj?.naziv || null,
    dateRange: { startDate, endDate },
    tariffSource: NETWORK_TARIFFS_2026.validFrom,
    displaySeason: getSeasonName(`${endDate}T00:00:00`),
    supplierTariffs: {
      vtPricePerKwh: vtPrice,
      mtPricePerKwh: mtPrice,
      monthlyFee: fixedMonthlyFee,
      monthlyDiscount: fixedMonthlyDiscount,
      consumptionSource: supplierConsumption.source,
    },
    totals: {
      totalKwh: roundQuantity(totalKwh),
      vtKwh: roundQuantity(supplierConsumption.vtKwh),
      mtKwh: roundQuantity(supplierConsumption.mtKwh),
      supplyCostVT,
      supplyCostMT,
      supplyCost,
      networkPowerCost,
      networkEnergyCost,
      ovespteFee,
      operatorFee,
      efficiencyFee,
      exciseDuty,
      serviceFee,
      serviceDiscount,
      subtotalExVat,
      vatAmount,
      totalInclVat,
    },
    blockConsumption: Object.keys(blockConsumption).map(key => ({
      block: Number(key),
      kwh: roundQuantity(blockConsumption[key]),
      energyTariffPerKwh: getSeasonTariffForBlock(getSeasonName(`${endDate}T00:00:00`), 'energyPerKwh', key),
      energyCost: roundCurrency(networkEnergyCosts.byBlock[key] || 0),
      agreedPowerKw: activePowerAgreement?.[`casovniBlok${key}`] != null
        ? Number(activePowerAgreement[`casovniBlok${key}`])
        : null,
      powerTariffPerKwMonth: getSeasonTariffForBlock(getSeasonName(`${endDate}T00:00:00`), 'powerPerKwMonth', key),
      powerCost: roundCurrency(powerCosts.byBlock[key] || 0),
    })),
    agreedPower: activePowerAgreement ? {
      casovniBlok1: Number(activePowerAgreement.casovniBlok1),
      casovniBlok2: Number(activePowerAgreement.casovniBlok2),
      casovniBlok3: Number(activePowerAgreement.casovniBlok3),
      casovniBlok4: Number(activePowerAgreement.casovniBlok4),
      casovniBlok5: Number(activePowerAgreement.casovniBlok5),
      prikljucnaMoc: Number(activePowerAgreement.prikljucnaMoc),
      minimalnaMoc: Number(activePowerAgreement.minimalnaMoc),
      datumOd: activePowerAgreement.datumOd,
      datumDo: activePowerAgreement.datumDo,
    } : null,
  };
}

async function getCurrentSupplierPrices({ usagePoint }) {
  const merilnoMesto = await getMerilnoMesto(usagePoint);
  const gsrn = extractOmtoGsrn(merilnoMesto);
  const merilnaTocka = gsrn ? await getMerilnaTocka(gsrn) : null;
  const supplier = merilnaTocka?.dobavitelj?.naziv || null;
  const tariff = await supplierPriceService.getCurrentSupplierPrices({ supplier });

  return {
    usagePoint,
    gsrn,
    supplier,
    ...tariff,
  };
}

async function getTodayUsageOverview({ usagePoint }) {
  const requestedDate = formatDateLocal(new Date());
  const previousDate = addDays(requestedDate, -1);
  const [rows, estimateSource, supplierContext, dailyState] = await Promise.all([
    getMeterReadings({
      usagePoint,
      startDate: requestedDate,
      endDate: requestedDate,
      registerCode: 'A+',
    }),
    getLatestPublishedDayRows({ usagePoint, requestedDate, lookbackDays: 7 }),
    getSupplierContext(usagePoint),
    getTodayDailyStateSummary({ usagePoint, date: requestedDate }),
  ]);
  const intervals = buildTodayTimeline({
    date: requestedDate,
    rows,
    estimateRows: estimateSource?.rows || [],
  });
  const measuredIntervals = intervals.filter(row => row.isMeasured);
  const estimatedIntervals = intervals.filter(row => row.isEstimated);
  const visibleIntervals = intervals.filter(row => row.isMeasured || row.isEstimated);
  const totalKwh = visibleIntervals.reduce((sum, row) => sum + row.kwh, 0);
  const vtKwh = intervals
    .filter(row => (row.isMeasured || row.isEstimated) && row.tariffCode === 'VT')
    .reduce((sum, row) => sum + row.kwh, 0);
  const ntKwh = intervals
    .filter(row => (row.isMeasured || row.isEstimated) && row.tariffCode === 'NT')
    .reduce((sum, row) => sum + row.kwh, 0);
  const vtPricePerKwh = supplierContext.tariff?.vtPricePerKwh ?? DEFAULT_VT_PRICE_PER_KWH;
  const ntPricePerKwh = supplierContext.tariff?.mtPricePerKwh ?? DEFAULT_MT_PRICE_PER_KWH;
  const vtCostExVat = roundCurrency(vtKwh * vtPricePerKwh);
  const ntCostExVat = roundCurrency(ntKwh * ntPricePerKwh);
  const totalCostExVat = roundCurrency(vtCostExVat + ntCostExVat);
  const vatAmount = roundCurrency(totalCostExVat * VAT_RATE);
  const totalCostInclVat = roundCurrency(totalCostExVat + vatAmount);
  const latest = visibleIntervals[visibleIntervals.length - 1] || null;

  return {
    usagePoint,
    requestedDate,
    previousDate,
    date: requestedDate,
    estimateSourceDate: estimateSource?.date || null,
    hasEstimate: estimatedIntervals.length > 0,
    finalDataNote: 'Tocni podatki za danasnji dan bodo praviloma na voljo po polnoci.',
    supplier: supplierContext.supplier,
    pricing: {
      vtPricePerKwh,
      ntPricePerKwh,
      vatRate: VAT_RATE,
      source: supplierContext.tariff ? 'web' : 'default',
    },
    currentUsage: latest ? {
      intervalStart: latest.intervalStart,
      intervalEnd: latest.intervalEnd,
      last15mKwh: latest.kwh,
      estimatedKw: latest.estimatedKw,
      tariffCode: latest.tariffCode,
      tariffLabel: latest.tariffLabel,
      isEstimated: latest.isEstimated,
      freshnessMinutes: getFreshnessMinutes(latest.intervalEnd),
    } : null,
    dailyState,
    totals: {
      totalKwh: roundQuantity(totalKwh),
      vtKwh: roundQuantity(vtKwh),
      ntKwh: roundQuantity(ntKwh),
      vtCostExVat,
      ntCostExVat,
      totalCostExVat,
      vatAmount,
      totalCostInclVat,
      intervalsCount: measuredIntervals.length,
      estimatedIntervalsCount: estimatedIntervals.length,
      visibleIntervalsCount: visibleIntervals.length,
      timelineCount: intervals.length,
    },
    intervals,
  };
}

async function getTodayDailyStateSummary({ usagePoint, date }) {
  try {
    const [vtRows, ntRows, etRows] = await Promise.all([
      getMeterReadings({
        usagePoint,
        startDate: date,
        endDate: date,
        registerCode: 'A+_T1',
      }),
      getMeterReadings({
        usagePoint,
        startDate: date,
        endDate: date,
        registerCode: 'A+_T2',
      }),
      getMeterReadings({
        usagePoint,
        startDate: date,
        endDate: date,
        registerCode: 'A+_T0',
      }),
    ]);

    const registers = [
      mapDailyStateRegister({
        registerCode: 'A+_T1',
        label: 'Dnevno stanje VT',
        rows: vtRows,
      }),
      mapDailyStateRegister({
        registerCode: 'A+_T2',
        label: 'Dnevno stanje MT',
        rows: ntRows,
      }),
      mapDailyStateRegister({
        registerCode: 'A+_T0',
        label: 'Dnevno stanje ET',
        rows: etRows,
      }),
    ].filter(Boolean);

    return {
      snapshotDate: date,
      available: registers.length > 0,
      registers,
      totalKwh: roundQuantity(
        registers.reduce((sum, row) => sum + Number(row.valueKwh || 0), 0)
      ),
    };
  } catch (err) {
    return {
      snapshotDate: date,
      available: false,
      registers: [],
      totalKwh: null,
      error: err.message,
    };
  }
}

async function getPowerOptimization({ usagePoint, startDate, endDate }) {
  const registerCode = api.normalizeRegisterCode('A+');
  await ensureReadingsAvailable({ usagePoint, startDate, endDate, registerCode });

  const readings = await queryReadingsFromDb({ usagePoint, startDate, endDate, registerCode });
  if (!readings.length) {
    throw Object.assign(
      new Error('Ni 15-minutnih A+ podatkov za izbrano obdobje.'),
      { status: 404 }
    );
  }

  const merilnoMesto = await getMerilnoMesto(usagePoint);
  const gsrn = extractOmtoGsrn(merilnoMesto);
  const merilnaTocka = gsrn ? await getMerilnaTocka(gsrn) : null;
  const activePowerAgreement = getActivePowerAgreement(merilnaTocka?.dogovorjeneMoci || [], endDate);

  if (!activePowerAgreement) {
    throw Object.assign(
      new Error('Dogovorjena moč za izbrano merilno točko ni na voljo.'),
      { status: 404 }
    );
  }

  const observedStats = calculateObservedPowerStats(readings);
  const currentPlan = buildAgreementSummary(activePowerAgreement);
  const currentMonthlyCosts = calculateAgreementMonthlyCosts(activePowerAgreement, startDate, endDate);
  const currentExcess = calculateExcessPowerAnalysis(readings, activePowerAgreement);
  const profiles = buildPowerOptimizationProfiles({
    activePowerAgreement,
    observedStats,
    readings,
    startDate,
    endDate,
    currentMonthlyCosts,
  });
  const recommendedProfileKey = selectRecommendedProfileKey(profiles);

  return {
    usagePoint,
    gsrn,
    supplier: merilnaTocka?.dobavitelj?.naziv || null,
    dateRange: { startDate, endDate },
    analysis: {
      readingCount: readings.length,
      distinctDays: countDistinctReadingDays(readings),
      equivalentMonths: roundQuantity(getEquivalentMonths(startDate, endDate)),
      seasonMix: getMonthFractions(startDate, endDate).map(item => ({
        year: item.year,
        month: item.month,
        season: item.season,
        fraction: roundQuantity(item.fraction),
      })),
    },
    agreement: {
      current: currentPlan,
      observedOverallPeakKw: roundPower(observedStats.overallPeakKw),
      observedOverallP99Kw: roundPower(observedStats.overallP99Kw),
      activeAgreementPeriod: {
        datumOd: activePowerAgreement.datumOd || null,
        datumDo: activePowerAgreement.datumDo || null,
      },
    },
    blocks: [1, 2, 3, 4, 5].map(block => {
      const stats = observedStats.byBlock[block];
      const currentKw = Number(activePowerAgreement[`casovniBlok${block}`] || 0);
      const currentPowerCostExVat = roundCurrency(currentMonthlyCosts.byBlock[block] || 0);
      return {
        block,
        intervalsCount: stats.intervalsCount,
        currentAgreedKw: roundPower(currentKw),
        observedPeakKw: roundPower(stats.peakKw),
        observedP99Kw: roundPower(stats.p99Kw),
        observedP95Kw: roundPower(stats.p95Kw),
        observedAverageKw: roundPower(stats.avgKw),
        currentHeadroomKw: roundPower(currentKw - stats.peakKw),
        currentHeadroomPct: currentKw > 0 ? roundQuantity(((currentKw - stats.peakKw) / currentKw) * 100) : null,
        currentPowerCostExVat,
        currentPowerCostInclVat: roundCurrency(currentPowerCostExVat * (1 + VAT_RATE)),
        recommendations: profiles.reduce((acc, profile) => {
          acc[profile.key] = profile.agreement[`casovniBlok${block}`];
          return acc;
        }, {}),
      };
    }),
    currentCosts: currentMonthlyCosts,
    currentExcess,
    profiles,
    recommendedProfileKey,
    excessMonths: buildExcessMonthMatrix(currentExcess, profiles),
    note: 'Predlagane spremembe so informativne. Dogovorjeno moč lahko spremenite na portalu Moj Elektro. Priporoceni bloki upostevajo pravilo portala: blok 1 <= blok 2 <= blok 3 <= blok 4 <= blok 5.',
  };
}

async function getLatestPublishedDayRows({ usagePoint, requestedDate, lookbackDays }) {
  for (let offset = 1; offset <= lookbackDays; offset += 1) {
    const date = addDays(requestedDate, -offset);
    const rows = await getMeterReadings({
      usagePoint,
      startDate: date,
      endDate: date,
      registerCode: 'A+',
    });

    if (rows.length) return { date, rows };
  }

  return null;
}

async function getSupplierContext(usagePoint) {
  const merilnoMesto = await getMerilnoMesto(usagePoint);
  const gsrn = extractOmtoGsrn(merilnoMesto);
  const merilnaTocka = gsrn ? await getMerilnaTocka(gsrn) : null;
  const supplier = merilnaTocka?.dobavitelj?.naziv || null;

  try {
    const tariff = supplier ? await supplierPriceService.getCurrentSupplierPrices({ supplier }) : null;
    return { supplier, tariff };
  } catch (_) {
    return { supplier, tariff: null };
  }
}

function normalizePrice(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function extractOmtoGsrn(merilnoMesto) {
  return merilnoMesto?.merilneTocke?.find(point => point.vrsta === 'OMTO')?.gsrn || null;
}

function getActivePowerAgreement(agreements, referenceDate) {
  const targetDate = new Date(`${referenceDate}T00:00:00Z`);
  const matching = agreements.filter(item => {
    const from = new Date(item.datumOd);
    const to = new Date(item.datumDo);
    return from <= targetDate && targetDate <= to;
  });

  const sortable = matching.length ? matching : agreements;
  if (!sortable.length) return null;

  return sortable.sort((a, b) => {
    const byEntryDate = new Date(b.datumVnosa || b.datumOd) - new Date(a.datumVnosa || a.datumOd);
    if (byEntryDate !== 0) return byEntryDate;
    return new Date(b.datumOd) - new Date(a.datumOd);
  })[0];
}

function calculateBlockConsumption(readings) {
  const totals = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  readings.forEach(row => {
    const block = calculateTariffBlock(row.INTERVAL_END || row.INTERVAL_START);
    totals[block] += Number(row.VALUE || 0);
  });

  return totals;
}

function scaleBlockConsumption(blockConsumption, currentTotal, targetTotal) {
  if (!currentTotal || !targetTotal || currentTotal === targetTotal) return blockConsumption;

  const factor = targetTotal / currentTotal;
  const scaled = {};
  for (const block of [1, 2, 3, 4, 5]) {
    scaled[block] = blockConsumption[block] * factor;
  }
  return scaled;
}

function calculateNetworkEnergyCostsFromBlocks(blockConsumption, endDate) {
  const byBlock = {};
  let total = 0;
  const season = getSeasonName(`${endDate}T00:00:00`);

  for (const block of [1, 2, 3, 4, 5]) {
    const tariff = getSeasonTariffForBlock(season, 'energyPerKwh', block);
    const value = Number(blockConsumption[block] || 0) * tariff;
    byBlock[block] = value;
    total += value;
  }

  return { byBlock, total };
}

function calculatePowerCosts(activePowerAgreement, startDate, endDate) {
  const byBlock = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  if (!activePowerAgreement) return { byBlock, total: 0 };

  const monthFractions = getMonthFractions(startDate, endDate);

  for (const { fraction, season } of monthFractions) {
    for (const block of NETWORK_TARIFFS_2026[season].activeBlocks) {
      const agreedPower = Number(activePowerAgreement[`casovniBlok${block}`] || 0);
      byBlock[block] += agreedPower * getSeasonTariffForBlock(season, 'powerPerKwMonth', block) * fraction;
    }
  }

  return {
    byBlock,
    total: Object.values(byBlock).reduce((sum, value) => sum + value, 0),
  };
}

function getMonthFractions(startDate, endDate) {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  const result = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));
    const periodStart = start > monthStart ? start : monthStart;
    const periodEnd = end < monthEnd ? end : monthEnd;

    if (periodStart <= periodEnd) {
      const coveredDays = diffInDaysInclusive(periodStart, periodEnd);
      const daysInMonth = monthEnd.getUTCDate();
      result.push({
        year,
        month: month + 1,
        fraction: coveredDays / daysInMonth,
        season: isHighSeasonMonth(month + 1) ? 'highSeason' : 'lowSeason',
      });
    }

    cursor = new Date(Date.UTC(year, month + 1, 1));
  }

  return result;
}

function calculateMonthlyFixedCharge(startDate, endDate, amountPerMonth) {
  return getMonthFractions(startDate, endDate)
    .reduce((sum, item) => sum + amountPerMonth * item.fraction, 0);
}

function calculateOvespteFee(activePowerAgreement, startDate, endDate) {
  if (!activePowerAgreement) return 0;

  return getMonthFractions(startDate, endDate).reduce((sum, item) => {
    const block = NETWORK_TARIFFS_2026[item.season].ovespteBlock;
    const agreedPower = Number(activePowerAgreement[`casovniBlok${block}`] || 0);
    return sum + (agreedPower * OVE_SPTE_FEE_PER_KW_MONTH * item.fraction);
  }, 0);
}

async function getSupplierConsumption({ usagePoint, startDate, endDate }) {
  // Daily state readings have interval_end = midnight of the NEXT day (local time).
  // The reading for "day before startDate" has interval_end = startDate midnight, which
  // satisfies >= startDate in a CET-timezone Oracle session — so it's already included
  // without needing to shift fetchStartDate back an extra day.
  const fetchStartDate = startDate;
  const fetchEndDate = endDate;
  const vtRows = await getMeterReadings({
    usagePoint,
    startDate: fetchStartDate,
    endDate: fetchEndDate,
    registerCode: 'A+_T1',
  });
  const mtRows = await getMeterReadings({
    usagePoint,
    startDate: fetchStartDate,
    endDate: fetchEndDate,
    registerCode: 'A+_T2',
  });

  return {
    vtKwh: calculateStateConsumptionFromRows(vtRows),
    mtKwh: calculateStateConsumptionFromRows(mtRows),
    source: 'daily_state',
  };
}

async function getSupplierConsumptionWithFallback({ usagePoint, startDate, endDate, intervalReadings }) {
  const intervalTotal = intervalReadings.reduce((sum, row) => sum + Number(row.VALUE || 0), 0);

  try {
    const result = await getSupplierConsumption({ usagePoint, startDate, endDate });
    const dailyStateTotal = (result.vtKwh || 0) + (result.mtKwh || 0);

    // Fall back when daily state is zero (< 2 readings) or implausibly low compared
    // to the metered interval total — catches sparse / inconsistent daily state data.
    if (dailyStateTotal === 0 || (intervalTotal > 0 && dailyStateTotal < intervalTotal * 0.8)) {
      return calculateTariffConsumptionFromIntervals(intervalReadings);
    }
    return result;
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    return calculateTariffConsumptionFromIntervals(intervalReadings);
  }
}

function calculateStateConsumptionFromRows(rows) {
  if (!rows.length) return 0;

  const sortedRows = [...rows].sort((a, b) => new Date(a.INTERVAL_END) - new Date(b.INTERVAL_END));
  if (sortedRows.length < 2) return 0;

  const startValue = Number(sortedRows[0].VALUE || 0);
  const endValue = Number(sortedRows[sortedRows.length - 1].VALUE || 0);
  return Math.max(0, endValue - startValue);
}

function calculateTariffConsumptionFromIntervals(rows) {
  return rows.reduce((totals, row) => {
    const tariffCode = calculateEnergyTariffCode(row.INTERVAL_START || row.INTERVAL_END);
    const value = Number(row.VALUE || 0);
    if (tariffCode === 'VT') {
      totals.vtKwh += value;
    } else {
      totals.mtKwh += value;
    }
    return totals;
  }, { vtKwh: 0, mtKwh: 0, source: 'interval_fallback' });
}

function isRateLimitError(err) {
  return Number(err?.status) === 429 || /API error 429/i.test(String(err?.message || ''));
}

function mapDailyStateRegister({ registerCode, label, rows }) {
  if (!rows.length) return null;

  const latest = [...rows]
    .sort((a, b) => new Date(a.INTERVAL_END) - new Date(b.INTERVAL_END))
    .at(-1);

  if (!latest) return null;

  return {
    registerCode,
    label,
    valueKwh: roundQuantity(Number(latest.VALUE || 0)),
    intervalStart: latest.INTERVAL_START || null,
    intervalEnd: latest.INTERVAL_END || null,
  };
}

function addDays(dateString, days) {
  const date = parseDateOnly(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function splitDateRangeIntoWindows(startDate, endDate, maxDaysPerWindow) {
  const windows = [];
  let cursor = startDate;

  while (cursor <= endDate) {
    const windowEndCandidate = addDays(cursor, maxDaysPerWindow - 1);
    const windowEnd = windowEndCandidate < endDate ? windowEndCandidate : endDate;
    windows.push({ startDate: cursor, endDate: windowEnd });
    cursor = addDays(windowEnd, 1);
  }

  return windows;
}

function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateTimeLocal(date) {
  return `${formatDateLocal(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:00`;
}

function diffInDaysInclusive(start, end) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((end - start) / msPerDay) + 1;
}

function parseDateOnly(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function calculateTariffBlock(timestamp) {
  const date = new Date(timestamp);
  date.setMinutes(date.getMinutes() - 15);

  const month = date.getMonth() + 1;
  const hour = date.getHours();
  const isHighSeason = isHighSeasonMonth(month);
  const freeDay = isWeekendOrHoliday(date);

  if (isHighSeason) {
    if (freeDay) {
      if (inHourRange(hour, 7, 14) || inHourRange(hour, 16, 20)) return 2;
      if (inHourRange(hour, 6, 7) || inHourRange(hour, 14, 16) || inHourRange(hour, 20, 22)) return 3;
      return 4;
    }

    if (inHourRange(hour, 7, 14) || inHourRange(hour, 16, 20)) return 1;
    if (inHourRange(hour, 6, 7) || inHourRange(hour, 14, 16) || inHourRange(hour, 20, 22)) return 2;
    return 3;
  }

  if (freeDay) {
    if (inHourRange(hour, 7, 14) || inHourRange(hour, 16, 20)) return 3;
    if (inHourRange(hour, 6, 7) || inHourRange(hour, 14, 16) || inHourRange(hour, 20, 22)) return 4;
    return 5;
  }

  if (inHourRange(hour, 7, 14) || inHourRange(hour, 16, 20)) return 2;
  if (inHourRange(hour, 6, 7) || inHourRange(hour, 14, 16) || inHourRange(hour, 20, 22)) return 3;
  return 4;
}

function calculateEnergyTariffCode(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'VT';

  const day = date.getDay();
  const isWorkday = day >= 1 && day <= 5 && !isWeekendOrHoliday(date);
  return isWorkday && inHourRange(date.getHours(), 6, 22) ? 'VT' : 'NT';
}

function isDailyStateRegister(registerCode) {
  return ['A+_T0', 'A+_T1', 'A+_T2'].includes(String(registerCode || '').toUpperCase());
}

function isHighSeasonMonth(month) {
  return [11, 12, 1, 2].includes(month);
}

function getSeasonName(timestamp) {
  const month = new Date(timestamp).getMonth() + 1;
  return isHighSeasonMonth(month) ? 'highSeason' : 'lowSeason';
}

function getSeasonTariffForBlock(season, tariffType, block) {
  return NETWORK_TARIFFS_2026[season][tariffType][block] || 0;
}

function inHourRange(hour, startInclusive, endExclusive) {
  return hour >= startInclusive && hour < endExclusive;
}

function isWeekendOrHoliday(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return true;

  const holidays = new Set([
    '01-01', '01-02', '02-08', '04-27', '05-01', '05-02',
    '06-25', '08-15', '10-31', '11-01', '12-25', '12-26',
  ]);

  const easterRelated = getEasterSaturdayAndMonday(date.getFullYear());
  holidays.add(formatMonthDay(easterRelated.saturday));
  holidays.add(formatMonthDay(easterRelated.monday));

  return holidays.has(formatMonthDay(date));
}

function formatMonthDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

function getEasterSaturdayAndMonday(year) {
  const easterSunday = calculateEasterSunday(year);
  return {
    saturday: new Date(easterSunday.getFullYear(), easterSunday.getMonth(), easterSunday.getDate() - 1),
    monday: new Date(easterSunday.getFullYear(), easterSunday.getMonth(), easterSunday.getDate() + 1),
  };
}

function calculateEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function roundCurrency(value) {
  return Number(value.toFixed(2));
}

function roundQuantity(value) {
  return Number(value.toFixed(4));
}

function roundPower(value) {
  return Number(value.toFixed(2));
}

function roundUpToStep(value, step) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

function quantile(values, q) {
  if (!values.length) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];

  const weight = index - lower;
  return (sorted[lower] * (1 - weight)) + (sorted[upper] * weight);
}

function countDistinctReadingDays(readings) {
  return new Set(readings.map(row => String(row.INTERVAL_START || '').slice(0, 10))).size;
}

function calculateObservedPowerStats(readings) {
  const byBlock = {
    1: { values: [] },
    2: { values: [] },
    3: { values: [] },
    4: { values: [] },
    5: { values: [] },
  };

  readings.forEach(row => {
    const valueKwh = Number(row.VALUE || 0);
    if (!Number.isFinite(valueKwh)) return;

    const block = calculateTariffBlock(row.INTERVAL_END || row.INTERVAL_START);
    byBlock[block].values.push(valueKwh * 4);
  });

  const normalizedByBlock = {};
  const allValues = [];

  for (const block of [1, 2, 3, 4, 5]) {
    const values = byBlock[block].values;
    values.forEach(value => allValues.push(value));
    const total = values.reduce((sum, value) => sum + value, 0);

    normalizedByBlock[block] = {
      intervalsCount: values.length,
      peakKw: values.length ? values.reduce((m, v) => v > m ? v : m, 0) : 0,
      p99Kw: values.length ? quantile(values, 0.99) : 0,
      p95Kw: values.length ? quantile(values, 0.95) : 0,
      avgKw: values.length ? total / values.length : 0,
    };
  }

  return {
    byBlock: normalizedByBlock,
    overallPeakKw: allValues.length ? allValues.reduce((m, v) => v > m ? v : m, 0) : 0,
    overallP99Kw: allValues.length ? quantile(allValues, 0.99) : 0,
  };
}

function buildAgreementSummary(agreement) {
  return {
    casovniBlok1: roundPower(Number(agreement.casovniBlok1 || 0)),
    casovniBlok2: roundPower(Number(agreement.casovniBlok2 || 0)),
    casovniBlok3: roundPower(Number(agreement.casovniBlok3 || 0)),
    casovniBlok4: roundPower(Number(agreement.casovniBlok4 || 0)),
    casovniBlok5: roundPower(Number(agreement.casovniBlok5 || 0)),
    prikljucnaMoc: roundPower(Number(agreement.prikljucnaMoc || 0)),
    minimalnaMoc: roundPower(Number(agreement.minimalnaMoc || 0)),
    datumOd: agreement.datumOd || null,
    datumDo: agreement.datumDo || null,
  };
}

function calculateAgreementMonthlyCosts(agreement, startDate, endDate) {
  const equivalentMonths = getEquivalentMonths(startDate, endDate) || 1;
  const powerCosts = calculatePowerCosts(agreement, startDate, endDate);
  const ovespteFee = calculateOvespteFee(agreement, startDate, endDate);
  const monthlyPowerCostExVat = powerCosts.total / equivalentMonths;
  const monthlyOvespteFeeExVat = ovespteFee / equivalentMonths;
  const monthlyTotalExVat = monthlyPowerCostExVat + monthlyOvespteFeeExVat;
  const monthlyVatAmount = monthlyTotalExVat * VAT_RATE;
  const monthlyTotalInclVat = monthlyTotalExVat + monthlyVatAmount;
  const monthlyByBlock = {};

  for (const block of [1, 2, 3, 4, 5]) {
    monthlyByBlock[block] = (powerCosts.byBlock[block] || 0) / equivalentMonths;
  }

  return {
    equivalentMonths: roundQuantity(equivalentMonths),
    byBlock: Object.fromEntries(
      Object.entries(monthlyByBlock).map(([block, value]) => [block, roundCurrency(value)])
    ),
    monthlyPowerCostExVat: roundCurrency(monthlyPowerCostExVat),
    monthlyOvespteFeeExVat: roundCurrency(monthlyOvespteFeeExVat),
    monthlyTotalExVat: roundCurrency(monthlyTotalExVat),
    monthlyVatAmount: roundCurrency(monthlyVatAmount),
    monthlyTotalInclVat: roundCurrency(monthlyTotalInclVat),
  };
}

function getEquivalentMonths(startDate, endDate) {
  return getMonthFractions(startDate, endDate)
    .reduce((sum, item) => sum + item.fraction, 0);
}

function buildPowerOptimizationProfiles({ activePowerAgreement, observedStats, readings, startDate, endDate, currentMonthlyCosts }) {
  const profileRules = [
    {
      key: 'conservative',
      label: 'Konzervativno',
      description: 'Najvecja rezerva nad izmerjenimi vrhovi. Najmanj tveganja za prenizko dogovorjeno moc.',
      peakBufferPct: 0.15,
      percentileBufferKw: 0.8,
      minimumExtraKw: 0.8,
    },
    {
      key: 'balanced',
      label: 'Uravnotezeno',
      description: 'Priporocena srednja pot med prihrankom in rezervo za konice.',
      peakBufferPct: 0.08,
      percentileBufferKw: 0.5,
      minimumExtraKw: 0.5,
    },
    {
      key: 'aggressive',
      label: 'Agresivno',
      description: 'Najvecji fokus na nizanju stroska. Najmanjsa rezerva nad izmerjenimi vrhovi.',
      peakBufferPct: 0.03,
      percentileBufferKw: 0.2,
      minimumExtraKw: 0.2,
    },
  ];

  return profileRules.map(rule => {
    const agreement = buildRecommendedAgreement(activePowerAgreement, observedStats.byBlock, rule);
    const monthlyCosts = calculateAgreementMonthlyCosts(agreement, startDate, endDate);
    const excess = calculateExcessPowerAnalysis(readings, agreement);
    const savingsExVat = roundCurrency(currentMonthlyCosts.monthlyTotalExVat - monthlyCosts.monthlyTotalExVat);
    const savingsInclVat = roundCurrency(currentMonthlyCosts.monthlyTotalInclVat - monthlyCosts.monthlyTotalInclVat);

    return {
      key: rule.key,
      label: rule.label,
      description: rule.description,
      riskLevel: deriveProfileRiskLevel(agreement, observedStats.byBlock, excess),
      agreement: buildAgreementSummary(agreement),
      monthlyCosts,
      excess,
      estimatedMonthlySavingsExVat: savingsExVat,
      estimatedMonthlySavingsInclVat: savingsInclVat,
      estimatedAnnualSavingsInclVat: roundCurrency(savingsInclVat * 12),
    };
  });
}

function buildRecommendedAgreement(activePowerAgreement, observedByBlock, rule) {
  const nextAgreement = { ...activePowerAgreement };
  const minimalnaMoc = Number(activePowerAgreement.minimalnaMoc || 0);
  const prikljucnaMoc = Number(activePowerAgreement.prikljucnaMoc || 0);

  for (const block of [1, 2, 3, 4, 5]) {
    const stats = observedByBlock[block];
    const currentValue = Number(activePowerAgreement[`casovniBlok${block}`] || 0);

    if (!stats || !stats.intervalsCount) {
      nextAgreement[`casovniBlok${block}`] = currentValue;
      continue;
    }

    let target = Math.max(
      stats.peakKw * (1 + rule.peakBufferPct),
      stats.p99Kw + rule.percentileBufferKw,
      stats.peakKw + rule.minimumExtraKw
    );

    if (minimalnaMoc > 0) {
      target = Math.max(target, minimalnaMoc);
    }

    if (prikljucnaMoc > 0) {
      target = Math.min(target, prikljucnaMoc);
    }

    nextAgreement[`casovniBlok${block}`] = roundPower(roundUpToStep(target, 0.1));
  }

  return enforcePortalBlockOrdering(nextAgreement, { minimalnaMoc, prikljucnaMoc });
}

function enforcePortalBlockOrdering(agreement, { minimalnaMoc, prikljucnaMoc }) {
  const normalized = { ...agreement };

  for (const block of [1, 2, 3, 4, 5]) {
    let value = Number(normalized[`casovniBlok${block}`] || 0);

    if (minimalnaMoc > 0) {
      value = Math.max(value, minimalnaMoc);
    }

    if (block > 1) {
      const previousValue = Number(normalized[`casovniBlok${block - 1}`] || 0);
      value = Math.max(value, previousValue);
    }

    if (prikljucnaMoc > 0) {
      value = Math.min(value, prikljucnaMoc);
    }

    normalized[`casovniBlok${block}`] = roundPower(roundUpToStep(value, 0.1));
  }

  return normalized;
}

function deriveProfileRiskLevel(agreement, observedByBlock, excess) {
  if (excess?.monthsWithExcessCount > 0) {
    if (excess.monthsWithExcessCount >= 3 || Number(excess.peakMonthlyExcessKw || 0) >= 0.5) {
      return 'visoko';
    }
    return 'srednje';
  }

  let minimumMarginPct = Number.POSITIVE_INFINITY;

  for (const block of [1, 2, 3, 4, 5]) {
    const peak = Number(observedByBlock[block]?.peakKw || 0);
    if (!peak) continue;

    const target = Number(agreement[`casovniBlok${block}`] || 0);
    const marginPct = ((target - peak) / peak) * 100;
    minimumMarginPct = Math.min(minimumMarginPct, marginPct);
  }

  if (!Number.isFinite(minimumMarginPct)) return 'ni podatkov';
  if (minimumMarginPct < 5) return 'visoko';
  if (minimumMarginPct < 10) return 'srednje';
  return 'nizko';
}

function calculateExcessPowerAnalysis(readings, agreement) {
  const byMonth = new Map();
  const prikljucnaMoc = Number(agreement.prikljucnaMoc || 0);

  readings.forEach(row => {
    const intervalTimestamp = row.INTERVAL_END || row.INTERVAL_START;
    const monthKey = String(intervalTimestamp || '').slice(0, 7);
    if (!monthKey) return;

    const block = calculateTariffBlock(intervalTimestamp);
    const actualKw = Number(row.VALUE || 0) * 4;
    const agreedKw = Number(agreement[`casovniBlok${block}`] || 0);
    const exceedKw = Math.max(0, actualKw - agreedKw);

    if (!byMonth.has(monthKey)) {
      byMonth.set(monthKey, {
        monthKey,
        blocks: {
          1: createExcessBlockBucket(),
          2: createExcessBlockBucket(),
          3: createExcessBlockBucket(),
          4: createExcessBlockBucket(),
          5: createExcessBlockBucket(),
        },
      });
    }

    if (exceedKw <= 0) return;

    const month = byMonth.get(monthKey);
    const bucket = month.blocks[block];
    bucket.sumSquares += exceedKw ** 2;
    bucket.intervalsCount += 1;
    bucket.maxIntervalExcessKw = Math.max(bucket.maxIntervalExcessKw, exceedKw);
    bucket.agreedKw = agreedKw;
    bucket.cappedByConnection = prikljucnaMoc > 0;
  });

  const months = [];
  const blocksWithExcess = new Set();
  let monthsWithExcessCount = 0;
  let totalInformativeExcessKw = 0;
  let peakMonthlyExcessKw = 0;
  let worstMonth = null;

  for (const monthKey of [...byMonth.keys()].sort()) {
    const month = byMonth.get(monthKey);
    const blockResults = [];
    let monthTotal = 0;

    for (const block of [1, 2, 3, 4, 5]) {
      const bucket = month.blocks[block];
      const rootExcess = Math.sqrt(bucket.sumSquares);
      const agreedKw = Number(agreement[`casovniBlok${block}`] || 0);
      const capKw = prikljucnaMoc > 0 ? Math.max(0, prikljucnaMoc - agreedKw) : rootExcess;
      const informativeExcessKw = Math.min(rootExcess, capKw);

      if (informativeExcessKw > 0) {
        blocksWithExcess.add(block);
      }

      monthTotal += informativeExcessKw;
      blockResults.push({
        block,
        agreedKw: roundPower(agreedKw),
        intervalsCount: bucket.intervalsCount,
        maxIntervalExcessKw: roundPower(bucket.maxIntervalExcessKw),
        informativeExcessKw: roundPower(informativeExcessKw),
      });
    }

    if (monthTotal > 0) {
      monthsWithExcessCount += 1;
    }

    if (monthTotal > peakMonthlyExcessKw) {
      peakMonthlyExcessKw = monthTotal;
      worstMonth = {
        monthKey,
        totalInformativeExcessKw: roundPower(monthTotal),
        blocks: blockResults.filter(item => item.informativeExcessKw > 0),
      };
    }

    totalInformativeExcessKw += monthTotal;
    months.push({
      monthKey,
      totalInformativeExcessKw: roundPower(monthTotal),
      blocks: blockResults,
    });
  }

  return {
    monthsWithExcessCount,
    totalInformativeExcessKw: roundPower(totalInformativeExcessKw),
    peakMonthlyExcessKw: roundPower(peakMonthlyExcessKw),
    blocksWithExcess: [...blocksWithExcess].sort((a, b) => a - b),
    worstMonth,
    months,
  };
}

function createExcessBlockBucket() {
  return {
    sumSquares: 0,
    intervalsCount: 0,
    maxIntervalExcessKw: 0,
    agreedKw: 0,
    cappedByConnection: false,
  };
}

function selectRecommendedProfileKey(profiles) {
  const preferenceOrder = ['balanced', 'conservative', 'aggressive'];
  const zeroExcessProfiles = profiles.filter(profile => profile.excess.monthsWithExcessCount === 0);

  for (const key of preferenceOrder) {
    if (zeroExcessProfiles.some(profile => profile.key === key)) {
      return key;
    }
  }

  return [...profiles].sort((a, b) => {
    if (a.excess.monthsWithExcessCount !== b.excess.monthsWithExcessCount) {
      return a.excess.monthsWithExcessCount - b.excess.monthsWithExcessCount;
    }
    if (a.excess.totalInformativeExcessKw !== b.excess.totalInformativeExcessKw) {
      return a.excess.totalInformativeExcessKw - b.excess.totalInformativeExcessKw;
    }
    return preferenceOrder.indexOf(a.key) - preferenceOrder.indexOf(b.key);
  })[0].key;
}

function buildExcessMonthMatrix(currentExcess, profiles) {
  const allMonths = new Set(currentExcess.months.map(item => item.monthKey));
  profiles.forEach(profile => {
    profile.excess.months.forEach(item => allMonths.add(item.monthKey));
  });

  return [...allMonths].sort().map(monthKey => ({
    monthKey,
    current: findMonthExcessValue(currentExcess, monthKey),
    balanced: findMonthExcessValue(profiles.find(item => item.key === 'balanced')?.excess, monthKey),
    conservative: findMonthExcessValue(profiles.find(item => item.key === 'conservative')?.excess, monthKey),
    aggressive: findMonthExcessValue(profiles.find(item => item.key === 'aggressive')?.excess, monthKey),
  })).filter(item => [item.current, item.balanced, item.conservative, item.aggressive].some(value => value > 0));
}

function findMonthExcessValue(excessAnalysis, monthKey) {
  const month = excessAnalysis?.months?.find(item => item.monthKey === monthKey);
  return roundPower(Number(month?.totalInformativeExcessKw || 0));
}

function mapTodayInterval(row) {
  const kwh = Number(row.VALUE || 0);
  const tariffCode = calculateEnergyTariffCode(row.INTERVAL_START || row.INTERVAL_END);

  return {
    intervalStart: row.INTERVAL_START,
    intervalEnd: row.INTERVAL_END,
    timeLabel: String(row.INTERVAL_START || '').slice(11, 16),
    kwh: roundQuantity(kwh),
    estimatedKw: roundQuantity(kwh * 4),
    tariffCode,
    tariffLabel: tariffCode === 'VT' ? 'Višja tarifa' : 'Nižja tarifa',
    isMeasured: true,
    isEstimated: false,
  };
}

function buildTodayTimeline({ date, rows, estimateRows }) {
  const byStart = new Map(rows.map(row => [row.INTERVAL_START, row]));
  const estimateByTime = new Map((estimateRows || []).map(row => [String(row.INTERVAL_START || '').slice(11, 16), row]));
  const timeline = [];
  const cursor = new Date(`${date}T00:00:00`);
  const now = new Date();
  const end = new Date(now);
  end.setSeconds(0, 0);
  end.setMinutes(Math.floor(end.getMinutes() / 15) * 15);

  while (cursor < end) {
    const start = new Date(cursor);
    const intervalEnd = new Date(start);
    intervalEnd.setMinutes(intervalEnd.getMinutes() + 15);
    const startKey = formatDateTimeLocal(start);
    const measured = byStart.get(startKey);

    if (measured) {
      timeline.push(mapTodayInterval(measured));
    } else {
      const estimate = estimateByTime.get(startKey.slice(11, 16));
      if (estimate) {
        timeline.push(mapEstimatedTodayInterval({ date, timeLabel: startKey.slice(11, 16), row: estimate }));
      } else {
        const tariffCode = calculateEnergyTariffCode(startKey);
        timeline.push({
          intervalStart: startKey,
          intervalEnd: formatDateTimeLocal(intervalEnd),
          timeLabel: startKey.slice(11, 16),
          kwh: 0,
          estimatedKw: 0,
          tariffCode,
          tariffLabel: tariffCode === 'VT' ? 'Višja tarifa' : 'Nižja tarifa',
          isMeasured: false,
          isEstimated: false,
        });
      }
    }

    cursor.setMinutes(cursor.getMinutes() + 15);
  }

  return timeline;
}

function mapEstimatedTodayInterval({ date, timeLabel, row }) {
  const [hours, minutes] = timeLabel.split(':').map(Number);
  const start = new Date(`${date}T00:00:00`);
  start.setHours(hours, minutes, 0, 0);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + 15);

  return {
    intervalStart: formatDateTimeLocal(start),
    intervalEnd: formatDateTimeLocal(end),
    timeLabel,
    kwh: roundQuantity(Number(row.VALUE || 0)),
    estimatedKw: roundQuantity(Number(row.VALUE || 0) * 4),
    tariffCode: calculateEnergyTariffCode(formatDateTimeLocal(start)),
    tariffLabel: calculateEnergyTariffCode(formatDateTimeLocal(start)) === 'VT' ? 'Višja tarifa' : 'Nižja tarifa',
    isMeasured: false,
    isEstimated: true,
  };
}

function getFreshnessMinutes(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - parsed.getTime()) / 60000));
}

function shiftIsoTimestamp(timestamp, minuteDelta) {
  if (!timestamp) return null;

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  date.setMinutes(date.getMinutes() + minuteDelta);

  const pad = value => String(Math.abs(value)).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainder = pad(Math.abs(offsetMinutes) % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainder}`;
}

module.exports = {
  listUsagePoints,
  saveUsagePoint,
  deleteUsagePoint,
  getMerilnoMesto,
  getMerilnaTocka,
  getMeterReadings,
  getDailyAggregates,
  getCostEstimate,
  getCurrentSupplierPrices,
  getTodayUsageOverview,
  getPowerOptimization,
};
