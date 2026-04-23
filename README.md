# EMA – Elektro Merilna Aplikacija

A local web application for analysing energy consumption data from the [MojeElektro](https://www.mojelektro.si) portal. Fetches 15-minute interval readings, estimates monthly costs against the 2026 Slovenian network tariff structure, and recommends optimal agreed power (dogovorjena moč) settings.

---

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Analiza | `/` | Monthly cost breakdown against 2026 network tariffs |
| Danes | `/today.html` | Live today's consumption with 15-minute chart |
| Moč | `/power.html` | Block-peak analysis and agreed power optimisation |

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | Included with Node.js |
| Oracle 26ai (Free) | any | Local database — [oracle.com/database/free](https://www.oracle.com/database/free/) |
| MojeElektro API key | — | Generate in the MojeElektro portal under *Nastavitve → API dostop* |

Oracle must be running and reachable before the app starts. The app uses **Thin mode** (`oracledb`) — no Oracle Instant Client is required.

---

## Oracle database setup

EMA uses its own **pluggable database (PDB)** called `EMAPDB` and a dedicated schema user `EMA_APP` inside it. Follow the steps below once, before running the Node.js setup wizard.

### Step A — create the PDB

Connect to the root container (CDB) as SYSDBA. Depending on your Oracle installation, the typical connect strings are:

| OS | Default SYSDBA connect |
|----|------------------------|
| Linux / macOS | `sql sys/password@localhost:1521/FREE as sysdba` |
| Windows | `sqlplus sys/password@localhost:1521/FREE as sysdba` |

> Replace `FREE` with your CDB service name if you used a different name during Oracle installation (e.g. `XE` for Oracle XE, or `ORCL` for a full install).

```sql
-- 1. Create the pluggable database
CREATE PLUGGABLE DATABASE emapdb
  ADMIN USER ema_admin IDENTIFIED BY "Admin#Strong1"
  ROLES = (DBA)
  DEFAULT TABLESPACE users
    DATAFILE 'emapdb_users01.dbf' SIZE 100M AUTOEXTEND ON NEXT 50M MAXSIZE 2G
  FILE_NAME_CONVERT = ('pdbseed', 'emapdb');

-- 2. Open it
ALTER PLUGGABLE DATABASE emapdb OPEN READ WRITE;

-- 3. Save state so it reopens automatically after every Oracle restart
ALTER PLUGGABLE DATABASE emapdb SAVE STATE;
```

Verify it is open:

```sql
SELECT name, open_mode FROM v$pdbs WHERE name = 'EMAPDB';
-- Expected: EMAPDB   READ WRITE
```

> **Oracle Database Free** allows up to 3 PDBs (including the seed). If you have already created 2, either drop one or reuse the existing `FREEPDB1` and skip to Step B, using `localhost:1521/FREEPDB1` as your connect string.

### Step B — create the schema user

Switch into the new PDB and create the application user:

```sql
-- Switch into the PDB
ALTER SESSION SET CONTAINER = emapdb;

-- Create the app user with its own tablespace quota
CREATE USER ema_app IDENTIFIED BY "EmaApp#YourPassword"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

-- Minimum required privileges
GRANT CREATE SESSION  TO ema_app;
GRANT CREATE TABLE    TO ema_app;
GRANT CREATE INDEX    TO ema_app;
GRANT CREATE SEQUENCE TO ema_app;
GRANT CREATE VIEW     TO ema_app;
```

> Pick a strong password. You will enter it during `npm run setup`.

### Step C — verify the connection

Test that the app user can connect to the PDB from the command line:

```bash
# Oracle SQL*Plus
sqlplus ema_app/"EmaApp#YourPassword"@localhost:1521/emapdb

# Oracle SQLcl
sql ema_app/"EmaApp#YourPassword"@localhost:1521/emapdb
```

You should reach a `SQL>` prompt without errors. The connect string `localhost:1521/emapdb` is what you will enter for `ORACLE_CONNECT_STRING` in the setup wizard.

---

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd elektro-merilna-aplikacija
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run the setup wizard

> Complete the [Oracle database setup](#oracle-database-setup) above before this step.

```bash
npm run setup
```

The wizard will:
- Create `.env` from `.env.example`
- Prompt for all required configuration values
- Connect to Oracle and initialise the database schema (idempotent — safe to re-run)

You will be asked for:

| Prompt | Description |
|--------|-------------|
| `MOJELEKTRO_API_KEY` | API key from the MojeElektro portal |
| `MOJELEKTRO_ENV` | `test` or `production` |
| `PORT` | Local port for the web server (default: `3000`) |
| `ORACLE_USER` | Oracle database username (e.g. `EMA_APP`) |
| `ORACLE_PASSWORD` | Oracle database password |
| `ORACLE_CONNECT_STRING` | Oracle connect string (e.g. `localhost:1521/emapdb`) |

### 4. Start the app

```bash
npm start
```

Open your browser at **http://localhost:3000** (or the port you configured).

---

## Configuration reference

All configuration lives in `.env` (never committed to version control). See `.env.example` for the full list with comments.

```env
# MojeElektro API
MOJELEKTRO_API_KEY=your_api_key_here
MOJELEKTRO_ENV=production          # test | production

# Local web server
PORT=3000

# Oracle 26ai Database
ORACLE_USER=EMA_APP
ORACLE_PASSWORD=your_password_here
ORACLE_CONNECT_STRING=localhost:1521/emapdb
```

To override settings without editing `.env`, create `.env.local` — it is loaded on top of `.env` and is also gitignored.

---

## Development

```bash
npm run dev
```

Starts the server with `--watch` so it restarts automatically on file changes.

---

## Database schema

The schema is initialised automatically by `npm run setup` and on every server start (via `ensureRuntimeSchema`). For a clean re-install, run the full schema script manually:

```bash
sql ema_app/<password>@localhost:1521/emapdb @db/init.sql
```

> **Warning:** `db/init.sql` drops and recreates all tables. Run it only on a fresh install or when you intentionally want to wipe all stored data.

---

## Adding a merilno mesto

1. Open the app at `http://localhost:3000`
2. Expand the **Merilna mesta** panel
3. Enter your identifier (e.g. `E-00012345`) and optional label
4. Click **Dodaj** — the app will fetch data from MojeElektro on the next analysis

---

## Troubleshooting

**`MOJELEKTRO_API_KEY is not set`**
Run `npm run setup` and enter your API key when prompted.

**`ORA-12541: TNS: no listener`**
Oracle is not running. Start it with:
```bash
sudo systemctl start oracle   # Linux
# or use Oracle Database Actions on Windows/Mac
```

**`ORA-01017: invalid username/password`**
Check `ORACLE_USER` and `ORACLE_PASSWORD` in `.env`.

**`Error: API error 401`**
Your MojeElektro API key is invalid or `MOJELEKTRO_ENV` is set to the wrong environment.

**`Error: API error 429`**
The MojeElektro API rate-limited the request. The app retries automatically; wait a moment and try again.

---

## Project structure

```
.
├── db/
│   └── init.sql              # Full schema (use for clean installs only)
├── public/
│   ├── index.html            # Analiza page
│   ├── today.html            # Danes page
│   ├── power.html            # Moč page
│   ├── css/style.css
│   └── js/
│       ├── app.js            # Analiza logic
│       ├── today.js          # Danes logic
│       └── power.js          # Moč logic
├── scripts/
│   ├── setup.js              # First-time setup wizard
│   └── start-server.sh       # Optional shell start script
├── src/
│   ├── dataService.js        # Core business logic and cost calculations
│   ├── db.js                 # Oracle connection pool and query helpers
│   ├── mojelektroClient.js   # MojeElektro API client
│   └── supplierPriceService.js # Supplier tariff scraper (GEN-I)
├── server.js                 # Express server and API routes
├── .env.example              # Configuration template
└── package.json
```
