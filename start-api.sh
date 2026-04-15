#!/bin/zsh
# What Next — API startup wrapper
# Called by the com.whatnextai.api LaunchAgent on boot and on crash-restart.
# Uses bootstrap-entry.js which retries on EAGAIN (Node.js v24 macOS boot race).

export HOME=/Users/danz0-home
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export WHATNEXT_PREFER_LOCAL=1
export WHATNEXT_CLOUD_SYNC_MODE=background
export WHATNEXT_BOOT_RETRIES=12
export WHATNEXT_BOOT_DELAY_MS=750

cd /Users/danz0-home/Documents/projects/what-next

echo "[start-api.sh] Starting, PID=$$, date=$(date)" >&2

# Wait up to 10s for network on fresh boot (avoids cloud sync timeout on startup)
for i in $(seq 1 10); do
  if /usr/bin/curl -sf --max-time 2 https://what-next-production.up.railway.app/health >/dev/null 2>&1; then
    break
  fi
  echo "[start-api.sh] Waiting for network... attempt $i/10" >&2
  sleep 1
done

exec /opt/homebrew/bin/node bin/bootstrap-entry.js src/api-server.js api
