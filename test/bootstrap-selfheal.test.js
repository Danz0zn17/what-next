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

function isNativeBinary(error) {
  return /\.node['"]?\s*$/.test(error?.message ?? '');
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

test('isNativeBinary detects missing .node binding path', () => {
  const err = new Error("Cannot find module '../bin/napi-v3/darwin/arm64/onnxruntime_binding.node'");
  err.code = 'ERR_MODULE_NOT_FOUND';
  assert.equal(isNativeBinary(err), true);
});

test('isNativeBinary returns false for regular JS module errors', () => {
  const err = new Error("Cannot find module '@modelcontextprotocol/sdk/dist/esm/server'");
  err.code = 'ERR_MODULE_NOT_FOUND';
  assert.equal(isNativeBinary(err), false);
});

test('isNativeBinary handles error with no message', () => {
  assert.equal(isNativeBinary({}), false);
  assert.equal(isNativeBinary(null), false);
  assert.equal(isNativeBinary(undefined), false);
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

  const { spawn } = await import('node:child_process');
  const { existsSync, renameSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { resolve, dirname, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(__dirname, '..');
  const serverDir = resolve(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server');
  const backupDir = serverDir + '.bak';

  assert.ok(existsSync(serverDir), 'SDK server dir must exist before test');

  // Read the self-heal signal from the on-disk bootstrap.log, not piped stdio.
  // bootstrap-entry.js writes the log synchronously (appendFileSync), so it
  // survives the SIGTERM we use to stop the long-running server — whereas
  // buffered pipe output is dropped on kill. Isolate it to a temp dir so we
  // only observe this run, via the WHATNEXT_AUDIT_LOG_DIR hook.
  const logDir = mkdtempSync(join(tmpdir(), 'whatnext-selfheal-'));
  const logFile = join(logDir, 'bootstrap.log');

  // Corrupt: rename the server dir away
  renameSync(serverDir, backupDir);
  assert.ok(!existsSync(serverDir), 'SDK server dir should be gone after rename');

  let child;
  try {
    child = spawn('bash', [resolve(ROOT, 'bin/mcp-wrapper.sh')], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, WHATNEXT_AUDIT_LOG_DIR: logDir },
    });

    // Poll the log until self-heal completes (clean node_modules) or fails.
    // Cold-cache npm install can take tens of seconds, so allow a generous
    // ceiling; we exit the moment recovery is confirmed, so the happy path is fast.
    const deadline = Date.now() + 90000;
    let healed = false;
    let failed = false;
    while (Date.now() < deadline) {
      if (existsSync(logFile)) {
        const log = readFileSync(logFile, 'utf8');
        if (log.includes('completed — retrying startup') || log.includes('imported successfully')) {
          healed = true;
          break;
        }
        if (/\[ERROR\].*npm install failed/.test(log)) {
          failed = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    assert.ok(!failed, `Self-heal npm install failed. Log:\n${log}`);
    assert.ok(log.includes('self-heal'), `Expected self-heal to trigger. Log:\n${log}`);
    assert.ok(healed, `Expected self-heal to recover within deadline. Log:\n${log}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    // Always restore — whether test passed or failed
    if (!existsSync(serverDir) && existsSync(backupDir)) {
      renameSync(backupDir, serverDir);
    } else if (existsSync(backupDir)) {
      // npm install already restored it; remove the backup
      rmSync(backupDir, { recursive: true, force: true });
    }
    rmSync(logDir, { recursive: true, force: true });
    assert.ok(existsSync(serverDir), 'SDK server dir must be restored after test');
  }
});
