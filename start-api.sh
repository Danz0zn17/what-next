#!/bin/zsh
# What Next — API startup wrapper
# Called by the com.whatnextai.api LaunchAgent on every boot and crash-restart.
# Designed to be fully self-healing — no manual intervention needed.

export HOME=/Users/danz0-home
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export WHATNEXT_PREFER_LOCAL=1
export WHATNEXT_CLOUD_SYNC_MODE=background
export WHATNEXT_BOOT_RETRIES=12
export WHATNEXT_BOOT_DELAY_MS=750

WHATNEXT_ROOT=/Users/danz0-home/Documents/projects/what-next

echo "[start-api.sh] Starting, PID=$$, date=$(date)" >&2

# ── 1. Self-heal: restore source if directory is empty or src/ is missing ──────
if [[ ! -f "$WHATNEXT_ROOT/src/api-server.js" ]]; then
  echo "[start-api.sh] src/api-server.js missing — attempting git restore" >&2
  cd "$WHATNEXT_ROOT"
  if [[ -d ".git" ]]; then
    git fetch --quiet 2>&1 && git checkout main --force 2>&1
  else
    git init 2>&1
    git remote add origin https://github.com/Danz0zn17/what-next.git 2>&1 || true
    git fetch --quiet 2>&1 && git checkout main 2>&1
  fi
  if [[ ! -f "$WHATNEXT_ROOT/src/api-server.js" ]]; then
    echo "[start-api.sh] FATAL: git restore failed — cannot start" >&2
    exit 1
  fi
  echo "[start-api.sh] Source restored from GitHub" >&2
fi

# ── 2. Self-heal: install dependencies if node_modules is missing ──────────────
if [[ ! -d "$WHATNEXT_ROOT/node_modules/better-sqlite3" ]]; then
  echo "[start-api.sh] node_modules missing — running npm install" >&2
  cd "$WHATNEXT_ROOT" && npm install --quiet 2>&1
fi

# ── 3. Self-heal: initialise DB if it does not exist ──────────────────────────
if [[ ! -f "$WHATNEXT_ROOT/data/what-next.db" ]]; then
  echo "[start-api.sh] DB missing — initialising schema" >&2
  cd "$WHATNEXT_ROOT"
  /opt/homebrew/bin/node -e "import('./src/db.js').then(() => { console.log('DB init OK'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); })" 2>&1
fi

# ── 4. Wait up to 15s for network (needed for cloud sync on fresh boot) ────────
for i in $(seq 1 15); do
  if /usr/bin/curl -sf --max-time 2 https://what-next-production.up.railway.app/health >/dev/null 2>&1; then
    echo "[start-api.sh] Network ready (attempt $i)" >&2
    break
  fi
  echo "[start-api.sh] Waiting for network... ($i/15)" >&2
  sleep 1
done

# ── 5. Start the server via bootstrap-entry.js (handles EAGAIN retry) ─────────
cd "$WHATNEXT_ROOT"
exec /opt/homebrew/bin/node bin/bootstrap-entry.js src/api-server.js api
