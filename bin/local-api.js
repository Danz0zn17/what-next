#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.WHATNEXT_PORT || 3747);
const LOG_DIR = process.env.WHATNEXT_AUDIT_LOG_DIR
  || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Logs', 'what-next')
    : join(homedir(), '.what-next', 'logs'));
const API_LOG_FILE = join(LOG_DIR, 'api-audit.log');
const DB_PATHS = [
  join(ROOT, 'data', 'what-next.db'),
  join(ROOT, 'data', 'whatnext.db'),
  join(ROOT, 'data', 'memory.db'),
];
const DB_PATH = DB_PATHS.find(existsSync);

if (!DB_PATH) {
  throw new Error(`No What Next SQLite database found. Checked: ${DB_PATHS.join(', ')}`);
}

mkdirSync(LOG_DIR, { recursive: true });

function log(level, message) {
  const line = `[what-next api] ${new Date().toISOString()} [${level}] ${message}\n`;
  process.stderr.write(line);
  appendFileSync(API_LOG_FILE, line);
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 262144) {
        rejectBody(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error('Invalid JSON body'));
      }
    });
    req.on('error', rejectBody);
  });
}

function tokensToMatch(query) {
  return query
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `${token}*`)
    .join(' OR ');
}

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

function getOrCreateProjectId(name) {
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
  if (existing) return existing.id;
  const inserted = db.prepare(`
    INSERT INTO projects (name, created_at, updated_at)
    VALUES (?, datetime('now'), datetime('now'))
  `).run(name);
  return Number(inserted.lastInsertRowid);
}

function touchProject(projectId) {
  db.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).run(projectId);
}

const recentSessionsSql = `
  SELECT
    s.id,
    p.name AS project_name,
    s.summary,
    s.what_was_built,
    s.decisions,
    s.stack,
    s.next_steps,
    s.tags,
    s.session_date,
    s.created_at
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  ORDER BY s.session_date DESC
  LIMIT ?
`;

