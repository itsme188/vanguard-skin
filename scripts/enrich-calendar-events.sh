#!/bin/bash
# Launchd entry: post-release calendar enrichment.
# Called every 15 min 09:30–16:00 ET Mon–Fri by
# ~/Library/LaunchAgents/com.vanguard-skin.calendar-enrich.plist
#
# Prefers hitting the running Electron app's HTTP endpoint (so TWS state
# is shared with the live dashboard). Falls back to a standalone tsx
# invocation if the app isn't running.

ENV_FILE="/Users/Yitzi/code/vanguard-skin/.env.local"
URL="http://localhost:3099/api/calendar/enrich"
PROJECT_DIR="/Users/Yitzi/code/vanguard-skin"

if [ ! -f "$ENV_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: $ENV_FILE not found"
  exit 2
fi

SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
HEADERS=(-H "Content-Type: application/json")
if [ -n "$SECRET" ]; then
  HEADERS+=(-H "X-Cron-Secret: $SECRET")
fi

# Try the HTTP path first (Electron app running + TWS session shared).
RESPONSE=$(curl -sS --max-time 180 -X POST \
  "${HEADERS[@]}" \
  -d '{}' \
  "$URL" 2>&1)
CURL_EXIT=$?

if [ $CURL_EXIT -eq 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — HTTP path OK"
  echo "$RESPONSE"
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') — HTTP path failed ($CURL_EXIT), falling back to tsx"
cd "$PROJECT_DIR" || exit 2
npx tsx scripts/enrich-calendar-events.ts
