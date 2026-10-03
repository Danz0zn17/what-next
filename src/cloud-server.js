/**
 * What Next — Multi-tenant Cloud Server
 *
 * Runs on Railway. Each user is isolated by their API key.
 * Local api.js / api-server.js are untouched — they remain single-user local only.
 *
 * Required env vars:
 *   DATABASE_URL        — Railway Postgres connection string
 *   ADMIN_KEY           — Secret for /admin/users endpoint (generate a long random string)
 *   WEBHOOK_SECRET      - Shared secret the Netlify function sends in the X-Webhook-Secret header
 *   RESEND_API_KEY      — Resend.com API key for sending welcome emails
 *   RESEND_FROM         — e.g. "What Next <noreply@whatnextai.co.za>"
 *
 * Optional:
 *   PORT                — defaults to 3001 (Railway sets this automatically)
 *   TELEGRAM_ALERT_URL  — Telegram sendMessage URL for error alerts
 *
 * Public endpoints:
 *   GET  /health                        — liveness check
 *   POST /webhooks/beta-signup          — Netlify form webhook (WEBHOOK_SECRET)
 *
 * Admin endpoints (X-Admin-Key required):
 *   POST /admin/users                   — create user + issue API key
 *   POST /admin/users/resend-welcome    - re-send an unsent welcome email (with a new key) to the stored address
 *
 * Authenticated endpoints (X-API-Key required):
 *   GET  /user                          — current user profile + stats
 *   GET  /stats                         — session/fact/project counts
 *   POST /session                       — dump a session
 *   DELETE /session/:id                 — delete own session
 *   POST /fact                          — store a fact
 *   GET  /search?q=...&limit=N          — full-text search
 *   GET  /semantic-search?q=...&limit=N  — vector similarity search
 *   POST /reindex                       — backfill embeddings for all own sessions+facts
 *   GET  /context                       — session-start brief
 *   GET  /projects                      — list projects
 *   GET  /project/:name                 — get project + sessions
 *   GET  /export?since=ISO_DATE         — bulk pull for local↔cloud sync
 *   PATCH /session/:id                  — edit an existing session
 *   GET  /whats-next                    — open next_steps per project
 *   POST /feedback                      — send feedback
 *   POST /intelligence                  - upsert project intelligence card
 *   GET  /intelligence/:name            - fetch project intelligence card
 */

import { createServer } from 'http';
import { randomBytes, timingSafeEqual, createHash } from 'crypto';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;
import { pipeline } from '@huggingface/transformers';

// ─── Embeddings (lazy-loaded, cached after first use) ─────────────────────────
let _embedder = null;
async function getEmbedder() {
  if (!_embedder) {
    _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: 'cpu' });
  }
  return _embedder;
}
async function generateEmbedding(text) {
  const model = await getEmbedder();
  const out = await model(text.slice(0, 2000), { pooling: 'mean', normalize: true });
  return Array.from(out.data); // 384-dim float array
}

const PORT = process.env.PORT ?? 3001;
const ADMIN_KEY = process.env.ADMIN_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM ?? 'What Next <noreply@whatnextai.co.za>';
const TELEGRAM_ALERT_URL = process.env.TELEGRAM_ALERT_URL; // optional: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Simple in-memory sliding window: 60 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) ?? { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_WINDOW_MS;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return { allowed: entry.count <= RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - entry.count), reset: entry.reset };
}
function pruneRateLimit(now = Date.now()) {
  for (const [ip, entry] of rateLimitMap) if (now > entry.reset + 60_000) rateLimitMap.delete(ip);
}
// Prune stale entries every 5 minutes
setInterval(() => pruneRateLimit(), 5 * 60_000).unref();

// Client address for rate limiting. This trusts Railway's edge: it sets
// X-Real-IP to the connecting client and puts that same address first in
// X-Forwarded-For. The right-most X-Forwarded-For entry is one of several
// internal proxy hops and rotates between requests, so it must not be used.
// Only correct while the service sits behind Railway's edge.
function normalizeIp(ip) {
  const v = typeof ip === 'string' ? ip.trim() : '';
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped ? mapped[1] : v;
}

function clientIp(req) {
  const real = normalizeIp(req.headers['x-real-ip']);
  if (real) return real;
  const xff = req.headers['x-forwarded-for'];
  const first = typeof xff === 'string' ? normalizeIp(xff.split(',')[0]) : '';
  return first || normalizeIp(req.socket?.remoteAddress) || 'unknown';
}

// ─── Structured logging ───────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  process.stderr.write(line + '\n');
}

// ─── Self-healing: error tracking + Telegram alert ────────────────────────────
let recentErrors = [];
const ERROR_THRESHOLD = 5; // alert after this many errors in 5 minutes
const ERROR_WINDOW_MS = 5 * 60_000;

function trackError(msg) {
  const now = Date.now();
  recentErrors.push(now);
  recentErrors = recentErrors.filter(t => now - t < ERROR_WINDOW_MS);
  if (recentErrors.length === ERROR_THRESHOLD) {
    sendTelegramAlert(`[What Next Cloud] ${ERROR_THRESHOLD} errors in 5 min. Latest: ${msg}`);
  }
}

function sendTelegramAlert(text) {
  if (!TELEGRAM_ALERT_URL) return;
  const url = `${TELEGRAM_ALERT_URL}${encodeURIComponent(text)}`;
  fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
}

