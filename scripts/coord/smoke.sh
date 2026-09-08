#!/usr/bin/env bash
# smoke.sh — serialized, task-scoped wrapper around scripts/verify-smoke.sh
# (design §6 + §11 F7/F20).
#
# The browser daemon is the one resource a sandbox cannot isolate: two
# concurrent agent-browser runs contend (2026-09-06 blank session). This
# wrapper takes the `browser` lock for the whole run, so two smokes queue
# instead of colliding, and it points verify-smoke.sh at the task's own
# sandbox (its own port, its own DB copy, its own minted session) so no
# password and no live data are involved.
#
# Usage:
#   scripts/coord/smoke.sh --task ID [--base-url URL] [--session-env PATH]
#                          [--evidence DIR] [--wait SECONDS] [--live]
#
#   default (sandbox mode)  requires $PD_COORD_DIR/sandboxes/<task>/manifest.json
#                           written by sandbox.sh up; base_url / session.env /
#                           DB come from it. Cookie auth, no password.
#   --live                  runs against the installed app on :3099 with the
#                           password path; also takes the `app-3099` lock.
#                           VERIFY_SMOKE_PASSWORD must already be exported.
#   --base-url/--session-env override the manifest; the host must be localhost
#                           or 127.0.0.1.
#
# Exit codes:
#   <smoke rc>  whatever scripts/verify-smoke.sh exited with (preserved exactly)
#   1           refused / invalid input (no manifest, non-loopback host, no password)
#   75          `browser` (or `app-3099`) lock held by another task after --wait
#
# Test seams:
#   PD_COORD_DIR      coordination root (default <git-common-dir>/portfolio-desk-coord)
#   PD_SMOKE_SCRIPT   replaces scripts/verify-smoke.sh — honoured only when
#                     PD_SMOKE_TEST_MODE=1.
#   PD_SMOKE_TEST_MODE  "1" enables the seam above.
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD="$SCRIPT_DIR/coord.sh"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

err() { printf '%s\n' "$*" >&2; }
die() { local code="$1"; shift; err "$@"; exit "$code"; }

usage() {
  err "Usage: smoke.sh --task ID [--base-url URL] [--session-env PATH] [--evidence DIR] [--wait SECONDS] [--live]"
}

abspath() {
  python3 -c 'import os,sys; sys.stdout.write(os.path.realpath(sys.argv[1]))' "$1"
}

valid_task_id() {
  case "$1" in
    "") return 1 ;;
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ ${#1} -le 64 ] || return 1
  return 0
}

# host part of a URL, port stripped
url_host() {
  printf '%s' "$1" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#/.*$##' -e 's#@.*$##' -e 's#:[0-9]*$##'
}

require_loopback() { # url label
  local host
  host="$(url_host "$1")"
  case "$host" in
    localhost|127.0.0.1) return 0 ;;
    *) die 1 "smoke: refused: $2 host '$host' is not loopback (localhost or 127.0.0.1 only)" ;;
  esac
}

manifest_field() { # manifest key
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
v = d.get(sys.argv[2])
sys.stdout.write("" if v is None else str(v))' "$1" "$2" 2>/dev/null
}

resolve_coord_dir() {
  local raw common
  if [ -n "${PD_COORD_DIR:-}" ]; then
    raw="$PD_COORD_DIR"
  else
    common="$(git rev-parse --git-common-dir 2>/dev/null)" || common=""
    [ -n "$common" ] || die 1 "smoke: not inside a git repo and PD_COORD_DIR is unset"
    raw="$common/portfolio-desk-coord"
  fi
  COORD_DIR="$(abspath "$raw")"
  [ -n "$COORD_DIR" ] || die 1 "smoke: could not resolve PD_COORD_DIR"
}

# --- locks ------------------------------------------------------------------
BROWSER_HELD=0
BROWSER_TOKEN=""
APP_HELD=0
APP_TOKEN=""

acquire_lock() { # name -> sets LAST_TOKEN, exits 75 on contention
  local name="$1" out rc
  out="$("$COORD" lock acquire "$name" --task "$TASK" --owner "smoke" --ttl 90m --wait "$WAIT" --pid $$ --exclusive)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    err "smoke: refused: lock '$name' is held by another task (waited ${WAIT}s)"
    exit 75
  fi
  LAST_TOKEN="$(printf '%s\n' "$out" | sed -n 's/^LOCK_TOKEN=//p' | head -1)"
  return 0
}

release_locks() {
  if [ "$APP_HELD" = "1" ]; then
    if [ -n "$APP_TOKEN" ]; then
      "$COORD" lock release "app-3099" --task "$TASK" --token "$APP_TOKEN" >/dev/null 2>&1 || true
    else
      "$COORD" lock release "app-3099" --task "$TASK" >/dev/null 2>&1 || true
    fi
    APP_HELD=0
  fi
  if [ "$BROWSER_HELD" = "1" ]; then
    if [ -n "$BROWSER_TOKEN" ]; then
      "$COORD" lock release "browser" --task "$TASK" --token "$BROWSER_TOKEN" >/dev/null 2>&1 || true
    else
      "$COORD" lock release "browser" --task "$TASK" >/dev/null 2>&1 || true
    fi
    BROWSER_HELD=0
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  release_locks
  exit "$rc"
}

