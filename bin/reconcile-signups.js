#!/usr/bin/env node
/**
 * reconcile-signups.js - safety net for the beta signup pipeline.
 *
 * Netlify fires `submission-created` at most once per form submission. If that
 * event never fires (spam classification at ingest) or the call to Railway
 * fails, the signup is lost silently - no user row, no API key, no email.
 * This script diffs verified Netlify form submissions against the users table
 * and issues keys for anyone missing.
 *
 * Spam-flagged submissions are reported separately and never auto-issued - that
 * bucket is mostly real spam, but it is also where a false-positive signup lands.
 * Review it, then pass --include-spam to issue those too.
 *
 * Dry run by default. Pass --apply to actually create users and send emails.
 *
 * Env:
 *   NETLIFY_TOKEN       - Netlify personal access token
 *   NETLIFY_FORM_ID     - beta-signup form id (defaults to the production form)
 *   DATABASE_URL        - Postgres connection string (public proxy URL when run locally)
 *   WHATNEXT_CLOUD_URL  - Railway base URL
 *   ADMIN_KEY           - secret for POST /admin/users
 */

import pg from 'pg';

const APPLY        = process.argv.includes('--apply');
const INCLUDE_SPAM = process.argv.includes('--include-spam');
const FORM_ID      = process.env.NETLIFY_FORM_ID ?? '69d6c3dd8cd5840008cf34da';
const TOKEN        = process.env.NETLIFY_TOKEN;
const DB_URL       = process.env.DATABASE_URL;
const CLOUD_URL    = process.env.WHATNEXT_CLOUD_URL ?? 'https://what-next-production.up.railway.app';
const ADMIN_KEY    = process.env.ADMIN_KEY;

const missing = ['NETLIFY_TOKEN', 'DATABASE_URL', 'ADMIN_KEY'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(1);
}

const VALID_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function fetchSubmissions(state) {
  const res = await fetch(
    `https://api.netlify.com/api/v1/forms/${FORM_ID}/submissions?state=${state}&per_page=100`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Netlify API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function issueKey({ name, email }) {
  const res = await fetch(`${CLOUD_URL}/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ name, email, send_email: true }),
  });
  return { status: res.status, body: await res.text() };
}

function toCandidates(submissions) {
  const out = new Map();
  for (const s of submissions) {
    const email = (s.data?.email ?? '').toLowerCase().trim();
    if (!VALID_EMAIL.test(email)) continue;
    if (!out.has(email)) {
      out.set(email, { email, name: s.data?.name || email.split('@')[0], created_at: s.created_at });
    }
  }
  return out;
}

const verified = toCandidates(await fetchSubmissions('verified'));
const spam     = toCandidates(await fetchSubmissions('spam'));
for (const email of verified.keys()) spam.delete(email);

const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const { rows } = await pool.query('SELECT LOWER(email) AS email FROM users');
await pool.end();
const known = new Set(rows.map(r => r.email));

const gaps     = [...verified.values()].filter(c => !known.has(c.email));
const spamGaps = [...spam.values()].filter(c => !known.has(c.email));

const line = (c) => `  ${c.created_at.slice(0, 19)}  ${c.email}  (${c.name})`;

console.log(`Verified submissions with an email: ${verified.size}`);
console.log(`Already have a key:                 ${verified.size - gaps.length}`);
console.log(`Missing a key:                      ${gaps.length}`);

if (gaps.length) {
  console.log('');
  for (const g of gaps) console.log(line(g));
}

if (spamGaps.length) {
  console.log(`\nSpam-flagged, no key (review before issuing - ${spamGaps.length}):`);
  for (const g of spamGaps) console.log(line(g));
  if (!INCLUDE_SPAM) console.log('  Pass --include-spam to issue these too.');
}

const targets = INCLUDE_SPAM ? [...gaps, ...spamGaps] : gaps;

if (!targets.length) {
  console.log('\nNothing to reconcile.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to issue keys and send welcome emails.');
  process.exit(0);
}

console.log('');
let issued = 0, failed = 0;
for (const t of targets) {
  const { status, body } = await issueKey(t);
  if (status === 201) { console.log(`  issued   ${t.email}`); issued++; }
  else if (status === 409) { console.log(`  exists   ${t.email}`); }
  else { console.error(`  FAILED   ${t.email} - ${status} ${body}`); failed++; }
}

console.log(`\nIssued ${issued}, failed ${failed}.`);
process.exit(failed ? 1 : 0);
