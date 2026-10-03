/**
 * What Next — Cloud API client
 *
 * Routes calls to the cloud server. If the cloud is unreachable (network error
 * or 5xx), throws CloudUnavailableError so callers can fall back to local SQLite.
 * 4xx errors (bad input) are rethrown as-is — don't fall back for those.
 *
 * Config via env vars:
 *   WHATNEXT_CLOUD_URL  — e.g. https://your-app.up.railway.app
 *   WHATNEXT_API_KEY    — bak_xxxxxxx
 */

export class CloudUnavailableError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'CloudUnavailableError';
  }
}

const TIMEOUT_MS = 8_000;
const FULL_EXPORT_TIMEOUT_MS = 60_000;

function cloudConfig() {
  const url = process.env.WHATNEXT_CLOUD_URL;
  const key = process.env.WHATNEXT_API_KEY;
  return { url, key, enabled: !!(url && key) };
}

// Node's fetch (undici) reports network failures as TypeError('fetch failed')
// with the real code on err.cause, and a body cut off mid-read as
// TypeError('terminated'). Timeouts surface as AbortError or TimeoutError.
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED',
]);

export function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const codes = [err.code, err.cause?.code];
  if (codes.some(c => typeof c === 'string' && (NETWORK_CODES.has(c) || c.startsWith('UND_ERR_')))) return true;
  if (err.cause?.name === 'AbortError' || err.cause?.name === 'TimeoutError') return true;
  return err instanceof TypeError && (err.message === 'fetch failed' || err.message === 'terminated');
}

async function fetchCloud(path, { timeoutMs = TIMEOUT_MS, ...options } = {}) {
  const { url, key } = cloudConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': key,
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    });

    if (res.status >= 500) {
      throw Object.assign(new CloudUnavailableError(`Cloud server error: ${res.status}`), { statusCode: res.status });
    }

    if (!res.ok) {
      // A 4xx from a proxy in front of the cloud may not be JSON; keep the status.
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error ?? `HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    const body = await res.json();

    return body;
  } catch (err) {
    if (err instanceof CloudUnavailableError) throw err;
    if (isNetworkError(err)) {
      throw new CloudUnavailableError(`Cloud unreachable: ${err.cause?.code ?? err.code ?? err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function isEnabled() {
  return cloudConfig().enabled;
}

export async function isReachable() {
  if (!isEnabled()) return false;
  try {
    const { url } = cloudConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${url}/health`, { signal: controller.signal }).finally(() => clearTimeout(timer));
    return res.ok;
  } catch {
    return false;
  }
}

// The cloud's per-field caps (SESSION_CAPS / FACT_CAPS in cloud-server.js).
// The server truncates to these anyway; trimming before sending keeps an
// oversized local row under the request body limit so it still syncs.
export const SESSION_CAPS = { project: 100, summary: 4000, what_was_built: 8000, decisions: 4000, stack: 1000, next_steps: 4000, tags: 500 };
export const FACT_CAPS = { project: 100, category: 200, content: 4000, tags: 500 };

export function trimToCaps(data, caps) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  for (const [field, max] of Object.entries(caps)) {
    if (typeof out[field] === 'string' && out[field].length > max) out[field] = out[field].slice(0, max);
  }
  return out;
}

export async function postSession(data) {
  return fetchCloud('/session', {
    method: 'POST',
    body: JSON.stringify(trimToCaps(data, SESSION_CAPS)),
  });
}

export async function postFact(data) {
  return fetchCloud('/fact', {
    method: 'POST',
    body: JSON.stringify(trimToCaps(data, FACT_CAPS)),
  });
}

export async function search(q) {
  return fetchCloud(`/search?q=${encodeURIComponent(q)}`);
}

export async function listProjects() {
  return fetchCloud('/projects');
}

export async function getProject(name) {
  return fetchCloud(`/project/${encodeURIComponent(name)}`);
}

export async function postFeedback(data) {
  return fetchCloud('/feedback', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getContext() {
  return fetchCloud('/context');
}

export async function semanticSearch(q, limit = 5) {
  return fetchCloud(`/semantic-search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export async function exportSince(since) {
  const param = since ? `?since=${encodeURIComponent(since)}` : '';
  // A full export (no cursor) can be large; give it longer than a normal call.
  return fetchCloud(`/export${param}`, since ? {} : { timeoutMs: FULL_EXPORT_TIMEOUT_MS });
}

export async function editSession(id, updates) {
  return fetchCloud(`/session/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(trimToCaps(updates, SESSION_CAPS)),
  });
}

export async function whatsNext(limit = 8) {
  return fetchCloud(`/whats-next?limit=${limit}`);
}

export async function postIntelligence(data) {
  return fetchCloud('/intelligence', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getIntelligence(projectName) {
  return fetchCloud(`/intelligence/${encodeURIComponent(projectName)}`);
}
