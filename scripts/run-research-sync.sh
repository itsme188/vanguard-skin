#!/bin/bash
# Launchd entry: background research-feed sync.
# Called every 90 min (StartInterval=5400) by
# ~/Library/LaunchAgents/com.vanguard-skin.research-sync.plist
#
# Self-gates to Mon-Fri 09:00-19:00 ET (the 19:00 ceiling pre-empts a planned
# evening 7pm digest email so newsletters arriving in the late afternoon get
# AI-processed in time). Outside that window, exits 0 immediately.
#
# Hits the running Electron app on :3099 first (shares TWS state, no separate
# DB connection), falls back to dev server on :3000. Does NOT send any email
# — pure background sync. The morning digest cron + Sunday briefing cron
# still do their own sync immediately before composing.

ENV_FILE="/Users/Yitzi/code/vanguard-skin/.env.local"
PROJECT_DIR="/Users/Yitzi/code/vanguard-skin"

if [ ! -f "$ENV_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: $ENV_FILE not found"
  exit 2
fi

# ── Self-gate: Mon-Fri 09:00-19:00 ET ────────────────────────────────
# `date` defaults to local time. The Mac runs in America/New_York, so
# this is ET directly. If we ever travel/relocate, the launchd self-gate
# would shift; that's intentionally simple — the calendar-enrich plist
# uses the same local-time pattern.
DOW=$(date +%u)        # 1=Mon ... 7=Sun
HOUR=$(date +%H)       # 00-23
if [ "$DOW" -gt 5 ]; then
  exit 0  # weekend — no newsletter traffic worth processing live
fi
if [ "$HOUR" -lt 9 ] || [ "$HOUR" -ge 19 ]; then
  exit 0  # outside 09:00-19:00 ET window
fi

SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
HEADERS=(-H "Content-Type: application/json")
if [ -n "$SECRET" ]; then
  HEADERS+=(-H "X-Cron-Secret: $SECRET")
fi

cd "$PROJECT_DIR" || exit 2

try_http_post() {
  local max_time=$1
  shift
  local last_body=""
  for url in "$@"; do
    local response curl_exit status body
    response=$(curl -sS --max-time "$max_time" -w $'\n%{http_code}' -X POST \
      "${HEADERS[@]}" \
      -d '{}' \
      "$url" 2>&1)
    curl_exit=$?
    status=$(printf '%s\n' "$response" | tail -n 1)
    body=$(printf '%s\n' "$response" | sed '$d')
    if [ $curl_exit -eq 0 ] && [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
      printf '%s\n' "$body"
      return 0
    fi
    last_body="$body"
  done
  printf '%s\n' "$last_body"
  return 1
}

echo "$(date '+%Y-%m-%d %H:%M:%S') — research-sync tick"
if try_http_post 240 \
    "http://localhost:3099/api/cron/research-sync" \
    "http://localhost:3000/api/cron/research-sync"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — research-sync HTTP OK"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') — research-sync HTTP failed"
  exit 1
fi
