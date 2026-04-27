#!/bin/bash
# PostToolUse hook (Edit|Write): eslint --fix the changed file, then run a
# narrow tsc + security_type case-sensitivity lint. Self-gates to vanguard-skin.
#
# Codex hook contract: stdout MUST be valid JSON (or empty). All diagnostic
# output goes to stderr — Codex shows stderr to the user but doesn't parse it.
# Codex hooks receive {tool_input: {file_path: "..."}} on stdin (NOT
# $CLAUDE_FILE_PATHS like Claude Code).

set -u

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null)

# Bail if no file (some Edit calls touch shells / batch ops)
[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$repo_root" ] && exit 0

# Self-gate: only act inside vanguard-skin
case "$repo_root" in
  */vanguard-skin) ;;
  *) exit 0 ;;
esac

cd "$repo_root" || exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx)
    # All diagnostic output to stderr so Codex doesn't try to parse it as JSON.
    {
      npx eslint --fix "$file" 2>&1
      npx tsc --noEmit 2>&1 | head -20

      # security_type case-sensitivity guard (project convention).
      # PostToolUse fires AFTER the edit, so we surface a warning rather
      # than block. The model sees stderr and can self-correct on the next turn.
      case "$file" in
        *test*) ;;  # tests are allowed to be explicit
        *)
          if grep -n "security_type = '" "$file" | grep -v 'LOWER(' | grep -v '^[[:space:]]*//' >/dev/null; then
            echo "WARN in $file: Use LOWER(security_type) for case-insensitive SQL comparisons"
          fi
          if grep -n "security_type ===" "$file" | grep -v 'toLowerCase' | grep -v '^[[:space:]]*//' >/dev/null; then
            echo "WARN in $file: Use .toLowerCase() for case-insensitive security_type comparisons"
          fi
          ;;
      esac
    } >&2
    ;;
esac

exit 0
