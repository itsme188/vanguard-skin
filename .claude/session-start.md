# Vanguard Skin — Session Start Checklist

Goal: get the user to a ranked "pick what to work on" menu within a few minutes. Gather everything first (parallel tool calls where independent), synthesize, then ask. Do NOT start any work before the user picks.

## 1. Repo state

- `git status --short` — uncommitted changes from a previous session? Show the user what they are BEFORE doing anything else.
- `git log --oneline -8` — what landed last session.
- `git worktree list` — leftover worktrees.
- QA branch sweep (memory rule — qa fix branches never auto-merge): `git fetch origin --quiet`, then for every local or remote `qa-*` branch, `git log main..<branch> --oneline`. Empty output = merged, just a stale ref; unique commits = unlanded fixes to surface.

## 2. Cross-agent inboxes

- Read `docs/HANDOFF.md` — last session's ending state (deploy result, live-process state, open concerns). Cross-check its "uncommitted/live state" claims against the actual `git status` from step 1.
- `gh issue list --limit 30` — **GitHub issues are Codex's outbox** (`codex-advisory` findings + P0 intake issues). Identify anything new since the last session; read the bodies of new ones (`gh issue view N`).
- `gh pr list` — open PRs.

## 3. Backlog

- `docs/plans/TODO.md` — the file is long; `grep -n '^- \[ \]' docs/plans/TODO.md` for open items first, then read entries that need context.
- `qa/findings/DECISIONS-PENDING.md` — pending QA decisions (collision lesson 2026-07: check this + open PRs before hand-fixing anything the nightly fixer may own).
- Auto-memory `MEMORY.md` — "Active Issues" + follow-ups queued in the newest Recent Work entry.

## 4. Reconcile issues ↔ TODO

`docs/plans/TODO.md` is the SINGLE authoritative backlog. For each new GitHub issue worth working: add a one-line TODO entry referencing the issue number (`#NN`) — the issue keeps Codex's full detail, the TODO holds priority/status; never duplicate the body. Flag issues that look already-fixed or obsolete as closure candidates (ask the user before closing).

## 5. Synthesize + ask

Present, in this order:

1. **Do-first quick items** — follow-ups explicitly queued from prior sessions, each ≤15 min.
2. **3–5 main candidates** in a table: what it is, why / why not now. Draw from user-reported bugs first, then Codex P0s, then TODO features, then advisory batches.
3. **A recommendation** with one-sentence reasoning (user-visible wrong data > latent risk > polish).

Then AskUserQuestion for the session focus. The user picks; only then does work begin.
