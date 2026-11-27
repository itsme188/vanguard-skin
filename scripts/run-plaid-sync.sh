#!/bin/bash
# Daily Plaid → Vanguard holdings sync. Fires on the first tick inside the
# 07:30 ET weekday window (after Plaid's overnight Vanguard re-scrape,
# before the 8:45 digest). The route itself dedupes (once per ET day) and
# skips market holidays, so the ≤2 ticks a 10-min window allows are safe.
# A read is stored only before 09:30 ET and is dated on the previous
# trading session (plan v4 A1); the log line says which session.
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

# First value of a JSON string field in the answer, or "-" when absent or
# null. The answer is one line of compact JSON; bash 3.2 has no JSON tool,
# so the fields are read with grep -o.
json_string() {
  local v
  v=$(printf '%s\n' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n 1 | sed -e "s/^\"$2\":\"//" -e 's/"$//')
  if [ -z "$v" ]; then v="-"; fi
  printf '%s' "$v"
}

# One summary line for a 2xx answer:
#   SKIPPED (<reason>) dating=<state> session=<S> stored=<n> skipped=<reason>:<n>,...
#   OK dating=<state> session=<S> stored=<n> skipped=none
# Whole-read reasons (skippedReason): market_closed, before_window (before
# 07:30 ET), after_open, already_synced_today, read_finished_after_open; or,
# for a null result, the route's cause (not_configured, not_connected,
# no_account_mapped, sync_in_progress, cleared_before_read).
# Per-account reasons (counted after skipped=): see the loop below.
summarize() {
  local body="$1" status reason dating session stored skipped r n extra
  reason=$(json_string "$body" skippedReason)
  if [ "$reason" = "-" ]; then
    # A null result: not configured, not connected, no account mapped, or
    # another sync running. The route names it in "cause".
    if printf '%s\n' "$body" | grep -q '"data":null'; then
      reason=$(json_string "$body" cause)
    fi
  fi
  if [ "$reason" = "-" ]; then status="OK"; else status="SKIPPED ($reason)"; fi
  dating=$(json_string "$body" datingState)
  session=$(json_string "$body" session)
  stored=$(printf '%s\n' "$body" | grep -o '"accountsSynced":[0-9]*' | head -n 1 | sed 's/.*://')
  if [ -z "$stored" ]; then stored=0; fi
  skipped=""
  for r in missing_in_response no_positions statement_on_session legacy_rows_after_session; do
    n=$(printf '%s\n' "$body" | grep -o "\"reason\":\"$r\"" | wc -l | tr -d ' ')
    if [ "$n" != "0" ]; then
      if [ -n "$skipped" ]; then skipped="$skipped,"; fi
      skipped="$skipped$r:$n"
    fi
  done
  if [ -z "$skipped" ]; then skipped="none"; fi
  extra=""
  if printf '%s\n' "$body" | grep -q '"valuationsRecomputed":false'; then
    extra=" valuations=not_updated"
  fi
  n=$(printf '%s\n' "$body" | grep -o '"pricesHeldLegacyAfter":[0-9]*' | head -n 1 | sed 's/.*://')
  if [ -n "$n" ] && [ "$n" != "0" ]; then extra="$extra prices_held_legacy_after=$n"; fi
  printf '%s dating=%s session=%s stored=%s skipped=%s%s' "$status" "$dating" "$session" "$stored" "$skipped" "$extra"
}

for url in "http://localhost:3099/api/cron/plaid-sync" "http://localhost:3000/api/cron/plaid-sync"; do
  response=$(curl -sS --max-time 180 -w $'\n%{http_code}' -X POST "${HEADERS[@]}" -d '{}' "$url" 2>&1)
  curl_exit=$?
  code=$(printf '%s\n' "$response" | tail -n 1)
  # Any 2xx is success, and only when curl itself finished cleanly.
  if [ $curl_exit -eq 0 ] && [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    body=$(printf '%s\n' "$response" | head -n 1)
    echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync via $url: $(summarize "$body")"
    exit 0
  fi
done
echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync failed on both ports: $response"
exit 1
