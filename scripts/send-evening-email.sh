#!/bin/bash
# Retry sending evening email with backoff.
# Called by com.vanguard-skin.evening-email.plist every 5 min (StartInterval=300).
# Self-gates to Mon-Thu 19:00-19:10 ET OR Fri 17:30-17:40 ET via
# scripts/lib/et-gate.sh — outside those windows, exits 0 in ~50ms.
#
# Hits /api/cron/evening (not /api/digest/email) so KV-marker dedup with the
# Cloudflare Worker (Phase 4) fires. If the Worker already delivered evening's
# email (cloud fallback), the Mac route returns 200 {skipped:true} and no
# duplicate is sent.

ENV_FILE="/Users/Yitzi/code/vanguard-skin/.env.local"
URL="http://localhost:3099/api/cron/evening"
MAX_RETRIES=3
DELAY=120

# Self-gate: Mon-Thu 19:00 ET OR Fri 17:30 ET (10-min windows).
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
in_et_window "1,2,3,4" 19 0 || in_et_window "5" 17 30 || exit 0

if [ ! -f "$ENV_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: $ENV_FILE not found"
  exit 2
fi

SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$SECRET" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: CRON_SHARED_SECRET missing from $ENV_FILE"
  exit 2
fi

for i in $(seq 1 $MAX_RETRIES); do
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Attempt $i of $MAX_RETRIES"
  # --max-time must exceed the send pipeline's worst case. At the old 300s a
  # slow run "timed out" while the server kept working, and the retry stacked
  # a concurrent duplicate pipeline (same failure family as the 2026-07-12
  # briefing ×3 / 2026-06-30 digest ×2).
  RESPONSE=$(curl -sS --max-time 900 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Cron-Secret: $SECRET" \
    -d '{}' \
    "$URL" 2>&1)
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "$RESPONSE"
    exit 0
  fi

  echo "Failed (exit code $EXIT_CODE): $RESPONSE"

  # Only a connection failure (curl exit 7 — server not running) is
  # retryable. A timeout (exit 28) means the server IS running and the
  # pipeline is still working — curl abandoning the request does NOT stop
  # the Next.js handler, so retrying would launch a concurrent duplicate.
  # The route's in-process send mutex is the backstop; don't even knock.
  if [ $EXIT_CODE -ne 7 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') — Non-retryable failure (exit $EXIT_CODE); server-side pipeline may still complete. Not retrying."
    exit 1
  fi

  if [ $i -lt $MAX_RETRIES ]; then
    echo "Waiting ${DELAY}s before retry..."
    sleep $DELAY
  fi
done

echo "$(date '+%Y-%m-%d %H:%M:%S') — All $MAX_RETRIES attempts failed. Electron app not running."
exit 1
