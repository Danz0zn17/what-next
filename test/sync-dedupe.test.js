import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-sync-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;

const { addSession, addFact, upsertSessionFromCloud, upsertFactFromCloud, setSessionCloudId, storeEmbedding, getAllEmbeddings, searchMemories, dedupeCloudEchoes, getSessionById, getAllFacts } = await import('../src/db.js');

test('cloud echo of a locally written session adopts the cloud id instead of inserting', () => {
  const local = addSession({ project: 'demo', summary: 'shipped the auth fix' });
  const inserted = upsertSessionFromCloud({ cloud_id: '901', project_name: 'demo', summary: 'shipped the auth fix', session_date: '2026-09-22T10:00:00Z' });
  assert.equal(inserted, null);
  assert.equal(getSessionById(local).cloud_id, '901');
  // second pull of the same cloud row is a no-op
  assert.equal(upsertSessionFromCloud({ cloud_id: '901', project_name: 'demo', summary: 'shipped the auth fix' }), null);
  assert.equal(searchMemories('auth').sessions.length, 1);
});

test('a genuinely new cloud session still inserts', () => {
  const id = upsertSessionFromCloud({ cloud_id: '902', project_name: 'demo', summary: 'something only the other machine did' });
  assert.ok(id > 0);
});

test('setSessionCloudId never overwrites an existing cloud id', () => {
  const id = addSession({ project: 'demo', summary: 'row with id' });
  setSessionCloudId(id, '1'); setSessionCloudId(id, '2');
  assert.equal(getSessionById(id).cloud_id, '1');
});

test('fact echo adopts cloud id', () => {
  const local = addFact({ category: 'lesson', content: 'pin node 22' });
  assert.equal(upsertFactFromCloud({ cloud_id: '55', project_name: null, category: 'lesson', content: 'pin node 22' }), null);
  assert.equal(getAllFacts().find(f => f.id === local).cloud_id, '55');
});

test('dedupeCloudEchoes removes existing duplicates, keeps the cloud row, cleans FTS and embeddings, runs once', () => {
  const keep = addSession({ project: 'old', summary: 'legacy duplicated session' });
  setSessionCloudId(keep, '700');
  const dupA = addSession({ project: 'old', summary: 'legacy duplicated session' });
  const dupB = addSession({ project: 'old', summary: 'legacy duplicated session' });
  storeEmbedding('session', dupA, [1, 0, 0]);
  storeEmbedding('session', keep, [1, 0, 0]);
  const before = searchMemories('legacy').sessions.length;
  assert.equal(before, 3);

  const r = dedupeCloudEchoes();
  assert.equal(r.sessions_removed, 2);
  assert.equal(r.skipped, false);
  assert.equal(getSessionById(dupA), undefined);
  assert.equal(getSessionById(dupB), undefined);
  assert.equal(getSessionById(keep).cloud_id, '700');
  assert.equal(searchMemories('legacy').sessions.length, 1);
  assert.deepEqual(getAllEmbeddings().filter(e => e.rowtype === 'session').map(e => e.row_id), [keep]);

  assert.equal(dedupeCloudEchoes().skipped, true);
});
