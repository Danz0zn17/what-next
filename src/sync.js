/**
 * What Next — Cloud ↔ Local Sync
 *
 * Pulls new sessions and facts from the cloud into local SQLite, then pushes
 * locally written rows the cloud never received (outages, imports).
 * Runs once on startup, then every SYNC_INTERVAL_MS.
 *
 * Design:
 *   - Cloud is the source of truth for multi-surface writes
 *   - Local SQLite is the always-available read cache (never empty offline)
 *   - cloud_id column on sessions/facts prevents duplicates
 *   - last_cloud_sync cursor stored in sync_state table, taken from the cloud's
 *     own timestamps (never the local clock) minus an overlap window
 */

import * as cloud from './cloud-client.js';
import db, { getLastCloudSync, setLastCloudSync, upsertSessionFromCloud, upsertFactFromCloud, storeEmbedding, dedupeCloudEchoes, setSessionCloudId, setFactCloudId, getPendingGists, markSyncError, getDirtySessions, markSessionSynced, deleteSessionByCloudId, parseCloudTimestamp } from './db.js';
import { findLocalTwin } from './gist-client.js';

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
// Re-read this much before the cursor each pull; upserts dedupe by cloud_id.
const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
// Rows younger than this may still be in flight on the write-through path.
const PUSH_MIN_AGE_MINUTES = 2;
const PUSH_BATCH = 25;
// Before the first push, pull everything once so rows that already reached the
// cloud (before cloud_id was tracked, or whose response was lost) adopt their
// cloud id instead of being pushed again.
const RECONCILED_KEY = 'push_reconciled';

// A 4xx rejection is persisted on the row (sync_error) and survives restarts.
// Rows that failed some other way (a non-HTTP error) are only skipped for the
// life of this process.
const rejected = { session: new Set(), fact: new Set(), edit: new Set() };

// Cloud timestamps come back as Postgres text ("2026-09-27 10:00:00.123456+00").
export { parseCloudTimestamp };

// Next cursor: newest created_at / updated_at / deleted_at received, else the
// server's exported_at, else unchanged. Always minus the overlap window.
export function nextCursor(data, previous) {
  let max = NaN;
  const stamps = [];
  for (const row of [...(data?.sessions ?? []), ...(data?.facts ?? [])]) stamps.push(row.created_at, row.updated_at);
  for (const row of data?.deleted_sessions ?? []) stamps.push(row.deleted_at);
  for (const stamp of stamps) {
    const t = parseCloudTimestamp(stamp);
    if (Number.isFinite(t) && !(t <= max)) max = t;
  }
  if (!Number.isFinite(max)) max = parseCloudTimestamp(data?.exported_at);
  if (!Number.isFinite(max)) return previous;
  return new Date(max - CURSOR_OVERLAP_MS).toISOString();
}

function getSyncFlag(key) {
  return db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
}

function setSyncFlag(key, value) {
  db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
}

// Local session ids still queued as a gist; the gist flush owns those.
function pendingGistSessionIds() {
  const ids = new Set();
  for (const row of getPendingGists()) {
    try {
      const twin = findLocalTwin(JSON.parse(row.payload));
      if (twin) ids.add(twin.id);
    } catch {}
  }
  return ids;
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

// 401 (bad or revoked key) and 429 (rate limited) say nothing about the row
// being sent: stop the cycle and retry next time, exactly like an outage.
function stopsCycle(err) {
  return err instanceof cloud.CloudUnavailableError || err?.statusCode === 401 || err?.statusCode === 429;
}

const TABLE = { session: 'sessions', edit: 'sessions', fact: 'facts' };

async function pushOne(kind, row, send, onSuccess) {
  try {
    return onSuccess(await send()) === true;
  } catch (err) {
    if (stopsCycle(err)) throw err;
    const status = err?.statusCode;
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      markSyncError(TABLE[kind], row.id, `${status}: ${err.message}`);
    } else {
      rejected[kind].add(row.id);
    }
    process.stderr.write(`[sync] Cloud rejected local ${kind} ${row.id}: ${err.message}\n`);
  }
  return false;
}

