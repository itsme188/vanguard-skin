#!/usr/bin/env bash
#
# deploy.sh — coordinated wrapper around the EXISTING Electron deploy chain.
#
#   Usage: bash scripts/coord/deploy.sh [--task ID] [--commit SHA] [--allow-unpushed] [--dry-run]
#          npm run deploy -- [same flags]
#
# It adds no build step. It wraps:
#     1. npm run electron:pack
#     2. node scripts/verify-bundle.js
#     3. npm run electron:install
# with named locks (so nobody lands or deploys underneath a running build),
# a preflight that refuses to build the wrong tree, a pre-quit of the running
# app, and a post-verify that proves the app on disk is the one that was
# just built and is actually answering.
#
# Design: docs/superpowers/specs/2026-09-08-agent-coordination-design.md
#         sections 3, 4 and 11 (the review fold overrides section 4).
#
# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
#   --task ID          coordination task id used for the locks; also receives a
#                      `task checkpoint` when the deploy succeeds. Default:
#                      deploy-<UTC stamp>.
#   --commit SHA       require HEAD to be exactly this commit (short prefixes
#                      accepted). Checked INDEPENDENTLY of the pushed check.
#   --allow-unpushed   downgrade "HEAD == origin/main" from a failure to a WARN.
#   --dry-run          stop after preflight (no quit, no chain, no install).
#
# ---------------------------------------------------------------------------
# Exit codes
# ---------------------------------------------------------------------------
#   0   deploy completed and post-verify passed (or --dry-run finished)
#   64  usage error (unknown flag / missing flag value)
#   65  preflight failure (wrong checkout, dirty tree, unpushed HEAD, wrong
#       commit, tracer leak, missing next binary, stale TODO.md, missing
#       toolchain, missing test chain script)
#   70  post-verify failure — including the pre-quit check (old app still
#       listening), BUILD_ID mismatch, codesign, no new listener, health probe
#   75  lock contention (propagated from coord.sh; the holder is printed)
#   N   the failing chain step's own exit code (step 1, 2 or 3)
#
# ---------------------------------------------------------------------------
# Locks (acquired BEFORE preflight, released by the EXIT trap in reverse order)
# ---------------------------------------------------------------------------
#   integration   nobody may merge/push into main while this runs
#   deploy        one Electron build+install at a time
#   app-3099      the installed app is quit, replaced and relaunched
#
# ---------------------------------------------------------------------------
# Test seams — every one of these is honoured ONLY when PD_DEPLOY_TEST_MODE=1.
# Outside test mode a set seam is IGNORED and a WARN is logged.
# ---------------------------------------------------------------------------
#   PD_MAIN_CHECKOUT              required repo root (default /Users/Yitzi/code/vanguard-skin)
#   PD_DEPLOY_CHAIN_DIR           dir holding pack.sh / gate.sh / install.sh that
#                                 replace the three real chain steps
#   PD_BUILT_APP                  built .app (default <checkout>/dist/mac-arm64/Vanguard Dashboard.app)
#   PD_INSTALLED_APP              installed .app (default /Applications/Vanguard Dashboard.app)
#   PD_DEPLOY_PORT                port the app listens on (default 3099)
#   PD_DEPLOY_HEALTH_URL          health URL (default http://127.0.0.1:<port>/login)
#   PD_DEPLOY_HEALTH_MARKER       string the health body must contain (default "Portfolio Desk")
#   PD_DEPLOY_QUIT_CMD            shell command used to quit the running app
#   PD_DEPLOY_EXPECT_CMD_SUBSTR   substring the new listener's command must contain
#                                 (default: the installed .app path)
#   PD_DEPLOY_SKIP_CODESIGN=1     skip the codesign verification
#   PD_SKIP_FETCH=1               skip `git fetch origin main`
#   PD_DEPLOY_QUIT_WAIT_SECONDS       pre-quit wait     (default 30)
#   PD_DEPLOY_LISTENER_WAIT_SECONDS   new-listener wait (default 120)
#   PD_DEPLOY_HEALTH_WAIT_SECONDS     health wait       (default 60)
#
#   PD_COORD_DIR is NOT a test seam — it is the coord CLI's own contract and is
#   always honoured (default: <git common dir>/portfolio-desk-coord).
#
# bash 3.2 compatible: no associative arrays, no ${var,,}, no mapfile.
# `set -e` is deliberately NOT used — every exit code is handled explicitly.

