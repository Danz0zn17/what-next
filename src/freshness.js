/**
 * What Next - fact freshness (v2.5.0)
 *
 * Every fact carries where it came from (source) and when it was last checked
 * (last_verified_at). Facts that change in the real world - contacts, prices,
 * URLs, deploy targets, status - are "volatile" and go stale after a TTL. A
 * stale or disputed fact is still returned, with a marker, so an agent knows
 * to re-check it instead of acting on it as true.
 *
 * Pure functions only: callers pass the fact row and, in tests, `now`.
 */

export const VOLATILITY = ['stable', 'volatile'];
export const DEFAULT_TTL_DAYS = Math.max(1, parseInt(process.env.WHATNEXT_VOLATILE_TTL_DAYS ?? '', 10) || 30);
// How far ahead "due for re-check" looks, so a fact can be checked before it
// goes stale rather than after.
export const DUE_SOON_DAYS = 7;

const DAY_MS = 86_400_000;

// Categories whose content is a real-world value that changes.
const VOLATILE_CATEGORIES = /^(contact|contacts|client|clients|lead|leads|price|prices|pricing|quote|url|urls|link|links|domain|domains|deploy|deployment|hosting|infra|status|account|accounts|credential|env|endpoint|endpoints)$/i;
// Content that names a value which changes: a URL, an email, a phone number, a Rand or dollar amount.
const VOLATILE_CONTENT = [
  /\bhttps?:\/\/\S+/i,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,
  /(?:\+27|\b0)\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/,
  /\bR\s?\d[\d\s,]*(?:\.\d+)?\b/,
  /\$\s?\d[\d,]*(?:\.\d+)?\b/,
  /\b[\w-]+\.(?:netlify\.app|up\.railway\.app|supabase\.co|vercel\.app)\b/i,
];

export function inferVolatility(fact) {
  if (!fact) return 'stable';
  if (fact.volatility && VOLATILITY.includes(fact.volatility)) return fact.volatility;
  // A lesson is a fixed mistake; it does not expire because a URL is in it.
  if (/^lesson$/i.test(fact.category ?? '')) return 'stable';
  if (VOLATILE_CATEGORIES.test(String(fact.category ?? '').trim())) return 'volatile';
  const text = String(fact.content ?? '');
  return VOLATILE_CONTENT.some(re => re.test(text)) ? 'volatile' : 'stable';
}

// Stored timestamps come as "2026-09-21 13:41:56" (SQLite, UTC), ISO with Z,
// or Postgres text ("2026-09-21 13:41:56.123+00"). Returns ms or NaN.
export function toMs(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  let v = String(value).trim().replace(' ', 'T');
  v = v.replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(v)) v += 'Z';
  return Date.parse(v);
}

function day(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'never';
}

/**
 * state:
 *   'disputed'   - someone reported it wrong (send_feedback with fact_id)
 *   'stale'      - volatile and not checked within its TTL
 *   'fresh'      - volatile and checked within its TTL
 *   'stable'     - does not expire
 * checked_at is last_verified_at, or created_at for rows written before v2.5.0.
 */
export function freshnessOf(fact, now = Date.now()) {
  const volatility = inferVolatility(fact);
  const ttl = Number.isInteger(fact?.ttl_days) && fact.ttl_days > 0 ? fact.ttl_days : DEFAULT_TTL_DAYS;
  const verified = toMs(fact?.last_verified_at);
  const checked = Number.isFinite(verified) ? verified : toMs(fact?.created_at);
  const out = {
    state: 'stable',
    volatility,
    ttl_days: volatility === 'volatile' ? ttl : null,
    source: fact?.source ?? null,
    verified: Number.isFinite(verified),
    checked_at: Number.isFinite(checked) ? new Date(checked).toISOString() : null,
    due_at: null,
  };
  if (volatility === 'volatile') {
    const due = Number.isFinite(checked) ? checked + ttl * DAY_MS : now;
    out.due_at = new Date(due).toISOString();
    out.state = due <= now ? 'stale' : 'fresh';
  }
  if (fact?.disputed_at) out.state = 'disputed';
  return out;
}

export function isDueSoon(fact, now = Date.now(), withinDays = DUE_SOON_DAYS) {
  const f = freshnessOf(fact, now);
  if (f.volatility !== 'volatile') return false;
  return f.state === 'stale' || toMs(f.due_at) <= now + withinDays * DAY_MS;
}

/**
 * Text appended to a fact when it is shown to an agent. Empty for fresh and
 * stable facts, so their output reads exactly as before v2.5.0.
 */
export function freshnessMarker(fact, now = Date.now()) {
  const f = freshnessOf(fact, now);
  if (f.state === 'disputed') {
    const note = fact.dispute_note ? `: ${String(fact.dispute_note).replace(/\s+/g, ' ').slice(0, 120)}` : '';
    return ` [DISPUTED - reported wrong${note}. Check before use${fact.id != null ? `; review_fact id ${fact.id}` : ''}]`;
  }
  if (f.state === 'stale') {
    return ` [STALE - ${f.verified ? 'last checked' : 'not checked since'} ${day(toMs(f.checked_at))}, volatile (${f.ttl_days}d). Re-check before use${fact.id != null ? `; review_fact id ${fact.id}` : ''}]`;
  }
  return '';
}

export function normaliseVolatility(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  return VOLATILITY.includes(v) ? v : null;
}

export function normaliseTtl(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null;
}
