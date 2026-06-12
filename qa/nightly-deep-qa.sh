#!/usr/bin/env bash
# Nightly deep QA — sandbox up, headless /qa-deep-sweep, sandbox down.
# Scheduled by com.vanguard-skin.nightly-deep-qa.plist (StartInterval=300,
# i.e. every 5 min) with the self-gate below: once per local day, first tick
# inside the 02:45–07:00 local window.
# PATH DEVIATION: claude CLI lives at /Users/Yitzi/.local/bin (not in standard
# Homebrew/system paths); that directory is prepended below.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
export PATH="/Users/Yitzi/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$PROJECT_DIR"

# --- Schedule self-gate ------------------------------------------------------
# Why not StartCalendarInterval: launchd evaluates Hour/Minute in the timezone
# UserEventAgent cached at boot, NOT the current system zone. The Mac booted
# 2026-05-20 in Israel (UTC+3), so "Hour 2, Minute 45" fired at 19:45 ET every
# night (observed 6/10 + 6/11) and collided with evening use. Same failure
# class the et-gate.sh pattern fixed for the email jobs — this job gates on
# LOCAL time deliberately (2:45 AM is about Mac-idle hours, not market hours).
# Window is bounded at 07:00 so a Mac asleep past it skips the night rather
# than launching a 3h sweep mid-day. DEEP_QA_FORCE=1 bypasses the gate for
# manual runs (the mutex below still applies).
MARKER_FILE="$SCRIPT_DIR/findings/.deep-qa-last-run"
if [ "${DEEP_QA_FORCE:-0}" != "1" ]; then
  MIN_OF_DAY=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))
  { [ "$MIN_OF_DAY" -ge 165 ] && [ "$MIN_OF_DAY" -lt 420 ]; } || exit 0
  [ "$(cat "$MARKER_FILE" 2>/dev/null)" = "$(date +%Y-%m-%d)" ] && exit 0
fi
date +%Y-%m-%d > "$MARKER_FILE"

echo "=== Deep QA run $(date '+%Y-%m-%d %H:%M:%S') ==="

# Single-run mutex. launchd fires a "missed" StartCalendarInterval occurrence
# immediately when a plist is (re)loaded after the scheduled time — observed
# 2026-06-10, when loading the plist at ~18:40 started a full production run
# that collided with an in-session manual sweep (shared browser + shared git
# working tree). One sweep at a time, ever.
LOCK_DIR="/tmp/vanguard-deep-qa.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_AGE_MIN=$(( ($(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)) / 60 ))
  if [ "$LOCK_AGE_MIN" -lt 180 ]; then
    echo "Another deep-QA run holds the lock (${LOCK_AGE_MIN}m old) — exiting."; exit 0
  fi
  echo "Stale lock (${LOCK_AGE_MIN}m) — taking over."
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

if ! command -v claude &>/dev/null; then
  echo "ERROR: claude CLI not on PATH — aborting"; exit 1
fi

bash "$SCRIPT_DIR/sandbox.sh" up || { echo "ERROR: sandbox boot failed"; exit 1; }
# Single EXIT trap (bash traps replace, not stack): sandbox down + release lock.
trap 'bash "$SCRIPT_DIR/sandbox.sh" down; rmdir "$LOCK_DIR" 2>/dev/null' EXIT

claude -p "/qa-deep-sweep"
STATUS=$?

echo "=== Deep QA finished (claude exit $STATUS) $(date '+%Y-%m-%d %H:%M:%S') ==="
exit $STATUS
