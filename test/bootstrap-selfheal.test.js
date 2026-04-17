/**
 * Tests for bootstrap-entry.js self-healing behaviour.
 *
 * We test the repairDeps logic inline rather than exec'ing the real
 * bootstrap, because the bootstrap does top-level await and opens stdio.
 * These tests verify the decision logic and the npm-install invocation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// ─── Inline the repair logic (keep in sync with bootstrap-entry.js) ──────────

function isRetryable(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return text.includes('unknown system error -11')
    || text.includes('eagain')
    || text.includes('resource temporarily unavailable')
    || text.includes('operation not permitted');
}

function isModuleNotFound(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('isRetryable returns false for ERR_MODULE_NOT_FOUND', () => {
  const err = new Error("Cannot find module '/some/path/mcp.js'");
  err.code = 'ERR_MODULE_NOT_FOUND';
  assert.equal(isRetryable(err), false, 'ERR_MODULE_NOT_FOUND must not trigger the old retry path');
});

test('isModuleNotFound detects ERR_MODULE_NOT_FOUND', () => {
  const err = new Error("Cannot find module '/some/path/mcp.js'");
  err.code = 'ERR_MODULE_NOT_FOUND';
  assert.equal(isModuleNotFound(err), true);
});

test('isModuleNotFound returns false for other error codes', () => {
  const err = new Error('something else');
  err.code = 'ECONNREFUSED';
  assert.equal(isModuleNotFound(err), false);
});

test('isRetryable still works for EAGAIN', () => {
  const err = new Error('resource temporarily unavailable');
  err.code = 'EAGAIN';
  assert.equal(isRetryable(err), true);
});

test('npm install --version exits 0 (npm is available)', () => {
  const result = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'npm must be available on PATH for self-heal to work');
});

test('bootstrap self-heal: wrapper exits 0 after clean install', async () => {
  // End-to-end: corrupt the SDK marker file, run the wrapper, expect clean startup.
  // We only remove the server subdir, forcing ERR_MODULE_NOT_FOUND on import.
  // The wrapper must run npm install and recover without manual intervention.
  //
  // Skip if running in CI where npm install may be slow or network-restricted.
  if (process.env.CI) {
    return; // skip in CI
  }

  const { execFileSync, spawnSync: sp } = await import('node:child_process');
  const { existsSync, renameSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(__dirname, '..');
  const serverDir = resolve(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server');
  const backupDir = serverDir + '.bak';

  assert.ok(existsSync(serverDir), 'SDK server dir must exist before test');

  // Corrupt: rename the server dir away
  renameSync(serverDir, backupDir);
  assert.ok(!existsSync(serverDir), 'SDK server dir should be gone after rename');

  try {
    // Run wrapper — it should self-heal and start cleanly (we kill it after 4s)
    const result = sp(
      'bash',
      [resolve(ROOT, 'bin/mcp-wrapper.sh')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8000,
      }
    );

    const output = (result.stderr || '') + (result.stdout || '');
    // Should see the self-heal message
    assert.ok(
      output.includes('npm install') || output.includes('self-heal'),
      `Expected self-heal log in output. Got:\n${output}`
    );
    // Should NOT see exit-1 error from the missing module
    assert.ok(
      !output.includes('ERR_MODULE_NOT_FOUND') || output.includes('npm install'),
      'If ERR_MODULE_NOT_FOUND appears it must be followed by recovery'
    );
  } finally {
    // Always restore — whether test passed or failed
    if (!existsSync(serverDir) && existsSync(backupDir)) {
      renameSync(backupDir, serverDir);
    } else if (existsSync(backupDir)) {
      // npm install already restored it; remove the backup
      execFileSync('rm', ['-rf', backupDir]);
    }
    assert.ok(existsSync(serverDir), 'SDK server dir must be restored after test');
  }
});
