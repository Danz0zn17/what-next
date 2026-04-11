# Changelog

All notable changes to What Next are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
