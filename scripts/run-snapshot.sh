#!/bin/bash
# Wrapper for com.vanguard-skin.state-snapshot.plist.
# Plist runs every 5 min (StartInterval=300). Self-gates to daily 02:00 ET
# (10-min window) via scripts/lib/et-gate.sh — outside that window, exits
# 0 in ~50ms. cd into the project root so relative paths (data/vanguard.db,
# .env.local) resolve correctly, then run the TypeScript snapshot via tsx.

set -euo pipefail

# Prefer Homebrew node on Apple Silicon; fall back to whatever's on PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Self-gate before doing anything else.
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
in_et_window "1,2,3,4,5,6,7" 2 0 || exit 0

cd /Users/Yitzi/code/vanguard-skin

# Isolate npm cache so a root-owned ~/.npm cache entry can't block cron.
# (Happens once on some machines from pre-2021 npm; proper fix is
#  `sudo chown -R $USER:staff ~/.npm`, but the cron must work regardless.)
export npm_config_cache="${TMPDIR:-/tmp}/vanguard-skin-npm-cache"

echo "$(date '+%Y-%m-%d %H:%M:%S') — refreshing Vanguard betas"
(cd /Users/Yitzi/code/vanguard-skin && npx tsx scripts/refresh-vanguard-betas.ts) || \
  echo "$(date '+%Y-%m-%d %H:%M:%S') — beta refresh failed (continuing)"

echo "$(date '+%Y-%m-%d %H:%M:%S') — starting state snapshot"
npx -y tsx scripts/snapshot-state-to-r2.ts
