# what-next - Claude Code Instructions

## Project Overview
What Next is Danny's persistent AI memory engine and MCP server product. Public repo at github.com/Danz0zn17/what-next. Live at whatnextai.co.za. This is a real product with customers.

## Stack
- Node.js (MCP server + REST API)
- SQLite (local source of truth) + Postgres on Railway (cloud backup)
- Netlify (landing page at `landing/`)
- VS Code extension at `vscode-extension/`
- LaunchAgent `com.whatnextai.api` (macOS, KeepAlive)
- MCP server spawned on demand via `bin/bootstrap-entry.js`

## Key Dirs
- `src/server.js` - MCP server entry point
- `src/api-server.js` - REST API on localhost:3747
- `src/db.js` - SQLite schema and queries
- `src/sidecar.js` - Smart Context Card generator
- `src/watcher.js` - git commit watcher
- `landing/` - static website served on Netlify
- `vscode-extension/` - VS Code context panel extension
- `bin/` - CLI entry points and installer scripts

## Env Vars
- `WHATNEXT_DATA_DIR` - path to local data directory
- `WHATNEXT_API_KEY` - API key for auth
- `WHATNEXT_CLOUD_URL` - Railway Postgres cloud endpoint
- `WHATNEXT_PREFER_LOCAL` - always 1 in production
- `WHATNEXT_CLOUD_SYNC_MODE` - always "background"

## Key Patterns
- Local SQLite writes first, cloud sync queued in background - never block on cloud
- MCP tools timeout after 15s (v1.3.0+) - all handlers must be fast
- `dump_session` in Claude Code must be called directly as MCP tool, NOT via Agent tool or Bash curl
- Smart Context Cards at `~/.whatnext/agents/{project}.md` - auto-generated, never manually edited
- The what-next MCP server itself is NOT used here during development (avoid recursive MCP calls)

## This Is a Public Repo
Changes pushed to main are visible to customers. README is customer-facing docs. Landing page is the product website. Always commit with clean, descriptive messages. Check CHANGELOG before pushing features.

## Conventions
- Conventional commits: feat|fix|chore|docs|refactor|test|security
- Always commit with --no-verify (run tsc + eslint manually first)
- Version in package.json and McpServer version field must match before tagging
- CHANGELOG.md must be updated before any version bump

## Templates
- Design standards: `~/.claude/templates/design-standards.md` (for landing page work)
- React/Vite: `~/.claude/templates/react-vite.md` (for VS Code extension if applicable)
