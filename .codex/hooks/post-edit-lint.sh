#!/bin/bash
# Read-only, per-file lint. Codex apply_patch supplies tool_input.command.
set -u
input=$(cat)
source "$(dirname "$0")/project-root.sh"
repo_root=$(portfolio_root "$input") || exit 0
cd "$repo_root" || exit 2
code=0
while IFS= read -r -d '' file; do
  case "$file" in *.ts|*.tsx|*.js|*.jsx|*.mjs) ;; *) continue ;; esac
  [ -f "$file" ] || continue
  /opt/homebrew/opt/node@24/bin/node node_modules/eslint/bin/eslint.js "$file" >&2
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'Portfolio Desk lint failed (exit %s) for %s\n' "$result" "$file" >&2
    code=2
  fi
  case "$file" in
    *test*) ;;
    *)
      if grep -n "security_type = '" "$file" | grep -v 'LOWER(' | grep -v '^[[:space:]]*//' >/dev/null; then
        printf 'WARN in %s: Use LOWER(security_type) for case-insensitive SQL comparisons\n' "$file" >&2
      fi
      if grep -n 'security_type ===' "$file" | grep -v 'toLowerCase' | grep -v '^[[:space:]]*//' >/dev/null; then
        printf 'WARN in %s: Use .toLowerCase() for case-insensitive security_type comparisons\n' "$file" >&2
      fi
      ;;
  esac
done < <(printf '%s' "$input" | jq -j '
  ([.tool_input.file_path?, .tool_input.path?] | map(select(type == "string" and length > 0))) +
  ((.tool_input.command // "") | split("\n") | map(select(test("^\\*\\*\\* (Add File|Update File|Move to): ")) | sub("^\\*\\*\\* (Add File|Update File|Move to): "; "")))
  | unique[] | ., "\u0000"')
exit "$code"
