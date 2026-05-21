#!/bin/bash
# Retry sending weekly briefing email with backoff.
# Called by com.vanguard-skin.weekly-email.plist every 5 min (StartInterval=300).
# Self-gates to Sun 15:00-15:10 ET via scripts/lib/et-gate.sh — outside that
# window, exits 0 in ~50ms.
#
# Hits /api/cron/briefing (not /api/calendar/email) so KV-marker dedup with
# the Cloudflare Worker (Phase 4) fires. If the Worker already delivered
# this week's briefing via cloud fallback, the Mac route returns 200
# {skipped:true} and no duplicate is sent.

ENV_FILE="/Users/Yitzi/code/vanguard-skin/.env.local"
URL="http://localhost:3099/api/cron/briefing"
MAX_RETRIES=3
DELAY=120
# WEEK_OF is tomorrow (Monday) computed in ET — when fired Sunday 15:00 ET,
# `date -v+1d` returns the right Monday regardless of the Mac's local zone.
WEEK_OF="$(TZ=America/New_York date -v+1d +%Y-%m-%d)"

# Self-gate: Sunday at 15:00 ET (10-min window).
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
in_et_window "7" 15 0 || exit 0

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
  RESPONSE=$(curl -sS --max-time 300 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Cron-Secret: $SECRET" \
    -d "{\"weekOf\":\"$WEEK_OF\"}" \
    "$URL" 2>&1)
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "$RESPONSE"
    exit 0
  fi

  echo "Failed (exit code $EXIT_CODE): $RESPONSE"

  if [ $i -lt $MAX_RETRIES ]; then
    echo "Waiting ${DELAY}s before retry..."
    sleep $DELAY
  fi
done

echo "$(date '+%Y-%m-%d %H:%M:%S') — All $MAX_RETRIES attempts failed. Electron app not running."
exit 1