// ─── FTS query sanitiser ──────────────────────────────────────────────────────
// Postgres to_tsquery crashes on special characters like : ( ) & | ! @
// Sanitise the query before passing it to avoid 500s on user input.
function safeTsQuery(q) {
  // Strip anything that isn't alphanumeric, whitespace, or hyphen
  const cleaned = q.replace(/[^a-zA-Z0-9\s\-]/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // Join as AND query (all words must appear)
  return words.map(w => w + ':*').join(' & ');
}

// ─── Schema ───────────────────────────────────────────────────────────────────

async function initSchema() {
  // Every core table that already exists must carry user_id. A table without it
  // is a legacy single-tenant schema: refuse to start rather than touch the data.
  const { rows: legacy } = await pool.query(`
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'public'
      AND t.table_name IN ('projects', 'sessions', 'facts')
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'user_id'
      )
  `);
  if (legacy.length) {
    const tables = legacy.map(r => r.table_name).join(', ');
    log('fatal', 'Unexpected schema: tables missing user_id. Refusing to start; migrate manually.', { tables });
    sendTelegramAlert(`[What Next Cloud] Refusing to start: tables missing user_id (${tables})`);
    throw new Error(`Schema check failed: ${tables} missing user_id`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      api_key    TEXT UNIQUE,
      email      TEXT NOT NULL UNIQUE,
      name       TEXT,
      plan       TEXT NOT NULL DEFAULT 'beta',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, name)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      summary        TEXT NOT NULL,
      what_was_built TEXT,
      decisions      TEXT,
      stack          TEXT,
      next_steps     TEXT,
      tags           TEXT,
      session_date   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      category   TEXT NOT NULL,
      content    TEXT NOT NULL,
      tags       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_facts_user    ON facts(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT NOT NULL DEFAULT 'general',
      message    TEXT NOT NULL,
      context    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id)');

  // pgvector for semantic search
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rowtype    TEXT NOT NULL,
      row_id     INTEGER NOT NULL,
      embedding  vector(384) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, rowtype, row_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_embeddings_user ON embeddings(user_id)');
  // IVFFlat index for fast ANN — only worth creating when enough rows exist
  await pool.query(`
    DO $$ BEGIN
      IF (SELECT COUNT(*) FROM embeddings) >= 100 THEN
        CREATE INDEX IF NOT EXISTS idx_embeddings_ivfflat
          ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
      END IF;
    END $$;
  `).catch(() => {}); // silently skip if pgvector version doesn't support it yet

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_intelligence (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repo_path   TEXT,
      stack       TEXT,
      key_dirs    TEXT,
      conventions TEXT,
      env_vars    TEXT,
      deployment  TEXT,
      extra       TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, project_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_intel_user ON project_intelligence(user_id)');

  // API keys are looked up by sha256 hash and never stored in plaintext: a key
  // is shown once, in the welcome email. Rows from before this keep working
  // through their hash; the plaintext is cleared only where the hash matches it.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hash TEXT');
  await pool.query(`UPDATE users SET api_key_hash = encode(sha256(convert_to(api_key, 'UTF8')), 'hex') WHERE api_key_hash IS NULL AND api_key IS NOT NULL`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash)');
  await pool.query('ALTER TABLE users ALTER COLUMN api_key DROP NOT NULL');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_used_at TIMESTAMPTZ');
  const cleared = await pool.query(`
    UPDATE users SET api_key = NULL
    WHERE api_key IS NOT NULL AND api_key_hash = encode(sha256(convert_to(api_key, 'UTF8')), 'hex')
  `);
  if (cleared.rowCount) log('info', 'Cleared plaintext API keys (hash kept)', { users: cleared.rowCount });

  // Edits and deletes reach other machines through /export. Existing rows keep
  // updated_at NULL (never edited), so the upgrade does not re-export them all.
  await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE sessions ALTER COLUMN updated_at SET DEFAULT NOW()');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_tombstones (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tombstones_user_deleted ON session_tombstones(user_id, deleted_at)');

  // welcome_sent_at: when the column is first added, mark every existing user as
  // already welcomed so nobody is mass emailed. Later NULLs mean a real send failure.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: hasWelcome } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'welcome_sent_at'
    `);
    if (!hasWelcome.length) {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_sent_at TIMESTAMPTZ');
      await client.query('UPDATE users SET welcome_sent_at = created_at WHERE welcome_sent_at IS NULL');
      log('info', 'Added users.welcome_sent_at and backfilled existing users');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  log('info', 'Schema ready');
}

async function storeEmbedding(userId, rowtype, rowId, text) {
  try {
    const vec = await generateEmbedding(text);
    await pool.query(`
      INSERT INTO embeddings (user_id, rowtype, row_id, embedding)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, rowtype, row_id) DO UPDATE SET embedding = $4
    `, [userId, rowtype, rowId, JSON.stringify(vec)]);
  } catch (err) {
    log('warn', 'Embedding generation failed', { err: err.message });
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function makeApiKey() {
  return 'bak_' + randomBytes(32).toString('hex');
}

// Constant-time string comparison — prevents timing attacks on secrets
function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hashApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey), 'utf8').digest('hex');
}

// Every key has a hash: initSchema backfills api_key_hash before the server
// listens and createUser always writes it, so there is no plaintext fallback.
async function resolveUser(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE api_key_hash = $1', [hashApiKey(apiKey)]);
  const user = rows[0] ?? null;
  // Remember that this key has been used, so a welcome re-send never replaces it
  if (user && !user.first_used_at) {
    pool.query('UPDATE users SET first_used_at = NOW() WHERE id = $1 AND first_used_at IS NULL', [user.id]).catch(() => {});
  }
  return user;
}

// Input validation

const MAX_EMAIL_LEN = 254;
const MAX_NAME_LEN = 80;
const EMAIL_RE = /^[^@\s<>"'`,;:()\[\]\\]+@[^@\s<>"'`,;:()\[\]\\]+\.[^@\s<>"'`,;:()\[\]\\]+$/;

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  if (!e || e.length > MAX_EMAIL_LEN || !EMAIL_RE.test(e)) return null;
  return e;
}

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME_LEN).trim();
  return n || null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Clamp a ?limit= value; anything non-numeric or below 1 falls back to the default.
function parseLimit(raw, def, max) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

// Returns the since value to pass to Postgres, or null when it is not a valid date.
function parseSince(raw) {
  if (raw == null || raw === '') return new Date(0).toISOString();
  if (raw.length > 64 || Number.isNaN(Date.parse(raw))) return null;
  return raw;
}