set -u
set -o pipefail

# ---------------------------------------------------------------------------
# Resolution (before any cd)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COORD="$SCRIPT_DIR/coord.sh"

if [ -n "${PD_COORD_DIR:-}" ]; then
  COORD_DIR_RAW="$PD_COORD_DIR"
else
  COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)"
  if [ -z "$COMMON_DIR" ]; then
    echo "deploy: not inside a git repository and PD_COORD_DIR is unset" >&2
    exit 65
  fi
  COMMON_DIR="$(cd "$COMMON_DIR" && pwd -P)"
  COORD_DIR_RAW="$COMMON_DIR/portfolio-desk-coord"
fi

mkdir -p "$COORD_DIR_RAW" || {
  echo "deploy: cannot create coord dir $COORD_DIR_RAW" >&2
  exit 65
}
PD_COORD_DIR="$(cd "$COORD_DIR_RAW" && pwd -P)"
export PD_COORD_DIR
mkdir -p "$PD_COORD_DIR/logs" || {
  echo "deploy: cannot create $PD_COORD_DIR/logs" >&2
  exit 65
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$PD_COORD_DIR/logs/deploy-$STAMP.log"
: > "$LOG"
DEPLOYS_LOG="$PD_COORD_DIR/deploys.log"

TEST_MODE=0
if [ "${PD_DEPLOY_TEST_MODE:-}" = "1" ]; then
  TEST_MODE=1
fi

# ---------------------------------------------------------------------------
# Logging — everything the wrapper prints also lands in $LOG
# ---------------------------------------------------------------------------

log() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >> "$LOG"
}

log_err() {
  printf '%s\n' "$*" >&2
  printf '%s\n' "$*" >> "$LOG"
}

usage() {
  cat <<'USAGE'
Usage: bash scripts/coord/deploy.sh [--task ID] [--commit SHA] [--allow-unpushed] [--dry-run]

  --task ID          coordination task id for the locks + success checkpoint
  --commit SHA       require HEAD to be exactly this commit
  --allow-unpushed   downgrade the "HEAD == origin/main" check to a warning
  --dry-run          stop after preflight
USAGE
}

usage_error() {
  log_err "deploy: $*"
  usage >&2
  exit 64
}

# ---------------------------------------------------------------------------
# Locks + cleanup trap
# ---------------------------------------------------------------------------

TASK=""
LOCK_NAMES=()
LOCK_TOKENS=()
ACQUIRED_TOKEN=""

