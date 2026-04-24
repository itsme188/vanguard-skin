#!/bin/bash
# PreToolUse hook — block Electron DMG rebuilds if docs/plans/TODO.md is stale vs HEAD commits.
# Grace: exits 0 silently if TODO.md has never been committed, or if the bash command isn't a rebuild.

set -u

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

case "$cmd" in
  *electron:deploy*|*electron:pack*) ;;
  *) exit 0 ;;
esac

repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$repo_root" ]; then
  exit 0
fi
cd "$repo_root" || exit 0

last_todo=$(git log -1 --format=%H -- docs/plans/TODO.md 2>/dev/null)

if [ -z "$last_todo" ]; then
  exit 0
fi

n=$(git log --oneline "${last_todo}..HEAD" -- . ':!docs/plans/TODO.md' 2>/dev/null | wc -l | tr -d ' ')

if [ "$n" -gt 0 ]; then
  commits=$(git log --oneline "${last_todo}..HEAD" -- . ':!docs/plans/TODO.md' 2>/dev/null | head -5)
  reason="TODO.md reconciliation required before rebuild. $n commit(s) landed since docs/plans/TODO.md was last updated:"$'\n'"$commits"$'\n\n'"Reconcile docs/plans/TODO.md (mark shipped items with today's date + commit hash, add any new TODOs) first. See .claude/skills/ship/SKILL.md step 5."
  jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
fi

exit 0
