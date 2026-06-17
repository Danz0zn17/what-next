# What Next

> Persistent memory for AI coding tools, delivered over MCP.

[![License: MIT](https://img.shields.io/badge/license-MIT-6366f1.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-818cf8.svg)](https://modelcontextprotocol.io)
[![Railway](https://img.shields.io/badge/cloud-Railway-0B0D0E.svg)](https://railway.app)
[![whatnextai.co.za](https://img.shields.io/badge/site-whatnextai.co.za-22c55e.svg)](https://whatnextai.co.za)

**Your AI tools don't share memory. What Next gives them one.**

What Next is a persistent memory engine for developers. It learns from every session you run, every commit you push, and every decision you make - then surfaces it instantly to Claude Code, Claude Desktop, Copilot, Cursor, Codex, or a self-hosted Hermes agent. One memory. Every tool. Always current.

**v2.0 - Smart Context Cards:** After every session dump or git commit, What Next auto-generates a plain markdown file per project at `~/.whatnext/agents/{project}.md`. Any AI tool can read this file directly - no MCP required. It's always current because it updates on every commit.

Local is the source of truth. SQLite writes happen first on your machine; cloud sync is background-only and exists purely as backup.

---

## How It Works

```
git commit  ──watcher──►  What Next (local-first)  ──background sync──►  Cloud (Railway)
dump_session              SQLite source of truth          backup only
                          ↓ writes
                    ~/.whatnext/agents/{project}.md   ← any AI tool reads this directly
```

---

## Supported Surfaces

| Surface | Config |
|---|---|
| Claude Code | `CLAUDE.md` in project root or `~/.claude/CLAUDE.md` global |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| VS Code / GitHub Copilot | `~/Library/Application Support/Code/User/mcp.json` |
| VS Code Codex | `~/.codex/config.toml` |
| GitHub Copilot CLI | `~/.config/github-copilot/mcp.json` |
| Cursor | `.cursor/rules/` in project root |
| Hermes Agent (Nous) | `~/.hermes/config.yaml` (MCP) + `~/.hermes/SOUL.md` (orientation) — Telegram, Desktop, CLI |

---

## Prerequisites

- **macOS, Windows, or Linux**
- **Node.js 20+** - install via [nodejs.org](https://nodejs.org)
- At least one AI surface: Claude Code, Claude Desktop, VS Code with Copilot, Cursor, etc.

---

## Setup (2 minutes)

**1. Install**

```bash
npm install -g whatnext-ai
```

**2. Run the installer**

```bash
# Claude Desktop
install-what-next --client claude  --key bak_xxx
# VS Code / GitHub Copilot
install-what-next --client vscode  --key bak_xxx
# VS Code Codex extension or Codex CLI
install-what-next --client codex   --key bak_xxx
```

> **Prefer cloning the repo?** (for contributors or self-hosters)
> ```bash
> git clone https://github.com/Danz0zn17/what-next.git ~/what-next
> cd ~/what-next && npm install
> node bin/install.js --client claude --key bak_xxx
> ```

On **macOS**, the installer sets up `com.whatnextai.api` as a LaunchAgent - the REST API starts at every login and auto-restarts on crash.

**3. Add to Claude Desktop**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "what-next": {
      "command": "node",
      "args": ["~/what-next/bin/bootstrap-entry.js", "src/server.js", "mcp"],
      "env": {
        "WHATNEXT_PREFER_LOCAL": "1",
        "WHATNEXT_CLOUD_SYNC_MODE": "background",
        "WHATNEXT_CLOUD_URL": "https://what-next-production.up.railway.app",
        "WHATNEXT_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**4. Add to Claude Code**

What Next works with Claude Code in two ways:

**Option A - Global CLAUDE.md** (one-time setup, works across all projects):

Add to `~/.claude/CLAUDE.md`:
```markdown
## What Next (Persistent Second Brain)

At session start: Read `~/.whatnext/agents/{project-name}.md` - instant context, no MCP needed.

MCP tools: get_context, get_orientation, update_project_intelligence, dump_session, search_memories, whats_next

CRITICAL - how to call dump_session in Claude Code: always call `mcp__what-next__dump_session`
directly as a tool call. Never delegate via the Agent tool - subagents don't inherit MCP connections.

Trigger dump_session whenever the session ends (any phrase of thanks, farewell, or completion).
Trigger silently after every completed milestone - tag as checkpoint.
```

**Option B - Per-project CLAUDE.md** (add to any project root):
```bash
echo "" >> CLAUDE.md
curl https://raw.githubusercontent.com/Danz0zn17/what-next/main/CLAUDE-snippet.md >> CLAUDE.md
```

**5. Add to VS Code / GitHub Copilot**

Edit `~/Library/Application Support/Code/User/mcp.json`:

```json
{
  "servers": {
    "what-next": {
      "command": "node",
      "args": ["~/what-next/bin/bootstrap-entry.js", "src/server.js", "mcp"],
      "env": {
        "WHATNEXT_PREFER_LOCAL": "1",
        "WHATNEXT_CLOUD_SYNC_MODE": "background",
        "WHATNEXT_CLOUD_URL": "https://what-next-production.up.railway.app",
        "WHATNEXT_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**6. Add to VS Code Codex**

Append to `~/.codex/config.toml`:

```toml
[mcp_servers.what-next]
command = "node"
args = ["/absolute/path/to/what-next/bin/bootstrap-entry.js", "src/server.js", "mcp"]
tool_timeout_sec = 20

[mcp_servers.what-next.env]
WHATNEXT_PREFER_LOCAL = "1"
WHATNEXT_CLOUD_SYNC_MODE = "background"
WHATNEXT_CLOUD_URL = "https://what-next-production.up.railway.app"
WHATNEXT_API_KEY = "your_api_key_here"
```

**7. Add to Hermes Agent (Nous, self-hosted)**

Hermes is a first-class surface: it auto-orients from your What Next memory at the start of every session
and saves a `dump_session` autonomously when work completes - the same reflexes as Claude Code.

Add the MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  what-next:
    command: node
    args:
      - /absolute/path/to/what-next/bin/bootstrap-entry.js
      - src/server.js
      - mcp
    env:
      WHATNEXT_PREFER_LOCAL: "1"
      WHATNEXT_CLOUD_SYNC_MODE: background
      WHATNEXT_CLOUD_URL: https://what-next-production.up.railway.app
      WHATNEXT_API_KEY: your_api_key_here
```

Then give Hermes the orientation reflex in `~/.hermes/SOUL.md` (its system prompt) - a short standing
directive so it loads memory before it answers:

```markdown
## What Next - New-Session Orientation Protocol (Non-Negotiable)
On the first message of any new session, silently BEFORE replying:
1. Determine the project from the working directory (or the question).
2. Read `~/.whatnext/agents/<project>.md` (per-project) or `~/.whatnext/context.md` (global).
3. Call get_orientation / get_context (surface: "hermes") when the task is project-specific.
4. Only then answer, grounded in what you loaded.
Save a dump_session silently at session end and after each completed milestone.
```

**8. Restart your AI tool**

What Next will appear as available MCP tools: `dump_session`, `get_orientation`, `get_context`, `search_memories`, and more.

---

## Available Tools

| Tool | What it does |
|---|---|
| `get_orientation` | **Start here for project work.** Returns stack, key dirs, conventions, last 3 sessions, and open tasks in under 2000 tokens. Replaces cold-start exploration entirely. |
| `get_context` | Full cross-project brain dump - all projects, recent sessions, facts. Use at session start when you need the full picture. |
| `dump_session` | Save a summary of the current session - what was built, decisions made, next steps. Triggers a Smart Context Card update automatically. |
| `update_project_intelligence` | Save structural knowledge about a project (stack, key dirs, conventions, env vars, deployment). Future sessions skip exploration entirely. |
| `whats_next` | See the most recent open `next_steps` across all your projects - your instant to-do list. |
| `search_memories` | Full-text keyword search across all sessions and facts. |
| `semantic_search` | Embedding-based search - finds related context even without exact keyword matches. |
| `get_project` | Load full history for a project - all prior sessions in one call. |
| `list_projects` | See all known projects with session counts and last activity. |
| `add_fact` | Store a persistent fact (preference, config, decision) not tied to a session. |
| `edit_session` | Update fields on an existing session by local ID. |

---

## What to Try First

Ask your AI (Claude Code, Claude Desktop, Copilot, Cursor, or Codex) at the start of a session:

> *"Run get_orientation for this project."*

After a session:

> *"Dump this session to What Next."*

After exploring a new codebase:

> *"Save what you learned about the structure with update_project_intelligence."*

It handles the rest - writes the context card, updates the file, syncs to cloud.

---

## Optional: `wn` CLI

A terminal-native interface to What Next. Talks to the local REST API at `localhost:3747`.

```bash
npm link   # one-time - makes wn available in any terminal
```

```bash
wn context                  # full brain dump - projects, sessions, facts
wn next                     # open next steps across all projects
wn projects                 # list all projects
wn project <name>           # full session history for a project
wn search "supabase auth"   # hybrid search across all memories
wn dump                     # save a session (auto-detects current git repo)
wn fact "always use conventional commits"
wn status                   # local API health + cloud sync status
wn open                     # open the web UI in your browser
wn install --client codex --key bak_xxx
```

Short aliases: `ctx`, `n`, `ps`, `p`, `s`, `d`, `f`, `i`. Colour output is TTY-aware.

---

## Optional: Hermes (Telegram Bot)

If you're running [Hermes](https://github.com/Danz0zn17/hermes) as your AI Telegram bot, add What Next to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  what-next:
    command: node
    args: ["~/what-next/bin/bootstrap-entry.js", "src/server.js", "mcp"]
    timeout: 30
    env:
      WHATNEXT_PREFER_LOCAL: "1"
      WHATNEXT_CLOUD_SYNC_MODE: "background"
      WHATNEXT_CLOUD_URL: "https://what-next-production.up.railway.app"
      WHATNEXT_API_KEY: "your_api_key_here"
```

**Model fallback - never get cut off mid-session**

When your primary model hits a rate limit or runs out of credits, Hermes falls through a chain of alternatives automatically. OpenRouter's `:free` models require no credits at all.

```yaml
model:
  default: "anthropic/claude-sonnet-4-5"
  provider: "openrouter"

fallback_chain:
  - provider: "openrouter"
    model: "deepseek/deepseek-chat-v3-0324:free"
    api_key_env: "OPENROUTER_API_KEY"
  - provider: "openrouter"
    model: "meta-llama/llama-3.3-70b-instruct:free"
    api_key_env: "OPENROUTER_API_KEY"
  - provider: "custom"
    model: "claude-haiku-4-5-20251001"
    base_url: "https://api.anthropic.com/v1"
    api_key_env: "ANTHROPIC_API_KEY"
  - provider: "google-gemini"
    model: "gemini-2.5-flash"
    api_key_env: "GEMINI_API_KEY"
```

**Tech Radar (optional daily digest)**

What Next ships with a daily tech radar cron job for Hermes. Every morning at 06:00 it scans Hacker News and Reddit for AI/MCP/agent news and sends a Telegram digest.

Add to `~/.hermes/cron/jobs.json`:

```json
[
  {
    "id": "tech-radar-daily",
    "name": "Daily Tech Radar",
    "prompt": "Run the tech-radar skill: scan HN + Reddit for AI/MCP/agent news, score relevance, send a 3-item Telegram digest with implement hooks.",
    "schedule": "0 6 * * *",
    "deliver": "origin",
    "enabled": true,
    "created_at": "2026-01-01T06:00:00Z"
  }
]
```

---

## Troubleshooting

**Tools don't appear in Claude/VS Code**
- Restart the app completely after running the installer - MCP config is read at startup only
- Check the path: `~/what-next/bin/bootstrap-entry.js` - if you cloned elsewhere, update the path
- Make sure `WHATNEXT_API_KEY` is set to your key
- On Windows, use an absolute path like `C:\Users\<you>\what-next\bin\bootstrap-entry.js`

**Claude Code: dump_session causes permission prompts**
- This means a subagent or Bash curl is being used instead of the direct MCP call
- In your CLAUDE.md, add: "Always call `mcp__what-next__dump_session` directly as a tool call. NEVER use the Agent tool to delegate a dump."
- The MCP tool is auto-approved; Bash curl is not

**Linux: MCP tools not appearing after install**
- The installer writes to `~/.config/Claude/claude_desktop_config.json` by default
- Override with: `XDG_CONFIG_HOME=/path/to/your/config node bin/install.js --client claude --key bak_xxx`
- For VS Code on Linux, `~/.config/Code/User/mcp.json` is the standard path

**"Invalid or missing API key" errors**
- Your API key is wrong or missing from the config env block
- Double-check you replaced `your_api_key_here` with the actual key from your welcome email

**Session not syncing to cloud**
- Local SQLite is still the primary store - your dump already succeeded locally
- Cloud sync is backup-only and retries in the background
- Check logs: `tail -n 40 ~/Library/Logs/what-next/mcp-audit.log`

**`search_memories` returns nothing for certain queries**
- Postgres full-text search rejects special characters like `:`, `(`, `)`, `!`, `@`
- Handled automatically server-side since v0.1.1 - update to the latest version
- Workaround on older versions: use plain words without punctuation

**Hermes: "Resource deadlock avoided" on macOS**
- Fixed in `file_operations.py` since v0.1.1
- If still occurring: `launchctl stop ai.hermes.gateway && launchctl start ai.hermes.gateway`

**Local service health check**
```bash
curl http://localhost:3747/health
curl http://localhost:3747/context
curl "http://localhost:3747/whats-next"
curl "http://localhost:3747/hybrid-search?q=auth+bug"
curl "http://localhost:3747/sync/status"
```

If the local service is down:
- macOS: `launchctl start com.whatnextai.api`
- Windows: `node "$env:USERPROFILE\what-next\bin\local-api.js"`
- Linux: `node ~/what-next/bin/local-api.js`

**macOS self-healing on boot:** The LaunchAgent runs `start-api.sh` on every login. If source code is missing it restores from GitHub; if node_modules are gone it runs `npm install`. What Next is resilient to accidental deletions.

**dump_session is slow or hangs**
1. Check logs: `tail -n 40 ~/Library/Logs/what-next/bootstrap.log`
2. If it keeps hanging: start a new chat - VS Code/Claude spawns a fresh MCP process per conversation
3. Check local API: `curl http://localhost:3747/health`

**macOS auto-watchdog (Hermes users)**
```bash
launchctl list com.hermes.healthcheck       # check watchdog status
cat ~/Library/Logs/hermes/health.log | tail -30
cd ~/Documents/projects/hermes && npm run health   # manual health check
```

**Cloud health check**
```bash
curl https://what-next-production.up.railway.app/health
curl -H "x-api-key: your_key" https://what-next-production.up.railway.app/stats
```

---

## Privacy & Data

What Next stores **only what your AI explicitly saves**: session summaries, facts, and any feedback you choose to send via the `send_feedback` tool. No passive telemetry, no error snooping, no tracking of any kind.

All data is isolated to your API key and stored in a private Postgres database on Railway. To request a full delete, email support@greenberries.co.za.

---

## Stack

Node.js - SQLite - Postgres - MCP SDK - Railway - LaunchAgent (macOS) / Task Scheduler (Windows) / systemd (Linux optional)
