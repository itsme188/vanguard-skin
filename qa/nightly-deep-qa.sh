#!/usr/bin/env bash
# Nightly deep QA — sandbox up, headless /qa-deep-sweep, sandbox down.
# Scheduled by com.vanguard-skin.nightly-deep-qa.plist (StartInterval=300,
# i.e. every 5 min) with the self-gate below: once per local day, first tick
# inside the 02:45–07:00 local window.
# PATH DEVIATION: claude CLI lives at /Users/Yitzi/.local/bin (not in standard
# Homebrew/system paths); that directory is prepended below.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
export PATH="/Users/Yitzi/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$PROJECT_DIR"

# --- Loud failure -------------------------------------------------------------
# This job has died SILENTLY twice now (6/13-6/14, then again 6/19-6/24): a model
# gate made `claude` exit 1 in seconds and nobody noticed for ~9 days because
# NOTHING alerted on a non-zero exit. Every abort path below routes through here.
# Pushover tokens come from settings.json (launchd does NOT load .env.local).
notify_failure() {
  local msg="$1"
  echo "DEEP-QA FAILURE: $msg" >&2
  local cfg="$HOME/Library/Application Support/Vanguard Dashboard/settings.json"
  [ -f "$cfg" ] || return 0
  local tok usr
  tok=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pushoverAppToken','') or '')" "$cfg" 2>/dev/null) || return 0
  usr=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pushoverUserKey','') or '')" "$cfg" 2>/dev/null) || return 0
  [ -n "$tok" ] && [ -n "$usr" ] || return 0
  curl -s --max-time 10 \
    --form-string "token=$tok" --form-string "user=$usr" \
    --form-string "title=Deep-QA cron failed" \
    --form-string "message=$msg" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 || true
}

# --- Schedule self-gate ------------------------------------------------------
# Why not StartCalendarInterval: launchd evaluates Hour/Minute in the timezone
# UserEventAgent cached at boot, NOT the current system zone. The Mac booted
# 2026-05-20 in Israel (UTC+3), so "Hour 2, Minute 45" fired at 19:45 ET every
# night (observed 6/10 + 6/11) and collided with evening use. Same failure
# class the et-gate.sh pattern fixed for the email jobs — this job gates on
# LOCAL time deliberately (2:45 AM is about Mac-idle hours, not market hours).
# Window is bounded at 07:00 so a Mac asleep past it skips the night rather
# than launching a 3h sweep mid-day. DEEP_QA_FORCE=1 bypasses the gate for
# manual runs (the mutex below still applies).
MARKER_FILE="$SCRIPT_DIR/findings/.deep-qa-last-run"
if [ "${DEEP_QA_FORCE:-0}" != "1" ]; then
  MIN_OF_DAY=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))
  { [ "$MIN_OF_DAY" -ge 165 ] && [ "$MIN_OF_DAY" -lt 420 ]; } || exit 0
  [ "$(cat "$MARKER_FILE" 2>/dev/null)" = "$(date +%Y-%m-%d)" ] && exit 0
fi
date +%Y-%m-%d > "$MARKER_FILE"

echo "=== Deep QA run $(date '+%Y-%m-%d %H:%M:%S') ==="

# Single-run mutex. launchd fires a "missed" StartCalendarInterval occurrence
# immediately when a plist is (re)loaded after the scheduled time — observed
# 2026-06-10, when loading the plist at ~18:40 started a full production run
# that collided with an in-session manual sweep (shared browser + shared git
# working tree). One sweep at a time, ever.
LOCK_DIR="/tmp/vanguard-deep-qa.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_AGE_MIN=$(( ($(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)) / 60 ))
  if [ "$LOCK_AGE_MIN" -lt 180 ]; then
    echo "Another deep-QA run holds the lock (${LOCK_AGE_MIN}m old) — exiting."; exit 0
  fi
  echo "Stale lock (${LOCK_AGE_MIN}m) — taking over."
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

if ! command -v claude &>/dev/null; then
  notify_failure "claude CLI not on PATH — aborting"; exit 1
fi

# --- npx / MCP launch preflight ----------------------------------------------
# The zone agents' playwright + sqlite MCP servers are npx-launched. A poisoned
# user npm cache (root-owned shards from a sudo npm run on 2026-04-23) made
# every MCP launch die with EACCES — the 2026-06-12 run swept 0 zones. Two
# layers: (1) a dedicated cache (inherited by claude → npx children) so this
# job never depends on shared user-cache state; (2) a fail-fast probe so a
# broken launch path aborts HERE with a diagnosis instead of burning a sandbox
# boot + a claude session that can only report "no browser tools".
export NPM_CONFIG_CACHE="$SCRIPT_DIR/sandbox/npm-cache"
if ! npx -y @playwright/mcp@latest --version >/dev/null 2>&1; then
  notify_failure "npx cannot launch @playwright/mcp (cache: $NPM_CONFIG_CACHE) — aborting before sandbox boot"
  exit 1
