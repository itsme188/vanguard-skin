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

if ! command -v claude &>/dev/null; then
  echo "ERROR: claude CLI not on PATH — aborting"; exit 1
fi

bash "$SCRIPT_DIR/sandbox.sh" up || { echo "ERROR: sandbox boot failed"; exit 1; }
trap 'bash "$SCRIPT_DIR/sandbox.sh" down' EXIT

claude -p "/qa-deep-sweep"
STATUS=$?

echo "=== Deep QA finished (claude exit $STATUS) $(date '+%Y-%m-%d %H:%M:%S') ==="
exit $STATUS
