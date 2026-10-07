# Session Handoff — for Codex review

**Waiting on:** USER: (1) all three September 2026 statements are now in the statements folder (the last arrived on the afternoon of 2026-10-07), so the import, then the rehearsed tax-lot recompute and the broker stamp, is the next session's focus (decision record `september-2026-statements`); (2) four repair scripts to run, each as a dry run on a database copy first: transcript sections, donated-lot basis, re-queue failed enrichment, option sectors (commands in `docs/plans/TODO.md`); (3) confirm or reverse the controller and builder rulings listed in `docs/DECISIONS.md` under 2026-10-06 and 2026-10-07; (4) pick one of the two options in the TODO for the Worker gap on replaced earnings entries; (5) the request to GitHub Support to remove cached commits left by the 2026-10-06 history rewrite (decision record `github-support-history-purge`). CODEX: nothing assigned; a review of this span's range on `main` is welcome, especially the items in section 3. CLAUDE: the September import once the user starts it.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session dates:** 2026-10-06 afternoon and evening → 2026-10-07. Interactive throughout; the user ruled on findings in several sittings and approved each landing and deploy.

## 1. Goal + exact files changed

**Goal:** land PR #99, get the user's rulings on the open QA (quality assurance) findings, then build what was ruled: scenario option repricing, PR #100, and two waves of ruled builds.

**What landed, in order** (range `72d3b2be^..e418b329`, 221 files; full list in `git log --stat`):

1. **PR #99** (nightly fixer, four fixes) with three review fixes.
2. **Rulings:** more than 30 QA findings ruled in six batches, all recorded in `docs/DECISIONS.md`; the last high-severity finding was closed.
3. **Scenario option repricing:** spec, plan, a Codex plan review, build, whole-branch review, deploy.
4. **PR #100** (nightly fixer; it built three of the ruled highs) with one review fix to the equity curve's start reference.
5. **First wave of ruled builds:** six units. Four by Claude builders (rate leg on bonds and bond funds, holdings footers and the broker cash line, calendar refresh honesty, two sync inputs). Two by Codex (transcripts by fiscal quarter, the Tax Lots page); the transcript unit needed three builds.
6. **Second wave:** six units. Giving confirm plus implausible-basis flag, level reactivate guard, newsletter enrichment retry rules, option sector inheritance, recap on a replaced earnings entry, import return check. Four by Claude builders, two by Codex with Claude fix rounds.

**Method:** each unit was built by a subagent or by Codex (gpt-5.5 through `codex exec`, which cannot commit, so the controller committed by pathspec). An independent agent that ran the code reviewed it; findings were fixed and re-reviewed. Then whole-branch verification, a fast-forward merge under the `integration` lock, and one Mac deploy per wave through `npm run deploy`.

Files, by concern:

