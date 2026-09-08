#!/usr/bin/env python3
"""Portfolio Desk agent-coordination CLI.

Task register + named locks shared by every worktree of this repo, so
concurrent Claude/Codex agents can see "who owns what right now, on which
port, at which commit" and serialize the resources that cannot be shared
(landing, deploying, the browser, a per-worktree dev server).

Spec: docs/superpowers/specs/2026-09-08-agent-coordination-design.md
(sections 1-3, 9 define this tool's contract; T1 in section 10). This file
also incorporates a binding design-review addendum (2026-09-08) covering:
absolute coord-dir resolution + 0700 perms, per-acquisition lock tokens,
parent-pid + start-time liveness checks, "initializing" (incomplete) lock
handling, --force-live release, SIGINT/SIGTERM forwarding + token-checked
release in `lock run`, and race-safe stale-lock breaking.

Python 3.9 stdlib only -- the system interpreter is /usr/bin/python3 3.9.6.
No `match` statement, no `X | Y` runtime type unions, no bare
`list[str]`/`dict[str, Any]` annotations without `from __future__ import
annotations` (present below, which makes all annotations lazy strings so the
3.10+ syntax the typing module also accepts here is never evaluated).

Exit codes: 0 ok; 1 usage/refused; 2 environment error (e.g. no git);
75 lock contention.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

EXIT_OK = 0
EXIT_REFUSED = 1
EXIT_ENV_ERROR = 2
EXIT_LOCK_CONTENTION = 75

TASK_STATUSES = ["planned", "active", "blocked", "review", "landed", "abandoned"]
TASK_TERMINAL_STATUSES = ("landed", "abandoned")
TASK_LIVE_STATUSES = ("active", "blocked")

TASK_FIELDS = [
    "id",
    "owner",
    "branch",
    "worktree",
    "owned_paths",
    "port",
    "browser_session",
    "status",
    "last_checkpoint",
    "tested_commit",
    "evidence",
    "next_action",
    "handoff",
    "pid",
    "created_at",
    "updated_at",
    "heartbeat_at",
]

DEFAULT_LOCK_TTL_SECONDS = 90 * 60
DEFAULT_STALE_AFTER_SECONDS = 6 * 3600
INCOMPLETE_LOCK_GRACE_SECONDS = 60.0
COORD_DIR_MODE = 0o700


# ---------------------------------------------------------------------------
# Coord dir resolution + layout
# ---------------------------------------------------------------------------


def resolve_coord_dir() -> str:
    """Resolves PD_COORD_DIR (or the git-common-dir fallback) to an absolute,
    symlink-resolved path exactly once, before anything else touches the
    filesystem. Every other function in this module receives this resolved
    string and never re-resolves it."""
    env_value = os.environ.get("PD_COORD_DIR")
    if env_value:
        return os.path.realpath(env_value)

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=os.getcwd(),
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        sys.stderr.write("coord: git executable not found; set PD_COORD_DIR to override\n")
        sys.exit(EXIT_ENV_ERROR)
    if result.returncode != 0:
        detail = (result.stderr or "").strip() or "not a git repository"
        sys.stderr.write(
            "coord: could not resolve git common dir (%s); "
            "run from inside the repo or set PD_COORD_DIR to override\n" % detail
        )
        sys.exit(EXIT_ENV_ERROR)
    common_dir = (result.stdout or "").strip()
    if not common_dir:
        sys.stderr.write(
            "coord: 'git rev-parse --git-common-dir' returned nothing; set PD_COORD_DIR to override\n"
        )
        sys.exit(EXIT_ENV_ERROR)
    return os.path.realpath(os.path.join(os.path.realpath(common_dir), "portfolio-desk-coord"))


def tasks_dir(coord_dir: str) -> str:
    return os.path.join(coord_dir, "tasks")


def archive_dir(coord_dir: str) -> str:
    return os.path.join(coord_dir, "tasks", "archive")


def locks_dir(coord_dir: str) -> str:
    return os.path.join(coord_dir, "locks")


def logs_dir(coord_dir: str) -> str:
    return os.path.join(coord_dir, "logs")


def ensure_dirs(coord_dir: str) -> None:
    os.makedirs(coord_dir, exist_ok=True)
    try:
        os.chmod(coord_dir, COORD_DIR_MODE)
    except OSError:
        pass
    for path in (tasks_dir(coord_dir), archive_dir(coord_dir), locks_dir(coord_dir), logs_dir(coord_dir)):
        os.makedirs(path, exist_ok=True)


# ---------------------------------------------------------------------------
# Time + process helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    text = value
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


_DURATION_RE = re.compile(r"^(\d+(?:\.\d+)?)([smhd])$")


def parse_duration(value: str) -> float:
    match = _DURATION_RE.match(value.strip())
    if not match:
        raise ValueError(
            "invalid duration '%s' (expected a number followed by s/m/h/d, e.g. 90m, 6h, 30s, 2d)" % value
        )
    amount = float(match.group(1))
    unit = match.group(2)
    multiplier = {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    return amount * multiplier


def get_pid_start(pid: Optional[int]) -> str:
    """The process start time as `ps` reports it, used to detect PID reuse.
    Empty string when the pid is unknown or `ps` cannot find it."""
    if pid is None:
        return ""
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return ""
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


def pid_alive(pid: Optional[int], pid_start: Optional[str] = None) -> Optional[bool]:
    """None = unknown (no pid recorded). True = alive (or unverifiable --
    PermissionError still means a process exists). False = confirmed gone,
    either because the pid does not exist or because its start time no
    longer matches the recorded one (PID reuse)."""
    if pid is None:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    except OSError:
        return False

    if pid_start:
        current = get_pid_start(pid)
        if current and current != pid_start:
            return False
    return True


# ---------------------------------------------------------------------------
# Atomic writes + history log
# ---------------------------------------------------------------------------


def atomic_write_json(path: str, data: Dict[str, Any]) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp_path = "%s.tmp-%d" % (path, os.getpid())
    try:
        with open(tmp_path, "w") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def append_history(coord_dir: str, command: str, subject: str, detail: str) -> None:
    ensure_dirs(coord_dir)
    line = "%s %s %s %s\n" % (now_iso(), command, subject, detail)
    with open(os.path.join(coord_dir, "history.log"), "a") as handle:
        handle.write(line)


# ---------------------------------------------------------------------------
# Task record helpers
# ---------------------------------------------------------------------------


def task_path(coord_dir: str, task_id: str) -> str:
    return os.path.join(tasks_dir(coord_dir), "%s.json" % task_id)


def archived_task_path(coord_dir: str, task_id: str) -> str:
    return os.path.join(archive_dir(coord_dir), "%s.json" % task_id)


def is_archived(coord_dir: str, task_id: str) -> bool:
    return os.path.isfile(archived_task_path(coord_dir, task_id))


def load_task(coord_dir: str, task_id: str) -> Optional[Dict[str, Any]]:
    path = task_path(coord_dir, task_id)
    if not os.path.isfile(path):
        return None
    with open(path, "r") as handle:
        return json.load(handle)


def save_task(coord_dir: str, record: Dict[str, Any]) -> None:
    atomic_write_json(task_path(coord_dir, record["id"]), record)


def parse_csv_list(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def report_task_missing(args: argparse.Namespace, coord_dir: str) -> int:
    if is_archived(coord_dir, args.id):
        sys.stderr.write("coord: task '%s' is archived\n" % args.id)
    else:
        sys.stderr.write("coord: task '%s' not found\n" % args.id)
    return EXIT_REFUSED


def compute_flags(record: Dict[str, Any], stale_after_seconds: float) -> List[str]:
    flags: List[str] = []

    status = record.get("status")
    if status in TASK_LIVE_STATUSES:
        heartbeat = record.get("heartbeat_at") or record.get("updated_at")
        if heartbeat:
            try:
                age = (datetime.now(timezone.utc) - parse_iso(heartbeat)).total_seconds()
                if age > stale_after_seconds:
                    flags.append("STALE")
            except ValueError:
                pass

    worktree = record.get("worktree")
    if worktree and not os.path.isdir(worktree):
        flags.append("WORKTREE-MISSING")

    pid = record.get("pid")
    if pid is not None and pid_alive(pid) is False:
        flags.append("OWNER-GONE")

    return flags


def print_task(record: Dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(record, indent=2, sort_keys=True))
        return
    print("task %s" % record.get("id"))
    for key in TASK_FIELDS:
        if key == "id":
            continue
        value = record.get(key)
        if key == "last_checkpoint" and value:
            value = "%s (%s)" % (value.get("note"), value.get("at"))
        print("  %-16s %s" % (key, value))


def format_table(headers: List[str], rows: List[List[Any]]) -> str:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))

    def fmt(cells: List[Any]) -> str:
        return "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(cells))

    lines = [fmt(headers)]
    for row in rows:
        lines.append(fmt(row))
    return "\n".join(lines)


def print_task_table(rows: List[Tuple[Dict[str, Any], List[str]]]) -> None:
    headers = ["ID", "OWNER", "STATUS", "BRANCH", "PORT", "LAST-CHECKPOINT", "NEXT", "FLAGS"]
    table_rows = []
    for record, flags in rows:
        checkpoint = record.get("last_checkpoint")
        checkpoint_str = checkpoint.get("note") if checkpoint else "-"
        port = record.get("port")
        table_rows.append(
            [
                record.get("id", "-"),
                record.get("owner", "-"),
                record.get("status", "-"),
                record.get("branch", "-"),
                port if port is not None else "-",
                checkpoint_str or "-",
                record.get("next_action") or "-",
                ",".join(flags) if flags else "-",
            ]
        )
    print(format_table(headers, table_rows))


# ---------------------------------------------------------------------------
# task subcommands
# ---------------------------------------------------------------------------


def cmd_task_register(coord_dir: str, args: argparse.Namespace) -> int:
    ensure_dirs(coord_dir)
    existing = load_task(coord_dir, args.id)
    ts = now_iso()

    if existing is not None and not args.update:
        sys.stderr.write("coord: task '%s' already exists (pass --update to modify it)\n" % args.id)
        return EXIT_REFUSED

    owned_paths = parse_csv_list(args.paths) if args.paths is not None else None

    if existing is None:
        missing = [
            name
            for name, value in (("owner", args.owner), ("branch", args.branch), ("worktree", args.worktree))
            if not value
        ]
        if missing:
            sys.stderr.write("coord: --%s is required to register a new task\n" % missing[0])
            return EXIT_REFUSED
        record = {
            "id": args.id,
            "owner": args.owner,
            "branch": args.branch,
            "worktree": args.worktree,
            "owned_paths": owned_paths if owned_paths is not None else [],
            "port": args.port,
            "browser_session": args.browser_session,
            "status": args.status or "active",
            "last_checkpoint": None,
            "tested_commit": None,
            "evidence": None,
            "next_action": None,
            "handoff": args.handoff,
            "pid": args.pid,
            "created_at": ts,
            "updated_at": ts,
            "heartbeat_at": ts,
        }
        save_task(coord_dir, record)
        append_history(
            coord_dir,
            "task register",
            args.id,
            "owner=%s branch=%s worktree=%s" % (record["owner"], record["branch"], record["worktree"]),
        )
    else:
        record = existing
        if args.owner is not None:
            record["owner"] = args.owner
        if args.branch is not None:
            record["branch"] = args.branch
        if args.worktree is not None:
            record["worktree"] = args.worktree
        if owned_paths is not None:
            record["owned_paths"] = owned_paths
        if args.port is not None:
            record["port"] = args.port
        if args.browser_session is not None:
            record["browser_session"] = args.browser_session
        if args.handoff is not None:
            record["handoff"] = args.handoff
        if args.pid is not None:
            record["pid"] = args.pid
        if args.status is not None:
            record["status"] = args.status
        record["updated_at"] = ts
        save_task(coord_dir, record)
        append_history(coord_dir, "task register --update", args.id, "merged given fields")

    print_task(record, args.json)
    return EXIT_OK


def cmd_task_checkpoint(coord_dir: str, args: argparse.Namespace) -> int:
    record = load_task(coord_dir, args.id)
    if record is None:
        return report_task_missing(args, coord_dir)
    ts = now_iso()
    record["last_checkpoint"] = {"at": ts, "note": args.note}
    if args.tested_commit is not None:
        record["tested_commit"] = args.tested_commit
    if args.evidence is not None:
        record["evidence"] = args.evidence
    if args.next is not None:
        record["next_action"] = args.next
    if args.status is not None:
        record["status"] = args.status
    record["updated_at"] = ts
    record["heartbeat_at"] = ts
    save_task(coord_dir, record)
    append_history(coord_dir, "task checkpoint", args.id, args.note)
    print_task(record, args.json)
    return EXIT_OK


def cmd_task_heartbeat(coord_dir: str, args: argparse.Namespace) -> int:
    record = load_task(coord_dir, args.id)
    if record is None:
        return report_task_missing(args, coord_dir)
    ts = now_iso()
    record["heartbeat_at"] = ts
    record["updated_at"] = ts
    save_task(coord_dir, record)
    append_history(coord_dir, "task heartbeat", args.id, "-")
    print_task(record, args.json)
    return EXIT_OK


def cmd_task_show(coord_dir: str, args: argparse.Namespace) -> int:
    record = load_task(coord_dir, args.id)
    if record is None:
        sys.stderr.write("coord: task '%s' not found\n" % args.id)
        return EXIT_REFUSED
    print_task(record, args.json)
    return EXIT_OK


def cmd_task_list(coord_dir: str, args: argparse.Namespace) -> int:
    ensure_dirs(coord_dir)
    stale_after = (
        parse_duration(args.stale_after) if getattr(args, "stale_after", None) else DEFAULT_STALE_AFTER_SECONDS
    )

    records: List[Dict[str, Any]] = []
    directory = tasks_dir(coord_dir)
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        with open(path, "r") as handle:
            try:
                records.append(json.load(handle))
            except json.JSONDecodeError:
                continue

    if not getattr(args, "all", False):
        records = [r for r in records if r.get("status") not in TASK_TERMINAL_STATUSES]

    rows = [(record, compute_flags(record, stale_after)) for record in records]

    if args.json:
        out = []
        for record, flags in rows:
            item = dict(record)
            item["flags"] = flags
            out.append(item)
        print(json.dumps(out, indent=2, sort_keys=True))
    else:
        print_task_table(rows)
    return EXIT_OK


def cmd_task_release(coord_dir: str, args: argparse.Namespace) -> int:
    record = load_task(coord_dir, args.id)
    if record is None:
        sys.stderr.write("coord: task '%s' not found\n" % args.id)
        return EXIT_REFUSED
    prior_owner = record.get("owner")
    ts = now_iso()
    record["status"] = "abandoned"
    record["updated_at"] = ts
    record["heartbeat_at"] = ts
    save_task(coord_dir, record)
    append_history(
        coord_dir,
        "task release",
        args.id,
        "prior_owner=%s released_by=%s reason=%s" % (prior_owner, args.by, args.reason),
    )
    print_task(record, args.json)
    return EXIT_OK


def cmd_task_archive(coord_dir: str, args: argparse.Namespace) -> int:
    record = load_task(coord_dir, args.id)
    if record is None:
        sys.stderr.write("coord: task '%s' not found\n" % args.id)
        return EXIT_REFUSED
    status = record.get("status")
    if status in TASK_LIVE_STATUSES:
        sys.stderr.write(
            "coord: refusing to archive task '%s' while status is '%s' (release it first)\n" % (args.id, status)
        )
        return EXIT_REFUSED
    ensure_dirs(coord_dir)
    os.replace(task_path(coord_dir, args.id), archived_task_path(coord_dir, args.id))
    append_history(coord_dir, "task archive", args.id, "status=%s" % status)
    if args.json:
        print(json.dumps(record, indent=2, sort_keys=True))
    else:
        print("archived task %s" % args.id)
    return EXIT_OK


# ---------------------------------------------------------------------------
# lock helpers
# ---------------------------------------------------------------------------


def lock_dir_path(coord_dir: str, name: str) -> str:
    return os.path.join(locks_dir(coord_dir), name)


def lock_owner_path(coord_dir: str, name: str) -> str:
    return os.path.join(lock_dir_path(coord_dir, name), "owner.json")


def read_lock_owner(coord_dir: str, name: str) -> Optional[Dict[str, Any]]:
    path = lock_owner_path(coord_dir, name)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def lock_dir_age_seconds(coord_dir: str, name: str) -> Optional[float]:
    try:
        mtime = os.stat(lock_dir_path(coord_dir, name)).st_mtime
    except OSError:
        return None
    return time.time() - mtime


def is_lock_stale(owner: Dict[str, Any]) -> bool:
    acquired_at = owner.get("acquired_at")
    ttl = owner.get("ttl_seconds")
    if not acquired_at or ttl is None:
        return False
    try:
        age = (datetime.now(timezone.utc) - parse_iso(acquired_at)).total_seconds()
    except ValueError:
        return False
    if age <= ttl:
        return False
    pid = owner.get("pid")
    if pid is None:
        return True
    return pid_alive(pid, owner.get("pid_start")) is False


def evaluate_lock(coord_dir: str, name: str) -> Dict[str, Any]:
    """Full state of lock `name`:
      exists   -- lock dir present
      owner    -- parsed owner.json, or None if missing/unparsable
      incomplete -- dir exists but owner.json missing/unparsable ("initializing")
      age_seconds -- dir mtime age (only meaningful when incomplete)
      stale    -- true if breakable with --break-stale right now
    """
    ldir = lock_dir_path(coord_dir, name)
    if not os.path.isdir(ldir):
        return {"exists": False, "owner": None, "incomplete": False, "age_seconds": None, "stale": False}
    owner = read_lock_owner(coord_dir, name)
    if owner is None:
        age = lock_dir_age_seconds(coord_dir, name)
        stale = age is not None and age > INCOMPLETE_LOCK_GRACE_SECONDS
        return {"exists": True, "owner": None, "incomplete": True, "age_seconds": age, "stale": stale}
    return {"exists": True, "owner": owner, "incomplete": False, "age_seconds": None, "stale": is_lock_stale(owner)}


def try_mkdir_lock(coord_dir: str, name: str, owner_record: Dict[str, Any]) -> bool:
    ensure_dirs(coord_dir)
    try:
        os.mkdir(lock_dir_path(coord_dir, name))
    except FileExistsError:
        return False
    try:
        atomic_write_json(lock_owner_path(coord_dir, name), owner_record)
    except OSError:
        # The freshly created lock dir vanished underneath us (someone
        # force-released an "initializing" lock in the window between mkdir
        # and the owner.json write). We do NOT hold the lock; report that.
        return False
    return True


def safe_break_lock(coord_dir: str, name: str, expected_owner: Optional[Dict[str, Any]]) -> bool:
    """Removes the lock dir for `name` ONLY if it still matches what was
    evaluated as stale a moment ago (compares acquired_at + token, or -- for
    an "incomplete" lock -- requires owner.json to still be absent), so a
    lock someone else freshly (re)acquired in a race is never destroyed.
    Returns True if the lock dir is gone (removed here, or already gone),
    False if a fresh, non-matching lock now occupies it."""
    ldir = lock_dir_path(coord_dir, name)
    current = read_lock_owner(coord_dir, name)

    if expected_owner is None:
        if current is not None:
            return False
    else:
        if current is None:
            return False
        if (
            current.get("acquired_at") != expected_owner.get("acquired_at")
            or current.get("token") != expected_owner.get("token")
        ):
            return False

    try:
        shutil.rmtree(ldir)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


def print_lock_record(owner_record: Dict[str, Any], as_json: bool, verb: str) -> None:
    if as_json:
        print(json.dumps(owner_record, indent=2, sort_keys=True))
        return
    print(
        "%s lock %s (task=%s owner=%s ttl=%ss)"
        % (verb, owner_record.get("name"), owner_record.get("task"), owner_record.get("owner"), owner_record.get("ttl_seconds"))
    )
    token = owner_record.get("token")
    if token:
        print("LOCK_TOKEN=%s" % token)


def report_lock_contention(args: argparse.Namespace, existing: Optional[Dict[str, Any]]) -> int:
    as_json = getattr(args, "json", False)
    if existing is None:
        task_s, owner_s, pid_s, since_s = "?", "?", "?", "?"
        payload: Dict[str, Any] = {"error": "lock_held", "name": args.name, "holder": None}
    else:
        task_s = existing.get("task")
        owner_s = existing.get("owner")
        pid_s = existing.get("pid")
        since_s = existing.get("acquired_at")
        payload = {"error": "lock_held", "name": args.name, "holder": existing}
    sys.stderr.write(
        "lock %s held by task=%s owner=%s pid=%s since %s\n" % (args.name, task_s, owner_s, pid_s, since_s)
    )
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    return EXIT_LOCK_CONTENTION


def acquire_lock_internal(
    coord_dir: str,
    name: str,
    task: str,
    owner: Optional[str],
    ttl: Optional[str],
    note: Optional[str],
    wait: Optional[float],
    break_stale: bool,
    pid: Optional[int],
    exclusive: bool = False,
) -> Tuple[int, Optional[Dict[str, Any]]]:
    """Returns (exit_code, record). exit_code == EXIT_OK: record is the
    owner_record we now hold (freshly written, or already held by this same
    task -- untouched). exit_code == EXIT_LOCK_CONTENTION: record is the
    current holder's owner.json (or None when unreadable/incomplete)."""
    ensure_dirs(coord_dir)
    ttl_seconds = parse_duration(ttl) if ttl else DEFAULT_LOCK_TTL_SECONDS
    resolved_pid = pid if pid is not None else os.getppid()
    pid_start = get_pid_start(resolved_pid)
    host = socket.gethostname()
    start_time = time.time()
    broke_stale_once = False

    while True:
        owner_record = {
            "name": name,
            "owner": owner or "-",
            "task": task,
            "pid": resolved_pid,
            "pid_start": pid_start,
            "host": host,
            "acquired_at": now_iso(),
            "ttl_seconds": ttl_seconds,
            "note": note,
            "token": secrets.token_hex(8),
        }
        if try_mkdir_lock(coord_dir, name, owner_record):
            append_history(
                coord_dir, "lock acquire", name, "task=%s owner=%s pid=%s" % (task, owner_record["owner"], resolved_pid)
            )
            return EXIT_OK, owner_record

        state = evaluate_lock(coord_dir, name)
        existing = state["owner"]

        if existing is not None and existing.get("task") == task and not exclusive:
            # Same task re-acquiring: idempotent. --exclusive disables this so
            # two concurrent RUNS of one task (e.g. two smoke processes) still
            # serialize instead of sharing -- and stealing -- one token.
            return EXIT_OK, existing

        if (not broke_stale_once) and break_stale and state["stale"]:
            broke_stale_once = True
            expected = None if state["incomplete"] else existing
            if state["incomplete"]:
                detail = "broke lock with missing/malformed owner.json (dir age=%.1fs)" % (state["age_seconds"] or 0.0)
            else:
                detail = (
                    "broke stale lock task=%s owner=%s pid=%s acquired_at=%s ttl_seconds=%s token=%s"
                    % (
                        existing.get("task"),
                        existing.get("owner"),
                        existing.get("pid"),
                        existing.get("acquired_at"),
                        existing.get("ttl_seconds"),
                        existing.get("token"),
                    )
                )
            if safe_break_lock(coord_dir, name, expected):
                append_history(coord_dir, "lock break-stale", name, detail)
            continue

        if wait:
            if time.time() - start_time >= wait:
                return EXIT_LOCK_CONTENTION, existing
            time.sleep(0.5)
            continue

        return EXIT_LOCK_CONTENTION, existing


