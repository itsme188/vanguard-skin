#!/bin/bash
# PreToolUse hook (Bash): block sqlite3 commands that mutate a .db file.
# Closes the loophole left by block-db-edits.sh, which only catches the Edit|Write
# tools. Smart agents will route writes through `sqlite3 ... INSERT/UPDATE/...`
# instead, which the Edit|Write matcher misses entirely.
#
# What this blocks:
#   sqlite3 data/vanguard.db "INSERT INTO ..."
#   sqlite3 vanguard.db "UPDATE ..."
#   sqlite3 anything.db "DELETE FROM ..."
#   sqlite3 anything.db "DROP TABLE ..."
#   sqlite3 anything.db < migration.sql      (defensive — could be writes)
#   sqlite3 anything.db ".restore ..."       (overwrites)
#
# What this allows:
#   sqlite3 data/vanguard.db ".schema X"
#   sqlite3 data/vanguard.db "SELECT ..."
#   sqlite3 data/vanguard.db ".dump"
#   sqlite3 data/vanguard.db "PRAGMA ..."
#
# To override (e.g., for legit migration work) drop the hook line in
# ~/.codex/config.toml or run the SQL via npm run migrate / API route.

set -u

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Only consider commands that actually invoke sqlite3 against a .db file.
if ! printf '%s' "$cmd" | grep -qiE 'sqlite3[[:space:]].*\.db\b'; then
  exit 0
fi

# Look for write-shaped tokens. Word-boundary anchored, case-insensitive.
write_pattern='\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|VACUUM)\b|\.restore\b|\.import\b|\.read\b|<[[:space:]]*[^|&;<>]+'

if printf '%s' "$cmd" | grep -qiE "$write_pattern"; then
  reason="sqlite3 write blocked. Mutations to .db files must go through API routes or numbered migrations in lib/db/migrations/, not ad-hoc shell SQL.

Command: $cmd

If this is a legit migration, run it via 'npx tsx scripts/...' or 'npm run migrate' which uses the migration runner. To bypass for one-off recovery, comment out the block-sqlite3-writes hook in ~/.codex/config.toml."
  jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
fi

exit 0
