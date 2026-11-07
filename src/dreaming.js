/**
 * What Next - dreaming pass (v2.5.0)
 *
 * The offline step that goes back over memory instead of only adding to it.
 * Built on the curator (src/curator.js), in this order:
 *
 *   1. disputed   facts reported wrong through send_feedback. With a correction,
 *                 the corrected fact is written and the old one superseded.
 *                 Without one, the fact stays flagged and is listed for re-check.
 *   2. duplicates the existing curator: near-duplicates archived, similar pairs flagged.
 *   3. lessons    sessions since the last pass are read and lines marked as a
 *                 lesson ("Lesson:", "Gotcha:", "Never ...", "Always ...") become
 *                 lesson facts, unless the same lesson is already stored.
 *   4. contradictions  similar facts in the same scope that name different URLs,
 *                 emails, phone numbers or amounts. The older one is marked
 *                 disputed so agents see a warning; nothing is retired.
 *   5. recheck    volatile facts that are stale or due within 7 days.
 *   6. pages      entity pages seeded/refreshed from projects and client facts.
 *
 * Never deletes. Every change is journalled under the run id (memory_changes)
 * and undoRun(run_id) reverts the lot. dry_run reports without changing
 * anything (the run record itself is the only write).
 */

import {
  getActiveFacts, getFactEmbeddings, getDisputedFacts, addFact, setFactStatus, disputeFact,
  journalCreatedFact, startCurationRun, finishCurationRun, getSessionsAfter, getSyncValue, setSyncValue,
} from './db.js';
import { runCuration } from './curator.js';
import { seedPages } from './pages.js';
import { freshnessOf, isDueSoon, inferVolatility, toMs } from './freshness.js';
import { writeGlobalContext, writeSidecarForProject } from './sidecar.js';

const LESSON_CURSOR = 'dream_session_cursor';
const MAX_LESSONS_PER_RUN = 20;
const MAX_LIST = 50;
const CONTRADICTION_COSINE = 0.8;
const CONTRADICTION_JACCARD = 0.5;
const DUPLICATE_JACCARD = 0.8;

function excerpt(s, n = 120) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 3) + '...' : flat;
}

