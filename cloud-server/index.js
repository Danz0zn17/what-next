/**
 * What Next Cloud Server
 * Deployed to Railway. Postgres-backed, multi-user, encrypted at rest.
 *
 * Endpoints:
 *   GET  /health                → liveness check
 *   POST /session               → dump a session (auth required)
 *   POST /fact                  → store a fact (auth required)
 *   GET  /search?q=...          → search memories (auth required)
 *   GET  /projects              → list projects (auth required)
 *   GET  /project/:name         → full project history (auth required)
 *   POST /admin/users           → create a user, get API key (admin secret required)
 */
import express from 'express';
import { requireApiKey, requireAdminSecret } from './auth.js';
import * as db from './db.js';
import { encryptFields, decryptFields, hashApiKey, SESSION_FIELDS, FACT_FIELDS } from './crypto.js';
import { randomBytes, createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3747;
const app = express();

// ── Security middleware ───────────────────────────────────────────────────────

// Body size limit — prevent large payload DoS
app.use(express.json({ limit: '64kb' }));

// Basic rate limiting — 120 requests per minute per IP
const rateBuckets = new Map();
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // skip health checks
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const now = Date.now();
  const bucket = rateBuckets.get(ip) ?? { count: 0, reset: now + 60_000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60_000; }
  bucket.count++;
  rateBuckets.set(ip, bucket);
  if (bucket.count > 120) return res.status(429).json({ error: 'Too many requests' });
  next();
});

// Disable fingerprinting
app.disable('x-powered-by');

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Schema init ───────────────────────────────────────────────────────────────

async function initSchema() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('Schema ready');
}

// ── Session dump ──────────────────────────────────────────────────────────────

app.post('/session', requireApiKey, async (req, res) => {
  try {
    const { project, summary, ...rest } = req.body;
    if (!project || !summary) {
      return res.status(400).json({ error: 'project and summary are required' });
    }
    const encrypted = encryptFields({ summary, ...rest }, SESSION_FIELDS, req.encKey);
    const row = await db.addSession(req.userId, { project, ...encrypted });
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('POST /session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Add fact ──────────────────────────────────────────────────────────────────

app.post('/fact', requireApiKey, async (req, res) => {
  try {
    const { category, content, ...rest } = req.body;
    if (!category || !content) {
      return res.status(400).json({ error: 'category and content are required' });
    }
    const encrypted = encryptFields({ content }, FACT_FIELDS, req.encKey);
    const row = await db.addFact(req.userId, { category, ...encrypted, ...rest });
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('POST /fact error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
// Since content is encrypted we fetch recent sessions + facts and filter
// in-process after decryption.

app.get('/search', requireApiKey, async (req, res) => {
  try {
    const q = (req.query.q ?? '').toLowerCase().trim();
    const [rawSessions, rawFacts] = await Promise.all([
      db.searchSessions(req.userId, q),
      db.searchFacts(req.userId),
    ]);

    const sessions = rawSessions
      .map(s => decryptFields(s, SESSION_FIELDS, req.encKey))
      .filter(s => !q || SESSION_FIELDS.some(f => s[f]?.toLowerCase().includes(q)));

    const facts = rawFacts
      .map(f => decryptFields(f, FACT_FIELDS, req.encKey))
      .filter(f => !q || f.content?.toLowerCase().includes(q) || f.category?.toLowerCase().includes(q));

    res.json({ sessions, facts });
  } catch (err) {
    console.error('GET /search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── List projects ─────────────────────────────────────────────────────────────

app.get('/projects', requireApiKey, async (req, res) => {
  try {
    const projects = await db.listProjectsForUser(req.userId);
    res.json(projects);
  } catch (err) {
    console.error('GET /projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Get project ───────────────────────────────────────────────────────────────

app.get('/project/:name', requireApiKey, async (req, res) => {
  try {
    const project = await db.getProjectWithSessions(req.userId, req.params.name);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    project.sessions = project.sessions.map(s =>
      decryptFields(s, SESSION_FIELDS, req.encKey)
    );
    res.json(project);
  } catch (err) {
    console.error('GET /project error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: create user ────────────────────────────────────────────────────────

app.post('/admin/users', requireAdminSecret, async (req, res) => {
  try {
    const label = req.body.label ?? 'unnamed';
    const rawKey = 'bak_' + randomBytes(32).toString('hex');
    const keyHash = hashApiKey(rawKey);
    const user = await db.createUser(label, keyHash);
    // Raw key shown once — never stored in plaintext
    res.json({ apiKey: rawKey, userId: user.id, label: user.label });
  } catch (err) {
    console.error('POST /admin/users error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`What Next cloud server on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to init schema:', err);
    process.exit(1);
  });
