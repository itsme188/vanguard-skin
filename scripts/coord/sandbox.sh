#!/usr/bin/env bash
# sandbox.sh — task-scoped dev-server sandbox (design §5 + §11 F15–F19).
#
# Boots ONE Next dev server per task against a throwaway copy of the database,
# on a non-reserved port, with a secret-free child environment. Two agents can
# therefore run servers at the same time without sharing a DB, a port, a
# Turbopack cache directory or an API key.
#
# Usage:
#   scripts/coord/sandbox.sh up     --task ID [--worktree PATH] [--port N] [--db-source PATH]
#   scripts/coord/sandbox.sh down   --task ID [--purge]
#   scripts/coord/sandbox.sh status
#
#   up      copies the source DB (VACUUM INTO, read-only source), mints a QA
#           session INTO THE COPY, starts the server and waits for /login to
#           answer 200 from a listener that is provably ours. Prints
#           BASE_URL= / SESSION_ENV= / DB= / PID= on success.
#   down    kills the listener + the npm parent, releases the sandbox lock and
#           KEEPS the DB copy, log and manifest as evidence. --purge deletes
#           the sandbox directory afterwards.
#   status  one line per recorded sandbox: task, port, alive.
#
# Exit codes:
#   0   success
#   1   refused / invalid input (bad task id, reserved or busy port, unsafe
#       --db-source, missing session, no free port)
#   2   boot failure (server never became ready; everything started is killed)
#   75  lock contention — another task holds sandbox:<worktree-basename>
#       (the holder is printed on stderr by the coord CLI)
#
# Test seams:
#   PD_COORD_DIR          coordination root. Default <git-common-dir>/portfolio-desk-coord.
#   PD_MAIN_CHECKOUT      root of the live checkout, used only to derive the
#                         default --db-source. Default /Users/Yitzi/code/vanguard-skin.
#   PD_SANDBOX_TEST_MODE  "1" enables the two seams below and shortens the
#                         readiness budget from 120s to 20s.
#   PD_SANDBOX_MINT_CMD   replaces `npx tsx scripts/mint-qa-session.ts` (test mode only).
#   PD_SANDBOX_DEV_CMD    replaces `npm run dev -- -p PORT`, run through `bash -c`
#                         with the same child environment (test mode only).
#   PD_SANDBOX_DUMP       passed through into the child environment (test mode
#                         only) so a fake dev command can dump `env` for assertions.
#
# Never touches the live database: the source is opened read-only and the
# destination may not alias it, be a symlink, or sit under any `data/` directory.
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD="$SCRIPT_DIR/coord.sh"

RESERVED_PORTS="3000 3097 3099"
PORT_RANGE_LO=3090
PORT_RANGE_HI=3096

TEST_MODE="${PD_SANDBOX_TEST_MODE:-}"

# Names present in the child environment. Dotenv keys NOT on this list are
# pinned to an empty string so Next's dotenv loader cannot smuggle a real
# secret past `env -i` (F15).
CHILD_KEYS=" HOME USER TMPDIR PATH DATABASE_PATH APP_EXTRA_HOSTS APP_EXTRA_ORIGINS ANTHROPIC_API_KEY TWS_HOST PD_SANDBOX_TASK PD_SANDBOX_PORT PORT "
if [ "$TEST_MODE" = "1" ]; then
  CHILD_KEYS="${CHILD_KEYS}PD_SANDBOX_DUMP "
fi

err() { printf '%s\n' "$*" >&2; }
die() { local code="$1"; shift; err "$@"; exit "$code"; }

usage() {
  err "Usage: sandbox.sh up --task ID [--worktree PATH] [--port N] [--db-source PATH]"
  err "       sandbox.sh down --task ID [--purge]"
  err "       sandbox.sh status"
}

# Absolute + symlink-resolved, and (unlike BSD realpath) fine with a path that
# does not exist yet.
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

is_reserved_port() {
  local p
  for p in $RESERVED_PORTS; do
    [ "$1" = "$p" ] && return 0
  done
  return 1
}

listener_pid_on() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

port_is_free() {
  [ -z "$(listener_pid_on "$1")" ]
}

# Does $1 reach $2 by walking parent pids? (F18/F19: prove the listener is ours.)
pid_descends_from() {
  local p="$1" want="$2" hops=0
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ] && [ "$hops" -lt 20 ]; do
    [ "$p" = "$want" ] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    hops=$((hops + 1))
  done
  [ -n "$p" ] && [ "$p" = "$want" ] && return 0
  return 1
}

