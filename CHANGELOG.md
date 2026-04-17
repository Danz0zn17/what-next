# Changelog

All notable changes to What Next are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [1.7.1] - 2026-04-17

### Fixed
- **`repairDeps` now does a network install for missing native binaries**: previously always used `--prefer-offline`, which could restore the same incomplete tarball from cache and silently fail all 12 retries. Now detects `.node` binary errors specifically and skips the cache entirely, going straight to a network install. Regular missing JS modules still try offline first with network fallback.
- **`postinstall` now verifies the onnxruntime native binding landed**: any `npm install` that does not produce `onnxruntime_binding.node` for the current platform/arch fails immediately with a clear error message instead of letting users discover it at MCP startup.

---

## [1.7.0] - 2026-04-17

### Added
- **Bootstrap self-healing for corrupt/missing node_modules**: `bin/bootstrap-entry.js` now detects `ERR_MODULE_NOT_FOUND` on the first startup attempt, automatically runs `npm install --prefer-offline --no-audit`, and retries. Prevents silent breakage from partially extracted packages or interrupted installs.
- **Dep integrity check in watchdog**: `bin/healthcheck.js` verifies the MCP SDK marker file exists before checking the API process. If missing, runs `npm install` to restore deps before the REST API health check.
- **Test: bootstrap self-heal**: `test/bootstrap-selfheal.test.js` covers `ERR_MODULE_NOT_FOUND` detection, npm availability, and a full end-to-end corrupt-and-recover cycle.

### Changed
- **`dump_session` and `add_fact` cloud sync is now always background**: removed the blocking `await cloud.postSession()` / `await cloud.postFact()` code paths entirely. Cloud sync is always fire-and-forget via `setImmediate` — local SQLite write completes first, MCP response goes over stdio before the HTTP call starts. `PREFER_LOCAL` and `CLOUD_SYNC_MODE` env vars are no longer used for write paths.
- **`setImmediate` replaces `queueMicrotask` in background sync helpers**: `queueMicrotask` fires before I/O; `setImmediate` fires after, guaranteeing the response pipe flushes before cloud sync begins.

### Fixed
- Node_modules corruption no longer silently kills the MCP server until a human notices and runs `npm install` manually.

---

## [1.6.1] - 2026-04-17

### Fixed
- **Boot resilience after power failure**: `bootstrap-entry.js` now supports `WHATNEXT_BOOT_INITIAL_DELAY_MS` - a flat sleep before the first import attempt. Set to 25s in the LaunchAgent plist so the FS is stable before Node ESM loading begins. Also bumped default retries to 20 and retry base delay to 2000ms (~7 min total retry window).

---

## [1.6.0] - 2026-04-15

### Added
- **Self-healing LaunchAgent** (`start-api.sh`): 5-step recovery chain on every boot - git-restore source from GitHub if missing, npm install if node_modules gone, DB init if database absent, network wait up to 15s, then launch via bootstrap-entry.js
- **`bin/update-check.js`**: version comparison module - fetches latest GitHub release, compares semver, writes a one-time notice to stderr (flag file dedup so it only shows once per session). Called by `api-server.js` on startup
- **macOS LaunchAgent auto-setup in installer**: `node bin/install.js --client claude --key bak_xxx` now automatically writes `com.whatnextai.api.plist` to `~/Library/LaunchAgents/`, creates log dirs, and runs `launchctl load`. Safe to re-run (unloads old service first). Uses `start-api.sh` if present for full self-heal chain
- **Proactive Telegram health alerts** (`hermes/health-check.js` rewrite): Telegram notifications for service failures, disk warnings, recovery, and boot summary. Alert dedup via `/tmp` flag files. 45s grace period on boot to avoid false positives
- **DB integrity check on startup** (`api-server.js`): `PRAGMA quick_check` runs before serving any requests - crashes loudly if DB is corrupt so LaunchAgent restarts rather than serving bad data

### Fixed
- **onnxruntime native bindings crash**: `sync.js` and `api.js` now dynamically import `embeddings.js` with graceful degradation - vector indexing and semantic search are skipped cleanly when native bindings are missing, rather than crashing the server
- **False boot failures in health check**: replaced fixed 3s sleep after kickstart with 15s polling loop (1.5s interval), matching the actual bootstrap-entry.js retry window
- **Unregistered LaunchAgent kickstart**: health-check now loads the plist via `launchctl load` before retrying kickstart when a service is unregistered

### Changed
- LaunchAgent plist updated to invoke `bootstrap-entry.js` (EAGAIN retry wrapper) instead of `local-api.js` directly; `ThrottleInterval` raised to 15s; boot retry env vars added (`WHATNEXT_BOOT_RETRIES=12`, `WHATNEXT_BOOT_DELAY_MS=750`)
- `McpServer` version field bumped to `1.6.0`

