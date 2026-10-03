import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-import-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;

const { importConversation, titleToProject, toSessionDate } = await import('../src/import-chatgpt.js');
const { default: db } = await import('../src/db.js');

after(() => { try { db.close(); } catch {} try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

const long = 'word '.repeat(150);
const convo = (over = {}) => ({
  id: 'abc-123', title: 'Build a booking app', create_time: 1717243200, // 2024-06-01 12:00:00 UTC
  messages: [{ role: 'user', text: 'help me' }, { role: 'assistant', text: long }],
  ...over,
});
const rows = () => db.prepare('SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON p.id = s.project_id ORDER BY s.id').all();

test('titleToProject is Unicode-aware and never empty', () => {
  assert.equal(titleToProject('Build a Booking App!'), 'build-a-booking-app');
  assert.equal(titleToProject('Café déjà vu'), 'café-déjà-vu');
  assert.equal(titleToProject('日本語のアプリ'), '日本語のアプリ');
  assert.equal(titleToProject('!!!'), 'chatgpt-import');
  assert.equal(titleToProject(''), 'chatgpt-import');
  assert.equal(titleToProject(null), 'chatgpt-import');
});

test('toSessionDate takes epoch seconds or ISO strings', () => {
  assert.equal(toSessionDate(1717243200), '2024-06-01 12:00:00');
  assert.equal(toSessionDate('2024-06-01T12:00:00.000Z'), '2024-06-01 12:00:00');
  assert.equal(toSessionDate(undefined), null);
  assert.equal(toSessionDate('nonsense'), null);
});

test('import keeps the conversation date and skips a second import', async () => {
  assert.equal(await importConversation(convo(), { index: false }), 'imported');
  assert.equal(await importConversation(convo(), { index: false }), 'duplicate');
  const r = rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].session_date, '2024-06-01 12:00:00');
  assert.equal(r[0].project, 'build-a-booking-app');
  assert.ok(r[0].tags.split(',').includes('chatgpt:abc-123'));
  assert.ok(r[0].tags.includes('2024-06'));
});

test('without an id, dedupe falls back to summary + date', async () => {
  const c = convo({ id: undefined, title: 'No id chat', create_time: 1700000000 });
  assert.equal(await importConversation(c, { index: false }), 'imported');
  assert.equal(await importConversation(c, { index: false }), 'duplicate');
  assert.equal(await importConversation({ ...c, create_time: 1700000999 }, { index: false }), 'imported');
});

test('trivial conversations are skipped, dry run writes nothing', async () => {
  assert.equal(await importConversation(convo({ id: 'short', messages: [{ role: 'assistant', text: 'hi' }] }), { index: false }), 'trivial');
  const before = rows().length;
  assert.equal(await importConversation(convo({ id: 'dry-1', create_time: 1600000000 }), { index: false, dryRun: true }), 'imported');
  assert.equal(rows().length, before);
});
