/**
 * What Next — Multi-tenant Cloud Server
 *
 * Runs on Railway. Each user is isolated by their API key.
 * Local api.js / api-server.js are untouched — they remain single-user local only.
 *
 * Required env vars:
 *   DATABASE_URL        — Railway Postgres connection string
 *   ADMIN_KEY           — Secret for /admin/users endpoint (generate a long random string)
 *   WEBHOOK_SECRET      — Secret appended to Netlify webhook URL
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
 */

import { createServer } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
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
const RESEND_FROM = process.env.RESEND_FROM ?? 'What Next <noreply@greenberries.co.za>';
const TELEGRAM_ALERT_URL = process.env.TELEGRAM_ALERT_URL; // optional: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=

if (!process.env.DATABASE_URL) {
  log('fatal', 'DATABASE_URL is required');
  process.exit(1);
}

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
// Prune stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) if (now > entry.reset + 60_000) rateLimitMap.delete(ip);
}, 5 * 60_000);

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

// Alert on process crash (unhandled rejection)
process.on('unhandledRejection', (err) => {
  const msg = err?.message ?? String(err);
  log('error', 'Unhandled rejection', { err: msg });
  sendTelegramAlert(`[What Next Cloud] Unhandled rejection: ${msg}`);
});

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
  // Check how many of our core tables have user_id — if any are missing, wipe and rebuild
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('projects', 'sessions', 'facts')
      AND column_name = 'user_id'
  `);
  if (rows[0].cnt < 3) {
    log('warn', 'Old schema detected — rebuilding');
    await pool.query('DROP TABLE IF EXISTS facts CASCADE');
    await pool.query('DROP TABLE IF EXISTS sessions CASCADE');
    await pool.query('DROP TABLE IF EXISTS projects CASCADE');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      api_key    TEXT NOT NULL UNIQUE,
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

async function resolveUser(apiKey) {
  if (!apiKey) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE api_key = $1', [apiKey]);
  return rows[0] ?? null;
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

async function addSession(userId, { project, summary, what_was_built, decisions, stack, next_steps, tags }) {
  const projectId = await upsertProject(userId, cap(project, 100));
  const { rows } = await pool.query(`
    INSERT INTO sessions (user_id, project_id, summary, what_was_built, decisions, stack, next_steps, tags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [userId, projectId, cap(summary, 4000), cap(what_was_built, 8000), cap(decisions, 4000), cap(stack, 1000), cap(next_steps, 4000), cap(tags, 500)]);
  const id = rows[0].id;
  const embText = [summary, what_was_built, decisions, next_steps, tags].filter(Boolean).join(' ');
  storeEmbedding(userId, 'session', id, embText); // fire and forget
  return id;
}

