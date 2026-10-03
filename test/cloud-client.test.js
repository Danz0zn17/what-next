import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const cloud = await import('../src/cloud-client.js');
const { CloudUnavailableError, isNetworkError } = cloud;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function useCloud(url) {
  process.env.WHATNEXT_CLOUD_URL = url;
  process.env.WHATNEXT_API_KEY = 'bak_test';
}

test('connection refused throws CloudUnavailableError', async () => {
  const { server, url } = await listen(() => {});
  await new Promise(r => server.close(r));
  useCloud(url);
  await assert.rejects(cloud.postSession({ project: 'p', summary: 's' }), CloudUnavailableError);
});

test('socket reset mid-request throws CloudUnavailableError', async () => {
  const { server, url } = await listen((req) => req.socket.destroy());
  useCloud(url);
  try {
    await assert.rejects(cloud.listProjects(), CloudUnavailableError);
  } finally {
    server.close();
  }
});

test('body cut off mid-read throws CloudUnavailableError', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
    res.write('{"id":');
    setTimeout(() => res.socket.destroy(), 20);
  });
  useCloud(url);
  try {
    await assert.rejects(cloud.listProjects(), CloudUnavailableError);
  } finally {
    server.close();
  }
});

test('5xx is CloudUnavailableError, 4xx is a plain error with statusCode', async () => {
  const { server, url } = await listen((req, res) => {
    const status = req.url === '/projects' ? 503 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad input' }));
  });
  useCloud(url);
  try {
    await assert.rejects(cloud.listProjects(), CloudUnavailableError);
    await assert.rejects(cloud.postFact({}), (err) => {
      assert.ok(!(err instanceof CloudUnavailableError));
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, 'bad input');
      return true;
    });
  } finally {
    server.close();
  }
});

test('success returns the parsed body', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 42 }));
  });
  useCloud(url);
  try {
    assert.deepEqual(await cloud.postSession({ project: 'p', summary: 's' }), { id: 42 });
  } finally {
    server.close();
  }
});

test('isNetworkError recognises undici, DNS and timeout shapes but not HTTP or parse errors', () => {
  const fetchFailed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  assert.equal(isNetworkError(fetchFailed('ENOTFOUND')), true);
  assert.equal(isNetworkError(fetchFailed('EAI_AGAIN')), true);
  assert.equal(isNetworkError(fetchFailed('UND_ERR_CONNECT_TIMEOUT')), true);
  assert.equal(isNetworkError(new TypeError('fetch failed')), true);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(isNetworkError(Object.assign(new Error('bad'), { statusCode: 400 })), false);
  assert.equal(isNetworkError(new SyntaxError('Unexpected token')), false);
});

// The cloud's own body parser behind a real HTTP server: an oversized body must
// come back as a 413 the client can read, never a reset socket ("cloud down").
async function bodyLimitServer() {
  const { parseBody } = await import('../src/cloud-server.js');
  return listen(async (req, res) => {
    try {
      const body = await parseBody(req, res);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 7, got: Object.keys(body).length }));
    } catch (err) {
      res.writeHead(err.statusCode ?? 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

test('oversized body: the 413 reaches the client as a 4xx, not a network error', async () => {
  const { server, url } = await bodyLimitServer();
  useCloud(url);
  try {
    for (const size of [70 * 1024, 2 * 1024 * 1024]) {
      const res = await fetch(`${url}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'x'.repeat(size) }) });
      assert.equal(res.status, 413, `raw fetch, ${size} bytes`);
      assert.deepEqual(await res.json(), { error: 'Request body too large' });
    }
    // postFact trims to the caps, so send something the caps cannot shrink.
    await assert.rejects(cloud.postFeedback({ message: 'x'.repeat(200 * 1024) }), (err) => {
      assert.ok(!(err instanceof CloudUnavailableError), `got ${err.name}: ${err.message}`);
      assert.equal(err.statusCode, 413);
      return true;
    });
    // The connection is still usable afterwards.
    assert.equal((await cloud.postSession({ project: 'p', summary: 's' })).id, 7);
  } finally {
    server.close();
  }
});

test('postSession and postFact trim fields to the cloud caps before sending', async () => {
  let received;
  const { server, url } = await listen((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      received = JSON.parse(b);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
    });
  });
  useCloud(url);
  try {
    await cloud.postSession({ project: 'p'.repeat(300), summary: 's'.repeat(50_000), what_was_built: 'w'.repeat(20_000), tags: 't', session_date: '2026-09-27T10:00:00.000Z' });
    assert.equal(received.project.length, 100);
    assert.equal(received.summary.length, 4000);
    assert.equal(received.what_was_built.length, 8000);
    assert.equal(received.tags, 't');
    assert.equal(received.session_date, '2026-09-27T10:00:00.000Z');
    await cloud.postFact({ category: 'c'.repeat(500), content: 'x'.repeat(9000) });
    assert.equal(received.category.length, 200);
    assert.equal(received.content.length, 4000);
  } finally {
    server.close();
  }
});

test('a non-JSON 4xx (proxy error page) still carries its status code', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(413, { 'Content-Type': 'text/html' });
    res.end('<html>too big</html>');
  });
  useCloud(url);
  try {
    await assert.rejects(cloud.postSession({ project: 'p', summary: 's' }), (err) => {
      assert.ok(!(err instanceof CloudUnavailableError));
      assert.equal(err.statusCode, 413);
      return true;
    });
  } finally {
    server.close();
  }
});
