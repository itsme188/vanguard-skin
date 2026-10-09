#!/bin/bash
# Daily Plaid → Vanguard holdings sync. Fires on the first tick inside the
# 07:30 ET weekday window (after Plaid's overnight Vanguard re-scrape,
# before the 8:45 digest). The route itself dedupes (once per ET day) and
# skips market holidays, so the ≤2 ticks a 10-min window allows are safe.
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
if ! in_et_window "1,2,3,4,5" 7 30; then
  exit 0
fi

# Past the gate: this tick does work. One line so the log shows the tick ran
# even when both calls below fail without a readable answer.
echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync tick start"

ENV_FILE=/Users/Yitzi/code/vanguard-skin/.env.local
if [ ! -f "$ENV_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: $ENV_FILE not found"
  exit 2
fi

# The cron route refuses every call without the shared secret, so a missing
# one is named here instead of being logged as the route's refusal.
SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$SECRET" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: CRON_SHARED_SECRET missing from $ENV_FILE"
  exit 2
fi
HEADERS=(-H "Content-Type: application/json" -H "X-Cron-Secret: $SECRET")

for url in "http://localhost:3099/api/cron/plaid-sync" "http://localhost:3000/api/cron/plaid-sync"; do
  response=$(curl -sS --max-time 180 -w $'\n%{http_code}' -X POST "${HEADERS[@]}" -d '{}' "$url" 2>&1)
  curl_exit=$?
  code=$(printf '%s\n' "$response" | tail -n 1)
  # Any 2xx is success, and only when curl itself finished cleanly.
  if [ $curl_exit -eq 0 ] && [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync OK via $url: $(printf '%s\n' "$response" | head -n 1)"
    exit 0
  fi
done
echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync failed on both ports: $response"
exit 1