// ─── Lessons ──────────────────────────────────────────────────────────────────
const MARKED = /^(?:lesson|lessons learned|learned|gotcha|rule|remember|note to self)\s*[:\-–]\s*(.+)$/i;
const IMPERATIVE = /^(?:never|always|do not|don't|must not)\b.+/i;

function splitLines(text) {
  return String(text ?? '')
    .split(/\n|(?<=[.!?])\s+(?=[A-Z])|;\s+/)
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Lesson candidates in one session. Marked lines count anywhere; imperative
 * "Never/Always" lines only in the decisions field, where they are rules the
 * session settled on rather than narration.
 */
export function extractLessons(session) {
  const out = [];
  const seen = new Set();
  const push = (text) => {
    const t = text.replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
    if (t.length < 15 || t.length > 500) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const field of ['summary', 'what_was_built', 'decisions', 'next_steps']) {
    for (const line of splitLines(session[field])) {
      const m = line.match(MARKED);
      if (m) push(m[1]);
      else if (field === 'decisions' && IMPERATIVE.test(line)) push(line);
    }
  }
  return out;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'it', 'its', 'this', 'that', 'with', 'at', 'by', 'as', 'from']);
export function tokens(text) {
  return new Set(String(text ?? '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)));
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ─── Contradictions ───────────────────────────────────────────────────────────
// Order matters: emails are taken out before URLs, since they contain a domain.
const VALUE_PATTERNS = {
  email: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  url: /\bhttps?:\/\/[^\s)>\]]+|\b[\w-]+(?:\.[\w-]+)*\.(?:netlify\.app|up\.railway\.app|supabase\.co|vercel\.app|co\.za|com|io|app|dev)\b/gi,
  phone: /(?:\+27|\b0)\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g,
  money: /\bR\s?\d[\d\s,]*(?:\.\d+)?\b|\$\s?\d[\d,]*(?:\.\d+)?\b/g,
};

export function valueTokens(text) {
  const out = {};
  let s = String(text ?? '');
  for (const [type, re] of Object.entries(VALUE_PATTERNS)) {
    const found = (s.match(re) ?? []).map(v => v.toLowerCase().replace(/[\s,]/g, '').replace(/\/+$/, '').replace(/^https?:\/\//, ''));
    if (found.length) out[type] = new Set(found);
    if (type === 'email') s = s.replace(re, ' ');
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pairs of active facts in the same scope that talk about the same thing but
 * name different values of the same type. `facts` oldest first. A pair where
 * one fact was verified after the other was written is settled, not flagged.
 */
export function findContradictions(facts, embeddingById = new Map()) {
  const withValues = facts
    .map(f => ({ f, values: valueTokens(f.content), words: tokens(f.content) }))
    .filter(x => Object.keys(x.values).length > 0);
  const pairs = [];
  for (let i = 0; i < withValues.length; i++) {
    for (let j = i + 1; j < withValues.length; j++) {
      const a = withValues[i], b = withValues[j];
      if ((a.f.project_id ?? null) !== (b.f.project_id ?? null)) continue;
      const ea = embeddingById.get(a.f.id), eb = embeddingById.get(b.f.id);
      // Either signal is enough: embeddings catch rewording, words catch facts
      // whose embeddings differ because the values themselves differ.
      const similar = (ea && eb && cosine(ea, eb) >= CONTRADICTION_COSINE)
        || (a.f.category === b.f.category && jaccard(a.words, b.words) >= CONTRADICTION_JACCARD);
      if (!similar) continue;
      const types = Object.keys(a.values).filter(t => b.values[t]);
      const differs = types.filter(t => ![...a.values[t]].some(v => b.values[t].has(v)));
      if (differs.length === 0) continue;
      const older = a.f, newer = b.f;
      // Settled: the older fact was re-checked (not just written) after the newer one appeared.
      const verified = toMs(older.last_verified_at);
      if (verified > toMs(older.created_at) + 2000 && verified > toMs(newer.created_at)) continue;
      pairs.push({
        older_id: older.id, newer_id: newer.id, project: older.project_name ?? null, differs,
        older_excerpt: excerpt(older.content), newer_excerpt: excerpt(newer.content),
      });
    }
  }
  return pairs;
}

// ─── The pass ─────────────────────────────────────────────────────────────────
export async function runDream({ apply = true, signal, budgetMs, now = Date.now() } = {}) {
  const start = Date.now();
  const stopped = () => signal?.aborted === true;
  const remaining = () => (budgetMs == null ? undefined : Math.max(0, budgetMs - (Date.now() - start)));
  const runId = startCurationRun({ dry_run: !apply, kind: 'dream' });
  const touched = new Set();
  const touch = (project) => { if (project) touched.add(project); };

  // 1. Disputed facts first.
  const disputed = [];
  for (const f of getDisputedFacts(MAX_LIST)) {
    if (stopped()) break;
    const item = { id: f.id, project: f.project_name ?? null, excerpt: excerpt(f.content), note: f.dispute_note ?? null };
    if (f.dispute_correction) {
      item.action = 'corrected';
      if (apply) {
        const newId = Number(addFact({
          project: f.project_name ?? undefined, category: f.category, content: f.dispute_correction, tags: f.tags ?? undefined,
          source: `feedback:fact#${f.id}`, volatility: f.volatility ?? undefined, ttl_days: f.ttl_days ?? undefined,
        }));
        journalCreatedFact(runId, newId, `correction of #${f.id}`);
        setFactStatus(f.id, 'superseded', { supersededBy: newId, runId, note: 'replaced by the correction sent with feedback' });
        item.replaced_by = newId;
        touch(f.project_name);
      }
    } else {
      item.action = 'needs_recheck';
    }
    disputed.push(item);
  }

  // 2. Duplicates (existing curator), journalled under this run.
  const curation = await runCuration({ apply, signal, budgetMs: remaining(), runId });
  for (const p of curation.auto_archived) touch(p.project);

  // 3. Lessons from sessions since the last pass.
  const cursor = Number(getSyncValue(LESSON_CURSOR) ?? 0) || 0;
  const sessions = stopped() ? [] : getSessionsAfter(cursor, 500);
  const active = getActiveFacts();
  const known = active.map(f => ({ scope: f.project_id ?? null, project: f.project_name ?? null, words: tokens(f.content), text: f.content.toLowerCase().trim() }));
  const lessons = [];
  let lastSeen = cursor;
  for (const s of sessions) {
    if (stopped() || lessons.length >= MAX_LESSONS_PER_RUN) break;
    // A session is read whole, so the cursor never skips half of one.
    for (const text of extractLessons(s)) {
      const words = tokens(text);
      const dup = known.some(k => k.project === s.project_name && (k.text === text.toLowerCase() || jaccard(k.words, words) >= DUPLICATE_JACCARD));
      if (dup) continue;
      const item = { session_id: s.id, project: s.project_name, lesson: excerpt(text, 200) };
      if (apply) {
        item.fact_id = Number(addFact({ project: s.project_name, category: 'lesson', content: text, tags: 'dreaming', source: `session:${s.id}` }));
        journalCreatedFact(runId, item.fact_id, `promoted from session ${s.id}`);
        touch(s.project_name);
      }
      known.push({ project: s.project_name, words, text: text.toLowerCase() });
      lessons.push(item);
    }
    lastSeen = s.id;
  }
  if (apply && lastSeen > cursor) setSyncValue(LESSON_CURSOR, lastSeen);

  // 4. Contradictions: flag the older fact as disputed.
  const facts = stopped() ? [] : getActiveFacts();
  const embeddingById = new Map(getFactEmbeddings().map(r => [r.row_id, r.embedding]));
  const contradictions = findContradictions(facts, embeddingById).slice(0, MAX_LIST);
  if (apply) {
    for (const c of contradictions) {
      const f = facts.find(x => x.id === c.older_id);
      if (!f || f.disputed_at) continue;
      disputeFact(c.older_id, { note: `contradicts newer #${c.newer_id} (${c.differs.join(', ')})`, runId });
      touch(c.project);
    }
  }

  // 5. Volatile facts due for re-check.
  const recheck = facts
    .filter(f => isDueSoon(f, now))
    .map(f => {
      const fr = freshnessOf(f, now);
      return { id: f.id, project: f.project_name ?? null, category: f.category, state: fr.state, due_at: fr.due_at, source: f.source ?? null, excerpt: excerpt(f.content) };
    })
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
    .slice(0, MAX_LIST);

  // 6. Entity pages.
  const pages = stopped() ? { created: [], updated: [] } : seedPages({ apply });

  const report = {
    run_id: runId,
    kind: 'dream',
    ran_at: new Date().toISOString(),
    dry_run: !apply,
    aborted: stopped(),
    disputed,
    duplicates: { facts_scanned: curation.facts_scanned, archived: curation.auto_archived, flagged_for_review: curation.flagged_for_review, unindexed_remaining: curation.unindexed_remaining },
    lessons_promoted: lessons,
    sessions_read: sessions.length,
    contradictions,
    recheck,
    volatile_facts: facts.filter(f => inferVolatility(f) === 'volatile').length,
    pages,
    duration_ms: Date.now() - start,
    undo: apply ? `POST /curate/undo {"run_id": ${runId}}` : null,
  };
  finishCurationRun(runId, {
    facts_scanned: curation.facts_scanned,
    auto_archived: curation.auto_archived.length,
    flagged: curation.flagged_for_review.length + contradictions.length + disputed.length,
    report,
  });

  if (apply && (touched.size > 0 || lessons.length > 0 || contradictions.length > 0)) {
    try { writeGlobalContext(); } catch {}
    for (const p of touched) { try { writeSidecarForProject(p); } catch {} }
  }
  process.stderr.write(
    `[dream] run ${runId}${apply ? '' : ' (dry run)'}: ${disputed.length} disputed, ${curation.auto_archived.length} duplicate(s), ` +
    `${lessons.length} lesson(s), ${contradictions.length} contradiction(s), ${recheck.length} to re-check, ` +
    `${pages.created.length + pages.updated.length} page(s) (${report.duration_ms}ms)\n`
  );
  return report;
}

// Short text summary for the MCP tool and the CLI.
export function formatDreamReport(r) {
  const lines = [`## Dreaming pass${r.dry_run ? ' (dry run - nothing changed)' : ''} - run ${r.run_id}`];
  if (r.aborted) lines.push('Stopped part way; only the changes listed happened.');
  lines.push('');
  lines.push(`**Disputed (${r.disputed.length})**`);
  for (const d of r.disputed) lines.push(`- #${d.id} ${d.action === 'corrected' ? (r.dry_run ? 'would be replaced by its correction' : `replaced by #${d.replaced_by}`) : 'no correction given - re-check it, then review_fact verify or retire'} [${d.project ?? 'global'}] "${d.excerpt}"`);
  lines.push('', `**Duplicates:** ${r.duplicates.archived.length} ${r.dry_run ? 'would be archived' : 'archived'}, ${r.duplicates.flagged_for_review.length} similar pair(s) flagged (scanned ${r.duplicates.facts_scanned}).`);
  lines.push('', `**Lessons from ${r.sessions_read} session(s): ${r.lessons_promoted.length}**`);
  for (const l of r.lessons_promoted) lines.push(`- [${l.project}] ${l.lesson}${l.fact_id ? ` (#${l.fact_id})` : ''}`);
  lines.push('', `**Contradictions (${r.contradictions.length})**${r.contradictions.length && !r.dry_run ? ' - older fact marked disputed' : ''}`);
  for (const c of r.contradictions) lines.push(`- #${c.older_id} vs newer #${c.newer_id} (${c.differs.join(', ')}) [${c.project ?? 'global'}]`);
  lines.push('', `**Due for re-check (${r.recheck.length} of ${r.volatile_facts} volatile)**`);
  for (const f of r.recheck.slice(0, 15)) lines.push(`- #${f.id} ${f.state === 'stale' ? 'STALE' : `due ${String(f.due_at).slice(0, 10)}`} ${f.category} [${f.project ?? 'global'}] "${f.excerpt}"`);
  if (r.recheck.length > 15) lines.push(`- ...and ${r.recheck.length - 15} more (GET /curate/run/status)`);
  lines.push('', `**Pages:** ${r.pages.created.length} ${r.dry_run ? 'to create' : 'created'}, ${r.pages.updated.length} ${r.dry_run ? 'to update' : 'updated'}.`);
  if (r.undo) lines.push('', `Undo this run: ${r.undo} or \`npm run dream -- --undo ${r.run_id}\`.`);
  return lines;
}
