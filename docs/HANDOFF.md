# Session Handoff — for Codex review

**Waiting on:** USER (each is also a `decision` record in the coordination register): `giving-mark-lots-verified` (mark the two flagged donated lots verified on the Giving page, with the source noted); `broker-realized-gain-reports` (realized-gain reports for both brokers, per tax year, so the reconciliation config can be rebuilt; the broker stamp and the data-confidence cap stay blocked until then); `tax-preparer-short-term-gift` (one question for the tax preparer about a short-term gifted lot); `confirm-gift-month-convention` (confirm how the gift ruling is stored, and whether to restate June); `run-four-repair-scripts` (now three, each as a dry run on a database copy first: transcript sections, re-queue failed enrichment, option sectors; the donated-lot basis repair is NOT needed); `worker-replaced-entry-recap-gap` (pick one of the two options in the TODO); `confirm-builder-rulings-2026-10-07` (confirm or reverse the controller and builder rulings in `docs/DECISIONS.md`); `github-support-history-purge` (ask GitHub Support to remove cached commits left by the 2026-10-06 history rewrite). CODEX: nothing assigned; a review of this span's range on `main` is welcome, especially the items in section 3. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session dates:** 2026-10-06 afternoon → 2026-10-07 evening. Interactive throughout; the user ruled on findings in several sittings and approved each landing and deploy.

## 1. Goal + exact files changed

**Goal:** land PR #99, get the user's rulings on the open QA (quality assurance) findings, then build what was ruled: scenario option repricing, PR #100, two waves of ruled builds; then import the September statements and build the "basis verified" marker for donated lots.

**Build waves, in order** (range `72d3b2be^..e418b329`, 221 files; full list in `git log --stat`):

1. **PR #99** (nightly fixer, four fixes) with three review fixes.
2. **Rulings:** more than 30 QA findings ruled in six batches (`docs/DECISIONS.md`); the last high-severity finding was closed.
3. **Scenario option repricing:** spec, plan, a Codex plan review, build, whole-branch review, deploy.
4. **PR #100** (nightly fixer; it built three of the ruled highs) with one review fix to the equity curve's start reference.
5. **First wave of ruled builds:** six units, four by Claude builders and two by Codex (rate leg on bonds and bond funds, holdings footers and the broker cash line, calendar refresh honesty, two sync inputs, transcripts by fiscal quarter, the Tax Lots page).
6. **Second wave:** six units, four by Claude builders and two by Codex with Claude fix rounds (Giving confirm plus implausible-basis flag, level reactivate guard, newsletter enrichment retry rules, option sector inheritance, recap on a replaced earnings entry, import return check).

**Method:** each unit was built by a subagent or by Codex (through `codex exec`, which cannot commit, so the controller committed by pathspec). An independent agent that ran the code reviewed it; findings were fixed and re-reviewed. Then whole-branch verification, a fast-forward merge under the `integration` lock, and one Mac deploy per landing through `npm run deploy`.

Files, by concern:

