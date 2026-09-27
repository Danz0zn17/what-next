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
