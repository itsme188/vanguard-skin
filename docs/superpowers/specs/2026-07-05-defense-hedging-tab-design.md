# Defense / Hedging Tab — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorming session)
**Origin:** TODO `[R3]` (user roadmap, added 2026-07-03)

## Goal

A dedicated surface answering two questions: *what in my book is actually protected, and what carries the most unprotected risk?* Today the answer is smeared across the exposure columns in Analysis Breakdown, the Greeks card, and mental arithmetic. The tab pairs long exposure against offsetting instruments per underlying, credits index/sector ETF puts as portfolio-level protection, ranks the most-exposed/least-hedged names, and scores every hedge for "close first / close last" decisions.

## Locked decisions

1. **Both layers** — per-underlying same-name pairing (Tier 1) AND a portfolio-level proxy layer (Tier 2) where index/sector ETF puts count as protection against the correlated slice of the book.
2. **Proxy attribution: sector/geo match + beta fallback** — sector-weighted where `etf_sector_weights` exist, geography match for country ETFs, β-weighted broad-book credit otherwise.
3. **Placement: Analysis 5th sub-view** — `/dashboard/analysis?view=defense`, alongside Workspace / Diagnostics / Performance / Trade Reviews.
4. **Guidance: deterministic score + AI prose** — testable per-hedge columns (delta coverage, theta bleed, runway, efficiency) plus a cached Sonnet narrative via the existing `analysis_narratives` pattern.

Live-book grounding (2026-07-05): 72 open options (68 in Vanguard Taxable, 4 IBKR), **zero short options anywhere** — all hedging is long puts / long calls vs shorts. True same-name pairs: MSFT (42 sh + 2 puts), INTC (125 sh + 4 puts + 20 amplifying calls), PAYC/PCTY (−80 sh shorts + 1 call each). Proxy sleeve: puts on MTUM/EWG/EWY/IGV/SMH/XLF/KRE/ARKK plus a −300 MAGS short. Standalone bearish bets: puts on non-held RGTI/TD/CM/PANW etc.

## Financial model

All classification runs on **signed delta-notional exposure**: stock/ETF at signed market value; options at Δ × spot × multiplier × contracts (from `computePortfolioGreeks`), with the ±`DEFAULT_OPTION_ELASTICITY`×MV fallback when Greeks are unavailable (existing `optionExposureFallback`). Underlyings normalize through `issuerSiblings()`.

### Tier 1 — same-name pairs

Per underlying, instruments split into *core* (stock/ETF shares, signed) and *options on that underlying*:

- **Opposing-sign options are hedges.** Long core + puts → *hedged long*; short core + calls → *hedged short*. Coverage = min(|offsetting Δ-notional|, |core|) ÷ |core|.
- **Same-sign options on a name with a long core are amplifiers**, never hedges (INTC calls over long stock). They raise the name's ranked exposure and get an explicit amplifier flag. Same-sign *negative* stacks on ETFs (the MAGS puts over the MAGS short) are not amplified risk — they are more protection, and route to Tier 2 along with the short itself.
- **Offset credit caps at the core.** Excess offsetting notional flips the name net-short (net-long for shorts); if the underlying is an ETF, the excess spills into Tier 2 as proxy protection.

### Tier 2 — proxy protection

Negative-exposure instruments on **ETFs with no (or fully consumed) offsetting core** — long ETF puts and short ETF share positions alike (the MAGS short is protection the same way its puts are). Attribution cascade, first match wins:

1. **Sector:** ETF has cached `etf_sector_weights` → protective notional distributes across GICS sectors by weight (reuse `explodeHoldingBySector`) and credits against the book's long exposure in those sectors.
2. **Geography:** country ETFs (EWG, EWY) credit against held names whose `geography` classification matches.
3. **Beta fallback:** unmatched (MTUM, ARKK, …) credits as broad-book protection at β × notional. β resolution: `security_betas` row → computed from cached closes with the trading-day gap guard (pairs spanning >7 calendar days dropped) → 1.0, flagged as assumed.

### Deliberately NOT credited as protection

- **Long calls with no core** (DRAM, FROG, LFMD, …) — speculation; shown as leveraged long exposure in the rankings.
- **Single-name puts on non-held stocks** (RGTI, TD, CM, PANW, …) and **naked single-name shorts** (AMD −20) — directional bearish bets; listed in a dedicated "standalone bets" block, never smeared into sector coverage.

### Outputs

- **Book-level protection ratio**: total credited protective notional ÷ total long exposure.
- **Per-sector coverage**: long exposure vs protected $ per GICS sector.
- **Ranked exposures**: per-underlying net exposure with Tier-1 coverage % and sector-proxy coverage % as *separate columns* — no fake per-name allocation of index puts.
- **Per-hedge scores** (below).

## Compute module

New pure module `lib/compute/hedging.ts`, house engine pattern (`db` + `accountIds?: number[]`, `:memory:`-testable):

