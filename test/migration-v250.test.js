/**
 * v2.5.0 migration against a real v2.4.0 database.
 *
 * test/fixtures/v2.4.0.db was written by the v2.4.0 code (see
 * scripts/make-v2.4.0-fixture.mjs): sessions, project intelligence, five facts
 * (one archived as a near-duplicate), a curation run and an embedding. A copy
 * is opened with the current db.js; every old row must still read the same,
 * and the new columns and tables must be there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOME = mkdtempSync(join(tmpdir(), 'wn-migration-'));
const DATA = join(HOME, 'data');
mkdirSync(DATA, { recursive: true });
copyFileSync(join(ROOT, 'test', 'fixtures', 'v2.4.0.db'), join(DATA, 'what-next.db'));
process.env.WHATNEXT_DATA_DIR = DATA;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const db = await import('../src/db.js');
const { freshnessOf } = await import('../src/freshness.js');
const raw = db.default;

test('old rows are all still there and read as before', () => {
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 5);
  const active = db.getAllFacts();
  assert.equal(active.length, 4, 'the archived duplicate stays hidden, the other four read');
  assert.deepEqual(active.map(f => f.id).sort(), [1, 2, 3, 4]);
  const archived = db.getFactById(5);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.superseded_by, 1);
  assert.equal(db.getProject('surf-rides').sessions.length, 1);
  assert.equal(db.getProjectIntelligence('surf-rides').repo_path, 'github.com/Danz0zn17/surf-rides');
  assert.equal(db.getLastCurationRun().auto_archived, 1);
  assert.equal(db.getLastCurationRun().kind, 'curate', 'old runs default to kind curate');
});

test('search still works on migrated rows', () => {
  const r = db.searchMemories('booking', 5);
  assert.equal(r.sessions.length, 1);
  const f = db.searchMemories('netlify', 5);
  assert.equal(f.facts.length, 1);
  assert.equal(f.facts[0].id, 2);
});

test('new columns exist and old facts are backfilled as unverified, never dropped', () => {
  const cols = raw.prepare('PRAGMA table_info(facts)').all().map(c => c.name);
  for (const c of ['source', 'last_verified_at', 'volatility', 'ttl_days', 'disputed_at', 'dispute_note', 'dispute_correction']) {
    assert.ok(cols.includes(c), `facts.${c}`);
  }
  const rows = raw.prepare('SELECT source, last_verified_at FROM facts').all();
  assert.ok(rows.every(r => r.source === 'unverified' && r.last_verified_at === null));
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
  assert.ok(tables.includes('memory_changes'));
  assert.ok(tables.includes('entity_pages'));
});

test('old volatile facts read as stale, old stable facts do not', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  assert.equal(freshnessOf(db.getFactById(2), now).state, 'stale', 'URL fact from August');
  assert.equal(freshnessOf(db.getFactById(3), now).state, 'stale', 'client contact from August');
  assert.equal(freshnessOf(db.getFactById(1), now).state, 'stable');
  assert.equal(freshnessOf(db.getFactById(4), now).state, 'stable', 'lessons never expire');
});

test('an archived v2.4.0 fact can be restored and the restore is journalled', () => {
  const state = db.restoreFact(5, { note: 'test' });
  assert.equal(state.status, 'active');
  assert.equal(db.getFactChanges(5).at(-1).action, 'restore');
  db.setFactStatus(5, 'archived', { supersededBy: 1 });
  assert.equal(db.getFactById(5).status, 'archived');
});

test('the migration is idempotent: loading db.js again changes nothing', async () => {
  const before = raw.prepare('SELECT * FROM facts ORDER BY id').all();
  // A second module instance runs every migration again against the same file.
  await import('../src/db.js?again');
  const after = raw.prepare('SELECT * FROM facts ORDER BY id').all();
  assert.deepEqual(after, before);
});
