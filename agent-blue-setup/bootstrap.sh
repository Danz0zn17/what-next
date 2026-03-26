#!/bin/bash
# ================================================================
#  AGENT BLUE — Personal MCP Knowledge Server
#  Bootstrap Script v1.0
#
#  Installs a local MCP server that gives AI coding tools
#  (Claude Code, GitHub Copilot) persistent memory of your
#  projects, decisions, and patterns — across every session.
#
#  Usage:
#    bash bootstrap.sh
#
#  Safe to share. Contains no personal data, API keys, or
#  organisation-specific configuration.
# ================================================================

set -e

# ── Colours ──────────────────────────────────────────────────────
BLUE='\033[0;34m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'
YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

header()  { echo -e "\n${BLUE}${BOLD}$1${NC}"; }
info()    { echo -e "  ${CYAN}→${NC} $1"; }
success() { echo -e "  ${GREEN}✓${NC} $1"; }
warn()    { echo -e "  ${YELLOW}!${NC} $1"; }
error()   { echo -e "  ${RED}✗${NC} $1"; }
ask()     { echo -e "\n  ${BOLD}$1${NC}"; }

# ── Banner ────────────────────────────────────────────────────────
clear
echo -e "${BLUE}"
echo "  ╔═══════════════════════════════════════╗"
echo "  ║         🔵  AGENT BLUE  🔵            ║"
echo "  ║    Personal MCP Knowledge Server      ║"
echo "  ╚═══════════════════════════════════════╝"
echo -e "${NC}"
echo "  Gives your AI coding tools persistent memory."
echo "  Works with Claude Code and GitHub Copilot."
echo ""

# ── Check Node.js ─────────────────────────────────────────────────
header "Checking prerequisites..."
NODE=$(which node 2>/dev/null || true)
if [ -z "$NODE" ]; then
  error "Node.js not found."
  echo ""
  echo "  Please install Node.js first:"
  echo "  → https://nodejs.org (download the LTS version)"
  echo ""
  echo "  After installing, re-run this script."
  exit 1
fi
NODE_VER=$($NODE --version)
success "Node.js $NODE_VER found at $NODE"

NPM=$(which npm 2>/dev/null || true)
if [ -z "$NPM" ]; then
  error "npm not found. Please reinstall Node.js."
  exit 1
fi
success "npm found"

# ── Interactive Setup Questions ───────────────────────────────────
header "Let's set up your agent..."

# Agent name
ask "What would you like to call your agent? (default: agent-blue)"
read -r INPUT_NAME
AGENT_NAME="${INPUT_NAME:-agent-blue}"
AGENT_NAME=$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g' | sed 's/[^a-z0-9-]//g')
info "Agent name: $AGENT_NAME"

# Projects directory
DEFAULT_PROJECTS="$HOME/Documents/projects"
ask "Where do you store your projects? (default: $DEFAULT_PROJECTS)"
read -r INPUT_PROJECTS
PROJECTS_DIR="${INPUT_PROJECTS:-$DEFAULT_PROJECTS}"
PROJECTS_DIR="${PROJECTS_DIR%/}"  # remove trailing slash
if [ ! -d "$PROJECTS_DIR" ]; then
  warn "Directory does not exist. Creating it..."
  mkdir -p "$PROJECTS_DIR"
fi
PROJECTS_DIR=$(cd "$PROJECTS_DIR" && pwd)  # resolve to absolute path
info "Projects directory: $PROJECTS_DIR"

# Port
ask "Which port should the web UI run on? (default: 3748)"
read -r INPUT_PORT
AGENT_PORT="${INPUT_PORT:-3748}"
# Check if port is in use
if lsof -i ":$AGENT_PORT" > /dev/null 2>&1; then
  warn "Port $AGENT_PORT is already in use."
  ask "Choose a different port:"
  read -r AGENT_PORT
fi
info "Port: $AGENT_PORT"

# Installation directory
AGENT_DIR="$PROJECTS_DIR/$AGENT_NAME"
ask "Install agent to: $AGENT_DIR — OK? (Y/n)"
read -r CONFIRM
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
  ask "Enter full install path:"
  read -r AGENT_DIR
  mkdir -p "$AGENT_DIR"
fi

# ── Tool Personalization ──────────────────────────────────────────
header "Personalising your agent..."
echo "  Which AI coding tools do you use? (select all that apply)"
echo ""
echo "  [1] Claude Code (VS Code extension)"
echo "  [2] GitHub Copilot (VS Code)"
echo "  [3] Claude Desktop app"
echo "  [4] ChatGPT"
echo "  [5] Cursor"
echo "  [6] Windsurf"
echo "  [7] JetBrains AI (IntelliJ, WebStorm, etc.)"
echo ""
ask "Enter numbers separated by spaces (e.g. 1 2 4):"
read -r TOOL_INPUT

USE_CLAUDE_CODE=false; USE_COPILOT=false; USE_CLAUDE_DESKTOP=false
USE_CHATGPT=false; USE_CURSOR=false; USE_WINDSURF=false; USE_JETBRAINS=false

for t in $TOOL_INPUT; do
  case $t in
    1) USE_CLAUDE_CODE=true ;;
    2) USE_COPILOT=true ;;
    3) USE_CLAUDE_DESKTOP=true ;;
    4) USE_CHATGPT=true ;;
    5) USE_CURSOR=true ;;
    6) USE_WINDSURF=true ;;
    7) USE_JETBRAINS=true ;;
  esac
done

# Default to Claude Code + Copilot if nothing selected
if ! $USE_CLAUDE_CODE && ! $USE_COPILOT && ! $USE_CURSOR && ! $USE_WINDSURF; then
  warn "No tools selected — defaulting to Claude Code + GitHub Copilot."
  USE_CLAUDE_CODE=true; USE_COPILOT=true
fi

