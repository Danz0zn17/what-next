#!/bin/zsh
# Wrapper for LaunchAgent — ensures proper shell environment before starting node
export HOME=/Users/danz0-home
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/danz0-home/Documents/projects/what-next
echo "[start-api.sh] Starting node, PID=$$, date=$(date)" >&2
exec /opt/homebrew/bin/node src/api-server.js
