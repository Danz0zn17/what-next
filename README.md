# What Next — Persistent Second Brain

Danny's personal memory server. Stores all project sessions, facts, and context across every AI tool he uses.

## What It Is

A local MCP server + REST API that runs 24/7 on Danny's Mac. Every AI session — VS Code Copilot, Claude Desktop, Hermes (Telegram bot), and Node.js Hermes CLI — reads and writes to it so context is never lost between conversations or tools.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Danny's Mac                          │
│                                                             │
│  ┌──────────────┐   MCP stdio   ┌──────────────────────┐   │
│  │  VS Code     │ ◄────────────► │                      │   │
│  │  (Copilot)   │               │   what-next           │   │
│  └──────────────┘               │   MCP server          │   │
│                                 │   (src/server.js)     │   │
│  ┌──────────────┐   MCP stdio   │                       │   │
│  │ Claude       │ ◄────────────► │   SQLite DB           │   │
│  │ Desktop      │               │   (data/memory.db)    │   │
│  └──────────────┘               │                       │   │
│                                 │   REST API            │   │
│  ┌──────────────┐   REST :3747  │   (src/api-server.js) │   │
│  │ Hermes       │ ◄────────────►│                       │   │
│  │ (Python)     │               └──────────────────────┘   │
│  │ Telegram bot │                                           │
│  └──────────────┘                                           │
│                                                             │
│  ┌──────────────┐   REST :3747                             │
│  │ Hermes       │ ◄────────────►  same REST API            │
│  │ (Node.js CLI)│                                           │
│  └──────────────┘                                           │
│                                                             │
│  ┌──────────────┐   MCP stdio                              │
│  │ GitHub       │ ◄────────────►  same MCP server          │
│  │ Copilot CLI  │                                           │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

## Services & Auto-Start

Both services are registered as macOS LaunchAgents and start automatically at login with KeepAlive (auto-restart on crash):

| Service | LaunchAgent | Port/Transport |
|---|---|---|
| MCP server (`src/server.js`) | via VS Code / Claude Desktop / Copilot CLI (spawned on demand) | stdio |
| REST API (`src/api-server.js`) | `com.whatnextai.api` | `localhost:3747` |

## MCP Tools Available

| Tool | Description |
|---|---|
| `dump_session` | Save a session summary for a project |
| `get_project` | Load full session history for a project |
| `list_projects` | List all known projects |
| `add_fact` | Store a persistent fact |
| `search_memories` | Full-text search across sessions and facts |
| `semantic_search` | Vector similarity search (embedding-based) |
| `list_resources` / `read_resource` | Browse stored files/resources |
| `list_prompts` / `get_prompt` | Access stored prompt templates |

## REST API Endpoints (localhost:3747)

| Method | Path | Description |
|---|---|---|
| GET | `/projects` | List all projects |
| GET | `/project/:name` | Get project + sessions |
| POST | `/session` | Save a session |
| GET | `/search?q=` | Search sessions + facts |
| POST | `/fact` | Add a fact |
| GET | `/health` | Health check |

## Config Locations (per tool)

| Tool | Config File |
|---|---|
| VS Code | `~/Library/Application Support/Code/User/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Hermes (Python gateway) | `~/.hermes/config.yaml` → `mcp_servers.what-next` |
| GitHub Copilot CLI | `~/.config/github-copilot/mcp.json` |
| Node.js Hermes CLI | `~/Documents/projects/hermes/src/memory.js` → `localhost:3747` |

## Running Locally

```bash
# MCP server (spawned automatically by AI tools — no manual start needed)
npm start

# REST API (managed by LaunchAgent — no manual start needed)
npm run api

# Manually restart REST API if needed
launchctl stop com.whatnextai.api && launchctl start com.whatnextai.api
```

## Stack

- Node.js + `@modelcontextprotocol/sdk`
- SQLite (via `better-sqlite3`)
- Vector embeddings for semantic search
- macOS LaunchAgent for 24/7 uptime
