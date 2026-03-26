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

function cloudConfig() {
  const url = process.env.WHATNEXT_CLOUD_URL;
  const key = process.env.WHATNEXT_API_KEY;
  return { url, key, enabled: !!(url && key) };
}

async function fetchCloud(path, options = {}) {
  const { url, key } = cloudConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      throw new CloudUnavailableError(`Cloud server error: ${res.status}`);
    }

    const body = await res.json();
    if (!res.ok) {
      const err = new Error(body.error ?? `HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }

    return body;
  } catch (err) {
    if (err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.name === 'CloudUnavailableError') {
      throw new CloudUnavailableError(`Cloud unreachable: ${err.message}`);
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

export async function postSession(data) {
  return fetchCloud('/session', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function postFact(data) {
  return fetchCloud('/fact', {
    method: 'POST',
    body: JSON.stringify(data),
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
