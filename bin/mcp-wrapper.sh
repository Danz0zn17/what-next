#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Same node as the installer pinned, so native modules match its ABI
NODE="${WHATNEXT_NODE:-$(command -v node)}"

PLATFORM="$("$NODE" -e "process.stdout.write(process.platform)")"
ARCH="$("$NODE" -e "process.stdout.write(process.arch)")"
BINDING="$ROOT/node_modules/onnxruntime-node/bin/napi-v3/$PLATFORM/$ARCH/onnxruntime_binding.node"

if [ ! -f "$BINDING" ]; then
  echo "[mcp-wrapper] FATAL: onnxruntime native binding missing at $BINDING" >&2
  echo "[mcp-wrapper] Running npm install to self-heal..." >&2
  if npm install --no-audit --prefix "$ROOT" >&2; then
    echo "[mcp-wrapper] npm install completed - starting server" >&2
  else
    echo "[mcp-wrapper] npm install failed. Fix: cd $ROOT && npm install" >&2
    exit 1
  fi
fi

exec "$NODE" "$ROOT/bin/bootstrap-entry.js" src/server.js what-next "$@"