def cmd_lock_acquire(coord_dir: str, args: argparse.Namespace) -> int:
    rc, record = acquire_lock_internal(
        coord_dir,
        name=args.name,
        task=args.task,
        owner=args.owner,
        ttl=args.ttl,
        note=args.note,
        wait=args.wait,
        break_stale=getattr(args, "break_stale", False),
        pid=args.pid,
        exclusive=getattr(args, "exclusive", False),
    )
    if rc == EXIT_OK:
        print_lock_record(record, args.json, "acquired")
        return EXIT_OK
    return report_lock_contention(args, record)


def cmd_lock_release(coord_dir: str, args: argparse.Namespace) -> int:
    ldir = lock_dir_path(coord_dir, args.name)
    if not os.path.isdir(ldir):
        print("coord: lock '%s' is not held; nothing to release" % args.name)
        return EXIT_OK

    existing = read_lock_owner(coord_dir, args.name)
    force = getattr(args, "force", False)
    force_live = getattr(args, "force_live", False)
    token = getattr(args, "token", None)

    if token is not None:
        if existing is None or existing.get("token") != token:
            sys.stderr.write("coord: refusing to release lock '%s': token mismatch\n" % args.name)
            return EXIT_REFUSED

    task_matches = existing is not None and existing.get("task") == args.task

    if existing is None and not (force or force_live):
        # "Initializing" (mkdir done, owner.json not yet written) or malformed
        # owner.json: nobody can prove ownership, so an ordinary release must
        # not delete it -- that would steal the lock from the acquirer that is
        # about to publish its record. Operators break it explicitly.
        sys.stderr.write(
            "coord: refusing to release lock '%s': owner.json missing/malformed (initializing?); "
            "pass --force --reason to break it\n" % args.name
        )
        return EXIT_REFUSED
    if existing is None and not getattr(args, "reason", None):
        sys.stderr.write("coord: --force/--force-live requires --reason\n")
        return EXIT_REFUSED

    if existing is not None and not task_matches:
        if not (force or force_live):
            sys.stderr.write(
                "coord: refusing to release lock '%s' held by task=%s "
                "(pass --force --reason to override)\n" % (args.name, existing.get("task"))
            )
            return EXIT_REFUSED
        if not getattr(args, "reason", None):
            sys.stderr.write("coord: --force/--force-live requires --reason\n")
            return EXIT_REFUSED
        alive = pid_alive(existing.get("pid"), existing.get("pid_start"))
        if alive and not force_live:
            sys.stderr.write(
                "coord: refusing --force release of lock '%s': holder pid %s is alive; "
                "stop it first or pass --force-live\n" % (args.name, existing.get("pid"))
            )
            return EXIT_REFUSED

    detail = "task=%s" % args.task
    if existing is not None and not task_matches:
        detail += " forced%s reason=%s prior_task=%s prior_owner=%s prior_pid=%s" % (
            "-live" if force_live else "",
            args.reason,
            existing.get("task"),
            existing.get("owner"),
            existing.get("pid"),
        )

    try:
        shutil.rmtree(ldir)
    except OSError as exc:
        sys.stderr.write("coord: failed to release lock '%s': %s\n" % (args.name, exc))
        return EXIT_REFUSED

    append_history(coord_dir, "lock release", args.name, detail)
    print("released lock %s" % args.name)
    return EXIT_OK


