/**
 * What Next — GitHub Gist fallback
 *
 * When the cloud is unreachable, session dumps are written to private GitHub Gists.
 * Gist IDs are stored locally in `pending_gists` (SQLite).
 * On next startup (when cloud is reachable), syncPending() flushes them to cloud.
 *
 * Requires: GITHUB_TOKEN env var (fine-grained PAT with Gist write permission)
 */
import { storePendingGist, getPendingGists, deletePendingGist } from './db.js';
import * as cloud from './cloud-client.js';

const GIST_API = 'https://api.github.com/gists';

function githubToken() {
  return process.env.GITHUB_TOKEN;
}

/**
 * Write a session dump to a private GitHub Gist.
 * Stores the gist ID locally for later sync.
 * Silently does nothing if GITHUB_TOKEN is not set.
 */
export async function dumpToGist(sessionData) {
  const token = githubToken();
  if (!token) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `what-next-${timestamp}.json`;

  try {
    const res = await fetch(GIST_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        description: `What Next fallback — ${sessionData.project} — ${timestamp}`,
        public: false,
        files: {
          [filename]: { content: JSON.stringify(sessionData, null, 2) },
        },
      }),
    });

    if (!res.ok) {
      console.error(`[gist] Failed to create gist: ${res.status}`);
      return;
    }

    const gist = await res.json();
    storePendingGist(gist.id, JSON.stringify(sessionData));
    console.error(`[gist] Queued fallback gist: ${gist.id}`);
  } catch (err) {
    console.error('[gist] Error creating gist:', err.message);
  }
}

/**
 * Sync all pending gists to the cloud server.
 * Deletes each gist from GitHub after successful sync.
 * Called on startup when cloud becomes reachable.
 */
export async function syncPending() {
  const token = githubToken();
  const pending = getPendingGists();

  if (pending.length === 0) return;

  console.error(`[gist] Syncing ${pending.length} pending gist(s) to cloud...`);

  for (const row of pending) {
    try {
      const payload = JSON.parse(row.payload);
      await cloud.postSession(payload);
      deletePendingGist(row.id);

      // Delete gist from GitHub (cleanup)
      if (token) {
        fetch(`${GIST_API}/${row.gist_id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }).catch(() => {});
      }

      console.error(`[gist] Synced and deleted gist: ${row.gist_id}`);
    } catch (err) {
      console.error(`[gist] Failed to sync gist ${row.gist_id}:`, err.message);
    }
  }
}
