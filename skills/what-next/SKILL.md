---
name: what_next
description: Persistent project memory across conversations. Save work sessions, decisions, and facts to What Next. Recall project history and context from past sessions. Use when starting work on a named project, finishing a meaningful task, or storing a key technical insight.
homepage: https://whatnext.ai
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
    "tags": "optional,tags"
  }'
```

**To get full project history** — When the user wants everything about a specific project:

```bash
curl -s "http://localhost:${WHATNEXT_PORT:-3747}/project/PROJECT-NAME"
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

`POST /fact` categories: `preference`, `pattern`, `lesson`, `stack-choice`

## Notes

- Only save when something real was built, decided, or learned — skip casual exchanges
- If curl returns "connection refused", the user needs to start What Next: `launchctl start com.whatnextai.api`
- Session data is also synced to cloud automatically when the user has a What Next API key configured
