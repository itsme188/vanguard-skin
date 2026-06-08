# Analysis Classification Data Backbone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Analysis tab's numbers true by repairing the classification data substrate — GICS sector normalization, option→underlying factor linkage, an honest+self-healing classifier, ETF sector-weight look-through, and the unreadable top-10 chart.

**Architecture:** Six independent tracks (A–F). Sector strings are normalized to canonical GICS-11 at the three sites that write `securities.sector`, plus a one-off backfill. Option rows get `underlying_symbol` populated (backfill + parser fix), resolved through issuer-family so dual-class names map to the held sibling. The static classifier gains a Claude fallback for its unresolved tail and honest toasts. A new `etf_sector_weights` table (populated via Claude+web_search) feeds a reusable `explodeHoldingsBySector` helper wired into cash-deploy. All changes are TDD with in-memory SQLite.

**Tech Stack:** Next.js 16, TypeScript 5, better-sqlite3, Vitest, AI SDK v6 (`generateText` via `getModelForFeature`), Recharts.

**Spec:** `docs/superpowers/specs/2026-06-08-analysis-classification-backbone-design.md`

**Conventions:**
- Run a single test file: `npx vitest run <path>`. Full suite: `npx vitest run`.
- DB functions take `db: Database.Database` (DI). Tests use `:memory:`.
- AI tests MUST mock `generateText` + `getModelForFeature` (`memory/feedback_ai_test_mocking.md`).
- Canonical GICS-11 (verified vs `benchmark_compositions`): Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Technology, Communication Services, Utilities, Real Estate.

NOTE: full per-step code blocks for every task are recorded in the session transcript that produced this plan (2026-06-08). This on-disk copy is the task checklist + file map; the executor should follow the transcript's exact code or re-derive from the cited files. Each task is TDD: write failing test → run (fail) → implement → run (pass) → commit.

---

## Track A — GICS Sector Normalization
- [ ] **A1. `lib/securities/normalize-sector.ts`** (+ `tests/securities/normalize-sector.test.ts`): pure `normalizeSector(raw)→GICS-11|null` + `GICS_SECTORS`. Maps Bloomberg variants (Communications→Communication Services, Financial→Financials, Industrial→Industrials, Consumer, Cyclical→Consumer Discretionary, Consumer, Non-cyclical→Consumer Staples, Basic Materials→Materials, Health Care→Healthcare, Information Technology→Technology). Case/space-insensitive. Blank/unknown→null. Diversified/Fixed Income pass through.
- [ ] **A2. Apply at the 3 sector-write sites** (+ `tests/securities/sector-write-normalization.test.ts` pinning the pattern `sector=COALESCE(?,sector), industry=COALESCE(NULLIF(industry,''),?)`): `lib/compute/classify-factors.ts:192-196`, `lib/tws/contracts.ts:169` (normalize Bloomberg `detail.industry`→sector; keep `detail.category` as industry, raw sector as fallback), `lib/import/engine.ts:463`.
- [ ] **A3. `scripts/backfill-sectors.ts`**: idempotent re-normalize of existing rows; logs unmapped labels. Run vs real DB; verify no Bloomberg `Communications`/`Financial` rows remain.

## Track B + C — Option → Underlying Linkage (issuer-family aware)
- [ ] **B1. `lib/securities/resolve-underlying.ts`** (+ test): `resolveHeldUnderlying(db, occSymbol)` = `parseOCCSymbol().underlying`, prefer a held issuer sibling (GOOGL→GOOG via `issuerSiblings`), null for non-OCC.
- [ ] **B2. `scripts/backfill-option-underlyings.ts`**: set `underlying_symbol` on the 25 NULL option rows via `resolveHeldUnderlying`; derive option `sector` from underlying's normalized sector. Verify 0 NULL remain.
- [ ] **B3. Fix `lib/import/parsers/canonical-csv.ts`** (protected pipeline — SHOW DIFF before commit) (+ `tests/import/canonical-csv-option-underlying.test.ts`): the directly-provided-OCC-symbol option branch must set `underlyingSymbol: parseOCCSymbol(symbol)?.underlying`. Run full `tests/import` for regression.

