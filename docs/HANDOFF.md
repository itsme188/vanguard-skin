# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-30 (evening) — three threads: (1) 8 pending QA decisions recorded for the nightly fixer; (2) all 10 deferred landing-review nits closed; (3) the **holdings "latest" sweep** shipped end-to-end (TODO line 77, filed from the PR #58 review).

## 1. Goal + exact files changed

**QA decisions (`825c65a`):** ledger-only (gitignored) + `docs/plans/TODO.md`. All 8 needs-decision findings → `disposition: auto` with DECIDED plans; fixer cap 4/night so expect two nights; the gen-recap SSE and stale-tiles root-cause items will likely arrive as PRs.

**Nits batch (`4df31ad`, 14 files):** `lib/securities/verify-sector-tags.ts` (comment), `lib/compute/cash-deploy.ts` + `app/dashboard/components/analysis/CashDeployCard.tsx` (caption reworded; residualGapPp surfaced as an "After picks" column, PrivateText-masked), `TrustStripDrawer.tsx` headline reword, `app/dashboard/today/WeekAheadView.tsx` (`actualChipClass` gains the `actualsAreImplausible` gate), `lib/queries/holdings.ts` (`getHoldingsByAccount` maturity parity), `lib/research-documents/extract-forwarded.ts` (`finalMessage` classified at the boundary), + test updates (ICU-hardened `formatEnrichedAtET` assertions, fixture sign-convention fix). The NotificationBell nit was already fixed by `8aa9c8e` (stale entry).

**Holdings latest sweep (merge `893f8c0`, 18 commits, 40 files):** every remaining per-account / global `MAX(as_of_date)` holdings read now keys per (account, security) via `latestHoldingsPredicate` — `lib/queries/{today-holdings,portfolio-summary,chat-tools,analysis,options,briefing-symbols,security-detail}.ts`, `lib/chat/{tools,ibkr-context}.ts`, `lib/calendar/briefing.ts` (7 sites), `lib/gmail/process.ts`, `lib/tws/streaming.ts`, `app/api/compute/options-strategies/route.ts`, `app/dashboard/security/[id]/page.tsx`, `scripts/{snapshot-state-to-r2,verify-*,check-held-earnings}.ts`. New: `getStockLegsForStrategyDetection` (shared stock-legs source; strategy detection now partitions legs per account), `getHoldingsForChat` `includeShorts` option (only ibkr-context opts in; fully-gross weights), deterministic streaming priority (`GROUP BY s.id ORDER BY MAX(as_of_date) DESC, symbol`), `tests/repo/no-handrolled-latest-holdings.test.ts` (per-occurrence static guard with adversarial self-tests). Deleted: dead `app/dashboard/components/DataFreshness.tsx`. Also fixed en route: option tombstones surfacing as 0-qty positions (sites had no quantity filter), briefing cross-account net-direction sign-flip (proven old-vs-new in a test), and the pre-existing Related Options case-sensitivity bug (`= 'option'` vs stored `'Option'` — the panel had NEVER rendered; found by E2E). Docs: `lib/db/CLAUDE.md` had been MANDATING per-account keying — inverted; `latest-holdings.ts`/`security-detail.ts` docstrings corrected; DECISIONS.md entry added.

## 2. Tests / E2E / deploy result

- Suite on merged main tree: **7,057 passed / 0 real failures** (599 files; two flakes ruled with evidence: 3 env-key failures in the worktree — no gitignored `.env.local` there, pass with a set-but-invalid key; 1 eslint-subprocess 30s timeout under load — 28/28 in isolation). `tsc` = the 20 known pre-existing; `next build` compiles.
- Preflight audit on a live-DB copy: per-pair keying adds EXACTLY the statement-only positions (bonds + sweep-fund rows at the statement date), drops zero — no reconciler misses.
- Browser E2E on a **secret-less-by-construction** sandbox (`env -i` + every `.env.local` key dynamically pinned to an invalid value; :3095, DB copy, minted session): 4/4 PASS with surface-exact DB oracles (Today IBKR card row count, Accounts totals incl. all Treasury CUSIPs, factor coverage denominator, Related Options post-fix showing only the live leg). Chat context verified server-side (`getPortfolioSummaryForChat` now lists the statement-only Treasuries) with no model call.
- Deploy: `npm run electron:deploy` green — notarization successful, `verify-bundle: OK`, installed + relaunched; `/login` 200 on :3099; launch auto-refresh synced cleanly (the 1 logged error is the known pre-existing plausibility-guard skip). Post-merge `scripts/snapshot-state-to-r2.ts` run refreshed the Worker fallback state to per-pair holdings.

## 3. Open concerns / rejected approaches / decisions

- **Plan review:** 3 Codex rounds (REVISE → REVISE → APPROVE); every finding folded in. Notables: cash-equivalent carry semantics made explicit (reconciler never tombstones sweep funds — Accounts precedent; `getCashEstimates` proven no-double-count with a genuinely discriminating non-cash fixture after a review-caught date-reuse bug), cross-account strategy-leg pairing fixed, E2E sandbox hardened to `env -i` after Codex showed a hand-maintained override list leaks (`CRON_SHARED_SECRET`, R2 creds, marker URL).
- **Parked (ruled, in TODO):** the guard's 250-char ON-extension is adversarially bypassable (no clause-boundary check) but no real site triggers it — fast-follow filed. **Filed HIGH:** reconciler hardening — import is fail-open (reconcile failures only logged) and `recon:` tombstones aren't batch-owned (same-date corrected re-import won't supersede; undo can't remove them).
- **Deliberate user-visible changes:** the next weekly briefing will newly name statement-lag positions (direction-only rendering untouched — verified zero formatter changes); chat context now includes statement-only bonds and (IBKR persona only) shorts; Related Options renders for the first time.
- Rejected: keeping per-account keying anywhere; whole-file guard allowlisting; a global shorts flip for chat (opt-in per consumer instead).

## 4. Uncommitted changes / live-process state (post-deploy)

- None uncommitted. Branch merged `--no-ff` to main (`893f8c0`) and pushed through `5f20300` + this handoff commit; sweep worktree/branch/SDD workspace removed. Remaining worktree: `../vanguard-skin-qa-fix` (nightly fixer's own, untouched).
- Packaged app live on :3099 from the fresh DMG. No dev servers running. Tonight's fixer will start on the 8 decided QA items — the sweep's guard test will police its diffs too.

## 5. Claude session link

https://claude.ai/code/session_012bnTcUm8Tyrd7sB2exLMPS
