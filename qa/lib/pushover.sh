#!/usr/bin/env bash
# Shared Pushover sender for QA tooling. Tokens come from the Electron
# settings.json because launchd jobs do NOT load .env.local (same sourcing
# as nightly-deep-qa.sh::notify_failure). Silent no-op when unconfigured.
# Usage: source qa/lib/pushover.sh; qa_pushover "Title" "message body"
qa_pushover() {
  local title="$1" msg="$2"
  local cfg="$HOME/Library/Application Support/Vanguard Dashboard/settings.json"
  [ -f "$cfg" ] || return 0
  local tok usr
  tok=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pushoverAppToken','') or '')" "$cfg" 2>/dev/null) || return 0
  usr=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pushoverUserKey','') or '')" "$cfg" 2>/dev/null) || return 0
  [ -n "$tok" ] && [ -n "$usr" ] || return 0
  curl -s --max-time 10 \
    --form-string "token=$tok" --form-string "user=$usr" \
    --form-string "title=$title" \
    --form-string "message=$msg" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 || true
}
