/**
 * What Next — Cloud ↔ Local Sync
 *
 * Pulls new sessions and facts from the cloud into local SQLite.
 * Runs once on startup, then every SYNC_INTERVAL_MS.
 *
 * Design:
 *   - Cloud is the source of truth for multi-surface writes
 *   - Local SQLite is the always-available read cache (never empty offline)
 *   - cloud_id column on sessions/facts prevents duplicates
 *   - last_cloud_sync timestamp stored in sync_state table
 */

import * as cloud from './cloud-client.js';
import { getLastCloudSync, setLastCloudSync, upsertSessionFromCloud, upsertFactFromCloud, storeEmbedding, getAllEmbeddings } from './db.js';

// Embeddings require native onnxruntime binaries and can be slow/dataless on
// macOS boot. Keep sync available and load embeddings only after the API starts.
let embeddingsPromise = null;
async function getGenerateEmbedding() {
  if (!embeddingsPromise) {
    embeddingsPromise = import('./embeddings.js')
      .then((mod) => mod.generateEmbedding)
      .catch((err) => {
        process.stderr.write(`[sync] embeddings unavailable — vector indexing skipped: ${err.message}\n`);
        return null;
      });
  }
  return embeddingsPromise;
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function syncFromCloud() {
  if (!cloud.isEnabled()) return;

  try {
    const reachable = await cloud.isReachable();
    if (!reachable) {
      process.stderr.write('[sync] Cloud unreachable — skipping sync\n');
      return;
    }

    const since = getLastCloudSync();
    const now = new Date().toISOString();

    const data = await cloud.exportSince(since);
    if (!data || data.error) {
      process.stderr.write(`[sync] Export failed: ${data?.error ?? 'unknown'}\n`);
      return;
    }

    const sessions = data.sessions ?? [];
    const facts = data.facts ?? [];

    const existingEmbeddings = new Set(
      getAllEmbeddings().map(e => `${e.rowtype}:${e.row_id}`)
    );
    const generateEmbedding = await getGenerateEmbedding();

    for (const session of sessions) {
      const localId = upsertSessionFromCloud(session);
      if (generateEmbedding && localId && !existingEmbeddings.has(`session:${localId}`)) {
        const text = [session.summary, session.what_was_built, session.decisions, session.next_steps, session.tags].filter(Boolean).join(' ');
        generateEmbedding(text).then(emb => storeEmbedding('session', localId, emb)).catch(() => {});
      }
    }
    for (const fact of facts) {
      const localId = upsertFactFromCloud(fact);
      if (generateEmbedding && localId && !existingEmbeddings.has(`fact:${localId}`)) {
        const text = [fact.category, fact.content, fact.tags].filter(Boolean).join(' ');
        generateEmbedding(text).then(emb => storeEmbedding('fact', localId, emb)).catch(() => {});
      }
    }

    setLastCloudSync(now);

    const total = sessions.length + facts.length;
    if (total > 0) {
      process.stderr.write(`[sync] Pulled ${sessions.length} session(s) + ${facts.length} fact(s) from cloud\n`);
    }
  } catch (err) {
    process.stderr.write(`[sync] Error: ${err.message}\n`);
  }
}

export function startPeriodicSync() {
  // Initial sync shortly after startup (give server a moment to bind)
  setTimeout(() => syncFromCloud().catch(() => {}), 4_000);
  // Then every 5 minutes
  setInterval(() => syncFromCloud().catch(() => {}), SYNC_INTERVAL_MS);
}
