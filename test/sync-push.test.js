import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-sync-push-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;

// Never reach Hugging Face from tests: an empty cache and no remote models
// makes any embedding attempt fail fast (sync swallows that).
const { env: hfEnv } = await import('@huggingface/transformers');
hfEnv.allowRemoteModels = false;
hfEnv.cacheDir = join(TEST_HOME, 'hf-cache');
hfEnv.localModelPath = join(TEST_HOME, 'hf-models');

const dbmod = await import('../src/db.js');
const db = dbmod.default;
const { addSession, addFact, storePendingGist, getSessionById, getFactById, getLastCloudSync } = dbmod;
const { syncFromCloud, pushToCloud, nextCursor, parseCloudTimestamp } = await import('../src/sync.js');

// ─── Stub cloud ──────────────────────────────────────────────────────────────

const cloud = { sessions: [], facts: [], posts: [], exports: [], nextId: 1000, clock: Date.parse('2026-09-27T10:00:00Z') };

function pgText(ms) {
  // Postgres ::TEXT shape: "2026-09-27 10:00:00.123456+00"
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '456+00');
}

function stamp() {
  cloud.clock += 1000;
  return pgText(cloud.clock);
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/health') return send(200, { ok: true });
  if (url.pathname === '/export') {
    const since = url.searchParams.get('since');
    cloud.exports.push(since);
    const after = (r) => !since || parseCloudTimestamp(r.created_at) > Date.parse(since);
    return send(200, { sessions: cloud.sessions.filter(after), facts: cloud.facts.filter(after), exported_at: new Date(cloud.clock).toISOString() });
  }
  if (req.method === 'POST' && (url.pathname === '/session' || url.pathname === '/fact')) {
    const body = await readBody(req);
    if (body.summary === 'poison row') return send(400, { error: 'rejected' });
    const id = cloud.nextId++;
    cloud.posts.push({ path: url.pathname, body, id });
    const row = { cloud_id: String(id), project_name: body.project ?? null, created_at: stamp(), ...body };
    delete row.project;
    (url.pathname === '/session' ? cloud.sessions : cloud.facts).push(row);
    return send(201, { id });
  }
  send(404, { error: 'not found' });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const CLOUD_URL = `http://127.0.0.1:${server.address().port}`;
process.env.WHATNEXT_CLOUD_URL = CLOUD_URL;
process.env.WHATNEXT_API_KEY = 'bak_test';
test.after(() => server.close());

function backdate(table, id, minutes = 10) {
  db.prepare(`UPDATE ${table} SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${minutes} minutes`, id);
}

function countSessions(summary) {
  return db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE summary = ?').get(summary).n;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('parseCloudTimestamp and nextCursor use cloud time minus the overlap, never the local clock', () => {
  assert.equal(parseCloudTimestamp('2026-09-27 10:00:00.123456+00'), Date.parse('2026-09-27T10:00:00.123Z'));
  assert.equal(parseCloudTimestamp('2026-09-27T10:00:00Z'), Date.parse('2026-09-27T10:00:00Z'));
  const data = { sessions: [{ created_at: '2020-01-01 00:20:00+00' }], facts: [{ created_at: '2020-01-01 00:30:00.5+00' }] };
  assert.equal(nextCursor(data, 'old'), '2020-01-01T00:20:00.500Z');
  assert.equal(nextCursor({ sessions: [], facts: [], exported_at: '2020-01-01T01:00:00.000Z' }, 'old'), '2020-01-01T00:50:00.000Z');
  assert.equal(nextCursor({ sessions: [], facts: [] }, 'old'), 'old');
});

