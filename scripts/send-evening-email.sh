#!/bin/bash
# Retry sending evening email with backoff.
# Called by com.vanguard-skin.evening-email.plist Mon-Thu at 19:00 / Fri at 17:30 local.
#
# Hits /api/cron/evening (not /api/digest/email) so KV-marker dedup with the
# Cloudflare Worker (Phase 4) fires. If the Worker already delivered evening's
# email (cloud fallback), the Mac route returns 200 {skipped:true} and no
# duplicate is sent.

ENV_FILE="/Users/Yitzi/code/vanguard-skin/.env.local"
URL="http://localhost:3099/api/cron/evening"
MAX_RETRIES=3
DELAY=120

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
    -d '{}' \
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
