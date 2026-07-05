#!/bin/bash
# Launchd entry: post-release calendar enrichment + earnings email sweep.
# Called every 15 min, 24/7, with NO time-of-day gate by
# ~/Library/LaunchAgents/com.vanguard-skin.calendar-enrich.plist
# (StartInterval=900; the plist has never had a 09:30-16:00 window — each
# tick no-ops cheaply, <200ms, outside business hours since findCandidates
# returns [] when nothing is in-window). This matters for the retry-until-
# settle enrichment loop (Task 6/B2) and AMC earnings recaps: both DEPEND on
# evening/overnight ticks still running — a market-hours-only gate would
# have silently starved every AMC recap and any retry past 4pm ET.
#
# Two responsibilities per tick (Phase 3, 2026-04-28):
#   1. Calendar enrichment — fill actual_value + reaction_snapshot for
#      events whose release window has opened.
#   2. Earnings email sweep — fire previews 105–135 min before release,
#      fire recaps within 4h after enrichment populates.
#
# Each step prefers the running Electron app's HTTP endpoint on :3099
# (TWS state shared, no separate DB connection), falls back to dev server
# on :3000, then to a standalone tsx invocation. Steps run sequentially.

ENV_FILE="/Users/Yitzi/code/vanguard-skin/.env.local"
PROJECT_DIR="/Users/Yitzi/code/vanguard-skin"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ ! -f "$ENV_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — ERROR: $ENV_FILE not found"
  exit 2
fi

SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
HEADERS=(-H "Content-Type: application/json")
if [ -n "$SECRET" ]; then
  HEADERS+=(-H "X-Cron-Secret: $SECRET")
fi

cd "$PROJECT_DIR" || exit 2

# Try a POST against each candidate URL in order; on the first 2xx response,
# print the body and return 0. On all-failure, print the last body, return 1.
# Args: <max-time-seconds> <url1> [url2 ...]
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

# ── 1. Enrichment ───────────────────────────────────────────────────
echo "$(date '+%Y-%m-%d %H:%M:%S') — enrichment tick"
if try_http_post 180 \
    "http://localhost:3099/api/calendar/enrich" \
    "http://localhost:3000/api/calendar/enrich"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — enrichment HTTP OK"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') — enrichment HTTP failed, falling back to tsx"
  npx tsx scripts/enrich-calendar-events.ts || true
fi

# ── 2. Earnings email sweep (Phase 3) ───────────────────────────────
# Self-gates on the candidate window — empty windows return immediately
# with `swept: 0`. 600s budget: multi-candidate ticks run 60-180s of Claude
# compose per email. DB claim rows (error='in_progress') make the tsx
# fallback idempotent even if this HTTP call times out mid-loop.
echo "$(date '+%Y-%m-%d %H:%M:%S') — earnings-sweep tick"
if try_http_post 600 \
    "http://localhost:3099/api/cron/earnings-sweep" \
    "http://localhost:3000/api/cron/earnings-sweep"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — sweep HTTP OK"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') — sweep HTTP failed, falling back to tsx"
  npx tsx scripts/sweep-earnings-emails.ts || true
fi
