-- ============================================================
--  EMA – Elektro Merilna Aplikacija
--  Run as EMA_APP on EMAPDB
--  sql <user>/<password>@<connect_string> @db/init.sql
-- ============================================================

-- Drop existing tables (in dependency order) for clean re-run
BEGIN
  FOR t IN (SELECT table_name FROM user_tables
            WHERE table_name IN (
              'API_REQUEST_LOG','DAILY_AGGREGATES','METER_READINGS',
              'READING_FETCH_WINDOWS',
              'MERILNE_TOCKE','MERILNA_MESTA','USAGE_POINTS'))
  LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS';
  END LOOP;
END;
/

-- ------------------------------------------------------------
-- Usage points saved by the user
-- ------------------------------------------------------------
CREATE TABLE usage_points (
    id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identifier       VARCHAR2(50)   NOT NULL,
    gsrn             VARCHAR2(50),
    label            VARCHAR2(200),
    created_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT uq_usage_points_identifier UNIQUE (identifier)
);

-- ------------------------------------------------------------
-- Cached merilno-mesto details (technical specs)
-- ------------------------------------------------------------
CREATE TABLE merilna_mesta (
    id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identifier       VARCHAR2(50)   NOT NULL,
    raw_json         CLOB           NOT NULL,
    fetched_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT uq_merilna_mesta_id UNIQUE (identifier),
    CONSTRAINT chk_mm_json CHECK (raw_json IS JSON)
);

-- ------------------------------------------------------------
-- Cached merilna-tocka details (contractual info)
-- ------------------------------------------------------------
CREATE TABLE merilne_tocke (
    id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    gsrn             VARCHAR2(50)   NOT NULL,
    raw_json         CLOB           NOT NULL,
    fetched_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT uq_merilne_tocke_gsrn UNIQUE (gsrn),
    CONSTRAINT chk_mt_json CHECK (raw_json IS JSON)
);

-- ------------------------------------------------------------
-- Meter readings (15-minute interval data)
-- ------------------------------------------------------------
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
);

CREATE INDEX idx_mr_point_time
    ON meter_readings (usage_point, interval_start, interval_end);

-- ------------------------------------------------------------
-- Requested ranges already fetched from the API
-- ------------------------------------------------------------
CREATE TABLE reading_fetch_windows (
    id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usage_point      VARCHAR2(50)   NOT NULL,
    register_code    VARCHAR2(50),
    start_date       DATE           NOT NULL,
    end_date         DATE           NOT NULL,
    fetched_at       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX uq_rfw_point_range
    ON reading_fetch_windows (usage_point, NVL(register_code, '_'), start_date, end_date);

-- ------------------------------------------------------------
-- Daily aggregates
-- ------------------------------------------------------------
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
);

CREATE INDEX idx_da_point_date
    ON daily_aggregates (usage_point, reading_date);

-- ------------------------------------------------------------
-- API request audit log
-- ------------------------------------------------------------
CREATE TABLE api_request_log (
    id               NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    endpoint         VARCHAR2(200)  NOT NULL,
    params_json      VARCHAR2(4000),
    http_status      NUMBER(3),
    response_ms      NUMBER,
    error_message    VARCHAR2(2000),
    requested_at     TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
);

COMMIT;

-- Verify
SELECT table_name, num_rows FROM user_tables
WHERE table_name IN (
  'USAGE_POINTS','MERILNA_MESTA','MERILNE_TOCKE',
  'METER_READINGS','READING_FETCH_WINDOWS','DAILY_AGGREGATES','API_REQUEST_LOG')
ORDER BY table_name;

PROMPT
PROMPT ✓ EMA schema initialised successfully.
PROMPT
