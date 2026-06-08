# Analysis Classification Data Backbone + Quick Wins — Design

**Date:** 2026-06-08
**Status:** Approved (design); pending implementation plan
**Surface:** Analysis tab (`/dashboard/analysis`) — cash-deploy workspace, factor coverage, classification, concentration card

## Problem

The Analysis tab's *math* is largely correct, but the **classification data feeding it is fragmented**, so every downstream tool faithfully computes a wrong answer from incomplete inputs. Root-caused against the real DB (`data/vanguard.db`, accounts: 1=Vanguard Taxable, 2=Vanguard Roth IRA, 3=IBKR):

1. **Cash-deploy "Technology < 20%" is an artifact.** The tool sums securities whose `sector` string is literally `"Technology"` (8.1% in Vanguard Taxable). But mega-cap "tech" (META, GOOG, AMZN, APP, NFLX, HOOD, SHOP, UBER = $278k / 19.7%) is filed under Bloomberg's `"Communications"`, and options ($297k / 21%) have a **blank** sector. The DB has both `Financial` and `Financials`, `Industrial` and `Industrials`, `Health Care` and `Healthcare` — a Bloomberg-vs-GICS vocabulary collision. The benchmark targets are pure GICS, so the gap comparison is garbage.
2. **Options don't inherit their underlying's factors.** The `COALESCE(option_factors, underlying_factors)` inheritance join already exists, but fails for 40 of 63 options (~$204k, 10.6% of portfolio): 25 options have a NULL `underlying_symbol` (canonical-CSV import miss, recoverable from the OCC symbol), ~16–20 underlying stocks are themselves unclassified, and GOOGL options don't map to the held GOOG (symbol-exact join ignores issuer siblings).
3. **"Auto-Classify" appears to do nothing.** The sector/fund classifier is a 220-key static map with **no fallback** — names not in the map (EWZ, ORR, XLE, ICL, LAC, MEOH, RBRK, and any new ticker forever) silently stay unclassified, and the toast reports an inflated global count. The factor classifier has a genuine silent-failure path: it always returns `success:true` and shows a green toast even when it classified 0 and hit N errors (e.g. Claude credits/JSON failure).
4. **Top-10 Positions chart is unreadable on the light theme.** `ClassificationCard.tsx:104-114` hardcodes dark-theme hex (`#E5E7EB`, `#94A3B8`) for axis/tooltip text — near-invisible on the Amber theme.
5. **(De-distorted, not fixed here.)** The scenario model's blind spots shrink once options/equities are classified; the model rebuild itself is a separate project.

## Goal

Make the numbers *true*. Fix #1, #2, #3, #4 and de-distort #5 by repairing the classification backbone. Scoped as one project because the fixes share the same data substrate.

## Design — six tracks

### Track A — Sector normalization (write-boundary)
- **New** `lib/securities/normalize-sector.ts`: pure `normalizeSector(raw: string | null): string | null` mapping Bloomberg + casing variants → canonical **GICS-11**. Single source of truth (sibling of `mapSecurityType`, `issuerSiblings`). Canonical set: Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Information Technology *(label as "Technology" to match the benchmark_compositions vocabulary — verify against that table)*, Communication Services, Utilities, Real Estate. Mappings include: `Communications`→`Communication Services`, `Financial`→`Financials`, `Industrial`→`Industrials`, `Consumer, Cyclical`→`Consumer Discretionary`, `Consumer, Non-cyclical`→`Consumer Staples`, `Basic Materials`→`Materials`, `Health Care`→`Healthcare`. Blank/unknown → `null`. Non-GICS values (`Diversified`, `Fixed Income`) pass through untouched (handled by ETF look-through / asset-class, not a GICS sector).
- Apply in `upsertSecurity` (`lib/mutations/securities.ts`) so `sector` is always canonical on the way in — consistent with the existing type/date/multiplier normalization there.
- **No migration** (reuses existing `sector`/`industry` columns).
- **Raw preservation:** `industry = COALESCE(NULLIF(industry,''), raw_sector)` — raw kept only where no industry exists; a genuine granular industry is never clobbered.
- **Backfill** `scripts/backfill-sectors.ts`: rewrite existing `securities.sector` through `normalizeSector`, idempotent, reports counts.
- **Verify** the exact canonical label set against `benchmark_compositions` (`lib/queries/benchmark-compositions.ts`) so portfolio sectors and benchmark targets use identical strings.

### Track B — Option → underlying linkage (fixes #2)
- **Backfill** `scripts/backfill-option-underlyings.ts`: set `underlying_symbol` on the 25 NULL option rows via `parseOCCSymbol(symbol).underlying` (`lib/import/occ-symbol.ts`).
- **Fix root cause** in `lib/import/resolve-description.ts` (canonical-CSV path, ~line 116) so future imports populate `underlying_symbol`. Add a parser test. **Show the diff for approval before applying** (import pipeline is protected).
- **Derive option `sector`** from the underlying's normalized GICS sector (so options stop being blank-sector in the allocation).

