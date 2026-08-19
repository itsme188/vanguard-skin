# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-19 — QA branch landing (16 nightly fixes + 5 review-blocker/hardening fixes, PR #53 merged) + full activity-report ledger reconciliation (four transcription disease classes found and repaired, end-to-end verified).

## 1. Goal + exact files changed

Goals picked at session start: (a) review + land the six stranded qa-* branches; (b) record the 6 pending QA decisions; (c) execute the split-basis audit + repair — which grew into a full 2019-2026 ledger reconciliation against the broker's activity report.

- Merges `48810ed`/`d0ff306`/prior — all four QA branches (16 fixes). One conflict in `lib/compute/risk.ts` resolved by composing the coverage-start floor with the asOfDate end cap (they are orthogonal).
- `0427fd1` `lib/compute/scenarios.ts` — the −100% clamp is now unconditional: a short's direction is carried by its negative market_value; the long-only clamp let shorts book more than notional on extreme rate shocks (review-found; a new test had pinned the wrong behavior and was corrected).
- `6c38a08` `app/dashboard/security/[id]/page.tsx` + `lib/compute/lot-coverage.ts` — lot-coverage disclosure now renders for zero-lot securities (19 of 52 gapped names were silent) and skips short legs (unsigned coverage produced a false sentence).
- `acec831` `lib/queries/daily-valuations.ts` — `commonCoverageStart` requires ≥30 distinct valuation dates before an account moves the scope-invariant floor (new-account collapse guard).
- `3ab72db` `app/dashboard/components/SecurityChart.tsx` — all five range entrances gate on visible bars via one `clearChartSeries` helper (two entrances still painted full-history indicator lines over the empty chart).
- `27d0856` `scripts/repair-empty-enrichments.ts` — VACUUM INTO backup + 60s lock timeout (repair-script conventions).
- `e18ac37` — reconciliation toolkit: `scripts/repair-split-basis-audit.ts` (generalized guarded split normalizer + sibling sweep, 44 tests), `scripts/repair-mistyped-option-legs.ts` (dup deletion + retype-with-key-rewrite + option-split normalization, 16 tests), `scripts/import-canonical-files.ts` (incremental importer).
- `13b4744`+follow-up `docs/plans/TODO.md` — splits item closed as the full backfill; residual triage item filed.

## 2. Tests / E2E / deploy result

- Full pinned suite at HEAD: **5,789 passed + 9 todo, 0 failed** (+185 over the 5,604 baseline). `npx next build` green (after clearing the documented stale-`dist/` trap).
- Live-DB reconciliation (all backed up first — `data/backups/pre-full-backfill-2026-08-19.db` + per-script backups): ~825 untranscribed rows (all 2022-01→2023-11 sells, 2019-2021 fund activity, statement tails) transcribed into the canonical year CSVs and imported; 22 duplicate option rows deleted (double symbol-spelling keys); 7 option closes retyped SELL_TO_OPEN→SELL_TO_CLOSE with source_key rewritten together; GOOG expired qty fixed; IBKR option 4:1 normalized; splits normalized product-preserving for AAPL 4:1 / AMZN 20:1 / SHOP 10:1 / NFLX 10:1 / ACB / XXII. Sweep signs in the 2022-2025 year files corrected + doubled deposits removed.
- Verification: ledger walks TIE exactly (AMZN 105, SHOP 175, NFLX 250, closed names 0; AAPL −0.059 = pending Aug reinvest); split audit re-run reports all "already-normalized"; re-import of all 8 year files is +0 rows (idempotent); valuations recompute 107ms; browser E2E on the AMZN page confirms 40 @ $98.45 + 40 @ $85.41, all-green lots tying the +115% position (screenshot delivered).
- Electron deploy: run at session close (see §4).

## 3. Open concerns / rejected approaches / decisions

- **The `:#N` source-key ordinal defeats dedupe for cross-source duplicates** — a generated row duplicating a file row (or a file-internal double) imports as new under `:#2`. This is how the first backfill import round created ~57 dups; it was rolled back via batch undo and redone with tuple-level overlap filtering. Worth a structural look (relates to the existing "same-key-different-values conflict warning" TODO).
- First import attempt was undone (batches 124-131) after discovering the year files were themselves more complete than the DB; the convergence order that worked: import pristine files → delete provable dup classes (89 wrong-sign sweeps, 6 doubled deposits) → re-import corrected+appended files.
- Residuals deliberately deferred (filed in TODO with full detail): ~28 sibling-sweep walk mismatches (mostly structural), ~15 net-vs-gross pre-2024 foreign dividends + date-typo rows (<$500 income-history noise, no lot/valuation impact), 2021-04-01 ACATS transfer-ins never transcribed (basis unknown), RKT 10-vs-5 contract report/statement contradiction, 3 unlinked post-R4 TRANSFER_OUT twins (route via Giving, not hand-delete).
- Six QA decisions recorded on the ledger (5 recommendations accepted; trade-counts decided as unify-to-round-trips against the recommendation).
- Subagent incident: two forked file-writers were killed mid-write and truncated 4 CSVs (one left a literal corruption artifact); all restored byte-identical from staged finals and re-verified via diff + idempotent re-import. DB was never at risk (imports had used verified copies).

## 4. Uncommitted changes / live-process state (post-session)

- `main` pushed through the docs commits; working tree clean. No open PRs (#53 merged); all six qa-* branches deleted local+remote.
- Live DB carries the full reconciliation; the running Electron app was rebuilt + relaunched at session close (electron:deploy) so the lot-coverage disclosure and today's UI fixes are live.
- Deferred by decision: `scripts/repair-empty-enrichments.ts` NOT run against the live DB (waiting on an enrichment attempt-counter so failing articles can't retry forever).

## 4b. Same-day addendum — deferred-items walkthrough (user-driven, pm)

All reconciliation residuals triaged; most closed. Shipped on top of the morning's work: income cleanup (29 TAX_WITHHELD + 3 INTEREST + 2 REDEMPTION rows in; 24 superseded net/date-typo dividend rows out of DB and files — the 2022/2023 year files had accumulated TWO transcription revisions across old imports, batches 47/48 vs 135/136); **a real engine fix in `lib/compute/tax-lots.ts`** (price-less REDEMPTIONs were never processed, so every matured bond/bill lot — $185k face — sat open forever; now derived at |amount|/qty×100 per-100 bond basis, bills realize $0); XLU 2:1 stock + option re-symbol repair (broker halved the strike — new OPTION_RESYMBOL_TARGETS section); enrichment retry cap (migration 083, `MAX_ENRICH_ATTEMPTS=3` → `enrichment_failed` exclusion in the D5 tab, 71 articles reset live). Suite 5,800 green; second electron:deploy at close. Reviewer attention: the REDEMPTION price-basis derivation (per-100 convention) and the retry-cap exclusion semantics (processed_at stamped on the third failure). Deliberately untouched: the 3-leg donation journal chains (correct as-is; R4 two-leg artifact linking would double-subtract — Giving machinery follow-up filed).

## 5. Claude session link

https://claude.ai/code/session_01RGYiaxoyfts3LfaVtsBNQZ
