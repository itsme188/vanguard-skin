#!/usr/bin/env bash
# PostToolUse(Edit|Write) — read-only checks on the SINGLE file that was just
# edited. Reads tool_input.file_path (fallback tool_input.path) from stdin
# JSON. Never mutates the file (no --fix). Findings go to stderr, exit 2;
# no findings, exit 0 with no output. Silently no-ops for anything outside
# .ts/.tsx/.js/.jsx or outside the project root.
#
# Test seams: PD_HOOK_SKIP_ESLINT=1 / PD_HOOK_SKIP_TSC=1 skip the respective
# check (tests use these so a run doesn't pay for a full tsc pass). Default
# is to run both.
set -u
set -o pipefail

input=$(cat)

file_path=$(printf '%s' "$input" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('')
    sys.exit(0)
ti = d.get('tool_input') or {}
fp = ti.get('file_path') or ti.get('path') or ''
print(fp)
" 2>/dev/null)

[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] || exit 0

case "$file_path" in
  *.ts | *.tsx | *.js | *.jsx) ;;
  *) exit 0 ;;
esac

project_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$project_root" ] && exit 0

abs_file=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$file_path" 2>/dev/null)
abs_root=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$project_root" 2>/dev/null)
[ -z "$abs_file" ] && exit 0
[ -z "$abs_root" ] && exit 0

case "$abs_file" in
  "$abs_root"/*) ;;
  *) exit 0 ;;
esac

cd "$abs_root" || exit 0
rel_file=${abs_file#"$abs_root"/}

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

findings=""
add_finding() {
  if [ -z "$findings" ]; then
    findings="$1"
  else
    findings="$findings
$1"
  fi
}

# (a) eslint — no --fix, bounded at 60s. This ESLint install (v9, flat
# config) ships only the stylish/json/html core formatters; the
# unix/compact formatter packages the design called for are not installed
# here, so the default (stylish) formatter is used instead — it exits
# non-zero only on real lint problems, unlike an unresolvable --format flag.
if [ "${PD_HOOK_SKIP_ESLINT:-0}" != "1" ]; then
  eslint_out=$(perl -e 'alarm shift; exec @ARGV' 60 npx eslint --no-fix "$rel_file" 2>&1)
  eslint_status=$?
  if [ "$eslint_status" -ne 0 ]; then
    trimmed=$(printf '%s\n' "$eslint_out" | head -10)
    add_finding "eslint:
$trimmed"
  fi
fi

# (b) tsc --noEmit, bounded at 90s, filtered to lines for THIS file only —
# the repo carries a 20-error baseline in unrelated test files that must
# never leak into a single-file check. --incremental false so the hook
# never writes a tsbuildinfo file (tsconfig.json has incremental:true).
if [ "${PD_HOOK_SKIP_TSC:-0}" != "1" ]; then
  tsc_out=$(perl -e 'alarm shift; exec @ARGV' 90 npx tsc --noEmit --pretty false --incremental false 2>&1)
  tsc_status=$?
  diag_count=$(printf '%s\n' "$tsc_out" | grep -c 'error TS')
  if [ "$tsc_status" -ne 0 ] && [ "$diag_count" -eq 0 ]; then
    # tsc exited non-zero (crash, timeout/alarm-kill, config error) with no
    # diagnostic lines at all — this is a tooling failure, not a finding
    # about the edited file. Say so plainly and stop.
    printf 'post-edit-check: tsc did not run cleanly (exit %s)\n' "$tsc_status" >&2
    exit 2
  fi
  filtered=$(printf '%s\n' "$tsc_out" | python3 -c "
import sys
rel = sys.argv[1]
for line in sys.stdin:
    line = line.rstrip('\n')
    if line.startswith(rel + '(') or line.startswith(rel + ':'):
        print(line)
" "$rel_file" | head -10)
  if [ -n "$filtered" ]; then
    add_finding "tsc:
$filtered"
  fi
fi

# (c) security_type case-sensitivity guard — carried over from the OLD
# hook: per-LINE, not per-file ("test" anywhere on the line is treated as
# a test fixture and skipped), with the comment-exclusion bug fixed (the
# old `grep -v '^\/\/'` ran on grep -n's "N:content" output and so never
# matched anything; this now strips the line-number prefix first).
bad1=$(grep -n "security_type = '" "$rel_file" 2>/dev/null | grep -v 'LOWER(' | grep -v 'test' | grep -vE '^[0-9]+:[[:space:]]*//')
bad2=$(grep -n 'security_type ===' "$rel_file" 2>/dev/null | grep -v 'toLowerCase' | grep -v 'test' | grep -vE '^[0-9]+:[[:space:]]*//')
if [ -n "$bad1" ] || [ -n "$bad2" ]; then
  add_finding "security_type: Use LOWER(security_type) / .toLowerCase() for case-insensitive security_type comparisons"
fi

if [ -n "$findings" ]; then
  {
    printf 'post-edit-check[%s] (edited-file-only checks; consumers not checked):\n' "$rel_file"
    printf '%s\n' "$findings"
  } | head -20 >&2
  exit 2
fi

exit 0