---

## [1.5.1] — 2026-04-12

### Added
- `wn dump` now auto-detects the current git repo name as the default project (prompts `[repo-name]`)
- README: new `## Terminal CLI (wn)` section with full command reference
- Landing page: `wn` terminal CLI quick-start block in the Setup section

---

## [1.5.0] — 2026-04-12

### Added
- **`wn` CLI** — a terminal-native interface to What Next. No new dependencies — talks directly to the local REST API at `localhost:3747`. Available globally after `npm link`.
  - `wn context` — full brain dump (projects, recent sessions, facts)
  - `wn next` — open next steps across all projects
  - `wn projects` — list all projects with session counts
  - `wn project <name>` — full session history for one project
  - `wn search <query>` — hybrid search across all memories
  - `wn dump` — interactive session save (prompts for all fields)
  - `wn fact [content]` — store a persistent fact (inline or interactive)
  - `wn status` — local API health + cloud sync status
  - `wn open` — open the web UI in your default browser
  - `wn install --client <x> --key <k>` — delegates to the existing MCP installer
  - Aliases: `ctx`, `n`, `ps`, `p`, `s`, `d`, `f`, `i` for power users
  - TTY-aware colour output (auto-disabled when piped)

---

## [1.4.0] — 2026-04-12

### Added
- **OpenAI Codex support** — `--client codex` installer option writes What Next into `~/.codex/config.toml`, covering both the VS Code Codex extension (`openai.chatgpt`) and the Codex CLI agent. Both surfaces share the same config file, so one installer run connects both.
- **Safe TOML patching** — the installer reads the existing `~/.codex/config.toml` (preserving all other settings like `model`, `personality`, and plugins), appends the `[mcp_servers.what-next]` block, and cleanly replaces it on re-runs without touching anything else.
- **Landing page updated** — OpenAI Codex surface card added (Live), hero stat updated to 6 surfaces, setup code block includes `--client codex`.
- **README updated** — VS Code Codex and Codex CLI manual setup section added with TOML snippet.

---

## [1.3.0] — 2026-04-12

### Added
- **15-second tool timeout** — every MCP tool handler is now wrapped with `withTimeout()`. If a cloud call stalls, the tool returns a friendly error within 15s instead of hanging VS Code/Claude indefinitely. Slow responses (>3s) are logged as WARN to stderr.
- **Per-tool error logging** — all tool errors and timeouts are written to stderr with ISO timestamps and tool name, visible in `~/Library/Logs/what-next/api-error.log` when running via LaunchAgent.
- **Hermes health-check watchdog** (`hermes/src/health-check.js`) — checks the REST API (`localhost:3747`), cloud Railway endpoint, and Hermes gateway LaunchAgent every 5 minutes. Auto-kickstarts dead LaunchAgents and logs recovery status to `~/Library/Logs/hermes/health.log`.
- **`com.hermes.healthcheck` LaunchAgent** — registers the health watchdog to run at login + every 5 minutes with `KeepAlive` off (fire-and-forget cron style).
- **`npm run health` script in Hermes** — run the watchdog once manually from the terminal.

### Fixed
- **Security: `path-to-regexp` CVE** — updated transitive dependency to resolve 1 high + 2 moderate ReDoS vulnerabilities (GHSA-j3q9-mxjg-w52f, GHSA-27v5-c462-wpq7) in the Express router.

### Testing
- 4 new tests in `test/server-timeout.test.js` covering: successful pass-through, error catch with friendly message, timeout path, and arg forwarding.

---

## [1.2.0] — 2026-04-11

### Added
- **Hybrid search (RRF)** — `GET /hybrid-search?q=` merges FTS5 keyword rankings with local cosine similarity using Reciprocal Rank Fusion; `rrf_score` returned per result.
- **Edit session** — `PATCH /session/:id` (local and cloud) lets AI tools correct or extend an existing session without creating a duplicate; FTS5 index and embedding are refreshed automatically.
- **What's next** — `GET /whats-next` returns the most recent open `next_steps` per project; available as `whats_next` MCP tool and cloud endpoint.
- **Sync status** — `GET /sync/status` returns `last_cloud_sync` timestamp and pending gist count for self-diagnosis.
- **`edit_session` MCP tool** — update any field on a session from Claude, Copilot, or Hermes.
- **`whats_next` MCP tool** — surfaces open action items across all projects in one call.
- **Cross-platform CI baseline** — GitHub Actions workflow now runs baseline checks/tests so changes are validated before merge.
- **Linux `XDG_CONFIG_HOME` support** — installer now respects `$XDG_CONFIG_HOME` for Claude and VS Code config paths on Linux.

