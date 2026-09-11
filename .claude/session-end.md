# Vanguard Skin — Session End Checklist

Perform these steps in order. Skip any that don't apply.

**Explicit session-end authorization:** When I explicitly invoke `session-end` (including `$session-end`, `/session-end`, or `/skills session-end`) or ask you to run the session-end workflow, that authorizes committing this session's changes, pushing, integrating this session's branch through the project's normal workflow, and building and deploying the reviewed result. The agent receiving the request owns the closeout; do not assume another agent will ship it or ask again for these actions. Complete verification and preserve other agents' work. If unfinished concurrent work prevents safe integration or deployment, finish independent closeout steps and report the specific blocker. Discussing/editing session-end, requesting a summary, saying only 'we're done', or closing the editor does not invoke it. Explicit limits such as 'session-end without deploying' override the default. Historical production-data repairs, destructive actions, and unrelated work still require separate authorization.

This file owns the shared Claude/Codex workflow. Agent-specific adapters supply environment details, not a different approval policy. GitHub issue comments/closures and external communications require their own user authorization; otherwise prepare a closure proposal.

## 1. Uncommitted changes

Run `git status --short` in the main repo and active worktree. Read `docs/CODEX-CLAUDE-COORDINATION.md` and the latest handoff when present; establish ownership and whether another agent is landing or deploying. Preserve their work and handoff. Before committing production code, follow `docs/reference/verification-loop.md`; reuse completed checks for unchanged code.

Commit only this session's verified changes using explicit paths for staging AND committing; never sweep another agent's staged or unstaged work. Use descriptive messages focused on why, with the actual agent's attribution (no hardcoded model identity). Multi-commit splits are fine when they reflect distinct concerns (e.g., feature code + docs reconciliation), and the established project pattern is to land docs reconciliation as a separate `chore(claude)` commit after the feature commit so commit hashes can be cross-referenced from TODO.md / MEMORY.md.

Reconcile TODOs against the resulting commits before pushing. Push this session's reviewed branch to origin. If push fails, report the failure; never force-push to bypass it.

### Integrate before deployment

Bring this session's branch up to the current integration branch in its isolated worktree. Preserve both sides of overlaps and review the combined diff. Rerun checks affected by integration and the full suite when production code changed. Land through the established project workflow only after the integration checkout is clean and no concurrent landing/deployment owns it; use a fast-forward where possible. Hold the shared `integration` lock for the landing (`npm run coord -- lock run integration --task <id> -- <merge/push command>`; `npm run coord -- status` shows the holder). A lock held by the other agent is the concrete blocker to report, not something this authorization breaks. Never stash, reset, or switch the shared checkout's branch to make room. Push the integrated result, and deploy from that reviewed commit. Do not deploy an unmerged feature branch or another agent's unfinished edits. If the boundary is unavailable, finish branch commits, verification, and handoff and report integration/deployment as pending.

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
- **GitHub issue reconcile (Codex request 2026-08-11):** sweep ALL open issues against landed commits, not just this session's fixes — `gh issue list` and, for each open issue, check whether a commit on `main` already implements it (grep for the issue's file paths / function names; check commit messages). A fix that landed in an earlier session without closing its issue is the known failure mode (issue #36 sat open 4 days after `8529729` shipped it). For each satisfied issue, prepare a closure proposal linking commit hashes and verification evidence. Post comments and close issues only when the user separately authorizes that external communication. This is Codex's feedback loop. Issues triaged into TODO.md whose fix hasn't shipped stay open.

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

## 7. Rebuild Electron DMG (pre-authorized)

If this session changed production code, deploy the verified integrated commit after reading `docs/reference/electron-build.md`. Tests, docs, skills (`.agents/`, `.claude/`), and memory-only changes do not need a rebuild. Builds must use the project's `npm run build` wrapper so build-time imports cannot migrate the live database. Do not run historical data backfills or repair scripts as part of deployment. Separately deployed services such as Workers require their own authorization.

Use the project's deployment wrapper (checked in; it runs the same `electron:pack` → `verify-bundle` → `electron:install` chain under the `integration`/`deploy`/`app-3099` locks, verifies HEAD == origin/main and a clean tree, preserves every step's exit code, and checks the installed BUILD_ID + a fresh :3099 listener afterwards — see `docs/reference/coordination.md`):