### Track C — Issuer-family-aware underlying (GOOGL→GOOG)
- When resolving/backfilling an option's `underlying_symbol`, route it through `issuerSiblings()` (`lib/securities/issuer-family.ts`) to prefer the classified sibling actually held (GOOGL option → store `GOOG`). Keeps the existing symbol-exact factor-inheritance join working — **no SQL change**.

### Track D — Classification completeness (fixes #3)
- **Claude fallback** in `classifySecurities` (`lib/compute/classify-securities.ts`): names unresolved by the static map go to a Sonnet call (new feature key `securityClassification` in `lib/ai/feature-keys.ts` + `FEATURE_MODELS`) filling GICS `sector` / `fund_category` / `geography` / `market_cap_category` / `style`. Validate output against canonical enums (GICS sector ∈ canonical set; reject/skip on malformed). Auto-heals the 7 stuck names + future tickers.
- **Run the factor classifier** (`classifyFactors`) on the ~16–20 unclassified underlyings so option factor inheritance fills.
- **Honest reporting:**
  - `ClassificationCard.tsx` toast surfaces `unresolved.length` ("N couldn't be auto-classified (not in lookup)") and reports the scope-relevant count, not the inflated global one.
  - `classifyFactors` bubbles a hard failure when **all** batches error (mirror the Worker `kind:"error"` counter convention); `app/api/compute/classify-factors/route.ts` returns `success:false`/non-200 when `classified===0 && errors.length>0`; `FactorModeCard.tsx` shows an **error** toast (not green success) in that case.

### Track E — ETF look-through (fixes the deeper part of #1)
- **Migration** (next number in `lib/db/migrations/`): `etf_sector_weights(etf_symbol TEXT, sector TEXT, weight_pct REAL, as_of_date TEXT, source TEXT, PRIMARY KEY(etf_symbol, sector))`.
- **New** `lib/etf/sector-weights.ts`: fetch each held ETF's GICS sector weights via Claude + `web_search_20250305` (Finnhub/FMP ETF data is premium-gated / unavailable — **verified 2026-06-08**). Validate: weights sum to ~100% (tolerance), every sector maps to the GICS-11 canonical set, drop/flag otherwise. Upsert into the table. New feature key `etfSectorWeights`.
- **Refresh** `scripts/refresh-etf-sector-weights.ts`: refresh all held ETFs; quarterly cadence. Last-good rows are the durable static fallback if a fetch fails.
- **Consumer**: reusable `explodeHoldingsBySector` helper that distributes an ETF holding's market value across sectors by weight. **Wired into cash-deploy** (`lib/compute/cash-deploy.ts`) now — the reported surface. ETFs without look-through rows fall back to current single-bucket behavior. Same helper is reusable by the allocation/scenario sector consumers as a **fast-follow** (out of scope for this project to keep it bounded).

### Track F — Quick wins
- **Top-10 contrast** (#4): replace the hardcoded `#E5E7EB`/`#94A3B8` chart hex in `ClassificationCard.tsx:104-114` with theme-aware colors (CSS var / token) readable on both Amber and dark themes.
- Honest toasts: see Track D.

## Out of scope (deferred)
- Scenario model rebuild (finding #5 — its own project: duration for bonds, `security_betas` for equities, options via delta).
- Analysis IA / navigation (four-sub-screens connectivity, mobile reachability, param/scope unification).
- Plain-English interpretation layer (jargon tooltips, Workspace hierarchy).
- ETF look-through for allocation/scenario sector views (helper is reusable; wiring is fast-follow).
- ETF *full-constituent* look-through (only sector-weight vectors here).

## Testing
Vitest + in-memory SQLite (per project convention; AI calls mocked per `memory/feedback_ai_test_mocking.md`):
- `normalizeSector` mapping table (every Bloomberg variant → GICS; blank/unknown → null; non-GICS pass-through).
- `upsertSecurity` writes normalized sector + preserves industry/raw correctly.
- Option underlying backfill: OCC parse + issuer-family resolution (GOOGL→GOOG).
- Canonical-CSV parser fix sets `underlying_symbol`.
- ETF weight validation (sum-to-100, GICS membership, rejection of malformed).
- `explodeHoldingsBySector` distributes MV correctly; non-look-through ETFs unchanged.
- Cash-deploy sector %: Technology now reflects normalized + option-underlying + ETF look-through.
- Classify Claude-fallback path (mocked) fills unresolved names; honest-reporting return shapes (`unresolved.length`, factor `success:false` on all-error).

## Sequencing (for the implementation plan)
1. Track A (normalize + upsert + backfill) — foundational.
2. Tracks B + C (option underlying backfill, parser fix, issuer-family resolution, option sector derive).
3. Track D (Claude classify fallback, run factor classifier, honest reporting).
4. Track E (migration, ETF fetch/validate, refresh script, cash-deploy explosion).
5. Track F contrast fix — independent, anytime.

## Real-data evidence (for verification after implementation)
- Vanguard Taxable (acct 1) "Technology" today: 8.1%. After fix, true tech (Technology bucket + Communications-filed names + tech option notional + ETF look-through) should land well above 20%.
- 25 option rows with NULL `underlying_symbol`; 40 of 63 options uncovered for factors (~$204k).
- 7 fund-classify-stuck names: EWZ, ORR, XLE, ICL, LAC, MEOH, RBRK.
