import * as vscode from 'vscode';

function baseUrl(): string {
  return vscode.workspace.getConfiguration('whatnext').get<string>('apiUrl', 'http://localhost:3747');
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) throw new Error(`What Next API error: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `What Next API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function isAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function getOrientation(project: string): Promise<{
  project: string;
  intelligence: Record<string, string> | null;
  recent_sessions: Array<{ summary: string; session_date: string; next_steps: string | null }>;
  next_steps: string | null;
  recent_commits: Array<{ message: string; committed_at: string }>;
}> {
  return get(`/orientation/${encodeURIComponent(project)}`);
}

export async function getContextCard(project: string): Promise<string | null> {
  try {
    const { homedir } = await import('os');
    const { readFileSync } = await import('fs');
    const path = `${homedir()}/.whatnext/agents/${project}.md`;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export async function saveSession(data: {
  project: string;
  summary: string;
  what_was_built?: string;
  decisions?: string;
  next_steps?: string;
  tags?: string;
}): Promise<{ id: number }> {
  return post('/session', data);
}

export async function getWhatsNext(): Promise<{
  items: Array<{ project_name: string; next_steps: string; session_date: string }>;
}> {
  return get('/whats-next');
}
