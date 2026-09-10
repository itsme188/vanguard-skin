#!/bin/bash
# Shared Claude/Codex entrypoint. No dependency installation or mutable PATH pin.
set -euo pipefail
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
[ -x /opt/homebrew/opt/node@24/bin/node ] || { echo 'Pinned Node 24 is unavailable' >&2; exit 1; }
cd "$(dirname "$0")/.."
exec /opt/homebrew/opt/node@24/bin/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/lib/verification-loader.mjs scripts/verify-runner.ts "$@"