- **Scenarios:** `lib/compute/{option-reprice,bond-duration,scenarios,scenario-recipes,option-elasticity}.ts`, `lib/bonds.ts`, `app/api/compute/scenarios/route.ts`, `app/dashboard/components/ScenarioModeling.tsx`.
- **Sync inputs:** `lib/tws/{option-underlyings,bond-coupon,contracts,snapshot,auto-refresh}.ts`, `lib/ibkr/refresh.ts`.
- **Accounts and analysis:** `lib/chart/equity-curve-anchor.ts`, `lib/queries/account-cash-line.ts`, `app/dashboard/components/{EquityCurveChart,HoldingsTable,AllHoldingsTable,AccountDetail,RiskMetrics,FactorAnalysis}.tsx`.
- **Calendar and earnings email:** `lib/calendar/{sync,macro-events,reconcile-earnings-dates,pre-release-actual}.ts`, `lib/earnings/{send-service,manual-twin-email,debrief,debrief-send,wrap}.ts`, `lib/digest/{send-earnings-email,send-briefing}.ts`, `lib/queries/{earnings-emails,manual-twin-email}.ts`, the Today hub components, `SupersededEmailNote.tsx`; Worker mirrors `workers/cron/src/{manual-twin-email,fallback-earnings}.ts`.
- **Transcripts:** `lib/transcripts/{fetch,alpha-vantage,same-day}.ts`, `lib/mutations/transcripts.ts`, `app/api/transcripts/route.ts`.
- **Tax lots and Giving:** `lib/queries/{tax-lots,giving-view}.ts`, `lib/compute/{donation-recompute,donation-recompute-contract}.ts`, four routes under `app/api/donations/[id]/`, `app/dashboard/components/giving/*`, `TaxLotTables.tsx`.
- **Levels:** `lib/alerts/{arm-guard,approve}.ts`, `lib/mutations/security-levels.ts`, `lib/levels/{action-visibility,last-fired-date}.ts`, `app/api/levels/route.ts`, `LevelsPanel.tsx`.
- **Newsletter enrichment:** `lib/gmail/{process,enrichment-failure}.ts`, `lib/mutations/research-articles.ts`, the retry-enrichment and unfilter routes, `ResearchFeedsView.tsx`.
- **Classification:** `lib/securities/{classify-option-sectors,normalize-fund-category}.ts`.
- **Import (protected area, validation only, user-approved):** `lib/import/validate.ts`.
- **Chat (PR #99):** `app/api/chat/route.ts`, `ChatInterface.tsx`, `lib/chat/tools.ts`, `lib/queries/{chat-tools,market-snapshot}.ts`.
- **Scripts (new, all dry-run by default):** `scripts/repair-{transcript-sections,donated-lot-basis,requeue-failed-enrichment,option-sectors}.ts`, `scripts/audit-transcript-keys.ts`, `scripts/compare-scenario-option-repricing.ts`.
- **Tests:** about one hundred test files added or changed. **Docs:** `CLAUDE.md` (two invariants dated 2026-10-07), `docs/DECISIONS.md`, `docs/plans/TODO.md`, reference docs.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Full suite at handoff | 12,018 passed, 0 failed (999 files); 11,021 at the previous handoff |
| Independent review | one read-only review each for PRs #99 and #100; a Codex plan review and a whole-branch review for scenario repricing; a build review and a re-review for every wave unit |
| Browser checks (sandbox, database copy) | smoke 4/4 on the PR landings. Second wave: 5 of 6 checks passed outright; the Retry-enrichment click was confirmed by calling the route on the sandbox after a restart |
| App deploys | through `npm run deploy` only, one per wave. One attempt stopped at pre-flight on an empty leftover `workers/cron/.wrangler` folder; nothing was built; the folder was removed and the deploy re-run |
| Final live build | built from `e418b329`; build id `e7BkpiypFhz2b9qZGJt0h` |
| Worker deploy | deployed on 2026-10-07 after the first wave. The second wave did not change the Worker |
| QA ledger | 457 open (0 high, 153 medium, 304 low); 100 need a decision; 20 ruled and awaiting a build |

## 3. Open concerns, rejected approaches, user decisions

**What Codex should scrutinize:**

- **Enrichment-failure rules** in `lib/gmail/process.ts` (the four counting rules on `processUnprocessedArticles`) and the classifier `lib/gmail/enrichment-failure.ts`. Out-of-credit detection partly relies on message text; a reworded provider message would be counted again.
- **Donation "rehearsal":** an unacknowledged edit runs the real mutation inside a transaction that always rolls back (`lib/compute/donation-recompute.ts`). It is safe only while the mutation is synchronous; an async mutation would escape the rollback.
- **Shared level arm guard** `lib/alerts/arm-guard.ts`, and the trial write in `reactivateLevel` (`lib/mutations/security-levels.ts`).
- **Replaced-entry re-check** inside `claimEarningsEmailSlot` and again after composing, in `lib/earnings/send-service.ts`. The Worker side is not fixed: it reads the replaced flag from the nightly snapshot and can still send for an entry replaced later that day.
- **Option sector resync** in `lib/securities/classify-option-sectors.ts` (refreshed on every classify run, no AI call).
- **Transcripts keyed by fiscal quarter** (`lib/transcripts/fetch.ts`): a wrong filing inside the four-day window is stored and never replaced.
- **First wave:** bond duration derived from maturity (`lib/compute/bond-duration.ts`) and option-underlying pricing in the sync (`lib/tws/option-underlyings.ts`).
- **`lib/tws/bond-coupon.ts` is intentionally unwired.** A repo test guards that; the name parser is the only working coupon source.

**User decisions and rejected approaches:** every ruling, with the alternatives the user turned down, is in `docs/DECISIONS.md` (entries dated 2026-10-06 and 2026-10-07). The entries headed "Controller rulings (for the owner to confirm or reverse)" were made by builders or the controller, not by the user. Owner questions and to-dos are in the matching `docs/plans/TODO.md` entries.

**Held builds:** the IBKR monthly-return scale (code and repair must land in one step, with the owner present) and the missing-sales hunt for the lot overhang (done with the September import).

**Operational notes:**

- The Mac disk reached 99% full and crashed a sandbox dev-server compile (ENOSPC, "no space left on device") during the second wave's browser pass. Database copies of finished sandboxes were deleted afterwards; about 14 GB is free now.
- The Giving unit's early commits carried real dates in a test fixture. They were squashed before the push, so pushed history is clean.
- TODO item (p) under the second wave still says the wave was not browser-checked. It predates the browser pass above and should be reconciled.

## 4. Uncommitted changes and live-process state (after the final deploy)

Main = origin/main at `e418b329`, plus this handoff commit; working tree clean. No open pull requests. No locks held. No dev servers or sandboxes running. The live app is up on the final build. The live database was not written by any repair script in this span; the four repair scripts wait for the user.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01ABdui9AGJG1AGrYs8XKHnr
