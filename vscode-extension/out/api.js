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
exports.isAlive = isAlive;
exports.getOrientation = getOrientation;
exports.getContextCard = getContextCard;
exports.saveSession = saveSession;
exports.getWhatsNext = getWhatsNext;
const vscode = __importStar(require("vscode"));
function baseUrl() {
    return vscode.workspace.getConfiguration('whatnext').get('apiUrl', 'http://localhost:3747');
}
async function get(path) {
    const res = await fetch(`${baseUrl()}${path}`);
    if (!res.ok)
        throw new Error(`What Next API error: ${res.status}`);
    return res.json();
}
async function post(path, body) {
    const res = await fetch(`${baseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `What Next API error: ${res.status}`);
    }
    return res.json();
}
async function isAlive() {
    try {
        const r = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
    }
    catch {
        return false;
    }
}
async function getOrientation(project) {
    return get(`/orientation/${encodeURIComponent(project)}`);
}
async function getContextCard(project) {
    try {
        const { homedir } = await Promise.resolve().then(() => __importStar(require('os')));
        const { readFileSync } = await Promise.resolve().then(() => __importStar(require('fs')));
        const path = `${homedir()}/.whatnext/agents/${project}.md`;
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
async function saveSession(data) {
    return post('/session', data);
}
async function getWhatsNext() {
    return get('/whats-next');
}
//# sourceMappingURL=api.js.map