cleanup() {
  local count idx name token
  count=${#LOCK_NAMES[@]}
  idx=$((count - 1))
  while [ "$idx" -ge 0 ]; do
    name="${LOCK_NAMES[$idx]}"
    token="${LOCK_TOKENS[$idx]}"
    if [ -n "$token" ]; then
      "$COORD" lock release "$name" --task "$TASK" --token "$token" >> "$LOG" 2>&1 || true
    else
      "$COORD" lock release "$name" --task "$TASK" >> "$LOG" 2>&1 || true
    fi
    idx=$((idx - 1))
  done
  LOCK_NAMES=()
  LOCK_TOKENS=()
}

# The trap must never clobber the exit code, and cleanup must never exit.
trap 'rc=$?; cleanup; exit $rc' EXIT

acquire_lock() {
  local name="$1"
  local ttl="$2"
  local errfile out rc holder token
  errfile="$PD_COORD_DIR/logs/deploy-$STAMP.lock-$name.err"
  ACQUIRED_TOKEN=""
  out="$("$COORD" lock acquire "$name" --task "$TASK" --owner deploy --ttl "$ttl" --pid $$ --exclusive 2>"$errfile")"
  rc=$?
  if [ -n "$out" ]; then
    printf '%s\n' "$out" >> "$LOG"
  fi
  holder="$(cat "$errfile" 2>/dev/null)"
  rm -f "$errfile"
  if [ "$rc" -ne 0 ]; then
    log_err "LOCK contention: could not acquire '$name' (coord exit $rc)"
    if [ -n "$holder" ]; then
      log_err "$holder"
    fi
    return "$rc"
  fi
  token="$(printf '%s\n' "$out" | sed -n 's/^LOCK_TOKEN=//p' | head -1)"
  ACQUIRED_TOKEN="$token"
  LOCK_NAMES[${#LOCK_NAMES[@]}]="$name"
  LOCK_TOKENS[${#LOCK_TOKENS[@]}]="$token"
  log "LOCK acquired: $name (task=$TASK)"
  return 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

TASK_GIVEN=0
COMMIT=""
ALLOW_UNPUSHED=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --task)
      shift
      [ $# -gt 0 ] || usage_error "--task requires a value"
      TASK="$1"
      TASK_GIVEN=1
      ;;
    --task=*)
      TASK="${1#--task=}"
      TASK_GIVEN=1
      [ -n "$TASK" ] || usage_error "--task requires a value"
      ;;
    --commit)
      shift
      [ $# -gt 0 ] || usage_error "--commit requires a value"
      COMMIT="$1"
      ;;
    --commit=*)
      COMMIT="${1#--commit=}"
      [ -n "$COMMIT" ] || usage_error "--commit requires a value"
      ;;
    --allow-unpushed) ALLOW_UNPUSHED=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done

if [ -z "$TASK" ]; then
  TASK="deploy-$STAMP"
fi

# ---------------------------------------------------------------------------
# Test seams
# ---------------------------------------------------------------------------

SEAM_VALUE=""
resolve_seam() {
  local name="$1"
  local default_value="$2"
  local value
  eval "value=\"\${$name:-}\""
  if [ -n "$value" ]; then
    if [ "$TEST_MODE" = "1" ]; then
      SEAM_VALUE="$value"
      return 0
    fi
    log "WARN: ignoring test seam $name (PD_DEPLOY_TEST_MODE is not 1)"
  fi
  SEAM_VALUE="$default_value"
}

resolve_seam PD_MAIN_CHECKOUT "/Users/Yitzi/code/vanguard-skin"; MAIN_CHECKOUT="$SEAM_VALUE"
resolve_seam PD_BUILT_APP "$MAIN_CHECKOUT/dist/mac-arm64/Vanguard Dashboard.app"; BUILT_APP="$SEAM_VALUE"
resolve_seam PD_INSTALLED_APP "/Applications/Vanguard Dashboard.app"; INSTALLED_APP="$SEAM_VALUE"
resolve_seam PD_DEPLOY_PORT "3099"; PORT="$SEAM_VALUE"
resolve_seam PD_DEPLOY_HEALTH_URL "http://127.0.0.1:$PORT/login"; HEALTH_URL="$SEAM_VALUE"
resolve_seam PD_DEPLOY_HEALTH_MARKER "Portfolio Desk"; HEALTH_MARKER="$SEAM_VALUE"
resolve_seam PD_DEPLOY_QUIT_CMD "osascript -e 'tell application \"$INSTALLED_APP\" to quit'"; QUIT_CMD="$SEAM_VALUE"
resolve_seam PD_DEPLOY_EXPECT_CMD_SUBSTR "$INSTALLED_APP"; EXPECT_CMD_SUBSTR="$SEAM_VALUE"
resolve_seam PD_DEPLOY_SKIP_CODESIGN "0"; SKIP_CODESIGN="$SEAM_VALUE"
resolve_seam PD_SKIP_FETCH "0"; SKIP_FETCH="$SEAM_VALUE"
resolve_seam PD_DEPLOY_CHAIN_DIR ""; CHAIN_DIR="$SEAM_VALUE"
resolve_seam PD_DEPLOY_QUIT_WAIT_SECONDS "30"; QUIT_WAIT="$SEAM_VALUE"
resolve_seam PD_DEPLOY_LISTENER_WAIT_SECONDS "120"; LISTENER_WAIT="$SEAM_VALUE"
resolve_seam PD_DEPLOY_HEALTH_WAIT_SECONDS "60"; HEALTH_WAIT="$SEAM_VALUE"

BUILT_ID_FILE="$BUILT_APP/Contents/Resources/standalone/.next/BUILD_ID"
INSTALLED_ID_FILE="$INSTALLED_APP/Contents/Resources/standalone/.next/BUILD_ID"

# Pin the toolchain (F14: export, do not merely check).
NODE24_BIN="/opt/homebrew/opt/node@24/bin"
export PATH="$NODE24_BIN:$PATH"

log "deploy: task=$TASK stamp=$STAMP log=$LOG"

# ---------------------------------------------------------------------------
# Locks FIRST (Codex review F1) — nobody may land under a running build
# ---------------------------------------------------------------------------

require_lock() {
  local name="$1"
  local ttl="$2"
  local rc
  acquire_lock "$name" "$ttl"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  # 75 is coord.sh's contention code and is propagated verbatim; anything else
  # is a broken coordination environment, which is a preflight failure.
  if [ "$rc" -eq 75 ]; then
    exit 75
  fi
  log_err "PRE-FLIGHT FAIL: coord lock '$name' failed with exit $rc"
  exit 65
}

require_lock integration 60m
require_lock deploy 60m
require_lock app-3099 60m

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

PREFLIGHT_FAILURES=0
HEAD_SHA=""

pre_ok()   { log "PRE-FLIGHT ok: $*"; }
pre_warn() { log "PRE-FLIGHT WARN: $*"; }
pre_fail() {
  log "PRE-FLIGHT FAIL: $*"
  PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
}

# 1. right checkout, right branch --------------------------------------------
REPO_ROOT_RAW="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT_RAW" ]; then
  pre_fail "not inside a git repository (expected $MAIN_CHECKOUT)"
  exit 65
fi
REPO_ROOT="$(cd "$REPO_ROOT_RAW" && pwd -P)"
if [ ! -d "$MAIN_CHECKOUT" ]; then
  pre_fail "main checkout does not exist: $MAIN_CHECKOUT"
  exit 65
fi
MAIN_CHECKOUT="$(cd "$MAIN_CHECKOUT" && pwd -P)"
if [ "$REPO_ROOT" != "$MAIN_CHECKOUT" ]; then
  pre_fail "wrong checkout: $REPO_ROOT (deploy only from $MAIN_CHECKOUT)"
  exit 65
fi
cd "$MAIN_CHECKOUT" || {
  pre_fail "cannot cd to $MAIN_CHECKOUT"
  exit 65
}
pre_ok "repo root is $MAIN_CHECKOUT"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$BRANCH" = "main" ]; then
  pre_ok "on branch main"
else
  pre_fail "branch is '$BRANCH', expected 'main'"
fi

# 2. clean tree ---------------------------------------------------------------
DIRTY="$(git status --porcelain 2>/dev/null)"
if [ -z "$DIRTY" ]; then
  pre_ok "working tree clean"
else
  pre_fail "working tree is dirty (no stash/reset is ever performed):"
  printf '%s\n' "$DIRTY" | head -20 | while IFS= read -r line; do
    log "    $line"
  done
fi

# 3. intended commit ----------------------------------------------------------
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
if [ "$SKIP_FETCH" = "1" ]; then
  pre_warn "skipping 'git fetch origin main' (PD_SKIP_FETCH=1)"
else
  if git fetch origin main --quiet 2>>"$LOG"; then
    pre_ok "fetched origin main"
  else
    pre_warn "git fetch origin main failed; comparing against the local origin/main ref"
  fi
fi

ORIGIN_SHA="$(git rev-parse origin/main 2>/dev/null)"
if [ -z "$ORIGIN_SHA" ]; then
  if [ "$ALLOW_UNPUSHED" = "1" ]; then
    pre_warn "HEAD not pushed: no origin/main ref (allowed by --allow-unpushed)"
  else
    pre_fail "HEAD not pushed: no origin/main ref"
  fi
elif [ "$HEAD_SHA" = "$ORIGIN_SHA" ]; then
  pre_ok "HEAD == origin/main ($HEAD_SHA)"
else
  if [ "$ALLOW_UNPUSHED" = "1" ]; then
    pre_warn "HEAD not pushed: HEAD=$HEAD_SHA origin/main=$ORIGIN_SHA (allowed by --allow-unpushed)"
  else
    pre_fail "HEAD not pushed: HEAD=$HEAD_SHA origin/main=$ORIGIN_SHA"
  fi
fi

# Independent of the pushed check (F10): --commit must equal HEAD.
if [ -n "$COMMIT" ]; then
  WANT_SHA="$(git rev-parse --verify "$COMMIT^{commit}" 2>/dev/null)"
  if [ -z "$WANT_SHA" ]; then
    pre_fail "--commit $COMMIT does not resolve to a commit in this repository"
  elif [ "$WANT_SHA" = "$HEAD_SHA" ]; then
    pre_ok "--commit $COMMIT == HEAD ($HEAD_SHA)"
  else
    pre_fail "--commit mismatch: requested $WANT_SHA but HEAD is $HEAD_SHA"
  fi
fi

# 4. clean build input --------------------------------------------------------
if [ -e "workers/cron/.wrangler" ]; then
  pre_fail "workers/cron/.wrangler exists — the Next output tracer would copy local KV state into the bundle; remove it first"
else
  pre_ok "no workers/cron/.wrangler tracer leak"
fi

if [ -x "node_modules/.bin/next" ] || [ -f "node_modules/.bin/next" ]; then
  pre_ok "node_modules/.bin/next present"
else
  pre_fail "node_modules/.bin/next missing — run npm install in $MAIN_CHECKOUT"
fi

# 5. TODO reconciled (same rule as .claude/hooks/check-todo-reconciled.sh) -----
LAST_TODO="$(git log -1 --format=%H -- docs/plans/TODO.md 2>/dev/null)"
if [ -z "$LAST_TODO" ]; then
  pre_warn "docs/plans/TODO.md has never been committed; skipping the reconciliation check"
else
  TODO_N="$(git log --oneline "$LAST_TODO..HEAD" -- . ':!docs/plans/TODO.md' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${TODO_N:-0}" -gt 0 ]; then
    pre_fail "docs/plans/TODO.md is stale: $TODO_N commit(s) landed since it was last updated:"
    git log --oneline "$LAST_TODO..HEAD" -- . ':!docs/plans/TODO.md' 2>/dev/null | head -5 | while IFS= read -r line; do
      log "    $line"
    done
  else
    pre_ok "docs/plans/TODO.md reconciled"
  fi
fi

# 6. toolchain + chain scripts ------------------------------------------------
if [ -x "$NODE24_BIN/node" ]; then
  pre_ok "node@24 present at $NODE24_BIN/node"
elif [ "$TEST_MODE" = "1" ]; then
  pre_warn "node@24 missing at $NODE24_BIN/node (tolerated in test mode)"
else
  pre_fail "node@24 missing at $NODE24_BIN/node"
fi

if [ -n "$CHAIN_DIR" ]; then
  for chain_script in pack.sh gate.sh install.sh; do
    if [ -x "$CHAIN_DIR/$chain_script" ]; then
      pre_ok "test chain script $CHAIN_DIR/$chain_script"
    else
      pre_fail "test chain script missing or not executable: $CHAIN_DIR/$chain_script"
    fi
  done
fi

# 7. notarization credentials (warning only) ----------------------------------
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  pre_ok "notarization credentials present"
else
  pre_warn "APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER not all set — notarization will be skipped"
fi

if [ "$PREFLIGHT_FAILURES" -gt 0 ]; then
  log "PRE-FLIGHT: $PREFLIGHT_FAILURES check(s) failed — nothing was built"
  exit 65
fi

# Plan --------------------------------------------------------------------
log "PLAN commit=$HEAD_SHA"
log "PLAN built-app=$BUILT_APP"
log "PLAN installed-app=$INSTALLED_APP"
log "PLAN health=$HEALTH_URL (port $PORT, marker \"$HEALTH_MARKER\")"
log "PLAN log=$LOG"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN complete"
  exit 0
fi

# ---------------------------------------------------------------------------
# Pre-quit (F11): the old app must be gone before the chain runs
# ---------------------------------------------------------------------------

listeners_on_port() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' '
}

