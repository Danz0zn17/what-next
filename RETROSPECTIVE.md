# What Next — Retrospective & Reflections
*For Danny's eyes only. The unfiltered story of how this got built, what broke, and what we learned.*

---

## The Origin

What Next started as "bloody-agent" — a blunt, honest name that reflected its purpose: a persistent brain you could dump your sessions into so you never lost context between AI conversations. Every developer using Claude or ChatGPT was losing their history at the end of every session. The model forgot everything. You forgot what you decided. Projects stalled at the same decisions every time.

The first version was SQLite + a REST API. Simple. That was right. Don't start with complexity you don't need.

---

## Problem 1: The Rename (bloody-agent → what-next)

**What happened:** The project was renamed from `bloody-agent` to `what-next` midway through active use. The name change propagated inconsistently — the MCP server name changed, but the agent's `MEMORY.md`, `SOUL.md`, Hermes `.env`, and the LaunchAgent plist label all had different states. The Telegram bot kept calling `mcp_bloody_agent_*` tools that no longer existed.

**Root cause:** No single source of truth for the name. It existed in: MCP server name in config.yaml, LaunchAgent label, MEMORY.md injected into Telegram sessions, SOUL.md, Hermes tools.js env var names, VS Code mcp.json, Claude Desktop config, GitHub Copilot config.

**Fix:** Systematic grep across all config files. Rewrote MEMORY.md. Updated all env var prefixes to `WHATNEXT_*`.

**Lesson for What Next's brain:** When renaming a project, write a fact: `"Project bloody-agent renamed to what-next on [date]. All tool names, env vars, and config files must use what-next."` The brain should surface this when you start a new session on the project.

---

## Problem 2: The Railway Deployment

**What happened:** Railway CLI authentication was broken in a browserless environment. The CLI generates a login URL that expires in ~60 seconds, which isn't enough time to manually open a browser, navigate to Railway, and complete OAuth. UUID tokens from the dashboard were rejected with format errors.

**Root cause:** The Railway CLI was designed for interactive use, not for environments where you can't open a browser automatically. The dashboard token format changed and the CLI wasn't updated to accept it.

**Fix:** Abandoned the CLI entirely. Used the Railway dashboard for all configuration — added Postgres plugin, set env vars, mapped port manually, confirmed deployment via curl.

**Lesson:** When a tool's auth is broken, don't fight it. The dashboard route took 15 minutes. CLI debugging took 2 hours across two sessions. Identifying the dead end earlier saves tokens and time.

---

## Problem 3: Port 3747 — The EADDRINUSE Crash Loop

**What happened:** The LaunchAgent kept failing with `LastExitStatus = 19968` (exit code 78: EX_CONFIG). The actual error was EADDRINUSE — port 3747 in use. But because `KeepAlive: true` with no throttle, launchd was restarting the process every 1-2 seconds, which caused the OS to throttle it further, creating a crash loop.

**Root cause (layered):**
1. A manual test server was still running from earlier terminal sessions
2. No `ThrottleInterval` in the plist meant instant restart cycles
3. The EADDRINUSE error was being thrown but not retried — it just crashed

**Fix (also layered):**
1. Added `ThrottleInterval: 10` to the plist
2. Added EADDRINUSE retry logic in `api.js` (5-second retry instead of crash)
3. Added `dotenv` loading in `api-server.js` so `.env` is read when LaunchAgent starts without shell environment

**Lesson:** LaunchAgents never have your shell environment. They have a minimal PATH and no HOME, no dotfiles, nothing. Always test with `env -i HOME=... /path/to/node script.js` to simulate exactly what launchd sees.

---

## Problem 4: macOS Sandbox Blocking LaunchAgent (The Real Killer)

**What happened:** After all the EADDRINUSE fixes, the LaunchAgent continued exiting with code 78 even with the port free. No error was appearing in the log files — because the log files themselves were blocked.

**Root cause:** macOS App Sandbox / System Policy was denying the LaunchAgent:
- Read access to `~/Documents/projects/what-next/data/api.log` (the log file path in the plist)
- Read access to the shell script when it was located in `~/Documents/projects/`

This was visible only in the macOS system log (`log show`), not in the application logs. The process was being killed by `xpcproxy` before it could even write its first byte.

**Fix:**
1. Moved log paths from `data/` to `~/Library/Logs/what-next/` (standard location LaunchAgents are allowed to write)
2. Moved the shell wrapper script from `Documents/projects/` to `~/Library/LaunchAgents/what-next-start.sh` (same directory as the plist — always accessible)

