#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const entry = process.argv[2];
const label = process.argv[3] || 'what-next';
const retries = Number(process.env.WHATNEXT_BOOT_RETRIES || 12);
const delayMs = Number(process.env.WHATNEXT_BOOT_DELAY_MS || 750);
const logDir = process.env.WHATNEXT_AUDIT_LOG_DIR
  || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Logs', 'what-next')
    : join(homedir(), '.what-next', 'logs'));
const logFile = join(logDir, 'bootstrap.log');

if (!entry) {
  process.stderr.write('[what-next bootstrap] Missing entry argument\n');
  process.exit(1);
}

mkdirSync(logDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function log(level, message) {
  const line = `[what-next bootstrap] ${new Date().toISOString()} [${level}] ${label}: ${message}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(logFile, line);
  } catch {
    // Never fail startup because logging failed.
  }
}

function isRetryable(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return text.includes('unknown system error -11')
    || text.includes('eagain')
    || text.includes('resource temporarily unavailable')
    || text.includes('operation not permitted');
}

const targetUrl = pathToFileURL(resolve(ROOT, entry)).href;

for (let attempt = 1; attempt <= retries; attempt += 1) {
  try {
    log('INFO', `starting ${entry} (attempt ${attempt}/${retries})`);
    await import(`${targetUrl}?attempt=${attempt}&ts=${Date.now()}`);
    log('INFO', `${entry} imported successfully`);
    break;
  } catch (error) {
    const retryable = isRetryable(error);
    log(retryable ? 'WARN' : 'ERROR', `${error?.stack ?? error?.message ?? error}`);
    if (!retryable || attempt === retries) {
      process.exit(1);
    }
    await sleep(delayMs * attempt);
  }
}
