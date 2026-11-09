/**
 * Cloud /search fallback (GRE-407) against a real Postgres with pgvector.
 * Skipped unless TEST_DATABASE_URL points at a throwaway database, e.g.
 *   docker run -d --rm -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- test/search-fallback.test.js
 * The tables are created by initSchema and every row belongs to users made here.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DB = process.env.TEST_DATABASE_URL;
const { cases, noise } = JSON.parse(readFileSync(new URL('./fixtures/search-eval.json', import.meta.url), 'utf8'));

const { anyWordTsQuery, fuseRanked, safeTsQuery } = await import('../src/cloud-server.js');

test('anyWordTsQuery ORs distinct prefix words and drops junk', () => {
  assert.equal(anyWordTsQuery('What is the What Next repository?'), 'what:* | is:* | the:* | next:* | repository:*');
  assert.equal(anyWordTsQuery('npm run dream:dry'), 'npm:* | run:* | dream:* | dry:*');
  assert.equal(anyWordTsQuery('a ! ( )'), null);
  assert.equal(safeTsQuery('railway nixpacks'), 'railway:* & nixpacks:*', 'AND query is unchanged');
});

test('fuseRanked prefers ids ranked in several lists', () => {
  assert.deepEqual(fuseRanked([[1, 2, 3], [3, 4]]), [3, 1, 2, 4]);
  assert.deepEqual(fuseRanked([[], []]), []);
});

let cs, user, other;
before(async () => {
  if (!DB) return;
  process.env.DATABASE_URL = DB;
  process.env.PGSSLMODE = 'disable';
  // Fresh import so the pool reads DATABASE_URL set above.
  cs = await import(`../src/cloud-server.js?db=${Date.now()}`);
  await cs.initSchema();
  const stamp = Date.now();
  user = await cs.createUser({ email: `search-${stamp}@example.test`, name: 'search test' });
  other = await cs.createUser({ email: `other-${stamp}@example.test`, name: 'other tenant' });
  // Plain inserts (no embeddings) so the full-text fallback is tested on its own.
  const insert = (uid, content, category = 'fact') => cs.pool.query(
    'INSERT INTO facts (user_id, category, content) VALUES ($1, $2, $3) RETURNING id', [uid, category, content]);
  for (const c of cases) await insert(user.id, c.fact);
  for (const n of noise) await insert(user.id, n, 'note');
  await insert(other.id, 'Other tenant secret: the What Next repository is elsewhere.');
});

after(async () => {
  if (!cs) return;
  await cs.pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[user.id, other.id]]);
  await cs.pool.end();
});

test('every eval question finds its fact in the top 5', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  const misses = [];
  for (const c of cases) {
    const { facts } = await cs.searchMemories(user.id, c.q, 5);
    assert.ok(facts.length <= 5);
    if (!facts.some(f => f.content.includes(c.expect))) misses.push(c.id);
  }
  assert.deepEqual(misses, [], `missed: ${misses.join(', ')}`);
});

test('all-words matches still come first, newest first', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  const { facts } = await cs.searchMemories(user.id, 'railway nixpacks', 5);
  assert.match(facts[0].content, /nixpacks/);
  const exact = await cs.searchMemories(user.id, 'dreaming pass', 1);
  assert.equal(exact.facts.length, 1);
  assert.match(exact.facts[0].content, /dreaming pass/);
});

test('fallback keeps the response shape and never crosses tenants', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  const r = await cs.searchMemories(user.id, 'What is the What Next repository?', 10);
  assert.deepEqual(Object.keys(r).sort(), ['facts', 'sessions']);
  assert.ok(r.facts.every(f => !/Other tenant/.test(f.content)));
  for (const k of ['id', 'category', 'content', 'tags', 'project_name', 'created_at', 'source', 'last_verified_at', 'volatility', 'ttl_days']) {
    assert.ok(k in r.facts[0], k);
  }
  const ids = r.facts.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  const none = await cs.searchMemories(user.id, 'zzzqqq xxyyzz', 5);
  assert.deepEqual(none.facts, []);
});
