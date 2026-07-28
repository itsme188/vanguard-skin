# Sector-Tag Verification & Bloomberg-Taxonomy Repair — Design

**Date:** 2026-07-28 (brainstormed 2026-07-27)
**Status:** Approved
**Origin:** User report 2026-07-23 "sectors not properly mapped" (Defense tab + chat sector analysis untrustworthy), root-caused same day; TODO entry under Bugs/Quality.

## Problem

`securities.sector` is corrupted for a meaningful share of held + watchlist stocks because
`normalizeSector` treats four Bloomberg sector buckets as 1:1-mappable to GICS-11 when they
are structurally not. Bloomberg's taxonomy predates GICS's 2016 Real Estate split and 2018
Communication Services reshuffle, so a single Bloomberg bucket spreads across up to five GICS
sectors depending on the name:

| Bloomberg bucket | Currently aliased to | Live wrong rows (verified 2026-07-27) | Live correct rows |
|---|---|---|---|
| `Communications` | Communication Services | AMZN (→Cons Disc), HOOD (→Financials), UBER (→Industrials), SHOP/APP (→Technology), LQDT, MELI | GOOG, META, SPHR |
| `Consumer, Non-cyclical` | Consumer Staples | UNH, OSCR, VRTX, ESTA, DHR (all →Healthcare) | KO |
| `Consumer, Cyclical` | Consumer Discretionary | IMAX (→Comm Services) | NKE, HD |
| `Financial` | Financials | LAND, KRC (REITs →Real Estate) | GS, BAC, V |

Complications established during exploration:

1. **`fund_category` is not a mechanical oracle.** GOOG/META carry
   `fund_category = "US Sector Equity (Technology)"` while their current Communication
   Services sector tags are GICS-correct — a prefer-fund_category rule would corrupt them in
   the opposite direction. Shapes like "International Equity" (TSM) or "Small Cap Equity"
   carry no sector signal at all.
2. **The AI classifier is a second corruption source.** `lib/compute/classify-factors.ts`'s
   few-shot examples assert `VRT: Technology` (GICS: Industrials); the live VRT row shows
   exactly that tag. Both AI classify paths write `sector = COALESCE(ai_value, sector)`, so
   example errors propagate.