# --- arguments --------------------------------------------------------------
TASK=""
BASE_URL_ARG=""
SESSION_ENV_ARG=""
EVIDENCE_ARG=""
WAIT="600"
LIVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK="${2:-}"; shift 2 || die 1 "smoke: --task needs a value" ;;
    --base-url) BASE_URL_ARG="${2:-}"; shift 2 || die 1 "smoke: --base-url needs a value" ;;
    --session-env) SESSION_ENV_ARG="${2:-}"; shift 2 || die 1 "smoke: --session-env needs a value" ;;
    --evidence) EVIDENCE_ARG="${2:-}"; shift 2 || die 1 "smoke: --evidence needs a value" ;;
    --wait) WAIT="${2:-}"; shift 2 || die 1 "smoke: --wait needs a value" ;;
    --live) LIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die 1 "smoke: unknown argument '$1'" ;;
  esac
done

valid_task_id "$TASK" || die 1 "smoke: refused: invalid --task id (expected ^[A-Za-z0-9._-]{1,64}\$)"
case "$WAIT" in
  ''|*[!0-9]*) die 1 "smoke: refused: --wait must be a whole number of seconds" ;;
esac
[ -n "$BASE_URL_ARG" ] && require_loopback "$BASE_URL_ARG" "--base-url"

resolve_coord_dir

# --- resolve target ---------------------------------------------------------
BASE_URL=""
SESSION_ENV=""
SANDBOX_DB=""

if [ "$LIVE" = "1" ]; then
  BASE_URL="${BASE_URL_ARG:-http://localhost:3099}"
  require_loopback "$BASE_URL" "--live base url"
  [ -n "${VERIFY_SMOKE_PASSWORD:-}" ] \
    || die 1 "smoke: refused: --live uses the password path; export VERIFY_SMOKE_PASSWORD first"
  # --session-env is still honoured for --live, but never required.
  SESSION_ENV="$SESSION_ENV_ARG"
else
  MANIFEST="$COORD_DIR/sandboxes/$TASK/manifest.json"
  [ -f "$MANIFEST" ] || die 1 "smoke: refused: no sandbox manifest at $MANIFEST — run 'sandbox.sh up --task $TASK' first, or pass --live"
  BASE_URL="${BASE_URL_ARG:-$(manifest_field "$MANIFEST" base_url)}"
  SESSION_ENV="${SESSION_ENV_ARG:-$(manifest_field "$MANIFEST" session_env)}"
  SANDBOX_DB="$(manifest_field "$MANIFEST" db)"
  [ -n "$BASE_URL" ] || die 1 "smoke: refused: manifest $MANIFEST has no base_url"
  require_loopback "$BASE_URL" "sandbox base url"
  [ -n "$SESSION_ENV" ] || die 1 "smoke: refused: manifest $MANIFEST has no session_env"
  [ -r "$SESSION_ENV" ] || die 1 "smoke: refused: session env is not readable: $SESSION_ENV"
fi

if [ -n "$EVIDENCE_ARG" ]; then
  EVIDENCE_DIR="$EVIDENCE_ARG"
else
  EVIDENCE_DIR="$COORD_DIR/evidence/$TASK/$(date -u '+%Y-%m-%dT%H%M%SZ')"
fi
mkdir -p "$EVIDENCE_DIR" || die 1 "smoke: could not create evidence dir $EVIDENCE_DIR"

# --- locks (browser first, then app-3099 for --live) ------------------------
trap on_exit EXIT

LAST_TOKEN=""
acquire_lock "browser"
BROWSER_HELD=1
BROWSER_TOKEN="$LAST_TOKEN"

if [ "$LIVE" = "1" ]; then
  acquire_lock "app-3099"
  APP_HELD=1
  APP_TOKEN="$LAST_TOKEN"
fi

# --- run --------------------------------------------------------------------
SMOKE_SCRIPT="$REPO/scripts/verify-smoke.sh"
if [ "${PD_SMOKE_TEST_MODE:-}" = "1" ] && [ -n "${PD_SMOKE_SCRIPT:-}" ]; then
  SMOKE_SCRIPT="$PD_SMOKE_SCRIPT"
fi

export VERIFY_SMOKE_BASE_URL="$BASE_URL"
export VERIFY_SMOKE_SESSION="smoke-$TASK"
export VERIFY_SMOKE_EVIDENCE_DIR="$EVIDENCE_DIR"
export VERIFY_SMOKE_NO_GLOBAL_CLEANUP=1
if [ -n "$SESSION_ENV" ]; then
  export VERIFY_SMOKE_SESSION_ENV="$SESSION_ENV"
fi
if [ -n "$SANDBOX_DB" ]; then
  export DATABASE_PATH="$SANDBOX_DB"
fi

bash "$SMOKE_SCRIPT"
RC=$?

release_locks

if "$COORD" task show "$TASK" --json >/dev/null 2>&1; then
  "$COORD" task checkpoint "$TASK" --note "smoke exit $RC" --evidence "$EVIDENCE_DIR" >/dev/null 2>&1 || true
fi

printf 'SMOKE exit=%s evidence=%s\n' "$RC" "$EVIDENCE_DIR"
exit "$RC"
