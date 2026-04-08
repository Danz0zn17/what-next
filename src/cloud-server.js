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
 *
 * Endpoints (all require X-API-Key except noted):
 *   GET  /health                        — public
 *   POST /session                       — dump a session
 *   POST /fact                          — store a fact
 *   GET  /search?q=...                  — full-text search
 *   GET  /projects                      — list projects
 *   GET  /project/:name                 — get project + sessions
 *   POST /admin/users                   — create user + issue key  (ADMIN_KEY)
 *   POST /webhooks/beta-signup          — Netlify form webhook (WEBHOOK_SECRET)
 */

import { createServer } from 'http';
import pkg from 'pg';
const { Pool } = pkg;

const PORT = process.env.PORT ?? 3001;
const ADMIN_KEY = process.env.ADMIN_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM ?? 'What Next <noreply@whatnextai.co.za>';

if (!process.env.DATABASE_URL) {
  process.stderr.write('[cloud] DATABASE_URL is required\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
    process.stderr.write('[cloud] Migrating: old schema detected — rebuilding\n');
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
  process.stderr.write('[cloud] Schema ready\n');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

import { randomBytes } from 'crypto';

function makeApiKey() {
  return 'bak_' + randomBytes(32).toString('hex');
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

async function addSession(userId, { project, summary, what_was_built, decisions, stack, next_steps, tags }) {
  const projectId = await upsertProject(userId, project);
  const { rows } = await pool.query(`
    INSERT INTO sessions (user_id, project_id, summary, what_was_built, decisions, stack, next_steps, tags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [userId, projectId, summary, what_was_built ?? null, decisions ?? null, stack ?? null, next_steps ?? null, tags ?? null]);
  return rows[0].id;
}

async function addFact(userId, { category, content, project, tags }) {
  let projectId = null;
  if (project) projectId = await upsertProject(userId, project);
  const { rows } = await pool.query(`
    INSERT INTO facts (user_id, project_id, category, content, tags)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [userId, projectId, category, content, tags ?? null]);
  return rows[0].id;
}

async function searchMemories(userId, q, limit = 10) {
  const term = q.split(/\s+/).filter(Boolean).join(' & ');
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
    process.stderr.write(`[cloud] RESEND_API_KEY not set — skipping email to ${email}\n`);
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
  <p style="color:#888;line-height:1.75;margin-bottom:12px"><strong style="color:#f0f0f0">2. Add to Claude Desktop</strong> — edit <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">~/Library/Application Support/Claude/claude_desktop_config.json</code></p>
  <div style="background:#0c0c0c;border:1px solid rgba(255,255,255,0.07);border-radius:6px;padding:14px 18px;font-family:monospace;font-size:12px;margin-bottom:16px;color:#888;line-height:1.9">
    "mcpServers": {<br>
    &nbsp;&nbsp;"what-next": {<br>
    &nbsp;&nbsp;&nbsp;&nbsp;"command": "node",<br>
    &nbsp;&nbsp;&nbsp;&nbsp;"args": ["/Users/YOUR_NAME/what-next/src/server.js"],<br>
    &nbsp;&nbsp;&nbsp;&nbsp;"env": {<br>
    &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"WHATNEXT_CLOUD_URL": "https://what-next-production.up.railway.app",<br>
    &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"WHATNEXT_API_KEY": "${apiKey}"<br>
    &nbsp;&nbsp;&nbsp;&nbsp;}<br>
    &nbsp;&nbsp;}<br>
    }
  </div>
  <p style="color:#888;line-height:1.75;margin-bottom:12px"><strong style="color:#f0f0f0">3. Add to VS Code / GitHub Copilot</strong> — same config in <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">~/Library/Application Support/Code/User/mcp.json</code> using <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">"servers"</code> instead of <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px">"mcpServers"</code></p>
  <p style="color:#888;line-height:1.75;margin-bottom:32px"><strong style="color:#f0f0f0">4. Restart Claude / VS Code</strong> — What Next will appear as an available tool.</p>
  <p style="color:#888;line-height:1.75;margin-bottom:8px">If anything breaks, reply to this email directly. This is a real beta — your feedback shapes what gets built next.</p>
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
    process.stderr.write(`[cloud] Resend error: ${err}\n`);
  } else {
    process.stderr.write(`[cloud] Welcome email sent to ${email}\n`);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

async function start() {
  await initSchema();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;

    // CORS
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    // ── Public: health ──
    if (method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'what-next-cloud' });
    }

    // ── Public: Netlify webhook ──
    if (method === 'POST' && url.pathname === '/webhooks/beta-signup') {
      const secret = url.searchParams.get('secret');
      if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
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
          process.stderr.write(`[cloud] Signup webhook: user ${email} already exists, skipping\n`);
          return send(res, 200, { ok: true, note: 'already exists' });
        }

        const user = await createUser({ email, name });
        await sendWelcomeEmail({ name, email, apiKey: user.api_key });
        process.stderr.write(`[cloud] New beta user: ${email}\n`);
        return send(res, 201, { ok: true });
      } catch (err) {
        process.stderr.write(`[cloud] Webhook error: ${err.message}\n`);
        return send(res, 500, { error: err.message });
      }
    }

    // ── Admin: create user ──
    if (method === 'POST' && url.pathname === '/admin/users') {
      const adminKey = req.headers['x-admin-key'];
      if (!ADMIN_KEY || adminKey !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
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
        process.stderr.write(`[cloud] Admin create user error: ${err.message}\n`);
        return send(res, 500, { error: err.message });
      }
    }

    // ── All routes below require auth ──
    const apiKey = req.headers['x-api-key'];
    const user = await resolveUser(apiKey);
    if (!user) return send(res, 401, { error: 'Invalid or missing API key' });

    try {
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
        const limit = parseInt(url.searchParams.get('limit') ?? '10');
        return send(res, 200, await searchMemories(user.id, q, limit));
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

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      process.stderr.write(`[cloud] Request error: ${err.message}\n`);
      send(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(PORT, () => {
    process.stderr.write(`[cloud] What Next cloud server running on port ${PORT}\n`);
  });
}

start().catch(err => {
  process.stderr.write(`[cloud] Fatal: ${err.message}\n`);
  process.exit(1);
});
