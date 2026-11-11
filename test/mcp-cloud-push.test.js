import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Stdio clients (the Paperclip connector among them) start one MCP process per
// call and end it after the reply, so add_fact and dump_session must finish the
// cloud push before replying, within a bounded budget.

// Fake cloud: records each POST and answers after `delayMs`.
async function fakeCloud({ delayMs = 0 } = {}) {
  const posts = [];
  let nextId = 900;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ path: req.url, body: JSON.parse(body) });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.method === 'POST' ? { id: nextId++ } : { status: 'ok' }));
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

// Boots src/server.js, runs the tool calls in order, then kills the process the
// moment the last reply arrives, as a per-call client does.
function runCalls(dir, cloudUrl, calls, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/server.js'], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        USERPROFILE: dir,
        WHATNEXT_DATA_DIR: join(dir, 'data'),
        WHATNEXT_AUDIT_LOG_DIR: join(dir, 'logs'),
        WHATNEXT_CLOUD_URL: cloudUrl ?? '',
        WHATNEXT_API_KEY: cloudUrl ? 'bak_test' : '',
        WHATNEXT_NO_UPDATE_CHECK: '1',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies = [];
    let buf = '';
    let err = '';
    let sentAt = 0;
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout; stderr:\n${err}`)); }, 60_000);
    const send = (i) => {
      sentAt = Date.now();
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: calls[i] }) + '\n');
    };
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (replies.length === calls.length) resolve(replies);
      else reject(new Error(`server exited (${code ?? signal}) early; stderr:\n${err}`));
    });
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.id === 1) send(0);
        if (m.id >= 10) {
          replies.push({ text: m.result.content[0].text, ms: Date.now() - sentAt });
          if (replies.length < calls.length) send(replies.length);
          else p.kill('SIGKILL');
        }
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  });
}

function withDb(dir, fn) {
  const db = new Database(join(dir, 'data', 'what-next.db'));
  try { return fn(db); } finally { db.close(); }
}

const fact = (content) => ({ name: 'add_fact', arguments: { category: 'pattern', content, project: 'push-test' } });

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wn-push-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

test('add_fact reaches the cloud before the reply, even when the process is killed right after', { timeout: 90_000 }, async (t) => {
  const dir = tempDir(t);
  const cloud = await fakeCloud();
  t.after(() => cloud.close());

  const [reply] = await runCalls(dir, cloud.url, [fact('Port 3747 is the local API')]);
  assert.match(reply.text, /\[local \+ cloud\]/);
  assert.equal(cloud.posts.filter((p) => p.path === '/fact').length, 1);
  assert.equal(cloud.posts[0].body.content, 'Port 3747 is the local API');
  const row = withDb(dir, (db) => db.prepare('SELECT cloud_id FROM facts').get());
  assert.equal(String(row.cloud_id), '900');
});

test('dump_session reaches the cloud before the reply', { timeout: 90_000 }, async (t) => {
  const dir = tempDir(t);
  const cloud = await fakeCloud();
  t.after(() => cloud.close());

  const [reply] = await runCalls(dir, cloud.url, [{ name: 'dump_session', arguments: { project: 'push-test', summary: 'Wired the push' } }]);
  assert.match(reply.text, /\[local \+ cloud\]/);
  const row = withDb(dir, (db) => db.prepare('SELECT cloud_id FROM sessions').get());
  assert.equal(String(row.cloud_id), '900');
});

test('a slow cloud does not hold the reply past the budget; the row stays queued', { timeout: 90_000 }, async (t) => {
  const dir = tempDir(t);
  const cloud = await fakeCloud({ delayMs: 10_000 });
  t.after(() => cloud.close());

  const [reply] = await runCalls(dir, cloud.url, [fact('Slow cloud fact')], { WHATNEXT_CLOUD_WRITE_BUDGET_MS: '500' });
  assert.match(reply.text, /\[local, cloud sync queued\]/);
  assert.ok(reply.ms < 5_000, `reply took ${reply.ms}ms`);
  const row = withDb(dir, (db) => db.prepare('SELECT cloud_id FROM facts').get());
  assert.equal(row.cloud_id, null);
});

test('a write with the cloud reachable also sends rows earlier processes left queued', { timeout: 90_000 }, async (t) => {
  const dir = tempDir(t);
  // An earlier process wrote while offline and exited.
  await runCalls(dir, null, [fact('Written offline'), fact('Also offline')]);
  withDb(dir, (db) => db.prepare("UPDATE facts SET created_at = datetime('now', '-10 minutes')").run());

  const cloud = await fakeCloud();
  t.after(() => cloud.close());
  const [reply] = await runCalls(dir, cloud.url, [fact('Written online')]);
  assert.match(reply.text, /\[local \+ cloud\]/);

  const sent = cloud.posts.filter((p) => p.path === '/fact').map((p) => p.body.content).sort();
  assert.deepEqual(sent, ['Also offline', 'Written offline', 'Written online']);
  const unsynced = withDb(dir, (db) => db.prepare('SELECT COUNT(*) AS n FROM facts WHERE cloud_id IS NULL').get().n);
  assert.equal(unsynced, 0);
});
