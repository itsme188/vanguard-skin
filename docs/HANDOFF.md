# Session Handoff — for Codex review

**Waiting on:** USER: confirm the five landings look right in the live app, and review the PR opened from `qa-local-unpushed-2026-11-09b` (three parked nightly-fixer commits, listed in §4). Two register rows are stale and only the owner can clear them — `settings-page` and `monthly-performance` still read "review PR and decide merge" although #172 and #173 merged and are deployed. The four standing decision records are unchanged and still open: `broker-realized-gain-reports`, `late-arm-preview-confirm`, `tax-preparer-short-term-gift`, plus `provider-failover` (who repairs the eight failover files). CLAUDE: nothing outstanding. CODEX: nothing requested.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

## 1. Goal and files changed

Goal: report merge-readiness on three QA pull requests, then — after the owner merged five PRs from outside — preserve the checkout, reconcile the TODO, and deploy the result to the Mac app and the Worker. This session authored no feature code; it reviewed, reconciled, verified and shipped other agents' work.

Files this session changed, both in PR #174 (`ad0af758`, merged as `1ed3c3dd`):

- `docs/plans/TODO.md` — marked the #165 / #166 / #170 nightly-QA lines landed with their merge commits, and appended a `Closed this session (2026-11-09)` block recording all five landings, the guard desync below, and the parked-commits situation.
- `tests/repo/hub-live-client-boundary.test.ts` — one entry added to `CLIENT_SAFE`.

Plus this file.

## 2. Tests and E2E checks

- **Pre-merge, per PR, on simulated merge commits:** #165 — its own 10 suites 200 passed, `workers/cron` 143 passed, `tests/repo` 53 files / 359 passed. #166 — affected calendar tests plus all of `tests/filing-summary`, 27 files / 627 passed, 1 skipped. #170 — 98 files, **1 failed**, 1,147 passed, 3 skipped (the guard below).
- **`bash scripts/verify.sh full --base main` on `519c0f02`** (after the owner merged all five): `result=failed` — 1,607 of 1,608 files green, **1 failed / 19,911 passed**, the single failure being the guard below. That bounded the blast radius: five landings together introduced no other interaction.
- **`bash scripts/verify.sh full --base main` on `1ed3c3dd`** (the deployed tip): **`result=passed` — 1,608 files, 19,912 passed, 9 todo, 0 failed.** Evidence `1794328190760-4fa0968a-cdcd-4bd7-997f-294fa79956e1`.
- **Deploy: completed and verified.** `bash scripts/coord/deploy.sh` at `1ed3c3dd` → build **`70qFikSuW5va544Ob5Mqn`**. Notarization successful; `verify-bundle: OK (no leaks, runtime pieces present)`; pre-quit freed :3099; post-verify confirmed the BUILD_ID matches on both sides, codesign verified, a new `next-server (v16.1.6)` listener, and `/login` answering "Portfolio Desk". Log `.git/portfolio-desk-coord/logs/deploy-20261110T163314Z.log`.
- **Worker deployed**, first attempt, no `.wrangler` retry needed: version **`8c83d074-5dfd-48ba-a205-4c1054345790`**, schedule `*/15 * * * *` intact, all bindings present. Required because #165 changes `workers/cron/src/fallback-earnings.ts`.
- No browser E2E this session: nothing here authored UI.

## 3. Open concerns, rejected approaches, decisions

**The twin client-safe guard desynced, and `main` landed red.** #170 added `snippet-measure-gate` to `CLIENT_SAFE` in `tests/repo/print-watch-import-boundaries.test.ts` but not to the twin list in `tests/repo/hub-live-client-boundary.test.ts`, whose set-equality assertion runs in both directions precisely so a one-sided widening cannot pass quietly. GitHub reported the PR `MERGEABLE / CLEAN` and `git merge-tree` agreed, because the defect is a consistency invariant between two files rather than a textual overlap, and the PR edited only one of the pair. The pre-merge review reported #170 **BLOCKED** on it; the merge went ahead anyway, so `main` arrived red. That also makes the Stop verification gate unsatisfiable, since `currentEvidence` accepts only `result=passed` and cannot distinguish "unverified" from "verified and red".

The fix was one line, folded into the TODO PR (#174) rather than a separate PR, because nothing could deploy past it and the owner had designated #174 the preflight tip. Flagged explicitly in the PR body for objection before merge. The module earns its place rather than merely silencing the check: `lib/print-watch/snippet-measure-gate.ts` imports only `import type { LineContract } from "./types"` — no db, no node builtins, no server trees — and its consumers are `reconcile.ts` (already client-safe) and `store.ts`.

**Drift reviewed before merge, no conflicts found.** All three QA PRs merged clean onto `origin/main` by `merge-tree` and by sequential `commit-tree` simulation in landing order, so the docs-conflict resolution step was a no-op and nothing was pushed to any PR branch. One real overlap surface existed — #166 and `main` both touched `lib/filing-summary/labels.ts`, the single source of owner-facing words — but the regions are independent (the PR adds a `REASON_SENTENCES` entry; `main` reworked the choice and cost helpers for the model-policy landing) and the whole `tests/filing-summary` suite passed on the merged tree.

**The unpushed-local-`main` divergence recurred, as predicted.** The nightly fixer auto-merges onto the main checkout's `main` and never pushes, so `main` silently diverges and the next `git pull --ff-only` aborts. This was handled twice in two sessions. A standing fix is still open and is the one thing most likely to cost another session's first hour.

**Deploy order.** Mac first, Worker second, leaving a few minutes where the new Mac build talked to the old Worker. Safe here because the Worker is fallback-only and reconciles through KV, and #165 carried no snapshot version bump. A snapshot schema change would have required the reverse order.

**Not done, deliberately:** no code conflict was resolved unilaterally (none existed); no PR was merged or deployed without the owner's explicit go; migration 102 from an earlier session remains un-rehearsed on a VACUUM copy, flagged previously and deployed on owner direction.

## 4. Uncommitted changes and live state

- Working tree clean at `1ed3c3dd`; local `main` equals `origin/main`.
- **Live app:** build `70qFikSuW5va544Ob5Mqn` at `/Applications/Vanguard Dashboard.app`, serving :3099. **Live Worker:** `8c83d074-5dfd-48ba-a205-4c1054345790`.
- The empty `workers/cron/.wrangler/` the Worker deploy leaves behind was removed; left in place it makes the next Mac deploy's pre-flight refuse to build.
- **Branch `qa-local-unpushed-2026-11-09b`** holds three unlanded nightly-fixer fixes plus a TODO reconcile: `01aa3759` (release-time popover says its source in words), `57080b5c` (stale-prices drawer leaves out an expired contract), `c0316107` (custom scenario names the leverage factor beside the beta), `c2b78e4c`. A PR is open against `main` for them.
- **`qa-local-unpushed-2026-11-08` is now fully contained in `main`** and can be deleted.
- Other open PRs untouched by this session: #133 (`pm-stop-summarizing`), and the `bogey-scan-tmt-only` branch in review. Worktrees `-menu` (`pm/settings-page-2026-11-09`), `-perf` (`pm/monthly-performance-2026-11-09`) and `-todo-reconcile` exist; the first two are now merged work and are cleanup candidates.
- No locks held. No dev servers started by this session; scratch worktrees used for PR testing were removed.

## 5. Agent identity

Claude Opus 5 (Claude Code), session `https://claude.ai/code/session_019QYEpYHrCJDAsyEhTxM7Ng`.
