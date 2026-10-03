/**
 * What Next — GitHub Gist fallback
 *
 * When the cloud is unreachable, session dumps are written to private GitHub Gists.
 * Gist IDs are stored locally in `pending_gists` (SQLite).
 * On next startup (when cloud is reachable), syncPending() flushes them to cloud.
 *
 * Requires: GITHUB_TOKEN env var (fine-grained PAT with Gist write permission)
 */
import db, { storePendingGist, getPendingGists, deletePendingGist, setSessionCloudId, markPendingGistRejected } from './db.js';
import * as cloud from './cloud-client.js';
import { sanitizeFields, SESSION_TEXT_FIELDS } from './sanitize.js';

const GIST_API = 'https://api.github.com/gists';
const GITHUB_TIMEOUT_MS = 10_000;

// The local row a gist payload was dumped from (same project and summary,
// compared after the same sanitise pass the local write went through).
// Rows that already carry a cloud id sort first.
export function findLocalTwin(payload) {
  if (!payload?.project || !payload?.summary) return null;
  const { values } = sanitizeFields({ summary: payload.summary }, SESSION_TEXT_FIELDS);
  return db.prepare(`
    SELECT s.id, s.cloud_id FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE p.name = ? AND s.summary = ?
    ORDER BY (s.cloud_id IS NULL) ASC, s.id ASC LIMIT 1
  `).get(payload.project, values.summary) ?? null;
}

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
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
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
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // Unreadable payload can never sync; keep the GitHub copy, stop retrying.
      markPendingGistRejected(row.id, 'invalid payload');
      console.error(`[gist] Gist ${row.gist_id} has an unreadable payload; no longer retried`);
      continue;
    }
    try {
      const twin = findLocalTwin(payload);
      if (twin?.cloud_id) {
        // Already reached the cloud (write-through retry or the sync push step).
        console.error(`[gist] Session already in cloud, dropping gist: ${row.gist_id}`);
      } else {
        const res = await cloud.postSession(payload);
        if (twin && res?.id) setSessionCloudId(twin.id, res.id);
      }
      deletePendingGist(row.id);

      // Delete gist from GitHub (cleanup)
      if (token) {
        fetch(`${GIST_API}/${row.gist_id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        }).catch(() => {});
      }

      console.error(`[gist] Synced and deleted gist: ${row.gist_id}`);
    } catch (err) {
      console.error(`[gist] Failed to sync gist ${row.gist_id}:`, err.message);
      const status = err?.statusCode;
      if (err instanceof cloud.CloudUnavailableError) {
        // A 5xx on this one payload while the cloud is up: keep it for next
        // time but carry on with the rest. Cloud gone: stop the flush.
        if (status >= 500 && await cloud.isReachable()) continue;
        break;
      }
      // 401 / 429 are about the key or the rate, not this gist: try again later.
      if (status === 401 || status === 429) break;
      // Any other 4xx: the cloud will never accept this payload. Stop retrying
      // it; the GitHub gist is kept, and the local session (if any) is pushed
      // by the regular sync, which trims fields to the cloud's caps first.
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        markPendingGistRejected(row.id, `${status}: ${err.message}`);
      }
    }
  }
}
