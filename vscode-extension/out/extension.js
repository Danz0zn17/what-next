"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const api_1 = require("./api");
const statusBar_1 = require("./statusBar");
const contextPanel_1 = require("./contextPanel");
function activate(ctx) {
    const provider = new contextPanel_1.ContextCardViewProvider(ctx);
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('whatnext.projectView', provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    (0, statusBar_1.createStatusBar)(ctx);
    ctx.subscriptions.push(vscode.commands.registerCommand('whatnext.saveSession', async () => {
        const project = (0, contextPanel_1.detectProject)();
        if (!project) {
            vscode.window.showWarningMessage('What Next: no project folder open.');
            return;
        }
        const alive = await (0, api_1.isAlive)();
        if (!alive) {
            vscode.window.showErrorMessage('What Next local API is not running. Start it: launchctl start com.whatnextai.api');
            return;
        }
        const summary = await vscode.window.showInputBox({
            prompt: `Session summary for "${project}"`,
            placeHolder: 'What did you build or fix?',
            ignoreFocusOut: true,
        });
        if (!summary)
            return;
        const nextSteps = await vscode.window.showInputBox({
            prompt: 'Next steps (optional)',
            placeHolder: 'What needs to happen next?',
            ignoreFocusOut: true,
        });
        try {
            await (0, api_1.saveSession)({ project, summary, next_steps: nextSteps || undefined });
            (0, statusBar_1.markSaved)();
            provider.refresh();
            vscode.window.showInformationMessage(`What Next: session saved for "${project}".`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`What Next: save failed - ${msg}`);
        }
    }), vscode.commands.registerCommand('whatnext.getOrientation', async () => {
        const project = (0, contextPanel_1.detectProject)();
        if (!project) {
            vscode.window.showWarningMessage('What Next: no project folder open.');
            return;
        }
        provider.setProject(project);
        await vscode.commands.executeCommand('whatnext.projectView.focus');
        provider.refresh();
    }), vscode.commands.registerCommand('whatnext.openContextCard', async () => {
        const project = (0, contextPanel_1.detectProject)();
        if (!project)
            return;
        const { homedir } = await Promise.resolve().then(() => __importStar(require('os')));
        const path = `${homedir()}/.whatnext/agents/${project}.md`;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
            await vscode.window.showTextDocument(doc, { preview: true });
        }
        catch {
            vscode.window.showWarningMessage(`No context card found for "${project}". Save a session first.`);
        }
    }), vscode.commands.registerCommand('whatnext.whatsNext', async () => {
        const alive = await (0, api_1.isAlive)();
        if (!alive) {
            vscode.window.showErrorMessage('What Next local API is not running.');
            return;
        }
        try {
            const { items } = await (0, api_1.getWhatsNext)();
            if (!items.length) {
                vscode.window.showInformationMessage('What Next: no open tasks found.');
                return;
            }
            const picks = items.map(i => ({
                label: i.project_name,
                description: i.next_steps?.slice(0, 80),
            }));
            await vscode.window.showQuickPick(picks, { title: "What's Next - open tasks" });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`What Next: ${msg}`);
        }
    }), vscode.commands.registerCommand('whatnext.showStatus', async () => {
        const alive = await (0, api_1.isAlive)();
        const project = (0, contextPanel_1.detectProject)();
        vscode.window.showInformationMessage(`What Next: API ${alive ? 'online' : 'OFFLINE'} | Project: ${project || 'none detected'}`);
    }));
    // Auto-prompt on window close if enabled
    ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()));
    if (vscode.workspace.getConfiguration('whatnext').get('autoPromptOnClose', false)) {
        ctx.subscriptions.push(vscode.window.onDidCloseTerminal(async () => {
            const project = (0, contextPanel_1.detectProject)();
            if (!project)
                return;
            const choice = await vscode.window.showInformationMessage(`Save session to What Next for "${project}"?`, 'Save', 'Skip');
            if (choice === 'Save')
                vscode.commands.executeCommand('whatnext.saveSession');
        }));
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map