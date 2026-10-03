/**
 * Pure helpers from the multi-tenant cloud server. Importing the module does not
 * boot the server or touch Postgres (boot only runs when executed directly).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const {
  escapeHtml, normalizeEmail, cleanName, parseLimit, parseSince, clientIp, normalizeIp, hashApiKey,
  webhookSecretFrom, safeEqual, checkRateLimit, pruneRateLimit, rateLimitMap, welcomeEmailHtml,
  SESSION_CAPS, FACT_CAPS, sessionEmbText, parseSessionDate,
} = await import('../src/cloud-server.js');

test('escapeHtml escapes markup characters', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
});

test('welcome email escapes the name and caps it', () => {
  const html = welcomeEmailHtml({ name: '<script>alert(1)</script> Evil', apiKey: 'bak_abc' });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes("You're in, &lt;script&gt;alert(1)&lt;/script&gt;."));
  assert.ok(html.includes('bak_abc'));
  const fallback = welcomeEmailHtml({ name: null, apiKey: 'k' });
  assert.ok(fallback.includes("You're in, there."));
});

test('cleanName trims, strips control chars and caps at 80', () => {
  assert.equal(cleanName('  Ann\nLee  '), 'Ann Lee');
  assert.equal(cleanName('x'.repeat(200)).length, 80);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName(42), null);
});

test('normalizeEmail validates format and length', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail('a b@c.com'), null);
  assert.equal(normalizeEmail('<x>@c.com'), null);
  assert.equal(normalizeEmail(['a@b.com']), null);
  assert.equal(normalizeEmail(`${'a'.repeat(250)}@b.com`), null);
});

test('parseLimit clamps and falls back on junk', () => {
  assert.equal(parseLimit(null, 10, 50), 10);
  assert.equal(parseLimit('abc', 10, 50), 10);
  assert.equal(parseLimit('-5', 10, 50), 10);
  assert.equal(parseLimit('0', 10, 50), 10);
  assert.equal(parseLimit('7', 10, 50), 7);
  assert.equal(parseLimit('9999', 10, 50), 50);
});

test('parseSince defaults, accepts ISO, rejects junk', () => {
  assert.equal(parseSince(null), new Date(0).toISOString());
  assert.equal(parseSince(''), new Date(0).toISOString());
  assert.equal(parseSince('2026-09-01T10:00:00.000Z'), '2026-09-01T10:00:00.000Z');
  assert.equal(parseSince('yesterday-ish'), null);
  assert.equal(parseSince('2026-01-01' + 'x'.repeat(100)), null);
});

test('clientIp prefers X-Real-IP, then the left-most X-Forwarded-For entry, then the socket', () => {
  const req = (headers, addr = '10.0.0.1') => ({ headers, socket: { remoteAddress: addr } });
  assert.equal(clientIp(req({ 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })), '5.5.5.5');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })), '1.1.1.1');
  assert.equal(clientIp(req({ 'x-forwarded-for': '9.9.9.9' })), '9.9.9.9');
  assert.equal(clientIp(req({ 'x-real-ip': '  ', 'x-forwarded-for': ' 7.7.7.7 ,8.8.8.8' })), '7.7.7.7');
  assert.equal(clientIp(req({})), '10.0.0.1');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '' }, socket: {} }), 'unknown');
});

test('clientIp: rotating proxy hops on the right do not split one client across counters', () => {
  rateLimitMap.clear();
  const hops = ['100.64.0.2', '100.64.0.3', '100.64.0.4'];
  let last;
  for (let i = 0; i < 61; i++) {
    const ip = clientIp({ headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': `203.0.113.9, ${hops[i % 3]}` }, socket: {} });
    last = checkRateLimit(ip);
  }
  assert.equal(last.allowed, false);
  rateLimitMap.clear();
});

test('IPv4-mapped IPv6 addresses are normalised', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIp('::FFFF:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(clientIp({ headers: { 'x-real-ip': '::ffff:1.2.3.4' }, socket: {} }), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), '127.0.0.1');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '::ffff:4.4.4.4, 5.5.5.5' }, socket: {} }), '4.4.4.4');
});

test('parseSessionDate keeps sane client dates, rejects junk, the future and pre-2020', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.equal(parseSessionDate('2026-09-27T10:00:00.000Z', now), '2026-09-27T10:00:00.000Z');
  assert.equal(parseSessionDate('2026-09-27 10:00:00', now), '2026-09-27T10:00:00.000Z', 'no zone means UTC');
  assert.equal(parseSessionDate('2026-10-04T06:00:00Z', now), '2026-10-04T06:00:00.000Z', 'under a day ahead is clock skew');
  assert.equal(parseSessionDate('2026-10-05T12:00:00Z', now), null);
  assert.equal(parseSessionDate('2019-12-31T23:59:59Z', now), null);
  assert.equal(parseSessionDate('not a date', now), null);
  assert.equal(parseSessionDate(1727430000000, now), null);
  assert.equal(parseSessionDate('', now), null);
  assert.equal(parseSessionDate(undefined, now), null);
  assert.equal(parseSessionDate('2026-01-01' + 'x'.repeat(100), now), null);
});

test('hashApiKey matches Postgres encode(sha256(convert_to(key)))', () => {
  const key = 'bak_' + 'ab'.repeat(32);
  assert.equal(hashApiKey(key), createHash('sha256').update(key).digest('hex'));
  assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
});

test('webhook secret: header only, the query string is never read', () => {
  const url = new URL('http://x/webhooks/beta-signup?secret=q');
  assert.equal(webhookSecretFrom({ headers: { 'x-webhook-secret': 'h' } }, url), 'h');
  assert.equal(webhookSecretFrom({ headers: {} }, url), null);
  assert.equal(webhookSecretFrom({ headers: {} }), null);
  assert.equal(safeEqual('s3cret', 's3cret'), true);
  assert.equal(safeEqual('s3cret', 's3creT'), false);
  assert.equal(safeEqual('s3cret', null), false);
  assert.equal(safeEqual(undefined, undefined), false);
});

test('rate limit blocks after 60 and prunes stale entries', () => {
  rateLimitMap.clear();
  for (let i = 0; i < 60; i++) assert.equal(checkRateLimit('t').allowed, true);
  assert.equal(checkRateLimit('t').allowed, false);
  pruneRateLimit(Date.now());
  assert.equal(rateLimitMap.has('t'), true);
  pruneRateLimit(Date.now() + 10 * 60_000);
  assert.equal(rateLimitMap.size, 0);
});

test('PATCH and insert share the same session caps, and the client trims to the same caps', async () => {
  const client = await import('../src/cloud-client.js');
  for (const [f, n] of Object.entries(SESSION_CAPS)) assert.equal(client.SESSION_CAPS[f], n, f);
  for (const [f, n] of Object.entries(FACT_CAPS)) assert.equal(client.FACT_CAPS[f], n, f);
  assert.equal(SESSION_CAPS.stack, 1000);
  assert.equal(SESSION_CAPS.what_was_built, 8000);
  assert.equal(sessionEmbText({ summary: 's', decisions: null, tags: 't' }), 's t');
});

test('schema init never drops tables', () => {
  const src = readFileSync(new URL('../src/cloud-server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /DROP\s+TABLE/i);
  assert.doesNotMatch(src, /DROP\s+COLUMN/i);
});

test('every response carries HSTS, and admin 500s do not leak err.message', () => {
  const src = readFileSync(new URL('../src/cloud-server.js', import.meta.url), 'utf8');
  assert.match(src, /setHeader\('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'\)/);
  assert.doesNotMatch(src, /send\(res, 500, \{ error: err\.message \}\)/);
  assert.doesNotMatch(src, /searchParams\.get\('secret'\)/);
});
