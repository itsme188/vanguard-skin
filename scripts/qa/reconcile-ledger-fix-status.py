#!/usr/bin/env python3
"""Reconcile QA-ledger `fix_status` after nightly-fixer PRs land.

For every finding whose fix_status is `branch-unpushed` or `pr-open` and that has
a `fix_commit` (or `fix_commit_partial`), check whether that commit, or a commit
on --ref whose subject carries the same `[qa:<finding-id>]` tag (cherry-picks get
new SHAs), is reachable from --ref (default origin/main). If so set
fix_status "merged", merged_date (US Eastern YYYY-MM-DD) and landed_commit
(short sha on the ref). Only those three fields are ever written.
A commit whose subject starts with "Revert" never counts as landing a tag, and a
row that has only `fix_commit_partial` is reported as "partial fix landed" and
left as is (a partial fix is not a merged fix).

Dry run by default. --apply first copies the ledger to
<ledger>.bak-<date>-reconcile (a numeric suffix -2, -3... is added rather than
overwriting an earlier backup from the same day), then rewrites it preserving indentation, trailing
newline and non-ASCII characters.

Usage: scripts/qa/reconcile-ledger-fix-status.py [--ledger PATH] [--ref REF] [--apply]
Run it from inside the repo (git is invoked in the current directory, or --repo).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

PENDING = ("branch-unpushed", "pr-open")


def git(repo, *args, check=True):
    proc = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc


def short_sha_on_ref(repo, ref, commit):
    """Short sha of `commit` if it is an ancestor of ref (or ref itself)."""
    if not commit:
        return None
    resolved = git(repo, "rev-parse", "--verify", "--quiet", commit + "^{commit}", check=False)
    if resolved.returncode != 0:
        return None
    sha = resolved.stdout.strip()
    anc = git(repo, "merge-base", "--is-ancestor", sha, ref, check=False)
    if anc.returncode != 0:
        return None
    return git(repo, "rev-parse", "--short", sha).stdout.strip()


def tagged_commit_on_ref(repo, ref, finding_id):
    """(sha, reverted): the newest live commit on ref carrying [qa:<id>].

    `sha` is None when none lands. A tagged commit is dead when a LATER commit
    reverts it (subject `Revert "<its subject>"` or a body line `This reverts
    commit <sha>`); a still-later commit with the tag again re-lands it.
    `reverted` is True when the only tagged commits found were reverted.
    """
    tag = "[qa:%s]" % finding_id
    out = git(repo, "log", ref, "--format=%H%x1f%h%x1f%s%x1f%b%x1e", "--fixed-strings", "--grep", tag).stdout
    commits = []  # newest first
    for rec in out.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        full, short, subject, body = (rec.split("\x1f") + ["", "", "", ""])[:4]
        commits.append((full, short, subject, body))
    live = []
    reverted_any = False
    for i, (full, short, subject, body) in enumerate(commits):
        if tag not in subject or subject.startswith("Revert"):
            continue
        # Later commits are the ones before index i (newest first).
        undone = any(
            ("This reverts commit %s" % full) in later_body
            or later_subject == 'Revert "%s"' % subject
            for _, _, later_subject, later_body in commits[:i]
        )
        if undone:
            reverted_any = True
        else:
            live.append(short)
    if live:
        return live[-1], False  # oldest live commit
    return None, reverted_any


def detect_format(raw):
    indent = 2
    lines = raw.split("\n")
    if len(lines) > 1:
        m = re.match(r"^( +|\t+)\S", lines[1])
        if m:
            indent = "\t" if m.group(1).startswith("\t") else len(m.group(1))
    return indent, raw.endswith("\n")


def findings_of(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("findings", "entries", "items"):
            if isinstance(data.get(key), list):
                return data[key]
    raise RuntimeError("unrecognised ledger shape: expected a list or an object with a findings list")


def today_eastern():
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ledger", default="qa/findings/ledger.json")
    ap.add_argument("--ref", default="origin/main")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)

    try:
        with open(args.ledger, encoding="utf-8") as fh:
            raw = fh.read()
        data = json.loads(raw)
        findings = findings_of(data)
        git(args.repo, "rev-parse", "--verify", "--quiet", args.ref + "^{commit}")
    except (OSError, ValueError, RuntimeError) as exc:
        sys.stderr.write("reconcile-ledger-fix-status: %s\n" % exc)
        return 1

    date = today_eastern()
    changes = []
    partials = []
    reverted = []
    suspects = []
    for f in findings:
        if not isinstance(f, dict):
            continue
        fid = f.get("id")
        full_commit = f.get("fix_commit")
        commit = full_commit or f.get("fix_commit_partial")
        if f.get("fix_status") == "fixed" or (f.get("status") == "fixed" and not f.get("fix_status")):
            if not f.get("fix_commit") and f.get("fix_status") == "fixed":
                suspects.append(fid)
            continue
        if f.get("fix_status") not in PENDING or not commit or not fid:
            continue
        try:
            landed = short_sha_on_ref(args.repo, args.ref, commit)
            if not landed:
                landed, was_reverted = tagged_commit_on_ref(args.repo, args.ref, fid)
                if was_reverted:
                    reverted.append(fid)
        except RuntimeError as exc:
            sys.stderr.write("reconcile-ledger-fix-status: %s\n" % exc)
            return 1
        if landed and not full_commit:
            partials.append((fid, commit, landed))
        elif landed:
            changes.append((f, fid, f["fix_status"], commit, landed))

    for _, fid, old, commit, landed in changes:
        print("%s: %s -> merged  (fix_commit %s, landed %s on %s)" % (fid, old, commit[:12], landed, args.ref))
    for fid, commit, landed in partials:
        print("%s: partial fix landed (fix_commit_partial %s, landed %s on %s); fix_status left as is" % (fid, commit[:12], landed, args.ref))
    for fid in reverted:
        print("%s: reverted on %s (tagged fix was reverted and not re-landed; left alone)" % (fid, args.ref))
    for fid in suspects:
        print("suspect: no commit: %s (fix_status fixed, no fix_commit; left alone)" % fid)
    print("%d finding(s) %s" % (len(changes), "updated" if args.apply else "would change (dry run; pass --apply)"))

    if args.apply and changes:
        backup = "%s.bak-%s-reconcile" % (args.ledger, date)
        n = 2
        while os.path.exists(backup):
            backup = "%s.bak-%s-reconcile-%d" % (args.ledger, date, n)
            n += 1
        shutil.copy2(args.ledger, backup)
        for f, _, _, _, landed in changes:
            f["fix_status"] = "merged"
            f["merged_date"] = date
            f["landed_commit"] = landed
        indent, trailing_nl = detect_format(raw)
        out = json.dumps(data, indent=indent, ensure_ascii=False)
        if trailing_nl:
            out += "\n"
        tmp = args.ledger + ".tmp-reconcile"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(out)
        os.replace(tmp, args.ledger)
        print("backup: %s" % backup)
    return 0


if __name__ == "__main__":
    sys.exit(main())