// The webhook secret is only read from the X-Webhook-Secret header. A query
// string secret ends up in proxy and access logs, so it is never accepted.
function webhookSecretFrom(req) {
  return req.headers['x-webhook-secret'] ?? null;
}

// Optional client session_date: kept when it is a real date between 2020 and
// one day from now, otherwise the server stamps NOW(). A date with no zone is UTC.
const MIN_SESSION_DATE = Date.parse('2020-01-01T00:00:00Z');
function parseSessionDate(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw || raw.length > 64) return null;
  let v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v = v.replace(' ', 'T') + 'Z';
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < MIN_SESSION_DATE || t > now + 86_400_000) return null;
  return new Date(t).toISOString();
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function upsertProject(userId, name, description = null) {
  const { rows } = await pool.query(`
    INSERT INTO projects (user_id, name, description)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, name) DO UPDATE
      SET updated_at = NOW(),
          description = COALESCE($3, projects.description)
    RETURNING id
  `, [userId, name, description]);
  return rows[0].id;
}

// Field length caps — prevents runaway storage abuse
const cap = (s, n) => (s == null ? null : String(s).slice(0, n));

const SESSION_CAPS = { summary: 4000, what_was_built: 8000, decisions: 4000, stack: 1000, next_steps: 4000, tags: 500 };
const FACT_CAPS = { category: 200, content: 4000, tags: 500 };
const sessionEmbText = (s) => [s.summary, s.what_was_built, s.decisions, s.next_steps, s.tags].filter(Boolean).join(' ');

async function addSession(userId, { project, summary, what_was_built, decisions, stack, next_steps, tags, session_date }) {
  const projectId = await upsertProject(userId, cap(project, 100));
  const C = SESSION_CAPS;
  const { rows } = await pool.query(`
    INSERT INTO sessions (user_id, project_id, summary, what_was_built, decisions, stack, next_steps, tags, session_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::TIMESTAMPTZ, NOW()))
    RETURNING id
  `, [userId, projectId, cap(summary, C.summary), cap(what_was_built, C.what_was_built), cap(decisions, C.decisions), cap(stack, C.stack), cap(next_steps, C.next_steps), cap(tags, C.tags), parseSessionDate(session_date)]);
  const id = rows[0].id;
  storeEmbedding(userId, 'session', id, sessionEmbText({ summary, what_was_built, decisions, next_steps, tags })); // fire and forget
  return id;
}

async function addFact(userId, { category, content, project, tags }) {
  let projectId = null; // resolved below
  if (project) projectId = await upsertProject(userId, cap(project, 100));
  const { rows } = await pool.query(`
    INSERT INTO facts (user_id, project_id, category, content, tags)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [userId, projectId, cap(category, FACT_CAPS.category), cap(content, FACT_CAPS.content), cap(tags, FACT_CAPS.tags)]);
  const id = rows[0].id;
  storeEmbedding(userId, 'fact', id, [category, content, tags].filter(Boolean).join(' ')); // fire and forget
  return id;
}

async function searchMemories(userId, q, limit = 10) {
  const term = safeTsQuery(q);
  if (!term) return { sessions: [], facts: [] };

  const { rows: sessions } = await pool.query(`
    SELECT s.id, p.name AS project_name, s.summary, s.what_was_built,
           s.decisions, s.stack, s.next_steps, s.tags,
           s.session_date::TEXT AS session_date
    FROM sessions s
    JOIN projects p ON p.id = s.project_id
    WHERE s.user_id = $1
      AND to_tsvector('english', COALESCE(s.summary,'') || ' ' || COALESCE(s.what_was_built,'') || ' ' ||
                                 COALESCE(s.decisions,'') || ' ' || COALESCE(s.stack,'') || ' ' ||
                                 COALESCE(s.tags,''))
          @@ to_tsquery('english', $2)
    ORDER BY s.session_date DESC
    LIMIT $3
  `, [userId, term, limit]).catch(() => ({ rows: [] }));

  const { rows: facts } = await pool.query(`
    SELECT f.id, f.category, f.content, f.tags, f.created_at::TEXT AS created_at
    FROM facts f
    WHERE f.user_id = $1
      AND to_tsvector('english', COALESCE(f.category,'') || ' ' || COALESCE(f.content,'') || ' ' || COALESCE(f.tags,''))
          @@ to_tsquery('english', $2)
    ORDER BY f.created_at DESC
    LIMIT $3
  `, [userId, term, limit]).catch(() => ({ rows: [] }));

  return { sessions, facts };
}

async function listProjects(userId) {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.description, p.created_at::TEXT,
           COUNT(s.id)::INT AS session_count,
           MAX(s.session_date)::TEXT AS last_session
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id
    WHERE p.user_id = $1
    GROUP BY p.id
    ORDER BY last_session DESC NULLS LAST
  `, [userId]);
  return rows;
}

async function getProject(userId, name) {
  const { rows: [project] } = await pool.query(
    'SELECT * FROM projects WHERE user_id = $1 AND name = $2', [userId, name]
  );
  if (!project) return null;
  const { rows: sessions } = await pool.query(
    'SELECT * FROM sessions WHERE project_id = $1 ORDER BY session_date DESC', [project.id]
  );
  return { ...project, sessions };
}

// ─── User management ──────────────────────────────────────────────────────────

// The plaintext key is returned to the caller once (for the welcome email or the
// admin response) and only its hash is stored.
async function createUser({ email, name, plan = 'beta' }) {
  const apiKey = makeApiKey();
  const { rows } = await pool.query(`
    INSERT INTO users (api_key_hash, email, name, plan)
    VALUES ($1, $2, $3, $4)
    RETURNING id, email, name, plan, created_at
  `, [hashApiKey(apiKey), email.toLowerCase().trim(), name ?? null, plan]);
  return { ...rows[0], api_key: apiKey };
}