kill_and_wait() { # pid seconds
  local pid="$1" secs="$2" i=0
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null || true
  while [ "$i" -lt "$secs" ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
    i=$((i + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
  return 0
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
  local raw
  if [ -n "${PD_COORD_DIR:-}" ]; then
    raw="$PD_COORD_DIR"
  else
    local common
    common="$(git rev-parse --git-common-dir 2>/dev/null)" || common=""
    [ -n "$common" ] || die 1 "sandbox: not inside a git repo and PD_COORD_DIR is unset"
    raw="$common/portfolio-desk-coord"
  fi
  COORD_DIR="$(abspath "$raw")"
  [ -n "$COORD_DIR" ] || die 1 "sandbox: could not resolve PD_COORD_DIR"
}

LOCK_NAME=""
LOCK_TOKEN=""
LOCK_HELD=0

release_lock() {
  [ "$LOCK_HELD" = "1" ] || return 0
  if [ -n "$LOCK_TOKEN" ]; then
    "$COORD" lock release "$LOCK_NAME" --task "$TASK" --token "$LOCK_TOKEN" >/dev/null 2>&1 || true
  else
    "$COORD" lock release "$LOCK_NAME" --task "$TASK" >/dev/null 2>&1 || true
  fi
  LOCK_HELD=0
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------

cmd_up() {
  local port_arg="" worktree_arg="" db_source_arg=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) TASK="${2:-}"; shift 2 || die 1 "sandbox: --task needs a value" ;;
      --worktree) worktree_arg="${2:-}"; shift 2 || die 1 "sandbox: --worktree needs a value" ;;
      --port) port_arg="${2:-}"; shift 2 || die 1 "sandbox: --port needs a value" ;;
      --db-source) db_source_arg="${2:-}"; shift 2 || die 1 "sandbox: --db-source needs a value" ;;
      *) usage; die 1 "sandbox: unknown argument '$1'" ;;
    esac
  done

  valid_task_id "${TASK:-}" || die 1 "sandbox: refused: invalid --task id (expected ^[A-Za-z0-9._-]{1,64}\$)"
  resolve_coord_dir

  # --- worktree ---
  local wt_raw
  if [ -n "$worktree_arg" ]; then
    wt_raw="$worktree_arg"
  else
    wt_raw="$(git rev-parse --show-toplevel 2>/dev/null)" || wt_raw=""
    [ -n "$wt_raw" ] || die 1 "sandbox: refused: no --worktree given and cwd is not a git worktree"
  fi
  WORKTREE="$(abspath "$wt_raw")"
  [ -d "$WORKTREE" ] || die 1 "sandbox: refused: worktree does not exist: $WORKTREE"
  [ -f "$WORKTREE/package.json" ] || die 1 "sandbox: refused: no package.json in $WORKTREE"

  # --- port ---
  if [ -n "$port_arg" ]; then
    case "$port_arg" in
      ''|*[!0-9]*) die 1 "sandbox: refused: --port must be numeric" ;;
    esac
    if is_reserved_port "$port_arg"; then
      die 1 "sandbox: refused: port $port_arg is reserved (3000 dev / 3097 nightly QA / 3099 app)"
    fi
    port_is_free "$port_arg" || die 1 "sandbox: refused: port $port_arg already has a listener"
    PORT="$port_arg"
  else
    PORT=""
    local p
    p="$PORT_RANGE_LO"
    while [ "$p" -le "$PORT_RANGE_HI" ]; do
      if ! is_reserved_port "$p" && port_is_free "$p"; then
        PORT="$p"
        break
      fi
      p=$((p + 1))
    done
    [ -n "$PORT" ] || die 1 "sandbox: refused: no free port in ${PORT_RANGE_LO}-${PORT_RANGE_HI}"
  fi

  SB="$COORD_DIR/sandboxes/$TASK"

  # Idempotent: a live sandbox for this task is reported, never re-booted (and
  # never re-locked — the lock is re-entrant per task, so a failure after a
  # re-entrant acquire would otherwise release the running sandbox's lock).
  if [ -f "$SB/manifest.json" ]; then
    local live_pid live_port
    live_pid="$(manifest_field "$SB/manifest.json" listener_pid)"
    live_port="$(manifest_field "$SB/manifest.json" port)"
    if [ -n "$live_pid" ] && kill -0 "$live_pid" 2>/dev/null; then
      err "sandbox: task $TASK already has a live sandbox on :$live_port (run 'sandbox.sh down --task $TASK' first)"
      printf 'BASE_URL=%s\n' "$(manifest_field "$SB/manifest.json" base_url)"
      printf 'SESSION_ENV=%s\n' "$(manifest_field "$SB/manifest.json" session_env)"
      printf 'DB=%s\n' "$(manifest_field "$SB/manifest.json" db)"
      printf 'PID=%s\n' "$live_pid"
      return 0
    fi
  fi

  # --- lock BEFORE any process starts (and before any state is written) ---
  LOCK_NAME="sandbox:$(basename "$WORKTREE")"
  local lock_out lock_rc
  lock_out="$("$COORD" lock acquire "$LOCK_NAME" --task "$TASK" --ttl 12h --pid $$)"
  lock_rc=$?
  if [ "$lock_rc" -ne 0 ]; then
    err "sandbox: refused: sandbox lock '$LOCK_NAME' is held by another task"
    exit 75
  fi
  LOCK_HELD=1
  LOCK_TOKEN="$(printf '%s\n' "$lock_out" | sed -n 's/^LOCK_TOKEN=//p' | head -1)"

  mkdir -p "$SB" || { release_lock; die 2 "sandbox: could not create $SB"; }

  # --- DB isolation ---
  local src_default
  src_default="${PD_MAIN_CHECKOUT:-/Users/Yitzi/code/vanguard-skin}/data/vanguard.db"
  local SRC="${db_source_arg:-$src_default}"
  DEST="$SB/vanguard.db"

  python3 - "$SRC" "$DEST" <<'PY'
