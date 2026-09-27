/**
 * What Next — Git Commit Watcher
 *
 * Polls ~/projects/ every 60 seconds. Detects new git commits
 * and posts them to the local REST API so context cards stay current
 * without any AI intervention.
 *
 * State persisted to ~/.whatnext/watcher-state.json to survive restarts.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECTS_DIR = process.env.WHATNEXT_PROJECTS_DIR || join(homedir(), 'projects');
const STATE_FILE = join(homedir(), '.whatnext', 'watcher-state.json');
const API_URL = `http://127.0.0.1:${process.env.WHATNEXT_PORT ?? 3747}`;
const POLL_INTERVAL_MS = 60_000;
const MAX_COMMITS_PER_POLL = 20;

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    mkdirSync(join(homedir(), '.whatnext'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

function runGit(cwd, args) {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function getProjectDirs() {
  try {
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: join(PROJECTS_DIR, e.name) }))
      .filter(p => existsSync(join(p.path, '.git')));
  } catch {
    return [];
  }
}

// True only when the API accepted the commit; the caller keeps its place
// otherwise and retries on the next poll.
async function postCommitContext(payload) {
  try {
    const res = await fetch(`${API_URL}/commit-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Commits since the last one recorded, oldest first, capped. First sight of a
// repo (or a lastKnown that no longer exists, e.g. after a rewrite) records
// HEAD only.
function newCommits(path, lastKnown, head) {
  if (!lastKnown) return [head];
  const out = runGit(path, `log --format=%H -n ${MAX_COMMITS_PER_POLL} --reverse ${lastKnown}..${head}`);
  if (out === null) return [head];
  return out.split('\n').filter(Boolean);
}

async function poll(state) {
  const dirs = getProjectDirs();

  for (const { name, path } of dirs) {
    const head = runGit(path, 'log -1 --format=%H HEAD');
    if (!head || !/^[0-9a-f]{40,64}$/.test(head)) continue;

    const lastKnown = state[name];
    if (lastKnown === head) continue;

    const pending = newCommits(path, lastKnown, head);
    // HEAD moved back (reset) or sideways with nothing new to record.
    if (pending.length === 0) state[name] = head;
    for (const hash of pending) {
      if (!/^[0-9a-f]{40,64}$/.test(hash)) break;
      const message = runGit(path, `log -1 --format=%s ${hash}`) ?? '';
      const body = runGit(path, `log -1 --format=%b ${hash}`) ?? '';
      const sessionUrl = body.match(/Claude-Session:\s*(https?:\/\/\S+)/)?.[1] ?? null;
      const committedAt = runGit(path, `log -1 --format=%aI ${hash}`) ?? new Date().toISOString();
      const changedFiles = runGit(path, `diff-tree --no-commit-id -r --name-only ${hash}`) ?? '';

      const ok = await postCommitContext({
        project: name,
        commit_hash: hash,
        message,
        changed_files: changedFiles,
        committed_at: committedAt,
        session_url: sessionUrl,
      });
      // Only move past a commit once it is stored; a failed post is retried.
      if (!ok) break;
      state[name] = hash;
      process.stderr.write(`[watcher] New commit in ${name}: ${hash.slice(0, 7)} ${message.slice(0, 60)}\n`);
    }
  }

  saveState(state);
}

export function startGitWatcher() {
  const state = loadState();

  setTimeout(async () => {
    await poll(state).catch(() => {});
    setInterval(() => poll(state).catch(() => {}), POLL_INTERVAL_MS);
  }, 8_000);

  process.stderr.write(`[watcher] Git commit watcher started — polling every ${POLL_INTERVAL_MS / 1000}s\n`);
}
