#!/bin/bash
# Retry sending weekly briefing email with backoff.
# Called by com.vanguard-skin.weekly-email.plist every 5 min (StartInterval=300).
# Self-gates to Sun 16:30-16:40 ET via scripts/lib/et-gate.sh — outside that
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

# Self-gate: 16:30 ET (10-min window) on BOTH Sunday and Monday. The route's
# shouldSendBriefingToday() decides which one actually sends — normally Sunday,
# but deferred to Monday when the upcoming Monday is a market holiday (so the
# week-ahead covers the real trading week). A normal-Monday tick is skipped by
# the route. We deliberately send NO weekOf so the route computes it via the
# ET-anchored getCurrentMonday() and its holiday-shift gate applies (passing
# weekOf would bypass the gate).
# Moved 15:00 → 16:30 ET on 2026-06-07: Eliant Capital (preferred weekend
# source) publishes its weekly after 3pm ET, so a 3pm send missed it.
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
in_et_window "7" 16 30 || in_et_window "1" 16 30 || exit 0

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
  # --max-time must exceed the send pipeline's worst case (briefing: 4-week
  # calendar sync + auto-refresh + macro themes + narratives + Opus ≈ 9 min).
  # At the old 300s every attempt "timed out" while the server kept working,
  # and each retry stacked another full pipeline — all of which eventually
  # sent (2026-07-12: Sunday briefing ×3).
  RESPONSE=$(curl -sS --max-time 900 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Cron-Secret: $SECRET" \
    -d "{}" \
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
