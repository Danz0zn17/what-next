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
import db, { getLastCloudSync, setLastCloudSync, upsertSessionFromCloud, upsertFactFromCloud, storeEmbedding, getAllEmbeddings, dedupeCloudEchoes, setSessionCloudId, setFactCloudId, getPendingGists } from './db.js';
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

// Rows the cloud rejected with a 4xx this process; skipped so they cannot
// block the batch every cycle.
const rejected = { session: new Set(), fact: new Set() };

// Cloud created_at comes back as Postgres text ("2026-09-27 10:00:00.123456+00").
export function parseCloudTimestamp(value) {
  if (!value || typeof value !== 'string') return NaN;
  let v = value.trim().replace(' ', 'T');
  v = v.replace(/(\.\d{3})\d+/, '$1');
  v = v.replace(/([+-]\d{2})$/, '$1:00');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(v)) v += 'Z';
  return Date.parse(v);
}

// Next cursor: newest created_at received, else the server's exported_at,
// else unchanged. Always minus the overlap window.
export function nextCursor(data, previous) {
  let max = NaN;
  for (const row of [...(data?.sessions ?? []), ...(data?.facts ?? [])]) {
    const t = parseCloudTimestamp(row.created_at);
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

async function pushOne(kind, row, post, setCloudId) {
  try {
    const res = await post();
    if (res?.id) {
      setCloudId(row.id, res.id);
      return true;
    }
  } catch (err) {
    if (err instanceof cloud.CloudUnavailableError) throw err;
    rejected[kind].add(row.id);
    process.stderr.write(`[sync] Cloud rejected local ${kind} ${row.id}: ${err.message}\n`);
  }
  return false;
}

// Push locally written rows (cloud_id IS NULL) the cloud never got. Cloud-pulled
// rows always carry a cloud_id, so only local writes match.
export async function pushToCloud({ batch = PUSH_BATCH, minAgeMinutes = PUSH_MIN_AGE_MINUTES } = {}) {
  const age = `-${Number(minAgeMinutes)} minutes`;
  let pushed = 0;
  try {
    const skipGists = pendingGistSessionIds();
    const sessions = db.prepare(`
      SELECT s.id, p.name AS project, s.summary, s.what_was_built, s.decisions, s.stack, s.next_steps, s.tags
      FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE s.cloud_id IS NULL AND COALESCE(julianday(s.created_at), 0) <= julianday('now', ?)
      ORDER BY s.id ASC LIMIT ?
    `).all(age, batch + rejected.session.size + skipGists.size)
      .filter(r => !rejected.session.has(r.id) && !skipGists.has(r.id))
      .slice(0, batch);
    for (const row of sessions) {
      const { id, ...body } = row;
      if (await pushOne('session', row, () => cloud.postSession(compact(body)), setSessionCloudId)) pushed++;
    }

    const facts = db.prepare(`
      SELECT f.id, p.name AS project, f.category, f.content, f.tags
      FROM facts f LEFT JOIN projects p ON p.id = f.project_id
      WHERE f.cloud_id IS NULL AND f.status = 'active' AND COALESCE(julianday(f.created_at), 0) <= julianday('now', ?)
      ORDER BY f.id ASC LIMIT ?
    `).all(age, batch + rejected.fact.size)
      .filter(r => !rejected.fact.has(r.id))
      .slice(0, batch);
    for (const row of facts) {
      const { id, ...body } = row;
      if (await pushOne('fact', row, () => cloud.postFact(compact(body)), setFactCloudId)) pushed++;
    }
  } catch (err) {
    if (!(err instanceof cloud.CloudUnavailableError)) throw err;
    process.stderr.write(`[sync] Push stopped, cloud unavailable: ${err.message}\n`);
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

    const existingEmbeddings = new Set(
      getAllEmbeddings().map(e => `${e.rowtype}:${e.row_id}`)
    );
    const generateEmbedding = await getGenerateEmbedding();

    let inserted = 0;
    for (const session of sessions) {
      const localId = upsertSessionFromCloud(session);
      if (localId) inserted++;
      if (generateEmbedding && localId && !existingEmbeddings.has(`session:${localId}`)) {
        const text = [session.summary, session.what_was_built, session.decisions, session.next_steps, session.tags].filter(Boolean).join(' ');
        generateEmbedding(text).then(emb => storeEmbedding('session', localId, emb)).catch(() => {});
      }
    }
    for (const fact of facts) {
      const localId = upsertFactFromCloud(fact);
      if (localId) inserted++;
      if (generateEmbedding && localId && !existingEmbeddings.has(`fact:${localId}`)) {
        const text = [fact.category, fact.content, fact.tags].filter(Boolean).join(' ');
        generateEmbedding(text).then(emb => storeEmbedding('fact', localId, emb)).catch(() => {});
      }
    }

    const cursor = nextCursor(data, getLastCloudSync());
    if (cursor) setLastCloudSync(cursor);
    if (!reconciled) setSyncFlag(RECONCILED_KEY, new Date().toISOString());

    if (inserted > 0) {
      process.stderr.write(`[sync] Pulled ${inserted} new row(s) from cloud (${sessions.length + facts.length} returned)\n`);
    }

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