fi

# Browser-process cleanup (2026-07-17): nightly runs were leaving daemon +
# Chrome-for-Testing pairs alive indefinitely. Reap PPID-1 orphans from prior
# killed runs FIRST (so they don't land in the baseline and survive forever),
# then baseline BEFORE any browser work; ab_cleanup chains into the single
# EXIT trap below (traps replace).
source "$SCRIPT_DIR/lib/agent-browser-cleanup.sh"
ab_reap_orphans
ab_baseline

bash "$SCRIPT_DIR/sandbox.sh" up || { notify_failure "sandbox boot failed"; exit 1; }
# Single EXIT trap (bash traps replace, not stack): sandbox down + release lock + browser cleanup.
trap 'bash "$SCRIPT_DIR/sandbox.sh" down; rmdir "$LOCK_DIR" 2>/dev/null; ab_cleanup' EXIT

# --- Model selection: PROBE for the strongest CALLABLE model -----------------
# Do NOT rely on `--model fable --fallback-model opus,sonnet`. That was the
# 2026-06-15 fix and it FAILED silently every night 6/19-6/24: a pulled model
# (Fable 5, under the gov "fable-mythos-access" hold) stays a valid alias but
# 404s at use with "Claude Fable 5 is currently unavailable" → exit 1, and
# `--fallback-model` does NOT rescue the `claude -p "/qa-deep-sweep"`
# slash-command invocation (verified by repro: bare `--model fable` reproduces
# the exact failure; the fallback only engages for plain-text prompts).
# Instead, probe each rung with a throwaway 1-token call and pass the first
# CALLABLE model as a concrete --model — mirrors the app-side model-catalog
# "probe callability" approach (a pulled model is LISTED but uncallable) and
# auto-returns to Fable the moment its probe passes again, no edit needed.
pick_model() {
  local m
  for m in fable opus sonnet; do
    if claude -p "ok" --model "$m" >/dev/null 2>&1; then echo "$m"; return 0; fi
  done
  return 1
}
MODEL="$(pick_model)" || { notify_failure "no callable model (fable/opus/sonnet all failed the probe)"; exit 1; }
echo "Resolved callable model: $MODEL"

# --- Headless background-task ceiling -----------------------------------------
# The sweep dispatches one agent-browser subagent per zone. When the orchestrator
# runs them as BACKGROUND tasks (a non-deterministic model choice — SKILL.md Step 1
# doesn't force blocking dispatch), `claude -p` applies its default 600s
# CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS and KILLS the still-running zone agent at the
# 10-min mark, then exits 0. That silently truncated the sweep every night 6/29-7/1
# (12-19 min runs, no findings, no run log, no alert — exit 0 dodged notify_failure).
# A real 7-zone sweep takes ~2h (up to ~6h when the Mac sleeps mid-run), so lift the
# ceiling to 6h. Finite, not 0/indefinite, so a genuinely-hung agent can't bleed into
# the next day; the post-run completeness guard below turns a >6h cut into a loud fail.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=21600000  # 6h

claude -p "/qa-deep-sweep" --model "$MODEL"
STATUS=$?
[ "$STATUS" -ne 0 ] && notify_failure "/qa-deep-sweep exited $STATUS (model $MODEL)"

# --- Completeness guard (exit 0 is NOT proof of a finished sweep) --------------
# The 600s-ceiling kills above exited 0, so non-zero-only alerting stayed silent for
# ~4 nights. The sweep's FINAL action is appending qa/findings/runs/<today>.md
# (SKILL.md "Run log" step), so its absence means the sweep died before finalizing —
# regardless of exit code. Alert on that even when STATUS is 0.
RUN_LOG="$SCRIPT_DIR/findings/runs/$(date +%Y-%m-%d).md"
if [ "$STATUS" -eq 0 ] && [ ! -f "$RUN_LOG" ]; then
  notify_failure "/qa-deep-sweep exited 0 but wrote no run log ($(basename "$RUN_LOG")) — sweep died before finalizing findings"
fi

echo "=== Deep QA finished (claude exit $STATUS) $(date '+%Y-%m-%d %H:%M:%S') ==="
exit $STATUS
