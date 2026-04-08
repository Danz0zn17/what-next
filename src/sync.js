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
import { getLastCloudSync, setLastCloudSync, upsertSessionFromCloud, upsertFactFromCloud } from './db.js';

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

    for (const session of sessions) upsertSessionFromCloud(session);
    for (const fact of facts) upsertFactFromCloud(fact);

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
