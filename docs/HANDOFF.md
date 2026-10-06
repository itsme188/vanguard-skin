# Session Handoff — for Codex review

**Waiting on:** USER: (1) the two September 2026 Vanguard statements (the IBKR one has arrived; decision record `september-2026-statements`), then CLAUDE runs `import-monthly-statements` and the rehearsed tax-lot recompute; (2) a request to GitHub Support to remove cached commits and pull-request refs left by the 2026-10-06 history rewrite (decision record `github-support-history-purge`); (3) whether to review and land PR #99, last night's fixer run (decision record `pr-99-review`). CODEX: an independent review of the session's range on `main` is welcome, especially the IBKR parser currency blocks, the recap-modal streaming and the display-only earnings time. CLAUDE: nothing until the statements arrive.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session dates:** 2026-10-05 evening → 2026-10-06 morning. Interactive at both ends; unattended overnight on the user's instruction, with authority to merge, push and deploy reviewed work and no authority to change live data.

## 1. Goal + exact files changed

**Goal:** clear as much of `docs/plans/TODO.md` as is safe, land the stranded nightly-QA PRs, then act on the user's morning instructions (Worker deploy, history purge, branch cleanup, four second-round rulings).

Files, by concern (about 360 files; full list in `git log --stat`):

- **Valuation:** `lib/compute/daily-valuation.ts` (cash before the first resolvable anchor is back-stepped through recorded external flows, with no lower bound).
- **Risk and options:** `app/api/compute/{position-risk,options-greeks,reconciliation}/route.ts`, `lib/compute/{risk,options-greeks,options-strategy,option-expiry}.ts`, `app/dashboard/components/OptionsStrategies.tsx`.
- **Import (protected area, limited to what TODO items and reviews asked):** `lib/import/parsers/ibkr-activity.ts` (per-currency conversion for Dividends, Fees, Deposits & Withdrawals; mixed-sign blocks skipped; blank trade price or fee becomes undefined with a warning), `lib/import/engine.ts`, `app/api/import/route.ts`, `lib/import/validate.ts` and two parsers (from PRs #96–#97), `app/dashboard/components/{ImportFlow,CanonicalCsvGuide}.tsx`.
- **Tax lots and reconciliation:** `lib/compute/{tax-lots,tax-convention,synthetic-close-guards,trade-roundtrips}.ts`, `lib/queries/{options,pending-statement,integrity-checks}.ts`, `scripts/reconcile-tax-report-vs-broker.ts` (explicit roll-up mode), `scripts/repair-split-basis-audit.ts` (comment only).
- **Earnings and calendar:** `lib/digest/send-earnings-email.ts`, `lib/earnings/{eps-delta,debrief,debrief-send,reporter-recap,wrap-send,recap-nudge-gate,cloud-outbox,prepare-armed-event,actuals,wire-times,recap-modal-generate}.ts`, `lib/calendar/{cloud-reconcile,finnhub,macro-events,sync,release-times,display-earnings-time}.ts`, `lib/queries/{calendar,briefing-symbols}.ts`, `lib/mutations/calendar.ts`, `app/api/calendar/events/route.ts`, `app/api/earnings/{recap-modal,release-time,email-content}/route.ts`, `app/dashboard/today/{EarningsHub,EarningsHubAddForm,EarningsRowChips,EarningsDateChip,WeekAheadView,page}.tsx`, `app/dashboard/components/TodayReleases.tsx`; Worker mirrors `workers/cron/src/{ai,armed-events,fallback-digest,fallback-earnings,fallback-evening,newsletter-fetch,todays-reporters}.ts`.
- **AI gateway:** `lib/ai/{generate,classify-anthropic-error}.ts`, `lib/compute/{classify-batch,classify-factors,classify-securities}.ts`.
- **Queries:** `lib/queries/{analysis,chat-tools,data-confidence,data-health,today-holdings,level-performance,portfolio-summary,securities,transcripts}.ts`, `lib/trade-review/{market-context,generate}.ts`.
- **UI honesty, dates, privacy:** `lib/ui/mutation-result.ts` (new) and about twenty components under `app/dashboard/components/` that now use it; `lib/privacy/components.tsx` (`QuantityUnit`, `PrivateNumberInput`), `lib/format/quantity-unit.ts`; Eastern-date fixes in four components and seven `lib/` files; ScrollFade on the remaining wide tables.
- **Print-watch:** `lib/print-watch/{pdf,read,roads}.ts`, `app/api/print-watch/{drop,go,sources}/route.ts`.
- **Auth and Plaid minors:** `lib/cron/wrappers.ts`, `lib/auth/password-policy.ts` (new), `app/api/auth/login/route.ts`, `lib/plaid/client.ts`.
- **Tooling:** `scripts/coord/{coord.py,deploy.sh}`, `scripts/qa/reconcile-ledger-fix-status.py` (new).
- **Tests:** about ninety test files added or changed, including `tests/helpers/source-anchor.ts` and six new repo guards.
- **Docs:** `CLAUDE.md`, `docs/DECISIONS.md` (three entries), `docs/plans/TODO.md`, `docs/reference/coordination.md`.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Full suite at session end | 11,021 passed, 0 failed (943 files); 10,489 at session start |
| Type-check | clean before every commit to `main`; Worker type-check clean and its own 592 tests passing before its deploy |
| Independent review | three Opus reviews of PRs #96–#98; three Codex rounds and three Opus rounds on the backlog waves; every Important finding fixed before landing |
| Browser checks (sandbox, database copy) | smoke 4/4 on each of five runs; six browser passes; misses were fixed and re-checked, except two items that could not be reached (no earnings rows this week) |
| Real-data checks (copies only) | September IBKR import rehearsal: clean; old-versus-new valuation engine on two copies: identical output |
| App deploys | five through `npm run deploy`. One attempt failed at the build step (font download) and left the app down for about fifteen minutes until the retry; the wrapper was then changed to build before it quits the app, and the last deploy exercised the new order successfully |
| Final live build | built from the commit before this handoff; build id recorded in the register checkpoint for task `rulings-2026-10-06` |
| Worker deploy | done on the user's instruction (2026-10-06) |

## 3. Open concerns, rejected approaches, user decisions

- **User rulings (all in `docs/DECISIONS.md`):** eleven QA rulings on 2026-10-05; four second-round rulings on 2026-10-06 (earnings time display only; pre-first-anchor cash back-stepped; same-date split guard unchanged; print-watch early-open stamp unchanged).
- **Rejected in review:** storing a history-derived time for slot-less vendor earnings rows (it would move the accept, enrichment and recap gates); one `force` flag answering two different warnings; totals-only matching in the reconciliation roll-up.
- **Measured no-op:** the pre-first-anchor cash rule changes nothing on the current book, because no account has a daily row dated before its first statement. Its behaviour on real data is covered by unit tests only.
- **Import rehearsal observations for the real run:** the recompute, not the import, is the large change; a handful of symbols show a realized result that differs from the statement's own summary (not root-caused); foreign-currency commissions are stored in native currency.
- **History purge limits:** the rewritten branches are on GitHub, but GitHub still serves the old commits by id and through pull-request refs until its support team removes them. Other files with statement-looking rows (listed in the TODO entry) were not synthesized and so were not part of the purge. A backup bundle of the old history is kept locally outside the repository.
- **Not verified in a browser:** the recap modal against a real generation (the sandbox has no AI key) and the fix-date popover bounds.
- **Follow-ups filed in `docs/plans/TODO.md`** under "Overnight 2026-10-05 — open rulings and follow-ups", including: Mac and Worker compute different no-marker digest fallback windows; the week-ahead page does one history lookup per slot-less card; the security hub's upcoming-earnings row shows no time; three exported functions with no production caller await a deletion decision.

## 4. Uncommitted changes and live-process state (after the final deploy)

Main = origin/main at the handoff commit; working tree clean. Worktrees: only the nightly fixer's `../vanguard-skin-qa-fix` (detached, repointed after the history rewrite). Open PR: #99 (nightly fixer 2026-10-06, unreviewed by this session). Remote branches: `main` and the PR #99 branch only. No dev servers or sandboxes running; no locks held. The live app is up on the final build. The live database was read (read-only copies) and never written by this session.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_013LutcaXwZipndHW2VcrbmP
