import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { loadConfig, checkRequest, MIN_TOKEN_LENGTH } from '../src/http-mcp.js';

const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

// ─── Unit: config + request checks ────────────────────────────────────────────

test('loadConfig refuses a missing or short token', () => {
  assert.throws(() => loadConfig({}), /WHATNEXT_MCP_HTTP_TOKEN/);
  assert.throws(() => loadConfig({ WHATNEXT_MCP_HTTP_TOKEN: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }), /at least/);
  assert.equal(loadConfig({ WHATNEXT_MCP_HTTP_TOKEN: TOKEN }).port, 3748);
});

test('loadConfig rejects a bad port and lowercases extra hosts', () => {
  assert.throws(() => loadConfig({ WHATNEXT_MCP_HTTP_TOKEN: TOKEN, WHATNEXT_MCP_HTTP_PORT: 'nope' }), /port/);
  const c = loadConfig({ WHATNEXT_MCP_HTTP_TOKEN: TOKEN, WHATNEXT_MCP_HTTP_ALLOWED_HOSTS: ' Mini.Tail1.ts.net , ' });
  assert.ok(c.allowedHosts.has('mini.tail1.ts.net'));
  assert.ok(c.allowedHosts.has('localhost:3748'));
});

const cfg = (extra = {}) => loadConfig({ WHATNEXT_MCP_HTTP_TOKEN: TOKEN, ...extra });
const req = (headers) => ({ headers: { host: 'localhost:3748', ...headers } });

test('checkRequest: bearer token required on /mcp', () => {
  assert.equal(checkRequest(req({ authorization: `Bearer ${TOKEN}` }), '/mcp', cfg()), null);
  assert.equal(checkRequest(req({}), '/mcp', cfg()).status, 401);
  assert.equal(checkRequest(req({ authorization: 'Bearer wrong' }), '/mcp', cfg()).status, 401);
  assert.equal(checkRequest(req({ authorization: TOKEN }), '/mcp', cfg()).status, 401);
});

test('checkRequest: unknown Host is rejected even with a valid token', () => {
  const r = checkRequest({ headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` } }, '/mcp', cfg());
  assert.equal(r.status, 403);
});

test('checkRequest: path token only when explicitly enabled', () => {
  assert.equal(checkRequest(req({}), `/mcp/${TOKEN}`, cfg()).status, 404);
  const on = cfg({ WHATNEXT_MCP_HTTP_ALLOW_PATH_TOKEN: '1' });
  assert.equal(checkRequest(req({}), `/mcp/${TOKEN}`, on), null);
  assert.equal(checkRequest(req({}), '/mcp/wrong', on).status, 401);
});

test('checkRequest: other paths are 404', () => {
  assert.equal(checkRequest(req({ authorization: `Bearer ${TOKEN}` }), '/context', cfg()).status, 404);
});

// ─── End to end: boot the real HTTP entry against a throwaway data dir ────────

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function boot(env) {
  const dir = mkdtempSync(join(tmpdir(), 'wn-http-test-'));
  const p = spawn(process.execPath, ['src/http-mcp.js'], {
    env: {
      PATH: process.env.PATH,
      WHATNEXT_DATA_DIR: join(dir, 'data'),
      HOME: dir,
      USERPROFILE: dir,
      WHATNEXT_CLOUD_URL: '',
      WHATNEXT_AUDIT_LOG_DIR: join(dir, 'logs'),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  p.stderr.on('data', d => { stderr += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; stderr:\n${stderr}`)), 60_000);
    p.stderr.on('data', () => { if (stderr.includes('listening on')) { clearTimeout(timer); resolve(); } });
    p.on('exit', code => { clearTimeout(timer); reject(Object.assign(new Error(`exited ${code}`), { code, stderr })); });
  });
  const stop = () => new Promise(r => {
    const cleanup = () => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); r(); };
    if (p.exitCode !== null || p.signalCode !== null) return cleanup();
    p.once('exit', cleanup);
    p.kill();
  });
  return { p, ready, stop, getStderr: () => stderr };
}

async function rpc(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Responses may come back as an SSE stream; take the JSON from the data line.
  const dataLine = text.split('\n').find(l => l.startsWith('data: '));
  return { status: res.status, json: dataLine ? JSON.parse(dataLine.slice(6)) : (text ? JSON.parse(text) : null) };
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

test('refuses to start without a token', { timeout: 60_000 }, async () => {
  const { ready, stop, getStderr } = boot({ WHATNEXT_MCP_HTTP_TOKEN: '' });
  await assert.rejects(ready, e => e.code === 1);
  assert.match(getStderr(), /Refusing to start without auth/);
  await stop();
});

test('serves the same tools over HTTP, with auth enforced', { timeout: 120_000 }, async () => {
  const port = await freePort();
  const srv = boot({ WHATNEXT_MCP_HTTP_TOKEN: TOKEN, WHATNEXT_MCP_HTTP_PORT: String(port) });
  try {
    await srv.ready;

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    assert.equal((await rpc(port, init, { Authorization: '' })).status, 401);
    assert.equal((await rpc(port, init, { Authorization: 'Bearer nope' })).status, 401);
    // fetch() will not let us spoof Host, so use a raw request for this one.
    const badHostStatus = await new Promise((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } },
      res => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject);
      r.end('{}');
    });
    assert.equal(badHostStatus, 403);
    const get = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);

    const i = await rpc(port, init);
    assert.equal(i.status, 200);
    assert.equal(i.json.result.serverInfo.name, 'what-next');

    const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.json.result.tools.length, 14);

    // Round trip through the real database: write a fact, find it again.
    const marker = `httpmcp${Date.now()}`;
    const add = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_fact', arguments: { category: 'preference', content: `remote access works ${marker}` } } });
    assert.equal(add.json.result.isError, undefined, JSON.stringify(add.json));
    const found = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_memories', arguments: { query: marker } } });
    assert.match(JSON.stringify(found.json.result), new RegExp(marker));

    assert.doesNotMatch(srv.getStderr(), new RegExp(TOKEN), 'token must never be logged');
  } finally {
    await srv.stop();
  }
});
