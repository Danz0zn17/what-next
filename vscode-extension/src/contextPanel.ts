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

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 16px; margin: 0; }
  h2 { font-size: 13px; font-weight: 600; margin: 16px 0 6px; color: var(--vscode-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .project-name { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: var(--vscode-foreground); }
  .pill { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; padding: 1px 7px; font-size: 11px; margin: 2px 2px 2px 0; }
  .session { border-left: 2px solid var(--vscode-panel-border); padding-left: 10px; margin: 6px 0; }
  .session-date { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .session-summary { font-size: 12px; margin-top: 2px; }
  .commit { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 0; font-family: var(--vscode-editor-font-family); }
  .task { font-size: 12px; line-height: 1.6; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .error { color: var(--vscode-errorForeground); font-size: 12px; }
  .card { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); white-space: pre-wrap; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px; margin-top: 6px; max-height: 200px; overflow-y: auto; }
  .btn { display: inline-block; margin-top: 10px; padding: 5px 12px; font-size: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 11px; font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
${error ? `<div class="error">${error}</div>` : ''}
<div class="project-name">${project || 'No project detected'}</div>

${intel ? `
<h2>Stack</h2>
<div>${intel.stack ? intel.stack.split(',').map((s: string) => `<span class="pill">${s.trim()}</span>`).join('') : '<span class="empty">Not saved yet</span>'}</div>
${intel.key_dirs ? `<h2>Key Dirs</h2><div class="task">${intel.key_dirs}</div>` : ''}
${intel.conventions ? `<h2>Conventions</h2><div class="task">${intel.conventions}</div>` : ''}
` : ''}

${tasks ? `<h2>Open Tasks</h2><div class="task">${tasks.replace(/\n/g, '<br>')}</div>` : ''}

${sessions.length ? `
<h2>Recent Sessions</h2>
${sessions.slice(0, 3).map(s => `
  <div class="session">
    <div class="session-date">${new Date(s.session_date).toLocaleDateString()}</div>
    <div class="session-summary">${s.summary?.slice(0, 120) ?? ''}${(s.summary?.length ?? 0) > 120 ? '...' : ''}</div>
  </div>
`).join('')}` : ''}

${commits.length ? `
<h2>Recent Commits</h2>
${commits.slice(0, 5).map(c => `<div class="commit">· ${c.message?.slice(0, 72) ?? ''}</div>`).join('')}` : ''}

${card ? `<h2>Context Card</h2><div class="card">${card.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}

<button class="btn" onclick="save()">Save session</button>

<script>
  const vscode = acquireVsCodeApi();
  function save() { vscode.postMessage({ command: 'save' }); }
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
