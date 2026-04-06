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
#   - claude CLI installed
#   - No other process on port 3099

set -uo pipefail

PROJECT_DIR="/Users/Yitzi/code/vanguard-skin"
QA_DIR="$PROJECT_DIR/qa"
PORT=3099
TODAY=$(date '+%Y-%m-%d')
LOG_DIR="$QA_DIR/logs"
REPORT_DIR="$QA_DIR/reports"
MAX_FIX_ATTEMPTS=2

mkdir -p "$LOG_DIR" "$REPORT_DIR"

echo "=== Nightly QA — $TODAY ==="
echo "Started: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- Ensure PATH includes Homebrew and node ---
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- Check prerequisites ---

if ! command -v node &>/dev/null; then
  echo "ERROR: node not found on PATH"
  exit 1
fi

if ! command -v agent-browser &>/dev/null; then
  echo "ERROR: agent-browser not found on PATH"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "WARNING: claude CLI not found — auto-fix will be skipped"
  CLAUDE_AVAILABLE=false
else
  CLAUDE_AVAILABLE=true
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

# --- Handle failures ---

FAIL_COUNT=$(grep -c "FAIL:" "$QA_DIR/qa-report.txt" 2>/dev/null || echo "0")

if [ "$FAIL_COUNT" -gt 0 ] && [ "$CLAUDE_AVAILABLE" = true ]; then
  echo ""
  echo "Found $FAIL_COUNT failures. Invoking Claude Code for auto-fix..."
  echo ""

  FAIL_SUMMARY=$(grep "FAIL:" "$QA_DIR/qa-report.txt")

  claude -p "$(cat <<PROMPT
You are running a nightly QA check on the Vanguard Skin project at $PROJECT_DIR.
The dev server is running on localhost:$PORT.

The QA report found these failures:

$FAIL_SUMMARY

Screenshots of each page are in $QA_DIR/screenshots/.

Instructions:
1. Create a new branch: git checkout -b qa-fixes-$TODAY
2. For each failure, read the relevant source file and attempt a fix.
3. Maximum $MAX_FIX_ATTEMPTS attempts per issue. If you can't fix it in $MAX_FIX_ATTEMPTS tries, log what you tried and move on.
4. After all fixes, re-run: bash $QA_DIR/run-qa.sh
5. Commit any fixes with a descriptive message.
6. Do NOT push — just leave the branch ready for review.
7. Return to the main branch when done: git checkout main

Important:
- Do not refactor or "improve" working code
- Only fix the specific failures listed above
- 2 attempts max per issue, then stop
PROMPT
  )" 2>&1 || true

  echo ""
  echo "Claude Code auto-fix completed."
fi

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
