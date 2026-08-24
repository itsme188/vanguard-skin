# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-23 → 24 — number-trust DURABLE FIXES: designed, 21-task-SDD built, four-layer reviewed, merged to main, deployed.

## 1. Goal + exact files changed

One arc: the P0 durable remainder from the 2026-08-23 containment, shipped end-to-end (spec `docs/superpowers/specs/2026-08-23-number-trust-durable-fixes-design.md`, 3×Codex-reviewed; plan `docs/superpowers/plans/2026-08-23-number-trust-durable-fixes.md`, 1×Codex-reviewed; 36 commits merged fast-forward to main @ `7e729b7`, docs reconcile `0f92d58`).

**Track A (tax-dollar convention):** `lib/compute/tax-convention.ts` NEW (generation counter, `v2:<gen>` recompute marker + per-(account,tax-year) broker-acceptance marker, all fail-closed); `lib/compute/tax-lots.ts` rewritten (true-dollar `cost_basis`/`proceeds`/`cost_basis_allocated`; `netLegDollars` gross-vs-net amount self-detection; IRS short orientation with signed-negative `holding_period_days`; calendar-anniversary LT; premium-rollover single-count with replay-time landing conservation + three-level same-date sub-rank; migration `086_tax_lot_sales_premium_rollover.sql`); generation bumps in `lib/import/engine.ts`, `lib/mutations/{import-batches,donation-links,donations,securities}.ts`, `lib/import/recovery.ts`, `scripts/repair-security-type-corruption.ts`; readers simplified in `lib/compute/cost-basis-reconciliation.ts`, `lib/queries/{portfolio-summary,giving-view,tax-lots,options}.ts`, `lib/compute/trade-roundtrips.ts`, `lib/queries/trade-reviews.ts`, `lib/chat/ibkr-context.ts`, `scripts/rebuild-ibkr-ledger.ts` (+`isSyntheticClose` "Estimated" labeling in `TaxLotTables.tsx`, security-detail, `TradeReviewView.tsx`); export gating in `lib/compute/tax-report.ts` (`filingReady`, `buildTaxReportFilename`, wash-sale advisory), `app/api/tax-report/route.ts`, `TaxReportCard.tsx`; NEW `scripts/reconcile-tax-report-vs-broker.ts` (fail-closed acceptance harness) + `scripts/recompute-tax-lots-v2.ts` (report-only default, `--apply` gated, WAL-safe backup, idempotence verify).

**Track B (Dietz lane):** NEW `lib/compute/dietz.ts` + `lib/compute/monthly-snapshot-utils.ts`; `lib/compute/flow-adjusted.ts` gains `fetchInKindFlowsByDate`; `lib/compute/twr-reconcile.ts` rewritten (computeTwr call DELETED — circularity severed; four bands, `DIETZ_CONSISTENT_BP=125`); `lib/queries/analysis-trust-state.ts` (contiguous `crossCheckedThru`, `bandHistory`); UI `TrustStrip.tsx`/`TrustStripDrawer.tsx`/`PerformanceView.tsx` (band-gated claims, zero "reconciled" copy); `scripts/audit-twr-vs-statements.ts` (direction-only stdout).

**Track C (confidence):** `lib/queries/data-confidence.ts` (latest-holdings predicate everywhere, LEFT-JOIN stalest, per-account valuation coverage, `todayET`, integrity cap `min(score,45)`/level→low monotonic); NEW `lib/queries/integrity-checks.ts` + `lib/compute/type-contradictions.ts` (shared tiered detector); `lib/db/holding-sources.ts` `classifyHoldingSourceKey`; `DataConfidenceIndicator.tsx` (capReason + warnings + timing-residual lines).

**Cross-cutting:** `tests/api/number-trust-contracts.test.ts` (real route-handler contracts incl. capped `/api/summary`); `scenarios.ts` inline-SQL cleanup; `.gitignore` `/qa/verify-evidence/`; reference docs (`conventions-detail`, `data-integrity`, `auto-refresh`, `api-patterns`) + CLAUDE.md bullets updated.

