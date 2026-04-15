#!/usr/bin/env node
/**
 * What Next — Update Checker
 *
 * Checks GitHub for the latest release and notifies the user if they are behind.
 * Called non-blocking from src/server.js on MCP startup.
 *
 * What it does:
 *   - Fetches the latest release tag from GitHub (5s timeout)
 *   - Compares semver against package.json version
 *   - If outdated: writes a one-time notice to stderr (visible in AI tool logs)
 *     and creates a flag file so the notice only shows once per session
 *   - Clears the flag file when the installed version matches latest
 *
 * Update instructions shown to user:
 *   cd ~/Documents/projects/what-next
 *   git pull && npm install
 *   node bin/install.js --client <claude|vscode|codex> --key bak_xxx
 */

import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));
const FLAG = join(homedir(), '.what-next-update-notice-shown');
const GITHUB_REPO = 'Danz0zn17/what-next';
const CHECK_TIMEOUT_MS = 5000;

function semverGt(a, b) {
  // Returns true if version string a > version string b
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

export async function checkForUpdate() {
  try {
    const { version: current } = JSON.parse(
      (await import('fs')).readFileSync(join(ROOT, 'package.json'), 'utf8')
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { 'User-Agent': 'what-next-update-check' },
        signal: controller.signal,
      }
    ).finally(() => clearTimeout(timer));

    if (!res.ok) return;

    const { tag_name: latest } = await res.json();
    if (!latest) return;

    const latestClean = latest.replace(/^v/, '');

    if (semverGt(latestClean, current)) {
      // Only show once per session (flag file lives until user updates)
      if (!existsSync(FLAG)) {
        writeFileSync(FLAG, latestClean);
        process.stderr.write(
          `\n[what-next] Update available: v${current} → v${latestClean}\n` +
          `[what-next] To update:\n` +
          `[what-next]   cd ${ROOT}\n` +
          `[what-next]   git pull && npm install\n` +
          `[what-next]   node bin/install.js --client <claude|vscode|codex> --key bak_xxx\n\n`
        );
      }
    } else {
      // Up to date — clear any stale flag
      try { unlinkSync(FLAG); } catch {}
    }
  } catch {
    // Never crash the MCP server because of an update check failure
  }
}

// Allow running standalone: node bin/update-check.js
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  checkForUpdate().then(() => process.exit(0));
}
