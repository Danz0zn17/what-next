# Agent Blue — Personal MCP Knowledge Server

A local MCP server that gives your AI coding tools (Claude Code, GitHub Copilot)
persistent memory of your projects, decisions, and patterns — across every session.

Works on macOS and Linux. No cloud, no API keys, no personal data leaves your machine.

---

## What it does

Every time you work with Claude Code or GitHub Copilot, the agent:
- **Loads context** at the start of a session (what you built before, what decisions you made)
- **Saves a summary** at the end of a session automatically
- **Answers questions** like "what did I do with authentication last time?"

Over time it becomes a genuine second brain — the more you use it, the more useful it gets.

---

## Prerequisites

- **Node.js LTS** — https://nodejs.org
- **VS Code** with Claude Code extension and/or GitHub Copilot extension

---

## Setup

### 1. Run the bootstrap script

```bash
bash bootstrap.sh
```

The script will ask you:
- What to call your agent (default: `agent-blue`)
- Where your projects folder is (default: `~/Documents/projects`)
- Which port to use (default: `3748`)

It then automatically:
- Creates the agent project with all source files
- Installs dependencies
- Registers the MCP server with Claude Code (`~/.claude/claude.json`)
- Creates standing instructions for Claude Code (`~/.claude/CLAUDE.md`)
- Creates standing instructions for GitHub Copilot (`~/.github/copilot-instructions.md`)
- Sets up auto-start at login (macOS LaunchAgent / Linux systemd)
- Starts the web UI

### 2. Add MCP to VS Code (for GitHub Copilot agent mode)

`Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux) → **Open User Settings JSON**

Add this before the last `}` (replace values with what the script printed):

```json
,
"mcp": {
  "servers": {
    "agent-blue": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/agent-blue/src/server.js"]
    }
  }
}
```

The script prints the exact values to paste at the end of setup.

### 3. ChatGPT setup (optional but recommended)

Open **http://localhost:3748/setup** in your browser. Two steps:
1. Paste the provided text into ChatGPT Custom Instructions
2. Drag the bookmarklet to your bookmarks bar

After that: finish a ChatGPT session → click the bookmarklet → brain updated.

### 4. Import your ChatGPT history (optional)

- chatgpt.com → top-right menu → Settings → Data Controls → **Export data**
- Wait for the email, download the ZIP, unzip it, find `conversations.json`
- Open **http://localhost:3748** → **Import ChatGPT** tab → drag the file in

---

## Daily workflow

| Tool | What happens automatically |
|---|---|
| Claude Code | Loads project context at start, saves summary at end |
| GitHub Copilot | Same — reads the same standing instructions |
| ChatGPT | Click bookmarklet at end of session to save |

**Saying any of these triggers an automatic brain dump:**
> done, thank you, thanks, cheers, bye, goodbye, see you, that's all, wrap up,
> wrapping up, signing off, calling it, enough for today, let's stop here

---

## Web UI

Open **http://localhost:3748** (or whichever port you chose) to:
- Browse all your projects and sessions
- Search across your entire history
- Manually add session notes or facts
- Import ChatGPT history

---

## MCP Tools (available in every AI session)

| Tool | What it does |
|---|---|
| `dump_session` | Save a session summary to the brain |
| `search_memories` | Full-text search across all history |
| `get_project` | Full session history for one project |
| `list_projects` | All known projects at a glance |
| `add_fact` | Store a preference, pattern, or lesson |

---

## File locations (after setup)

| Item | Location |
|---|---|
| Agent source | `~/Documents/projects/agent-blue/` (or your chosen path) |
| Database | `agent-blue/data/agent.db` |
| Logs | `agent-blue/data/api-error.log` |
| MCP config | `~/.claude/claude.json` |
| Claude instructions | `~/.claude/CLAUDE.md` |
| Copilot instructions | `~/.github/copilot-instructions.md` |

---

## Notes

- The database is a single SQLite file. Back it up the same way you back up your projects.
- The agent runs entirely locally. Nothing is sent to any external service.
- No API keys or credentials are required or stored.
- The bootstrap script contains no personal data and is safe to share.
