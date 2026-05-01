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
exports.createStatusBar = createStatusBar;
exports.markSaved = markSaved;
const vscode = __importStar(require("vscode"));
const api_1 = require("./api");
let bar;
let lastSaveTime = null;
let pollInterval;
function createStatusBar(ctx) {
    bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    bar.command = 'whatnext.saveSession';
    ctx.subscriptions.push(bar);
    update();
    pollInterval = setInterval(update, 60000);
    ctx.subscriptions.push({ dispose: () => clearInterval(pollInterval) });
    return bar;
}
function markSaved() {
    lastSaveTime = new Date();
    update();
}
function timeSince(d) {
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
}
async function update() {
    if (!bar)
        return;
    const enabled = vscode.workspace.getConfiguration('whatnext').get('statusBarEnabled', true);
    if (!enabled) {
        bar.hide();
        return;
    }
    const alive = await (0, api_1.isAlive)();
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
    }
    else {
        bar.text = '$(database) WN unsaved';
        bar.tooltip = 'What Next: no session saved yet. Click to save.';
    }
    bar.show();
}
//# sourceMappingURL=statusBar.js.map