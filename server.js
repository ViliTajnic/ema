'use strict';

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const db       = require('./src/db');
const svc      = require('./src/dataService');
const apiClient = require('./src/mojelektroClient');

const supplierPriceSvc = require('./src/supplierPriceService');

const app  = express();
const PORT = process.env.PORT || 3000;
let server = null;
let shutdownPromise = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDateRange(startDate, endDate) {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return 'startDate and endDate must be in YYYY-MM-DD format';
  }
  if (startDate > endDate) {
    return 'startDate must not be after endDate';
  }
  return null;
}

function validateUsagePoint(value) {
  if (!value || typeof value !== 'string' || value.length > 100 || !/^[\w\-. ]+$/.test(value)) {
    return 'usagePoint is invalid';
  }
  return null;
}

// ----------------------------------------------------------------
// App config
// ----------------------------------------------------------------
app.get('/api/app-config', (_req, res) => {
  res.json({
    appName: 'EMA',
    mojelektroEnv: (process.env.MOJELEKTRO_ENV || 'test').toLowerCase(),
    port: Number(PORT),
  });
});

// ----------------------------------------------------------------
// Usage Points
// ----------------------------------------------------------------
app.get('/api/usage-points', asyncRoute(async (req, res) => {
  res.json(await svc.listUsagePoints());
}));

app.post('/api/usage-points', asyncRoute(async (req, res) => {
  const { identifier, gsrn, label } = req.body;
  if (!identifier) return res.status(400).json({ error: 'identifier is required' });
  await svc.saveUsagePoint({ identifier, gsrn, label });
  res.json({ ok: true });
}));

app.delete('/api/usage-points/:identifier', asyncRoute(async (req, res) => {
  await svc.deleteUsagePoint(req.params.identifier);
  res.json({ ok: true });
}));

// ----------------------------------------------------------------
// Meter Readings
// ----------------------------------------------------------------
app.get('/api/meter-readings', asyncRoute(async (req, res) => {
  const { usagePoint, startDate, endDate, registerCode } = req.query;
  if (!usagePoint || !startDate || !endDate)
    return res.status(400).json({ error: 'usagePoint, startDate and endDate are required' });
  const upErr = validateUsagePoint(usagePoint);
  if (upErr) return res.status(400).json({ error: upErr });
  const drErr = validateDateRange(startDate, endDate);
  if (drErr) return res.status(400).json({ error: drErr });

  const rows = await svc.getMeterReadings({ usagePoint, startDate, endDate, registerCode });
  res.json(rows);
}));

// Daily aggregates (for bar/line charts)
app.get('/api/daily-aggregates', asyncRoute(async (req, res) => {
  const { usagePoint, startDate, endDate, registerCode } = req.query;
  if (!usagePoint || !startDate || !endDate)
    return res.status(400).json({ error: 'usagePoint, startDate and endDate are required' });
  const upErr = validateUsagePoint(usagePoint);
  if (upErr) return res.status(400).json({ error: upErr });
  const drErr = validateDateRange(startDate, endDate);
  if (drErr) return res.status(400).json({ error: drErr });

  const rows = await svc.getDailyAggregates({ usagePoint, startDate, endDate, registerCode });
  res.json(rows);
}));

app.get('/api/cost-estimate', asyncRoute(async (req, res) => {
  const { usagePoint, startDate, endDate, vtPricePerKwh, mtPricePerKwh, monthlyFee, monthlyDiscount } = req.query;
  if (!usagePoint || !startDate || !endDate)
    return res.status(400).json({ error: 'usagePoint, startDate and endDate are required' });
  const upErr = validateUsagePoint(usagePoint);
  if (upErr) return res.status(400).json({ error: upErr });
  const drErr = validateDateRange(startDate, endDate);
  if (drErr) return res.status(400).json({ error: drErr });

  const data = await svc.getCostEstimate({
    usagePoint,
    startDate,
    endDate,
    vtPricePerKwh,
    mtPricePerKwh,
    monthlyFee,
    monthlyDiscount,
  });
  res.json(data);
}));