## Track D — Classification Completeness (Claude fallback + honest reporting)
- [ ] **D1. Feature key `securityClassification`** in `lib/ai/feature-keys.ts` union + `lib/ai/models.ts` FEATURE_MODELS (`anthropic/${SONNET_MODEL}`).
- [ ] **D2. `classifyUnresolvedWithClaude(db, unresolved)`** in `lib/compute/classify-securities.ts` (+ mocked-AI test): batches of 25 → Sonnet → fills fund_category/geography/market_cap_category/style, `classification_source='auto_ai'`; returns `{classified, errors}`.
- [ ] **D3. Wire into `app/api/compute/classify/route.ts`** (run fallback on `result.unresolved`, return `unresolvedCount`) + honest toast in `ClassificationCard.tsx:38-48` (surface unresolved count).
- [ ] **D4. Honest factor-classify failure**: add `isFactorClassifySuccess({classified,errors})` to `lib/compute/classify-factors.ts` (+ test); route `app/api/compute/classify-factors/route.ts` returns `success:false`/502 on all-error; `FactorModeCard.tsx:29-39` shows error/info toast honestly.
- [ ] **D5. `scripts/run-classify.ts`**: run static + AI fallback + factor classifier vs real DB; verify EWZ/ORR/XLE/ICL/LAC/MEOH/RBRK get `classification_source`.

## Track E — ETF Sector-Weight Look-Through
- [ ] **E1. Migration `lib/db/migrations/059_etf_sector_weights.sql`**: `etf_sector_weights(etf_symbol, sector, weight_pct, as_of_date, source, PK(etf_symbol,sector))`.
- [ ] **E2. `lib/etf/sector-weights.ts`** (+ test on `validateSectorWeights`): `validateSectorWeights` (GICS-map, drop unmappable, sum≈100 tol 8, re-normalize to 100); `fetchEtfSectorWeights(sym)` via `getRawAnthropicClient("etfSectorWeights")` + `web_search_20250305` (mirror `send-earnings-email.ts::callClaude`); `refreshEtfWeights(db, symbols)` upserts validated rows, skips on `!ok`. Add `etfSectorWeights` feature key.
- [ ] **E3. `lib/queries/etf-weights.ts`** (+ test): `getHeldEtfSymbols`, `getEtfSectorWeights→Map`. `scripts/refresh-etf-sector-weights.ts`: refresh held ETFs vs real DB; verify each ETF sums ~100.
- [ ] **E4. `lib/compute/explode-sector.ts`** (+ test): `explodeHoldingBySector(symbol, type, mv, weights, ownSector)` splits ETF MV by weight, else single-bucket. Wire into `lib/compute/cash-deploy.ts` `loadCurrentHoldings` (replace bucket loop 107-115). Run cash-deploy tests (add `etf_sector_weights` table to their in-memory schema if needed). Verify Technology now ≫ old 8.1% on real DB.

## Track F — Quick Win: Top-10 Chart Contrast
- [ ] **F1. `app/dashboard/components/analysis/ClassificationCard.tsx:104-114`**: replace hardcoded `#E5E7EB`/`#94A3B8`/`#0F1219` hex with theme CSS vars (`var(--color-ink-dim/ink-faint/panel/edge/ink)` — confirm names in `app/globals.css`); keep gold `#C9A44E` bar. Verify readable on Amber + dark in browser.

## Final Verification
- [ ] `npx vitest run` (baseline 2372 + new) — report count.
- [ ] `npx next build` — clean compile.
- [ ] E2E manual pass: (1) cash-deploy Technology realistic; (2) factor coverage % up + honest factor toast; (3) classify toast honest + Top-10 readable; (4) privacy/theme toggle no regressions.
- [ ] Report before/after Technology %, factor coverage %, Top-10 screenshot.

## Spec Coverage Self-Check
A1-A3 sector normalization ✓ · B1-B3 option underlying + parser + issuer-family ✓ · D1-D5 classify fallback + honest toasts + factor run ✓ · E1-E4 ETF look-through ✓ · F1 contrast ✓ · out-of-scope (scenario rebuild, IA, interpretation layer, ETF look-through for allocation/scenario, full constituents) intentionally absent ✓