test('first sync reconciles with a full export, then pushes only old local rows the cloud lacks', async () => {
  // Already in the cloud (written before cloud_id was tracked): must adopt, not push.
  const already = addSession({ project: 'demo', summary: 'already in cloud' });
  backdate('sessions', already);
  cloud.sessions.push({ cloud_id: '500', project_name: 'demo', summary: 'already in cloud', created_at: stamp() });
  // Only in the cloud: pulled in with its cloud id, never pushed back.
  cloud.sessions.push({ cloud_id: '501', project_name: 'demo', summary: 'other machine', created_at: stamp() });

  const outage = addSession({ project: 'demo', summary: 'written during outage' });
  backdate('sessions', outage);
  const fact = addFact({ project: 'demo', category: 'lesson', content: 'imported fact' });
  backdate('facts', fact);
  const fresh = addSession({ project: 'demo', summary: 'write-through in flight' });
  const gisted = addSession({ project: 'demo', summary: 'queued as gist' });
  backdate('sessions', gisted);
  storePendingGist('g1', JSON.stringify({ project: 'demo', summary: 'queued as gist' }));

  await syncFromCloud();

  assert.equal(cloud.exports[0], null, 'first export is a full export');
  assert.deepEqual(cloud.posts.map(p => p.body.summary ?? p.body.content), ['written during outage', 'imported fact']);
  assert.equal(cloud.posts[1].body.project, 'demo');
  assert.equal(getSessionById(already).cloud_id, '500');
  assert.equal(getSessionById(outage).cloud_id, String(cloud.posts[0].id));
  assert.equal(getFactById(fact).cloud_id, String(cloud.posts[1].id));
  assert.equal(getSessionById(fresh).cloud_id, null);
  assert.equal(getSessionById(gisted).cloud_id, null);
  assert.equal(countSessions('other machine'), 1);

  // Cursor comes from the newest cloud created_at received, minus 10 minutes.
  const newest = Math.max(...[...cloud.sessions].slice(0, 2).map(r => parseCloudTimestamp(r.created_at)));
  assert.equal(getLastCloudSync(), new Date(newest - 10 * 60 * 1000).toISOString());
});

test('second sync: echoes of pushed rows are not duplicated and nothing is pushed twice', async () => {
  const postsBefore = cloud.posts.length;
  await syncFromCloud();
  assert.notEqual(cloud.exports.at(-1), null, 'later exports use the cursor');
  assert.equal(cloud.posts.length, postsBefore);
  assert.equal(countSessions('written during outage'), 1);
  assert.equal(countSessions('already in cloud'), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM facts WHERE content = 'imported fact'").get().n, 1);
});

test('a row the cloud rejects is skipped so it cannot block the batch', async () => {
  const poison = addSession({ project: 'demo', summary: 'poison row' });
  backdate('sessions', poison);
  const good = addSession({ project: 'demo', summary: 'good row after poison' });
  backdate('sessions', good);
  // Older unpushed rows from earlier tests are young or gist-owned; make them ineligible.
  db.prepare("UPDATE sessions SET cloud_id = 'x-' || id WHERE summary = 'write-through in flight'").run();

  assert.equal(await pushToCloud({ batch: 1 }), 0);
  assert.equal(await pushToCloud({ batch: 1 }), 1);
  assert.equal(getSessionById(poison).cloud_id, null);
  assert.ok(getSessionById(good).cloud_id);
});

test('cloud down: push stops quietly and leaves rows for the next cycle', async () => {
  const row = addSession({ project: 'demo', summary: 'offline row' });
  backdate('sessions', row);
  process.env.WHATNEXT_CLOUD_URL = 'http://127.0.0.1:1';
  try {
    assert.equal(await pushToCloud(), 0);
    await syncFromCloud();
  } finally {
    process.env.WHATNEXT_CLOUD_URL = CLOUD_URL;
  }
  assert.equal(getSessionById(row).cloud_id, null);
  assert.equal(await pushToCloud(), 1);
  assert.ok(getSessionById(row).cloud_id);
});

test('gist flush posts a queued session once, records its cloud id, and drops gists already in the cloud', async () => {
  delete process.env.GITHUB_TOKEN;
  const { syncPending } = await import('../src/gist-client.js');
  const { getPendingGists } = dbmod;
  const pushed = db.prepare("SELECT id FROM sessions WHERE summary = 'written during outage'").get().id;
  storePendingGist('g2', JSON.stringify({ project: 'demo', summary: 'written during outage' }));
  const postsBefore = cloud.posts.length;

  await syncPending();

  const posted = cloud.posts.slice(postsBefore).map(p => p.body.summary);
  assert.deepEqual(posted, ['queued as gist']);
  const gisted = db.prepare("SELECT cloud_id FROM sessions WHERE summary = 'queued as gist'").get();
  assert.equal(gisted.cloud_id, String(cloud.posts.at(-1).id));
  assert.ok(getSessionById(pushed).cloud_id);
  assert.equal(getPendingGists().length, 0);
});