const factsSql = `
  SELECT
    f.id,
    p.name AS project_name,
    f.category,
    f.content,
    f.tags,
    f.created_at
  FROM facts f
  LEFT JOIN projects p ON p.id = f.project_id
  ORDER BY f.created_at DESC
  LIMIT ?
`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true, service: 'what-next-local', db_path: DB_PATH });
    }

    if (req.method === 'GET' && pathname === '/context') {
      const sessionLimit = Math.max(1, Math.min(50, Number(url.searchParams.get('sessions') || 10)));
      const factLimit = Math.max(1, Math.min(100, Number(url.searchParams.get('facts') || 25)));
      return json(res, 200, {
        sessions: db.prepare(recentSessionsSql).all(sessionLimit),
        facts: db.prepare(factsSql).all(factLimit),
        source: 'local',
      });
    }

    if (req.method === 'GET' && pathname === '/projects') {
      const projects = db.prepare(`
        SELECT
          p.name,
          p.description,
          p.created_at,
          p.updated_at,
          COUNT(s.id) AS session_count,
          MAX(s.session_date) AS last_session
        FROM projects p
        LEFT JOIN sessions s ON s.project_id = p.id
        GROUP BY p.id
        ORDER BY COALESCE(MAX(s.session_date), p.updated_at) DESC
      `).all();
      return json(res, 200, projects);
    }

    if (req.method === 'GET' && pathname.startsWith('/project/')) {
      const name = decodeURIComponent(pathname.slice('/project/'.length));
      const sessions = db.prepare(`
        SELECT
          s.id,
          p.name AS project_name,
          s.summary,
          s.what_was_built,
          s.decisions,
          s.stack,
          s.next_steps,
          s.tags,
          s.session_date,
          s.created_at
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE p.name = ?
        ORDER BY s.session_date DESC
      `).all(name);
      if (sessions.length === 0) return json(res, 404, { error: 'Project not found' });
      return json(res, 200, { name, sessions, source: 'local' });
    }

    if (req.method === 'GET' && pathname === '/whats-next') {
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 10)));
      const items = db.prepare(`
        SELECT
          p.name AS project_name,
          s.next_steps,
          s.session_date,
          s.created_at
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE s.next_steps IS NOT NULL AND TRIM(s.next_steps) <> ''
        ORDER BY s.session_date DESC
        LIMIT ?
      `).all(limit);
      return json(res, 200, items);
    }

    if (req.method === 'GET' && pathname === '/hybrid-search') {
      const query = (url.searchParams.get('q') || '').trim();
      const limit = Math.max(1, Math.min(25, Number(url.searchParams.get('limit') || 10)));
      if (!query) return json(res, 400, { error: 'Missing q query parameter' });

      const match = tokensToMatch(query);
      let sessionResults = [];
      let factResults = [];

      if (match) {
        try {
          sessionResults = db.prepare(`
            SELECT
              s.id,
              p.name AS project_name,
              s.summary,
              s.what_was_built,
              s.decisions,
              s.stack,
              s.next_steps,
              s.tags,
              s.session_date,
              s.created_at
            FROM sessions_fts
            JOIN sessions s ON s.id = sessions_fts.rowid
            JOIN projects p ON p.id = s.project_id
            WHERE sessions_fts MATCH ?
            ORDER BY bm25(sessions_fts)
            LIMIT ?
          `).all(match, limit);

          factResults = db.prepare(`
            SELECT
              f.id,
              p.name AS project_name,
              f.category,
              f.content,
              f.tags,
              f.created_at
            FROM facts_fts
            JOIN facts f ON f.id = facts_fts.rowid
            LEFT JOIN projects p ON p.id = f.project_id
            WHERE facts_fts MATCH ?
            ORDER BY bm25(facts_fts)
            LIMIT ?
          `).all(match, limit);
        } catch (error) {
          log('WARN', `FTS search failed for "${query}": ${error.message}`);
        }
      }

      if (sessionResults.length === 0) {
        sessionResults = db.prepare(`
          SELECT
            s.id,
            p.name AS project_name,
            s.summary,
            s.what_was_built,
            s.decisions,
            s.stack,
            s.next_steps,
            s.tags,
            s.session_date,
            s.created_at
          FROM sessions s
          JOIN projects p ON p.id = s.project_id
          WHERE
            s.summary LIKE ? OR
            COALESCE(s.what_was_built, '') LIKE ? OR
            COALESCE(s.decisions, '') LIKE ? OR
            COALESCE(s.stack, '') LIKE ? OR
            COALESCE(s.next_steps, '') LIKE ? OR
            COALESCE(s.tags, '') LIKE ?
          ORDER BY s.session_date DESC
          LIMIT ?
        `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit);
      }

      if (factResults.length === 0) {
        factResults = db.prepare(`
          SELECT
            f.id,
            p.name AS project_name,
            f.category,
            f.content,
            f.tags,
            f.created_at
          FROM facts f
          LEFT JOIN projects p ON p.id = f.project_id
          WHERE
            f.category LIKE ? OR
            f.content LIKE ? OR
            COALESCE(f.tags, '') LIKE ?
          ORDER BY f.created_at DESC
          LIMIT ?
        `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);
      }

      const results = [
        ...sessionResults,
        ...factResults.map((fact) => ({
          id: `fact-${fact.id}`,
          project_name: fact.project_name,
          summary: `${fact.category}: ${fact.content}`,
          what_was_built: null,
          decisions: null,
          stack: null,
          next_steps: null,
          tags: fact.tags,
          session_date: fact.created_at,
          created_at: fact.created_at,
          result_type: 'fact',
        })),
      ]
        .sort((a, b) => String(b.session_date || b.created_at).localeCompare(String(a.session_date || a.created_at)))
        .slice(0, limit);

      return json(res, 200, { results, source: 'local' });
    }

    if (req.method === 'GET' && pathname === '/sync/status') {
      const lastCloudSync = db.prepare(`SELECT value FROM sync_state WHERE key = 'last_cloud_sync'`).get()?.value ?? null;
      const pendingGists = db.prepare(`SELECT COUNT(*) AS count FROM pending_gists`).get().count;
      return json(res, 200, { last_cloud_sync: lastCloudSync, pending_gists: pendingGists, source: 'local' });
    }

    if (req.method === 'POST' && pathname === '/session') {
      const body = await readJsonBody(req);
      if (!body.project || !body.summary) return json(res, 400, { error: 'project and summary are required' });

      const tx = db.transaction((payload) => {
        const projectId = getOrCreateProjectId(payload.project);
        const result = db.prepare(`
          INSERT INTO sessions (
            project_id,
            summary,
            what_was_built,
            decisions,
            stack,
            next_steps,
            tags,
            session_date,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          projectId,
          payload.summary,
          payload.what_was_built ?? null,
          payload.decisions ?? null,
          payload.stack ?? null,
          payload.next_steps ?? null,
          payload.tags ?? null,
        );
        touchProject(projectId);
        return Number(result.lastInsertRowid);
      });

      const id = tx(body);
      log('INFO', `stored local session ${id} for project ${body.project}`);
      return json(res, 201, { ok: true, id, source: 'local' });
    }

    if (req.method === 'POST' && pathname === '/fact') {
      const body = await readJsonBody(req);
      if (!body.content) return json(res, 400, { error: 'content is required' });

      const tx = db.transaction((payload) => {
        const projectId = payload.project ? getOrCreateProjectId(payload.project) : null;
        const result = db.prepare(`
          INSERT INTO facts (
            project_id,
            category,
            content,
            tags,
            created_at
          ) VALUES (?, ?, ?, ?, datetime('now'))
        `).run(projectId, payload.category || 'general', payload.content, payload.tags ?? null);
        if (projectId) touchProject(projectId);
        return Number(result.lastInsertRowid);
      });

      const id = tx(body);
      log('INFO', `stored local fact ${id}`);
      return json(res, 201, { ok: true, id, source: 'local' });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    log('ERROR', error?.stack ?? error?.message ?? String(error));
    return json(res, 500, { error: 'Internal server error' });
  }
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    log('WARN', `port ${PORT} already in use; assuming another healthy local API instance is active`);
    process.exit(0);
  }
  log('ERROR', error?.stack ?? error?.message ?? String(error));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log('INFO', `local API listening on http://127.0.0.1:${PORT} using ${DB_PATH}`);
});
