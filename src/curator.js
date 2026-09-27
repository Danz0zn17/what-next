/**
 * What Next — Memory Curator (evaluation loop)
 *
 * Reviews stored facts for near-duplicates using the local embedding index
 * (all-MiniLM-L6-v2 — fully offline, no LLM API needed). Non-destructive:
 * duplicates are archived (status='archived', superseded_by points at the
 * surviving fact), never deleted. Sessions are never curated — they are a
 * time-stamped journal, not a fact store.
 *
 * Runs daily inside the API server, on demand via the `curate_memory` MCP
 * tool or POST /curate. Disable the periodic run with WHATNEXT_CURATOR=0.
 *
 * Thresholds (cosine similarity, same scope only — same project or both global):
 *   >= AUTO_ARCHIVE_THRESHOLD  auto-archive the older fact, keep the newest
 *   >= REVIEW_THRESHOLD        flag the pair for review, change nothing
 */

import { getActiveFacts, getFactEmbeddings, archiveFact, storeEmbedding, recordCurationRun } from './db.js';
import { writeGlobalContext, writeSidecarForProject } from './sidecar.js';

const AUTO_ARCHIVE_THRESHOLD = 0.95;
const REVIEW_THRESHOLD = 0.85;
const MAX_INDEX_PER_RUN = 30; // embedding backfill cap so a single run stays fast
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Embeddings require native onnxruntime binaries — load lazily and only when
// facts are missing from the index (same pattern as sync.js).
let embeddingsPromise = null;
function loadEmbeddings() {
  if (!embeddingsPromise) {
    embeddingsPromise = import('./embeddings.js').catch((err) => {
      process.stderr.write(`[curator] embeddings unavailable — backfill skipped: ${err.message}\n`);
      return null;
    });
  }
  return embeddingsPromise;
}

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function excerpt(s, n = 120) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 3) + '...' : flat;
}

/**
 * Pure pair detection. `facts` must be sorted oldest-first (getActiveFacts
 * order); the older fact of an auto pair is always the one archived. A fact
 * already slated for archive this run is skipped in later pairs, so duplicate
 * chains (A~B~C) resolve to a single survivor.
 */
export function findDuplicatePairs(facts, embeddingById, {
  autoThreshold = AUTO_ARCHIVE_THRESHOLD,
  reviewThreshold = REVIEW_THRESHOLD,
} = {}) {
  const auto = [];
  const review = [];
  const slated = new Set();

  for (let i = 0; i < facts.length; i++) {
    const a = facts[i];
    if (slated.has(a.id)) continue;
    const ea = embeddingById.get(a.id);
    if (!ea) continue;
    const scopeA = a.project_id ?? 'global';

    for (let j = i + 1; j < facts.length; j++) {
      const b = facts[j];
      if (slated.has(a.id)) break;
      if (slated.has(b.id)) continue;
      if ((b.project_id ?? 'global') !== scopeA) continue;
      const eb = embeddingById.get(b.id);
      if (!eb) continue;

      const similarity = Number(cosine(ea, eb).toFixed(4));
      // A "lesson" is a fixed mistake; losing one is worse than a duplicate, so
      // lesson pairs only ever go to the review band.
      const protectedPair = a.category === 'lesson' || b.category === 'lesson';
      if (similarity >= autoThreshold && !protectedPair) {
        slated.add(a.id);
        auto.push({
          archived_id: a.id,
          kept_id: b.id,
          similarity,
          project: a.project_name ?? null,
          archived_excerpt: excerpt(a.content),
          kept_excerpt: excerpt(b.content),
        });
      } else if (similarity >= reviewThreshold) {
        review.push({
          a_id: a.id,
          b_id: b.id,
          similarity,
          project: a.project_name ?? null,
          a_excerpt: excerpt(a.content),
          b_excerpt: excerpt(b.content),
        });
      }
    }
  }

  return { auto, review };
}

// `signal` (AbortSignal) stops the run between items: nothing further is
// indexed or archived once it fires, and the report says so. `budgetMs` caps
// the embedding backfill so a caller with a deadline still gets a report;
// facts left unindexed are picked up by the next run.
export async function runCuration({ apply = true, signal, budgetMs } = {}) {
  const start = Date.now();
  const overBudget = () => budgetMs != null && Date.now() - start >= budgetMs;
  const stopped = () => signal?.aborted === true;
  const facts = getActiveFacts();
  const embeddingById = new Map(getFactEmbeddings().map(r => [r.row_id, r.embedding]));

  // Backfill embeddings for facts not yet indexed (capped per run)
  const missing = facts.filter(f => !embeddingById.has(f.id));
  let indexed = 0;
  if (missing.length > 0) {
    const mod = await loadEmbeddings();
    if (mod?.generateEmbedding) {
      for (const f of missing.slice(0, MAX_INDEX_PER_RUN)) {
        if (stopped() || overBudget()) break;
        try {
          const emb = await mod.generateEmbedding([f.category, f.content, f.tags].filter(Boolean).join(' '));
          storeEmbedding('fact', f.id, emb);
          embeddingById.set(f.id, emb);
          indexed++;
        } catch {
          break;
        }
      }
    }
  }

  const { auto, review } = findDuplicatePairs(facts, embeddingById);

  const touchedProjects = new Set();
  const applied = [];
  if (apply) {
    for (const pair of auto) {
      if (stopped()) break;
      archiveFact(pair.archived_id, pair.kept_id);
      applied.push(pair);
      if (pair.project) touchedProjects.add(pair.project);
    }
  }
  const archived = apply ? applied : auto;

  const report = {
    ran_at: new Date().toISOString(),
    dry_run: !apply,
    aborted: stopped(),
    facts_scanned: facts.length,
    unindexed_remaining: Math.max(0, missing.length - indexed),
    auto_archived: archived,
    flagged_for_review: review,
    duration_ms: Date.now() - start,
  };
  recordCurationRun({
    dry_run: !apply,
    facts_scanned: facts.length,
    auto_archived: archived.length,
    flagged: review.length,
    report,
  });

  // Archived facts change what context cards show — refresh them
  if (apply && archived.length > 0) {
    try { writeGlobalContext(); } catch {}
    for (const project of touchedProjects) {
      try { writeSidecarForProject(project); } catch {}
    }
  }

  process.stderr.write(
    `[curator] scanned ${facts.length} facts - ${apply ? 'archived' : 'would archive'} ${archived.length}${report.aborted ? ' (aborted)' : ''}, ` +
    `flagged ${review.length} for review (${report.duration_ms}ms)\n`
  );
  return report;
}

export function startPeriodicCuration() {
  if (process.env.WHATNEXT_CURATOR === '0') {
    process.stderr.write('[curator] disabled via WHATNEXT_CURATOR=0\n');
    return;
  }
  // First run 60s after boot (let embeddings/native deps settle), then daily
  setTimeout(() => runCuration().catch(() => {}), 60_000);
  setInterval(() => runCuration().catch(() => {}), RUN_INTERVAL_MS);
}
