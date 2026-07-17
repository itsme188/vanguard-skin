# Shared browser-process cleanup for the nightly QA scripts.
#
# Problem (observed 2026-07-17): every nightly run left an agent-browser
# daemon + "Chrome for Testing" pair alive indefinitely — `agent-browser
# close` doesn't kill the daemon, and abort paths skip cleanup entirely.
# Pairs from 7/16 AND 7/17 were both still resident at midday 7/17.
#
# Approach: baseline-diff, not pattern-kill. At script start we snapshot the
# PIDs of any already-running browser/daemon processes (an interactive
# session may legitimately own some); at EXIT we kill only matching
# processes that appeared AFTER the baseline — i.e., only what this run
# spawned. Safe under DEEP_QA_FORCE daytime runs alongside live sessions.
#
# Usage — two shapes, because bash EXIT traps REPLACE rather than stack:
#   Script with no EXIT trap of its own (nightly-qa-cron.sh):
#     source "$QA_DIR/lib/agent-browser-cleanup.sh"
#     ab_cleanup_init          # snapshot baseline + install EXIT trap
#   Script that already owns an EXIT trap (nightly-deep-qa.sh):
#     source "$SCRIPT_DIR/lib/agent-browser-cleanup.sh"
#     ab_baseline              # snapshot only — no trap
#     trap '<existing cleanup>; ab_cleanup' EXIT   # chain manually

# Process patterns this cleanup owns. Deliberately narrow:
#  - the agent-browser daemon binary
#  - agent-browser's own Chrome-for-Testing cache path
#  - npx-launched playwright-mcp servers (deep-QA zone agents)
#  - playwright's browser cache path (ms-playwright)
# Never matches TWS's jxbrowser Chromium, the user's real Chrome, or the
# Electron app's next-server.
AB_CLEANUP_PATTERN='agent-browser-darwin|\.agent-browser/browsers|playwright-mcp|ms-playwright'

ab_baseline() {
  AB_BASELINE_PIDS=$(pgrep -f "$AB_CLEANUP_PATTERN" 2>/dev/null | sort || true)
}

ab_cleanup_init() {
  ab_baseline
  trap ab_cleanup EXIT
}

ab_cleanup() {
  # Graceful first: close every agent-browser session (best-effort, daemon
  # may still survive this — that's what the kill pass below is for).
  command -v agent-browser >/dev/null 2>&1 && agent-browser close --all >/dev/null 2>&1 || true
  sleep 2
  local pid
  for pid in $(pgrep -f "$AB_CLEANUP_PATTERN" 2>/dev/null || true); do
    # Pre-existing at baseline → not ours, leave it alone.
    if printf '%s\n' "$AB_BASELINE_PIDS" | grep -qx "$pid"; then
      continue
    fi
    echo "[ab-cleanup] killing run-spawned PID $pid ($(ps -p "$pid" -o command= 2>/dev/null | cut -c1-80))"
    kill "$pid" 2>/dev/null || true
  done
  # Escalate only for survivors of the polite kill (daemons ignore TERM
  # occasionally); still PID-exact, still baseline-guarded.
  sleep 2
  for pid in $(pgrep -f "$AB_CLEANUP_PATTERN" 2>/dev/null || true); do
    if printf '%s\n' "$AB_BASELINE_PIDS" | grep -qx "$pid"; then
      continue
    fi
    kill -9 "$pid" 2>/dev/null || true
  done
}
