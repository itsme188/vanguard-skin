#!/bin/bash
# Daily Plaid → Vanguard holdings sync. Fires on the first tick inside the
# 07:30 ET weekday window (after Plaid's overnight Vanguard re-scrape,
# before the 8:45 digest). The route itself dedupes (once per ET day) and
# skips market holidays, so the ≤2 ticks a 10-min window allows are safe.
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
if ! in_et_window "1,2,3,4,5" 7 30; then
  exit 0
fi

ENV_FILE=/Users/Yitzi/code/vanguard-skin/.env.local
SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
HEADERS=(-H "Content-Type: application/json")
if [ -n "$SECRET" ]; then
  HEADERS+=(-H "X-Cron-Secret: $SECRET")
fi

for url in "http://localhost:3099/api/cron/plaid-sync" "http://localhost:3000/api/cron/plaid-sync"; do
  response=$(curl -sS --max-time 180 -w $'\n%{http_code}' -X POST "${HEADERS[@]}" -d '{}' "$url" 2>&1)
  code=$(echo "$response" | tail -1)
  if [ "$code" = "200" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync OK via $url: $(echo "$response" | head -1)"
    exit 0
  fi
done
echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync failed on both ports: $response"
exit 1
