/**
 * Sync: persisted rejections, cycle-stopping statuses, client-side trimming,
 * session_date on push, local edits PATCHed, cloud edits and deletes pulled,
 * and gist flush behaviour on 4xx / 5xx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-sync-edits-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;
delete process.env.GITHUB_TOKEN;

const { env: hfEnv } = await import('@huggingface/transformers');
hfEnv.allowRemoteModels = false;
hfEnv.cacheDir = join(TEST_HOME, 'hf-cache');
hfEnv.localModelPath = join(TEST_HOME, 'hf-models');

const dbmod = await import('../src/db.js');
const db = dbmod.default;
const { addSession, editSession, getSessionById, storePendingGist, getPendingGists, setSessionCloudId, upsertSessionFromCloud, searchMemories } = dbmod;
const { pushToCloud, syncFromCloud, nextCursor } = await import('../src/sync.js');
const { syncPending } = await import('../src/gist-client.js');

// ─── Stub cloud ──────────────────────────────────────────────────────────────

const cloud = { posts: [], patches: [], exportBody: null, mode: null, nextId: 5000, sessions: new Map() };

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/health') return send(200, { ok: true });
  if (url.pathname === '/export') return send(200, cloud.exportBody ?? { sessions: [], facts: [], exported_at: new Date().toISOString() });
  const body = await readBody(req);
  if (cloud.mode === 401) return send(401, { error: 'Invalid or missing API key' });
  if (cloud.mode === 429) return send(429, { error: 'Too many requests' });
  if (req.method === 'POST' && url.pathname === '/session') {
    if (body.summary?.startsWith('reject-413')) return send(413, { error: 'Request body too large' });
    if (body.summary?.startsWith('reject-400')) return send(400, { error: 'bad' });
    if (body.summary?.startsWith('fail-500')) return send(500, { error: 'boom' });
    const id = cloud.nextId++;
    cloud.posts.push({ id, body });
    cloud.sessions.set(String(id), body);
    return send(201, { id });
  }
  const m = url.pathname.match(/^\/session\/(\d+)$/);
  if (req.method === 'PATCH' && m) {
    if (!cloud.sessions.has(m[1])) return send(404, { error: 'Session not found or not yours' });
    cloud.patches.push({ id: m[1], body });
    return send(200, { ok: true, updated_at: '2026-10-03 12:00:00.123456+00' });
  }
  send(404, { error: 'not found' });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.WHATNEXT_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;
process.env.WHATNEXT_API_KEY = 'bak_test';
test.after(() => server.close());

function backdate(id, minutes = 10) {
  db.prepare("UPDATE sessions SET created_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);
}
function oldSession(summary, extra = {}) {
  const id = addSession({ project: 'demo', summary, ...extra });
  backdate(id);
  return id;
}
// Rows from earlier tests that are still unsynced must not leak into later ones.
function settleAll() {
  db.prepare("UPDATE sessions SET cloud_id = COALESCE(cloud_id, 'settled-' || id), dirty = 0").run();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('a 4xx row is marked rejected on disk and later rows keep syncing', async () => {
  const bad = oldSession('reject-413 huge session');
  const bad400 = oldSession('reject-400 malformed');
  const good = oldSession('good row after rejects');

  assert.equal(await pushToCloud(), 1);
  assert.ok(getSessionById(good).cloud_id);
  assert.match(getSessionById(bad).sync_error, /^413/);
  assert.match(getSessionById(bad400).sync_error, /^400/);

  // Survives a restart: the rejection is in SQLite, not in memory.
  const postsBefore = cloud.posts.length;
  const after = oldSession('next good row');
  assert.equal(await pushToCloud({ batch: 1 }), 1, 'the rejected rows do not take the only batch slot');
  assert.equal(cloud.posts.length, postsBefore + 1);
  assert.ok(getSessionById(after).cloud_id);
  const rejected = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sync_error IS NOT NULL AND cloud_id IS NULL').get().n;
  assert.equal(rejected, 2);
  settleAll();
});

test('editing a rejected row clears the rejection so it gets another try', async () => {
  const id = oldSession('reject-400 typo');
  await pushToCloud();
  assert.ok(getSessionById(id).sync_error);
  editSession(id, { summary: 'fixed typo' });
  assert.equal(getSessionById(id).sync_error, null);
  await pushToCloud();
  assert.ok(getSessionById(id).cloud_id);
  assert.equal(cloud.posts.at(-1).body.summary, 'fixed typo');
  settleAll();
});

test('429 and 401 stop the cycle without marking anything rejected', async () => {
  const a = oldSession('rate limited one');
  const b = oldSession('rate limited two');
  for (const mode of [429, 401]) {
    cloud.mode = mode;
    const postsBefore = cloud.posts.length;
    assert.equal(await pushToCloud(), 0);
    assert.equal(cloud.posts.length, postsBefore);
    assert.equal(getSessionById(a).sync_error, null, `${mode} must not mark the row`);
    assert.equal(getSessionById(b).sync_error, null);
  }
  cloud.mode = null;
  assert.equal(await pushToCloud(), 2);
  settleAll();
});

test('oversized local rows are trimmed to the cloud caps and pushed with their session_date', async () => {
  const id = oldSession('long one', { what_was_built: 'w'.repeat(30_000), decisions: 'd'.repeat(9_000) });
  db.prepare("UPDATE sessions SET session_date = '2026-08-01 09:30:00' WHERE id = ?").run(id);
  assert.equal(await pushToCloud(), 1);
  const sent = cloud.posts.at(-1).body;
  assert.equal(sent.what_was_built.length, 8000);
  assert.equal(sent.decisions.length, 4000);
  assert.equal(sent.session_date, '2026-08-01T09:30:00.000Z');
  assert.ok(getSessionById(id).cloud_id);
  settleAll();
});

test('editSession marks the row dirty; sync PATCHes it once and clears the flag', async () => {
  const id = oldSession('to be edited');
  await pushToCloud();
  const cloudId = getSessionById(id).cloud_id;
  assert.ok(cloudId);
  assert.equal(getSessionById(id).dirty, 0);

  assert.equal(editSession(id, { next_steps: 'ship it' }), true, 'signature and return shape unchanged');
  const row = getSessionById(id);
  assert.equal(row.dirty, 1);
  assert.ok(row.updated_at);

  const patchesBefore = cloud.patches.length;
  assert.equal(await pushToCloud(), 1);
  assert.equal(cloud.patches.length, patchesBefore + 1);
  assert.equal(cloud.patches.at(-1).id, cloudId);
  assert.equal(cloud.patches.at(-1).body.next_steps, 'ship it');
  assert.equal(cloud.patches.at(-1).body.summary, 'to be edited');
  assert.equal(getSessionById(id).dirty, 0);
  assert.equal(getSessionById(id).updated_at, '2026-10-03T12:00:00.123Z', 'adopts the cloud updated_at');

  assert.equal(await pushToCloud(), 0, 'nothing left to send');
  assert.equal(cloud.patches.length, patchesBefore + 1);

  // The cloud echo of our own PATCH is not treated as a newer edit.
  assert.equal(upsertSessionFromCloud({ cloud_id: cloudId, project_name: 'demo', summary: 'to be edited', next_steps: 'ship it',
    created_at: '2026-10-01 10:00:00+00', updated_at: '2026-10-03 12:00:00.123456+00' }), null);

  // A PATCH the cloud refuses (row gone) is marked, not retried forever.
  const gone = oldSession('gone in cloud');
  setSessionCloudId(gone, '999999');
  editSession(gone, { summary: 'gone in cloud, edited' });
  await pushToCloud();
  assert.match(getSessionById(gone).sync_error, /^404/);
  settleAll();
});

test('pull: a newer cloud edit updates the local row; an older one does not', () => {
  const created = '2026-09-01 10:00:00+00';
  const id = upsertSessionFromCloud({ cloud_id: '7001', project_name: 'demo', summary: 'cloud original', session_date: '2026-09-01 10:00:00.5+00', created_at: created, updated_at: created });
  assert.ok(id);
  assert.equal(getSessionById(id).session_date, '2026-09-01 10:00:00', 'session_date stored in one normalised shape');

  // Unedited echo: nothing to do.
  assert.equal(upsertSessionFromCloud({ cloud_id: '7001', project_name: 'demo', summary: 'cloud original', created_at: created, updated_at: created }), null);

  const edited = upsertSessionFromCloud({ cloud_id: '7001', project_name: 'demo', summary: 'cloud wombat version', next_steps: 'new step', created_at: created, updated_at: '2026-09-05 10:00:00+00' });
  assert.equal(edited, id);
  assert.equal(getSessionById(id).summary, 'cloud wombat version');
  assert.equal(getSessionById(id).next_steps, 'new step');
  assert.deepEqual(searchMemories('wombat').sessions.map(s => s.id), [id], 'FTS follows the edit');
  assert.deepEqual(searchMemories('cloud original').sessions.map(s => s.id), []);

  // A local edit made after that wins over an older cloud copy.
  editSession(id, { summary: 'local edit wins' });
  assert.equal(upsertSessionFromCloud({ cloud_id: '7001', project_name: 'demo', summary: 'stale cloud', created_at: created, updated_at: '2026-09-06 10:00:00+00' }), null);
  assert.equal(getSessionById(id).summary, 'local edit wins');
  assert.equal(getSessionById(id).dirty, 1);
  settleAll();
});

test('pull: cloud tombstones delete the local copy, FTS row and embedding; cursor covers edits and deletes', async () => {
  const id = upsertSessionFromCloud({ cloud_id: '7100', project_name: 'demo', summary: 'doomed quokka session', created_at: '2026-09-01 10:00:00+00' });
  dbmod.storeEmbedding('session', id, [0.1, 0.2]);
  assert.equal(searchMemories('quokka').sessions.length, 1);

  cloud.exportBody = {
    sessions: [{ cloud_id: '7101', project_name: 'demo', summary: 'edited elsewhere', created_at: '2026-09-02 10:00:00+00', updated_at: '2026-09-20 10:00:00+00' }],
    facts: [],
    deleted_sessions: [{ cloud_id: '7100', deleted_at: '2026-09-25 10:00:00.5+00' }],
    exported_at: '2026-09-26T00:00:00.000Z',
  };
  await syncFromCloud();
  cloud.exportBody = null;

  assert.equal(getSessionById(id), undefined);
  assert.equal(searchMemories('quokka').sessions.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE rowtype = 'session' AND row_id = ?").get(id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE cloud_id = '7101'").get().n, 1);

  assert.equal(nextCursor({
    sessions: [{ created_at: '2026-09-02 10:00:00+00', updated_at: '2026-09-20 10:00:00+00' }],
    facts: [],
    deleted_sessions: [{ deleted_at: '2026-09-25 10:00:00+00' }],
  }, 'old'), '2026-09-25T09:50:00.000Z');
  settleAll();
});

test('gist flush: a 4xx gist is marked and skipped, later gists still sync, 5xx keeps the gist', async () => {
  storePendingGist('g-bad', JSON.stringify({ project: 'demo', summary: 'reject-400 gist' }));
  storePendingGist('g-5xx', JSON.stringify({ project: 'demo', summary: 'fail-500 gist' }));
  storePendingGist('g-junk', '{not json');
  storePendingGist('g-good', JSON.stringify({ project: 'demo', summary: 'good gist' }));
  const postsBefore = cloud.posts.length;

  await syncPending();

  assert.deepEqual(cloud.posts.slice(postsBefore).map(p => p.body.summary), ['good gist'], 'did not stop at the bad ones');
  assert.deepEqual(getPendingGists().map(g => g.gist_id), ['g-5xx'], '5xx is kept for retry; 4xx and junk are not retried');
  const marked = db.prepare('SELECT gist_id, sync_error FROM pending_gists WHERE sync_error IS NOT NULL ORDER BY id').all();
  assert.deepEqual(marked.map(g => g.gist_id), ['g-bad', 'g-junk']);
  assert.match(marked[0].sync_error, /^400/);

  await syncPending();
  assert.equal(cloud.posts.length, postsBefore + 1, 'the rejected gist is not posted again');

  // Cloud down mid-flush still stops the loop and keeps the gist.
  process.env.WHATNEXT_CLOUD_URL = 'http://127.0.0.1:1';
  try {
    await syncPending();
  } finally {
    process.env.WHATNEXT_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;
  }
  assert.deepEqual(getPendingGists().map(g => g.gist_id), ['g-5xx']);
});
