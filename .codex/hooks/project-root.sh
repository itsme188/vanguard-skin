#!/bin/bash
# Source from hooks. Resolve the event cwd first, never a checkout basename.
portfolio_root() {
  local event_cwd root
  event_cwd=$(printf '%s' "$1" | jq -r '.cwd // empty') || return 1
  root=$(git -C "${event_cwd:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || return 1
  jq -e '.name == "vanguard-skin" and .repository.url == "https://github.com/itsme188/vanguard-skin.git"' "$root/package.json" >/dev/null 2>&1 || return 1
  printf '%s\n' "$root"
}
