import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'what-next.db');

mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    summary     TEXT NOT NULL,
    what_was_built TEXT,
    decisions   TEXT,
    stack       TEXT,
    next_steps  TEXT,
    tags        TEXT,
    session_date TEXT NOT NULL DEFAULT (datetime('now')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS facts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER REFERENCES projects(id),
    category    TEXT NOT NULL,
    content     TEXT NOT NULL,
    tags        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    summary, what_was_built, decisions, stack, next_steps, tags,
    content='sessions', content_rowid='id'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    category, content, tags,
    content='facts', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, summary, what_was_built, decisions, stack, next_steps, tags)
    VALUES (new.id, new.summary, new.what_was_built, new.decisions, new.stack, new.next_steps, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, category, content, tags)
    VALUES (new.id, new.category, new.content, new.tags);
  END;

  CREATE TABLE IF NOT EXISTS embeddings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rowtype    TEXT NOT NULL,
    row_id     INTEGER NOT NULL,
    embedding  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(rowtype, row_id)
  );

  CREATE TABLE IF NOT EXISTS pending_gists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    gist_id    TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migrations: add cloud_id to sessions + facts for sync dedup (safe to run on existing DBs)
try { db.exec('ALTER TABLE sessions ADD COLUMN cloud_id TEXT'); } catch {}
try { db.exec('ALTER TABLE facts    ADD COLUMN cloud_id TEXT'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_cloud_id ON sessions(cloud_id) WHERE cloud_id IS NOT NULL'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_cloud_id    ON facts(cloud_id)    WHERE cloud_id IS NOT NULL'); } catch {}

// --- Project helpers ---
export function upsertProject(name, description = null) {
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
  if (existing) {
    db.prepare(`UPDATE projects SET updated_at = datetime('now'), description = COALESCE(?, description) WHERE id = ?`)
      .run(description, existing.id);
    return existing.id;
  }
  const result = db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(name, description);
  return result.lastInsertRowid;
}

export function getProject(name) {
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  if (!project) return null;
  const sessions = db.prepare(
    'SELECT * FROM sessions WHERE project_id = ? ORDER BY session_date DESC'
  ).all(project.id);
  return { ...project, sessions };
}

export function listProjects() {
  return db.prepare(`
    SELECT p.*, COUNT(s.id) as session_count, MAX(s.session_date) as last_session
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id
    GROUP BY p.id
    ORDER BY last_session DESC NULLS LAST
  `).all();
}

// --- Session helpers ---
export function addSession({ project, summary, what_was_built, decisions, stack, next_steps, tags }) {
  const projectId = upsertProject(project);
  const result = db.prepare(`
    INSERT INTO sessions (project_id, summary, what_was_built, decisions, stack, next_steps, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, summary, what_was_built ?? null, decisions ?? null, stack ?? null, next_steps ?? null, tags ?? null);
  return result.lastInsertRowid;
}

// --- Fact helpers ---
export function addFact({ project, category, content, tags }) {
  const projectId = project ? upsertProject(project) : null;
  const result = db.prepare(`
    INSERT INTO facts (project_id, category, content, tags) VALUES (?, ?, ?, ?)
  `).run(projectId, category, content, tags ?? null);
  return result.lastInsertRowid;
}

// --- Search ---
export function getRecentSessions(limit = 5) {
  return db.prepare(`
    SELECT s.*, p.name as project_name
    FROM sessions s
    JOIN projects p ON p.id = s.project_id
    ORDER BY s.session_date DESC
    LIMIT ?
  `).all(limit);
}

export function getAllFacts() {
  return db.prepare(`
    SELECT f.*, p.name as project_name
    FROM facts f
    LEFT JOIN projects p ON p.id = f.project_id
    ORDER BY f.created_at DESC
  `).all();
}

export function searchMemories(query, limit = 10) {
  const sessionResults = db.prepare(`
    SELECT s.*, p.name as project_name,
           highlight(sessions_fts, 0, '[', ']') as matched_summary
    FROM sessions_fts
    JOIN sessions s ON s.id = sessions_fts.rowid
    JOIN projects p ON p.id = s.project_id
    WHERE sessions_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit);

  const factResults = db.prepare(`
    SELECT f.*, p.name as project_name
    FROM facts_fts
    JOIN facts f ON f.id = facts_fts.rowid
    LEFT JOIN projects p ON p.id = f.project_id
    WHERE facts_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit);

  return { sessions: sessionResults, facts: factResults };
}

// --- Embedding helpers ---
export function storeEmbedding(rowtype, row_id, embedding) {
  db.prepare(`
    INSERT OR REPLACE INTO embeddings (rowtype, row_id, embedding)
    VALUES (?, ?, ?)
  `).run(rowtype, row_id, JSON.stringify(embedding));
}

export function getAllEmbeddings() {
  return db.prepare('SELECT rowtype, row_id, embedding FROM embeddings').all()
    .map(r => ({ ...r, embedding: JSON.parse(r.embedding) }));
}

export function getSessionById(id) {
  const s = db.prepare('SELECT s.*, p.name as project_name FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(id);
  return s;
}

export function getFactById(id) {
  const f = db.prepare('SELECT f.*, p.name as project_name FROM facts f LEFT JOIN projects p ON p.id = f.project_id WHERE f.id = ?').get(id);
  return f;
}

// --- Pending gist helpers ---
export function storePendingGist(gistId, payload) {
  db.prepare('INSERT INTO pending_gists (gist_id, payload) VALUES (?, ?)').run(gistId, payload);
}

export function getPendingGists() {
  return db.prepare('SELECT * FROM pending_gists ORDER BY created_at ASC').all();
}

export function deletePendingGist(id) {
  db.prepare('DELETE FROM pending_gists WHERE id = ?').run(id);
}

// --- Sync state helpers ---
export function getLastCloudSync() {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get('last_cloud_sync');
  return row?.value ?? null;
}

export function setLastCloudSync(iso) {
  db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run('last_cloud_sync', iso);
}

// --- Cloud sync upserts (idempotent — skips if cloud_id already exists locally) ---
export function upsertSessionFromCloud({ cloud_id, project_name, summary, what_was_built, decisions, stack, next_steps, tags, session_date }) {
  if (!project_name || !summary) return null;
  if (cloud_id) {
    const exists = db.prepare('SELECT id FROM sessions WHERE cloud_id = ?').get(String(cloud_id));
    if (exists) return null;
  }
  const projectId = upsertProject(project_name);
  const result = db.prepare(`
    INSERT INTO sessions (project_id, summary, what_was_built, decisions, stack, next_steps, tags, session_date, cloud_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, summary, what_was_built ?? null, decisions ?? null, stack ?? null, next_steps ?? null, tags ?? null, session_date ?? new Date().toISOString(), cloud_id ? String(cloud_id) : null);
  return result.lastInsertRowid;
}

export function upsertFactFromCloud({ cloud_id, project_name, category, content, tags, created_at }) {
  if (!category || !content) return null;
  if (cloud_id) {
    const exists = db.prepare('SELECT id FROM facts WHERE cloud_id = ?').get(String(cloud_id));
    if (exists) return null;
  }
  const projectId = project_name ? upsertProject(project_name) : null;
  const result = db.prepare(`
    INSERT INTO facts (project_id, category, content, tags, created_at, cloud_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, category, content, tags ?? null, created_at ?? new Date().toISOString(), cloud_id ? String(cloud_id) : null);
  return result.lastInsertRowid;
}

export default db;
