import * as vscode from 'vscode';
import { getOrientation, getContextCard } from './api';

function markdownToHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul])/gm, '')
    .replace(/\n/g, '<br>');
}

export function getWebviewContent(
  project: string,
  orientation: Awaited<ReturnType<typeof getOrientation>> | null,
  card: string | null,
  error: string | null
): string {
  const intel = orientation?.intelligence;
  const sessions = orientation?.recent_sessions ?? [];
  const tasks = orientation?.next_steps ?? '';
  const commits = orientation?.recent_commits ?? [];

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtDate(d: string): string {
    const date = new Date(d);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const stackPills = intel?.stack
    ? intel.stack.split(',').map((s: string) =>
        `<span class="pill">${esc(s.trim())}</span>`
      ).join('')
    : '';

  const sessionRows = sessions.slice(0, 3).map(s => `
    <div class="session-row">
      <span class="session-dot"></span>
      <div class="session-body">
        <div class="session-date">${fmtDate(s.session_date)}</div>
        <div class="session-text">${esc((s.summary ?? '').slice(0, 110))}${(s.summary?.length ?? 0) > 110 ? '…' : ''}</div>
      </div>
    </div>`).join('');

  const commitRows = commits.slice(0, 5).map(c => {
    const msg = esc((c.message ?? '').slice(0, 68));
    const hash = c.hash ? `<span class="commit-hash">${esc(c.hash.slice(0, 7))}</span>` : '';
    return `<div class="commit-row">${hash}<span class="commit-msg">${msg}</span></div>`;
  }).join('');

  const taskLines = tasks
    ? tasks.split('\n').filter(Boolean).map(t =>
        `<div class="task-row"><span class="task-bullet">·</span><span>${esc(t.replace(/^[-*]\s*/, ''))}</span></div>`
      ).join('')
    : '';

  const offlineHtml = error ? `
    <div class="offline-card">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="var(--red)" stroke-width="1.2"/><path d="M8 5v3.5M8 10.5v.5" stroke="var(--red)" stroke-width="1.3" stroke-linecap="round"/></svg>
      <div>
        <div class="offline-title">API offline</div>
        <div class="offline-cmd">launchctl start com.whatnextai.api</div>
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --accent:   #6366f1;
    --accent-l: #818cf8;
    --green:    #22c55e;
    --red:      #ef4444;
    --amber:    #f59e0b;
    --r:        5px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    padding: 0 0 24px;
    line-height: 1.5;
  }

  /* HEADER */
  .header {
    display: flex; align-items: center; gap: 9px;
    padding: 14px 14px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 4px;
  }
  .logo-ring {
    width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
    border: 1.5px solid var(--accent);
    display: flex; align-items: center; justify-content: center;
  }
  .logo-ring::after {
    content: ''; width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent);
  }
  .header-text { flex: 1; min-width: 0; }
  .project-name {
    font-size: 13px; font-weight: 600; color: var(--vscode-foreground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .project-sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
  .online-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--green); flex-shrink: 0;
    box-shadow: 0 0 6px rgba(34,197,94,0.5);
  }

  /* SECTION */
  .section { padding: 10px 14px 0; }
  .section-label {
    font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--vscode-descriptionForeground);
    margin-bottom: 7px;
  }

  /* PILLS */
  .pills { display: flex; flex-wrap: wrap; gap: 4px; }
  .pill {
    font-size: 11px; font-weight: 500;
    background: rgba(99,102,241,0.12); color: var(--accent-l);
    border: 1px solid rgba(99,102,241,0.22);
    border-radius: 99px; padding: 2px 8px;
  }

  /* SESSIONS */
  .session-row {
    display: flex; align-items: flex-start; gap: 9px;
    padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .session-row:last-child { border-bottom: none; }
  .session-dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
    flex-shrink: 0; margin-top: 5px; opacity: 0.7;
  }
  .session-body { flex: 1; min-width: 0; }
  .session-date { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .session-text { font-size: 11.5px; line-height: 1.45; color: var(--vscode-foreground); opacity: 0.85; }

  /* COMMITS */
  .commit-row {
    display: flex; align-items: baseline; gap: 7px;
    padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border);
    font-family: var(--vscode-editor-font-family);
  }
  .commit-row:last-child { border-bottom: none; }
  .commit-hash {
    font-size: 10px; color: var(--accent-l); flex-shrink: 0;
    background: rgba(99,102,241,0.1); border-radius: 3px; padding: 1px 4px;
  }
  .commit-msg { font-size: 11px; color: var(--vscode-foreground); opacity: 0.8; word-break: break-all; }

  /* TASKS */
  .task-row {
    display: flex; gap: 7px; align-items: flex-start;
    padding: 3px 0; font-size: 11.5px; line-height: 1.5;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .task-row:last-child { border-bottom: none; }
  .task-bullet { color: var(--accent-l); flex-shrink: 0; font-size: 13px; line-height: 1.3; }

  /* CONTEXT CARD */
  .card {
    font-family: var(--vscode-editor-font-family);
    font-size: 10.5px; line-height: 1.7;
    color: var(--vscode-foreground); opacity: 0.75;
    white-space: pre-wrap; word-break: break-word;
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--r); padding: 10px;
    max-height: 180px; overflow-y: auto;
  }

  /* OFFLINE */
  .offline-card {
    display: flex; align-items: flex-start; gap: 10px;
    margin: 12px 14px 4px;
    background: rgba(239,68,68,0.07);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: var(--r); padding: 10px 12px;
  }
  .offline-title { font-size: 12px; font-weight: 600; color: var(--red); margin-bottom: 3px; }
  .offline-cmd {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px; color: var(--vscode-descriptionForeground);
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 2px 6px; display: inline-block; margin-top: 2px;
  }

  /* NO PROJECT */
  .no-project {
    padding: 32px 14px; text-align: center;
    color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.6;
  }
  .no-project strong { display: block; margin-bottom: 6px; font-size: 13px; color: var(--vscode-foreground); }

  /* ACTIONS */
  .actions { padding: 12px 14px 0; display: flex; gap: 8px; }
  .btn {
    flex: 1; padding: 6px 10px; font-size: 11.5px; font-weight: 500;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: var(--r); cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn-ghost {
    flex: 1; padding: 6px 10px; font-size: 11.5px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--r); cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent-l); }

  .divider { height: 1px; background: var(--vscode-panel-border); margin: 10px 0 0; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 11px; opacity: 0.6; }
</style>
</head>
<body>

${!project ? `<div class="no-project"><strong>No project open</strong>Open a folder to see context.</div>` : `

<div class="header">
  <div class="logo-ring"></div>
  <div class="header-text">
    <div class="project-name">${esc(project)}</div>
    <div class="project-sub">What Next</div>
  </div>
  ${!error ? '<div class="online-dot"></div>' : ''}
</div>

${offlineHtml}

${stackPills ? `
<div class="section">
  <div class="section-label">Stack</div>
  <div class="pills">${stackPills}</div>
</div>
<div class="divider"></div>` : ''}

${intel?.conventions ? `
<div class="section" style="padding-top:10px">
  <div class="section-label">Conventions</div>
  <div style="font-size:11.5px;line-height:1.6;opacity:0.8">${esc(intel.conventions)}</div>
</div>
<div class="divider"></div>` : ''}

${taskLines ? `
<div class="section" style="padding-top:10px">
  <div class="section-label">Open tasks</div>
  ${taskLines}
</div>
<div class="divider"></div>` : ''}

${sessionRows ? `
<div class="section" style="padding-top:10px">
  <div class="section-label">Recent sessions</div>
  ${sessionRows}
</div>
<div class="divider"></div>` : ''}

${commitRows ? `
<div class="section" style="padding-top:10px">
  <div class="section-label">Recent commits</div>
  ${commitRows}
</div>
<div class="divider"></div>` : ''}

${card ? `
<div class="section" style="padding-top:10px">
  <div class="section-label">Context card</div>
  <div class="card">${esc(card)}</div>
</div>` : ''}

${!stackPills && !taskLines && !sessionRows && !commitRows && !card && !error ? `
<div class="section" style="padding-top:16px">
  <div class="empty">No context saved yet. Save a session to get started.</div>
</div>` : ''}

<div class="actions">
  <button class="btn" onclick="save()">Save session</button>
  <button class="btn-ghost" onclick="refresh()">Refresh</button>
</div>

`}

<script>
  const vscode = acquireVsCodeApi();
  function save() { vscode.postMessage({ command: 'save' }); }
  function refresh() { vscode.postMessage({ command: 'refresh' }); }
</script>
</body>
</html>`;
}

export class ContextCardViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _project = '';

  constructor(private readonly _ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'save') vscode.commands.executeCommand('whatnext.saveSession');
      if (msg.command === 'refresh') this.refresh();
    }, undefined, this._ctx.subscriptions);
    this.refresh();
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh(), undefined, this._ctx.subscriptions);
  }

  setProject(name: string): void {
    this._project = name;
    this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this._view) return;
    const project = this._project || detectProject();
    if (!project) {
      this._view.webview.html = getWebviewContent('', null, null, 'Open a project folder to see context.');
      return;
    }
    try {
      const [orientation, card] = await Promise.all([
        getOrientation(project).catch(() => null),
        getContextCard(project).catch(() => null),
      ]);
      this._view.webview.html = getWebviewContent(project, orientation, card, null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this._view.webview.html = getWebviewContent(project, null, null, `Cannot reach What Next API: ${msg}`);
    }
  }
}

export function detectProject(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return '';
  const name = folders[0].uri.path.split('/').pop() ?? '';
  return name;
}