```ts
computeDefenseAnalysis(db, accountIds?) → DefenseAnalysis {
  summary:         { longExposure, shortExposure, protectiveNotional,
                     protectionRatio, netExposure, grossExposure }
  pairs:           UnderlyingPair[]    // Tier 1
  proxies:         ProxyHedge[]        // Tier 2, with attribution route
  sectorCoverage:  SectorCoverage[]
  standaloneBets:  StandaloneBet[]
  rankedExposures: RankedExposure[]
  hedgeScores:     HedgeScore[]
  diagnostics:     DefenseDiagnostic[] // assumed-β, missing weights, Greeks fallbacks
}
```

Reused single-sources: `latestHoldingsPredicate` (per-(account, security), `includeShorts: true`), `computePortfolioGreeks` positions (scoring needs theta/expiry/strike, not just the delta map), `exposureForHolding`/`optionExposureFallback`, `issuerSiblings`, `explodeHoldingBySector` + `etf_sector_weights`, `security_betas`. Every dollar carries the FX factor per the foreign-currency convention (`COALESCE(fx.usd_per_unit, 1)` / `getUsdPerUnit`) — byte-identical for USD. Expired-but-unpurged options filtered as in `exposure.ts`.

**No new tables, no migration.**

## Per-hedge scoring

One row per protective instrument (Tier 1 offsets + Tier 2 proxies):

| Field | Definition |
|---|---|
| Protected $ | \|Δ\| × spot × multiplier × contracts, plus what it credits (name / sector / book) |
| Carry cost | theta $/day from Greeks, expressed as monthly bleed % of protected notional |
| Runway | days to expiry; moneyness (% OTM/ITM) |
| Efficiency | dollars protected per dollar of monthly decay (primary sort) |

Badges from named-constant thresholds (constants in `hedging.ts`, pinned by tests; defaults below, tunable in one place): `expiring` (runway <30d), `decayed` (>20% OTM AND runway <45d — mostly salvage value), `expensive` (monthly bleed >3% of protected notional), `deep ITM` (|Δ| ≥ 0.8 — mostly intrinsic, cheap carry). No opaque composite score — columns are individually explainable and sortable; "close first" candidates emerge as low efficiency + short runway. Instruments without computable Greeks are **excluded from scoring** (no fake numbers) but stay in exposure via the elasticity fallback, with a diagnostic explaining why.

## API + narrative

- `GET /api/analysis/defense?scope=` → `resolveScope` (multi-account `accountIds[]`, never first-id) → `computeDefenseAnalysis`. Contract test added to `tests/contracts/api-component-contracts.test.ts`.
- AI prose: new `surface='defense'` prompt builder in `lib/compute/analysis-narratives.ts`, reusing the `analysis_narratives` cache table, GET/POST routes, and rate limits unchanged. On-demand generation only (no Sunday pre-generation initially).

## UI

`defense` becomes the 5th canonical Analysis sub-view: extend `lib/analysis/view-param.ts::resolveAnalysisView`, `AnalysisViewToggle` (5 pills), and the Analysis `subviews` entry in `nav-tabs.ts`.

`DefenseView` (desktop two-column where the chat rail allows; mobile single column; every portfolio-derived number through `<Money>`/`<Pct>`):

1. **Headline strip** — protection ratio, net/gross exposure, protective notional, hedge count; each with a plain-English interpretation line (extend `lib/analysis/interpret.ts`).
2. **Sector coverage bars** — long vs protected $ per GICS sector.
3. **Most-exposed table** — `SortableHeader` + `useSortParam` (scope `"defense"`): `SymbolLink`, net exposure $, % of book, Tier-1 coverage %, sector proxy coverage %, amplifier `<Chip>`.
4. **Hedge book table** — scoring rows, sortable, badges as `<Chip>` tones.
5. **Standalone bets block** — labeled as outside the coverage math.
6. **`NarrativeBlock`** — cached `surface='defense'` prose with the standard regen affordance.

Empty states via `<EmptySection>` with a reason ("No options or short positions in this scope") so a Roth scope looks intentional. Diagnostics render as the collapsible block pattern from `OptionsGreeksCard`.

## Edge handling

- Sector ETF without cached weights → beta tier + diagnostic ("treated as broad-market — no cached sector weights"); never silently miscredited.
- Missing geography/β → beta fallback → assumed β=1.0, always flagged.
- Scope consistency: a Vanguard-only scope excludes IBKR shorts *and* their exposure from both sides of every ratio.
- Zero-hedge book or empty scope → `EmptySection`, ratios null (not 0/0 artifacts).

## Testing

Vitest, `:memory:` DBs. One unit test per classification case: hedged long, hedged short, amplifier, over-hedge cap + ETF spillover, proxy via sector / geography / beta, standalone bet, no-Greeks fallback. Scoring boundary tests pin badge thresholds. FX pass-through test (non-USD holding scales, USD identical). API contract test; `resolveAnalysisView` extension test. Full suite (`npx vitest run`) must stay green before commit.

## Out of scope

- Short-option strategies (covered calls, short puts) — the book has none; classification handles them structurally (sign-based) but no dedicated UI treatment until they exist.
- Per-name allocation of index-put protection (fake precision — sector coverage columns instead).
- Email/Worker surfaces — in-app only.
- Historical hedge-effectiveness scoring (did past hedges pay off) — future follow-up.