3. **Option rows carry copied sectors.** `classifyOptionSectors` writes the underlying's
   sector onto option rows directly (cash-deploy reads the option's own column), so a stock
   repair must cascade to its options.
4. Write sites use `COALESCE(new, old)` — a null from `normalizeSector` never erases an
   existing value. Hardening the alias table stops future corruption but heals nothing;
   an explicit sweep is required.

**Blast radius of the corruption:** Defense tab Tier-2 proxy attribution, allocation
breakdowns, sector-ETF reaction mapping (`resolveSectorEtf`), briefing sector clusters,
cash-deploy, and chat (conversation 36 on 7/20 repeated the wrong tags verbatim).

**Scale:** ~112 held+watchlist stock rows; ~150–200 stock rows total; ~750 tagged rows
including options.

## Decisions (user-approved 2026-07-27)

1. **Truth source for repair:** Claude **with `web_search` verification** (not context-only,
   not fund_category-first). Uses the established `getRawAnthropicClient` +
   `web_search_20250305` pattern (`lib/etf/sector-weights.ts` precedent).
2. **Sweep scope:** **all stock/common-stock rows** (covers non-held read-through reporters),
   then cascade to option rows. ETFs/funds excluded (their Bloomberg tags are their explicit
   theme; allocation uses `etf_sector_weights` look-through anyway).
3. **Drift visibility:** **migration 071 verification stamp** (`sector_source`,
   `sector_verified_at` nullable columns) + a Data Health panel that flags only UNVERIFIED
   disagreements — GOOG/META-style permanent-legit divergences stay suppressed forever
   without an allowlist.

## Design

### 1. Prevention — `normalizeSector` demotions

Remove from `ALIASES` (they return `null` → write sites' COALESCE leaves sector for the
context-aware Claude tail to fill):

- `communications`
- `consumer, non-cyclical`, `consumer non-cyclical`, `consumer non cyclical`
- `consumer, cyclical`, `consumer cyclical`
- `financial`

Keep every alias that is 1:1 in practice: exact GICS spellings, `basic materials`,
`health care`, `information technology` / `info technology`, `industrial` (singular — every
live row under it checks out; Bloomberg's Industrial bucket only marginally leaks toward
GICS Materials; documented in a comment). `Diversified` / `Fixed Income` passthrough
unchanged.

A header comment on the demoted set documents WHY those four cannot be 1:1 (with example
names from the table above) so nobody "restores" them as a cleanup.

**Consumers unaffected:** `resolveSectorEtf`'s normalizeSector defense reads
`securities.sector` values that are already canonical GICS; fund-category normalization is a
separate module.

### 2. Prevention — AI classifier fixes

- `classify-factors.ts` few-shot: `VRT` sector corrected to `Industrials` (industry "Data
  Centers" stays — that's the point: industry strings do not determine GICS sector).
- Both AI classify prompts (`classify-factors.ts`, `classifySecurities`'s
  `classifyUnresolvedWithClaude`) gain one explicit guidance line:
  *"Sector must be GICS-11, not Bloomberg: internet retail → Consumer Discretionary;
  interactive media/search/social → Communication Services; REITs → Real Estate; managed
  care/biotech/pharma → Healthcare; payment networks → Financials."*
- All three sector write sites stamp provenance into `sector_source` when they write a
  non-null sector: `lib/tws/contracts.ts` → `'tws_bloomberg'`,
  `lib/compute/classify-factors.ts` → `'ai_classify'`, `lib/import/engine.ts` →
  `'csv_import'` (its sector values come from a user-provided factor CSV, verified at the
  call site). Stamp only when the sector value actually lands (same COALESCE guard), and
  never touch `sector_verified_at` — that column belongs to the sweep alone.

### 3. Migration 071

```sql
ALTER TABLE securities ADD COLUMN sector_source TEXT;
ALTER TABLE securities ADD COLUMN sector_verified_at TEXT;
```

Nullable, no backfill — the sweep fills them. No CHECK constraint (values are app-defined
strings; SQLite table-rebuild cost not warranted here).

### 4. Repair sweep — `scripts/verify-sector-tags.ts`

Idempotent CLI, **dry-run by default**, `--apply` to write, optional trailing symbol args to
re-verify specific names later (the standing resolution tool for future Data Health flags).

- **Scope query:** all `LOWER(security_type) IN ('stock','common stock')` rows, excluding
  garbage symbols (`isGarbageSymbol`). Default behavior skips rows already stamped
  `sector_verified_at` (so re-runs only touch new/flagged names); `--all` forces
  re-verification of stamped rows. On the first run nothing is stamped, so the default
  covers everything.
- **Model call:** batches of ~10 through `getRawAnthropicClient("sectorVerification")` with
  `web_search_20250305` (max_uses bounded per batch). New feature key `sectorVerification`
  → `$frontier` in `FEATURE_MODELS`. Model id recorded from
  `resolveFeatureModel("sectorVerification").modelId` — never a hardcoded string.
- **Prompt context per name:** symbol, name, industry, fund_category, current sector.
  Output contract: JSON array of `{symbol, sector, rationale}` where `sector` ∈ GICS-11 or
  `"Unknown"`; instructed to web-verify any name it is not certain of (recent GICS
  reclassifications, small caps, foreign listings).
- **Parse + guard:** `extractJsonArray` then strict `GICS_SECTORS.includes` — anything else
  (including `"Unknown"`) leaves the row unwritten and is reported, never guessed.
- **Write (with `--apply`):** `sector = <verified>`, `sector_source = 'gics_verified'`,
  `sector_verified_at = datetime('now')` — **stamping even when the sector is unchanged**
  ("verified correct" is exactly the signal the drift panel suppresses on).
- **Option cascade:** after stock writes, every option row whose `underlying_symbol`
  resolves (issuerSiblings-aware, `resolveHeldUnderlying` pattern) to a swept stock gets
  that stock's sector copied directly (no Claude, no stamp — options are derived rows).
- **Report:** old→new table per row with rationale, count summary, and a printed companion
  checklist: run `scripts/reprocess-sector-etf-gaps.ts`; force-regen macro themes
  (`POST /api/analysis/macro-themes`); analysis narratives self-refresh weekly (no action).

### 5. Data Health drift panel

New read-only section on `/dashboard/data-health`: **"Sector disagreements"** — rows where:

- `fund_category` matches the `US Sector Equity (X)` shape, AND
- `normalizeSector(X)` is non-null and ≠ `sector`, AND
- `sector_verified_at IS NULL`

Query lives in `lib/queries/data-health.ts` (existing module); the X→GICS mapping reuses
`normalizeSector` (it already handles "Health Care", "Financial", etc. — note
"Financial"/"Communication"-style X values inside fund_category strings use the GICS-close
spellings, and any X that normalizes to null simply doesn't flag). Renders symbol, sector,
fund_category, industry + a hint naming the verify script. Empty state via `<EmptySection>`
("No unverified sector disagreements"). No data-confidence score change (YAGNI).

## Testing

- `normalizeSector`: pins that the four demoted buckets return null; kept aliases stable
  (update the existing test file).
- Sweep pure pieces against in-memory DB with mocked AI (per `feedback_ai_test_mocking`):
  scope query (incl. garbage-symbol + unverified-only filters), response parse + GICS
  guard (Unknown/invalid → unwritten + reported), write + stamp semantics (unchanged row
  still stamps), option cascade (issuerSiblings resolution, non-matching options untouched).
- Data Health predicate: flags an unverified disagreement; suppresses a verified one
  (GOOG-style); ignores non-sector fund_category shapes.
- Migration: covered by the standard migration-runner test.
- Verify-external-truth discipline: the sweep's own web_search IS the verification; the
  spec's wrong-row table above is the fixture basis for expected repairs (UNH→Healthcare,
  AMZN→Consumer Discretionary, LAND→Real Estate, IMAX→Communication Services,
  VRT→Industrials, GOOG stays Communication Services).

## Post-repair verification (session E2E)

1. Browser: Defense tab Tier-2 attribution, Analysis allocation breakdown, UNH + AMZN
   Security Detail — sectors render repaired.
2. Data Health panel empty post-sweep.
3. User re-grades chat sector trust (the 7/20 conversation-36 complaint) at their leisure.

## Explicitly out of scope

- ETF/fund sector tags (low-risk; look-through covers allocation).
- `SECTOR_TO_ETF` / benchmark_compositions / briefing query changes — they consume
  `securities.sector` and heal automatically once it's correct.
- Historical cached artifacts (old macro themes, narratives, past briefings) — weekly regen
  cycles replace them; the sweep's companion checklist covers the two worth forcing.
- Automatic re-verification cadence — the Data Health panel + reusable script are the loop.
