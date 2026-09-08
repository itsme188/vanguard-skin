# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-08 (Tuesday) ~12:10 ET → ~13:25 ET. Focus (user task): Claude/Codex coordination helpers, browser/deployment orchestration, Claude hook repair, shared workflow documentation. This task did NOT invoke session-end: everything below is committed on the isolated branch `claude/coordination-2026-09-08` (worktree `/Users/Yitzi/code/vanguard-skin-coord`, base `3b31714e`) — not pushed, not merged into `main`, nothing built or deployed.

## 1. Goal + exact files changed

Five pathspec commits, oldest first:

1. `9b097b07` feat(coord): shared task register + named locks CLI — `scripts/coord/coord.py`, `scripts/coord/coord.sh`, `tests/coord/coord-cli.test.ts`.
2. `d971d49b` fix(claude-hooks): stdin JSON, no masked failures, no full suite on Stop — `.claude/settings.json`, `.claude/hooks/check-todo-reconciled.sh`, `.claude/hooks/post-edit-check.sh` (new), `.claude/hooks/stop-verify.sh` (new), `tests/coord/claude-hooks.test.ts`.
3. `14b26228` feat(coord): deploy wrapper — `scripts/coord/deploy.sh`, `tests/coord/deploy-wrapper.test.ts`.
4. `89061141` feat(coord): sandbox + smoke wrappers, additive verify-smoke hooks — `scripts/coord/sandbox.sh`, `scripts/coord/smoke.sh`, `scripts/verify-smoke.sh`, `tests/coord/sandbox-smoke.test.ts`.
5. `5f158439` docs(coord) — `docs/reference/coordination.md` (new, authoritative workflow), `docs/CODEX-CLAUDE-COORDINATION.md` (now a short live board), `docs/plans/archive/coordination-log-2026-09-04-to-09-06.md` (verbatim move), `docs/superpowers/specs/2026-09-08-agent-coordination-design.md` (design + Codex review fold §11), `AGENTS.md`, `CLAUDE.md` (Workflow Rules + Testing lines), `.claude/session-end.md`, `.claude/session-start.md`, `docs/DECISIONS.md`, `docs/plans/TODO.md`, `package.json` (four entries at the END of the scripts block: `coord`, `deploy`, `sandbox`, `smoke`).

Outside git: `~/.claude/settings.json` `sandbox.excludedCommands` gained the deploy wrapper forms (backup `~/.claude/settings.json.bak-2026-09-08-coord`); the shared coordination directory `/Users/Yitzi/code/vanguard-skin/.git/portfolio-desk-coord/` now exists (mode 0700) with one registered task; private evidence in `docs/private/coordination-evidence-2026-09-08/` and the resumable log `docs/private/coordination-progress-2026-09-08.md` (both gitignored, main checkout).

Verified findings that drove the work: the installed Claude Code 2.1.263 binary has no `CLAUDE_FILE_PATHS` (the eslint + security_type PostToolUse hooks had been no-ops); the Stop hook ran the full suite at every stop behind `| tail -3` (exit code masked); Codex loads at most one instruction file per directory, so with `AGENTS.md` present `CLAUDE.md` was never auto-loaded by Codex (the AGENTS.md claim was wrong); no lock protected landing/deploying; the 09-06 browser contention came from concurrent smokes sharing one agent-browser session plus a `close --all` cleanup.

## 2. Tests / E2E / deploy result

