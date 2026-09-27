#!/usr/bin/env bash
# End-to-end customer path from the real npm tarball, fully sandboxed. Run before every npm publish:
#   bash scripts/customer-e2e.sh
# Packs the repo, installs the tarball into a temp prefix, runs the installer under a temp HOME
# (launchctl is shimmed so the real com.whatnextai.api job is never touched), starts the API exactly
# as the generated LaunchAgent would on a spare port, then exercises the REST API, wn and the MCP server.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
S=$(mktemp -d "${TMPDIR:-/tmp}/wn-e2e.XXXXXX")
PORT=3811
rm -rf "$S"; mkdir -p "$S/home" "$S/prefix" "$S/shim"
H="$S/home"
ok() { printf '  PASS  %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS+1)); }
FAILS=0

echo "== pack + install"
(cd "$REPO" && npm pack --pack-destination "$S" >/dev/null 2>&1)
TGZ=$(ls "$S"/whatnext-ai-*.tgz)
N=$(tar -tzf "$TGZ" | wc -l | tr -d ' ')
[ "$N" -lt 60 ] && ok "tarball has $N files ($(du -k "$TGZ" | cut -f1) KB)" || bad "tarball has $N files"
(cd "$S" && npm install -g --prefix "$S/prefix" "$TGZ" >/dev/null 2>&1) && ok "global install" || bad "global install"
PKG="$S/prefix/lib/node_modules/whatnext-ai"

# launchctl shim so the installer cannot touch the real com.whatnextai.api job
printf '#!/bin/sh\necho "$*" >> %s/launchctl.calls\n' "$S" > "$S/shim/launchctl"; chmod +x "$S/shim/launchctl"
BASEPATH="$S/shim:$S/prefix/bin:$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "== installer (vscode)"
env -i PATH="$BASEPATH" HOME="$H" WHATNEXT_UPDATE_CHECK=0 install-what-next --client vscode --key bak_zzsweep >/dev/null 2>&1 && ok "installer ran" || bad "installer exit code"
PL="$H/Library/LaunchAgents/com.whatnextai.api.plist"
[ -f "$PL" ] && plutil -lint "$PL" >/dev/null && ok "plist valid" || bad "plist missing or invalid"

echo "== start API exactly as the LaunchAgent would (port changed only)"
ARGS=$(plutil -extract ProgramArguments json -o - "$PL" | python3 -c 'import json,sys;print("\n".join(json.load(sys.stdin)))')
ENVV=$(plutil -extract EnvironmentVariables json -o - "$PL" 2>/dev/null | python3 -c 'import json,sys
for k,v in json.load(sys.stdin).items():
    if k!="WHATNEXT_PORT": print(f"{k}={v}")' 2>/dev/null)
PROG=(); while IFS= read -r l; do [ -n "$l" ] && PROG+=("$l"); done <<< "$ARGS"
ENVA=(); while IFS= read -r l; do [ -n "$l" ] && ENVA+=("$l"); done <<< "$ENVV"
env -i HOME="$H" PATH=/usr/bin:/bin "${ENVA[@]}" WHATNEXT_PORT=$PORT WHATNEXT_UPDATE_CHECK=0 WHATNEXT_CURATOR=0 WHATNEXT_PROJECTS_DIR="$H/p" WHATNEXT_BOOT_INITIAL_DELAY_MS=0 WHATNEXT_CLOUD_URL=http://127.0.0.1:9 "${PROG[@]}" > "$S/api.log" 2>&1 &
for i in $(seq 1 60); do curl -s -m 2 "localhost:$PORT/health" >/dev/null && break; sleep 1; done
curl -s "localhost:$PORT/health" | grep -q '"ok":true' && ok "API healthy via start-api.sh" || { bad "API did not start"; tail -5 "$S/api.log"; }
C=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "localhost:$PORT/session" -H 'Content-Type: application/json' -d '{"project":"zz-sweep","summary":"ZZ customer e2e"}')
[ "$C" = 201 ] && ok "JSON write 201" || bad "JSON write $C"
C=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "localhost:$PORT/fact" -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' -d '{}')
[ "$C" = 403 ] && ok "cross-site write 403" || bad "cross-site write $C"
C=$(curl -s -o /dev/null -w '%{http_code}' "localhost:$PORT/context" -H "Host: attacker.example:$PORT")
[ "$C" = 403 ] && ok "rebinding read 403" || bad "rebinding read $C"
B=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN | awk 'NR>1{print $9}' | sort -u | tr '\n' ' ')
[[ "$B" == 127.0.0.1:* ]] && ok "bound to $B" || bad "bound to $B"
sleep 2
[ -f "$H/.whatnext/agents/zz-sweep.md" ] && ok "context card written in sandbox HOME" || bad "no context card"
[ -f "$H/.whatnext/data/what-next.db" ] && ok "DB in ~/.whatnext/data" || bad "DB not in ~/.whatnext/data"

echo "== wn CLI"
W=$(env -i PATH="$BASEPATH" HOME="$H" WHATNEXT_PORT=$PORT wn context 2>&1)
echo "$W" | grep -q "1 session" && ok "wn context sees the sandbox session" || bad "wn context: $(echo "$W" | head -2 | tr '\n' ' ')"
env -i PATH="$BASEPATH" HOME="$H" WHATNEXT_PORT=$PORT wn fact "ZZ fact from wn" >/dev/null 2>&1
curl -s "localhost:$PORT/search?q=wn" | grep -q "ZZ fact from wn" && ok "wn fact stored" || bad "wn fact not stored"

echo "== MCP server configured by the installer"
M="$H/Library/Application Support/Code/User/mcp.json"
CMD=$(python3 -c "import json;c=json.load(open('''$M'''));s=(c.get('servers') or c.get('mcpServers'))['what-next'];print(s['command'])")
MARGS=(); while IFS= read -r l; do [ -n "$l" ] && MARGS+=("$l"); done < <(python3 -c "import json;c=json.load(open('''$M'''));s=(c.get('servers') or c.get('mcpServers'))['what-next'];print('\n'.join(s.get('args',[])))")
OUT=$( { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"zz","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_context","arguments":{}}}' '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'; sleep 20; } | (cd "$PKG" && env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin HOME="$H" WHATNEXT_DATA_DIR="$H/.whatnext/data" WHATNEXT_UPDATE_CHECK=0 WHATNEXT_BOOT_INITIAL_DELAY_MS=0 WHATNEXT_CLOUD_URL=http://127.0.0.1:9 WHATNEXT_API_KEY=bak_zzsweep WHATNEXT_PREFER_LOCAL=1 "$CMD" "${MARGS[@]}") 2>/dev/null)
T=$(echo "$OUT" | grep -o '"name":"[a-z_]*"' | sort -u | wc -l | tr -d ' ')
[ "$T" -ge 14 ] && ok "MCP tools/list: $T tools" || bad "MCP tools/list: $T tools"
echo "$OUT" | grep -q "ZZ customer e2e" && ok "MCP get_context returns the session written via the API" || bad "MCP get_context missing the session"

echo "== cleanup"
for p in $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN); do kill "$p"; done; pkill -f "$PKG/" ; sleep 2
lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null && bad "port $PORT still open" || ok "sandbox processes stopped"
echo "launchctl calls intercepted: $(cat "$S/launchctl.calls" 2>/dev/null | sed "s#$H#~#g" | tr '\n' ';')"
rm -rf "$S"
echo "RESULT: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