OLD_PIDS="$(listeners_on_port)"
if [ -n "$OLD_PIDS" ]; then
  log "PRE-QUIT: existing listener(s) on port $PORT: $OLD_PIDS"
else
  log "PRE-QUIT: no listener on port $PORT"
fi

sh -c "$QUIT_CMD" >> "$LOG" 2>&1 || true

quit_waited=0
while [ "$quit_waited" -lt "$QUIT_WAIT" ]; do
  if [ -z "$(listeners_on_port)" ]; then
    break
  fi
  sleep 1
  quit_waited=$((quit_waited + 1))
done

STILL="$(listeners_on_port)"
if [ -n "$STILL" ]; then
  log_err "POST-VERIFY FAIL: old app still listening on port $PORT (pid $STILL) after ${QUIT_WAIT}s — refusing to build"
  exit 70
fi
log "PRE-QUIT ok: port $PORT free"

# ---------------------------------------------------------------------------
# Chain
# ---------------------------------------------------------------------------

STEP_RC=0

record_failure() {
  local step="$1"
  local rc="$2"
  printf '%s commit=%s result=failed step=%s exit=%s log=%s\n' \
    "$STAMP" "$HEAD_SHA" "$step" "$rc" "$LOG" >> "$DEPLOYS_LOG"
}