| Check | Result |
|---|---|
| `tests/coord` (4 files, new) | 60 passed |
| Full suite on the branch tip (worktree, no `.env.local`) | 753 files: 9,112 passed, 3 failed, 3 skipped, 9 todo. The 3 failures are `tests/ai/generate.test.ts`, which reads `ANTHROPIC_API_KEY` from the environment (same 3 fail on unmodified `main` in this worktree; pass with a dummy key). Filed as TODO (g). Net: +60 tests, 0 new failures. |
| `tsc --noEmit` | only the documented 20-error baseline in four untouched test files; none in the new files |
| `npm run verify:changed` | tooling category, no focused mapping (expected); `tests/coord` run manually as the manual selection |
| Codex design review (read-only, 1 round) | REVISE, 25 findings; 20 accepted and folded (spec §11), 5 rejected/deferred with reasons |
| Live proof A — lock contention | two shells: second acquire 75 with holder line; `lock run` refused without running; `--wait` succeeded after release; stale (dead pid + expired TTL) refused without, broken with `--break-stale`, logged |
| Live proof B — interrupted task | owner pid killed + worktree removed → `OWNER-GONE,WORKTREE-MISSING`; resume pointer readable; `release --by codex --reason`; archive refused while active, allowed after; a late checkpoint on the archived task refused |
| Live proof C1 — `deploy.sh --dry-run` on the REAL main checkout | refused (exit 65) for two true reasons: dirty `docs/HANDOFF.md` and `workers/cron/.wrangler` present; locks acquired first and released; nothing built |
| Live proof C2 — sandbox + smoke | real sandbox from this worktree on :3090 in ~7 s (VACUUM copy, minted session, 0 dotenv keys to pin, `TWS_HOST` blocked); single smoke **4/4**; two concurrent smokes serialized on the exclusive `browser` lock (ends at 21 s and 43 s, both 4/4); a second same-worktree sandbox refused (75); live DB size/mtime unchanged; torn down, no listener or lock left |
| Electron deploy | **not run** (out of scope; the wrapper's dry-run was the only deploy-path execution) |

Before the `--exclusive` fix, two same-task smokes shared one browser session and each lost the Cmd+K flow (3/4) — the 09-06 failure shape reproduced and then removed.

## 3. Open concerns / rejected approaches / decisions for the user

- **Landing order:** Codex's `codex/verification-reliability-2026-09-08` (touches `package.json` `verify:changed`, `scripts/lib`, `.codex/hooks`) should land first; this branch rebases on top (different `package.json` hunk). Neither branch is authorized to merge itself.
- **Main checkout blockers the wrapper will keep refusing until fixed:** (a) `docs/HANDOFF.md` is a stale, corrupted working copy (backup kept in the session scratchpad); restore with `git checkout -- docs/HANDOFF.md` from the main checkout — your call, it discards uncommitted text; (b) `workers/cron/.wrangler/` (local KV state from a `wrangler dev` run, newest file 2026-08-28) sits in the main checkout — the bundle gate excludes it, but the wrapper preflight fails closed; delete it (or move it to a sibling worktree) before the next deploy.
- **AGENTS.md structural fix (user decision, deletes a file):** move the CSV contract to `docs/canonical-csv-guide.md` and remove `AGENTS.md` so Codex's fallback loads `CLAUDE.md` for both agents. Not done here.
- **Hook activation:** the new hooks take effect in Claude Code sessions whose project settings are the landed `.claude/settings.json` (the file watcher picks up project-settings edits). First live turn after landing: expect one `post-edit-check` warning per edited TS file with a finding and a Stop that blocks once only on a real verification failure.
- **Codex runner adoption:** `stop-verify.sh` already feature-detects `scripts/verify.sh status --base main`; confirm the 0/3/4 contract live once Codex lands. Until then the fallback (`verify:changed`) cannot distinguish "unverified" from "passed" for unmapped changes.
- **Rejected/deferred from the Codex review:** lock adoption by the nightly QA scripts; revision-checked task updates; process-tree supervision (needs a daemon); an in-app build stamp (`/api/health`, production code); all filed in TODO with reasons in spec §11.
- **Stale `.claude/worktrees/*` dirs** (five, March, not registered worktrees) — delete after confirmation.
- **Nightly fixer branch `qa-fix-work-20260908`** (4 commits) is still undelivered because of the dirty HANDOFF.md above.

## 4. Uncommitted changes / live-process state

- Main checkout: unchanged by this session except `docs/private/*` (gitignored) and the new `.git/portfolio-desk-coord/` directory; `docs/HANDOFF.md` still dirty as found. No branch switch, no stash, no reset.
- Worktree `/Users/Yitzi/code/vanguard-skin-coord` on `claude/coordination-2026-09-08` @ `5f158439` + this handoff commit; clean. Codex's worktree `/private/tmp/portfolio-desk-verification-2026-09-08` untouched. The prunable `/private/tmp/portfolio-desk-trade-lots-2026-09-06` worktree still listed.
- No dev server, sandbox, browser session or lock left running (sandbox torn down; `coord status` shows one active task, no locks). The installed app on :3099 was never touched.
- Register: task `coord-helpers-2026-09-08` (owner claude) — set to `landed` by whoever merges this branch.
- Codex message channel: `/private/tmp/portfolio-claude-to-codex-2026-09-08.md` (interface review + ownership + this branch's state) and the board in `docs/CODEX-CLAUDE-COORDINATION.md`.

## 5. Claude session link

https://claude.ai/code/session_01KyxCGVdtETtp71BFyZk5k1
