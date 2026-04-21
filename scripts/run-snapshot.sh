#!/bin/bash
# Wrapper for com.vanguard-skin.state-snapshot.plist.
# cd into the project root so relative paths (data/vanguard.db, .env.local)
# resolve correctly, then run the TypeScript snapshot script via tsx.

set -euo pipefail

cd /Users/Yitzi/code/vanguard-skin

# Prefer Homebrew node on Apple Silicon; fall back to whatever's on PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Isolate npm cache so a root-owned ~/.npm cache entry can't block cron.
# (Happens once on some machines from pre-2021 npm; proper fix is
#  `sudo chown -R $USER:staff ~/.npm`, but the cron must work regardless.)
export npm_config_cache="${TMPDIR:-/tmp}/vanguard-skin-npm-cache"

echo "$(date '+%Y-%m-%d %H:%M:%S') — starting state snapshot"
npx -y tsx scripts/snapshot-state-to-r2.ts
