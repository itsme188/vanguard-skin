#!/bin/bash
# Stop hook: smoke-run the test suite at the end of every Codex session.
# Self-gates to vanguard-skin (most projects don't use vitest).
#
# Codex hook contract: stdout MUST be valid JSON (or empty). Any human-readable
# output goes to stderr — Codex shows stderr to the user but does not parse it.
# Exit 0 + empty stdout is also valid (silent success).

set -u

repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$repo_root" ] && exit 0

case "$repo_root" in
  */vanguard-skin) ;;
  *) exit 0 ;;
esac

cd "$repo_root" || exit 0
[ -f package.json ] || exit 0

# Run vitest. Stream the tail to stderr so the user sees the test summary
# without polluting stdout (which Codex parses as JSON hook output).
{
  npx vitest run --reporter=dot --exclude '.claude/**' --exclude '.agents/**' 2>&1 | tail -3
} >&2

# Empty stdout = silent success per Codex hook contract.
exit 0
