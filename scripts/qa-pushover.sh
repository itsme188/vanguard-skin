#!/usr/bin/env bash
# Send a Pushover notification for deep-QA findings.
# Usage: scripts/qa-pushover.sh "message text"
# Reads PUSHOVER_APP_TOKEN + PUSHOVER_USER_KEY from .env.local.
# No-ops (exit 0) when keys are missing — never blocks the QA run.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MSG="${1:?usage: qa-pushover.sh \"message\"}"

TOKEN="$(grep -m1 '^PUSHOVER_APP_TOKEN=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"
USERKEY="$(grep -m1 '^PUSHOVER_USER_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"

if [ -z "$TOKEN" ] || [ -z "$USERKEY" ]; then
  echo "qa-pushover: keys missing — skipping notification"; exit 0
fi

curl -s --max-time 15 \
  --form-string "token=$TOKEN" \
  --form-string "user=$USERKEY" \
  --form-string "title=Portfolio Desk Deep QA" \
  --form-string "message=$MSG" \
  https://api.pushover.net/1/messages.json > /dev/null \
  && echo "qa-pushover: sent" || echo "qa-pushover: send failed (non-fatal)"
