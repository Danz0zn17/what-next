import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'wn-watcher-test-'));
process.env.HOME = TEST_HOME;
process.env.WHATNEXT_PROJECTS_DIR = join(TEST_HOME, 'projects');

const { newCommits } = await import('../src/watcher.js');

const repo = join(TEST_HOME, 'repo');
const git = (...args) => execFileSync('git', args, {
  cwd: repo, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

execFileSync('mkdir', ['-p', repo]);
git('init', '-q');
const shas = [];
for (let i = 0; i < 25; i++) {
  writeFileSync(join(repo, 'f.txt'), String(i));
  git('add', 'f.txt');
  git('commit', '-q', '--no-verify', '-m', `c${i}`);
  shas.push(git('rev-parse', 'HEAD'));
}

after(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

test('backlog: the oldest 20 come first, in order, the rest wait for the next poll', async () => {
  const first = await newCommits(repo, shas[0], shas[24]);
  assert.deepEqual(first, shas.slice(1, 21));
  const second = await newCommits(repo, first.at(-1), shas[24]);
  assert.deepEqual(second, shas.slice(21));
});

test('first sight or a non-SHA lastKnown records HEAD only; bad head yields nothing', async () => {
  assert.deepEqual(await newCommits(repo, undefined, shas[24]), [shas[24]]);
  assert.deepEqual(await newCommits(repo, 'HEAD~3; rm -rf /', shas[24]), [shas[24]]);
  assert.deepEqual(await newCommits(repo, shas[0], '--output=/tmp/x'), []);
});

test('unknown lastKnown (history rewritten) records HEAD only', async () => {
  assert.deepEqual(await newCommits(repo, 'f'.repeat(40), shas[24]), [shas[24]]);
});
