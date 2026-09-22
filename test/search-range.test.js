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
