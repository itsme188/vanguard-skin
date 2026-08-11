#!/bin/bash
# Wrapper for com.vanguard-skin.state-snapshot.plist.
# Plist runs every 5 min (StartInterval=300). Self-gates to daily 02:00 ET
# (10-min window) via scripts/lib/et-gate.sh — outside that window, exits
# 0 in ~50ms. cd into the project root so relative paths (data/vanguard.db,
# .env.local) resolve correctly, then run the TypeScript snapshot via tsx.
#
# Staleness catch-up (2026-07-15): a Mac asleep at 02:00 misses the window
# entirely and every cloud-fallback email then runs on a day-old-or-worse
# snapshot (observed: 7/15's cloud digest used the 7/13 snapshot after two
# slept-through nights). If the last SUCCESSFUL snapshot is >26h old, run on
# the next 5-min tick regardless of hour. Marker file (touched only after a
# clean run) lives in gitignored data/.

set -euo pipefail

# Prefer Homebrew node on Apple Silicon; fall back to whatever's on PATH.
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

MARKER=/Users/Yitzi/code/vanguard-skin/data/.state-snapshot-last-success
STALE_MINUTES=1560  # 26h — one missed 02:00 window plus slack

# Self-gate before doing anything else.
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
if in_et_window "1,2,3,4,5,6,7" 2 0; then
  : # scheduled 02:00 ET run
elif [ ! -f "$MARKER" ] || [ -n "$(find "$MARKER" -mmin +$STALE_MINUTES 2>/dev/null)" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — catch-up run: last successful snapshot >26h old (Mac slept through 02:00)"
else
  exit 0
fi

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

# Only a clean snapshot run reaches here (set -e) — stamp success so the
# staleness catch-up knows the last good run.
touch "$MARKER"
