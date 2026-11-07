/**
 * The customer install path: pack the real tarball, install it into a fresh
 * prefix (npm hoists dependencies such as onnxruntime-node to that prefix's
 * node_modules, unlike `npm ci` in this repo or a global install), then run
 * both bin entry points from the installed copy.
 *
 * Needs the npm registry (or a warm npm cache). Set WHATNEXT_SKIP_PACK_TEST=1
 * to skip it offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const skip = process.env.WHATNEXT_SKIP_PACK_TEST === '1' ? 'WHATNEXT_SKIP_PACK_TEST=1' : false;

function npm(args, opts) {
  // npm is npm.cmd on Windows, which needs a shell.
  return spawnSync(WIN ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: WIN, ...opts });
}

test('packed tarball installs into a fresh prefix and both bins run', { skip, timeout: 600_000 }, () => {
  const S = mkdtempSync(join(tmpdir(), 'wn-pack-test-'));
  try {
    const pack = npm(['pack', '--pack-destination', S], { cwd: REPO });
    assert.equal(pack.status, 0, `npm pack failed:\n${pack.stderr}`);
    const tgz = readdirSync(S).find(f => /^whatnext-ai-.*\.tgz$/.test(f));
    assert.ok(tgz, 'tarball written');

    const prefix = join(S, 'prefix');
    mkdirSync(prefix);
    const install = npm(['install', '--no-audit', '--no-fund', '--foreground-scripts', '--prefix', prefix, join(S, tgz)], { cwd: prefix });
    assert.equal(install.status, 0, `fresh-prefix install failed (exit ${install.status}):\n${install.stdout}\n${install.stderr}`);
    assert.match(install.stdout + install.stderr, /OK: onnxruntime binding present/, 'package postinstall ran and found the binding');

    const pkgDir = join(prefix, 'node_modules', 'whatnext-ai');
    // The layout this test exists for: onnxruntime-node hoisted, not nested.
    assert.ok(existsSync(join(prefix, 'node_modules', 'onnxruntime-node')) || existsSync(join(pkgDir, 'node_modules', 'onnxruntime-node')));

    const home = join(S, 'home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, WHATNEXT_UPDATE_CHECK: '0', WHATNEXT_CLOUD_URL: '' };
    const { bin, version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(bin).sort(), ['install-what-next', 'wn']);

    // Through the shims npm created, as a customer runs them.
    const shim = (name) => join(prefix, 'node_modules', '.bin', WIN ? `${name}.cmd` : name);
    const run = (name, args) => execFileSync(shim(name), args, { env, cwd: prefix, encoding: 'utf8', shell: WIN, stdio: 'pipe' });

    assert.equal(run('wn', ['--version']).trim(), `wn v${version}`);
    const out = run('install-what-next', ['--client', 'codex', '--key', 'bak_packtest']);
    assert.match(out, /What Next added to Codex/);
    const cfg = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(cfg, /\[mcp_servers\.what-next\]/);
    // The MCP server the installer points at lives in the installed package.
    assert.ok(cfg.includes('bootstrap-entry.js'), 'config points at the installed bootstrap entry');
  } finally {
    rmSync(S, { recursive: true, force: true });
  }
});