## 2. Tests / E2E / deploy result

- Merged main: **`npx vitest run` — 6,489 passed / 0 failed** (571 files); `npx next build` green.
- Review structure: per-task spec+quality reviews (every task), tax engine 4 adversarial fix rounds (conservation probes, 11 permutation/multi-lot probes in the final round), final whole-branch review on the most capable model → APPROVE, 4-finding fix wave + scoped re-review clean.
- Browser E2E on a seeded demo DB (worktree dev server :3098, minted QA session): integrity cap + capReason live, privacy masking on all new surfaces, NOT-FOR-FILING banner + both export filenames verified via Content-Disposition, pending-state behavior, two-caption freshness distinction. Band chips + trade-review pending banner unverifiable on demo data (no statement TWR rows) — pinned by unit/contract tests instead.
- **Deploy: SUCCESS** — `electron:deploy` green, notarization successful, `verify-bundle: OK`, installed + relaunched, `/login` 200 on :3099.

## 3. Open concerns / rejected approaches / user decisions

- **User decisions:** all three workstreams in ONE spec; acceptance evidence = statement realized sections + IBKR annual CSV (not 1099-B); banner lifts automatically once markers + acceptance are current (fail-closed implementation of "banner off with the fix"); Dietz banded verdicts (never a green reconciled ✓); integrity as a hard cap, not a weighted dimension; merge locally then push.
- **Notable controller rulings** (full list in the session transcript): gross-vs-net `amount` self-detection instead of importer changes (source_keys embed amount cents — changing them would duplicate rows on re-import); rollover conservation extended to LANDING (unlanded premium stays realized + warns); same-date sub-rank ordinary→exercise→link-target; wash-sale W codes stay advisory permanently pending 1099-B reconciliation; check-2 integrity mirrors the cash lane's IBKR exclusion.
- **NOT DONE — the user-run runbook (exports stay banner-gated until it runs):** (1) rehearse `REPAIR_DB_PATH=<copy> npx tsx scripts/recompute-tax-lots-v2.ts --apply --verify-idempotent` from repo root, app quit; (2) live `--apply --live` (auto-backup); (3) transcribe broker figures into gitignored `data/repair-configs/broker-realized-*.json`; (4) `reconcile-tax-report-vs-broker.ts --config … --stamp`; (5) exports unlock per accepted (account, tax-year). The deployed app is SAFE pre-runbook: `recomputeCurrent` is false on the live DB, so exports stay NOT-FOR-FILING and the lot-drift integrity check stays dark.
- **New pre-existing bug filed (TODO):** `lib/compute/hedging.ts` resolves "now" in UTC for option-expiry runway — `hedging-orchestrator.test.ts` fails every night 20:00–24:00 ET; nightly QA will hit it.
- **Deferred minors** (~20, all triaged OK-to-defer at final review; in TODO/plan history): consolidate the fail-open `isConventionPending` helpers into tax-convention.ts (fail-closed); Feb-29 SQLite `'+1 year'` anniversary edge on the chat open-lots preview; rewrite `tax-report-filing-warning.test.ts` behaviorally; unwound partial-rollover rows keep `sale_price` 0.

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree clean; main pushed through this handoff commit. No open PRs; issue #34 (process discussion) remains open, nothing implements it.
- Worktrees: `vanguard-skin-number-trust` REMOVED (merged + cleaned); fixer-owned `vanguard-skin-qa-fix` now on `qa-fix-work-20260824` (nightly fixer active overnight — sweep `git log main..qa-*` next session).
- Live app = tonight's notarized build on :3099 carrying all three tracks, marker-gated (banner up until the runbook).
- **Date-critical:** Tuesday 2026-08-25 arm NVDA/CRWD worksheets; Wednesday 2026-08-26 ≈15:45 ET first live print-watch + `scripts/spike-print-timestamp-harness.ts --symbols NVDA,CRWD`; Thursday `--symbols RBRK`.

## 5. Claude session link

https://claude.ai/code/session_01Ad9WjJJ2aZXWSBxhdSHyGK
