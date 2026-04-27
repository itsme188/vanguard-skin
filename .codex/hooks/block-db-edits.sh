#!/bin/bash
# PreToolUse hook (Edit|Write): block direct edits to *.db files.
# Codex hooks receive a JSON object on stdin with {tool_input: {file_path: ...}}.
# Returns Claude-Code-compatible JSON to deny the action.

set -u

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null)

case "$file_path" in
  *.db|*.db-wal|*.db-shm)
    reason="Database files must be modified through API routes or migrations, not directly edited."
    jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
    exit 0
    ;;
esac

exit 0
