-- ============================================================
--  EMA – Elektro Merilna Aplikacija
--  Run as EMA_APP on EMAPDB
--  sql <user>/<password>@<connect_string> @db/init.sql
-- ============================================================

-- ------------------------------------------------------------
-- Usage points saved by the user
-- ------------------------------------------------------------
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE usage_points (
        id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        identifier       VARCHAR2(50)   NOT NULL,
        gsrn             VARCHAR2(50),
        label            VARCHAR2(200),
        created_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_usage_points_identifier UNIQUE (identifier)
    )
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

-- ------------------------------------------------------------
-- Cached merilno-mesto details (technical specs)
-- ------------------------------------------------------------
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE merilna_mesta (
        id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        identifier       VARCHAR2(50)   NOT NULL,
        raw_json         CLOB           NOT NULL,
        fetched_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_merilna_mesta_id UNIQUE (identifier),
        CONSTRAINT chk_mm_json CHECK (raw_json IS JSON)
    )
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

-- ------------------------------------------------------------
-- Cached merilna-tocka details (contractual info)
-- ------------------------------------------------------------
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE merilne_tocke (
        id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        gsrn             VARCHAR2(50)   NOT NULL,
        raw_json         CLOB           NOT NULL,
        fetched_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_merilne_tocke_gsrn UNIQUE (gsrn),
        CONSTRAINT chk_mt_json CHECK (raw_json IS JSON)
    )
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

-- ------------------------------------------------------------
-- Meter readings (15-minute interval data)
-- ------------------------------------------------------------
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE meter_readings (
        id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        usage_point      VARCHAR2(50)   NOT NULL,
        interval_start   TIMESTAMP      NOT NULL,
        interval_end     TIMESTAMP      NOT NULL,
        register_code    VARCHAR2(50),
        value            NUMBER(18,6),
        unit             VARCHAR2(20),
        quality_code     VARCHAR2(200),
        reading_type     VARCHAR2(50),
        created_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_meter_reading UNIQUE (usage_point, interval_start, register_code)
    )
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE INDEX idx_mr_point_time
        ON meter_readings (usage_point, interval_start, interval_end)
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

-- ------------------------------------------------------------
-- Requested ranges already fetched from the API
-- ------------------------------------------------------------
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
END;
/

BEGIN
  DELETE FROM reading_fetch_windows dst
   WHERE ROWID <> (
     SELECT MIN(src.ROWID)
       FROM reading_fetch_windows src
      WHERE src.usage_point = dst.usage_point
        AND NVL(src.register_code, '_') = NVL(dst.register_code, '_')
        AND src.start_date = dst.start_date
        AND src.end_date = dst.end_date
   );
END;
/

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
END;
/

-- ------------------------------------------------------------
-- Daily aggregates
-- ------------------------------------------------------------
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE daily_aggregates (
        id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        usage_point      VARCHAR2(50)   NOT NULL,
        reading_date     DATE           NOT NULL,
        register_code    VARCHAR2(50),
        total_kwh        NUMBER(18,6),
        min_value        NUMBER(18,6),
        max_value        NUMBER(18,6),
        avg_value        NUMBER(18,6),
        reading_count    NUMBER,
        updated_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_daily_agg UNIQUE (usage_point, reading_date, register_code)
    )
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE INDEX idx_da_point_date
        ON daily_aggregates (usage_point, reading_date)
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

-- ------------------------------------------------------------
-- API request audit log
-- ------------------------------------------------------------
BEGIN
  EXECUTE IMMEDIATE q'[
    CREATE TABLE api_request_log (
        id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        endpoint         VARCHAR2(200)  NOT NULL,
        params_json      VARCHAR2(4000),
        http_status      NUMBER(3),
        response_ms      NUMBER,
        error_message    VARCHAR2(2000),
        requested_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
    )
  ]';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -955 THEN
      RAISE;
    END IF;
END;
/

-- ------------------------------------------------------------
-- Supplier price history cache
-- ------------------------------------------------------------
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
END;
/

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
END;
/

BEGIN
  EXECUTE IMMEDIATE 'ALTER TABLE meter_readings MODIFY quality_code VARCHAR2(200)';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -942 THEN
      RAISE;
    END IF;
END;
/

COMMIT;

-- Verify
SELECT table_name, num_rows FROM user_tables
WHERE table_name IN (
  'USAGE_POINTS','MERILNA_MESTA','MERILNE_TOCKE',
  'METER_READINGS','READING_FETCH_WINDOWS','DAILY_AGGREGATES','API_REQUEST_LOG',
  'SUPPLIER_PRICES')
ORDER BY table_name;

PROMPT
PROMPT ✓ EMA schema initialised successfully.
PROMPT
