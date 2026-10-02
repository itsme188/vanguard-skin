# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Waiting on:** USER: the reconcile HIGH ruling (decision record `reconcile-high-user-row-actuals`): calendar sync's whole-book reconcile can still clear actuals on a pre-print user-confirmed earnings row; pick zero-gap leg / evidence-based / guard-only. USER: regenerate saved trade review 17 (it still grades engine reconcile closes). CLAUDE (next session): the Recompute non-idempotence diagnosis (read-only, VACUUM copy), which still gates the broker roll-up match mode and the opening-lots importer; land the stranded fixer commit `0c157527` (Recent Sales header count, local branch `qa-fix-work-20260924`, never reviewed). Open PRs: none.

**Session date:** 2026-10-01 (Thursday) evening ~21:20 → ~22:10 ET. Focus (user pick, after a full project audit page): push the 11 unpushed fixer commits, land the nine nightly-QA PRs, deploy.

## 1. Goal + exact files changed

**Why:** local `main` was 11 commits ahead of origin (the nightly fixer merges locally and never pushes, so the deploy wrapper's HEAD == origin/main preflight blocked normal deploys), and nine fixer PRs (#87–#95, ~26 findings) had waited up to 8 days, so the nightly sweep kept re-filing breakage that was already fixed.

**Push:** `54782634..86120120` after a privacy scan of messages and added lines (synthetic fixtures only).

**Landing (main `86120120` → `845a1678`, built on `claude/qa-landing-2026-10-01` in `../vanguard-skin-landing`, ff-merged under the integration lock):**
- PRs #88–#95 merged `--no-ff` in order, no conflicts.
- PR #87 landed as sanitized cherry-picks (`c01ea5fe` amended: a `lib/valuation.ts` comment quoted the live position's share count; `f095cd7c`), PR closed unmerged, remote branch deleted. The original commit still exists in the closed PR's ref on GitHub; add it to the TODO privacy purge list if a history purge is ever run.
- Review-fix wave (4 fixers, one owner per file, orchestrator pathspec commits):
  - `f8dbee40` `lib/import/engine.ts`, `app/api/import/route.ts`: unknown-account exclusion is opt-in (`excludeUnknownAccounts`) for the API route only; every other `commitImport` caller (canonical/monthly import scripts) throws before writing, naming each unknown account. Tests: `tests/import/commit-unknown-account.test.ts` (new), `tests/api/import-account-validation.test.ts`.
  - `225b1cc2` `lib/calendar/briefing-html.ts` + Worker mirror `workers/cron/src/html.ts`: two consecutive short table rows no longer merge (1aa14aa7 regression). Both test suites carry the two-short-rows case.
  - `41b83e96` `CommandPalette.tsx`: a queued Enter dies with the palette; clearing the input stops the spinner. JSDoc move in `lib/compute/trade-roundtrips.ts`.
  - `f03a3e8d` `app/dashboard/security/[id]/page.tsx` (Related Options), `lib/queries/options.ts` (`getOptionPositions` + by-underlying + open P&L), `lib/compute/exposure.ts` (both functions, ET not UTC `date('now')`, bond maturity too): expired options drop out via `liveOptionExpirationSql`. XIRR test now reproduces the 16ccb73b defect (old code ~5,189% vs 5.4% on the synthetic fixture).
  - `845a1678` source-pin update for the hub's widened `option-expiry` import.
- Docs: `b104789e`, `b312920f` (TODO follow-ups (a)–(i), the HIGH as `[USER DECISION]`, closed block).

## 2. Tests / E2E / deploy result

| Check | Result |
|---|---|
| Read-only Opus landing reviews (5, against the merged tree) | no REVERT; 1 privacy leak (#87), 1 data-integrity regression (#88 CLI imports), 1 email rendering regression (#91), 1 vacuous-ish test (#94), 1 half fix (#89 expired-option siblings); the rest SHIP |
| `tsc --noEmit` | clean |
| `npm run build` (landing worktree) | ok |
| Sandbox smoke (:3090, secrets pinned empty) | 4/4 |
| Browser pass (8 surfaces: Related Options, ScrollFade, Defense scope + sweep funds, Cmd+K, data-confidence popover, Tax Lots mobile, XIRR plausibility, console) | 8/8 PASS |
| `verify.sh full --base main` (landing, then main checkout) | 10,345 / 10,346 passed, 0 failed |
| Deploy (`npm run deploy`) | ok — build `MAvVP2tJaoKOOlkfp6jmn` at `b312920f`, codesign + listener + login probe verified |

## 3. Bookkeeping

- QA ledger: 26 `pr-open` rows flipped to `merged` with main SHAs (backup `qa/findings/ledger.json.bak-2026-10-01-landed`). The reconcile HIGH stays open.
- Register: `qa-landing-2026-10-01` landed; `qa-deep-sweep-2026-09-22/23`, `qa-fix-findings-2026-10-01` closed as superseded; decision `qa-deep-sweep-2026-09-24` resolved; new decision `reconcile-high-user-row-actuals`.
- Branches: landing worktree removed; 15 local `qa-*` branches and 9 remote fixer branches deleted. Kept: local `qa-fix-work-20260924` (stranded `0c157527`); remote `qa-auto-fixes-2026-09-16` and `qa-deep-fixes-2026-09-17` (older, not audited tonight).

## 4. Open questions for review

- Workflow: the nightly fixer still merges locally without pushing and deploys around the wrapper. The audit page recommends a PR cap (no new PRs above 3 open) and push-after-merge; not implemented tonight (needs the user's go-ahead).