### Changed
- **Windows onboarding improved** — README and installer now include first-class Windows setup, PowerShell examples, and platform-specific guidance.
- **CORS** — local and cloud APIs now allow PATCH method.
- **Linux installer output** — post-install message shows the written config path and `XDG_CONFIG_HOME` override instructions.

### Testing
- Baseline test coverage added for core cross-platform/config/update-check behavior.
- 3 new tests for Linux XDG path resolution (default and custom `XDG_CONFIG_HOME`).

---

## [1.1.0] — 2026-04-11

### Added
- **Semantic / vector search** — sessions and facts are now embedded with pgvector on write; `semantic_search` MCP tool tries cloud pgvector first, falls back to local cosine similarity ([`f886ed9`](https://github.com/Danz0zn17/what-next/commit/f886ed9))
- **`POST /reindex`** — backfill embeddings for all existing sessions and facts ([`6f17671`](https://github.com/Danz0zn17/what-next/commit/6f17671))
- **`GET /health` on local API** — `curl http://localhost:3747/health` returns `{"ok":true,"service":"what-next-local"}` for self-diagnosis ([`43f7d67`](https://github.com/Danz0zn17/what-next/commit/43f7d67))
- **Update notifications in MCP server** — on startup the MCP server silently checks the latest GitHub release and logs a notice to stderr if a newer version is available; non-blocking, never delays tool calls
- **Telegram admin alerts** — new signups and feedback submissions trigger a Telegram message to the operator ([`64a519c`](https://github.com/Danz0zn17/what-next/commit/64a519c))
- **`GET /context` on local REST API** — same payload as the `get_context` MCP tool, available via curl for Hermes/Telegram self-diagnosis ([`bc76eed`](https://github.com/Danz0zn17/what-next/commit/bc76eed))

### Fixed
- CORS restricted to `localhost` origins only — no cross-origin access from external sites ([`d16bcf9`](https://github.com/Danz0zn17/what-next/commit/d16bcf9))
- Request body size capped at 64 KB to prevent abuse ([`d16bcf9`](https://github.com/Danz0zn17/what-next/commit/d16bcf9))
- API key comparison made timing-safe (prevents timing attacks) ([`e8b7dbd`](https://github.com/Danz0zn17/what-next/commit/e8b7dbd))
- Search result limit was uncapped — now enforced server-side ([`e8b7dbd`](https://github.com/Danz0zn17/what-next/commit/e8b7dbd))
- All `parseInt` calls now pass explicit radix 10 ([`d16bcf9`](https://github.com/Danz0zn17/what-next/commit/d16bcf9))
- Invalid JSON bodies now return 400 instead of crashing ([`d16bcf9`](https://github.com/Danz0zn17/what-next/commit/d16bcf9))
- Welcome email support address and GitHub links corrected ([`d6174dc`](https://github.com/Danz0zn17/what-next/commit/d6174dc))

### Docs
- README: local service health check added to troubleshooting section ([`a40c443`](https://github.com/Danz0zn17/what-next/commit/a40c443))
- README: badges, tagline, Hermes Telegram bot setup section ([`7b6eb7e`](https://github.com/Danz0zn17/what-next/commit/7b6eb7e))

---

## [1.0.0] — 2026-03-xx

### Added
- **MCP server** (`src/server.js`) — `dump_session`, `add_fact`, `search_memories`, `get_context`, `get_project`, `list_projects`, `send_feedback` tools
- **Local REST API + Web UI** (`src/api.js`) — persistent LaunchAgent at `http://localhost:3747`; browser UI for manual session dumps and search
- **Cloud sync** — write-through to Railway Postgres; periodic pull; offline-first with local SQLite cache
- **Multi-tenant cloud server** (`src/cloud-server.js`) — Postgres auth, per-user RLS, API key auth
- **`/export` endpoint** — download all your data as JSON
- **`/feedback` endpoint + `send_feedback` MCP tool** — privacy-transparent feedback channel
- **Cloud↔local sync** — `src/sync.js` periodic pull; `src/gist-client.js` GitHub Gist fallback
- **Landing page** — `public/` with OG image, Plausible analytics, security headers via `netlify.toml`
- **Rate limiting, security headers, body size limits** across cloud and local servers
- **Install script** — one-command setup for Claude Desktop, VS Code, and Hermes

### Fixed
- Schema initialisation split into individual queries to handle first-boot correctly
- Railway `railway.toml` start command pointed at correct entry file
- Welcome email paths use `~/what-next` (no hardcoded username)

---

[1.1.0]: https://github.com/Danz0zn17/what-next/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Danz0zn17/what-next/releases/tag/v1.0.0
