/**
 * Pure helpers from the multi-tenant cloud server. Importing the module does not
 * boot the server or touch Postgres (boot only runs when executed directly).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const {
  escapeHtml, normalizeEmail, cleanName, parseLimit, parseSince, clientIp, hashApiKey,
  webhookSecretFrom, safeEqual, checkRateLimit, pruneRateLimit, rateLimitMap, welcomeEmailHtml,
  SESSION_CAPS, sessionEmbText,
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

test('clientIp uses the right-most X-Forwarded-For entry', () => {
  const req = (xff, addr = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: addr } });
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3')), '3.3.3.3');
  assert.equal(clientIp(req('9.9.9.9')), '9.9.9.9');
  assert.equal(clientIp(req(undefined)), '10.0.0.1');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '' }, socket: {} }), 'unknown');
});

test('hashApiKey matches Postgres encode(sha256(convert_to(key)))', () => {
  const key = 'bak_' + 'ab'.repeat(32);
  assert.equal(hashApiKey(key), createHash('sha256').update(key).digest('hex'));
  assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
});

test('webhook secret: header preferred, query param still accepted', () => {
  const url = new URL('http://x/webhooks/beta-signup?secret=q');
  assert.equal(webhookSecretFrom({ headers: { 'x-webhook-secret': 'h' } }, url), 'h');
  assert.equal(webhookSecretFrom({ headers: {} }, url), 'q');
  assert.equal(webhookSecretFrom({ headers: {} }, new URL('http://x/')), null);
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

test('PATCH and insert share the same session caps', () => {
  assert.equal(SESSION_CAPS.stack, 1000);
  assert.equal(SESSION_CAPS.what_was_built, 8000);
  assert.equal(sessionEmbText({ summary: 's', decisions: null, tags: 't' }), 's t');
});

test('schema init never drops tables', () => {
  const src = readFileSync(new URL('../src/cloud-server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /DROP\s+TABLE/i);
  assert.doesNotMatch(src, /DROP\s+COLUMN/i);
});
