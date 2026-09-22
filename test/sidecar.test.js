import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-sidecar-test-'));
process.env.WHATNEXT_DATA_DIR = join(TEST_HOME, 'data');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { addFact, addSession, addCommitContext, upsertProjectIntelligence, getHotFiles } = await import('../src/db.js');
const { writeSidecarForProject, writeGlobalContext } = await import('../src/sidecar.js');

const card = () => readFileSync(join(TEST_HOME, '.whatnext', 'agents', 'demo.md'), 'utf8');
const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();

test('hot files: counted from recent commits, lock files ignored, old commits excluded', () => {
  addCommitContext({ project: 'demo', commit_hash: 'a1', message: 'one', changed_files: 'src/api.js\nsrc/db.js\npackage-lock.json', committed_at: iso(2) });
  addCommitContext({ project: 'demo', commit_hash: 'a2', message: 'two', changed_files: 'src/api.js\nREADME.md', committed_at: iso(5) });
  addCommitContext({ project: 'demo', commit_hash: 'a3', message: 'old', changed_files: 'src/legacy.js', committed_at: iso(45) });
  const hot = getHotFiles('demo');
  assert.deepEqual(hot, [
    { file: 'src/api.js', commits: 2 },
    { file: 'README.md', commits: 1 },
    { file: 'src/db.js', commits: 1 },
  ]);
});

test('card renders lessons first, then tours and hot files above recent work, date in footer', () => {
  addFact({ project: 'demo', category: 'lesson', content: 'always pass the no-verify flag' });
  addFact({ project: 'demo', category: 'tour', content: 'Booking flow: BookingForm.tsx submit() -> api/bookings.ts create() -> db/bookings.ts insert(); checks in validateBooking(); boundary: do not touch payments/' });
  addFact({ project: 'demo', category: 'pattern', content: 'local first' });
  addSession({ project: 'demo', summary: 'did work' });
  writeSidecarForProject('demo');
  const c = card();
  const order = ['# demo | What Next Context', '## Lessons', '## Code Tours', '## Hot Files (last 30 days)', '## Recent Work', '_Updated '];
  let last = -1;
  for (const h of order) { const i = c.indexOf(h); assert.ok(i > last, `${h} missing or out of order`); last = i; }
  assert.equal(c.split('\n')[1], '', 'header line 2 must be blank so the prefix is byte-stable');
  assert.ok(c.includes('- src/api.js (2 commits)'));
  assert.ok(!c.includes('package-lock.json'));
  assert.ok(!c.includes('local first'), 'plain project facts are not rendered on the card');
});

test('card without tours or commits has neither section', () => {
  addSession({ project: 'bare', summary: 'x' });
  writeSidecarForProject('bare');
  const c = readFileSync(join(TEST_HOME, '.whatnext', 'agents', 'bare.md'), 'utf8');
  assert.ok(!c.includes('## Code Tours') && !c.includes('## Hot Files'));
});

test('AGENTS.md pointer: written when repo has no CLAUDE.md, skipped when it does', () => {
  const repoA = join(TEST_HOME, 'repoA'); mkdirSync(join(repoA, '.git'), { recursive: true });
  const repoB = join(TEST_HOME, 'repoB'); mkdirSync(join(repoB, '.git'), { recursive: true }); writeFileSync(join(repoB, 'CLAUDE.md'), '# b');
  upsertProjectIntelligence({ project: 'pa', repo_path: repoA, stack: 'node' });
  upsertProjectIntelligence({ project: 'pb', repo_path: repoB, stack: 'node' });
  writeSidecarForProject('pa'); writeSidecarForProject('pb');
  assert.ok(existsSync(join(repoA, 'AGENTS.md')));
  assert.ok(!existsSync(join(repoB, 'AGENTS.md')));
  writeSidecarForProject('pa');
  assert.equal((readFileSync(join(repoA, 'AGENTS.md'), 'utf8').match(/auto-managed block/g) || []).length, 1, 'block written once, not appended twice');
});

test('global context: lessons before facts, stable header', () => {
  addFact({ category: 'lesson', content: 'global lesson' });
  addFact({ category: 'preference', content: 'global pref' });
  writeGlobalContext();
  const g = readFileSync(join(TEST_HOME, '.whatnext', 'context.md'), 'utf8');
  assert.ok(g.indexOf('## Lessons') < g.indexOf('## Global Facts'));
  assert.equal(g.split('\n')[1], '');
});