// Local session_date ("2026-09-27 10:00:00", UTC) as ISO for the cloud.
function isoDate(value) {
  const t = parseCloudTimestamp(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// Push locally written rows (cloud_id IS NULL) the cloud never got, then local
// edits of rows the cloud already has. Cloud-pulled rows always carry a
// cloud_id, so only local writes match the first query.
export async function pushToCloud({ batch = PUSH_BATCH, minAgeMinutes = PUSH_MIN_AGE_MINUTES } = {}) {
  const age = `-${Number(minAgeMinutes)} minutes`;
  let pushed = 0;
  try {
    const skipGists = pendingGistSessionIds();
    const sessions = db.prepare(`
      SELECT s.id, p.name AS project, s.summary, s.what_was_built, s.decisions, s.stack, s.next_steps, s.tags, s.session_date
      FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE s.cloud_id IS NULL AND s.sync_error IS NULL AND COALESCE(julianday(s.created_at), 0) <= julianday('now', ?)
      ORDER BY s.id ASC LIMIT ?
    `).all(age, batch + rejected.session.size + skipGists.size)
      .filter(r => !rejected.session.has(r.id) && !skipGists.has(r.id))
      .slice(0, batch);
    for (const row of sessions) {
      const { id, session_date, ...body } = row;
      const payload = compact({ ...body, session_date: isoDate(session_date) });
      if (await pushOne('session', row, () => cloud.postSession(payload), res => {
        if (!res?.id) return false;
        setSessionCloudId(id, res.id);
        return true;
      })) pushed++;
    }

    const facts = db.prepare(`
      SELECT f.id, p.name AS project, f.category, f.content, f.tags
      FROM facts f LEFT JOIN projects p ON p.id = f.project_id
      WHERE f.cloud_id IS NULL AND f.sync_error IS NULL AND f.status = 'active' AND COALESCE(julianday(f.created_at), 0) <= julianday('now', ?)
      ORDER BY f.id ASC LIMIT ?
    `).all(age, batch + rejected.fact.size)
      .filter(r => !rejected.fact.has(r.id))
      .slice(0, batch);
    for (const row of facts) {
      const { id, ...body } = row;
      if (await pushOne('fact', row, () => cloud.postFact(compact(body)), res => {
        if (!res?.id) return false;
        setFactCloudId(id, res.id);
        return true;
      })) pushed++;
    }

    const edits = getDirtySessions(batch + rejected.edit.size)
      .filter(r => !rejected.edit.has(r.id))
      .slice(0, batch);
    for (const row of edits) {
      const { id, cloud_id, updated_at, ...fields } = row;
      if (await pushOne('edit', row, () => cloud.editSession(cloud_id, fields), res => {
        if (!res?.ok) return false;
        markSessionSynced(id, updated_at, res.updated_at);
        return true;
      })) pushed++;
    }
  } catch (err) {
    if (!stopsCycle(err)) throw err;
    process.stderr.write(`[sync] Push stopped until next cycle: ${err.message}\n`);
  }
  if (pushed > 0) process.stderr.write(`[sync] Pushed ${pushed} local row(s) to cloud\n`);
  return pushed;
}

export async function syncFromCloud() {
  if (!cloud.isEnabled()) return;

  try {
    const reachable = await cloud.isReachable();
    if (!reachable) {
      process.stderr.write('[sync] Cloud unreachable — skipping sync\n');
      return;
    }

    const reconciled = getSyncFlag(RECONCILED_KEY);
    const since = reconciled ? getLastCloudSync() : null;

    const data = await cloud.exportSince(since);
    if (!data || data.error) {
      process.stderr.write(`[sync] Export failed: ${data?.error ?? 'unknown'}\n`);
      return;
    }

    const sessions = data.sessions ?? [];
    const facts = data.facts ?? [];

    const generateEmbedding = await getGenerateEmbedding();

    // A returned id is a row inserted, or rewritten by a newer cloud edit (which
    // drops its old embedding); both need a fresh embedding.
    let inserted = 0;
    for (const session of sessions) {
      const localId = upsertSessionFromCloud(session);
      if (localId) inserted++;
      if (generateEmbedding && localId) {
        const text = [session.summary, session.what_was_built, session.decisions, session.next_steps, session.tags].filter(Boolean).join(' ');
        generateEmbedding(text).then(emb => storeEmbedding('session', localId, emb)).catch(() => {});
      }
    }
    for (const fact of facts) {
      const localId = upsertFactFromCloud(fact);
      if (localId) inserted++;
      if (generateEmbedding && localId) {
        const text = [fact.category, fact.content, fact.tags].filter(Boolean).join(' ');
        generateEmbedding(text).then(emb => storeEmbedding('fact', localId, emb)).catch(() => {});
      }
    }

    let deleted = 0;
    for (const tomb of data.deleted_sessions ?? []) {
      if (deleteSessionByCloudId(tomb.cloud_id)) deleted++;
    }

    const cursor = nextCursor(data, getLastCloudSync());
    if (cursor) setLastCloudSync(cursor);
    if (!reconciled) setSyncFlag(RECONCILED_KEY, new Date().toISOString());

    if (inserted > 0) {
      process.stderr.write(`[sync] Pulled ${inserted} new or edited row(s) from cloud (${sessions.length + facts.length} returned)\n`);
    }
    if (deleted > 0) process.stderr.write(`[sync] Removed ${deleted} session(s) deleted in the cloud\n`);

    // Pull first so echoes of rows already in the cloud adopt their id, then push.
    await pushToCloud();
  } catch (err) {
    process.stderr.write(`[sync] Error: ${err.message}\n`);
  }
}

export function startPeriodicSync() {
  try {
    const r = dedupeCloudEchoes();
    if (!r.skipped) process.stderr.write(`[sync] One-off cleanup: removed ${r.sessions_removed} duplicate session(s), ${r.facts_removed} duplicate fact(s)\n`);
  } catch (err) {
    process.stderr.write(`[sync] Cleanup failed: ${err.message}\n`);
  }
  // Initial sync shortly after startup (give server a moment to bind)
  setTimeout(() => syncFromCloud().catch(() => {}), 4_000);
  // Then every 5 minutes
  setInterval(() => syncFromCloud().catch(() => {}), SYNC_INTERVAL_MS);
}