import os
import sqlite3
import stat
import sys

src_in, dest_in = sys.argv[1], sys.argv[2]


def refuse(msg):
    sys.stderr.write("sandbox: refused: %s\n" % msg)
    sys.exit(1)


src = os.path.realpath(src_in)
if not os.path.exists(src):
    refuse("--db-source does not exist: %s" % src_in)
if not stat.S_ISREG(os.stat(src).st_mode):
    refuse("--db-source is not a regular file: %s" % src)
if not src.endswith(".db"):
    refuse("--db-source must resolve to a .db file: %s" % src)
if "?" in src or "#" in src:
    refuse("--db-source path contains a URI metacharacter: %s" % src)

dest_parent = os.path.realpath(os.path.dirname(dest_in))
dest = os.path.join(dest_parent, os.path.basename(dest_in))
if os.path.islink(dest_in) or os.path.islink(dest):
    refuse("sandbox database destination is a symlink: %s" % dest_in)
if src == dest or src == os.path.realpath(dest):
    refuse("--db-source is the sandbox destination itself: %s" % dest)
for part in os.path.dirname(dest).split(os.sep):
    if part == "data":
        refuse("sandbox database destination sits under a 'data' directory: %s" % dest)

for suffix in ("", "-wal", "-shm"):
    victim = dest + suffix
    if os.path.exists(victim) and not os.path.islink(victim):
        try:
            os.remove(victim)
        except OSError as exc:
            sys.stderr.write("sandbox: could not clear %s: %s\n" % (victim, exc))
            sys.exit(2)

try:
    con = sqlite3.connect("file:" + src + "?mode=ro", uri=True)
    try:
        con.execute("VACUUM INTO ?", (dest,))
    finally:
        con.close()
except sqlite3.Error as exc:
    sys.stderr.write("sandbox: could not copy the database: %s\n" % exc)
    sys.exit(2)

try:
    check = sqlite3.connect(dest)
    try:
        row = check.execute("PRAGMA quick_check").fetchone()
    finally:
        check.close()
except sqlite3.Error as exc:
    sys.stderr.write("sandbox: the database copy does not open: %s\n" % exc)
    sys.exit(2)
if not row or str(row[0]).lower() != "ok":
    sys.stderr.write("sandbox: the database copy failed quick_check: %r\n" % (row,))
    sys.exit(2)