// True once a user's key has been used: first_used_at is set by resolveUser, and
// accounts from before that column existed count as used if they hold any data.
async function keyInUse(userId) {
  const { rows: [r] } = await pool.query(`
    SELECT (first_used_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM sessions WHERE user_id = $1)
        OR EXISTS (SELECT 1 FROM facts WHERE user_id = $1)
        OR EXISTS (SELECT 1 FROM projects WHERE user_id = $1) AS used
    FROM users WHERE id = $1
  `, [userId]);
  return !!r?.used;
}

// A welcome that never arrived means the user never had their key, so a re-send
// issues a fresh one. Refuses (null) when the current key is already in use.
async function reissueKeyForWelcome(user) {
  if (await keyInUse(user.id)) return null;
  const apiKey = makeApiKey();
  await pool.query('UPDATE users SET api_key_hash = $1, api_key = NULL WHERE id = $2', [hashApiKey(apiKey), user.id]);
  return { ...user, api_key: apiKey };
}

// ─── Email ────────────────────────────────────────────────────────────────────

// Returns true only when Resend accepted the email.
async function sendWelcomeEmail({ name, email, apiKey }) {
  if (!RESEND_API_KEY) {
    log('warn', 'RESEND_API_KEY not set — skipping email', { email });
    return false;
  }

  const html = welcomeEmailHtml({ name, apiKey });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: "You're in — What Next beta access",
        html,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const err = await res.text();
      log('error', 'Resend email failed', { email, err });
      return false;
    }
    log('info', 'Welcome email sent', { email });
    return true;
  } catch (err) {
    log('error', 'Resend email failed', { email, err: err.message });
    return false;
  }
}

// Sends the welcome email to the user's stored address and records success.
async function deliverWelcome(user) {
  const ok = await sendWelcomeEmail({ name: user.name, email: user.email, apiKey: user.api_key });
  if (ok) {
    await pool.query('UPDATE users SET welcome_sent_at = NOW() WHERE id = $1', [user.id]);
  } else {
    trackError(`Welcome email failed for user ${user.id}`);
    sendTelegramAlert(`[What Next Cloud] Welcome email failed for ${user.email}`);
  }
  return ok;
}

