# Vanguard Skin — Session End Checklist

Perform these steps in order. Skip any that don't apply.

**`/session-end` itself is the authorization** — do NOT pause for commit / push / rebuild confirmation. The user invoking the command IS the green light. Only stop for destructive operations (force-push, branch delete, dropping data).

## 1. Uncommitted changes

Run `git status --short` in the main repo (and any worktrees if working in one).

If anything is uncommitted: stage + commit straight through. Follow the project's commit conventions (descriptive 1-2 sentence message focused on "why," `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer, name files explicitly — never `git add -A`). Multi-commit splits are fine when they reflect distinct concerns (e.g., feature code + docs reconciliation), and the established project pattern is to land docs reconciliation as a separate `chore(claude)` commit after the feature commit so commit hashes can be cross-referenced from TODO.md / MEMORY.md.

After committing: `git push origin <current-branch>`. Don't ask. If push fails (auth, network, conflict), surface the failure and stop — do not retry destructively.

## 2. Open PRs

Run `gh pr list 2>/dev/null`. If any open PRs from this session, surface them in the summary at the end. No action required unless explicitly asked.

## 3. Worktrees

Run `git worktree list`. If extras exist beyond the main checkout, mention them in the summary so the user can clean up next session. Don't auto-remove (worktree cleanup can lose in-progress work; the user gets to decide).

## 4. Reconcile TODO.md

Read `docs/plans/TODO.md` and reconcile it against what actually shipped this session:

- Cross-reference every open item (`- [ ]` checkboxes) against `git log` since session start — sibling fixes often ride along with the headline work and must be ticked too.
- **Before ticking any item, verify it actually shipped** — `grep` the codebase for its identifiers (file paths, function names, migration numbers, commit hashes referenced in the item). Drift goes both ways: items get ticked that weren't done, and items stay open after silently shipping in an earlier session. Flag the latter rather than re-implementing.
- Match the file's existing convention: completed items move from "Open items" to the "Closed this session" block with `✅`, today's date, and commit hash(es). Do NOT introduce a new convention.
- Add any new TODOs discovered this session (bugs found, deferred work, follow-ups the user mentioned) to "Open items" with enough context (files, ~time estimate, why) that next session can pick them up cold.
- If the session closed a roadmap-level theme (Theme A / Theme D / etc.), update the "Backlog themes" list too.

## 5. Update auto-memory

Read `/Users/Yitzi/.claude/projects/-Users-Yitzi-code-vanguard-skin/memory/MEMORY.md` and update:
- Add a new entry under "Recent Work (<today's date>)" summarizing what shipped this session (commit hash, file count, key bullets)
- Add any newly discovered TODOs to the "TODO (next session)" list
- Strike through anything the session resolved (e.g., active issues that were fixed)
- Add new memory files in `memory/` for any durable feedback or project facts learned this session, then link them in MEMORY.md

## 6. Update CLAUDE.md

If any of these changed during the session, update `CLAUDE.md` accordingly:
- New conventions or single-source-of-truth utilities (add to "Conventions")
- New API routes (add to "API Pattern")
- Architecture changes (Calendar / Auto-Refresh / Electron Build / etc.)
- Fixed known issues (strike through with `~~text~~` in "Active Issues")

## 7. Codex handoff — write `docs/HANDOFF.md`

Overwrite `docs/HANDOFF.md` (rolling file; git history is the archive) with a brief handoff for Codex, which reviews this repo via GitHub. Cover exactly these five items:

1. **Current goal + exact files changed** this session (paths, not vague areas).
2. **Tests/E2E checks run and their results** (e.g., "`npx vitest run` — 4,571 passed" or "not run — docs-only session").
3. **Open concerns, rejected approaches, and user decisions** — the "why" a reviewer can't get from the diff. Include anything decided but not yet implemented.
4. **Uncommitted changes or live-process state** (worktrees, running dev servers, in-flight branches, pending PRs). "None" is a valid and useful answer.
5. **Claude session link** (the `https://claude.ai/code/session_...` URL from this session's environment, if available).

**Sanitization (public repo):** describe work in code terms only. No dollar amounts, share counts, position counts, return percentages, or any portfolio-derived figures — same rule as PR bodies and README assets.

Commit it with the session's `chore(claude)` docs commit so it lands on GitHub with the push. Skip this step only if the session made no decisions and changed nothing (pure Q&A).

## 8. Rebuild Electron DMG (pre-authorized)

If the session changed any production code (anything outside `tests/`, `docs/`, `.claude/`, or memory files):

```bash
npm run electron:deploy
```

**Run in background.** Pre-authorized — do not ask. Takes ~3-5 min (Next.js build + tsc + symlink deref + electron-builder + code signing + auto-install to `/Applications/Vanguard Dashboard.app` + relaunch).

If notarization is skipped because `APPLE_API_KEY` env vars aren't in shell, that's fine for local install — note it but don't block.

Skip this step if the session was docs-only / memory-only / `.claude/` config-only.

## 9. Summary

Print a tight summary (≤150 words):
- What shipped this session (commit hash + 1-line takeaway per item)
- Stats: files changed, test count delta, lines +/-
- What's deferred (with pointers to plans / TODOs)
- Anything blocking next session
