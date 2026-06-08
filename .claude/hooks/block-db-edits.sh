#!/usr/bin/env bash
# PreToolUse(Edit|Write): deterministically block edits to SQLite DB files only.
# Allows every other path (the previous prompt-based hook misfired on the allow path,
# blocking all legitimate edits). Reads the tool-call JSON from stdin.
input=$(cat)
fp=$(printf '%s' "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)
case "$fp" in
  *.db|*.db-wal|*.db-shm|*.sqlite|*.sqlite3)
    echo "Database files must be modified through API routes or migrations, not directly edited." >&2
    exit 2
    ;;
esac
exit 0