echo ""
echo "  What is your primary programming language or domain?"
echo ""
echo "  [1] JavaScript / TypeScript (web, Node.js)"
echo "  [2] Python (backend, automation, data)"
echo "  [3] Full-stack web (frontend + backend)"
echo "  [4] Mobile (React Native, Flutter, Swift, Kotlin)"
echo "  [5] DevOps / Infrastructure (Docker, Kubernetes, CI/CD)"
echo "  [6] Data Science / ML / AI"
echo "  [7] Other / Mixed"
echo ""
ask "Enter number:"
read -r DOMAIN_INPUT
case "${DOMAIN_INPUT:-7}" in
  1) USER_DOMAIN="JavaScript/TypeScript developer. Primary stack: Node.js, React, TypeScript." ;;
  2) USER_DOMAIN="Python developer. Primary work: backend APIs, automation, scripting." ;;
  3) USER_DOMAIN="Full-stack web developer. Works across frontend (React/Vue) and backend (Node/Python)." ;;
  4) USER_DOMAIN="Mobile developer. Works with React Native, Flutter, or native iOS/Android." ;;
  5) USER_DOMAIN="DevOps / Infrastructure engineer. Works with Docker, Kubernetes, CI/CD pipelines, cloud." ;;
  6) USER_DOMAIN="Data scientist / ML engineer. Works with Python, Jupyter, model training, AI pipelines." ;;
  *) USER_DOMAIN="Works across multiple languages and domains." ;;
esac
info "Domain: $USER_DOMAIN"

# Primary code editor
ask "What is your primary code editor?"
echo "  [1] VS Code"
echo "  [2] Cursor"
echo "  [3] Windsurf"
echo "  [4] JetBrains IDE"
echo "  [5] Vim / Neovim"
echo "  [6] Other"
read -r EDITOR_INPUT
case "${EDITOR_INPUT:-1}" in
  1) USER_EDITOR="VS Code" ;;
  2) USER_EDITOR="Cursor" ;;
  3) USER_EDITOR="Windsurf" ;;
  4) USER_EDITOR="JetBrains IDE" ;;
  5) USER_EDITOR="Vim/Neovim" ;;
  *) USER_EDITOR="Other editor" ;;
esac
info "Editor: $USER_EDITOR"

echo ""
echo "  ┌──────────────────────────────────────────┐"
echo "  │  Agent name:   $AGENT_NAME"
echo "  │  Projects:     $PROJECTS_DIR"
echo "  │  Install dir:  $AGENT_DIR"
echo "  │  Port:         $AGENT_PORT"
echo "  │  Editor:       $USER_EDITOR"
echo "  │  Claude Code:  $USE_CLAUDE_CODE"
echo "  │  Copilot:      $USE_COPILOT"
echo "  │  Claude Desktop: $USE_CLAUDE_DESKTOP"
echo "  │  ChatGPT:      $USE_CHATGPT"
echo "  │  Cursor:       $USE_CURSOR"
echo "  └──────────────────────────────────────────┘"
echo ""
ask "Proceed with setup? (Y/n)"
read -r GO
if [[ "$GO" =~ ^[Nn] ]]; then
  echo "Setup cancelled."
  exit 0
fi

# ── Create directory structure ─────────────────────────────────────
header "Creating project structure..."
mkdir -p "$AGENT_DIR/src" "$AGENT_DIR/data"
success "Created $AGENT_DIR"

# ── package.json ──────────────────────────────────────────────────
cat > "$AGENT_DIR/package.json" << PKGEOF
{
  "name": "$AGENT_NAME",
  "version": "1.0.0",
  "description": "Personal MCP knowledge server — persistent second brain for AI coding tools",
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "api": "node src/api-server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0"
  }
}
PKGEOF
success "package.json created"

# ── src/db.js ─────────────────────────────────────────────────────
cat > "$AGENT_DIR/src/db.js" << 'DBEOF'
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'agent.db');
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    summary TEXT NOT NULL,
    what_was_built TEXT,
    decisions TEXT,
    stack TEXT,
    next_steps TEXT,
    tags TEXT,
    session_date TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id),
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    summary, what_was_built, decisions, stack, next_steps, tags,
    content='sessions', content_rowid='id'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    category, content, tags,
    content='facts', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, summary, what_was_built, decisions, stack, next_steps, tags)
    VALUES (new.id, new.summary, new.what_was_built, new.decisions, new.stack, new.next_steps, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, category, content, tags)
    VALUES (new.id, new.category, new.content, new.tags);
  END;
`);

export function upsertProject(name, description = null) {
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
  if (existing) {
    db.prepare(`UPDATE projects SET updated_at = datetime('now'), description = COALESCE(?, description) WHERE id = ?`).run(description, existing.id);
    return existing.id;
  }
  return db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid;
}

export function getProject(name) {
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  if (!project) return null;
  return { ...project, sessions: db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY session_date DESC').all(project.id) };
}

export function listProjects() {
  return db.prepare(`
    SELECT p.*, COUNT(s.id) as session_count, MAX(s.session_date) as last_session
    FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
    GROUP BY p.id ORDER BY last_session DESC NULLS LAST
  `).all();
}

export function addSession({ project, summary, what_was_built, decisions, stack, next_steps, tags }) {
  const pid = upsertProject(project);
  return db.prepare(`INSERT INTO sessions (project_id, summary, what_was_built, decisions, stack, next_steps, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(pid, summary, what_was_built ?? null, decisions ?? null, stack ?? null, next_steps ?? null, tags ?? null).lastInsertRowid;
}

export function addFact({ project, category, content, tags }) {
  const pid = project ? upsertProject(project) : null;
  return db.prepare(`INSERT INTO facts (project_id, category, content, tags) VALUES (?, ?, ?, ?)`)
    .run(pid, category, content, tags ?? null).lastInsertRowid;
}

export function searchMemories(query, limit = 10) {
  return {
    sessions: db.prepare(`SELECT s.*, p.name as project_name FROM sessions_fts JOIN sessions s ON s.id = sessions_fts.rowid JOIN projects p ON p.id = s.project_id WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit),
    facts: db.prepare(`SELECT f.*, p.name as project_name FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid LEFT JOIN projects p ON p.id = f.project_id WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit),
  };
}