async function addFact(userId, { category, content, project, tags }) {
  let projectId = null; // resolved below
  if (project) projectId = await upsertProject(userId, cap(project, 100));
  const { rows } = await pool.query(`
    INSERT INTO facts (user_id, project_id, category, content, tags)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [userId, projectId, cap(category, 200), cap(content, 4000), cap(tags, 500)]);
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

async function createUser({ email, name, plan = 'beta' }) {
  const apiKey = makeApiKey();
  const { rows } = await pool.query(`
    INSERT INTO users (api_key, email, name, plan)
    VALUES ($1, $2, $3, $4)
    RETURNING id, api_key, email, name, plan, created_at
  `, [apiKey, email.toLowerCase().trim(), name ?? null, plan]);
  return rows[0];
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendWelcomeEmail({ name, email, apiKey }) {
  if (!RESEND_API_KEY) {
    log('warn', 'RESEND_API_KEY not set — skipping email', { email });
    return;
  }

  const firstName = name ? name.split(' ')[0] : 'there';

  const html = `
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
    &nbsp;&nbsp;&nbsp;&nbsp;"args": ["~/what-next/src/server.js"],<br>
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
  });

  if (!res.ok) {
    const err = await res.text();
    log('error', 'Resend email failed', { email, err });
  } else {
    log('info', 'Welcome email sent', { email });
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const MAX_BODY_BYTES = 64 * 1024; // 64KB — more than enough for any session dump

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', c => {
      size += Buffer.byteLength(c);
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      raw += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
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
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress ?? 'unknown';
      const rl = checkRateLimit(ip);
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
      const secret = url.searchParams.get('secret');
      if (!safeEqual(WEBHOOK_SECRET, secret)) {
        return send(res, 401, { error: 'Unauthorized' });
      }
      try {
        const body = await parseBody(req);
        // Netlify sends form data under body.data or body.payload.data
        const data = body.data ?? body.payload?.data ?? body;
        const email = data.email;
        const name  = data.name;

        if (!email) return send(res, 400, { error: 'email missing from webhook payload' });

        // Check if already exists (idempotent)
        const existing = await pool.query('SELECT api_key FROM users WHERE email = $1', [email.toLowerCase().trim()]);
        if (existing.rows.length) {
          log('info', 'Webhook: user already exists', { email });
          return send(res, 200, { ok: true, note: 'already exists' });
        }

        const user = await createUser({ email, name });
        await sendWelcomeEmail({ name, email, apiKey: user.api_key });
        log('info', 'New beta user created', { email });
        sendTelegramAlert(`New What Next signup: ${name ? name + ' ' : ''}(${email})`);
        return send(res, 201, { ok: true });
      } catch (err) {
        log('error', 'Webhook error', { err: err.message });
        return send(res, 500, { error: err.message });
      }
    }

    // ── Admin: create user ──
    if (method === 'POST' && url.pathname === '/admin/users') {
      const adminKey = req.headers['x-admin-key'];
      if (!safeEqual(ADMIN_KEY, adminKey)) return send(res, 401, { error: 'Unauthorized' });
      try {
        const body = await parseBody(req);
        if (!body.email) return send(res, 400, { error: 'email required' });
        const user = await createUser({ email: body.email, name: body.name, plan: body.plan ?? 'beta' });
        if (body.send_email !== false) {
          await sendWelcomeEmail({ name: user.name, email: user.email, apiKey: user.api_key });
        }
        return send(res, 201, user);
      } catch (err) {
        if (err.code === '23505') return send(res, 409, { error: 'User with this email already exists' });
        log('error', 'Admin create user error', { err: err.message });
        return send(res, 500, { error: err.message });
      }
    }

    // ── All routes below require auth ──
    const apiKey = req.headers['x-api-key'];
    const user = await resolveUser(apiKey);
    if (!user) return send(res, 401, { error: 'Invalid or missing API key' });

    try {
      // POST /feedback
      if (method === 'POST' && url.pathname === '/feedback') {
        const body = await parseBody(req);
        if (!body.message) return send(res, 400, { error: 'message is required' });
        sendTelegramAlert(`What Next feedback from ${user.email}: ${String(body.message).slice(0, 200)}`);
        const { rows } = await pool.query(`
          INSERT INTO feedback (user_id, type, message, context)
          VALUES ($1, $2, $3, $4) RETURNING id
        `, [user.id, body.type ?? 'general', body.message, body.context ?? null]);
        log('info', 'Feedback received', { user: user.email, preview: body.message.slice(0, 80) });
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
        const body = await parseBody(req);
        if (!body.project || !body.summary) return send(res, 400, { error: 'project and summary are required' });
        const id = await addSession(user.id, body);
        return send(res, 201, { id, message: 'Session stored' });
      }

      // POST /fact
      if (method === 'POST' && url.pathname === '/fact') {
        const body = await parseBody(req);
        if (!body.category || !body.content) return send(res, 400, { error: 'category and content are required' });
        const id = await addFact(user.id, body);
        return send(res, 201, { id, message: 'Fact stored' });
      }

      // GET /search?q=...
      if (method === 'GET' && url.pathname === '/search') {
        const q = url.searchParams.get('q');
        if (!q) return send(res, 400, { error: 'q parameter required' });
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);
        return send(res, 200, await searchMemories(user.id, q, limit));
      }

      // GET /semantic-search?q=...&limit=N
      if (method === 'GET' && url.pathname === '/semantic-search') {
        const q = url.searchParams.get('q');
        if (!q) return send(res, 400, { error: 'q parameter required' });
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);
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
        const since = url.searchParams.get('since') ?? new Date(0).toISOString();
        const { rows: sessions } = await pool.query(`
          SELECT s.id::TEXT AS cloud_id, p.name AS project_name, s.summary,
                 s.what_was_built, s.decisions, s.stack, s.next_steps, s.tags,
                 s.session_date::TEXT AS session_date, s.created_at::TEXT AS created_at
          FROM sessions s
          JOIN projects p ON p.id = s.project_id
          WHERE s.user_id = $1 AND s.created_at > $2
          ORDER BY s.created_at ASC
        `, [user.id, since]);
        const { rows: facts } = await pool.query(`
          SELECT f.id::TEXT AS cloud_id, p.name AS project_name, f.category,
                 f.content, f.tags, f.created_at::TEXT AS created_at
          FROM facts f
          LEFT JOIN projects p ON p.id = f.project_id
          WHERE f.user_id = $1 AND f.created_at > $2
          ORDER BY f.created_at ASC
        `, [user.id, since]);
        return send(res, 200, { sessions, facts, exported_at: new Date().toISOString() });
      }

      // DELETE /session/:id — user deletes one of their own sessions
      const sessionIdMatch = url.pathname.match(/^\/session\/(\d+)$/);
      if (method === 'DELETE' && sessionIdMatch) {
        const sessionId = parseInt(sessionIdMatch[1], 10);
        const { rowCount } = await pool.query(
          'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
          [sessionId, user.id]
        );
        if (!rowCount) return send(res, 404, { error: 'Session not found or not yours' });
        return send(res, 200, { ok: true });
      }

      // PATCH /session/:id — edit an existing session
      if (method === 'PATCH' && sessionIdMatch) {
        const sessionId = parseInt(sessionIdMatch[1], 10);
        const body = await parseBody(req);
        const allowed = ['summary', 'what_was_built', 'decisions', 'stack', 'next_steps', 'tags'];
        const sets = [];
        const vals = [];
        for (const f of allowed) {
          if (body[f] !== undefined) {
            sets.push(`${f} = $${vals.length + 3}`);
            vals.push(cap(body[f], f === 'summary' ? 4000 : f === 'what_was_built' ? 8000 : f === 'tags' ? 500 : 4000));
          }
        }
        if (sets.length === 0) return send(res, 400, { error: 'No valid fields to update' });
        const { rowCount } = await pool.query(
          `UPDATE sessions SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
          [sessionId, user.id, ...vals]
        );
        if (!rowCount) return send(res, 404, { error: 'Session not found or not yours' });
        return send(res, 200, { ok: true });
      }

      // GET /whats-next — most recent open next_steps per project
      if (method === 'GET' && url.pathname === '/whats-next') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '8', 10), 20);
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

start().catch(err => {
  log('fatal', 'Server failed to start', { err: err.message });
  process.exit(1);
});
