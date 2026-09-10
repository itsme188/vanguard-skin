#!/bin/bash
# Stop checks authoritative evidence; tests run explicitly through the shared runner.
# Codex 0.153.4: exit 2 + stderr requests continuation. Never hide runner failure.
set -u
input=$(cat)
source "$(dirname "$0")/project-root.sh"
repo_root=$(portfolio_root "$input") || exit 0
if bash "$repo_root/scripts/verify.sh" status >&2; then
  exit 0
fi
reason='Portfolio Desk full-suite verification is missing, failed, or stale. Run bash scripts/verify.sh full --base <explicit-integration-base>, inspect its logs, and report any unresolved failures. Do not claim verified completion.'
# One continuation only: do not turn a pre-existing failure into an infinite loop.
if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = true ]; then
  jq -n --arg reason "$reason" '{continue:false,stopReason:$reason,systemMessage:$reason}'
  exit 0
fi
printf '%s\n' "$reason" >&2
exit 2
