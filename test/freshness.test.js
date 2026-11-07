import test from 'node:test';
import assert from 'node:assert/strict';
import { inferVolatility, freshnessOf, freshnessMarker, isDueSoon, toMs, normaliseVolatility, normaliseTtl, DEFAULT_TTL_DAYS } from '../src/freshness.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

test('volatility: explicit value wins, then category, then content', () => {
  assert.equal(inferVolatility({ category: 'deploy', content: 'x', volatility: 'stable' }), 'stable');
  assert.equal(inferVolatility({ category: 'pattern', content: 'y', volatility: 'volatile' }), 'volatile');
  for (const category of ['contact', 'Pricing', 'url', 'deploy', 'status', 'client']) {
    assert.equal(inferVolatility({ category, content: 'plain words' }), 'volatile', category);
  }
  assert.equal(inferVolatility({ category: 'note', content: 'site is https://a.netlify.app' }), 'volatile');
  assert.equal(inferVolatility({ category: 'note', content: 'mail jo@acme.co.za' }), 'volatile');
  assert.equal(inferVolatility({ category: 'note', content: 'call 082 555 1234' }), 'volatile');
  assert.equal(inferVolatility({ category: 'note', content: 'quote was R8,500' }), 'volatile');
  assert.equal(inferVolatility({ category: 'preference', content: 'no long dashes' }), 'stable');
  assert.equal(inferVolatility({ category: 'lesson', content: 'see https://x.io' }), 'stable', 'lessons never expire');
});

test('freshness: volatile facts go stale after the TTL, counted from the last check', () => {
  const fresh = { category: 'deploy', content: 'x', created_at: daysAgo(90), last_verified_at: daysAgo(3) };
  assert.equal(freshnessOf(fresh, NOW).state, 'fresh');
  assert.equal(freshnessOf({ ...fresh, last_verified_at: daysAgo(DEFAULT_TTL_DAYS + 1) }, NOW).state, 'stale');
  // Legacy rows (no last_verified_at) count from created_at.
  assert.equal(freshnessOf({ category: 'deploy', content: 'x', created_at: '2026-08-01 10:00:00' }, NOW).state, 'stale');
  assert.equal(freshnessOf({ category: 'deploy', content: 'x', created_at: daysAgo(10), ttl_days: 5 }, NOW).state, 'stale', 'own TTL');
  assert.equal(freshnessOf({ category: 'preference', content: 'x', created_at: daysAgo(900) }, NOW).state, 'stable');
});

test('a disputed fact reads as disputed whatever its age', () => {
  const f = { id: 7, category: 'preference', content: 'x', created_at: daysAgo(1), disputed_at: daysAgo(0), dispute_note: 'wrong domain' };
  assert.equal(freshnessOf(f, NOW).state, 'disputed');
  assert.match(freshnessMarker(f, NOW), /DISPUTED.*wrong domain.*review_fact id 7/);
});

test('markers are empty for fresh and stable facts, so old output is unchanged', () => {
  assert.equal(freshnessMarker({ category: 'preference', content: 'x', created_at: daysAgo(400) }, NOW), '');
  assert.equal(freshnessMarker({ category: 'deploy', content: 'x', created_at: daysAgo(1), last_verified_at: daysAgo(1) }, NOW), '');
  const stale = freshnessMarker({ id: 2, category: 'deploy', content: 'x', created_at: '2026-08-01 10:00:00' }, NOW);
  assert.match(stale, /^ \[STALE - not checked since 2026-08-01, volatile \(30d\)\. Re-check before use; review_fact id 2\]$/);
});

test('due soon looks seven days ahead', () => {
  assert.equal(isDueSoon({ category: 'deploy', content: 'x', last_verified_at: daysAgo(25) }, NOW), true);
  assert.equal(isDueSoon({ category: 'deploy', content: 'x', last_verified_at: daysAgo(5) }, NOW), false);
  assert.equal(isDueSoon({ category: 'preference', content: 'x', created_at: daysAgo(500) }, NOW), false);
});

test('timestamps in SQLite, ISO and Postgres text all parse', () => {
  const want = Date.parse('2026-09-21T13:41:56Z');
  assert.equal(toMs('2026-09-21 13:41:56'), want);
  assert.equal(toMs('2026-09-21T13:41:56.000Z'), want);
  assert.equal(toMs('2026-09-21 13:41:56.000123+00'), want);
  assert.ok(Number.isNaN(toMs(null)));
});

test('input normalisers drop bad values instead of failing', () => {
  assert.equal(normaliseVolatility('Volatile'), 'volatile');
  assert.equal(normaliseVolatility('sometimes'), null);
  assert.equal(normaliseTtl(14), 14);
  assert.equal(normaliseTtl(0), null);
  assert.equal(normaliseTtl('abc'), null);
});
