#!/usr/bin/env node
'use strict';

/**
 * EMA interactive setup wizard.
 * Run once after cloning:  npm run setup
 *
 * What it does:
 *  1. Creates .env from .env.example if it doesn't exist yet.
 *  2. Prompts for any missing required values and saves them.
 *  3. Connects to Oracle and initialises the schema (idempotent).
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const ROOT        = path.resolve(__dirname, '..');
const ENV_FILE    = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

// ----------------------------------------------------------------
// Node version gate
// ----------------------------------------------------------------
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`✗ Node.js 18 or higher is required. You have ${process.version}.`);
  process.exit(1);
}

// ----------------------------------------------------------------
// .env file helpers
// ----------------------------------------------------------------

/** Parse a .env file into a plain object, preserving only key=value pairs. */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

/**
 * Write values back to .env, using .env.example as the structural template
 * so comments and section headings are preserved.
 */
function writeEnvFile(values) {
  const lines = [];

  if (fs.existsSync(ENV_EXAMPLE)) {
    for (const raw of fs.readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) { lines.push(raw); continue; }
      const eq = line.indexOf('=');
      if (eq === -1) { lines.push(raw); continue; }
      const key = line.slice(0, eq).trim();
      if (key in values) {
        const v = values[key];
        // Quote values that contain spaces, # or special chars
        const safe = /[ #"'\\]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
        lines.push(`${key}=${safe}`);
      } else {
        lines.push(raw);
      }
    }
  } else {
    for (const [k, v] of Object.entries(values)) lines.push(`${k}=${v}`);
  }

  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
}

// ----------------------------------------------------------------
// Prompt helper
// ----------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal = '') {
  return new Promise(resolve => {
    const hint = defaultVal ? ` [${defaultVal}]` : '';
    rl.question(`  ${question}${hint}: `, answer => resolve(answer.trim() || defaultVal));
  });
}

function askSecret(question) {
  // Node's readline doesn't have a built-in silent mode; we fake it by
  // temporarily muting stdout echo so the password isn't shown in the terminal.
  return new Promise(resolve => {
    process.stdout.write(`  ${question}: `);

    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';
    const handler = char => {
      if (char === '\n' || char === '\r' || char === '\u0003') {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u007f') {
        password = password.slice(0, -1);
      } else {
        password += char;
      }
    };
    stdin.on('data', handler);
  });
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  EMA – Elektro Merilna Aplikacija    ║');
  console.log('║  First-time setup                    ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Step 1 — create .env if absent
  if (!fs.existsSync(ENV_FILE)) {
    if (fs.existsSync(ENV_EXAMPLE)) {
      fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
    } else {
      fs.writeFileSync(ENV_FILE, '', 'utf8');
    }
    console.log('✓ Created .env\n');
  } else {
    console.log('✓ .env already exists\n');
  }

  const cur = parseEnvFile(ENV_FILE);

  // Step 2 — collect configuration
  console.log('Enter your configuration (press Enter to keep the current value):\n');
  console.log('  ── MojeElektro API ──────────────────────────────');

  const apiKey = await ask('MOJELEKTRO_API_KEY  (from the MojeElektro portal)', cur.MOJELEKTRO_API_KEY || '');
  const apiEnv = await ask('MOJELEKTRO_ENV      (test or production)',           cur.MOJELEKTRO_ENV  || 'test');

  console.log('\n  ── Local web server ─────────────────────────────');
  const port   = await ask('PORT', cur.PORT || '3000');

  console.log('\n  ── Oracle 26ai database (EMAPDB) ────────────────');
  const dbUser    = await ask('ORACLE_USER',           cur.ORACLE_USER           || 'EMA_APP');
  const dbConnect = await ask('ORACLE_CONNECT_STRING', cur.ORACLE_CONNECT_STRING || 'localhost:1521/emapdb');

  // Prompt password silently only when running interactively; fall back to plain ask otherwise.
  let dbPassword;
  if (process.stdin.isTTY) {
    dbPassword = await askSecret('ORACLE_PASSWORD (input hidden)');
    if (!dbPassword && cur.ORACLE_PASSWORD) {
      dbPassword = cur.ORACLE_PASSWORD;
      console.log('  (keeping existing password)');
    }
  } else {
    dbPassword = await ask('ORACLE_PASSWORD', cur.ORACLE_PASSWORD || '');
  }

  const updated = {
    ...cur,
    MOJELEKTRO_API_KEY:    apiKey,
    MOJELEKTRO_ENV:        apiEnv,
    PORT:                  port,
    ORACLE_USER:           dbUser,
    ORACLE_PASSWORD:       dbPassword,
    ORACLE_CONNECT_STRING: dbConnect,
  };

  writeEnvFile(updated);
  console.log('\n✓ .env saved\n');

  // Step 3 — warn about missing required values (non-fatal, allow DB test to fail gracefully)
  const required = { MOJELEKTRO_API_KEY: apiKey, ORACLE_USER: dbUser, ORACLE_PASSWORD: dbPassword, ORACLE_CONNECT_STRING: dbConnect };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.warn(`⚠  Still empty: ${missing.join(', ')}`);
    console.warn('   Fill these in .env before starting the app.\n');
  }

  // Step 4 — connect to Oracle and initialise schema
  if (dbUser && dbPassword && dbConnect) {
    console.log('Connecting to Oracle and initialising schema…');
    process.env.ORACLE_USER           = dbUser;
    process.env.ORACLE_PASSWORD       = dbPassword;
    process.env.ORACLE_CONNECT_STRING = dbConnect;

    try {
      const db = require('../src/db');
      await db.initPool();
      console.log('✓ Database connected — schema is up to date\n');
      await db.closePool();
    } catch (err) {
      console.error(`✗ Database error: ${err.message}`);
      console.error('  Verify ORACLE_USER, ORACLE_PASSWORD and ORACLE_CONNECT_STRING in .env');
      console.error('  Then run  npm run setup  again or start the app once the DB is available.\n');
      rl.close();
      process.exit(1);
    }
  } else {
    console.log('⚠  Skipping DB check (credentials incomplete).\n');
  }

  rl.close();

  const portLine = `http://localhost:${port}`.padEnd(36);
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Setup complete!                     ║');
  console.log('║                                      ║');
  console.log('║  Start the app:  npm start           ║');
  console.log(`║  Open browser:   ${portLine}║`);
  console.log('╚══════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('\n✗ Setup failed:', err.message);
  rl.close();
  process.exit(1);
});
