# What Next

> Persistent memory for AI, delivered over MCP.

[![License: MIT](https://img.shields.io/badge/license-MIT-6366f1.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-818cf8.svg)](https://modelcontextprotocol.io)
[![Railway](https://img.shields.io/badge/cloud-Railway-0B0D0E.svg)](https://railway.app)
[![whatnextai.co.za](https://img.shields.io/badge/site-whatnextai.co.za-22c55e.svg)](https://whatnextai.co.za)

**Your AI second brain.** What Next keeps context across every AI tool you use. When you start a new conversation — in Claude, VS Code Copilot, or anywhere else — it already knows what you were building, what decisions you made, and what comes next.

No more copy-pasting context. No more re-explaining your stack. It just knows.

---

## How It Works

What Next runs a local MCP server on your machine (macOS, Windows, or Linux). Every AI tool connects to it. When you finish a session, your AI dumps a summary. When you start a new one, it loads it back. All of it synced to the cloud so your memory is safe even if your machine dies.

```
Your AI tools  ──MCP──►  What Next (local)  ──HTTPS──►  Cloud (Railway)
(Claude, VS Code,         runs on your Mac               Postgres, isolated
 Copilot, Hermes)         SQLite cache                   per API key
```

---

## Prerequisites

- **macOS, Windows, or Linux**
- **Node.js 20+** — install via [nodejs.org](https://nodejs.org)
- **Claude Desktop** and/or **VS Code with GitHub Copilot** — at least one AI surface

---

## Setup (2 minutes)

**1. Clone the repo**

macOS / Linux:

```bash
git clone https://github.com/Danz0zn17/what-next.git ~/what-next
cd ~/what-next && npm install
```

Windows PowerShell:

```powershell
git clone https://github.com/Danz0zn17/what-next.git "$env:USERPROFILE\what-next"
cd "$env:USERPROFILE\what-next"
npm install
```

**2. Recommended: run the installer (all platforms)**

```bash
# Claude Desktop
node bin/install.js --client claude  --key bak_xxx
# VS Code / GitHub Copilot
node bin/install.js --client vscode  --key bak_xxx
# VS Code Codex extension or Codex CLI
node bin/install.js --client codex   --key bak_xxx
```

The installer writes the correct config file for your tool and OS automatically.

**3. Add to Claude Desktop (manual option)**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "what-next": {
      "command": "node",
      "args": ["~/what-next/src/server.js"],
      "env": {
        "WHATNEXT_CLOUD_URL": "https://what-next-production.up.railway.app",
        "WHATNEXT_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**4. Add to VS Code / GitHub Copilot (manual option)**

Edit `~/Library/Application Support/Code/User/mcp.json`:

```json
{
  "servers": {
    "what-next": {
      "command": "node",
      "args": ["~/what-next/src/server.js"],
      "env": {
        "WHATNEXT_CLOUD_URL": "https://what-next-production.up.railway.app",
        "WHATNEXT_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**4b. Add to VS Code Codex extension or Codex CLI (manual option)**

Both the VS Code Codex extension (`openai.chatgpt`) and the Codex CLI agent read the same file: `~/.codex/config.toml`. Append this block:

```toml
[mcp_servers.what-next]
command = "node"
args = ["/path/to/what-next/src/server.js"]
tool_timeout_sec = 20

[mcp_servers.what-next.env]
WHATNEXT_CLOUD_URL = "https://what-next-production.up.railway.app"
WHATNEXT_API_KEY = "your_api_key_here"
```

Replace `/path/to/what-next/src/server.js` with the absolute path where you cloned the repo.

**5. Restart Claude Desktop / VS Code**

What Next will appear as an available MCP tool. You'll see tools like `dump_session`, `get_project`, `search_memories` in your AI's tool list.

---

## Optional: `wn` CLI

A terminal-native interface to What Next. No new dependencies — talks to the local REST API at `localhost:3747`.

```bash
npm link   # one-time — makes wn available in any terminal
```

Then from anywhere:

```bash
wn context                  # full brain dump — projects, sessions, facts
wn next                     # open next steps across all projects
wn projects                 # list all projects
wn project <name>           # full session history for a project
wn search "supabase auth"   # hybrid search across all memories
wn dump                     # save a session interactively (auto-detects current git repo)
wn fact "always use conventional commits"
wn status                   # local API health + cloud sync status
wn open                     # open the web UI in your browser
wn install --client codex --key bak_xxx   # run the MCP installer
```

Short aliases: `ctx`, `n`, `ps`, `p`, `s`, `d`, `f`, `i`. Colour output is TTY-aware (auto-disabled when piping).

---

## Available Tools

Once connected, your AI can use these tools automatically:

| Tool | What it does |
|---|---|
| `get_context` | **Start here.** One call returns all projects, recent sessions, and facts — a full brain dump at session start |
| `dump_session` | Save a summary of the current session — what was built, decisions made, next steps |
| `edit_session` | Update fields on an existing session by local ID |
| `get_project` | Load full history for a project — all prior sessions in one call |
| `list_projects` | See all known projects with session counts and last activity |
| `search_memories` | Full-text keyword search across all sessions and facts |
| `add_fact` | Store a persistent fact (preference, config, decision) that isn't tied to a session |
| `semantic_search` | Embedding-based search — finds related context even without exact keyword matches |
| `whats_next` | See the most recent open `next_steps` across all your projects — your instant to-do list |

---

## What to Try First

Ask your AI (Claude or Copilot) at the start of any work session:

> *"Check What Next — what do you know about this project?"*

After a session, tell it:

> *"Dump this session to What Next."*

It handles the rest.

---

## Troubleshooting

**Tools don't appear in Claude/VS Code**
- Restart the app completely after running the installer — MCP config is only read at startup
- Check the path: `~/what-next/src/server.js` — if you cloned somewhere else, update the path
- Make sure `WHATNEXT_API_KEY` is set to your key (from the welcome email)
- On Windows, use an absolute path like `C:\Users\<you>\what-next\src\server.js`

**Linux: MCP tools not appearing after install**
- Claude Desktop on Linux is not officially supported — config paths vary by build
- The installer writes to `~/.config/Claude/claude_desktop_config.json` by default
- If your Claude Desktop uses a different location, override it:
  ```bash
  XDG_CONFIG_HOME=/path/to/your/config node bin/install.js --client claude --key bak_xxx
  ```
- Verify the file was written: `cat ~/.config/Claude/claude_desktop_config.json`
- Then fully restart Claude Desktop (quit + reopen)
- For VS Code on Linux, the path `~/.config/Code/User/mcp.json` is standard and should work

**"Invalid or missing API key" errors**
- Your API key is wrong or missing from the config env block
- Double-check you replaced `your_api_key_here` with the actual key

**Session not syncing to cloud**
- Check your Internet connection
- The local SQLite still works offline — it'll sync next time

**`search_memories` crashes or returns nothing for certain queries**
- Postgres full-text search rejects special characters like `:`, `(`, `)`, `!`, `@`
- This is handled automatically server-side since v0.1.1 — update to the latest version
- Workaround on older versions: use plain words without punctuation in search queries

**Hermes reads files and gets "Resource deadlock avoided" (macOS only)**
- macOS can deadlock PTY-based subprocess reads on certain `.md` files
- Fixed in `file_operations.py` since v0.1.1 — native Python reads are used first, shell only as fallback
- If still occurring, restart the Hermes gateway: `launchctl stop ai.hermes.gateway && launchctl start ai.hermes.gateway`

**Local service health check**
```bash
curl http://localhost:3747/health
# → {"ok":true,"service":"what-next-local"}
curl http://localhost:3747/context
# → recent sessions + facts (same as MCP get_context)
curl "http://localhost:3747/whats-next"
# → open next_steps per project
curl "http://localhost:3747/hybrid-search?q=auth+bug"
# → FTS + semantic RRF merged results
curl "http://localhost:3747/sync/status"
# → last_cloud_sync timestamp and pending gists count
```
If the local service is down:
- macOS: `launchctl start com.whatnextai.api`
- Windows PowerShell: `node "$env:USERPROFILE\what-next\src\api-server.js"`
- Linux: `node ~/what-next/src/api-server.js`

For always-on local API on Windows, create a Task Scheduler task that runs:
- Program/script: `node`
- Add arguments: `C:\Users\<you>\what-next\src\api-server.js`
- Trigger: At log on

**MCP tool hangs or `dump_session` is slow**

Since v1.3.0, every MCP tool enforces a **15-second timeout**. If the cloud is unreachable the tool returns a clear error message immediately — your data is always safe in local SQLite and available via the REST API.

If `dump_session` hangs in VS Code Copilot or Claude Desktop:
1. Wait — it will return an error within 15s (not forever)
2. If it keeps happening: **start a new chat** — VS Code/Claude spawns a fresh MCP stdio process per conversation
3. Check the MCP error log: `cat ~/Library/Logs/what-next/api-error.log | tail -20`
4. Check cloud reachability: `curl https://what-next-production.up.railway.app/health`

**macOS auto-watchdog (Hermes users)**

If you're running Hermes, the `com.hermes.healthcheck` LaunchAgent monitors the whole stack every 5 minutes and auto-restarts dead LaunchAgents:

```bash
# Check watchdog status
launchctl list com.hermes.healthcheck

# View watchdog log
cat ~/Library/Logs/hermes/health.log | tail -30

# Run a manual health check immediately
cd ~/Documents/projects/hermes && npm run health
```

**Cloud health check**
```bash
curl https://what-next-production.up.railway.app/health
# → {"ok":true,"service":"what-next-cloud"}
curl -H "x-api-key: your_key" https://what-next-production.up.railway.app/stats
# → {"sessions":N,"facts":N,"projects":N,...}
```

---

## Optional: Hermes (Telegram Bot)

If you're running [Hermes](https://github.com/Danz0zn17/hermes) as your AI Telegram bot, add What Next to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  what-next:
    command: node
    args: ["~/what-next/src/server.js"]
    timeout: 30
    env:
      WHATNEXT_CLOUD_URL: "https://what-next-production.up.railway.app"
      WHATNEXT_API_KEY: "your_api_key_here"
```

Hermes will then have access to the same memory tools on your phone via Telegram.

**Model fallback — never get cut off mid-session**

When your primary model hits a rate limit or runs out of credits, Hermes falls through a chain of alternatives automatically. The key insight: OpenRouter's `:free` models require no credits at all — they work even at a $0 balance, just with rate limits. Put them first in the chain so you always have a capable fallback that costs nothing.

Add this to `~/.hermes/config.yaml` under your existing model config:

```yaml
model:
  default: "anthropic/claude-sonnet-4-5"
  provider: "openrouter"

fallback_chain:
  # Free tier — no credits needed, works at $0 balance (rate-limited)
  - provider: "openrouter"
    model: "deepseek/deepseek-chat-v3-0324:free"
    api_key_env: "OPENROUTER_API_KEY"
  # Second free option if DeepSeek is rate-limited
  - provider: "openrouter"
    model: "meta-llama/llama-3.3-70b-instruct:free"
    api_key_env: "OPENROUTER_API_KEY"
  # Paid fallback — Claude Haiku via direct Anthropic API
  - provider: "custom"
    model: "claude-haiku-4-5-20251001"
    base_url: "https://api.anthropic.com/v1"
    api_key_env: "ANTHROPIC_API_KEY"
  # Last resort — Google Gemini direct
  - provider: "google-gemini"
    model: "gemini-2.5-flash"
    api_key_env: "GEMINI_API_KEY"
```

> **Why this matters:** Claude Code and Claude Desktop subscriptions are UI products — their credits cannot be shared with API-based tools like Hermes. The `:free` fallbacks ensure your Telegram bot stays capable even when paid credits on any provider are exhausted, without needing to top up immediately.

**Tech Radar (Hermes optional feature)**

What Next ships with a daily tech radar cron job for Hermes. Every morning at 06:00 it scans Hacker News, Reddit r/LocalLLaMA, and r/MachineLearning for AI/MCP/agent news, sends a Telegram digest, and lets you reply "implement 1" to auto-apply a suggestion.

To enable, add the job to `~/.hermes/cron/jobs.json`:

```json
[
  {
    "id": "tech-radar-daily",
    "name": "Daily Tech Radar",
    "prompt": "Run the tech-radar skill: scan HN + Reddit for AI/MCP/agent news, score relevance, send a 3-item Telegram digest with implement hooks.",
    "schedule": "0 6 * * *",
    "deliver": "origin",
    "enabled": true,
    "created_at": "2026-04-11T07:00:00Z"
  }
]
```

---

## Privacy & Data

What Next stores **only what your AI explicitly saves**: session summaries, facts, and any feedback you choose to send via the `send_feedback` tool. No passive telemetry, no error snooping, no tracking of any kind.

All data is isolated to your API key and stored in a private Postgres database on Railway. To request a full delete, email support@greenberries.co.za.

---

## Stack

Node.js · SQLite · Postgres · MCP SDK · Railway · LaunchAgent (macOS) / Task Scheduler (Windows) / systemd (Linux optional)

