/**
 * What Next - linked entity pages (v2.5.0)
 *
 * One page per client and per product: repo, hosting, database, live or not,
 * open issues, last decision, with links between pages. Agents read a page
 * instead of rebuilding the picture from sessions on every run.
 *
 * Seeding builds pages from what is already stored:
 *   product pages - one per project: project intelligence (repo, hosting, stack),
 *                   the latest session's decisions and next steps, and facts in
 *                   url / database / live / status categories.
 *   client pages  - one per fact in the "client" category whose content starts
 *                   with a name ("Acme Surf: owner Jo, ..."), linked to the
 *                   fact's project page.
 * Seeded fields are tagged source 'seed'; a field set through update_page is
 * 'manual' and seeding never overwrites it. A field copied from a fact keeps
 * that fact's id and last-checked time, so an old value is shown stale on the
 * page (and in role blocks) exactly as it is on the fact itself.
 */

import {
  listProjects, getProjectIntelligence, getLatestSessionWith, getProjectFacts, getAllFacts,
  getPage, upsertPage, getBacklinks, getFactById, slugify, PAGE_FIELDS,
} from './db.js';
import { freshnessOf, freshnessMarker, toMs, DEFAULT_TTL_DAYS } from './freshness.js';

const DAY_MS = 86_400_000;
// Page fields whose value changes in the real world; shown stale after the TTL.
const VOLATILE_FIELDS = new Set(['hosting', 'url', 'live', 'status', 'contact', 'database', 'open_issues']);
const FACT_FIELD = [
  [/^(url|urls|domain|domains|site|website)$/i, 'url'],
  [/^(database|db)$/i, 'database'],
  [/^(live|launch)$/i, 'live'],
  [/^(status)$/i, 'status'],
  [/^(contact|contacts)$/i, 'contact'],
];

function trunc(s, n) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 3) + '...' : flat;
}

