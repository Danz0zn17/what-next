import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boot the real MCP server over stdio and read tools/list, as a client would.
// Each attempt gets its own HOME and data dir, removed afterwards.
function listToolsOnce() {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'wn-tools-test-'));
    const p = spawn(process.execPath, ['src/server.js'], {
      env: {
        PATH: process.env.PATH,
        WHATNEXT_DATA_DIR: join(dir, 'data'),
        HOME: dir,
        USERPROFILE: dir,
        WHATNEXT_CLOUD_URL: '',
        WHATNEXT_AUDIT_LOG_DIR: join(dir, 'logs'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let err = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (p.exitCode === null && p.signalCode === null) {
        p.once('exit', () => { cleanup(); fn(value); });
        p.kill();
      } else {
        cleanup();
        fn(value);
      }
    };
    const timer = setTimeout(() => finish(reject, new Error(`timeout; stderr:\n${err}`)), 60000);
    p.stderr.on('data', d => { err += d; });
    p.on('exit', (code) => finish(reject, Object.assign(new Error(`server exited (${code}) before tools/list; stderr:\n${err}`), { stderr: err })));
    p.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.id === 1) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        if (m.id === 2) finish(resolve, m.result.tools);
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  });
}

// test/bootstrap-selfheal.test.js renames part of the shared node_modules and
// runs npm install to prove self-heal. Under parallel `node --test` that can
// overlap this test, so a missing module is retried until the heal finishes.
async function listTools() {
  const deadline = Date.now() + 150_000;
  for (;;) {
    try {
      return await listToolsOnce();
    } catch (e) {
      if (!/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(e.stderr ?? '') || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

test('every tool has a one-line description and the schema stays small', { timeout: 200_000 }, async () => {
  const tools = await listTools();
  assert.equal(tools.length, 14);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} has no description`);
    assert.ok(t.description.length < 400, `${t.name} description too long`);
  }
  const bytes = JSON.stringify(tools).length;
  assert.ok(bytes < 12_000, `tools/list is ${bytes} bytes; keep the schema tax small`);
});
