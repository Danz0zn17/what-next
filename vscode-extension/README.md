# What Next

**Persistent AI memory for your codebase.**  
Every session starts oriented - no re-explaining, no cold start.

---

## What it does

What Next runs a local memory engine that learns from every session you save and every git commit you push. It surfaces that context instantly to Claude, Copilot, Cursor, and Codex so every session starts fully oriented.

This extension connects VS Code to your local What Next API and gives you a sidebar panel showing your project's stack, recent sessions, open tasks, and recent commits - all in one place.

---

## Requirements

The What Next local API must be running. Install it:

```
npm install -g whatnext-ai
```

Then start the API server (runs as a LaunchAgent on macOS):

```
launchctl start com.whatnextai.api
```

---

## Commands

| Command | Description |
|---|---|
| `What Next: Save Session` | Save a session summary and next steps for the current project |
| `What Next: Get Orientation` | Load the current project's context into the sidebar |
| `What Next: Open Context Card` | Open the project's context card markdown file |
| `What Next: What's Next?` | Show open tasks across all projects |
| `What Next: Show Status` | Show API status and detected project |

---

## Status bar

The status bar item in the bottom right shows the current API state:

- `WN offline` - local API is not running
- `WN unsaved` - API online, no session saved this session
- `WN saved Xm ago` - session saved, shows time since last save

Click the status bar item to save a session.

---

## Sidebar panel

Open the What Next panel from the activity bar (the ring icon). It shows:

- **Stack** - tech stack pills from your stored project intelligence
- **Open Tasks** - next steps from your last session
- **Recent Sessions** - last 3 session summaries with dates
- **Recent Commits** - last 5 git commits captured by the watcher
- **Context Card** - raw markdown context card preview

---

## Beta

What Next is in private beta. Request access at [whatnextai.co.za](https://whatnextai.co.za).

---

Built by [Greenberries](https://greenberries.co.za)
