#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const entry = process.argv[2];
const label = process.argv[3] || 'what-next';
const retries = Number(process.env.WHATNEXT_BOOT_RETRIES || 12);
const delayMs = Number(process.env.WHATNEXT_BOOT_DELAY_MS || 750);
const initialDelayMs = Number(process.env.WHATNEXT_BOOT_INITIAL_DELAY_MS || 0);
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

function runNpmInstall(offline) {
  const args = offline
    ? ['install', '--prefer-offline', '--no-audit']
    : ['install', '--no-audit'];
  const result = spawnSync('npm', args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: (result.stderr || result.stdout || 'unknown error').trim() };
}

function repairDeps(isNativeBinary = false) {
  // For missing native binaries, skip the offline cache — the tarball in cache may be
  // the same incomplete one that caused the problem. Go straight to network install.
  if (isNativeBinary) {
    log('WARN', 'native binary missing — running full network npm install to self-heal');
    const result = runNpmInstall(false);
    if (result.ok) { log('INFO', 'npm install (network) completed — retrying startup'); return true; }
    log('ERROR', `npm install (network) failed: ${result.error}`);
    return false;
  }

  // For regular missing modules: try offline cache first (fast), fall back to network.
  log('WARN', 'missing dependency detected — running npm install to self-heal');
  const offlineResult = runNpmInstall(true);
  if (offlineResult.ok) { log('INFO', 'npm install (offline) completed — retrying startup'); return true; }

  log('WARN', `offline install failed (${offlineResult.error.slice(0, 80)}) — trying network install`);
  const networkResult = runNpmInstall(false);
  if (networkResult.ok) { log('INFO', 'npm install (network) completed — retrying startup'); return true; }

  log('ERROR', `npm install failed: ${networkResult.error}`);
  return false;
}

const targetUrl = pathToFileURL(resolve(ROOT, entry)).href;

if (initialDelayMs > 0) {
  log('INFO', `waiting ${initialDelayMs}ms before first attempt (boot delay)`);
  await sleep(initialDelayMs);
}

for (let attempt = 1; attempt <= retries; attempt += 1) {
  try {
    log('INFO', `starting ${entry} (attempt ${attempt}/${retries})`);
    await import(`${targetUrl}?attempt=${attempt}&ts=${Date.now()}`);
    log('INFO', `${entry} imported successfully`);
    break;
  } catch (error) {
    // Self-heal: if a module is missing (e.g. corrupt node_modules), run npm install once and retry.
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && attempt === 1) {
      const isNative = /\.node['"]?\s*$/.test(error?.message ?? '');
      const repaired = repairDeps(isNative);
      if (repaired) continue;
      // npm install failed — fall through to normal exit
    }
    const retryable = isRetryable(error);
    log(retryable ? 'WARN' : 'ERROR', `${error?.stack ?? error?.message ?? error}`);
    if (!retryable || attempt === retries) {
      process.exit(1);
    }
    await sleep(delayMs * attempt);
  }
}