**Lesson:** LaunchAgent log paths must be in `~/Library/Logs/` — not in your project folder. Shell scripts must live in `~/Library/LaunchAgents/` or `/usr/local/bin/`. `Documents/projects/` is sandbox-restricted for spawned processes. Always check `log show --last 5m | grep "your-service-name"` first when debugging a LaunchAgent — the real error is there, not in your app logs.

**Diagnostic command to save and reuse:**
```bash
log show --last 2m | grep -i "your.service.name\|xpcproxy\|Sandbox"
```

---

## Problem 5: MCP Server Name Drift in Agent Memory

**What happened:** The Telegram bot's `MEMORY.md` (injected into every session) still referenced `bloody-agent` with old REST API paths and old MCP tool names (`mcp_bloody_agent_*`). This caused the agent to call non-existent tools and fall back to confusion every session.

**Root cause:** The MEMORY.md is managed by the agent itself, and it hadn't been updated when the project was renamed. It predated the rename.

**Fix:** Manually rewrote MEMORY.md with correct `what-next` references, cloud URL, and correct MCP tool names (`mcp_what_next_*`).

**Lesson:** When the agent's own memory contains stale instructions, it will confidently do the wrong thing. The brain's memory needs to be versioned or at minimum have a "last verified" date on critical facts.

---

## Problem 6: Hermes Node.js Had No Git History

**What happened:** The Node.js Hermes agent (`~/Documents/projects/hermes/`) had no git repository. Changes to `tools.js`, `memory.js`, `router.js`, `.env` lived only on disk with no history, no rollback, no remote backup.

**Root cause:** The project was built quickly as a utility — no `git init` was done.

**Lesson:** Every project folder gets `git init` on day one. Even a solo utility. Especially when it contains your AI agent's brain wiring.

**Status:** Still needs to be addressed — `git init ~/Documents/projects/hermes && git remote add origin ...`

---

## Architecture Decisions We Got Right

**SQLite + Postgres dual-layer:** Running SQLite locally with Postgres in the cloud means:
- Zero latency local reads (SQLite is in-process)
- Cloud persistence for mobile/offline access
- Write-through means local and cloud stay in sync
- Gist buffer for truly offline scenarios

This was the right call. Don't abandon it for "just use Postgres everywhere" — the local SQLite layer is why the tool is instant.

**Write-through cloud-first, fallback to local reads:** The MCP server writes to cloud first, then local. If cloud fails, local still works. This is resilient and correct.

**MCP protocol over REST for desktop AI tools:** Claude Desktop, VS Code, GitHub Copilot all speak MCP natively. Choosing MCP as the primary interface means What Next works as a first-class citizen in every AI tool without any special glue code.

**LaunchAgent over manual startup:** Getting the LaunchAgent right took 3 sessions of debugging but it's worth it. The server is now always-on, cloud-connected, and survives reboots. Users who give up on this step miss out on the whole "persistent brain" value proposition.

---

## What the Brain Should Learn From This

These facts should be stored in What Next and surfaced automatically:

1. **LaunchAgent logs must be in `~/Library/Logs/`** — not in project directories
2. **LaunchAgent scripts must be in `~/Library/LaunchAgents/` or `/usr/local/bin/`** — not in `Documents/`
3. **Always test LaunchAgent env with `env -i HOME=...`** before fighting `launchctl`
4. **`log show --last 2m | grep service-name`** is the only real LaunchAgent debugger
5. **Railway CLI auth is broken in browserless environments** — use dashboard
6. **Rename a project? Update: MCP config, plist label, env var prefixes, MEMORY.md, SOUL.md, all 3 AI tool configs**
7. **Every new project directory needs `git init` on day one**

---

## The Bigger Picture

We're building the infrastructure layer for personal AI — the thing every AI tool needs but none of them provide: memory that persists across sessions, surfaces, and agents. The journey getting here was messy but the foundation is now solid:

- Local SQLite for speed
- Cloud Postgres for persistence and mobile
- MCP for desktop AI tool integration
- REST API for agent tool use (Hermes, Telegram)
- Gist buffer for offline resilience
- LaunchAgent for always-on availability

The stack is right. The patterns are right. The only thing left is polish, reach, and making it easy for others to use.

---

*Last updated: 8 April 2026*
*Sessions that contributed to this: ~15 sessions across 5 weeks*
*Tokens spent debugging the LaunchAgent alone: estimated 50,000+*
