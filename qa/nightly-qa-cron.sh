#!/usr/bin/env bash
# Vanguard Skin — Nightly QA Automation
# Intended to be run by cron at 2 AM. Starts the dev server, runs QA,
# and if failures are found, invokes Claude Code to attempt fixes.
#
# Cron entry (add with `crontab -e`):
#   0 2 * * * /Users/Yitzi/code/vanguard-skin/qa/nightly-qa-cron.sh >> /Users/Yitzi/code/vanguard-skin/qa/logs/cron-$(date +\%Y-\%m-\%d).log 2>&1
#
# Requirements:
#   - Node.js on PATH
#   - agent-browser installed
#   - (auto-fix is owned by the 02:45 deep-QA chain — this smoke only reports)
#   - No other process on port 3099

set -uo pipefail

PROJECT_DIR="/Users/Yitzi/code/vanguard-skin"
QA_DIR="$PROJECT_DIR/qa"
PORT=3099
# Report filename uses ET date so the cron cycle and report name align
# even when the Mac travels to a non-ET timezone.
TODAY=$(TZ=America/New_York date '+%Y-%m-%d')
LOG_DIR="$QA_DIR/logs"
REPORT_DIR="$QA_DIR/reports"

mkdir -p "$LOG_DIR" "$REPORT_DIR"

# --- Ensure PATH includes Homebrew and node ---
# node@24 keg first: better-sqlite3 is ABI-pinned to Node 24; the bare
# /opt/homebrew/bin/node moves on every `brew upgrade` (broke 2026-08-11).
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- Browser-process cleanup (2026-07-17) ---
# Every nightly run was leaving an agent-browser daemon + Chrome-for-Testing
# pair alive indefinitely (close doesn't kill the daemon; abort paths skip
# cleanup). Baseline-diff kill on EXIT — only processes this run spawned.
source "$QA_DIR/lib/agent-browser-cleanup.sh"
ab_cleanup_init

# Self-gate: daily at 02:00 ET (10-min window). Plist now runs every 5 min.
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
in_et_window "1,2,3,4,5,6,7" 2 0 || exit 0

# Once per night: the plist ticks every 5 min and the 10-min gate admits two
# ticks, which ran the whole smoke twice a night from 2026-06-01 to 2026-09-03.
# The archived report is the per-day marker (a run that produced no report
# — e.g. a crashed mint — is retried by the next tick, which is what we want).
[ -f "$REPORT_DIR/$TODAY.txt" ] && exit 0

echo "=== Nightly QA — $TODAY ==="
echo "Started: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- Check prerequisites ---

if ! command -v node &>/dev/null; then
  echo "ERROR: node not found on PATH"
  exit 1
fi

if ! command -v agent-browser &>/dev/null; then
  echo "ERROR: agent-browser not found on PATH"
  exit 1
fi

# --- Check if port is already in use ---

if lsof -ti :"$PORT" &>/dev/null; then
  echo "WARNING: Port $PORT already in use. Assuming dev server is running."
  SERVER_PID=""
  STARTED_SERVER=false
else
  # --- Start dev server ---
  echo "Starting dev server on port $PORT..."
  cd "$PROJECT_DIR"
  npm run dev -- --port "$PORT" &
  SERVER_PID=$!
  STARTED_SERVER=true

  # Wait for server to be ready (up to 90 seconds)
  echo "Waiting for server to be ready..."
  WAITED=0
  MAX_WAIT=90
  while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -sf "http://localhost:$PORT" > /dev/null 2>&1; then
      echo "Server ready after ${WAITED}s"
      break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
  done

  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "ERROR: Dev server did not start within ${MAX_WAIT}s"
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi

  # Extra buffer for full hydration
  sleep 5
fi

# --- Run QA ---

echo ""
echo "Running QA suite..."
bash "$QA_DIR/run-qa.sh" 2>&1
QA_EXIT=$?

# --- Archive report ---

if [ -f "$QA_DIR/qa-report.txt" ]; then
  cp "$QA_DIR/qa-report.txt" "$REPORT_DIR/$TODAY.txt"
  echo ""
  echo "Report archived to: reports/$TODAY.txt"
fi

# --- Failures ---
# Reported only. Auto-fix moved to the 02:45 deep-QA chain (own worktree) on
# 2026-07-27; the claude -p block that used to live here had been dead since
# 2026-05-30 (claude was never on this PATH) and would have switched the MAIN
# checkout to a qa-fixes branch at 2 AM had it ever run. Removed 2026-09-03.

# --- Cleanup ---

if [ "$STARTED_SERVER" = true ] && [ -n "$SERVER_PID" ]; then
  echo ""
  echo "Stopping dev server (PID: $SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
  # Also kill any child processes (Next.js spawns workers)
  pkill -P "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
fi

echo ""
echo "=== Nightly QA Complete ==="
echo "Finished: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Report: $REPORT_DIR/$TODAY.txt"
echo "Exit code: $QA_EXIT"

exit $QA_EXIT