def cmd_lock_status(coord_dir: str, args: argparse.Namespace) -> int:
    ensure_dirs(coord_dir)
    root = locks_dir(coord_dir)
    requested = getattr(args, "name", None)
    if requested:
        names = [requested] if os.path.isdir(lock_dir_path(coord_dir, requested)) else []
    else:
        names = sorted(n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))) if os.path.isdir(root) else []

    rows = []
    for name in names:
        state = evaluate_lock(coord_dir, name)
        if not state["exists"]:
            continue
        owner = state["owner"]
        alive = pid_alive(owner.get("pid"), owner.get("pid_start")) if owner else None
        rows.append((name, owner, alive, state["stale"]))

    if args.json:
        out = []
        for name, owner, alive, stale in rows:
            item = dict(owner) if owner else {"name": name, "task": None}
            item["alive"] = alive
            item["stale"] = stale
            out.append(item)
        print(json.dumps(out, indent=2, sort_keys=True))
    else:
        headers = ["NAME", "TASK", "OWNER", "PID", "ALIVE", "ACQUIRED", "TTL", "STALE"]
        table_rows = []
        for name, owner, alive, stale in rows:
            if owner is None:
                table_rows.append([name, "?", "?", "-", "-", "-", "-", "yes" if stale else "no"])
            else:
                table_rows.append(
                    [
                        name,
                        owner.get("task", "-"),
                        owner.get("owner", "-"),
                        owner.get("pid", "-"),
                        "yes" if alive else ("no" if alive is False else "-"),
                        owner.get("acquired_at", "-"),
                        owner.get("ttl_seconds", "-"),
                        "yes" if stale else "no",
                    ]
                )
        print(format_table(headers, table_rows))
    return EXIT_OK


