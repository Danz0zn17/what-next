---
name: what_next
description: Persistent project memory across conversations. Save work sessions, decisions, and facts to What Next. Recall project history and context from past sessions. Use when starting work on a named project, finishing a meaningful task, or storing a key technical insight.
homepage: https://whatnextai.co.za
metadata: {"openclaw": {"emoji": "🧠", "requires": {"bins": ["curl"]}}}
---

# What Next — Persistent Project Memory

What Next runs locally at `http://localhost:${WHATNEXT_PORT:-3747}`. It stores structured memory across all AI sessions so context is never lost between conversations.

## When to use

**On session start** — If the user mentions a project by name or asks "what was I working on?", fetch context first:

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/search?q=PROJECT_NAME&limit=3"
```

Or get the full context brief (recent sessions + all facts + project list):

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/context"
```

**On session end** — After completing meaningful work (feature built, bug fixed, decision made), proactively save the session without being asked:

```bash
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/session" \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "project-name",
    "summary": "2-3 sentence summary of what happened",
    "what_was_built": "specific files, features, or components changed",
    "decisions": "key architectural or design choices and why",
    "stack": "comma-separated technologies used",
    "next_steps": "what to pick up next session",
    "tags": "comma,separated,tags"
  }'
```

**To store a fact** — When the user wants to remember a preference, pattern, or decision permanently:

```bash
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/fact" \
  -H 'Content-Type: application/json' \
  -d '{
    "category": "preference",
    "content": "The fact or insight",
    "project": "optional-project-name",
    "tags": "optional,tags",
    "source": "where it came from (optional)",
    "volatility": "volatile"
  }'
```

Use `"volatility": "volatile"` for anything that changes in the real world (contacts, prices, URLs, deploy targets, status); it goes stale after `ttl_days` (default 30). Tag a fact `role:engineer` (or `ceo`, `qa`, `growth`, `ops`) to put it in that role's start-up block.

**Stale and disputed facts** — A fact shown with `[STALE ...]` has not been checked recently; one with `[DISPUTED ...]` was reported wrong. Do not act on either as true: check it against the real system first, then record the result:

```bash
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/fact/FACT_ID/verify" -H 'Content-Type: application/json' -d '{"note": "checked in Netlify"}'
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/fact/FACT_ID/retire"  -H 'Content-Type: application/json' -d '{"note": "site moved"}'
```

**When a memory was wrong** — Mark it, with the correct text if you know it. The next dreaming pass replaces it:

```bash
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/fact/FACT_ID/dispute" \
  -H 'Content-Type: application/json' \
  -d '{"note": "what was wrong", "correction": "the correct fact"}'
```

**Role start-up block** — A short (max 30 lines) brief for your job instead of everything:

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/context?role=engineer"          # role_block field
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/orientation/PROJECT?role=qa"
```

**Client and product pages** — Repo, hosting, database, live or not, open issues, last decision, links:

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/pages"
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/page/surf-rides"
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/page" -H 'Content-Type: application/json' \
  -d '{"slug": "surf-rides", "kind": "product", "fields": {"live": "yes", "hosting": "Netlify site surf-rides"}, "links": ["surf-rides-co"]}'
```

**To get full project history** — When the user wants everything about a specific project:

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/project/PROJECT-NAME"
```

**To see open action items** — What to work on next across all projects:

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/whats-next"
```

**To curate memory** — Archive near-duplicate facts non-destructively (runs daily on its own; `"dry_run": true` previews without changing anything):

```bash
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/curate" \
  -H 'Content-Type: application/json' \
  -d '{"dry_run": true}'
```

**To run the dreaming pass** — Fixes disputed facts, merges duplicates, turns session lessons into facts, flags contradictions, lists facts due for re-check and refreshes pages. Preview first; every run can be undone:

```bash
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/curate/run" -H 'Content-Type: application/json' -d '{"dry_run": true}'
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/curate/run" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST "http://localhost:${WHATNEXT_PORT:-3747}/curate/undo" -H 'Content-Type: application/json' -d '{"run_id": 42}'
```

To help it, write lasting lessons in a session as `Lesson: ...` or `Gotcha: ...`.

**To search with hybrid ranking** — Better than plain keyword search (FTS5 + semantic RRF):

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/hybrid-search?q=QUERY&limit=5"
```

**To edit an existing session** — Correct or extend a previously saved session:

```bash
curl -s -X PATCH "http://localhost:${WHATNEXT_PORT:-3747}/session/SESSION_ID" \
  -H 'Content-Type: application/json' \
  -d '{"next_steps": "updated next steps"}'
```

## Field reference

`POST /session`:
- `project` (required) — matches the project folder name exactly (e.g. `my-saas-app`)
- `summary` (required) — 2–3 sentence session summary
- `what_was_built` — specific files, features, or components created/changed
- `decisions` — architectural or design choices made and reasoning
- `stack` — comma-separated technologies (e.g. `React,Supabase,Tailwind`)
- `next_steps` — what to pick up next session
- `tags` — comma-separated tags (e.g. `auth,api,bug-fix`)

`POST /fact` categories: `preference`, `pattern`, `lesson`, `stack-choice`, `client` (written as `Name: details`, seeds a client page), `deploy`, `contact`, `pricing`. Optional: `source`, `volatility` (`stable` | `volatile`), `ttl_days`.

## Notes

- Only save when something real was built, decided, or learned — skip casual exchanges
- Save what the next agent would need to avoid redoing work or repeating a mistake
- If curl returns "connection refused", the user needs to start What Next: `launchctl start com.whatnextai.api`
- Session data is also synced to cloud automatically when the user has a What Next API key configured
