'use strict';

const oracledb = require('oracledb');

// Thin mode is the default for this app and does not require Oracle Instant Client.

oracledb.autoCommit = true;
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let pool;

async function ensureRuntimeSchema() {
  await query(`
    BEGIN
      EXECUTE IMMEDIATE q'[
        CREATE TABLE supplier_prices (
            id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            supplier_key     VARCHAR2(100)  NOT NULL,
            supplier_name    VARCHAR2(200),
            tariff_name      VARCHAR2(500),
            source_url       VARCHAR2(1000),
            valid_from       VARCHAR2(50),
            vt_price_per_kwh NUMBER(10,6),
            mt_price_per_kwh NUMBER(10,6),
            fetched_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
      ]';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE != -955 THEN
          RAISE;
        END IF;
    END;`);

  await query(`
    BEGIN
      EXECUTE IMMEDIATE q'[
        CREATE INDEX idx_sp_key_fetched
            ON supplier_prices (supplier_key, fetched_at)
      ]';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE != -955 THEN
          RAISE;
        END IF;
    END;`);

  await query(`
    BEGIN
      EXECUTE IMMEDIATE q'[
        CREATE TABLE reading_fetch_windows (
            id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            usage_point      VARCHAR2(50)   NOT NULL,
            register_code    VARCHAR2(50),
            start_date       DATE           NOT NULL,
            end_date         DATE           NOT NULL,
            fetched_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
      ]';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE != -955 THEN
          RAISE;
        END IF;
    END;`);

  await query(`
    DELETE FROM reading_fetch_windows dst
     WHERE ROWID <> (
       SELECT MIN(src.ROWID)
         FROM reading_fetch_windows src
        WHERE src.usage_point = dst.usage_point
          AND NVL(src.register_code, '_') = NVL(dst.register_code, '_')
          AND src.start_date = dst.start_date
          AND src.end_date = dst.end_date
     )`);

  await query(`
    BEGIN
      EXECUTE IMMEDIATE q'[
        CREATE UNIQUE INDEX uq_rfw_point_range
            ON reading_fetch_windows (usage_point, NVL(register_code, '_'), start_date, end_date)
      ]';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE != -955 THEN
          RAISE;
        END IF;
    END;`);

  await query(`
    BEGIN
      EXECUTE IMMEDIATE 'ALTER TABLE meter_readings MODIFY quality_code VARCHAR2(200)';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE != -942 THEN
          RAISE;
        END IF;
    END;`);
}

async function initPool() {
  if (pool) return pool;
  pool = await oracledb.createPool({
    user:          process.env.ORACLE_USER,
    password:      process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
    poolMin:       2,
    poolMax:       10,
    poolIncrement: 1,
  });
  await ensureRuntimeSchema();
  console.log('[db] Oracle connection pool created');
  return pool;
}

async function getConnection() {
  if (!pool) await initPool();
  return pool.getConnection();
}

/** Run a query and always release the connection. */
async function query(sql, binds = [], opts = {}) {
  const conn = await getConnection();
  try {
    return await conn.execute(sql, binds, opts);
  } finally {
    await conn.close();
  }
}

/** Run a batch insert/update and always release the connection. */
async function executeMany(sql, binds, opts = {}) {
  const conn = await getConnection();
  try {
    return await conn.executeMany(sql, binds, opts);
  } finally {
    await conn.close();
  }
}

/** Run multiple statements in a single connection (same tx). */
async function transaction(fn) {
  const conn = await getConnection();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.close();
  }
}

async function closePool() {
  if (pool) {
    await pool.close(10);
    pool = null;
    console.log('[db] Oracle connection pool closed');
  }
}

module.exports = { initPool, query, executeMany, transaction, closePool, getConnection };
