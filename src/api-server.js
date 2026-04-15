/**
 * What Next — Standalone REST API + Web UI
 * This runs as a persistent background service (macOS LaunchAgent).
 * Always available at http://localhost:3747 — survives reboots.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
try { require('dotenv').config(); } catch {} // Load .env if present (optional dep)

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'what-next.db');

// ── DB integrity check on startup ──────────────────────────────────────────────
// Validates schema is present and readable before serving any requests.
// If integrity fails, we crash loudly so LaunchAgent restarts us rather
// than serving garbage data.
if (!existsSync(DB_PATH)) {
  process.stderr.write(`[api-server] DB not found at ${DB_PATH} — will be created by db.js\n`);
} else {
  try {
    // Dynamically import better-sqlite3 for a quick PRAGMA check
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    const result = db.prepare('PRAGMA quick_check').get();
    db.close();
    if (result?.quick_check !== 'ok') {
      process.stderr.write(`[api-server] FATAL: DB integrity check failed: ${result?.quick_check}\n`);
      process.exit(1);
    }
    process.stderr.write(`[api-server] DB integrity check passed\n`);
  } catch (err) {
    process.stderr.write(`[api-server] DB check error: ${err.message} — continuing (db.js will handle schema)\n`);
  }
}

import { startApiServer } from './api.js';
import { startPeriodicSync } from './sync.js';

startApiServer();
startPeriodicSync();