app.get('/api/current-supplier-prices', asyncRoute(async (req, res) => {
  const { usagePoint } = req.query;
  if (!usagePoint) return res.status(400).json({ error: 'usagePoint is required' });
  const upErr = validateUsagePoint(usagePoint);
  if (upErr) return res.status(400).json({ error: upErr });

  const data = await svc.getCurrentSupplierPrices({ usagePoint });
  res.json(data);
}));

app.get('/api/today-usage', asyncRoute(async (req, res) => {
  const { usagePoint } = req.query;
  if (!usagePoint) return res.status(400).json({ error: 'usagePoint is required' });
  const upErr = validateUsagePoint(usagePoint);
  if (upErr) return res.status(400).json({ error: upErr });

  const data = await svc.getTodayUsageOverview({ usagePoint });
  res.json(data);
}));

app.get('/api/power-optimization', asyncRoute(async (req, res) => {
  const { usagePoint, startDate, endDate } = req.query;
  if (!usagePoint || !startDate || !endDate) {
    return res.status(400).json({ error: 'usagePoint, startDate and endDate are required' });
  }
  const upErr = validateUsagePoint(usagePoint);
  if (upErr) return res.status(400).json({ error: upErr });
  const drErr = validateDateRange(startDate, endDate);
  if (drErr) return res.status(400).json({ error: drErr });

  const data = await svc.getPowerOptimization({ usagePoint, startDate, endDate });
  res.json(data);
}));

// ----------------------------------------------------------------
// Merilno Mesto & Merilna Tocka
// ----------------------------------------------------------------
app.get('/api/merilno-mesto/:identifier', asyncRoute(async (req, res) => {
  const data = await svc.getMerilnoMesto(req.params.identifier);
  res.json(data);
}));

app.get('/api/merilna-tocka/:gsrn', asyncRoute(async (req, res) => {
  const data = await svc.getMerilnaTocka(req.params.gsrn);
  res.json(data);
}));

// ----------------------------------------------------------------
// Reference data (pass-through from API, no persistence needed)
// ----------------------------------------------------------------
app.get('/api/reading-qualities', asyncRoute(async (req, res) => {
  res.json(await apiClient.getReadingQualities());
}));

app.get('/api/reading-type', asyncRoute(async (req, res) => {
  res.json(await apiClient.getReadingTypes());
}));

app.get('/api/supplier-prices-history', asyncRoute(async (_req, res) => {
  res.json(await supplierPriceSvc.getSupplierPricesHistory());
}));

// ----------------------------------------------------------------
// Error handler
// ----------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  const status = err.status || 500;
  // Only expose the message for client errors (4xx); mask internal errors to avoid leaking DB details.
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({
    error: message,
    ...(status < 500 && err.body ? { body: err.body } : {}),
  });
});

// ----------------------------------------------------------------
// Start
// ----------------------------------------------------------------
async function start() {
  if (!process.env.MOJELEKTRO_API_KEY) {
    console.error('[startup] MOJELEKTRO_API_KEY is not set. Run  npm run setup  to configure.');
    process.exit(1);
  }

  await db.initPool();
  server = app.listen(PORT, () => {
    console.log(`[server] EMA running at http://localhost:${PORT}`);
    console.log(`[server] Oracle connected to ${process.env.ORACLE_CONNECT_STRING}`);
    console.log(`[server] MojeElektro env: ${process.env.MOJELEKTRO_ENV || 'test'}`);
  });
}

async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    console.log(`[server] Received ${signal}, shutting down`);

    if (server) {
      await new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
      server = null;
    }

    await db.closePool();
  })();

  try {
    await shutdownPromise;
    process.exit(0);
  } catch (err) {
    console.error('[shutdown error]', err);
    process.exit(1);
  }
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

start().catch(err => {
  console.error('[startup error]', err);
  process.exit(1);
});
