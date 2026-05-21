#!/bin/bash
# Retry sending daily digest email with backoff.
# Called by com.vanguard-skin.daily-digest.plist every 5 min (StartInterval=300).
# Self-gates to Mon-Fri 08:45-08:55 ET via scripts/lib/et-gate.sh — outside
# that window, exits 0 in ~50ms.
#
# Hits /api/cron/digest (not /api/digest/email) so KV-marker dedup with the
# Cloudflare Worker (Phase 4) fires. If the Worker already delivered today's
# digest (cloud fallback), the Mac route returns 200 {skipped:true} and no
# duplicate is sent. Marker dedup also handles the case where 2 ticks land
# in the same 10-min window.

ENV_FILE="/Users/Yitzi/code/vanguard-skin/.env.local"
URL="http://localhost:3099/api/cron/digest"
MAX_RETRIES=3
DELAY=120

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Self-gate: Mon-Fri at 08:45 ET (10-min window).
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
in_et_window "1,2,3,4,5" 8 45 || exit 0

if [ ! -f "$ENV_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: $ENV_FILE not found"
  exit 2
fi

SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$SECRET" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: CRON_SHARED_SECRET missing from $ENV_FILE"
  exit 2
fi

# Refresh FRED 3-month T-bill (DGS3MO) cache before the digest runs.
# Used by Sharpe ratio + Black-Scholes drift; piggy-backs on the same
# launchd window so we don't spawn a separate plist. Fire-and-forget on
# failure — a FRED outage must not block digest delivery.
echo "$(date '+%Y-%m-%d %H:%M:%S') — Refreshing risk-free rate cache"
(cd /Users/Yitzi/code/vanguard-skin && npx tsx scripts/refresh-risk-free-rate.ts) || \
  echo "$(date '+%Y-%m-%d %H:%M:%S') — risk-free-rate refresh failed (continuing)"

for i in $(seq 1 $MAX_RETRIES); do
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Attempt $i of $MAX_RETRIES"
  RESPONSE=$(curl -sS --max-time 300 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Cron-Secret: $SECRET" \
    -d '{"mode":"since_last"}' \
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