run_chain_step() {
  local idx="$1"
  local label="$2"
  shift 2
  log "STEP $idx/3: $label"
  "$@" 2>&1 | tee -a "$LOG"
  STEP_RC=${PIPESTATUS[0]}
}

check_step() {
  local idx="$1"
  if [ "$STEP_RC" -ne 0 ]; then
    log_err "FAILED step $idx (exit $STEP_RC)"
    record_failure "$idx" "$STEP_RC"
    exit "$STEP_RC"
  fi
  log "STEP $idx/3 ok"
}

if [ -n "$CHAIN_DIR" ]; then
  run_chain_step 1 "$CHAIN_DIR/pack.sh" "$CHAIN_DIR/pack.sh"
else
  run_chain_step 1 "npm run electron:pack" npm run electron:pack
fi
check_step 1

if [ -n "$CHAIN_DIR" ]; then
  run_chain_step 2 "$CHAIN_DIR/gate.sh" "$CHAIN_DIR/gate.sh"
else
  run_chain_step 2 "node scripts/verify-bundle.js" node scripts/verify-bundle.js
fi
check_step 2

if [ -n "$CHAIN_DIR" ]; then
  run_chain_step 3 "$CHAIN_DIR/install.sh" "$CHAIN_DIR/install.sh"
else
  run_chain_step 3 "npm run electron:install" npm run electron:install
