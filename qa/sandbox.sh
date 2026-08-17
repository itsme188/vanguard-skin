#!/usr/bin/env bash
# Sandbox lifecycle for the nightly deep QA sweep.
#   up   — snapshot the live DB (VACUUM INTO) and boot the DEPLOYED Electron
#          standalone server on :3097 with an explicit env allowlist.
#          No outbound keys (Resend/Pushover/Gmail/Worker) are passed, so the
#          sandbox cannot send anything real. DATABASE_PATH (lib/db.ts:11)
#          points every DB read/write at the throwaway copy.
#   down — kill the sandbox server by PID file and delete qa/sandbox/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SANDBOX_DIR="$SCRIPT_DIR/sandbox"
DB_COPY="$SANDBOX_DIR/vanguard-qa.db"
PID_FILE="$SANDBOX_DIR/server.pid"
LOG_FILE="$SANDBOX_DIR/server.log"
PORT=3097
STANDALONE="/Applications/Vanguard Dashboard.app/Contents/Resources/standalone"

up() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Sandbox already running (PID $(cat "$PID_FILE"))"; return 0
  fi
  if [ ! -f "$STANDALONE/server.js" ]; then
    echo "ERROR: deployed standalone server not found at $STANDALONE" >&2; exit 1
  fi

  mkdir -p "$SANDBOX_DIR"
  rm -f "$DB_COPY"
  # Clean point-in-time copy; safe while Electron holds the WAL.
  sqlite3 "$PROJECT_DIR/data/vanguard.db" "VACUUM INTO '$DB_COPY'"
  echo "DB snapshot: $DB_COPY ($(du -h "$DB_COPY" | cut -f1))"

  # Mint a qa session into the SNAPSHOT COPY (not the live DB) so the sweep
  # can authenticate past the #35 trust boundary. Persisted to session.env
  # for both the health-check loop below and the zone agents.
  if ! (cd "$PROJECT_DIR" && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/mint-qa-session.ts --db "$DB_COPY") > "$SANDBOX_DIR/session.env"; then
    echo "ERROR: failed to mint a QA session into $DB_COPY" >&2
    exit 1
  fi
  if [ ! -s "$SANDBOX_DIR/session.env" ]; then
    echo "ERROR: mint-qa-session.ts produced an empty session.env" >&2
    exit 1
  fi

  # Random per-boot throwaway values — satisfies the #35 boot guard
  # (instrumentation.ts refuses to start with a blank CRON_SHARED_SECRET or
  # ELECTRON_SERVICE_CRED under NODE_ENV=production) without ever giving the
  # sandbox real credentials. Nothing needs to know these values: the
  # sandbox never receives a cron request or an Electron-main service call.
  local qa_cron_secret qa_electron_cred
  qa_cron_secret="$(openssl rand -hex 32)"
  qa_electron_cred="$(openssl rand -hex 32)"

  # Pull ONLY the keys the sandbox is allowed to have from .env.local.
  # Outbound (RESEND/PUSHOVER/GMAIL/WORKER_MARKER_URL/CRON secret) is
  # deliberately absent — all those surfaces no-op gracefully when unset.
  local anthropic finnhub fred
  anthropic="$(grep -m1 '^ANTHROPIC_API_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"
  finnhub="$(grep -m1 '^FINNHUB_API_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"
  fred="$(grep -m1 '^FRED_API_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"

  # CRITICAL: the deployed standalone bundles its OWN .env.local (full secrets:
  # Resend, Pushover, Gmail, Worker secret, R2) which Next.js auto-loads at
  # boot — `env -i` alone does NOT block it. @next/env only adopts a dotenv key
  # when it is absent from the process environment, so pin every bundled key to
  # an empty string; the allowlisted three get real values below (a real env
  # entry also wins over the dotenv copy).
  local -a pins=()
  local key
  # Enumerate keys from every dotenv file Next's loadEnvConfig reads in
  # production (in load order: production.local > local > production > base).
  # The grep+awk form handles leading whitespace, "export KEY=…" prefix, and
  # key names containing "." or "-" (all valid in dotenv).
  for dotenv_file in \
    "$STANDALONE/.env.production.local" \
    "$STANDALONE/.env.local" \
    "$STANDALONE/.env.production" \
    "$STANDALONE/.env"
  do
    [ -f "$dotenv_file" ] || continue
    while IFS= read -r key; do
      case "$key" in
        ANTHROPIC_API_KEY|FINNHUB_API_KEY|FRED_API_KEY|CRON_SHARED_SECRET|ELECTRON_SERVICE_CRED|APP_EXTRA_HOSTS|APP_EXTRA_ORIGINS) ;;
        *) pins+=("$key=") ;;
      esac
    done < <(grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_.-]*' "$dotenv_file" 2>/dev/null \
               | awk '{print $NF}' || true)
  done

  # APP_EXTRA_HOSTS/ORIGINS: verify-request's Host gate rejects any request
  # whose Host is not allowlisted BEFORE credentials are examined, and :3097
  # is not in the built-in list (only :3099/:3000/public hostname) — without
  # these every sandbox request 401s even with a valid session. Placed AFTER
  # the pins (env resolves duplicate keys last-one-wins).
  (
    cd "$STANDALONE"
    env -i HOME="$HOME" PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
      NODE_ENV=production PORT="$PORT" HOSTNAME=127.0.0.1 \
      DATABASE_PATH="$DB_COPY" \
      CRON_SHARED_SECRET="$qa_cron_secret" \
      ELECTRON_SERVICE_CRED="$qa_electron_cred" \
      ${pins[@]+"${pins[@]}"} \
      APP_EXTRA_HOSTS="localhost:$PORT,127.0.0.1:$PORT" \
      APP_EXTRA_ORIGINS="http://localhost:$PORT,http://127.0.0.1:$PORT" \
      ${anthropic:+ANTHROPIC_API_KEY="$anthropic"} \
      ${finnhub:+FINNHUB_API_KEY="$finnhub"} \
      ${fred:+FRED_API_KEY="$fred"} \
      node server.js > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )

  # Source VGS_SESSION out of session.env (written above) so the health
  # check carries the same cookie the zone agents will use — #35 requires
  # an authenticated session on every route, /api/summary included.
  local health_session
  health_session="$(grep -m1 '^VGS_SESSION=' "$SANDBOX_DIR/session.env" | cut -d= -f2- | tr -d "'")"
  for i in $(seq 1 30); do
    if curl -sf -H "Cookie: vgs_session=$health_session" "http://localhost:$PORT/api/summary" > /dev/null 2>&1; then
      echo "Sandbox up on :$PORT (PID $(cat "$PID_FILE"))"; return 0
    fi
    sleep 1
  done
  cp "$LOG_FILE" "$SCRIPT_DIR/sandbox-boot-failure.log" 2>/dev/null || true
  echo "ERROR: sandbox server did not become healthy in 30s — see $SCRIPT_DIR/sandbox-boot-failure.log" >&2
  down; exit 1
}

down() {
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid"; sleep 1; fi
  fi
  rm -rf "$SCRIPT_DIR/sandbox"
  echo "Sandbox down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "Usage: qa/sandbox.sh up|down" >&2; exit 1 ;;
esac
