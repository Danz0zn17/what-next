#!/usr/bin/env bash
# Tests the v2.5.0 cloud migration and its rollback on a throwaway Postgres.
#
#   bash scripts/cloud-migration-check.sh [old-ref]   (default old-ref: v2.4.0 tag, else origin/main)
#
# 1. starts pgvector/pgvector:pg17 in Docker on 127.0.0.1:55432
# 2. boots the OLD cloud server (old-ref) so it builds the schema exactly as
#    production does, and writes a user, a fact and a session through its API
# 3. boots THIS checkout: migration runs, old rows export unchanged, new fields round-trip
# 4. boots this checkout again (idempotent)
# 5. rollback step 1: the OLD server runs on the migrated schema and still writes/reads
# 6. rollback step 2: migrations/2.5.0-fact-freshness.down.sql, OLD server reads again
# 7. migrations/2.5.0-fact-freshness.up.sql by hand, THIS server reads again
# Ends with "RESULT: PASS" or exits non-zero. Needs docker, node, git.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
OLD_REF=${1:-$(git -C "$ROOT" rev-parse -q --verify v2.4.0 >/dev/null && echo v2.4.0 || echo origin/main)}
PG=wn-migration-check-$$
export DATABASE_URL='postgres://postgres:test@127.0.0.1:55432/postgres?sslmode=disable'
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; docker rm -f "$PG" >/dev/null 2>&1 || true; git -C "$ROOT" worktree remove --force "$WORK/old" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
PSQL() { docker exec -i "$PG" psql -U postgres -Atq "$@"; }
boot() { (cd "$1" && PORT=$2 ADMIN_KEY=migration-check-admin-key node src/cloud-server.js >"$WORK/boot-$2.log" 2>&1) & PIDS+=($!); echo $! >"$WORK/pid-$2"
  for _ in $(seq 1 60); do curl -sf "localhost:$2/health" >/dev/null && return 0; sleep 1; done; cat "$WORK/boot-$2.log"; fail "server on $2 did not start"; }
stop() { kill "$(cat "$WORK/pid-$1")" 2>/dev/null || true; sleep 1; }
cols() { PSQL -c "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='facts'"; }

docker run -d --name "$PG" -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17 >/dev/null
for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
git -C "$ROOT" worktree add -q --detach "$WORK/old" "$OLD_REF"
ln -s "$ROOT/node_modules" "$WORK/old/node_modules"

echo "1. old server ($OLD_REF) builds the schema"
boot "$WORK/old" 4201
KEY=$(curl -s -X POST localhost:4201/admin/users -H 'X-Admin-Key: migration-check-admin-key' -H 'Content-Type: application/json' -d '{"email":"check@example.com","send_email":false}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).api_key))')
H="X-API-Key: $KEY"; J='Content-Type: application/json'
curl -sf -X POST localhost:4201/fact -H "$H" -H "$J" -d '{"category":"deploy","content":"old fact on https://a.netlify.app","project":"p1"}' >/dev/null
curl -sf -X POST localhost:4201/session -H "$H" -H "$J" -d '{"project":"p1","summary":"old session"}' >/dev/null
stop 4201
[[ "$(cols)" == *source* ]] && fail "old schema already has source"

echo "2. this checkout migrates"
boot "$ROOT" 4202
[[ "$(cols)" == *source,last_verified_at,volatility,ttl_days* ]] || fail "columns missing: $(cols)"
curl -sf "localhost:4202/export" -H "$H" | grep -q '"content":"old fact on https://a.netlify.app"' || fail "old fact not exported"
curl -sf -X POST localhost:4202/fact -H "$H" -H "$J" -d '{"category":"deploy","content":"new fact","volatility":"volatile","ttl_days":7,"source":"netlify"}' >/dev/null
curl -sf "localhost:4202/search?q=new%20fact" -H "$H" | grep -q '"volatility":"volatile","ttl_days":7' || fail "new fields did not round-trip"
curl -sf -X POST localhost:4202/fact -H "$H" -H "$J" -d '{"category":"x","content":"old client shape"}' >/dev/null || fail "old-shape fact rejected"
stop 4202
echo "3. idempotent re-boot"; boot "$ROOT" 4203; stop 4203
echo "4. rollback step 1: old server on the migrated schema"
boot "$WORK/old" 4204
curl -sf -X POST localhost:4204/fact -H "$H" -H "$J" -d '{"category":"x","content":"written by old after upgrade"}' >/dev/null || fail "old server cannot write"
[ "$(curl -sf localhost:4204/export -H "$H" | grep -o '"cloud_id"' | wc -l)" -ge 4 ] || fail "old server export short"
stop 4204
echo "5. rollback step 2: down migration"
PSQL < "$ROOT/migrations/2.5.0-fact-freshness.down.sql"
[[ "$(cols)" == *source* ]] && fail "down migration left columns"
[ "$(PSQL -c 'select count(*) from facts')" = 4 ] || fail "facts lost in rollback"
boot "$WORK/old" 4205; curl -sf "localhost:4205/search?q=fact" -H "$H" >/dev/null || fail "old server after down"; stop 4205
echo "6. up migration by hand"
PSQL < "$ROOT/migrations/2.5.0-fact-freshness.up.sql"
boot "$ROOT" 4206; curl -sf localhost:4206/export -H "$H" >/dev/null || fail "new server after up"; stop 4206
echo "RESULT: PASS"
