# What Next

**Your AI second brain.** What Next keeps context across every AI tool you use. When you start a new conversation — in Claude, VS Code Copilot, or anywhere else — it already knows what you were building, what decisions you made, and what comes next.

No more copy-pasting context. No more re-explaining your stack. It just knows.

---

## How It Works

What Next runs a local MCP server on your Mac. Every AI tool connects to it. When you finish a session, your AI dumps a summary. When you start a new one, it loads it back. All of it synced to the cloud so your memory is safe even if your machine dies.

```
Your AI tools  ──MCP──►  What Next (local)  ──HTTPS──►  Cloud (Railway)
(Claude, VS Code,         runs on your Mac               Postgres, isolated
 Copilot, Hermes)         SQLite cache                   per API key
```

---

## Prerequisites

- **macOS** (Apple Silicon or Intel — tested on macOS 14+)
- **Node.js 20+** — install via [nodejs.org](https://nodejs.org) or `brew install node`
- **Claude Desktop** and/or **VS Code with GitHub Copilot** — at least one AI surface

---

## Setup (2 minutes)

**1. Clone the repo**

```bash
git clone https://github.com/Danz0zn17/what-next.git ~/what-next
cd ~/what-next && npm install
```

**2. Add to Claude Desktop**

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

**3. Add to VS Code / GitHub Copilot**

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

**4. Restart Claude Desktop / VS Code**

What Next will appear as an available MCP tool. You'll see tools like `dump_session`, `get_project`, `search_memories` in your AI's tool list.

---

## Available Tools

Once connected, your AI can use these tools automatically:

| Tool | What it does |
|---|---|
| `dump_session` | Save a summary of the current session — what was built, decisions made, next steps |
| `get_project` | Load full history for a project — all prior sessions in one call |
| `list_projects` | See all known projects with session counts and last activity |
| `search_memories` | Full-text search across all sessions and facts |
| `add_fact` | Store a persistent fact (preference, config, decision) that isn't tied to a session |
| `semantic_search` | Embedding-based search — finds related context even without exact keyword matches |

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
- Restart the app after editing the config
- Check the path: `~/what-next/src/server.js` — if you cloned somewhere else, update the path
- Make sure `WHATNEXT_API_KEY` is set to your key (from the welcome email)

**"Invalid or missing API key" errors**
- Your API key is wrong or missing from the config env block
- Double-check you replaced `your_api_key_here` with the actual key

**Session not syncing to cloud**
- Check your Internet connection
- The local SQLite still works offline — it'll sync next time

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

---

## Privacy & Data

What Next stores **only what your AI explicitly saves**: session summaries, facts, and any feedback you choose to send via the `send_feedback` tool. No passive telemetry, no error snooping, no tracking of any kind.

All data is isolated to your API key and stored in a private Postgres database on Railway. To request a full delete, email danny@greenberries.co.za.

---

## Stack

Node.js · SQLite · Postgres · MCP SDK · Railway · macOS LaunchAgent