- **Scenarios:** `lib/compute/{option-reprice,bond-duration,scenarios,scenario-recipes,option-elasticity}.ts`, `lib/bonds.ts`, `app/api/compute/scenarios/route.ts`, `app/dashboard/components/ScenarioModeling.tsx`.
- **Sync inputs:** `lib/tws/{option-underlyings,bond-coupon,contracts,snapshot,auto-refresh}.ts`, `lib/ibkr/refresh.ts`.
- **Accounts and analysis:** `lib/chart/equity-curve-anchor.ts`, `lib/queries/account-cash-line.ts`, `app/dashboard/components/{EquityCurveChart,HoldingsTable,AllHoldingsTable,AccountDetail,RiskMetrics,FactorAnalysis}.tsx`.
- **Calendar and earnings email:** `lib/calendar/{sync,macro-events,reconcile-earnings-dates,pre-release-actual}.ts`, `lib/earnings/{send-service,manual-twin-email,debrief,debrief-send,wrap}.ts`, `lib/digest/{send-earnings-email,send-briefing}.ts`, `lib/queries/{earnings-emails,manual-twin-email}.ts`, the Today hub components, `SupersededEmailNote.tsx`; Worker mirrors `workers/cron/src/{manual-twin-email,fallback-earnings}.ts`.
- **Transcripts:** `lib/transcripts/{fetch,alpha-vantage,same-day}.ts`, `lib/mutations/transcripts.ts`, `app/api/transcripts/route.ts`.
- **Tax lots and Giving:** `lib/queries/{tax-lots,giving-view}.ts`, `lib/compute/{donation-recompute,donation-recompute-contract}.ts`, four routes under `app/api/donations/[id]/`, `app/dashboard/components/giving/*`, `TaxLotTables.tsx`.
- **Levels:** `lib/alerts/{arm-guard,approve}.ts`, `lib/mutations/security-levels.ts`, `lib/levels/{action-visibility,last-fired-date}.ts`, `app/api/levels/route.ts`, `LevelsPanel.tsx`.
- **Newsletter enrichment:** `lib/gmail/{process,enrichment-failure}.ts`, `lib/mutations/research-articles.ts`, the retry-enrichment and unfilter routes, `ResearchFeedsView.tsx`. **Classification:** `lib/securities/{classify-option-sectors,normalize-fund-category}.ts`.
- **Import (protected area, validation only, user-approved):** `lib/import/validate.ts`. **Chat (PR #99):** `app/api/chat/route.ts`, `ChatInterface.tsx`, `lib/chat/tools.ts`, `lib/queries/{chat-tools,market-snapshot}.ts`.
- **Scripts (new, all dry-run by default):** `scripts/repair-{transcript-sections,donated-lot-basis,requeue-failed-enrichment,option-sectors}.ts`, `scripts/audit-transcript-keys.ts`, `scripts/compare-scenario-option-repricing.ts`.
- **Tests:** about one hundred test files added or changed. **Docs:** `CLAUDE.md` (two invariants dated 2026-10-07), `docs/DECISIONS.md`, `docs/plans/TODO.md`, reference docs.

### 1b. September 2026 statement import (2026-10-07 afternoon)

**No code changed in this part of the session. Data and docs only** (commits `22274360`, `b24eb521`).

- **Imported:** all three accounts through the app's import API, after a database backup. Batches 220 (IBKR), 221–224 (Roth), 225–228 (Taxable), 229 undone and replaced by 232 (Taxable monthly snapshot), 230 (the donor-advised fund (DAF) contributions file), 231 (an empty batch from a no-op re-import).
- **Result:** every account's month-end value equals its statement (zero delta). Every gate passed to the penny except the Taxable cost-basis spot check, which could not run because that statement printed no cost basis; the basis was filled from the broker's lot report under a strict rule. Estimated closes fell from 11 to 2.
- **Live-database writes through the app's API:** the import commits above; one two-step batch undo (229); four donation links (each stamps the DAF value on the gift's OUT leg and runs the whole-ledger recompute, acknowledged after the 409); lot assignments for the September gifts, and for two earlier gifts of one stock whose lots were swapped.
- **Live-database write outside the API:** one. A single same-day live-feed holdings row, for a position fully sold on the last trading day, was set to zero and valuations were recomputed (the runbook's last-trading-day fix, owner-approved). The total did not move; the cash/holdings split changed by exactly that position's value.
- **Rehearsed on a copy only, nothing live:** the IBKR direction backfill (nothing to do), the script-driven full tax-lot recompute (no realized gain changed in any tax year; second run identical), and the broker reconciliation (does not pass with the existing config).
- **Docs changed:** `docs/DECISIONS.md`, `docs/plans/TODO.md`, `docs/reference/conventions-detail.md`, `.claude/skills/import-monthly-statements/SKILL.md` (new Phase 6 for gifts; the Phase 4 sweep note corrected), this file. Real figures are only in the gate reports in the owner's statements folder (`canonical/2026-09/GATES-202609-*.md`) and in private notes under gitignored `docs/private/`.

### 1c. "Basis verified" marker for donated lots (2026-10-07 evening)

**What settled the question first:** the second wave flagged donated lots whose basis is under 1% of the gift's value. The owner then supplied the fund's final partnership tax form. Its property-distribution line equals the stored lots' total and its tax-basis capital account is consistent with it. So the small basis is correct and no repair applies. The flag was right to ask; there was no way to record the answer. This feature adds one.

**What was built** (range `b24eb521..1888e23c`: feature `052fa88c`, fixes `3c03ce93`, `d09b345b`, `6ece4bb4`, docs `1888e23c`):

- Migration 095 adds one table, `lot_basis_verifications`, and touches no existing table.
- One reader, `donatedLotBasisState` (`lib/queries/giving-view.ts`), decides `plausible` / `implausible` / `verified` / `verified-stale`. The row chip, the left-out flag and the year total all come from it.
- The marker snapshots the lot's cost basis and quantity acquired. It goes stale when either changes.
- Marking changes no tax input and triggers no recompute, so its routes need no ledger-recompute acknowledgement. Marking is refused while a recompute is pending.

Exact files:

- **New code:** `lib/db/migrations/095_lot_basis_verifications.sql`, `lib/mutations/lot-basis-verifications.ts`, `app/api/donations/lots/[acquisitionTransactionId]/basis-verified/route.ts`, `app/dashboard/components/giving/{LotBasisControl.tsx,lot-basis-actions.ts}`.
- **Changed code:** `lib/queries/giving-view.ts`, `lib/mutations/donation-links.ts`, `app/dashboard/components/giving/GivingYearSection.tsx`.
- **New tests:** `tests/api/lot-basis-verified-route.test.ts`, `tests/dashboard/giving-lot-basis-control.test.tsx`, `tests/db/migration-095-lot-basis-verifications.test.ts`, `tests/helpers/giving-basis-fixture.ts`, `tests/queries/giving-basis-verified.test.ts`. **Changed test:** `tests/dashboard/giving-ledger-recompute-flow.test.tsx`.
- **Docs:** `CLAUDE.md`, `docs/DECISIONS.md`, `docs/plans/TODO.md`, `docs/reference/{api-patterns,conventions-detail}.md`.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Full suite on `main` after the last landing | 12,106 passed, 0 failed (`bash scripts/verify.sh full --base main`, evidence recorded); 11,021 at the previous handoff |
| Independent review, build waves | one read-only review each for PRs #99 and #100; a Codex plan review and a whole-branch review for scenario repricing; a build review and a re-review for every wave unit |
| Independent review, the marker | a review that ran the code: first verdict not ready on one finding (section 3), fixed, re-review ready |
| Browser checks (sandbox, database copy) | smoke 4/4 on the PR landings; second wave 5 of 6 outright, the sixth confirmed by calling the route. The marker: two passes, all checks passed on the second; production build and smoke passed |
| Mac deploy | through `npm run deploy` only, one per landing. Final: deployed from `1888e23c`, build id `JSL1n8PKjRgOz20R2nf-Z`, app relaunched |
| Migration 095 | applied on the live database at startup; a backup was taken first |
| Worker deploy | deployed on the morning of 2026-10-07 after the first wave; not changed since |
| September import | no test run; every statement gate is in section 1b |
| Load-sensitive tests | three timing-sensitive tests (a lint-run boundary test and two verification-subprocess tests) time out when the suite runs alongside a dev server or other heavy load. Each passes alone |

## 3. Open concerns, rejected approaches, user decisions

**What Codex should scrutinize:**

- **Enrichment-failure rules** in `lib/gmail/process.ts` (the four counting rules on `processUnprocessedArticles`) and the classifier `lib/gmail/enrichment-failure.ts`. Out-of-credit detection partly relies on message text; a reworded provider message would be counted again.
- **Donation "rehearsal":** an unacknowledged edit runs the real mutation inside a transaction that always rolls back (`lib/compute/donation-recompute.ts`). It is safe only while the mutation is synchronous; an async mutation would escape the rollback.
- **Shared level arm guard** `lib/alerts/arm-guard.ts`, and the trial write in `reactivateLevel` (`lib/mutations/security-levels.ts`).
- **Replaced-entry re-check** inside `claimEarningsEmailSlot` and again after composing, in `lib/earnings/send-service.ts`. The Worker side is not fixed: it reads the replaced flag from the nightly snapshot and can still send for an entry replaced later that day.
- **Option sector resync** in `lib/securities/classify-option-sectors.ts` (refreshed on every classify run, no AI call).
- **Transcripts keyed by fiscal quarter** (`lib/transcripts/fetch.ts`): a wrong filing inside the four-day window is stored and never replaced.
- **First wave:** bond duration derived from maturity (`lib/compute/bond-duration.ts`) and option-underlying pricing in the sync (`lib/tws/option-underlyings.ts`). `lib/tws/bond-coupon.ts` is intentionally unwired; a repo test guards that.
- **Gift months: cash-only flow field plus an adjusted return (September import).** The owner ruled that gifted shares are an external outflow. The controller stored that as: `deposits_withdrawals` cash-only, `twr` by Modified Dietz with each gift as a dated outflow, `investment_gain` with gifts excluded. So `total − starting − deposits_withdrawals` no longer equals `investment_gain` in a gift month. Check every reader that rebuilds one of these fields from the others, and the statement-return audit's treatment of such a month. June 2026 is still on the old convention.
- **Open lots against the broker's lot report (Taxable, first comparison).** About seven in ten positions match on quantity and cost, about two in ten on quantity only, and a few differ in quantity or exist on one side only. Causes found: early lots missing from the ledger, exercise rows with no price (premium booked as an option loss instead of stock basis), one exercise typed as a corporate action, stray rows from old ticker changes, lot-relief differences, accrued interest in Treasury basis. Each is a TODO follow-up; the exercise handling is the one to look at in code first.
- **The marker's staleness rule** (`donatedLotBasisState` and `lib/mutations/lot-basis-verifications.ts`). The first build snapshotted the purchase row's amount, not the lot's basis, so a real basis change could leave a marker in place. The controller's brief caused that, not the builder; it is fixed. Known behaviour to weigh: a split makes a marker stale by design (quantity acquired changes); undo-with-recovery does not restore a marker; staleness appears at the recompute, not at the row edit.
- **Found, not fixed:** after a split dated later than a gift, the gift row's per-share basis uses post-split quantity (existing behaviour, found in the marker review).

**User decisions and rejected approaches:** every ruling, with the alternatives the user turned down, is in `docs/DECISIONS.md` (entries dated 2026-10-06 and 2026-10-07). The entries headed "Controller rulings (for the owner to confirm or reverse)" were made by builders or the controller, not by the user. Owner questions and to-dos are in the matching `docs/plans/TODO.md` entries. **Disproved reading:** the first reading of the donated-lot question, that the stored basis might be wrong, was disproved by the tax form; `scripts/repair-donated-lot-basis.ts` stays in the repo unused and its draft config is not to be applied.

**Held builds:** the IBKR monthly-return scale (code and repair must land in one step, with the owner present) and the missing-sales hunt for the lot overhang. Both were held for the September import, so both are now unblocked; neither is built. The script-driven live tax-lot recompute was rehearsed on a copy only (TODO f14); the app's own whole-ledger recompute ran live with each donation link.

**Operational notes:**

- The Giving unit's early commits carried real dates in a test fixture. They were squashed before the push, so pushed history is clean.
- Landing the marker ran `git worktree remove --force`, which discarded the unit's private brief and report. Archive private reports before removing a worktree.

## 4. Uncommitted changes and live-process state (after the final deploy)

Nothing uncommitted: `main` equals `origin/main` (`1888e23c` plus this handoff commit) and the working tree is clean. No feature branches, no open pull requests, no locks held. One extra worktree exists, the nightly fixer's (detached); it was left alone. No dev servers or sandboxes are running. The live app runs build `JSL1n8PKjRgOz20R2nf-Z` with migration 095 applied. The live database carries the September import and the writes listed in 1b; no repair script wrote to it in this span. Two database backups from today are in the gitignored `data/` folder (pre-import and pre-migration). Private working notes are in gitignored `docs/private/`: `wave-2026-10-07`, `wave2-2026-10-07`, `september-2026-import`.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01ABdui9AGJG1AGrYs8XKHnr
