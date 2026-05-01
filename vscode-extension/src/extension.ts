import * as vscode from 'vscode';
import { saveSession, getWhatsNext, isAlive } from './api';
import { createStatusBar, markSaved } from './statusBar';
import { ContextCardViewProvider, detectProject } from './contextPanel';

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new ContextCardViewProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('whatnext.projectView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  createStatusBar(ctx);

  ctx.subscriptions.push(

    vscode.commands.registerCommand('whatnext.saveSession', async () => {
      const project = detectProject();
      if (!project) {
        vscode.window.showWarningMessage('What Next: no project folder open.');
        return;
      }
      const alive = await isAlive();
      if (!alive) {
        vscode.window.showErrorMessage('What Next local API is not running. Start it: launchctl start com.whatnextai.api');
        return;
      }

      const summary = await vscode.window.showInputBox({
        prompt: `Session summary for "${project}"`,
        placeHolder: 'What did you build or fix?',
        ignoreFocusOut: true,
      });
      if (!summary) return;

      const nextSteps = await vscode.window.showInputBox({
        prompt: 'Next steps (optional)',
        placeHolder: 'What needs to happen next?',
        ignoreFocusOut: true,
      });

      try {
        await saveSession({ project, summary, next_steps: nextSteps || undefined });
        markSaved();
        provider.refresh();
        vscode.window.showInformationMessage(`What Next: session saved for "${project}".`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`What Next: save failed - ${msg}`);
      }
    }),

    vscode.commands.registerCommand('whatnext.getOrientation', async () => {
      const project = detectProject();
      if (!project) {
        vscode.window.showWarningMessage('What Next: no project folder open.');
        return;
      }
      provider.setProject(project);
      await vscode.commands.executeCommand('whatnext.projectView.focus');
      provider.refresh();
    }),

    vscode.commands.registerCommand('whatnext.openContextCard', async () => {
      const project = detectProject();
      if (!project) return;
      const { homedir } = await import('os');
      const path = `${homedir()}/.whatnext/agents/${project}.md`;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch {
        vscode.window.showWarningMessage(`No context card found for "${project}". Save a session first.`);
      }
    }),

    vscode.commands.registerCommand('whatnext.whatsNext', async () => {
      const alive = await isAlive();
      if (!alive) {
        vscode.window.showErrorMessage('What Next local API is not running.');
        return;
      }
      try {
        const { items } = await getWhatsNext();
        if (!items.length) {
          vscode.window.showInformationMessage('What Next: no open tasks found.');
          return;
        }
        const picks = items.map(i => ({
          label: i.project_name,
          description: i.next_steps?.slice(0, 80),
        }));
        await vscode.window.showQuickPick(picks, { title: "What's Next - open tasks" });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`What Next: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('whatnext.showStatus', async () => {
      const alive = await isAlive();
      const project = detectProject();
      vscode.window.showInformationMessage(
        `What Next: API ${alive ? 'online' : 'OFFLINE'} | Project: ${project || 'none detected'}`
      );
    }),

  );

  // Auto-prompt on window close if enabled
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );

  if (vscode.workspace.getConfiguration('whatnext').get<boolean>('autoPromptOnClose', false)) {
    ctx.subscriptions.push(
      vscode.window.onDidCloseTerminal(async () => {
        const project = detectProject();
        if (!project) return;
        const choice = await vscode.window.showInformationMessage(
          `Save session to What Next for "${project}"?`,
          'Save', 'Skip'
        );
        if (choice === 'Save') vscode.commands.executeCommand('whatnext.saveSession');
      })
    );
  }
}

export function deactivate(): void {}