fi
check_step 3

# ---------------------------------------------------------------------------
# Post-verify
# ---------------------------------------------------------------------------

# (a) BUILD_ID -----------------------------------------------------------
if [ ! -f "$BUILT_ID_FILE" ]; then
  log_err "POST-VERIFY FAIL: built BUILD_ID missing at $BUILT_ID_FILE"
  exit 70
fi
if [ ! -f "$INSTALLED_ID_FILE" ]; then
  log_err "POST-VERIFY FAIL: installed BUILD_ID missing at $INSTALLED_ID_FILE"
  exit 70
fi
BUILT_ID="$(cat "$BUILT_ID_FILE" 2>/dev/null | tr -d '\n')"
INSTALLED_ID="$(cat "$INSTALLED_ID_FILE" 2>/dev/null | tr -d '\n')"
if [ "$BUILT_ID" != "$INSTALLED_ID" ]; then
  log_err "POST-VERIFY FAIL: BUILD_ID mismatch (built=$BUILT_ID installed=$INSTALLED_ID)"
  exit 70
fi
log "POST-VERIFY ok: BUILD_ID $BUILT_ID matches on both sides"

# (b) codesign -----------------------------------------------------------
if [ "$SKIP_CODESIGN" = "1" ]; then
  log "POST-VERIFY skip: codesign (PD_DEPLOY_SKIP_CODESIGN=1)"
