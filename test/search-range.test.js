import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-range-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;

const { addSession, addFact, searchMemories } = await import('../src/db.js');
const { default: Database } = await import('better-sqlite3');
const db = new Database(join(TEST_HOME, 'data', 'what-next.db'));

const s1 = addSession({ project: 'demo', summary: 'railway deploy fixed the env var bug' });
const s2 = addSession({ project: 'demo', summary: 'railway deploy switched to nixpacks' });
const f1 = addFact({ project: 'demo', category: 'lesson', content: 'railway needs Node 22 pinned' });
db.prepare("UPDATE sessions SET session_date = '2026-08-10T09:00:00Z' WHERE id = ?").run(s1);
db.prepare("UPDATE sessions SET session_date = '2026-09-15T09:00:00Z' WHERE id = ?").run(s2);
db.prepare("UPDATE facts SET created_at = '2026-08-20T09:00:00Z' WHERE id = ?").run(f1);

test('range filters FTS results to the window', () => {
  const all = searchMemories('railway');
  assert.equal(all.sessions.length, 2);
  const aug = searchMemories('railway', 10, { since: '2026-08-01T00:00:00Z', until: '2026-09-01T00:00:00Z' });
  assert.deepEqual(aug.sessions.map(s => s.id), [s1]);
  assert.deepEqual(aug.facts.map(f => f.id), [f1]);
});

test('empty query with a range lists the window chronologically', () => {
  const r = searchMemories('', 10, { since: '2026-08-01T00:00:00Z', until: '2026-10-01T00:00:00Z' });
  assert.deepEqual(r.sessions.map(s => s.id), [s2, s1]);
});

test('control characters (including NUL) in a query never throw', () => {
  for (const q of ['rail\u0000way', '\u0000', '\u0007\u001b[31m', 'railway\u007f', '"\u0000"']) {
    assert.doesNotThrow(() => searchMemories(q), JSON.stringify(q));
  }
  assert.equal(searchMemories('rail\u0000way').sessions.length, 0, 'NUL splits the term rather than matching garbage');
  assert.equal(searchMemories('\u0000railway').sessions.length, 2);
  assert.deepEqual(searchMemories('\u0000 \u0001'), { sessions: [], facts: [] });
});

test('ISO "T" and SQLite space session_dates sort by time, not by format', async () => {
  const { getRecentSessionsForProject, getLastSession, getWhatsNext } = await import('../src/db.js');
  const older = addSession({ project: 'mixed', summary: 'older iso row', next_steps: 'old step' });
  const newer = addSession({ project: 'mixed', summary: 'newer sqlite row', next_steps: 'new step' });
  // Same day: the 'T' row is earlier but sorts later as plain text ('T' > ' ').
  db.prepare("UPDATE sessions SET session_date = '2026-09-21T08:00:00.000Z' WHERE id = ?").run(older);
  db.prepare("UPDATE sessions SET session_date = '2026-09-21 13:41:56' WHERE id = ?").run(newer);
  assert.deepEqual(getRecentSessionsForProject('mixed', 5).map(s => s.id), [newer, older]);
  assert.equal(getLastSession('mixed').id, newer);
  assert.equal(getWhatsNext(20).find(i => i.project_name === 'mixed').next_steps, 'new step');
});
