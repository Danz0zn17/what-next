#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const port = process.env.WHATNEXT_PORT || '3747';
const label = process.env.WHATNEXT_LAUNCHD_LABEL || 'com.whatnextai.api';
const userId = String(process.getuid?.() ?? '');
const logDir = process.env.WHATNEXT_AUDIT_LOG_DIR
  || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Logs', 'what-next')
    : join(homedir(), '.what-next', 'logs'));
const logFile = join(logDir, 'watchdog.log');

mkdirSync(logDir, { recursive: true });

function log(level, message) {
  const line = `[what-next watchdog] ${new Date().toISOString()} [${level}] ${message}\n`;
  appendFileSync(logFile, line);
}

async function isHealthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (await isHealthy()) {
    log('INFO', `healthy on port ${port}`);
    return;
  }

  log('WARN', `health check failed on port ${port}; attempting restart`);

  if (process.platform === 'darwin' && userId) {
    const result = spawnSync('/bin/launchctl', ['kickstart', '-k', `gui/${userId}/${label}`], { encoding: 'utf8' });
    if (result.status !== 0) {
      log('ERROR', `launchctl kickstart failed: ${result.stderr || result.stdout || 'unknown error'}`);
    } else {
      log('INFO', `launchctl kickstart issued for ${label}`);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));

  if (await isHealthy()) {
    log('INFO', `service recovered on port ${port}`);
    return;
  }

  log('ERROR', `service still unhealthy after restart attempt on port ${port}`);
  process.exitCode = 1;
}

await main();
