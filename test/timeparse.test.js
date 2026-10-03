import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeRange } from '../src/timeparse.js';

const NOW = new Date('2026-09-22T10:00:00Z'); // a Tuesday

test('no time phrase returns null', () => {
  assert.equal(parseTimeRange('auth decisions for surf-rides', NOW), null);
});

test('yesterday is one day, text stripped', () => {
  const r = parseTimeRange('what broke yesterday on surf-rides', NOW);
  assert.equal(r.since, '2026-09-21T00:00:00.000Z');
  assert.equal(r.until, '2026-09-22T00:00:00.000Z');
  assert.equal(r.text, 'what broke on surf-rides');
});

test('last week is the previous Monday to Sunday', () => {
  const r = parseTimeRange('budget last week', NOW);
  assert.equal(r.since.slice(0, 10), '2026-09-14');
  assert.equal(r.until.slice(0, 10), '2026-09-21');
  assert.equal(r.label, '2026-09-14 to 2026-09-20');
});

test('in <month> picks the most recent past occurrence', () => {
  const r = parseTimeRange('what did we decide about auth in August', NOW);
  assert.equal(r.since.slice(0, 10), '2026-08-01');
  assert.equal(r.until.slice(0, 10), '2026-09-01');
  assert.equal(r.text, 'what did we decide about auth');
  const nov = parseTimeRange('deploys in November', NOW);
  assert.equal(nov.since.slice(0, 4), '2025');
});

test('month with year, ISO date, N days ago, since', () => {
  assert.equal(parseTimeRange('July 2026 notes', NOW).since.slice(0, 10), '2026-07-01');
  const d = parseTimeRange('commit on 2026-08-13', NOW);
  assert.equal(d.since.slice(0, 10), '2026-08-13');
  assert.equal(d.until.slice(0, 10), '2026-08-14');
  assert.equal(parseTimeRange('3 days ago', NOW).since.slice(0, 10), '2026-09-19');
  const s = parseTimeRange('since 2026-07-01 railway', NOW);
  assert.equal(s.since.slice(0, 10), '2026-07-01');
  assert.equal(s.text, 'railway');
});

test('bare time phrase leaves empty text', () => {
  assert.equal(parseTimeRange('last month', NOW).text, '');
});

test('words that start like a month are not months', () => {
  for (const q of ['auth decisions 2026', 'notes in marketing', 'during junit runs', 'in decide mode', 'from octopus', 'in augmented reality',
    'sept-style notes in septic', 'in mayhem', 'marching 2026']) {
    assert.equal(parseTimeRange(q, NOW), null, q);
  }
});

test('may is a month only next to a year or after in/during/last', () => {
  assert.equal(parseTimeRange('we may need auth', NOW), null);
  assert.equal(parseTimeRange('data from may be lost', NOW), null);
  assert.equal(parseTimeRange('it may 2 things', NOW), null);
  assert.equal(parseTimeRange('deploys in may', NOW).since.slice(0, 10), '2026-05-01');
  assert.equal(parseTimeRange('May 2025 notes', NOW).since.slice(0, 10), '2025-05-01');
  assert.equal(parseTimeRange('last may', NOW).until.slice(0, 10), '2026-06-01');
});

test('exact abbreviations and last <month> still parse', () => {
  assert.equal(parseTimeRange('auth in Aug', NOW).since.slice(0, 10), '2026-08-01');
  assert.equal(parseTimeRange('Sept 2025 work', NOW).since.slice(0, 10), '2025-09-01');
  assert.equal(parseTimeRange('Dec 2025', NOW).since.slice(0, 10), '2025-12-01');
  assert.equal(parseTimeRange('during march', NOW).since.slice(0, 10), '2026-03-01');
  assert.equal(parseTimeRange('last september', NOW).since.slice(0, 10), '2025-09-01');
  const r = parseTimeRange('decisions in december', NOW);
  assert.equal(r.since.slice(0, 10), '2025-12-01');
  assert.equal(r.text, 'decisions');
});
