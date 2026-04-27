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
RESPONSE=$(curl -sS --max-time 180 -w $'\n%{http_code}' -X POST \
  "${HEADERS[@]}" \
  -d '{}' \
  "$URL" 2>&1)
CURL_EXIT=$?

HTTP_STATUS=$(printf '%s\n' "$RESPONSE" | tail -n 1)
HTTP_BODY=$(printf '%s\n' "$RESPONSE" | sed '$d')

if [ $CURL_EXIT -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — HTTP path OK"
  echo "$HTTP_BODY"
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') — HTTP path failed (curl=$CURL_EXIT status=$HTTP_STATUS), falling back to tsx"
echo "$HTTP_BODY"
cd "$PROJECT_DIR" || exit 2
npx tsx scripts/enrich-calendar-events.ts