else
  codesign --verify --deep --strict "$INSTALLED_APP" >> "$LOG" 2>&1
  CODESIGN_RC=$?
  if [ "$CODESIGN_RC" -ne 0 ]; then
    log_err "POST-VERIFY FAIL: codesign --verify --deep --strict failed (exit $CODESIGN_RC) on $INSTALLED_APP"
    exit 70
  fi
  log "POST-VERIFY ok: codesign verified"
fi

# (c) a NEW listener that is actually the installed app ------------------
NEW_PID=""
NEW_CMD=""
listener_waited=0
while [ "$listener_waited" -lt "$LISTENER_WAIT" ]; do
  for candidate in $(listeners_on_port); do
    case " $OLD_PIDS " in
      *" $candidate "*) continue ;;
    esac
    candidate_cmd="$(ps -o command= -p "$candidate" 2>/dev/null)"
    case "$candidate_cmd" in
      *"$EXPECT_CMD_SUBSTR"*)
        NEW_PID="$candidate"
        NEW_CMD="$candidate_cmd"
        break
        ;;
    esac
  done
  if [ -n "$NEW_PID" ]; then
    break
  fi
  sleep 1
  listener_waited=$((listener_waited + 1))
done

if [ -z "$NEW_PID" ]; then
  log_err "POST-VERIFY FAIL: no new listener on port $PORT matching \"$EXPECT_CMD_SUBSTR\" after ${LISTENER_WAIT}s"
  exit 70
fi
log "POST-VERIFY ok: new listener pid=$NEW_PID cmd=$NEW_CMD"

# (d) health -------------------------------------------------------------
HEALTH_OK=0
health_waited=0
while [ "$health_waited" -lt "$HEALTH_WAIT" ]; do
  BODY="$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null)"
  CURL_RC=$?
  if [ "$CURL_RC" -eq 0 ]; then
    case "$BODY" in
      *"$HEALTH_MARKER"*)
        HEALTH_OK=1
        break
        ;;
    esac
  fi
  sleep 2
  health_waited=$((health_waited + 2))
done

if [ "$HEALTH_OK" -ne 1 ]; then
  log_err "POST-VERIFY FAIL: $HEALTH_URL did not return a body containing \"$HEALTH_MARKER\" within ${HEALTH_WAIT}s"
  exit 70
fi
log "POST-VERIFY ok: $HEALTH_URL answered with \"$HEALTH_MARKER\""

# ---------------------------------------------------------------------------
# Record
# ---------------------------------------------------------------------------

printf '%s commit=%s build=%s result=ok log=%s\n' \
  "$STAMP" "$HEAD_SHA" "$BUILT_ID" "$LOG" >> "$DEPLOYS_LOG"

if [ "$TASK_GIVEN" = "1" ]; then
  if "$COORD" task show "$TASK" --json >> "$LOG" 2>&1; then
    # Never --tested-commit (F12): deploy evidence is not test evidence.
    if "$COORD" task checkpoint "$TASK" \
        --note "deployed $HEAD_SHA build $BUILT_ID" \
        --evidence "$LOG" >> "$LOG" 2>&1; then
      log "CHECKPOINT recorded on task $TASK"
    else
      log "WARN: could not checkpoint task $TASK"
    fi
  else
    log "WARN: task $TASK is not registered; skipping the checkpoint"
  fi
fi

log "DEPLOY ok commit=$HEAD_SHA build=$BUILT_ID installed=$INSTALLED_APP log=$LOG"
exit 0
