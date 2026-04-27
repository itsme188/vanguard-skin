#!/bin/bash
# PreToolUse hook (Bash): block Electron DMG rebuilds when docs/plans/TODO.md
# is stale relative to HEAD commits. Self-gates: only fires inside vanguard-skin.
#
# Ported from .claude/hooks/check-todo-reconciled.sh — Codex uses the same
# stdin-JSON contract, so the body is unchanged.

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

# Self-gate: only run for vanguard-skin
case "$repo_root" in
  */vanguard-skin) ;;
  *) exit 0 ;;
esac

cd "$repo_root" || exit 0

last_todo=$(git log -1 --format=%H -- docs/plans/TODO.md 2>/dev/null)

if [ -z "$last_todo" ]; then
  exit 0
fi

n=$(git log --oneline "${last_todo}..HEAD" -- . ':!docs/plans/TODO.md' 2>/dev/null | wc -l | tr -d ' ')

if [ "$n" -gt 0 ]; then
  commits=$(git log --oneline "${last_todo}..HEAD" -- . ':!docs/plans/TODO.md' 2>/dev/null | head -5)
  reason="TODO.md reconciliation required before rebuild. $n commit(s) landed since docs/plans/TODO.md was last updated:"$'\n'"$commits"$'\n\n'"Reconcile docs/plans/TODO.md (mark shipped items with today's date + commit hash, add any new TODOs) first. See .agents/skills/ship/SKILL.md step 4."
  jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
fi

exit 0