export default db;
DBEOF
success "src/db.js created"

# ── src/server.js (MCP) ───────────────────────────────────────────
cat > "$AGENT_DIR/src/server.js" << SRVEOF
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { addSession, addFact, searchMemories, getProject, listProjects } from './db.js';

const server = new McpServer({ name: '${AGENT_NAME}', version: '1.0.0' });

server.tool('dump_session', {
  project: z.string().describe('Project name — matches your folder name'),
  summary: z.string().describe('What happened this session'),
  what_was_built: z.string().optional(),
  decisions: z.string().optional(),
  stack: z.string().optional(),
  next_steps: z.string().optional(),
  tags: z.string().optional(),
}, async (args) => {
  const id = addSession(args);
  return { content: [{ type: 'text', text: \`✅ Session saved (id: \${id}) — Project: \${args.project}\` }] };
});

server.tool('search_memories', {
  query: z.string().describe('What to search for'),
  limit: z.number().optional().default(5),
}, async ({ query, limit }) => {
  const r = searchMemories(query, limit);
  const total = r.sessions.length + r.facts.length;
  if (!total) return { content: [{ type: 'text', text: \`No results for "\${query}"\` }] };
  const lines = [\`\${total} result(s) for "\${query}":\\n\`];
  for (const s of r.sessions) {
    lines.push(\`[\${s.project_name}] \${s.session_date}\\n\${s.summary}\`);
    if (s.stack) lines.push(\`Stack: \${s.stack}\`);
    if (s.next_steps) lines.push(\`Next: \${s.next_steps}\`);
    lines.push('');
  }
  for (const f of r.facts) lines.push(\`[\${f.project_name || 'global'}] \${f.category}\\n\${f.content}\\n\`);
  return { content: [{ type: 'text', text: lines.join('\\n') }] };
});

server.tool('get_project', { name: z.string() }, async ({ name }) => {
  const p = getProject(name);
  if (!p) return { content: [{ type: 'text', text: \`No project found: "\${name}"\` }] };
  const lines = [\`# \${p.name} — \${p.sessions.length} session(s)\\n\`];
  for (const s of p.sessions) {
    lines.push(\`## \${s.session_date}\\n\${s.summary}\`);
    if (s.what_was_built) lines.push(\`\\nBuilt: \${s.what_was_built}\`);
    if (s.decisions) lines.push(\`\\nDecisions: \${s.decisions}\`);
    if (s.stack) lines.push(\`\\nStack: \${s.stack}\`);
    if (s.next_steps) lines.push(\`\\nNext: \${s.next_steps}\`);
    lines.push('\\n---\\n');
  }
  return { content: [{ type: 'text', text: lines.join('\\n') }] };
});

server.tool('list_projects', {}, async () => {
  const projects = listProjects();
  if (!projects.length) return { content: [{ type: 'text', text: 'No projects yet.' }] };
  const lines = [\`# All Projects (\${projects.length})\\n\`];
  for (const p of projects) lines.push(\`\${p.name} — \${p.session_count} session(s), last: \${p.last_session ?? 'never'}\`);
  return { content: [{ type: 'text', text: lines.join('\\n') }] };
});

server.tool('add_fact', {
  category: z.string().describe('e.g. preference, pattern, lesson, stack-choice'),
  content: z.string(),
  project: z.string().optional(),
  tags: z.string().optional(),
}, async (args) => {
  const id = addFact(args);
  return { content: [{ type: 'text', text: \`✅ Fact stored (id: \${id})\` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
SRVEOF
success "src/server.js created"

# ── src/api-server.js (REST API + Web UI) ─────────────────────────
cat > "$AGENT_DIR/src/api-server.js" << APIEOF
/**
 * ${AGENT_NAME} — REST API + Web UI
 * Always-on local server. Use the web UI to browse memories,
 * dump sessions manually, or import ChatGPT history.
 */
import { createServer } from 'http';
import { addSession, addFact, searchMemories, getProject, listProjects } from './db.js';

const PORT = process.env.AGENT_PORT ?? ${AGENT_PORT};
const AGENT_NAME = '${AGENT_NAME}';
const PROJECTS_DIR = '${PROJECTS_DIR}';

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(body));
}
function sendHtml(res, html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
  });
}
function parseRawBody(req) {
  return new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8'))); });
}

// ── ChatGPT import helpers ────────────────────────────────────────
function extractMessages(mapping) {
  if (!mapping) return [];
  return Object.values(mapping).filter(n => n.message?.content && n.message?.author)
    .map(n => ({ role: n.message.author.role, text: (n.message.content.parts ?? []).filter(p => typeof p === 'string').join(''), time: n.message.create_time ?? 0 }))
    .filter(m => m.text.trim() && m.role !== 'system').sort((a, b) => a.time - b.time);
}
function findDumpBlock(text) {
  const match = text.match(/---(?:AGENT BLUE|BLOODY AGENT) DUMP---([\s\S]*?)(?:---END DUMP---|$)/i);
  if (!match) return null;
  const block = match[1];
  const get = (key) => { const r = block.match(new RegExp(\`\${key}:\\\\s*(.+?)(?=\\\\n[A-Z]|\$)\`, 'is')); return r ? r[1].trim() : undefined; };
  const project = get('PROJECT'), summary = get('SUMMARY');
  if (!project || !summary) return null;
  return { project, summary, what_was_built: get('BUILT'), decisions: get('DECISIONS'), stack: get('STACK'), next_steps: get('NEXT'), tags: get('TAGS') };
}
function titleToProject(t) { return (t ?? 'unknown').toLowerCase().replace(/[^a-z0-9\\s-]/g, '').trim().replace(/\\s+/g, '-').slice(0, 50); }
function buildStack(msgs) {
  const text = msgs.map(m => m.text).join(' ').toLowerCase();
  return ['react','next.js','vue','svelte','angular','node','express','fastapi','django','typescript','javascript','python','rust','go','supabase','firebase','postgresql','mongodb','mysql','sqlite','prisma','redis','tailwind','docker','kubernetes','aws','gcp','azure','vercel','stripe','openai','anthropic'].filter(t => text.includes(t)).join(', ') || undefined;
}
function isWorthImporting(msgs) { return msgs.filter(m => m.role === 'assistant').map(m => m.text).join(' ').split(/\\s+/).length > 100; }
function importConversations(conversations) {
  let imported = 0, skipped = 0, fromDump = 0;
  for (const c of conversations) {
    const msgs = extractMessages(c.mapping);
    const date = c.create_time ? new Date(c.create_time * 1000).toISOString().slice(0, 10) : 'unknown';
    if (!isWorthImporting(msgs)) { skipped++; continue; }
    const allText = msgs.map(m => m.text).join('\\n');
    const dump = findDumpBlock(allText);
    if (dump) { addSession(dump); fromDump++; imported++; continue; }
    const firstUser = msgs.find(m => m.role === 'user')?.text ?? '';
    addSession({ project: titleToProject(c.title), summary: \`[ChatGPT Import] "\${c.title}". \${firstUser.slice(0, 250).replace(/\\n+/g, ' ').trim()}\`, stack: buildStack(msgs), tags: \`chatgpt-import,\${date.slice(0, 7)}\` });
    imported++;
  }
  return { total: conversations.length, imported, skipped, fromDump };
}

// ── Bookmarklet (works for both BLOODY AGENT and AGENT BLUE dump formats) ─────
const BOOKMARKLET = \`javascript:(function(){var msgs=document.querySelectorAll('[data-message-author-role]');var text='';msgs.forEach(function(m){text+=(m.getAttribute('data-message-author-role')==='user'?'USER: ':'AI: ')+m.innerText+'\\\\n\\\\n';});if(!text){alert('No messages found on this page.');return;}fetch('http://localhost:${AGENT_PORT}/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({raw:text})}).then(function(r){return r.json();}).then(function(d){if(d.id){alert('${AGENT_NAME} updated! Project: '+d.project);}else{alert('No dump block found. Make sure the AI produced the summary.\\\\n\\\\n'+(d.error||''));}}).catch(function(){alert('${AGENT_NAME} not reachable at port ${AGENT_PORT}.');});})()\`;

const CHATGPT_INSTRUCTIONS = \`At the end of every work session where we built, decided, or learned something significant, output a summary block in this exact format:

---AGENT BLUE DUMP---
PROJECT: [project folder name]
SUMMARY: [2-3 sentence summary of what happened]
BUILT: [specific files, features, or components created or changed]
DECISIONS: [key architectural or design decisions made and why]
STACK: [technologies and libraries used, comma-separated]
NEXT: [what to pick up next session]
TAGS: [relevant tags, comma-separated]
---END DUMP---

Only output this when there is genuinely something worth remembering. Skip for casual questions.\`;

// ── HTML ──────────────────────────────────────────────────────────
const HTML = \`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\${AGENT_NAME}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0f1e;color:#e0e0e0;min-height:100vh}
  header{background:#0d1b3e;border-bottom:2px solid #1e40af;padding:1.5rem 2rem;display:flex;align-items:center;gap:1rem}
  header h1{font-size:1.5rem;color:#3b82f6;letter-spacing:.05em}header span{color:#888;font-size:.9rem}
  .tabs{display:flex;flex-wrap:wrap;gap:0;border-bottom:1px solid #1e293b;background:#0a1628;padding:0 2rem}
  .tab{padding:.75rem 1.25rem;cursor:pointer;border-bottom:2px solid transparent;color:#888;font-size:.85rem;transition:all .2s}
  .tab.active{color:#3b82f6;border-bottom-color:#3b82f6}.tab:hover{color:#e0e0e0}
  .panel{display:none;padding:2rem;max-width:860px}.panel.active{display:block}
  label{display:block;font-size:.75rem;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.4rem;margin-top:1rem}
  label:first-child{margin-top:0}.req{color:#3b82f6}
  input,textarea,select{width:100%;background:#0d1b3e;border:1px solid #1e293b;color:#e0e0e0;padding:.6rem .8rem;border-radius:6px;font-size:.9rem;font-family:inherit}
  input:focus,textarea:focus{outline:none;border-color:#1e40af}textarea{resize:vertical;min-height:80px}
  button{margin-top:1.5rem;background:#1e40af;color:white;border:none;padding:.7rem 1.8rem;border-radius:6px;font-size:.95rem;cursor:pointer;font-weight:600}
  button:hover:not(:disabled){background:#2563eb}button:disabled{background:#1e293b;cursor:default}
  .toast{display:none;margin-top:1rem;padding:.7rem 1rem;border-radius:6px;background:#1e3a1e;color:#4caf50;border:1px solid #2e5a2e;font-size:.9rem}
  .toast.error{background:#1a1e3a;color:#ef4444;border-color:#3b1e1e}
  .card{background:#0d1b3e;border:1px solid #1e293b;border-radius:8px;padding:1rem;margin-bottom:.75rem}
  .card h4{color:#3b82f6;margin-bottom:.4rem;font-size:.95rem}.card .meta{font-size:.75rem;color:#555;margin-bottom:.4rem}
  .card p{font-size:.9rem;line-height:1.5}
  .drop{border:2px dashed #1e293b;border-radius:8px;padding:2.5rem 2rem;text-align:center;cursor:pointer;transition:border-color .2s;margin:1rem 0}
  .drop:hover,.drop.on{border-color:#1e40af}.drop strong{display:block;margin-bottom:.4rem}
  .drop p{color:#666;font-size:.85rem}input[type=file]{display:none}
  .stat{display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #1e293b;font-size:.9rem}
  .stat:last-child{border-bottom:none}.stat span:last-child{color:#3b82f6;font-weight:600}
  pre{background:#060d1a;border:1px solid #1e293b;border-radius:6px;padding:1rem;overflow-x:auto;font-size:.8rem;white-space:pre-wrap;word-break:break-all;color:#aaa;margin:.5rem 0}
  .hint{font-size:.75rem;color:#555;margin-top:.25rem}a{color:#3b82f6;text-decoration:none}
  .bm{display:inline-block;background:#1e40af;color:#fff;padding:.5rem 1.2rem;border-radius:6px;font-weight:600;cursor:grab;border:2px dashed #3b82f6;margin:.5rem 0;font-size:.85rem}
</style></head><body>
<header>
  <h1>🔵 \${AGENT_NAME}</h1>
  <span>Your personal second brain — <a href="/setup">ChatGPT Setup</a></span>
</header>
<div class="tabs">
  <div class="tab active" onclick="show('dump')">Dump Session</div>
  <div class="tab" onclick="show('fact')">Add Fact</div>
  <div class="tab" onclick="show('search')">Search</div>
  <div class="tab" onclick="show('projects')">Projects</div>
  <div class="tab" onclick="show('import')">Import ChatGPT</div>
</div>

<div id="tab-dump" class="panel active">
  <label>Project Name <span class="req">*</span></label>
  <input id="d-p" placeholder="e.g. my-project (matches your folder name)"/>
  <p class="hint">Must match the folder name in your projects directory</p>
  <label>Session Summary <span class="req">*</span></label>
  <textarea id="d-s" placeholder="What happened this session? Keep it concise but complete."></textarea>
  <label>What was built</label>
  <textarea id="d-b" style="min-height:60px" placeholder="Specific files, features, or components created or changed"></textarea>
  <label>Key decisions</label>
  <textarea id="d-dec" style="min-height:60px" placeholder="Architectural or design choices made and why"></textarea>
  <label>Stack / Technologies</label>
  <input id="d-st" placeholder="e.g. React, Node.js, PostgreSQL, Docker"/>
  <label>Next steps</label>
  <textarea id="d-n" style="min-height:60px" placeholder="What to pick up next session"></textarea>
  <label>Tags</label>
  <input id="d-t" placeholder="comma-separated e.g. auth,api,bug-fix"/>
  <button onclick="dump()">Dump to \${AGENT_NAME}</button>
  <div id="dt" class="toast"></div>
</div>

<div id="tab-fact" class="panel">
  <label>Category <span class="req">*</span></label>
  <input id="f-c" placeholder="e.g. preference, pattern, lesson, stack-choice"/>
  <label>Content <span class="req">*</span></label>
  <textarea id="f-co" placeholder="The fact, insight, or preference to remember"></textarea>
  <label>Project (leave blank for global)</label>
  <input id="f-p" placeholder="Optional — associate with a project"/>
  <label>Tags</label><input id="f-t" placeholder="comma-separated"/>
  <button onclick="fact()">Store Fact</button>
  <div id="ft" class="toast"></div>
</div>

<div id="tab-search" class="panel">
  <label>Search your memories</label>
  <input id="s-q" placeholder="e.g. authentication, database migration, Docker setup..." onkeydown="if(event.key==='Enter')search()"/>
  <button onclick="search()">Search</button>
  <div id="sr" style="margin-top:1.5rem"></div>
</div>

<div id="tab-projects" class="panel">
  <button style="margin-top:0" onclick="projects()">Refresh</button>
  <div id="pl" style="margin-top:1rem"></div>
</div>

<div id="tab-import" class="panel">
  <p style="color:#aaa;margin-bottom:1.5rem">Bulk import your ChatGPT conversation history. Useful for seeding the brain with past work.</p>
  <p style="color:#666;font-size:.85rem">Get your export: chatgpt.com → Settings → Data Controls → Export data → unzip → find <strong>conversations.json</strong></p>
  <div class="drop" id="dz" onclick="document.getElementById('fi').click()">
    <strong>Click or drag & drop</strong>
    <p>conversations.json from your ChatGPT export</p>
  </div>
  <input type="file" id="fi" accept=".json"/>
  <div id="fn" style="color:#666;font-size:.8rem;margin-top:.4rem"></div>
  <button id="ib" disabled onclick="imp()">Import to \${AGENT_NAME}</button>
  <div id="ir" style="display:none;margin-top:1.5rem" class="card">
    <h4 style="color:#4caf50;margin-bottom:1rem">Import complete</h4>
    <div class="stat"><span>Total conversations</span><span id="r-t"></span></div>
    <div class="stat"><span>Imported</span><span id="r-i"></span></div>
    <div class="stat"><span>From dump blocks</span><span id="r-d"></span></div>
    <div class="stat"><span>Auto-summarised</span><span id="r-a"></span></div>
    <div class="stat"><span>Skipped (too short)</span><span id="r-s"></span></div>
  </div>
</div>

<script>
const NAME = '\${AGENT_NAME}';
function show(n){document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',['dump','fact','search','projects','import'][i]===n));document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));document.getElementById('tab-'+n).classList.add('active');if(n==='projects')projects();}
function toast(id,msg,ok=true){const el=document.getElementById(id);el.textContent=msg;el.className='toast'+(ok?'':' error');el.style.display='block';if(ok)setTimeout(()=>el.style.display='none',4000);}
async function dump(){const p=document.getElementById('d-p').value.trim(),s=document.getElementById('d-s').value.trim();if(!p||!s)return toast('dt','Project and summary are required.',false);const r=await fetch('/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:p,summary:s,what_was_built:document.getElementById('d-b').value.trim()||undefined,decisions:document.getElementById('d-dec').value.trim()||undefined,stack:document.getElementById('d-st').value.trim()||undefined,next_steps:document.getElementById('d-n').value.trim()||undefined,tags:document.getElementById('d-t').value.trim()||undefined})});const d=await r.json();r.ok?toast('dt','✅ Saved to '+NAME+' (session #'+d.id+')'):toast('dt',d.error,false);}
async function fact(){const c=document.getElementById('f-c').value.trim(),co=document.getElementById('f-co').value.trim();if(!c||!co)return toast('ft','Category and content are required.',false);const r=await fetch('/fact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:c,content:co,project:document.getElementById('f-p').value.trim()||undefined,tags:document.getElementById('f-t').value.trim()||undefined})});const d=await r.json();r.ok?toast('ft','✅ Fact stored (#'+d.id+')'):toast('ft',d.error,false);}
async function search(){const q=document.getElementById('s-q').value.trim();if(!q)return;const r=await fetch('/search?q='+encodeURIComponent(q));const d=await r.json();const el=document.getElementById('sr');if(!d.sessions.length&&!d.facts.length){el.innerHTML='<p style="color:#555">No results found.</p>';return;}let h='';for(const s of d.sessions){h+='<div class="card"><h4>'+s.project_name+'</h4><div class="meta">'+s.session_date+'</div><p>'+s.summary+'</p>'+(s.stack?'<p style="margin-top:.4rem;color:#666;font-size:.85rem">Stack: '+s.stack+'</p>':'')+'</div>';}for(const f of d.facts){h+='<div class="card"><h4>'+(f.project_name||'Global')+' — '+f.category+'</h4><p>'+f.content+'</p></div>';}el.innerHTML=h;}
async function projects(){const r=await fetch('/projects');const d=await r.json();const el=document.getElementById('pl');if(!d.length){el.innerHTML='<p style="color:#555">No projects yet.</p>';return;}el.innerHTML=d.map(p=>'<div class="card"><h4>'+p.name+'</h4><div class="meta">'+p.session_count+' session(s) · last active: '+(p.last_session||'never')+'</div></div>').join('');}
let sf=null;
document.getElementById('fi').addEventListener('change',()=>setf(document.getElementById('fi').files[0]));
const dz=document.getElementById('dz');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('on');});
dz.addEventListener('dragleave',()=>dz.classList.remove('on'));
dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('on');setf(e.dataTransfer.files[0]);});
function setf(f){if(!f)return;sf=f;document.getElementById('fn').textContent='Selected: '+f.name+' ('+(f.size/1024/1024).toFixed(1)+' MB)';document.getElementById('ib').disabled=false;}
async function imp(){if(!sf)return;document.getElementById('ib').disabled=true;document.getElementById('ib').textContent='Importing...';try{const t=await sf.text();const r=await fetch('/import',{method:'POST',headers:{'Content-Type':'application/json'},body:t});const d=await r.json();if(!r.ok)throw new Error(d.error);document.getElementById('r-t').textContent=d.total;document.getElementById('r-i').textContent=d.imported;document.getElementById('r-d').textContent=d.fromDump;document.getElementById('r-a').textContent=d.imported-d.fromDump;document.getElementById('r-s').textContent=d.skipped;document.getElementById('ir').style.display='block';}catch(e){alert('Import failed: '+e.message);}document.getElementById('ib').disabled=false;document.getElementById('ib').textContent='Import to '+NAME;}
</script>
</body></html>\`;

const SETUP_PAGE = \`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>\${AGENT_NAME} — ChatGPT Setup</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0f1e;color:#e0e0e0;padding:2rem;max-width:800px;margin:0 auto}h1{color:#3b82f6;margin-bottom:.3rem}h2{color:#3b82f6;margin:2rem 0 .75rem;font-size:1.05rem}p{color:#aaa;line-height:1.6;margin-bottom:1rem}.step{background:#0d1b3e;border:1px solid #1e293b;border-radius:8px;padding:1.25rem;margin-bottom:1rem}.label{color:#3b82f6;font-weight:700;font-size:.75rem;text-transform:uppercase;margin-bottom:.5rem}pre{background:#060d1a;border:1px solid #1e293b;border-radius:6px;padding:1rem;font-size:.8rem;white-space:pre-wrap;word-break:break-all;color:#ccc;margin:.5rem 0}.bm{display:inline-block;background:#1e40af;color:#fff;padding:.5rem 1.2rem;border-radius:6px;font-weight:600;cursor:grab;border:2px dashed #3b82f6;margin:.5rem 0;text-decoration:none}.tip{font-size:.75rem;color:#555;margin-top:.5rem}a{color:#3b82f6}</style>
</head><body>
<h1>\${AGENT_NAME} — ChatGPT Setup</h1>
<p>Two steps. Do this once and it works forever.</p>
<h2>Step 1 — Give ChatGPT standing instructions</h2>
<div class="step">
  <div class="label">chatgpt.com → Settings → Personalization → Custom Instructions</div>
  <p>Paste this into "How would you like ChatGPT to respond?"</p>
  <pre>\${CHATGPT_INSTRUCTIONS}</pre>
</div>
<h2>Step 2 — Add the bookmarklet to your browser</h2>
<div class="step">
  <div class="label">Show bookmarks bar (Ctrl/Cmd+Shift+B), then drag this button onto it:</div>
  <a class="bm" href="\${BOOKMARKLET.replace(/"/g,'&quot;')}">🔵 Dump to \${AGENT_NAME}</a>
  <p class="tip">If drag doesn't work: right-click bookmarks bar → Add page → paste the URL below</p>
  <pre>\${BOOKMARKLET.replace(/</g,'&lt;')}</pre>
</div>
<h2>How it works</h2>
<div class="step">
  <p>1. Finish a ChatGPT session<br>2. ChatGPT outputs the dump block automatically<br>3. Click the bookmarklet<br>4. Done — session is in your brain</p>
</div>
<p style="margin-top:2rem"><a href="/">← Back to \${AGENT_NAME}</a></p>
</body></html>\`;

// ── Server ────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, \`http://localhost:\${PORT}\`);
  const method = req.method;
  if (method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); res.end(); return; }
  try {
    if (method === 'GET'  && url.pathname === '/')        return sendHtml(res, HTML);
    if (method === 'GET'  && url.pathname === '/setup')   return sendHtml(res, SETUP_PAGE);
    if (method === 'POST' && url.pathname === '/session') { const b = await parseBody(req); if (!b.project||!b.summary) return send(res,400,{error:'project and summary required'}); return send(res,201,{id:addSession(b),message:'Stored'}); }
    if (method === 'POST' && url.pathname === '/fact')    { const b = await parseBody(req); if (!b.category||!b.content) return send(res,400,{error:'category and content required'}); return send(res,201,{id:addFact(b),message:'Stored'}); }
    if (method === 'POST' && url.pathname === '/ingest')  { const b = await parseBody(req); if (!b.raw) return send(res,400,{error:'raw required'}); const p = findDumpBlock(b.raw); if (!p) return send(res,400,{error:'No dump block found'}); return send(res,201,{id:addSession(p),project:p.project,message:'Ingested'}); }
    if (method === 'GET'  && url.pathname === '/search')  { const q = url.searchParams.get('q'); if (!q) return send(res,400,{error:'q required'}); return send(res,200,searchMemories(q,parseInt(url.searchParams.get('limit')||'10'))); }
    if (method === 'GET'  && url.pathname === '/projects') return send(res,200,listProjects());
    if (method === 'POST' && url.pathname === '/import')  { const raw = await parseRawBody(req); let c; try{c=JSON.parse(raw);}catch{return send(res,400,{error:'Invalid JSON'});} if (!Array.isArray(c)) return send(res,400,{error:'Expected array'}); return send(res,200,importConversations(c)); }
    const pm = url.pathname.match(/^\/project\/(.+)\$/);
    if (method === 'GET' && pm) { const p = getProject(decodeURIComponent(pm[1])); return p ? send(res,200,p) : send(res,404,{error:'Not found'}); }
    send(res, 404, { error: 'Not found' });
  } catch (err) { send(res, 500, { error: err.message }); }
});

httpServer.listen(PORT, '127.0.0.1', () => process.stderr.write(\`[\${AGENT_NAME}] Running at http://localhost:\${PORT}\\n\`));
APIEOF
success "src/api-server.js created"

# ── Install npm dependencies ──────────────────────────────────────
header "Installing dependencies..."
cd "$AGENT_DIR"
npm install --silent 2>&1 | grep -v "^npm warn"
success "Dependencies installed"

# ── Verify DB works ───────────────────────────────────────────────
header "Verifying installation..."
$NODE -e "import('./src/db.js').then(m => { console.log('  DB OK'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); })" 2>&1
success "Database initialised at $AGENT_DIR/data/agent.db"

# ── Register MCP — Claude Code ────────────────────────────────────
if $USE_CLAUDE_CODE || $USE_CURSOR || $USE_WINDSURF; then
  header "Registering MCP server for Claude Code..."
  CLAUDE_CONFIG="$HOME/.claude/claude.json"
  mkdir -p "$HOME/.claude"
  if [ -f "$CLAUDE_CONFIG" ]; then
    if grep -q '"mcpServers"' "$CLAUDE_CONFIG" 2>/dev/null; then
      warn "~/.claude/claude.json already has mcpServers. Add manually:"
      echo "    \"$AGENT_NAME\": { \"command\": \"$NODE\", \"args\": [\"$AGENT_DIR/src/server.js\"] }"
    else
      warn "~/.claude/claude.json exists — add mcpServers section manually."
      echo "    \"mcpServers\": { \"$AGENT_NAME\": { \"command\": \"$NODE\", \"args\": [\"$AGENT_DIR/src/server.js\"] } }"
    fi
  else
    cat > "$CLAUDE_CONFIG" << CONFEOF
{
  "mcpServers": {
    "$AGENT_NAME": {
      "command": "$NODE",
      "args": ["$AGENT_DIR/src/server.js"]
    }
  }
}
CONFEOF
    success "Created ~/.claude/claude.json"
  fi
fi

# ── Register MCP — Claude Desktop ─────────────────────────────────
if $USE_CLAUDE_DESKTOP; then
  header "Registering MCP for Claude Desktop..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    if [ -f "$DESKTOP_CONFIG" ]; then
      warn "Claude Desktop config exists. Add to mcpServers manually:"
      echo "    \"$AGENT_NAME\": { \"command\": \"$NODE\", \"args\": [\"$AGENT_DIR/src/server.js\"] }"
    else
      mkdir -p "$HOME/Library/Application Support/Claude"
      cat > "$DESKTOP_CONFIG" << DESKEOF
{
  "mcpServers": {
    "$AGENT_NAME": {
      "command": "$NODE",
      "args": ["$AGENT_DIR/src/server.js"]
    }
  }
}
DESKEOF
      success "Created Claude Desktop config"
    fi
  else
    warn "Claude Desktop MCP config location unknown for this OS. Configure manually."
  fi
fi

# ── CLAUDE.md (for Claude Code) ───────────────────────────────────
if $USE_CLAUDE_CODE; then
  CLAUDE_MD="$HOME/.claude/CLAUDE.md"
  if [ -f "$CLAUDE_MD" ]; then
    warn "~/.claude/CLAUDE.md already exists — not overwritten."
  else
    cat > "$CLAUDE_MD" << MDEOF
# Standing Instructions — All Projects

## ${AGENT_NAME} (My Second Brain)

At the **start of every session**, call these MCP tools:
1. \`list_projects\` — overview of known projects
2. \`get_project\` with the current project name (= current folder name) — load prior context
3. If the project is new, call \`search_memories\` with relevant keywords

At the **end of every session**, call \`dump_session\` with a thorough summary of what was built, decisions made, stack used, and next steps.

Trigger words — dump immediately **before** replying when the user says any of these:
- "done", "thank you", "thanks", "cheers", "bye", "goodbye", "see you", "later",
  "that's all", "that's it", "wrap up", "wrapping up", "signing off", "we're done",
  "good session", "enough for today", "calling it", "calling it a day", "let's stop here"

**During long sessions**, dump after every significant milestone. Tag as \`checkpoint\`.

**Do not wait to be asked.** This is a standing instruction for every session.

## About This Developer
- Primary editor: ${USER_EDITOR}
- Domain: ${USER_DOMAIN}
- Projects directory: ${PROJECTS_DIR}
- Project name in ${AGENT_NAME} = folder name exactly

## General Preferences
- Be concise and direct — lead with the answer, not the reasoning
- No over-engineering — minimum complexity for the current task
- Don't add comments, docstrings, or annotations to code not being changed
- Don't add error handling for scenarios that can't happen
- Trust existing code and framework guarantees
MDEOF
    success "Created ~/.claude/CLAUDE.md"
  fi
fi

# ── Copilot instructions ──────────────────────────────────────────
if $USE_COPILOT; then
  mkdir -p "$HOME/.github"
  COPILOT_MD="$HOME/.github/copilot-instructions.md"
  if [ -f "$COPILOT_MD" ]; then
    warn "~/.github/copilot-instructions.md already exists — not overwritten."
  else
  cat > "$COPILOT_MD" << CPEOF
# Copilot Standing Instructions

## ${AGENT_NAME} — Second Brain
I have a local MCP server called ${AGENT_NAME} that stores my project history.

At the **start of each session**:
- Call \`get_project\` (project name = current folder name) to load context
- Call \`search_memories\` if the project is new

At the **end of each session**, call \`dump_session\` with a full summary.

Trigger words — dump before replying when I say:
- "done", "thank you", "thanks", "cheers", "bye", "see you", "later",
  "that's all", "wrap up", "wrapping up", "signing off", "calling it", "enough for today"

During long sessions, dump after every significant milestone. Tag as \`checkpoint\`.

Do not wait to be asked — this is a standing instruction.

## About This Developer
- Primary editor: ${USER_EDITOR}
- Domain: ${USER_DOMAIN}
- Projects: ${PROJECTS_DIR}
- Project name = folder name
CPEOF
    success "Created ~/.github/copilot-instructions.md"
  fi
fi

# ── LaunchAgent (macOS) / background note (Linux/other) ───────────
header "Setting up auto-start..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  PLIST_LABEL="com.${AGENT_NAME//-/.}.api"
  PLIST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
  cat > "$PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string>
    <string>${AGENT_DIR}/src/api-server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${AGENT_DIR}/data/api.log</string>
  <key>StandardErrorPath</key><string>${AGENT_DIR}/data/api-error.log</string>
  <key>WorkingDirectory</key><string>${AGENT_DIR}</string>
</dict></plist>
PLISTEOF
  launchctl load "$PLIST" 2>/dev/null && success "LaunchAgent registered — starts automatically at login" || warn "LaunchAgent created but could not load. Run: launchctl load $PLIST"
elif [[ "$OSTYPE" == "linux"* ]]; then
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"
  cat > "$SYSTEMD_DIR/${AGENT_NAME}.service" << SVCEOF
[Unit]
Description=${AGENT_NAME} API Server
After=network.target

[Service]
ExecStart=${NODE} ${AGENT_DIR}/src/api-server.js
Restart=always
RestartSec=5
StandardOutput=append:${AGENT_DIR}/data/api.log
StandardError=append:${AGENT_DIR}/data/api-error.log
WorkingDirectory=${AGENT_DIR}

[Install]
WantedBy=default.target
SVCEOF
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable "${AGENT_NAME}" 2>/dev/null && systemctl --user start "${AGENT_NAME}" 2>/dev/null && success "systemd service registered and started" || warn "Systemd service created. Run: systemctl --user enable --now ${AGENT_NAME}"
else
  warn "Auto-start not configured for this OS."
  warn "To start manually: node $AGENT_DIR/src/api-server.js"
fi

# ── Wait for server and verify ────────────────────────────────────
header "Verifying web UI..."
sleep 2
if curl -s "http://localhost:${AGENT_PORT}" -o /dev/null 2>/dev/null; then
  success "Web UI is running at http://localhost:${AGENT_PORT}"
else
  warn "Server not responding yet. It may take a moment."
  warn "Try opening http://localhost:${AGENT_PORT} in your browser."
fi

# ── Final summary ─────────────────────────────────────────────────
echo ""
echo -e "${BLUE}${BOLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║           Setup Complete! 🔵                  ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Agent:        $AGENT_NAME"
echo "  Web UI:       http://localhost:${AGENT_PORT}"
echo "  DB:           $AGENT_DIR/data/agent.db"
echo "  Logs:         $AGENT_DIR/data/api-error.log"
echo ""

STEP=1
echo -e "  ${BOLD}Manual steps remaining:${NC}"
echo ""

if $USE_COPILOT || $USE_CURSOR || $USE_WINDSURF; then
  echo "  $STEP. Add MCP to VS Code / Cursor / Windsurf:"
  echo "     Cmd/Ctrl+Shift+P → 'Open User Settings JSON' → add before last }:"
  echo ""
  echo "     ,\"mcp\": {"
  echo "       \"servers\": {"
  echo "         \"$AGENT_NAME\": {"
  echo "           \"type\": \"stdio\","
  echo "           \"command\": \"$NODE\","
  echo "           \"args\": [\"$AGENT_DIR/src/server.js\"]"
  echo "         }"
  echo "       }"
  echo "     }"
  echo ""
  echo "     Then restart your editor."
  echo ""
  STEP=$((STEP + 1))
fi

if $USE_CHATGPT; then
  echo "  $STEP. ChatGPT setup (custom instructions + bookmarklet):"
  echo "     Open: http://localhost:${AGENT_PORT}/setup"
  echo "     Follow the 2 steps on that page."
  echo ""
  STEP=$((STEP + 1))
fi

if $USE_CLAUDE_DESKTOP; then
  echo "  $STEP. Claude Desktop — add standing instructions:"
  echo "     Claude Desktop → Settings → Personal preferences → paste:"
  echo ""
  echo "     I have a local MCP server called $AGENT_NAME."
  echo "     At session start: call list_projects and get_project."
  echo "     At session end: call dump_session. Trigger words: done, thanks,"
  echo "     bye, that's all, wrap up, signing off, calling it."
  echo "     Projects: $PROJECTS_DIR. Project name = folder name."
  echo ""
  STEP=$((STEP + 1))
fi

if [ $STEP -eq 1 ]; then
  echo "  None — you're fully set up!"
  echo ""
fi
