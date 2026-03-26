/**
 * What Next Cloud — Postgres adapter
 * Uses the `pg` package. DATABASE_URL must be set.
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function getUserByKeyHash(hash) {
  const r = await query('SELECT * FROM users WHERE api_key_hash = $1', [hash]);
  return r.rows[0] ?? null;
}

export async function createUser(label, keyHash) {
  const r = await query(
    'INSERT INTO users (api_key_hash, label) VALUES ($1, $2) RETURNING *',
    [keyHash, label]
  );
  return r.rows[0];
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function upsertProject(userId, name) {
  const r = await query(
    `INSERT INTO projects (user_id, name)
     VALUES ($1, $2)
     ON CONFLICT (user_id, name) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [userId, name]
  );
  return r.rows[0];
}

export async function listProjectsForUser(userId) {
  const r = await query(
    `SELECT p.*, COUNT(s.id)::int AS session_count
     FROM projects p
     LEFT JOIN sessions s ON s.project_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id
     ORDER BY p.updated_at DESC`,
    [userId]
  );
  return r.rows;
}

export async function getProjectWithSessions(userId, name) {
  const pr = await query(
    'SELECT * FROM projects WHERE user_id = $1 AND name = $2',
    [userId, name]
  );
  if (!pr.rows[0]) return null;
  const project = pr.rows[0];
  const sr = await query(
    'SELECT * FROM sessions WHERE project_id = $1 ORDER BY session_date DESC',
    [project.id]
  );
  return { ...project, sessions: sr.rows };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function addSession(userId, data) {
  const project = await upsertProject(userId, data.project);
  const r = await query(
    `INSERT INTO sessions
       (project_id, summary, what_was_built, decisions, stack, next_steps, tags, session_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()))
     RETURNING *`,
    [
      project.id,
      data.summary,
      data.what_was_built ?? null,
      data.decisions ?? null,
      data.stack ?? null,
      data.next_steps ?? null,
      Array.isArray(data.tags) ? data.tags.join(',') : (data.tags ?? null),
      data.session_date ?? null,
    ]
  );
  return r.rows[0];
}

// ── Facts ─────────────────────────────────────────────────────────────────────

export async function addFact(userId, data) {
  let projectId = null;
  if (data.project) {
    const p = await upsertProject(userId, data.project);
    projectId = p.id;
  }
  const r = await query(
    `INSERT INTO facts (user_id, project_id, category, content, tags)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [
      userId,
      projectId,
      data.category,
      data.content,
      Array.isArray(data.tags) ? data.tags.join(',') : (data.tags ?? null),
    ]
  );
  return r.rows[0];
}

// ── Search ────────────────────────────────────────────────────────────────────
// Postgres full-text search across decrypted fields isn't viable with
// encrypted content — so we return recent sessions and let the caller
// do in-memory filtering after decryption. For now we do a simple ILIKE
// on the tags column (unencrypted) and return up to 20 recent sessions.

export async function searchSessions(userId, q, limit = 20) {
  const r = await query(
    `SELECT s.*, p.name AS project_name
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.user_id = $1
     ORDER BY s.session_date DESC
     LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

export async function searchFacts(userId, limit = 20) {
  const r = await query(
    `SELECT * FROM facts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}