def cmd_lock_run(coord_dir: str, args: argparse.Namespace) -> int:
    cmd = getattr(args, "cmd", None) or []
    if not cmd:
        sys.stderr.write("coord: 'lock run' requires a command after '--'\n")
        return EXIT_REFUSED

    run_pid = args.pid if args.pid is not None else os.getpid()

    rc, record = acquire_lock_internal(
        coord_dir,
        name=args.name,
        task=args.task,
        owner=args.owner,
        ttl=args.ttl,
        note=args.note,
        wait=args.wait,
        break_stale=getattr(args, "break_stale", False),
        pid=run_pid,
        exclusive=getattr(args, "exclusive", False),
    )
    if rc != EXIT_OK:
        return report_lock_contention(args, record)

    our_token = record.get("token") if record else None

    signal_state: Dict[str, Optional[int]] = {"signum": None}
    proc = subprocess.Popen(cmd)

    def forward_signal(signum: int, _frame: Any) -> None:
        signal_state["signum"] = signum
        if proc.poll() is None:
            try:
                proc.send_signal(signum)
            except ProcessLookupError:
                pass

    old_handlers = {
        signal.SIGINT: signal.signal(signal.SIGINT, forward_signal),
        signal.SIGTERM: signal.signal(signal.SIGTERM, forward_signal),
    }

    try:
        returncode = None
        while returncode is None:
            try:
                returncode = proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                if signal_state["signum"] is not None:
                    deadline = time.time() + 10
                    while proc.poll() is None and time.time() < deadline:
                        time.sleep(0.1)
                    if proc.poll() is None:
                        proc.kill()
                    returncode = proc.wait()

        if signal_state["signum"] is not None:
            return 128 + signal_state["signum"]
        if returncode < 0:
            return 128 + (-returncode)
        return returncode
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        current = read_lock_owner(coord_dir, args.name)
        if current is not None and our_token is not None and current.get("token") == our_token:
            release_ns = argparse.Namespace(
                name=args.name, task=args.task, force=False, force_live=False, reason=None, token=None
            )
            cmd_lock_release(coord_dir, release_ns)
        else:
            sys.stderr.write(
                "coord: not releasing lock '%s': owner.json no longer carries this run's token\n" % args.name
            )


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def cmd_status(coord_dir: str, args: argparse.Namespace) -> int:
    ensure_dirs(coord_dir)
    print("TASKS")
    cmd_task_list(coord_dir, argparse.Namespace(all=False, stale_after=None, json=False))
    print()
    print("LOCKS")
    cmd_lock_status(coord_dir, argparse.Namespace(name=None, json=False))
    return EXIT_OK


