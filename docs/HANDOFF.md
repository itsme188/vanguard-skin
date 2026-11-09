# Session Handoff — for Codex review

**Waiting on:** USER: the three standing decision records are unchanged and still open — `late-arm-preview-confirm`, `broker-realized-gain-reports`, `tax-preparer-short-term-gift`. Nothing from tonight is blocked on a ruling; the one judgement call that arose (how to reconcile a diverged `main`) was ruled by the owner mid-session and executed. CLAUDE: three QA auto-fix PRs are open and unlanded — #170 (2026-11-08), #166 (2026-11-07), #165 (2026-11-06). None of them overlaps tonight's five fixes; they are separate work sitting on separate branches, and the project's standing rule is that `qa-*` branches never auto-merge and must be swept every session. CODEX: nothing requested.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

## 1. Goal and files changed

Goal: deploy `origin/main` in the main checkout, and deploy the Worker because the bundle changed the model-policy mirror. The session authored no feature code; it integrated, verified and shipped other agents' landed work, and resolved a branch divergence found on arrival.

Two deploys happened, in this order.

**Deploy A — `5396a4af`, build `vsHEGSq11bKT6sZc-0Ju8`.** Four commits already on `origin/main` at session start: `aa7be926` model policy (#167, Sonnet becomes the app default, frontier means Opus, Fable retired; 38 files, including the `workers/cron/src/ai.ts` + `model-tiers.ts` mirror), `dd38b9cb` decision #52 chat-title masking (#168), `3f5f6145` T2 signed leverage factor (#169, 23 files, migration `102_securities_leverage_factor.sql`), `5396a4af` TODO reconciliation (#171). Worker deployed alongside it, version `4eb36431-997f-4dd1-8ff3-f5cc04617612`.

**Deploy B — `b2459c2d`, build `uNTsuCKLRETJGcM23bJdz`** (the build now live). Eight commits, rebased by the owner onto `5396a4af` and fast-forwarded in: five nightly QA fixer fixes plus three `docs: reconcile TODO.md`. Files: `lib/tws/contracts.ts` (enrichment never names an option after its underlying; an empty-string name reads as unnamed), `app/dashboard/alerts/page.tsx` + new `lib/alerts/price-as-of-label.ts` + `lib/queries/security-levels.ts` (a stored close from an earlier day is dated, never labelled "Now"; review cards stop reading a stored `created_at` as UTC), `lib/compute/donation-recompute.ts` (the recompute dialog counts estimated closes in the Tax Lots unit), `docs/plans/TODO.md`. Tests: `tests/tws/contracts.test.ts`, `tests/alerts/price-as-of-label.test.ts`, `tests/dashboard/alerts-review-created-at-utc.test.ts`, `tests/compute/donation-recompute-census-unit.test.ts`. No `workers/` file touched, verified by diff, so deploy B carried no Worker deploy and Mac/Worker parity is unchanged.

This session's own commit: this file.

## 2. Tests and E2E checks

- **Full suite at `b2459c2d` (the shipped tip): GREEN — 1,595 files, 19,731 tests passed, 9 todo, zero failures**, 174.84s. Evidence `1794182830655-758c8449-0856-4f7d-83f3-283515fa728e`. Run before the push, deliberately, so a red tree could never reach `origin/main`.
- Full suite at `5396a4af`: GREEN — 1,592 files, 19,719 passed. Evidence `1794177619305-dfbbcfbf-9ee7-430b-bf15-27fcd8665395`.
- **Deploy A:** `scripts/coord/deploy.sh` exit 0. Notarization successful first attempt; `verify-bundle.js` → `OK (no leaks, runtime pieces present)`; pre-quit freed :3099; post-verify passed all four checks. Worker: `wrangler deploy` exit 0, first try, no stale `.wrangler` state, single `*/15 * * * *` trigger and the KV/R2 bindings unchanged. Log `.git/portfolio-desk-coord/logs/deploy-20261108T224002Z.log`.
- **Deploy B:** `scripts/coord/deploy.sh` exit 0, same chain, all gates green, `BUILD_ID uNTsuCKLRETJGcM23bJdz matches on both sides`, codesign verified, `/login` answered "Portfolio Desk". Log `.git/portfolio-desk-coord/logs/deploy-20261109T001032Z.log`.
- **Migration 102 verified on the live database after the relaunch** (read-only check): `102_securities_leverage_factor.sql` is recorded in `schema_migrations`, `securities.leverage_factor` exists, and the startup sync populated it. It was never rehearsed on a VACUUM copy before deploy — flagged at the time, the owner directed the deploy regardless, and it applied cleanly. Row counts omitted, public repo.
- Not exercised: the leverage-factor scenario maths and the new alerts labelling were not driven through the UI in the real app. Unit coverage only. See section 3.

## 3. Open concerns, rejected approaches, decisions

- **A diverged `main` was the session's real finding.** On arrival the pull aborted: local `main` carried eight commits that existed on no remote branch — the nightly QA fixer had merged into the local checkout and never pushed — while `origin/main` carried four it lacked. Only `docs/plans/TODO.md` overlapped. The session stopped rather than choosing, since the deploy wrapper builds the working tree and the resolution therefore decides what ships. The owner ruled: preserve the eight on a pushed branch, reset to `origin/main`, ship that, then rebase the eight on top and ship again. Both halves are now on `origin/main` and in the live build. The durable lesson is that a nightly fixer landing into a local `main` diverges silently; a push after each landing, or a sweep of `git log main..origin/main` at session start, catches it.
- **The stop-verify gate was unsatisfiable for part of the session, for a diagnosable reason.** The full suite at the pre-merge tip `e709e7e7` was red in exactly two tests in `tests/calendar/verify-earnings-dates.test.ts`. The cause was a wall-clock-stale fixture: two tests pinned `event_date "2026-11-05"`, and `applyExactTimeVerdict`'s re-resolve only rewrites rows dated today or later, so they began failing on 2026-11-06 and would have failed every day after. The repair (fixtures derived from `addDays(todayET(), 7)`) existed only in `dd38b9cb` on `origin/main`. Because the gate's `currentEvidence` accepts only `result=passed`, a verified-but-red tree reads as `run=none base=none`, so the gate could not clear until the merge landed. Worth knowing: the gate cannot distinguish "not verified" from "verified and red".
- **The earlier 33-failure AI/failover red is confirmed gone,** independently of tonight's work, matching the correction already recorded in the previous handoff. The only redness remaining at session start was the two fixture tests above.
- Not done, because only the handoff refresh was asked: the rest of the session-end checklist — TODO.md reconciliation against tonight's commits, auto-memory update, CLAUDE.md review, and the GitHub issue sweep. The three open QA PRs in the Waiting-on line are the most actionable leftover.
- No new `decision` record was registered, because no new user-only question arose; the divergence question was ruled inside the session.

## 4. Uncommitted changes and live-process state

- `main` = `b2459c2d`, clean tree, pushed to `origin/main`.
- **Live app: build `uNTsuCKLRETJGcM23bJdz`** at `b2459c2d`, `next-server v16.1.6`, listener on :3099. Worker live at version `4eb36431-997f-4dd1-8ff3-f5cc04617612`.
- `origin/qa-local-unpushed-2026-11-08` still exists, pointing at the pre-rebase `e709e7e7`. Its content is fully contained in `main` via the rebased commits, so it is safe to delete whenever convenient; it is kept as the audit trail of the divergence.
- Seven extra worktrees beyond the main checkout, none touched this session: `-bogey-tmt`, `-deep-read`, `-provider-failover`, `-qa-fix` (detached at the now-superseded `e709e7e7`), `-stop-summarizing`, `-t1`, `-todo-reconcile` (on `qa-local-unpushed-2026-11-08`). Left for the owner to clean up.
- Open PRs: #170, #166, #165, all QA auto-fixes, none landed.
- `workers/cron/.wrangler/` was created by the Worker deploy and removed afterwards, because the Mac deploy's pre-flight refuses to build while it exists.
- No dev server, no sandbox, no background job still running.

## 5. Agent identity

Claude Opus 5, Claude Code, interactive session.
Session: https://claude.ai/code/session_019QYEpYHrCJDAsyEhTxM7Ng
