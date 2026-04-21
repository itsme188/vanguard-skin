#!/bin/bash
# Retry sending daily digest email with backoff.
# Called by launchd plist. Retries up to 3 times with 2-minute delays
# in case the Electron app is still starting up.

URL="http://localhost:3099/api/digest/email"
MAX_RETRIES=3
DELAY=120  # 2 minutes between retries

for i in $(seq 1 $MAX_RETRIES); do
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Attempt $i of $MAX_RETRIES"
  RESPONSE=$(curl -sS --max-time 300 -X POST \
    -H "Content-Type: application/json" \
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