function day(v) {
  const ms = toMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

// A client fact names its client before the first ":" or " - ".
export function clientNameFromFact(content) {
  const m = String(content ?? '').match(/^\s*([^:\n]{2,60}?)\s*(?::|\s-\s|\s–\s|\s—\s)/);
  if (!m) return null;
  const name = m[1].trim();
  return /[a-z0-9]/i.test(name) && name.split(/\s+/).length <= 6 ? name : null;
}

// When a fact was last checked (last_verified_at, else created_at), as ISO.
const factMeta = (f) => ({ fact_id: Number(f.id), checked_at: freshnessOf(f).checked_at });

// What seeding would write: [{ slug, kind, title, project, fields, meta, links }].
export function planSeed() {
  const plans = new Map();
  const productSlug = new Map();
  for (const p of listProjects()) {
    const slug = slugify(p.name);
    if (!slug || plans.has(slug)) continue;
    const intel = getProjectIntelligence(p.name);
    const fields = {}, meta = {};
    if (p.description) fields.summary = trunc(p.description, 400);
    if (intel?.repo_path) fields.repo = intel.repo_path;
    if (intel?.deployment) fields.hosting = trunc(intel.deployment, 400);
    if (intel?.stack) fields.stack = trunc(intel.stack, 300);
    const decision = getLatestSessionWith(p.name, 'decisions');
    if (decision) fields.last_decision = `${day(decision.session_date)}: ${trunc(decision.value, 300)}`;
    const next = getLatestSessionWith(p.name, 'next_steps');
    if (next) fields.open_issues = `${day(next.session_date)}: ${trunc(next.value, 500)}`;
    // Newest fact wins per field (getProjectFacts is newest first).
    for (const f of getProjectFacts(p.name, 200)) {
      const hit = FACT_FIELD.find(([re]) => re.test(String(f.category ?? '').trim()));
      if (hit && !fields[hit[1]]) { fields[hit[1]] = trunc(f.content, 400); meta[hit[1]] = factMeta(f); }
    }
    plans.set(slug, { slug, kind: 'product', title: p.name, project: p.name, fields, meta, links: [] });
    productSlug.set(p.name, slug);
  }
  for (const f of getAllFacts()) {
    if (!/^clients?$/i.test(String(f.category ?? '').trim())) continue;
    const name = clientNameFromFact(f.content);
    const slug = name && slugify(name);
    if (!slug) continue;
    // A client and a product with the same name share a slug; keep the client
    // page distinct.
    const clientSlug = plans.has(slug) && plans.get(slug).kind === 'product' ? `${slug}-client` : slug;
    const plan = plans.get(clientSlug) ?? { slug: clientSlug, kind: 'client', title: name, project: null, fields: {}, meta: {}, links: [] };
    if (!plan.fields.summary) { plan.fields.summary = trunc(f.content, 400); plan.meta.summary = factMeta(f); }
    const prod = f.project_name && productSlug.get(f.project_name);
    if (prod) {
      if (!plan.links.includes(prod)) plan.links.push(prod);
      const pp = plans.get(prod);
      if (pp && !pp.links.includes(clientSlug)) pp.links.push(clientSlug);
    }
    plans.set(clientSlug, plan);
  }
  return [...plans.values()];
}

// Would this plan change the stored page? Mirrors upsertPage's seed rules.
function seedDiff(plan) {
  const page = getPage(plan.slug);
  if (!page) return 'create';
  for (const [name, value] of Object.entries(plan.fields)) {
    const prev = page.fields[name];
    if (prev && prev.source !== 'seed') continue;
    if (prev?.value !== value) return 'update';
    const m = plan.meta?.[name] ?? {};
    if ((prev.fact_id ?? null) !== (m.fact_id ?? null) || (prev.checked_at ?? null) !== (m.checked_at ?? null)) return 'update';
  }
  if (plan.links.some(l => !page.links.includes(l))) return 'update';
  return null;
}

export function seedPages({ apply = true } = {}) {
  const created = [], updated = [];
  for (const plan of planSeed()) {
    const action = seedDiff(plan);
    if (!action) continue;
    if (apply) upsertPage({ ...plan, source: 'seed' });
    (action === 'create' ? created : updated).push(plan.slug);
  }
  return { created, updated };
}

/**
 * Freshness of one page field: null when fine, else { state, checked_at, fact_id }.
 * A field copied from a fact follows that fact (stale or disputed there means
 * stale or disputed here). Any volatile field is also stale once its value was
 * last checked more than the TTL ago - the source fact's check time when it
 * has one, not the time seeding copied it onto the page.
 */
export function pageFieldState(name, field, now = Date.now()) {
  if (!field) return null;
  const fact = field.fact_id != null ? getFactById(field.fact_id) : null;
  const live = fact && fact.status === 'active' ? fact : null;
  const fr = live ? freshnessOf(live, now) : null;
  const checkedAt = fr?.checked_at ?? field.checked_at ?? field.updated_at;
  const out = (state) => ({ state, checked_at: checkedAt, fact_id: field.fact_id ?? null });
  if (fr?.state === 'disputed') return out('disputed');
  if (fr?.state === 'stale') return out('stale');
  if (!VOLATILE_FIELDS.has(name)) return null;
  const at = toMs(checkedAt);
  if (!Number.isFinite(at) || now - at < DEFAULT_TTL_DAYS * DAY_MS) return null;
  return out('stale');
}

export function pageFieldMarker(name, field, now = Date.now()) {
  const st = pageFieldState(name, field, now);
  if (!st) return '';
  const ref = st.fact_id != null ? `; review_fact id ${st.fact_id}` : '';
  if (st.state === 'disputed') return ` [DISPUTED - source fact reported wrong. Check before use${ref}]`;
  return ` [STALE - last checked ${day(st.checked_at)}, re-check before use${ref}]`;
}

// Short form for one-line snippets (role blocks, page lists).
export function pageFieldTag(name, field, now = Date.now()) {
  const st = pageFieldState(name, field, now);
  return st ? ` [${st.state === 'disputed' ? 'DISPUTED' : 'STALE'}]` : '';
}

const LABEL = {
  summary: 'Summary', repo: 'Repo', hosting: 'Hosting', database: 'Database', url: 'URL', live: 'Live',
  stack: 'Stack', contact: 'Contact', open_issues: 'Open issues', last_decision: 'Last decision', status: 'Status',
};

export function renderPage(page, { now = Date.now() } = {}) {
  const lines = [`# ${page.title} (${page.kind}) - page "${page.slug}"`];
  if (page.project_name) lines.push(`Project: ${page.project_name}`);
  lines.push('');
  const names = PAGE_FIELDS.filter(n => page.fields[n]);
  if (names.length === 0) lines.push('_No fields yet. Fill them with update_page._');
  for (const n of names) {
    const f = page.fields[n];
    lines.push(`- **${LABEL[n] ?? n}:** ${f.value}  _(${f.source}, ${day(f.updated_at)})_${pageFieldMarker(n, f, now)}`);
  }
  if (page.notes) { lines.push('', '## Notes', page.notes); }
  const backlinks = getBacklinks(page.slug);
  if (page.links.length || backlinks.length) lines.push('', '## Links');
  for (const l of page.links) {
    const target = getPage(l);
    lines.push(`- -> ${l}${target ? ` (${target.kind}: ${target.title})` : ' (no page yet)'}`);
  }
  for (const b of backlinks) if (!page.links.includes(b.slug)) lines.push(`- <- ${b.slug} (${b.kind}: ${b.title})`);
  if (page.project_name) {
    const facts = getProjectFacts(page.project_name, 8);
    if (facts.length) {
      lines.push('', '## Facts');
      for (const f of facts) lines.push(`- #${f.id} ${f.category}: ${trunc(f.content, 240)}${freshnessMarker(f, now)}`);
    }
  }
  lines.push('', `Updated ${day(page.updated_at)}. Change it with update_page; open a linked page with get_page.`);
  return lines;
}

export function renderPageList(pages, { now = Date.now() } = {}) {
  if (pages.length === 0) return ['No pages yet. Run the dreaming pass (curate_memory mode "full") to seed them from your projects, or create one with update_page.'];
  const lines = [`# Pages (${pages.length})`, ''];
  for (const p of pages) {
    const live = p.fields.live?.value ? ` - live: ${trunc(p.fields.live.value, 40)}${pageFieldTag('live', p.fields.live, now)}` : '';
    const host = p.fields.hosting?.value ? ` - ${trunc(p.fields.hosting.value, 60)}${pageFieldTag('hosting', p.fields.hosting, now)}` : '';
    lines.push(`- **${p.slug}** (${p.kind}) ${p.title}${host}${live}`);
  }
  lines.push('', 'Open one with get_page { slug }.');
  return lines;
}
