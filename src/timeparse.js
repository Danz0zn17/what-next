/**
 * What Next - time phrase parser for search
 *
 * Pulls a date range out of a natural query ("what did we decide about auth
 * last week", "surf-rides in August") so search can restrict by time first
 * and match text second. Returns null when the query has no time phrase.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const UNIT_MS = { day: 86_400_000, week: 7 * 86_400_000 };

const iso = d => d.toISOString();
const startOfDay = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d, n) => new Date(d.getTime() + n * UNIT_MS.day);
const monthStart = (y, m) => new Date(Date.UTC(y, m, 1));
const monthIndex = s => MONTHS.findIndex(m => m.startsWith(s.slice(0, 3).toLowerCase()));

// Each pattern: regex, then a function (match, now) -> [start, end) as Dates.
const PATTERNS = [
  // "since <date>" must win over the bare ISO-date pattern below
  [/\bsince\s+(\d{4}-\d{2}-\d{2})\b/i, (m, now) => [new Date(m[1] + 'T00:00:00Z'), addDays(startOfDay(now), 1)]],
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return [d, addDays(d, 1)];
  }],
  [/\b(\d{4})-(\d{2})\b/, (m) => [monthStart(+m[1], +m[2] - 1), monthStart(+m[1], +m[2])]],
  [/\b(?:in\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{4})\b/i, (m) => {
    const mi = monthIndex(m[1]);
    return [monthStart(+m[2], mi), monthStart(+m[2], mi + 1)];
  }],
  [/\b(?:in|during|from)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i, (m, now) => {
    const mi = monthIndex(m[1]);
    let y = now.getUTCFullYear();
    if (mi > now.getUTCMonth()) y -= 1; // most recent occurrence, never the future
    return [monthStart(y, mi), monthStart(y, mi + 1)];
  }],
  [/\btoday\b/i, (m, now) => [startOfDay(now), addDays(startOfDay(now), 1)]],
  [/\byesterday\b/i, (m, now) => [addDays(startOfDay(now), -1), startOfDay(now)]],
  [/\b(?:this|the past|past)\s+week\b/i, (m, now) => [addDays(startOfDay(now), -7), addDays(startOfDay(now), 1)]],
  [/\blast\s+week\b/i, (m, now) => {
    const dow = now.getUTCDay();
    const thisMonday = addDays(startOfDay(now), -((dow + 6) % 7));
    return [addDays(thisMonday, -7), thisMonday];
  }],
  [/\b(?:this|the past|past)\s+month\b/i, (m, now) => [addDays(startOfDay(now), -30), addDays(startOfDay(now), 1)]],
  [/\blast\s+month\b/i, (m, now) => [
    monthStart(now.getUTCFullYear(), now.getUTCMonth() - 1),
    monthStart(now.getUTCFullYear(), now.getUTCMonth()),
  ]],
  [/\blast\s+(\d+)\s+(day|week)s?\b/i, (m, now) => [
    new Date(now.getTime() - +m[1] * UNIT_MS[m[2].toLowerCase()]), addDays(startOfDay(now), 1),
  ]],
  [/\b(\d+)\s+(day|week)s?\s+ago\b/i, (m, now) => {
    const d = startOfDay(new Date(now.getTime() - +m[1] * UNIT_MS[m[2].toLowerCase()]));
    return [d, addDays(d, 1)];
  }],
  [/\blast\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i, (m, now) => {
    const want = DAYS.findIndex(d => d.startsWith(m[1].toLowerCase()));
    let back = (now.getUTCDay() - want + 7) % 7;
    if (back === 0) back = 7;
    const d = addDays(startOfDay(now), -back);
    return [d, addDays(d, 1)];
  }],
];

/**
 * @returns {{ since: string, until: string, text: string, label: string } | null}
 *   since/until are ISO strings, [since, until). text is the query with the
 *   time phrase removed. label is a short human form of the range.
 */
export function parseTimeRange(query, now = new Date()) {
  for (const [re, toRange] of PATTERNS) {
    const m = query.match(re);
    if (!m) continue;
    const [start, end] = toRange(m, now);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const text = query.replace(re, ' ').replace(/\s+/g, ' ').trim();
    const label = `${iso(start).slice(0, 10)} to ${iso(addDays(end, -1)).slice(0, 10)}`;
    return { since: iso(start), until: iso(end), text, label };
  }
  return null;
}