```bash
source ~/.zshrc >/dev/null 2>&1; PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run deploy -- --task <id> [--commit <sha>]
```

Do not improvise a deploy script at closeout; if the wrapper refuses, fix the stated precondition or report it. (`npm run electron:deploy` remains the raw chain the wrapper calls.)

(The node@24 PATH prefix is REQUIRED — the project is pinned to the node@24 LTS keg (2026-08-11 migration); the bare `/opt/homebrew/bin/node` moves on every `brew upgrade`. `source ~/.zshrc` carries the APPLE_API_* notarization vars. When backgrounding with a `| tail` pipe, check `PIPESTATUS[0]` or grep the output for "Build error" — the pipe masks the real exit code.)

**Run in background.** Pre-authorized — do not ask. Takes ~3-5 min (Next.js build + tsc + symlink deref + electron-builder + code signing + auto-install to `/Applications/Vanguard Dashboard.app` + relaunch).

If notarization is skipped because `APPLE_API_KEY` env vars aren't in shell, that's fine for local install — note it but don't block.

Skip this step if the session was docs-only / memory-only / `.claude/` config-only.

## 8. Codex handoff — write `docs/HANDOFF.md` (after the deploy finishes)

Runs AFTER step 7 deliberately (Codex request 2026-08-10): the handoff must report the FINAL deploy/E2E result and the true ending process state, not the state before deployment. If the deploy is still running in the background, wait for it before writing.

Write the final handoff in `docs/HANDOFF.md` when owned by this session. Preserve another agent's handoff by writing `docs/HANDOFF-<AGENT>-<DATE>.md` and linking it from the coordination note. Use the actual executing agent's attribution. Cover exactly these five items:

0. **Waiting on:** the FIRST line of the file — and every question in it that only the user can answer also exists as a `decision` record in the register (`npm run coord -- task register --id <slug> --owner user --status decision --next "<question>"`), so `npm run inbox` still shows it after this task is landed. It is — `USER: …`, `CODEX: …`, `CLAUDE: …` or `nobody` (the same labels `npm run inbox` reads from task `next_action`). Also checkpoint the task in the register with a labeled `--next` so the inbox and the handoff agree.
1. **Current goal + exact files changed** this session (paths, not vague areas).
2. **Tests/E2E checks run and their results** (e.g., "`npx vitest run` — 4,571 passed" or "not run — docs-only session"), plus the step-7 deploy outcome (deployed + relaunched / skipped / failed-with-reason).
3. **Open concerns, rejected approaches, and user decisions** — the "why" a reviewer can't get from the diff. Include anything decided but not yet implemented.
4. **Uncommitted changes or live-process state** as of AFTER the deploy (worktrees, running dev servers, in-flight branches, pending PRs, which app build is live). "None" is a valid and useful answer.
5. **Agent identity and session link** (the `https://claude.ai/code/session_...` URL from this session's environment, if available). Access-control verified 2026-08-10: sessions are private-by-default (login wall + owner-only; opaque ID, no metadata leak), and the same links already ride every commit trailer in this repo. NEVER toggle a session on this project to public visibility — session context contains real portfolio data.

**Sanitization (public repo):** describe work in code terms only. No dollar amounts, share counts, position counts, return percentages, or any portfolio-derived figures — same rule as PR bodies and README assets.

Commit it as its own final `chore(<agent>): session handoff` commit and push — this is the session's last commit, so `docs/HANDOFF.md` on GitHub always reflects the true end state. Skip this step only if the session made no decisions and changed nothing (pure Q&A).

## 9. Summary

Print a tight summary (≤150 words):
- What shipped this session (commit hash + 1-line takeaway per item)
- Stats: files changed, test count delta, lines +/-
- What's deferred (with pointers to plans / TODOs)
- Anything blocking next session
