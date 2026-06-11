#!/usr/bin/env bash
# Nightly deep QA — sandbox up, headless /qa-deep-sweep, sandbox down.
# Scheduled by com.vanguard-skin.nightly-deep-qa.plist at 2:45 AM local.
# PATH DEVIATION: claude CLI lives at /Users/Yitzi/.local/bin (not in standard
# Homebrew/system paths); that directory is prepended below.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
export PATH="/Users/Yitzi/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$PROJECT_DIR"

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
