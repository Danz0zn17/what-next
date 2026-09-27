#!/bin/zsh
# What Next - API startup wrapper
# Called by the com.whatnextai.api LaunchAgent on every boot and crash-restart.
# Works from wherever What Next is installed (npm global install or git clone):
# the root is this script's own directory, and HOME comes from launchd.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export WHATNEXT_PREFER_LOCAL="${WHATNEXT_PREFER_LOCAL:-1}"
export WHATNEXT_CLOUD_SYNC_MODE="${WHATNEXT_CLOUD_SYNC_MODE:-background}"
export WHATNEXT_BOOT_RETRIES="${WHATNEXT_BOOT_RETRIES:-12}"
export WHATNEXT_BOOT_DELAY_MS="${WHATNEXT_BOOT_DELAY_MS:-750}"

WHATNEXT_ROOT="${WHATNEXT_ROOT:-${0:A:h}}"
# Use the node that installed What Next: native modules (better-sqlite3, onnxruntime)
# are built for its ABI, and another node on PATH (e.g. a newer Homebrew one) cannot load them.
NODE="${WHATNEXT_NODE:-$(command -v node)}"

echo "[start-api.sh] Starting, PID=$$, root=$WHATNEXT_ROOT, node=$NODE, date=$(date)" >&2

if [[ -z "$NODE" ]]; then
  echo "[start-api.sh] FATAL: node not found on PATH" >&2
  exit 1
fi

# 1. Self-heal a git checkout whose source went missing (npm installs have no .git)
if [[ ! -f "$WHATNEXT_ROOT/src/api-server.js" ]]; then
  if [[ -d "$WHATNEXT_ROOT/.git" ]]; then
    echo "[start-api.sh] src/api-server.js missing - restoring from git" >&2
    (cd "$WHATNEXT_ROOT" && git fetch --quiet && git checkout main --force) 2>&1
  fi
  if [[ ! -f "$WHATNEXT_ROOT/src/api-server.js" ]]; then
    echo "[start-api.sh] FATAL: $WHATNEXT_ROOT/src/api-server.js not found - reinstall What Next" >&2
    exit 1
  fi
fi

# 2. Self-heal dependencies (git checkouts; npm installs ship their node_modules)
if [[ ! -d "$WHATNEXT_ROOT/node_modules/better-sqlite3" ]]; then
  echo "[start-api.sh] node_modules missing - running npm install" >&2
  (cd "$WHATNEXT_ROOT" && npm install --quiet) 2>&1
fi

# 3. Wait up to 15s for network on a fresh boot (cloud sync is optional; the API starts regardless)
for i in $(seq 1 15); do
  if /usr/bin/curl -sf --max-time 2 "${WHATNEXT_CLOUD_URL:-https://what-next-production.up.railway.app}/health" >/dev/null 2>&1; then
    echo "[start-api.sh] Network ready (attempt $i)" >&2
    break
  fi
  sleep 1
done

# 4. Start the server via bootstrap-entry.js (handles EAGAIN retry). db.js creates the DB if needed.
cd "$WHATNEXT_ROOT"
exec "$NODE" bin/bootstrap-entry.js src/api-server.js api
