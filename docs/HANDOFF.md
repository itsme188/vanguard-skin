# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-19 (full day, three arcs) — QA branch landing; full activity-report ledger reconciliation; deferred-items walkthrough incl. one real engine fix and a source-key collision sweep.

## 1. Goal + exact files changed

Arc 1 — QA landing: merged all four stranded qa-* branches (16 nightly fixes) + 5 review-blocker/hardening commits: `lib/compute/scenarios.ts` (unconditional −100% clamp — shorts included), `app/dashboard/security/[id]/page.tsx` + `lib/compute/lot-coverage.ts` (disclosure renders for zero-lot securities; shorts skipped), `lib/queries/daily-valuations.ts` (30-day floor-participation guard), `app/dashboard/components/SecurityChart.tsx` (visible-bar gating via one `clearChartSeries` helper), `scripts/repair-empty-enrichments.ts` (backup + lock timeout). PR #53 merged; all six qa-* branches deleted.

Arc 2 — reconciliation toolkit (`e18ac37`): `scripts/repair-split-basis-audit.ts` (+44 tests), `scripts/repair-mistyped-option-legs.ts` (+20 tests, later extended with `OPTION_RESYMBOL_TARGETS` in `e577408`), `scripts/import-canonical-files.ts`. Applied to the live DB with backups: ~825-row canonical backfill, 22 dup option rows deleted, 7 mistyped closes retyped (type + source_key together), splits normalized (AAPL 4:1 / AMZN 20:1 / SHOP 10:1 / NFLX 10:1 / ACB / XXII / XLU 2:1).

Arc 3 — walkthrough + collision sweep: `lib/compute/tax-lots.ts` (`1442aad`) — **engine fix**: price-less REDEMPTION rows (bond/bill maturities, principal in `amount`) were skipped by the sell query, so every matured bond's lot sat open; now derived at `|amount|/qty×100` per-100 bond basis. `lib/gmail/process.ts` + migration `083_research_enrich_attempts.sql` (`894e7d5`) — enrichment retry cap (3 strikes → `enrichment_failed` exclusion). Income-history cleanup (withholding/interest/redemption rows in; superseded net/date-typo dividend layer out of DB and canonical files). All 14 monthly/Roth canonical files sign-fixed (113 sweep rows) and re-imported, recovering source-key-collision victims (the pre-2026-05 no-cents key silently dropped same-day same-price split fills) — including the second RKT 2025-12-12 fill (resolved a statement-vs-report contradiction the user adjudicated with statement pages) and 21 Roth monthly deposits (real external flows for XIRR). IBKR's 4:1 re-struck its option symbols (140P→35P, 220C→55C) — buys moved so lots equal holdings.

## 2. Tests / E2E / deploy result

- Full suite at final HEAD: **5,800 passed + 9 todo, 0 failed** (521 files). Targeted re-runs after each live-DB phase; `npx next build` green.
- Convergence proofs: every canonical file (8 year + 14 monthly/Roth) re-imports at **+0 rows**; zero exact-duplicate transaction groups in the Vanguard accounts; split audit re-runs report all "already-normalized"; ledger walks tie holdings for all repaired names; browser E2E confirmed the originally-reported AMZN tax-lot page renders correctly.
- Deploys: **two** `electron:deploy` runs (signed + notarized + relaunched). The second carries all arc-3 runtime changes (tax-lots fix, enrichment cap). Commits after it are scripts/tests/docs only — not packaged into the app bundle, no third deploy needed.

## 3. Open concerns / rejected approaches / user decisions

- **Reviewer attention requested:** (a) the REDEMPTION price derivation leans on the repo-wide per-100 bond price basis — a redemption with a true per-unit price would carry `price_per_share` and skip the derivation, but sanity-check the basis reasoning; (b) the retry-cap exclusion stamps `processed_at` on the third failure (deliberate: leaves the queue permanently, surfaces in the D5 Filtered tab); (c) the `:#N` ordinal dedupe hazard is now documented in CLAUDE.md — a structural fix idea (same-key-different-values conflict warning) is an existing TODO.
- Deliberately NOT done: 3-leg donation journal chains left unlinked (they net correctly; the R4 two-leg artifact-linking pattern would double-subtract — Giving-machinery follow-up filed); 2021 ACATS transfer-ins untranscribed (basis needs the prior brokerage's records — user action); Roth/IBKR full-history reconciliation (needs their statements — future session).
- Six QA product decisions recorded on the ledger for the fixer (5 recommendations accepted; trade-counts decided as unify-to-round-trips).
- **The nightly fixer ran overnight and opened PR #54** (4 HIGH/MEDIUM fixes: plausibility-band single-sourcing, Workspace scope pills, Earnings-tab search, wash-sale disclosure; auto-merge correctly withheld by severity policy) — next session's landing review.

## 4. Uncommitted changes / live-process state (post-session)

- Working tree clean; `main` pushed through this handoff commit. Open PR: **#54** (fixer's, un-reviewed). Fixer worktree `vanguard-skin-qa-fix` still checked out (fixer-owned).
- Live: Vanguard Dashboard running the second (final) deployed build; the 71 reset research articles re-enrich on the next cron pass under the new cap.

## 5. Claude session link

https://claude.ai/code/session_01RGYiaxoyfts3LfaVtsBNQZ
