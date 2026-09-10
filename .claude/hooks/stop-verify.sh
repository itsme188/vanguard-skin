#!/usr/bin/env bash
# Stop hook — runs the smallest current verification evidence check once per
# stop cycle. NEVER runs the full suite (that was the old `npx vitest run |
# tail -3` hook, whose exit code was always tail's — failures never reached
# Claude).
#
# Output contract: plain stderr at exit 0 is NOT surfaced to Claude, so an
# advisory outcome (manual test selection required / no current evidence)
# is reported as a single `{"systemMessage": "..."}` JSON object on stdout
# at exit 0 instead — nothing else may go to stdout. A real failure stays
# exit 2 with the tail of the log on stderr (that path IS surfaced). The
# A genuine pass prints nothing; a clean checkout still needs current task evidence.
#
# Test seams: PD_STOP_VERIFY_CMD overrides the verification command (run via
# `bash -c`, so shell builtins like `exit 7` work); PD_COORD_DIR overrides
# the coordination directory (default: $(git rev-parse --git-common-dir)/
# portfolio-desk-coord, resolved from the project root).
set -u
set -o pipefail

input=$(cat)

stop_hook_active=$(printf '%s' "$input" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print('true' if d.get('stop_hook_active') else 'false')
" 2>/dev/null)

project_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$project_root" ] && exit 0
cd "$project_root" || exit 0

common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -n "$common_dir" ]; then
  case "$common_dir" in
    /*) ;;
    *) common_dir="$project_root/$common_dir" ;;
  esac
fi
coord_dir="${PD_COORD_DIR:-${common_dir:+$common_dir/portfolio-desk-coord}}"
[ -z "$coord_dir" ] && exit 0
mkdir -p "$coord_dir/logs" || { printf "stop-verify: cannot record verification logs\n" >&2; exit 2; }

# The coordination root is shared; Stop outcomes are NOT. Partition by
# canonical worktree and Claude session, and never interpolate input as paths.
scope=$(printf '%s' "$input" | python3 -c '
import hashlib, json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
session = d.get("session_id") or d.get("transcript_path") or ("parent:" + sys.argv[2])
print(hashlib.sha256(json.dumps([os.path.realpath(sys.argv[1]), session]).encode()).hexdigest())
' "$project_root" "$PPID") || exit 2
session_logs="$coord_dir/logs/stop-verify/$scope"
mkdir -p "$session_logs" || exit 2
status_file="$session_logs/last-status"

emit_message() {
  # $1 = message text -> the ONLY stdout line, as {"systemMessage": "..."}
  python3 -c "import json,sys; print(json.dumps({'systemMessage': sys.argv[1]}))" "$1"
}

write_status() {
  # $1 = status word (passed|failed|unverified|advice|skipped), $2 = log path (may be "")
  tmp="$status_file.tmp-$$"
  printf '%s\t%s\n' "$1" "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$status_file" 2>/dev/null
}

# Once-per-stop-cycle guard: Claude Code sets stop_hook_active on the SECOND
# pass of a stop cycle this hook itself blocked. Never re-run here — just
# surface a reminder if the run that blocked it actually failed.
if [ "$stop_hook_active" = "true" ]; then
  if [ -f "$status_file" ]; then
    last_status=$(cut -f1 "$status_file" 2>/dev/null)
    last_log=$(cut -f2- "$status_file" 2>/dev/null)
    if [ "$last_status" = "failed" ]; then
      emit_message "stop-verify: the previous verification failure may still be unresolved — see $last_log"
    elif [ "$last_status" = "unverified" ]; then
      emit_message "stop-verify: the working tree still has no verification evidence (unverified is not passed) — see $last_log"
    fi
  fi
  exit 0
fi

# A branch can be clean but contain unverified committed task changes.
# Always ask the runner; it binds evidence to HEAD and the complete task diff.
log=$(python3 -c 'import os, sys, tempfile; fd, name = tempfile.mkstemp(prefix="run-", suffix=".log", dir=sys.argv[1]); os.close(fd); print(name)' "$session_logs") || exit 2

if [ -n "${PD_STOP_VERIFY_CMD:-}" ]; then
  cmd="$PD_STOP_VERIFY_CMD"
elif [ -f "scripts/verify.sh" ]; then
  cmd="bash scripts/verify.sh status --base main"
else
  # Focused evidence cannot satisfy an authoritative full-suite gate.
  write_status "unverified" ""
  printf 'stop-verify: shared verification runner is unavailable; integrate scripts/verify.sh before claiming verified completion.\n' >&2
  exit 2
fi

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

# Bounded at 240s. The alarm is set before exec, so it survives into the
# execed command (same portable pattern as scripts/verify-smoke.sh's ab()).
perl -e 'alarm shift; exec "bash", "-c", $ARGV[0]' 240 "$cmd" > "$log" 2>&1
status=$?

case "$status" in
  0)
    if grep -q '^verify: result=no-relevant-changes ' "$log"; then
      write_status "skipped" "$log"
    else
      write_status "passed" "$log"
    fi
    exit 0
    ;;
  3)
    write_status "advice" "$log"
    emit_message "verification: manual test selection required — see $log"
    exit 0
    ;;
  4)
    # No current evidence for this task state (including a clean branch). Codex parity (2026-09-08): this
    # must REQUEST verification once, not quietly allow a claimed completion.
    # Exit 2 blocks the stop exactly once (the stop_hook_active pass above
    # lets the next stop through with an explicit "unverified" reminder).
    write_status "unverified" "$log"
    {
      printf 'stop-verify: no current verification evidence for the working tree — run `bash scripts/verify.sh full --base main` before finishing; see %s\n' "$log"
    } >&2
    exit 2
    ;;
  *)
    write_status "failed" "$log"
    detail="exit $status"
    if [ "$status" -eq 142 ]; then
      detail="exit $status — likely timed out at the 240s bound"
    fi
    {
      printf 'stop-verify: verification FAILED (%s) —\n' "$detail"
      tail -15 "$log" 2>/dev/null
    } >&2
    exit 2
    ;;
esac
