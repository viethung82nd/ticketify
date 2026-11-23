#!/usr/bin/env bash
# Runs one k6 script in Docker against an API that is already up, then records everything a result
# needs (ROADMAP 6.2): machine, Docker, Postgres and API settings, the raw k6 summary, and the SQL
# duplicate check. Stops with exit 3 if the check finds a violation.
#
#   LOAD_DB=ticketify_load01 POOL_MAX=10 RATE=100 DURATION=2m load-tests/run.sh hot-showtime
#
# Required: LOAD_DB (the load-test database), POOL_MAX (DATABASE_POOL_MAX the API runs with: the
# script cannot see inside the API process, so it is declared here and written into meta.json).
# Optional: RATE, DURATION, PRE_VUS, MAX_VUS, MAX_SEATS (passed to k6), BASE_URL (default
# http://host.docker.internal:3100), PG_CONTAINER (default ticketify-postgres-1), K6_IMAGE,
# RESULTS_ROOT (default load-tests/results), LABEL (added to the run folder name).
set -euo pipefail

SCRIPT="${1:?usage: run.sh hot-showtime|mixed-traffic}"
: "${LOAD_DB:?set LOAD_DB to the load-test database (ticketify_load…)}"
: "${POOL_MAX:?set POOL_MAX to the DATABASE_POOL_MAX the API under test runs with}"
case "$LOAD_DB" in ticketify_load*) ;; *) echo "LOAD_DB must start with ticketify_load" >&2; exit 2 ;; esac

HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"  # pwd -W: C:/… form Docker Desktop accepts
K6_IMAGE="${K6_IMAGE:-grafana/k6:2.4.0}"
PG_CONTAINER="${PG_CONTAINER:-ticketify-postgres-1}"
BASE_URL="${BASE_URL:-http://host.docker.internal:3100}"
RESULTS_ROOT="${RESULTS_ROOT:-$HERE/results}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ID="${STAMP}-${SCRIPT}${LABEL:+-$LABEL}"
OUT="$RESULTS_ROOT/$RUN_ID"
mkdir -p "$OUT"

psql_load() { docker exec -i "$PG_CONTAINER" psql -U ticketify -d "$LOAD_DB" -At "$@"; }

# Every hot-showtime run starts with all seats of the hot showtime free.
if [ "$SCRIPT" = hot-showtime ]; then
  HOT_ID="$(grep -o '"hotShowtimeId":"[^"]*"' "$HERE/.data/load-data.json" | cut -d'"' -f4)"
  psql_load -v showtime="$HOT_ID" -f - <"$HERE/sql/reset-hot-showtime.sql" >"$OUT/reset.txt"
fi

# Host facts. On Windows (Git Bash) ask PowerShell; elsewhere use /proc and uname.
if command -v powershell.exe >/dev/null 2>&1; then
  HOST_INFO="$(powershell.exe -NoProfile -Command \
    '$c = Get-CimInstance Win32_Processor | Select-Object -First 1;
     $o = Get-CimInstance Win32_OperatingSystem;
     "{0}|{1}|{2}|{3:N1} GB|{4} {5}" -f $c.Name.Trim(), $c.NumberOfCores, $c.NumberOfLogicalProcessors,
       ($o.TotalVisibleMemorySize / 1MB), $o.Caption, $o.Version' | tr -d '\r')"
else
  HOST_INFO="$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)|?|$(nproc)|$(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo)|$(uname -sr)"
fi
IFS='|' read -r CPU CORES THREADS RAM OS <<<"$HOST_INFO"
DOCKER_INFO="$(docker info --format '{{.OperatingSystem}}|{{.ServerVersion}}|{{.NCPU}}|{{.MemTotal}}')"
IFS='|' read -r DOCKER_OS DOCKER_VERSION DOCKER_CPUS DOCKER_MEM <<<"$DOCKER_INFO"
PG_INFO="$(psql_load -F'|' -c "SELECT current_setting('server_version'), current_setting('max_connections'), current_setting('shared_buffers'), current_setting('work_mem'), pg_size_pretty(pg_database_size(current_database()))")"
IFS='|' read -r PG_VERSION PG_MAX_CONN PG_SHARED_BUFFERS PG_WORK_MEM DB_SIZE <<<"$PG_INFO"
DEADLOCKS_BEFORE="$(psql_load -c "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()")"
K6_VERSION="$(docker run --rm "$K6_IMAGE" version | head -1)"

cat >"$OUT/meta.json" <<EOF
{
  "runId": "$RUN_ID",
  "script": "$SCRIPT",
  "startedAtUtc": "$STAMP",
  "loadGenerator": "k6 in Docker ($K6_IMAGE) on the SAME machine as the API, worker and databases",
  "host": { "cpu": "$CPU", "cores": "$CORES", "logicalProcessors": "$THREADS", "ram": "$RAM", "os": "$OS" },
  "docker": { "engine": "$DOCKER_OS", "version": "$DOCKER_VERSION", "vmCpus": "$DOCKER_CPUS", "vmMemoryBytes": "$DOCKER_MEM" },
  "postgres": { "version": "$PG_VERSION", "maxConnections": "$PG_MAX_CONN", "sharedBuffers": "$PG_SHARED_BUFFERS", "workMem": "$PG_WORK_MEM", "database": "$LOAD_DB", "databaseSize": "$DB_SIZE" },
  "api": { "baseUrl": "$BASE_URL", "databasePoolMax": "$POOL_MAX", "processes": "1 API + 1 worker (node, outside Docker)" },
  "k6": { "version": "$K6_VERSION", "rate": "${RATE:-default}", "duration": "${DURATION:-default}", "preAllocatedVUs": "${PRE_VUS:-default}", "maxVUs": "${MAX_VUS:-default}", "maxSeats": "${MAX_SEATS:-default}" },
  "deadlocksBefore": $DEADLOCKS_BEFORE
}
EOF

echo "Run $RUN_ID → $OUT"
set +e
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$HERE:/load-tests" -v "$OUT:/results" \
  -e BASE_URL="$BASE_URL" -e RESULTS_DIR=/results \
  ${RATE:+-e RATE="$RATE"} ${DURATION:+-e DURATION="$DURATION"} \
  ${PRE_VUS:+-e PRE_VUS="$PRE_VUS"} ${MAX_VUS:+-e MAX_VUS="$MAX_VUS"} \
  ${MAX_SEATS:+-e MAX_SEATS="$MAX_SEATS"} \
  "$K6_IMAGE" run --quiet "/load-tests/$SCRIPT.js" | tee "$OUT/k6-stdout.txt"
K6_EXIT=${PIPESTATUS[0]}
set -e
echo "k6 exit code: $K6_EXIT (99 = a threshold was crossed)" | tee -a "$OUT/k6-stdout.txt"

psql_load -F' ' -f - <"$HERE/sql/verify-no-duplicates.sql" | tee "$OUT/verify.txt"
if awk '$1 !~ /^info_/ && $2 != 0 { bad = 1 } END { exit !bad }' "$OUT/verify.txt"; then
  echo "DUPLICATE CHECK FAILED — see $OUT/verify.txt" >&2
  exit 3
fi
echo "Duplicate check: every rule 0."
