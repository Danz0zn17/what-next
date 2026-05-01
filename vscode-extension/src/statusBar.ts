import * as vscode from 'vscode';
import { isAlive } from './api';

let bar: vscode.StatusBarItem | undefined;
let lastSaveTime: Date | null = null;
let pollInterval: NodeJS.Timeout | undefined;

export function createStatusBar(ctx: vscode.ExtensionContext): vscode.StatusBarItem {
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = 'whatnext.saveSession';
  ctx.subscriptions.push(bar);
  update();
  pollInterval = setInterval(update, 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(pollInterval) });
  return bar;
}

export function markSaved(): void {
  lastSaveTime = new Date();
  update();
}

function timeSince(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

async function update(): Promise<void> {
  if (!bar) return;
  const enabled = vscode.workspace.getConfiguration('whatnext').get<boolean>('statusBarEnabled', true);
  if (!enabled) { bar.hide(); return; }

  const alive = await isAlive();
  if (!alive) {
    bar.text = '$(circle-slash) WN offline';
    bar.tooltip = 'What Next local API is not running. Start it with: launchctl start com.whatnextai.api';
    bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    bar.show();
    return;
  }

  bar.backgroundColor = undefined;
  if (lastSaveTime) {
    bar.text = `$(database) WN saved ${timeSince(lastSaveTime)}`;
    bar.tooltip = `What Next: session saved ${timeSince(lastSaveTime)}. Click to save again.`;
  } else {
    bar.text = '$(database) WN unsaved';
    bar.tooltip = 'What Next: no session saved yet. Click to save.';
  }
  bar.show();
}