function welcomeEmailHtml({ name, apiKey }) {
  const clean = cleanName(name);
  const firstName = escapeHtml(clean ? clean.split(' ')[0] : 'there');
  apiKey = escapeHtml(apiKey);

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#060606;color:#f0f0f0;padding:40px 20px;max-width:560px;margin:0 auto">
  <p style="font-size:13px;color:#555;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:32px">What Next · Private Beta</p>
  <h1 style="font-size:28px;font-weight:400;letter-spacing:-0.03em;margin-bottom:16px">You're in, ${firstName}.</h1>
  <p style="color:#888;line-height:1.75;margin-bottom:28px">Here's your API key. Keep it safe — it's how all your AI surfaces will authenticate with the What Next cloud.</p>
  <div style="background:#0c0c0c;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:20px 24px;margin-bottom:32px;font-family:'JetBrains Mono',monospace;font-size:14px;word-break:break-all">
    ${apiKey}
  </div>
  <h2 style="font-size:16px;font-weight:500;margin-bottom:16px">Setup (2 minutes)</h2>
  <p style="color:#888;line-height:1.75;margin-bottom:12px"><strong style="color:#f0f0f0">1. Clone the repo</strong></p>
  <div style="background:#0c0c0c;border:1px solid rgba(255,255,255,0.07);border-radius:6px;padding:14px 18px;font-family:monospace;font-size:13px;margin-bottom:16px;color:#888">
    git clone https://github.com/Danz0zn17/what-next.git ~/what-next<br>
    cd ~/what-next && npm install
  </div>
  <p style="color:#888;line-height:1.75;margin-bottom:12px">Full setup guide and tool reference: <a href="https://whatnextai.co.za" style="color:#f0f0f0">whatnextai.co.za</a></p>
  <p style="color:#888;line-height:1.75;margin-bottom:12px"><strong style="color:#f0f0f0">2. Add to Claude Desktop</strong> — edit <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">~/Library/Application Support/Claude/claude_desktop_config.json</code></p>
  <div style="background:#0c0c0c;border:1px solid rgba(255,255,255,0.07);border-radius:6px;padding:14px 18px;font-family:monospace;font-size:12px;margin-bottom:16px;color:#888;line-height:1.9">
    "mcpServers": {<br>
    &nbsp;&nbsp;"what-next": {<br>
    &nbsp;&nbsp;&nbsp;&nbsp;"command": "node",<br>
    &nbsp;&nbsp;&nbsp;&nbsp;"args": ["~/what-next/bin/bootstrap-entry.js", "src/server.js", "mcp"],<br>
    &nbsp;&nbsp;&nbsp;&nbsp;"env": {<br>
    &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"WHATNEXT_CLOUD_URL": "https://what-next-production.up.railway.app",<br>
    &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"WHATNEXT_API_KEY": "${apiKey}"<br>
    &nbsp;&nbsp;&nbsp;&nbsp;}<br>
    &nbsp;&nbsp;}<br>
    }
  </div>
  <p style="color:#888;line-height:1.75;margin-bottom:12px"><strong style="color:#f0f0f0">3. Add to VS Code / GitHub Copilot</strong> — same config in <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">~/Library/Application Support/Code/User/mcp.json</code> using <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">"servers"</code> instead of <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">"mcpServers"</code></p>
  <p style="color:#888;line-height:1.75;margin-bottom:32px"><strong style="color:#f0f0f0">4. Restart Claude / VS Code</strong> — What Next will appear as an available tool.</p>
  <p style="color:#888;line-height:1.75;margin-bottom:12px"><strong style="color:#f0f0f0">Bonus: Telegram</strong> — If you use Hermes as your AI bot on Telegram, What Next works there too. Your memory follows you to your phone — same context, same tools, everywhere.</p>
  <p style="color:#888;line-height:1.75;margin-bottom:8px">If anything breaks, reply to this email directly or reach us at <a href="mailto:support@greenberries.co.za" style="color:#f0f0f0">support@greenberries.co.za</a>. This is a real beta — your feedback shapes what gets built next.</p>
  <p style="color:#888;line-height:1.75;margin-bottom:28px">You can also send feedback directly from your AI: just ask it to <em>send feedback to What Next</em> — it'll use the <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">send_feedback</code> tool.</p>
  <p style="font-size:13px;color:#444;line-height:1.75;margin-bottom:28px;padding:16px;border:1px solid rgba(255,255,255,0.05);border-radius:6px"><strong style="color:#666">What data is stored:</strong> Only what your AI explicitly saves — session summaries, facts, and any feedback you choose to send. No passive telemetry, no error snooping, no tracking. Your data is isolated to your API key and is never shared. You can ask me to delete it at any time.</p>
  <p style="color:#555;margin-bottom:32px">— Danny, Greenberries</p>
  <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin-bottom:24px">
  <p style="font-size:12px;color:#333">whatnextai.co.za · Built by Greenberries</p>
</body>
</html>`;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function send(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const MAX_BODY_BYTES = 64 * 1024; // 64KB — more than enough for any session dump

// Past this much an oversized body is no longer drained; the socket is closed
// once the 413 has been written.
const MAX_DRAIN_BYTES = 16 * 1024 * 1024;

// An oversized body rejects with 413 straight away, but the socket is left
// open and the rest of the body is read and discarded, so the client finishes
// sending and actually receives the 413. Destroying the socket here made the
// client see ECONNRESET and treat a bad request as "cloud down".
function parseBody(req, res) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers?.['content-length'] ?? '', 10);
    const chunks = [];
    let size = 0;
    let rejected = false;
    const overflow = () => {
      rejected = true;
      chunks.length = 0;
      reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
    };
    const destroyAfterReply = () => {
      if (req.destroyed) return;
      if (!res || res.writableFinished) req.destroy();
      else res.once('finish', () => req.destroy());
    };
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) overflow();
    req.on('data', c => {
      size += c.length;
      if (rejected) {
        if (size > MAX_DRAIN_BYTES) destroyAfterReply();
        return;
      }
      if (size > MAX_BODY_BYTES) return overflow();
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', err => { if (!rejected) { rejected = true; reject(err); } });
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

async function start() {
  await initSchema();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;

    // Security headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    // CORS
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      });
      res.end();
      return;
    }

    // Rate limit (skip health check)
    if (url.pathname !== '/health') {
      const rl = checkRateLimit(clientIp(req));
      res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
      res.setHeader('X-RateLimit-Remaining', rl.remaining);
      if (!rl.allowed) return send(res, 429, { error: 'Too many requests. Limit: 60/min.' });
    }

    // ── Public: health ──
    if (method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'what-next-cloud' });
    }

    // ── Public: Netlify webhook ──
    if (method === 'POST' && url.pathname === '/webhooks/beta-signup') {
      if (!safeEqual(WEBHOOK_SECRET, webhookSecretFrom(req))) {
        return send(res, 401, { error: 'Unauthorized' });
      }
      try {
        const body = await parseBody(req, res);
        // Netlify sends form data under body.data or body.payload.data
        const data = body.data ?? body.payload?.data ?? body;
        if (data.email == null || data.email === '') return send(res, 400, { error: 'email missing from webhook payload' });
        const email = normalizeEmail(data.email);
        if (!email) return send(res, 400, { error: 'invalid email' });
        const name = cleanName(data.name);

        // Already exists: idempotent, but finish an earlier failed welcome email.
        // Always sent to the stored address, never to anything in this payload.
        const existing = await pool.query(
          'SELECT id, email, name, welcome_sent_at FROM users WHERE email = $1', [email]
        );
        if (existing.rows.length) {
          const u = existing.rows[0];
          if (u.welcome_sent_at) {
            log('info', 'Webhook: user already exists', { email });
            return send(res, 200, { ok: true, note: 'already exists' });
          }
          const fresh = await reissueKeyForWelcome(u);
          if (!fresh) {
            log('info', 'Webhook: user exists and their key is in use, not re-sending', { email });
            return send(res, 200, { ok: true, note: 'already exists' });
          }
          log('info', 'Webhook: user exists without welcome email, re-sending with a new key', { email });
          if (!(await deliverWelcome(fresh))) return send(res, 502, { error: 'welcome email failed' });
          return send(res, 200, { ok: true, note: 'already exists, welcome email re-sent' });
        }

        let user;
        try {
          user = await createUser({ email, name });
        } catch (err) {
          // Concurrent signup for the same email: the other request owns it
          if (err.code === '23505') {
            log('info', 'Webhook: user already exists (concurrent)', { email });
            return send(res, 200, { ok: true, note: 'already exists' });
          }
          throw err;
        }
        log('info', 'New beta user created', { email });
        sendTelegramAlert(`New What Next signup: ${name ? name + ' ' : ''}(${email})`);
        if (!(await deliverWelcome(user))) {
          return send(res, 502, { error: 'user created but welcome email failed; resubmit or run reconcile-signups to retry' });
        }
        return send(res, 201, { ok: true });
      } catch (err) {
        const status = err.statusCode ?? 500;
        log('error', 'Webhook error', { status, err: err.message });
        return send(res, status, { error: status === 500 ? 'Internal server error' : err.message });
      }
    }

    // ── Admin: create user ──
    if (method === 'POST' && url.pathname === '/admin/users') {
      const adminKey = req.headers['x-admin-key'];
      if (!safeEqual(ADMIN_KEY, adminKey)) return send(res, 401, { error: 'Unauthorized' });
      try {
        const body = await parseBody(req, res);
        if (!body.email) return send(res, 400, { error: 'email required' });
        const email = normalizeEmail(body.email);
        if (!email) return send(res, 400, { error: 'invalid email' });
        const plan = body.plan == null ? 'beta' : cap(body.plan, 50);
        const user = await createUser({ email, name: cleanName(body.name), plan });
        let welcome_sent = false;
        if (body.send_email !== false) welcome_sent = await deliverWelcome(user);
        return send(res, 201, { ...user, welcome_sent });
      } catch (err) {
        if (err.code === '23505') return send(res, 409, { error: 'User with this email already exists' });
        if (err.statusCode) return send(res, err.statusCode, { error: err.message });
        log('error', 'Admin create user error', { err: err.message });
        trackError(err.message);
        return send(res, 500, { error: 'Internal server error' });
      }
    }

    // ── Admin: re-send a welcome email that never went out ──
    // Only for users whose welcome_sent_at is NULL; always to the stored address.
    if (method === 'POST' && url.pathname === '/admin/users/resend-welcome') {
      const adminKey = req.headers['x-admin-key'];
      if (!safeEqual(ADMIN_KEY, adminKey)) return send(res, 401, { error: 'Unauthorized' });
      try {
        const body = await parseBody(req, res);
        const email = normalizeEmail(body.email);
        if (!email) return send(res, 400, { error: 'valid email required' });
        const { rows: [u] } = await pool.query(
          'SELECT id, email, name, welcome_sent_at FROM users WHERE email = $1', [email]
        );
        if (!u) return send(res, 404, { error: 'User not found' });
        if (u.welcome_sent_at) return send(res, 409, { error: 'Welcome email already sent' });
        const fresh = await reissueKeyForWelcome(u);
        if (!fresh) return send(res, 409, { error: "This user's API key is already in use, so it was not replaced" });
        if (!(await deliverWelcome(fresh))) return send(res, 502, { error: 'welcome email failed' });
        return send(res, 200, { ok: true });
      } catch (err) {
        if (err.statusCode) return send(res, err.statusCode, { error: err.message });
        log('error', 'Admin resend welcome error', { err: err.message });
        trackError(err.message);
        return send(res, 500, { error: 'Internal server error' });
      }
    }

    // ── All routes below require auth ──
    try {
      const apiKey = req.headers['x-api-key'];
      const user = await resolveUser(apiKey);
      if (!user) return send(res, 401, { error: 'Invalid or missing API key' });

      // POST /feedback
      if (method === 'POST' && url.pathname === '/feedback') {
        const body = await parseBody(req, res);
        if (typeof body.message !== 'string' || !body.message.trim()) return send(res, 400, { error: 'message is required' });
        if (body.type != null && typeof body.type !== 'string') return send(res, 400, { error: 'type must be a string' });
        const message = cap(body.message, 4000);
        const context = body.context == null ? null
          : cap(typeof body.context === 'string' ? body.context : JSON.stringify(body.context), 4000);
        sendTelegramAlert(`What Next feedback from ${user.email}: ${message.slice(0, 200)}`);
        const { rows } = await pool.query(`
          INSERT INTO feedback (user_id, type, message, context)
          VALUES ($1, $2, $3, $4) RETURNING id
        `, [user.id, cap(body.type ?? 'general', 50), message, context]);
        log('info', 'Feedback received', { user: user.email, preview: message.slice(0, 80) });
        return send(res, 201, { id: rows[0].id, message: 'Feedback received — thank you' });
      }

      // GET /user — current user profile
      if (method === 'GET' && url.pathname === '/user') {
        const { rows: [stats] } = await pool.query(`
          SELECT
            (SELECT COUNT(*)::INT FROM sessions WHERE user_id = $1) AS total_sessions,
            (SELECT COUNT(*)::INT FROM facts    WHERE user_id = $1) AS total_facts,
            (SELECT COUNT(*)::INT FROM projects WHERE user_id = $1) AS total_projects
        `, [user.id]);
        return send(res, 200, {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          created_at: user.created_at,
          ...stats,
        });
      }

      // GET /stats — quick summary counts
      if (method === 'GET' && url.pathname === '/stats') {
        const { rows: [counts] } = await pool.query(`
          SELECT
            (SELECT COUNT(*)::INT FROM sessions WHERE user_id = $1) AS sessions,
            (SELECT COUNT(*)::INT FROM facts    WHERE user_id = $1) AS facts,
            (SELECT COUNT(*)::INT FROM projects WHERE user_id = $1) AS projects,
            (SELECT MIN(session_date)::TEXT FROM sessions WHERE user_id = $1) AS first_session,
            (SELECT MAX(session_date)::TEXT FROM sessions WHERE user_id = $1) AS last_session
        `, [user.id]);
        return send(res, 200, counts);
      }

      // POST /session
      if (method === 'POST' && url.pathname === '/session') {
        const body = await parseBody(req, res);
        if (!body.project || !body.summary) return send(res, 400, { error: 'project and summary are required' });
        const id = await addSession(user.id, body);
        return send(res, 201, { id, message: 'Session stored' });
      }

      // POST /fact
      if (method === 'POST' && url.pathname === '/fact') {
        const body = await parseBody(req, res);
        if (!body.category || !body.content) return send(res, 400, { error: 'category and content are required' });
        const id = await addFact(user.id, body);
        return send(res, 201, { id, message: 'Fact stored' });
      }

      // GET /search?q=...
      if (method === 'GET' && url.pathname === '/search') {
        const q = url.searchParams.get('q');
        if (!q) return send(res, 400, { error: 'q parameter required' });
        const limit = parseLimit(url.searchParams.get('limit'), 10, 50);
        return send(res, 200, await searchMemories(user.id, q, limit));
      }

      // GET /semantic-search?q=...&limit=N
      if (method === 'GET' && url.pathname === '/semantic-search') {
        const q = url.searchParams.get('q');
        if (!q) return send(res, 400, { error: 'q parameter required' });
        const limit = parseLimit(url.searchParams.get('limit'), 10, 50);
        try {
          const vec = await generateEmbedding(q);
          const { rows } = await pool.query(`
            SELECT e.rowtype, e.row_id,
                   1 - (e.embedding <=> $3::vector) AS score,
                   CASE e.rowtype
                     WHEN 'session' THEN (SELECT s.summary FROM sessions s WHERE s.id = e.row_id AND s.user_id = $1)
                     WHEN 'fact'    THEN (SELECT f.content FROM facts    f WHERE f.id = e.row_id AND f.user_id = $1)
                   END AS text
            FROM embeddings e
            WHERE e.user_id = $1
            ORDER BY e.embedding <=> $3::vector
            LIMIT $2
          `, [user.id, limit, JSON.stringify(vec)]);
          return send(res, 200, { results: rows.filter(r => r.text) });
        } catch (err) {
          log('error', 'semantic-search error', { err: err.message });
          return send(res, 500, { error: 'Semantic search unavailable' });
        }
      }

      // POST /reindex — backfill embeddings for own sessions + facts that aren't indexed yet
      if (method === 'POST' && url.pathname === '/reindex') {
        try {
          const [{ rows: sessions }, { rows: facts }] = await Promise.all([
            pool.query(`
              SELECT s.id, s.summary, s.what_was_built, s.decisions, s.next_steps
              FROM sessions s
              LEFT JOIN embeddings e ON e.user_id = $1 AND e.rowtype = 'session' AND e.row_id = s.id
              WHERE s.user_id = $1 AND e.id IS NULL
            `, [user.id]),
            pool.query(`
              SELECT f.id, f.category, f.content, f.tags
              FROM facts f
              LEFT JOIN embeddings e ON e.user_id = $1 AND e.rowtype = 'fact' AND e.row_id = f.id
              WHERE f.user_id = $1 AND e.id IS NULL
            `, [user.id]),
          ]);
          let indexed = 0;
          for (const s of sessions) {
            const text = [s.summary, s.what_was_built, s.decisions, s.next_steps].filter(Boolean).join(' ').slice(0, 2000);
            await storeEmbedding(user.id, 'session', s.id, text);
            indexed++;
          }
          for (const f of facts) {
            const text = [f.category, f.content, f.tags].filter(Boolean).join(' ').slice(0, 2000);
            await storeEmbedding(user.id, 'fact', f.id, text);
            indexed++;
          }
          log('info', 'Reindex complete', { user: user.email, indexed });
          return send(res, 200, { indexed, message: `${indexed} items indexed` });
        } catch (err) {
          log('error', 'Reindex error', { err: err.message });
          return send(res, 500, { error: 'Reindex failed' });
        }
      }

      // GET /context — session-start context brief (recent sessions + all facts + projects)
      if (method === 'GET' && url.pathname === '/context') {
        const [{ rows: sessions }, { rows: facts }, { rows: projects }] = await Promise.all([
          pool.query(`
            SELECT s.id, p.name AS project_name, s.summary, s.next_steps, s.tags,
                   s.session_date::TEXT AS session_date
            FROM sessions s JOIN projects p ON p.id = s.project_id
            WHERE s.user_id = $1 ORDER BY s.session_date DESC LIMIT 5
          `, [user.id]),
          pool.query(`
            SELECT f.id, f.category, f.content, f.tags, p.name AS project_name
            FROM facts f LEFT JOIN projects p ON p.id = f.project_id
            WHERE f.user_id = $1 ORDER BY f.created_at DESC
          `, [user.id]),
          pool.query(`
            SELECT p.name, COUNT(s.id)::INT AS session_count,
                   MAX(s.session_date)::TEXT AS last_session
            FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
            WHERE p.user_id = $1 GROUP BY p.id
            ORDER BY last_session DESC NULLS LAST LIMIT 10
          `, [user.id]),
        ]);
        return send(res, 200, { recent_sessions: sessions, facts, active_projects: projects });
      }

      // GET /projects
      if (method === 'GET' && url.pathname === '/projects') {
        return send(res, 200, await listProjects(user.id));
      }

      // GET /project/:name
      const projectMatch = url.pathname.match(/^\/project\/(.+)$/);
      if (method === 'GET' && projectMatch) {
        const name = decodeURIComponent(projectMatch[1]);
        const project = await getProject(user.id, name);
        if (!project) return send(res, 404, { error: 'Project not found' });
        return send(res, 200, project);
      }

      // GET /export?since=ISO_DATE — bulk pull for local↔cloud sync
      if (method === 'GET' && url.pathname === '/export') {
        const since = parseSince(url.searchParams.get('since'));
        if (!since) return send(res, 400, { error: 'since must be an ISO date' });
        const { rows: sessions } = await pool.query(`
          SELECT s.id::TEXT AS cloud_id, p.name AS project_name, s.summary,
                 s.what_was_built, s.decisions, s.stack, s.next_steps, s.tags,
                 s.session_date::TEXT AS session_date, s.created_at::TEXT AS created_at,
                 s.updated_at::TEXT AS updated_at
          FROM sessions s
          JOIN projects p ON p.id = s.project_id
          WHERE s.user_id = $1 AND (s.created_at > $2 OR s.updated_at > $2)
          ORDER BY GREATEST(s.created_at, s.updated_at) ASC
        `, [user.id, since]);
        const { rows: deleted_sessions } = await pool.query(`
          SELECT session_id::TEXT AS cloud_id, deleted_at::TEXT AS deleted_at
          FROM session_tombstones
          WHERE user_id = $1 AND deleted_at > $2
          ORDER BY deleted_at ASC
        `, [user.id, since]);
        const { rows: facts } = await pool.query(`
          SELECT f.id::TEXT AS cloud_id, p.name AS project_name, f.category,
                 f.content, f.tags, f.created_at::TEXT AS created_at
          FROM facts f
          LEFT JOIN projects p ON p.id = f.project_id
          WHERE f.user_id = $1 AND f.created_at > $2
          ORDER BY f.created_at ASC
        `, [user.id, since]);
        return send(res, 200, { sessions, facts, deleted_sessions, exported_at: new Date().toISOString() });
      }

      // DELETE /session/:id — user deletes one of their own sessions
      const sessionIdMatch = url.pathname.match(/^\/session\/(\d+)$/);
      if (method === 'DELETE' && sessionIdMatch) {
        const sessionId = parseInt(sessionIdMatch[1], 10);
        // Delete and tombstone together, so every synced machine learns of it.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rowCount } = await client.query(
            'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
            [sessionId, user.id]
          );
          if (!rowCount) {
            await client.query('ROLLBACK');
            return send(res, 404, { error: 'Session not found or not yours' });
          }
          await client.query(
            'INSERT INTO session_tombstones (user_id, session_id) VALUES ($1, $2)',
            [user.id, sessionId]
          );
          await client.query(
            "DELETE FROM embeddings WHERE user_id = $1 AND rowtype = 'session' AND row_id = $2",
            [user.id, sessionId]
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        return send(res, 200, { ok: true });
      }

      // PATCH /session/:id — edit an existing session
      if (method === 'PATCH' && sessionIdMatch) {
        const sessionId = parseInt(sessionIdMatch[1], 10);
        const body = await parseBody(req, res);
        const allowed = ['summary', 'what_was_built', 'decisions', 'stack', 'next_steps', 'tags'];
        const sets = [];
        const vals = [];
        for (const f of allowed) {
          if (body[f] !== undefined) {
            sets.push(`${f} = $${vals.length + 3}`);
            vals.push(cap(body[f], SESSION_CAPS[f]));
          }
        }
        if (sets.length === 0) return send(res, 400, { error: 'No valid fields to update' });
        const { rows: updated } = await pool.query(
          `UPDATE sessions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND user_id = $2
           RETURNING summary, what_was_built, decisions, next_steps, tags, updated_at::TEXT AS updated_at`,
          [sessionId, user.id, ...vals]
        );
        if (!updated.length) return send(res, 404, { error: 'Session not found or not yours' });
        storeEmbedding(user.id, 'session', sessionId, sessionEmbText(updated[0])); // fire and forget, same as insert
        return send(res, 200, { ok: true, updated_at: updated[0].updated_at });
      }

      // GET /whats-next — most recent open next_steps per project
      if (method === 'GET' && url.pathname === '/whats-next') {
        const limit = parseLimit(url.searchParams.get('limit'), 8, 20);
        const { rows } = await pool.query(`
          SELECT DISTINCT ON (s.project_id)
            s.id, s.next_steps, s.session_date::TEXT AS session_date, s.summary,
            p.name AS project_name
          FROM sessions s
          JOIN projects p ON p.id = s.project_id
          WHERE s.user_id = $1
            AND s.next_steps IS NOT NULL AND trim(s.next_steps) != ''
          ORDER BY s.project_id, s.session_date DESC
          LIMIT $2
        `, [user.id, limit]);
        return send(res, 200, { items: rows });
      }

      // POST /intelligence — upsert project intelligence card
      if (method === 'POST' && url.pathname === '/intelligence') {
        const body = await parseBody(req, res);
        if (!body.project) return send(res, 400, { error: 'project is required' });
        const { rows: [proj] } = await pool.query(
          `INSERT INTO projects (user_id, name) VALUES ($1, $2)
           ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [user.id, cap(body.project, 100)]
        );
        const fields = ['repo_path', 'stack', 'key_dirs', 'conventions', 'env_vars', 'deployment', 'extra'];
        const sets = fields.map((f, i) => `${f} = $${i + 3}`);
        const vals = fields.map(f => cap(body[f], f === 'repo_path' ? 1000 : 4000));
        await pool.query(`
          INSERT INTO project_intelligence (user_id, project_id, ${fields.join(', ')})
          VALUES ($1, $2, ${fields.map((_, i) => `$${i + 3}`).join(', ')})
          ON CONFLICT (user_id, project_id) DO UPDATE SET
            ${sets.join(', ')}, updated_at = NOW()
        `, [user.id, proj.id, ...vals]);
        return send(res, 200, { ok: true });
      }

      // GET /intelligence/:name — fetch project intelligence card
      const intelMatch = url.pathname.match(/^\/intelligence\/(.+)$/);
      if (method === 'GET' && intelMatch) {
        const name = decodeURIComponent(intelMatch[1]);
        const { rows } = await pool.query(`
          SELECT pi.*
          FROM project_intelligence pi
          JOIN projects p ON p.id = pi.project_id
          WHERE pi.user_id = $1 AND p.name = $2
        `, [user.id, name]);
        if (!rows.length) return send(res, 404, { error: 'No intelligence for this project' });
        return send(res, 200, rows[0]);
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.statusCode ?? 500;
      log('error', 'Request error', { method, path: url.pathname, status, err: err.message });
      if (status === 500) trackError(err.message);
      send(res, status, { error: status === 413 ? 'Request body too large' : status === 400 ? err.message : 'Internal server error' });
    }
  });

  server.listen(PORT, () => {
    log('info', 'What Next cloud server started', { port: PORT });
  });
}

export {
  escapeHtml, normalizeEmail, cleanName, parseLimit, parseSince, clientIp, normalizeIp, hashApiKey,
  webhookSecretFrom, safeEqual, checkRateLimit, pruneRateLimit, rateLimitMap, welcomeEmailHtml,
  SESSION_CAPS, FACT_CAPS, sessionEmbText, parseSessionDate, parseBody, MAX_BODY_BYTES,
};

// Only boot when run directly (node src/cloud-server.js), so tests can import the helpers.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!process.env.DATABASE_URL) {
    log('fatal', 'DATABASE_URL is required');
    process.exit(1);
  }

  // Alert on process crash (unhandled rejection)
  process.on('unhandledRejection', (err) => {
    const msg = err?.message ?? String(err);
    log('error', 'Unhandled rejection', { err: msg });
    sendTelegramAlert(`[What Next Cloud] Unhandled rejection: ${msg}`);
  });

  start().catch(err => {
    log('fatal', 'Server failed to start', { err: err.message });
    process.exit(1);
  });
}
