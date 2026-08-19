/**
 * Tests for the memory curator (src/curator.js).
 *
 * Uses a throwaway SQLite DB in a temp dir (WHATNEXT_DATA_DIR is set before
 * db.js is imported). Embeddings are injected directly via storeEmbedding so
 * no onnx model is ever loaded — findDuplicatePairs and runCuration only read
 * the stored index when every fact is already indexed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate ALL filesystem writes: the DB via WHATNEXT_DATA_DIR, and the sidecar
// context cards (written after an apply-run) via a redirected home dir.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-curator-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { addFact, storeEmbedding, getAllFacts, getActiveFacts, getFactById, getFactEmbeddings, getLastCurationRun, searchMemories } = await import('../src/db.js');
const { findDuplicatePairs, runCuration } = await import('../src/curator.js');

// Unit vectors for controlled cosine similarities
const V_BASE = [1, 0, 0];
const V_NEAR = [0.999, 0.0447, 0];   // ~0.999 vs V_BASE → auto-archive band
const V_SIMILAR = [0.9, 0.436, 0];   // ~0.90 vs V_BASE → review band
const V_DISTINCT = [0, 1, 0];        // 0.0 vs V_BASE → unrelated

// ─── findDuplicatePairs (pure) ───────────────────────────────────────────────

test('detects auto-archive pairs and keeps the newest', () => {
  const facts = [
    { id: 1, project_id: null, project_name: null, content: 'older duplicate' },
    { id: 2, project_id: null, project_name: null, content: 'newer duplicate' },
  ];
  const emb = new Map([[1, V_BASE], [2, V_NEAR]]);
  const { auto, review } = findDuplicatePairs(facts, emb);
  assert.equal(auto.length, 1);
  assert.equal(auto[0].archived_id, 1);
  assert.equal(auto[0].kept_id, 2);
  assert.equal(review.length, 0);
});

test('flags review-band pairs without slating them', () => {
  const facts = [
    { id: 1, project_id: null, project_name: null, content: 'a' },
    { id: 2, project_id: null, project_name: null, content: 'b' },
  ];
  const emb = new Map([[1, V_BASE], [2, V_SIMILAR]]);
  const { auto, review } = findDuplicatePairs(facts, emb);
  assert.equal(auto.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].a_id, 1);
  assert.equal(review[0].b_id, 2);
});

test('never merges across scopes (project vs global)', () => {
  const facts = [
    { id: 1, project_id: null, project_name: null, content: 'global fact' },
    { id: 2, project_id: 7, project_name: 'proj-a', content: 'same text, project scope' },
  ];
  const emb = new Map([[1, V_BASE], [2, V_BASE]]);
  const { auto, review } = findDuplicatePairs(facts, emb);
  assert.equal(auto.length, 0);
  assert.equal(review.length, 0);
});

test('duplicate chain resolves to a single survivor', () => {
  const facts = [
    { id: 1, project_id: null, project_name: null, content: 'v1' },
    { id: 2, project_id: null, project_name: null, content: 'v2' },
    { id: 3, project_id: null, project_name: null, content: 'v3' },
  ];
  const emb = new Map([[1, V_BASE], [2, V_BASE], [3, V_BASE]]);
  const { auto } = findDuplicatePairs(facts, emb);
  assert.equal(auto.length, 2);
  const archivedIds = auto.map(p => p.archived_id).sort();
  assert.deepEqual(archivedIds, [1, 2]);
  // id 3 (newest) survives and is never archived
  assert.ok(!archivedIds.includes(3));
});

test('facts without embeddings are skipped, not archived', () => {
  const facts = [
    { id: 1, project_id: null, project_name: null, content: 'indexed' },
    { id: 2, project_id: null, project_name: null, content: 'not indexed' },
  ];
  const emb = new Map([[1, V_BASE]]);
  const { auto, review } = findDuplicatePairs(facts, emb);
  assert.equal(auto.length, 0);
  assert.equal(review.length, 0);
});

// ─── runCuration (integration, temp SQLite) ──────────────────────────────────

test('end-to-end: archives duplicates, filters reads, records the run', async () => {
  const idOld = addFact({ category: 'preference', content: 'zebrafact always use conventional commits' });
  const idNew = addFact({ category: 'preference', content: 'zebrafact always use conventional commits everywhere' });
  const idOther = addFact({ category: 'lesson', content: 'quaggafact launchagent logs must live in library logs' });
  storeEmbedding('fact', idOld, V_BASE);
  storeEmbedding('fact', idNew, V_NEAR);
  storeEmbedding('fact', idOther, V_DISTINCT);

  // Dry run first: reports but changes nothing
  const dryReport = await runCuration({ apply: false });
  assert.equal(dryReport.dry_run, true);
  assert.equal(dryReport.auto_archived.length, 1);
  assert.equal(getActiveFacts().length, 3);

  // Real run: archives the older duplicate
  const report = await runCuration({ apply: true });
  assert.equal(report.dry_run, false);
  assert.equal(report.auto_archived.length, 1);
  assert.equal(report.auto_archived[0].archived_id, idOld);
  assert.equal(report.auto_archived[0].kept_id, idNew);

  // Archived fact excluded from active reads
  const activeIds = getAllFacts().map(f => f.id);
  assert.ok(!activeIds.includes(idOld));
  assert.ok(activeIds.includes(idNew));
  assert.ok(activeIds.includes(idOther));

  // Row still exists for recovery, with pointer to the survivor
  const archived = getFactById(idOld);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.superseded_by, idNew);

  // Embedding removed so semantic search can never surface it
  const embIds = getFactEmbeddings().map(e => e.row_id);
  assert.ok(!embIds.includes(idOld));
  assert.ok(embIds.includes(idNew));

  // FTS search no longer returns the archived fact
  const { facts } = searchMemories('zebrafact');
  const ftsIds = facts.map(f => f.id);
  assert.ok(!ftsIds.includes(idOld));
  assert.ok(ftsIds.includes(idNew));

  // Run recorded
  const last = getLastCurationRun();
  assert.equal(last.dry_run, false);
  assert.equal(last.auto_archived, 1);
  assert.equal(last.report.auto_archived[0].archived_id, idOld);
});

test('second run is idempotent — nothing left to archive', async () => {
  const report = await runCuration({ apply: true });
  assert.equal(report.auto_archived.length, 0);
});