PY
  local db_rc=$?
  if [ "$db_rc" -ne 0 ]; then
    release_lock
    exit "$db_rc"
  fi

  # --- session minted into the COPY ---
  local mint_cmd="npx tsx scripts/mint-qa-session.ts"
  if [ "$TEST_MODE" = "1" ] && [ -n "${PD_SANDBOX_MINT_CMD:-}" ]; then
    mint_cmd="$PD_SANDBOX_MINT_CMD"
  fi
  if ! (cd "$WORKTREE" && PATH=/opt/homebrew/opt/node@24/bin:$PATH $mint_cmd --db "$DEST") > "$SB/session.env" 2>"$SB/mint.log"; then
    err "sandbox: failed to mint a QA session into $DEST"
    sed -n '1,20p' "$SB/mint.log" >&2 2>/dev/null || true
    release_lock
    exit 1
  fi
  if [ ! -s "$SB/session.env" ] \
     || ! grep -q '^VGS_SESSION=' "$SB/session.env" \
     || ! grep -q '^VGS_CSRF=' "$SB/session.env"; then
    err "sandbox: session.env is empty or missing VGS_SESSION/VGS_CSRF"
    release_lock
    exit 1
  fi

  # --- child environment (explicit allowlist + dotenv pins) ---
  local -a child_env
  child_env=(
    "HOME=${HOME:-}"
    "USER=${USER:-}"
    "TMPDIR=${TMPDIR:-/tmp}"
    "PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin"
    "DATABASE_PATH=$DEST"
    "APP_EXTRA_HOSTS=localhost:$PORT,127.0.0.1:$PORT"
    "APP_EXTRA_ORIGINS=http://localhost:$PORT,http://127.0.0.1:$PORT"
    "ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real"
    "TWS_HOST=192.0.2.1"
    "PD_SANDBOX_TASK=$TASK"
    "PD_SANDBOX_PORT=$PORT"
    "PORT=$PORT"
  )
  if [ "$TEST_MODE" = "1" ]; then
    child_env+=("PD_SANDBOX_DUMP=${PD_SANDBOX_DUMP:-}")
  fi

  local pinned=0 files=0 dotenv_file key base
  for dotenv_file in "$WORKTREE"/.env*; do
    [ -f "$dotenv_file" ] || continue
    base="$(basename "$dotenv_file")"
    [ "$base" = ".env.local.example" ] && continue
    files=$((files + 1))
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      case "$CHILD_KEYS" in
        *" $key "*) continue ;;
      esac
      child_env+=("$key=")
      pinned=$((pinned + 1))
    done < <(grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_.-]*' "$dotenv_file" 2>/dev/null \
               | awk '{print $NF}' | sort -u || true)
  done
  printf 'pinned %s dotenv key(s) from %s file(s)\n' "$pinned" "$files"

  # --- start ---
  cd "$WORKTREE" || { release_lock; die 2 "sandbox: could not cd into $WORKTREE"; }
  local NPM_PID
  if [ "$TEST_MODE" = "1" ] && [ -n "${PD_SANDBOX_DEV_CMD:-}" ]; then
    nohup env -i "${child_env[@]}" bash -c "$PD_SANDBOX_DEV_CMD" > "$SB/server.log" 2>&1 &
    NPM_PID=$!
  else
    nohup env -i "${child_env[@]}" npm run dev -- -p "$PORT" > "$SB/server.log" 2>&1 &
    NPM_PID=$!
  fi

  local budget=120
  [ "$TEST_MODE" = "1" ] && budget=20

  local LISTENER_PID="" i=0 code lpid cmdline
  while [ "$i" -lt "$budget" ]; do
    code="$(curl -sf --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      lpid="$(listener_pid_on "$PORT")"
      if [ -n "$lpid" ]; then
        cmdline="$(ps -o command= -p "$lpid" 2>/dev/null || true)"
        if pid_descends_from "$lpid" "$NPM_PID" || printf '%s' "$cmdline" | grep -qF "$WORKTREE"; then
          LISTENER_PID="$lpid"
          break
        fi
        err "sandbox: a listener on :$PORT is NOT ours (pid $lpid) — refusing to adopt it"
        break
      fi
    fi
    sleep 1
    i=$((i + 1))
  done

  if [ -z "$LISTENER_PID" ]; then
    err "sandbox: server did not become ready on :$PORT within ${budget}s"
    lpid="$(listener_pid_on "$PORT")"
    if [ -n "$lpid" ] && pid_descends_from "$lpid" "$NPM_PID"; then
      kill_and_wait "$lpid" 10
    fi
    kill_and_wait "$NPM_PID" 10
    release_lock
    err "--- last 20 lines of $SB/server.log ---"
    tail -20 "$SB/server.log" >&2 2>/dev/null || true
    exit 2
  fi

  BASE_URL="http://localhost:$PORT"
  python3 - "$SB/manifest.json" "$TASK" "$WORKTREE" "$PORT" "$BASE_URL" "$DEST" \
    "$SB/session.env" "$SB/server.log" "$NPM_PID" "$LISTENER_PID" "$LOCK_NAME" <<'PY'
import datetime
import json
import os
import sys

(path, task, worktree, port, base_url, db, session_env, server_log,
 npm_pid, listener_pid, lock) = sys.argv[1:12]