# ---------------------------------------------------------------------------
# argument parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="coord", description="Portfolio Desk agent coordination CLI")
    top = parser.add_subparsers(dest="command")

    task_parser = top.add_parser("task", help="task register")
    task_sub = task_parser.add_subparsers(dest="task_command")

    p = task_sub.add_parser("register")
    p.add_argument("--id", required=True)
    p.add_argument("--owner")
    p.add_argument("--branch")
    p.add_argument("--worktree")
    p.add_argument("--paths")
    p.add_argument("--port", type=int)
    p.add_argument("--browser-session")
    p.add_argument("--handoff")
    p.add_argument("--pid", type=int)
    p.add_argument("--status", choices=["planned", "active"])
    p.add_argument("--update", action="store_true")
    p.add_argument("--json", action="store_true")

    p = task_sub.add_parser("checkpoint")
    p.add_argument("id")
    p.add_argument("--note", required=True)
    p.add_argument("--tested-commit")
    p.add_argument("--evidence")
    p.add_argument("--next")
    p.add_argument("--status", choices=TASK_STATUSES)
    p.add_argument("--json", action="store_true")

    p = task_sub.add_parser("heartbeat")
    p.add_argument("id")
    p.add_argument("--json", action="store_true")

    p = task_sub.add_parser("show")
    p.add_argument("id")
    p.add_argument("--json", action="store_true")

    p = task_sub.add_parser("list")
    p.add_argument("--all", action="store_true")
    p.add_argument("--stale-after")
    p.add_argument("--json", action="store_true")

    p = task_sub.add_parser("release")
    p.add_argument("id")
    p.add_argument("--by", required=True)
    p.add_argument("--reason", required=True)
    p.add_argument("--json", action="store_true")

    p = task_sub.add_parser("archive")
    p.add_argument("id")
    p.add_argument("--json", action="store_true")

    lock_parser = top.add_parser("lock", help="named locks")
    lock_sub = lock_parser.add_subparsers(dest="lock_command")

    p = lock_sub.add_parser("acquire")
    p.add_argument("name")
    p.add_argument("--task", required=True)
    p.add_argument("--owner")
    p.add_argument("--ttl")
    p.add_argument("--note")
    p.add_argument("--wait", type=float)
    p.add_argument("--break-stale", action="store_true")
    p.add_argument("--exclusive", action="store_true", help="do not treat a same-task holder as already-acquired; two runs of one task then serialize")
    p.add_argument("--pid", type=int)
    p.add_argument("--json", action="store_true")

    p = lock_sub.add_parser("release")
    p.add_argument("name")
    p.add_argument("--task", required=True)
    p.add_argument("--force", action="store_true")
    p.add_argument("--force-live", action="store_true")
    p.add_argument("--reason")
    p.add_argument("--token")
    p.add_argument("--json", action="store_true")

    p = lock_sub.add_parser("status")
    p.add_argument("name", nargs="?")
    p.add_argument("--json", action="store_true")

    p = lock_sub.add_parser("run")
    p.add_argument("name")
    p.add_argument("--task", required=True)
    p.add_argument("--owner")
    p.add_argument("--ttl")
    p.add_argument("--note")
    p.add_argument("--wait", type=float)
    p.add_argument("--break-stale", action="store_true")
    p.add_argument("--exclusive", action="store_true", help="do not treat a same-task holder as already-acquired; two runs of one task then serialize")
    p.add_argument("--pid", type=int)

    top.add_parser("status")

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    argv = list(argv)

    # `lock run NAME --task ID ... -- CMD ARGS...`: strip everything from the
    # first literal "--" off before argparse ever sees it, so CMD ARGS are
    # never interpreted as coord.py's own options.
    cmd_for_run: Optional[List[str]] = None
    if len(argv) >= 2 and argv[0] == "lock" and argv[1] == "run" and "--" in argv:
        idx = argv.index("--")
        cmd_for_run = argv[idx + 1 :]
        argv = argv[:idx]

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return EXIT_REFUSED

    coord_dir = resolve_coord_dir()
    ensure_dirs(coord_dir)

    if args.command == "task":
        if getattr(args, "task_command", None) is None:
            sys.stderr.write("coord: 'task' requires a subcommand\n")
            return EXIT_REFUSED
        if args.task_command == "register":
            return cmd_task_register(coord_dir, args)
        if args.task_command == "checkpoint":
            return cmd_task_checkpoint(coord_dir, args)
        if args.task_command == "heartbeat":
            return cmd_task_heartbeat(coord_dir, args)
        if args.task_command == "show":
            return cmd_task_show(coord_dir, args)
        if args.task_command == "list":
            return cmd_task_list(coord_dir, args)
        if args.task_command == "release":
            return cmd_task_release(coord_dir, args)
        if args.task_command == "archive":
            return cmd_task_archive(coord_dir, args)

    if args.command == "lock":
        if getattr(args, "lock_command", None) is None:
            sys.stderr.write("coord: 'lock' requires a subcommand\n")
            return EXIT_REFUSED
        if args.lock_command == "acquire":
            return cmd_lock_acquire(coord_dir, args)
        if args.lock_command == "release":
            return cmd_lock_release(coord_dir, args)
        if args.lock_command == "status":
            return cmd_lock_status(coord_dir, args)
        if args.lock_command == "run":
            args.cmd = cmd_for_run or []
            return cmd_lock_run(coord_dir, args)

    if args.command == "status":
        return cmd_status(coord_dir, args)

    parser.print_help()
    return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main())
