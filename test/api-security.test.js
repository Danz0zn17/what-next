/**
 * Local REST API request guard: DNS rebinding (Host), CSRF (Origin +
 * Content-Type), the ChatGPT /ingest exception and the web UI escaping helper.
 *
 * Starts src/api-server.js on a free port with a throwaway HOME and data dir,
 * so it never touches the real instance on 3747 or ~/.whatnext.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let dir, port, child;

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => ok(p));
    });
    srv.on('error', fail);
  });
}

function call(method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        ok({ status: res.statusCode, headers: res.headers, text: raw, json });
      });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wn-api-sec-'));
  port = await freePort();
  child = spawn(process.execPath, [join(ROOT, 'src', 'api-server.js')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      USERPROFILE: dir,
      WHATNEXT_DATA_DIR: join(dir, 'data'),
      WHATNEXT_PORT: String(port),
      WHATNEXT_PROJECTS_DIR: join(dir, 'p'),
      WHATNEXT_CURATOR: '0',
      WHATNEXT_UPDATE_CHECK: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await call('GET', '/health');
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`api-server did not start:\n${stderr}`);
});

after(async () => {
  // Wait for the server to exit before removing its data dir: on Windows the
  // open SQLite file keeps the directory locked (EBUSY) until the process is gone.
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const json = { 'Content-Type': 'application/json' };

test('foreign Host header is rejected (DNS rebinding)', async () => {
  const r = await call('GET', '/projects', { headers: { Host: `evil.example:${port}` } });
  assert.equal(r.status, 403);
  const r2 = await call('GET', '/health', { headers: { Host: 'localhost' } });
  assert.equal(r2.status, 403, 'bare host is only valid on port 80');
});

test('localhost, 127.0.0.1 and [::1] Host headers are accepted', async () => {
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    const r = await call('GET', '/health', { headers: { Host: host } });
    assert.equal(r.status, 200, host);
  }
});

test('POST from a foreign Origin is rejected (CSRF)', async () => {
  const r = await call('POST', '/session', {
    headers: { ...json, Origin: 'https://evil.example' },
    body: JSON.stringify({ project: 'x', summary: 'csrf' }),
  });
  assert.equal(r.status, 403);
});

test('text/plain POST is rejected even without Origin', async () => {
  const r = await call('POST', '/session', {
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ project: 'x', summary: 'simple request' }),
  });
  assert.ok(r.status === 403 || r.status === 415, `got ${r.status}`);
});

test('JSON POST without Origin (curl, hooks) is stored', async () => {
  const r = await call('POST', '/session', {
    headers: json,
    body: JSON.stringify({ project: 'sec-test', summary: 'plain local write' }),
  });
  assert.equal(r.status, 201);
  assert.ok(r.json.id);
});

test('JSON POST from a localhost Origin is stored', async () => {
  const r = await call('POST', '/fact', {
    headers: { ...json, Origin: `http://localhost:${port}` },
    body: JSON.stringify({ category: 'general', content: 'local ui write' }),
  });
  assert.equal(r.status, 201);
});

test('/ingest preflight and POST allow the ChatGPT origin', async () => {
  const pre = await call('OPTIONS', '/ingest', {
    headers: { Origin: 'https://chatgpt.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://chatgpt.com');

  const post = await call('POST', '/ingest', {
    headers: { ...json, Origin: 'https://chatgpt.com' },
    body: JSON.stringify({ raw: '---WHAT NEXT DUMP---\nPROJECT: sec-test\nSUMMARY: ingested from chatgpt\n---END DUMP---' }),
  });
  assert.equal(post.status, 201);
  assert.equal(post.headers['access-control-allow-origin'], 'https://chatgpt.com');
  assert.equal(post.json.project, 'sec-test');
});

test('ChatGPT origin is not allowed on other endpoints', async () => {
  const pre = await call('OPTIONS', '/session', { headers: { Origin: 'https://chatgpt.com' } });
  assert.equal(pre.headers['access-control-allow-origin'], 'null');
  const r = await call('POST', '/session', {
    headers: { ...json, Origin: 'https://chatgpt.com' },
    body: JSON.stringify({ project: 'x', summary: 'y' }),
  });
  assert.equal(r.status, 403);
});

test('non-numeric limit params fall back to defaults', async () => {
  const r = await call('GET', '/search?q=plain&limit=abc');
  assert.equal(r.status, 200);
  const w = await call('GET', '/whats-next?limit=zzz');
  assert.equal(w.status, 200);
  assert.ok(Array.isArray(w.json.items));
});

test('web UI escapes memory data before innerHTML', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /function esc\(v\)/);
  assert.match(r.text, /esc\(s\.summary\)/);
  assert.match(r.text, /esc\(f\.content\)/);
  assert.match(r.text, /esc\(p\.name\)/);
  assert.doesNotMatch(r.text, /'<p>' \+ s\.summary/);
});