data = {
    "task": task,
    "worktree": worktree,
    "port": int(port),
    "base_url": base_url,
    "db": db,
    "session_env": session_env,
    "server_log": server_log,
    "npm_pid": int(npm_pid),
    "listener_pid": int(listener_pid),
    "lock": lock,
    "started_at": datetime.datetime.now(datetime.timezone.utc)
    .replace(microsecond=0)
    .isoformat()
    .replace("+00:00", "Z"),
}
tmp = path + ".tmp"
with open(tmp, "w") as handle:
    json.dump(data, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.replace(tmp, path)
PY
  local mf_rc=$?
  if [ "$mf_rc" -ne 0 ]; then
    err "sandbox: could not write $SB/manifest.json"
    kill_and_wait "$LISTENER_PID" 10
    kill_and_wait "$NPM_PID" 10
    release_lock
    exit 2
  fi

  # Best effort: record the chosen port on the task when one is registered.
  if "$COORD" task show "$TASK" --json >/dev/null 2>&1; then
    "$COORD" task register --id "$TASK" --update --port "$PORT" >/dev/null 2>&1 || true
  fi

  printf 'BASE_URL=%s\n' "$BASE_URL"
  printf 'SESSION_ENV=%s\n' "$SB/session.env"
  printf 'DB=%s\n' "$DEST"
  printf 'PID=%s\n' "$LISTENER_PID"
  return 0
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------

cmd_down() {
  local purge=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) TASK="${2:-}"; shift 2 || die 1 "sandbox: --task needs a value" ;;
      --purge) purge=1; shift ;;
      *) usage; die 1 "sandbox: unknown argument '$1'" ;;
    esac
  done

  valid_task_id "${TASK:-}" || die 1 "sandbox: refused: invalid --task id"
  resolve_coord_dir

  local sb="$COORD_DIR/sandboxes/$TASK"
  local manifest="$sb/manifest.json"
  if [ ! -f "$manifest" ]; then
    printf 'sandbox: no manifest for task %s (nothing to stop)\n' "$TASK"
    if [ "$purge" = "1" ] && [ -d "$sb" ]; then
      purge_dir "$sb"
    fi
    return 0
  fi

  local worktree lock listener npm_pid pid cmdline
  worktree="$(manifest_field "$manifest" worktree)"
  lock="$(manifest_field "$manifest" lock)"
  listener="$(manifest_field "$manifest" listener_pid)"
  npm_pid="$(manifest_field "$manifest" npm_pid)"

  for pid in "$listener" "$npm_pid"; do
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    cmdline="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    if { [ -n "$worktree" ] && printf '%s' "$cmdline" | grep -qF "$worktree"; } \
       || printf '%s' "$cmdline" | grep -q 'next' \
       || printf '%s' "$cmdline" | grep -q 'http\.server'; then
      kill_and_wait "$pid" 15
    else
      err "sandbox: pid $pid does not look like this sandbox's server — left alone"
    fi
  done

  if [ -n "$lock" ]; then
    "$COORD" lock release "$lock" --task "$TASK" >/dev/null 2>&1 || true
  fi

  if [ "$purge" = "1" ]; then
    purge_dir "$sb"
  else
    printf 'sandbox: task %s stopped (evidence kept in %s)\n' "$TASK" "$sb"
  fi
  return 0
}

purge_dir() { # only ever under $COORD_DIR/sandboxes/
  local target real root
  target="$1"
  real="$(abspath "$target")"
  root="$(abspath "$COORD_DIR/sandboxes")"
  case "$real" in
    "$root"/?*) ;;
    *) die 1 "sandbox: refused: $real is not under $root" ;;
  esac
  rm -rf "$real"
  printf 'sandbox: purged %s\n' "$real"
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

cmd_status() {
  [ $# -eq 0 ] || { usage; die 1 "sandbox: status takes no arguments"; }
  resolve_coord_dir
  local root="$COORD_DIR/sandboxes"
  if [ ! -d "$root" ]; then
    printf 'no sandboxes\n'
    return 0
  fi
  local found=0 manifest task port listener alive
  for manifest in "$root"/*/manifest.json; do
    [ -f "$manifest" ] || continue
    found=1
    task="$(manifest_field "$manifest" task)"
    port="$(manifest_field "$manifest" port)"
    listener="$(manifest_field "$manifest" listener_pid)"
    alive="no"
    if [ -n "$listener" ] && kill -0 "$listener" 2>/dev/null; then alive="yes"; fi
    printf 'task=%s port=%s alive=%s\n' "$task" "$port" "$alive"
  done
  [ "$found" = "1" ] || printf 'no sandboxes\n'
  return 0
}

# ---------------------------------------------------------------------------

command -v python3 >/dev/null 2>&1 || die 1 "sandbox: python3 is required"

ACTION="${1:-}"
[ $# -gt 0 ] && shift
case "$ACTION" in
  up) cmd_up "$@" ;;
  down) cmd_down "$@" ;;
  status) cmd_status "$@" ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage; exit 1 ;;
esac
