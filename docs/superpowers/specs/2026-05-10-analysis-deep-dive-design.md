# Analysis Deep Dive — Portfolio Construction Workspace

**Author:** Claude (with Yitzi)
**Date:** 2026-05-10
**Status:** Approved (brainstorming complete; pending spec review + user re-review)
**Estimated effort:** ~70h across 4 implementation phases (~2-3 weeks at user's pace)
**AI cost added:** ~$1.20/month
**Test count target:** 1766 → ~1850 (+84)

---

## Executive Summary

Reorient the `/dashboard/analysis` page from a metrics dump into a **portfolio construction workspace** the user actually trusts. The user's primary unmet need is "I have cash to deploy in Vanguard or Roth — where does it go?", a workflow the current page doesn't support. Two secondary use cases — weekly review and explanation/advisor conversation — are also in scope. Daily check-up is *not* a target use case.

Three structural changes compose the redesign:

1. **Trust layer first.** The user does not currently use the page much because the numbers feel uncertain. We fix two confirmed bugs (Options Greeks blank, Options Expirations blank — both downstream of a shared multi-source-data-freshness query bug), surface data-quality state in a top-of-page Trust Strip, and audit Performance computations against statement TWR.
2. **Construction Mode becomes the default landing.** Above-the-fold gets a workspace with three cards: Cash-Deploy (allocate cash by closing benchmark gaps with watchlist names), What-if Calculator (multi-leg exposure delta), and Macro Overlay (Sonnet-distilled themes from research feeds + calendar enrichment). Diagnostics live below the fold.
3. **Narrative layer on top.** Sonnet-generated paragraphs explaining what each card means, per-security factor lens on Security Detail, classification drill-down, week-over-week deltas. Adds depth without burying the numbers.

A new ETF composition table and four small new tables (regressions cache, narratives cache, macro themes cache, plus settings-row construction caps) complete the data model. The 612-line `AnalysisView.tsx` carves into ~10 focused components.

This is one mega-spec because the thirteen items have load-bearing interactions: Cash-Deploy uses What-if as its compute engine, Macro Overlay drives narrative emphasis, scenario-recipes share the factor-sensitivity math with What-if. Splitting across phase-specific specs would force us to relitigate joints every phase.

---

## Background

### Current state

The Analysis page (`/dashboard/analysis/page.tsx`, 180 lines + `AnalysisView.tsx`, 612 lines) defaults to a Classification pie chart with mode flags `?mode=classification|factors`. Sub-views via dropdown: Performance, Trade Reviews. Renders ten subcards: classification charts, factor heatmap, quantitative factor analysis, risk metrics, position risk, scenario modeling, fixed income, options Greeks, options strategies, expiration calendar — plus an income/yield section at the bottom.

Phase 5 (2026-04-30) shipped scope-aware default benchmarks (`DEFAULT_BENCHMARK_BY_SCOPE`: Vanguard→VTI, IBKR→QQQ, Roth→SPY) and disjoint scopes (Vanguard excludes Roth). That foundation is reused here.

### What's broken / untrusted (per user 2026-05-10)

- **Options Greeks card always blank.** Confirmed root cause: `lib/compute/options-greeks.ts:363-366` filters via `WHERE h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.as_of_date <= ?)` — a global max across the entire holdings table, not per-(account, security). With IBKR refreshed today (TWS auto-refresh) and Vanguard at 2026-04-30 (last statement), the global MAX returns today; the filter then admits only IBKR rows. All 52 Vanguard Taxable options vanish. Of 3 IBKR options, 2 fail because TWS hasn't ticked them today either — only 1 row survives. Many are missing required fields for Black-Scholes anyway, so the visible card is empty.
- **Options Expirations always blank.** Chains off `/api/compute/options-greeks` — inherits the bug.
- **Factor coverage uncertain** — the user can't tell what's classified, what's stale, what's missing.
- **Performance accuracy** — user is "85-90% sure on TWR/MWR." Trust gap blocks usage.
- **Scenario modeling** — current 9 presets feel arbitrary; accuracy unverified.

### What the user said

> "It's more portfolio construction if I'm looking to add to put that deploy cash in my long-term account or Roth IRA. You know, factors, or there's a macro thing going on. I want to see how exposed I am to it, not really tied to short-term IBKR trading, because portfolio construction is not really a thing there. I still don't trust the numbers 100% in there, so I have not used it much."

Plus: scenario modeling — "I'm open to changing it." Performance — "pretty bare bones; we can improve it." Options Greeks — "always blank, don't know what it's supposed to do." Options Expirations — same.

### Use case priorities

In: **Decision support** (B), **Weekly review** (C), **Explanation** (D). Out: Daily check-up (A).

---

## Information Architecture

### Page structure (post-redesign)

```
/dashboard/analysis                                   default landing flips
├── Trust Strip (5 cells, top-of-page)                NEW · 2.3
├── Workspace                                         NEW
│   ├── Cash-Deploy card                              3.1
│   ├── What-if Calculator card                       3.2
│   └── Macro Overlay card                            5
└── Diagnostics (below the fold)
    ├── Quantitative Factor Analysis (+ narrative)    4.1
    ├── Factor Heatmap (+ narrative + drill-down)     4.1 + 4.3
    ├── Classification (+ drill-down)                 4.3
    ├── Risk Metrics (+ narrative + W-o-W deltas)     4.1 + 4.4
    ├── Position Risk (+ drill-down)                  4.3
    ├── Fixed Income
    ├── Options Greeks (FIXED)                        2.1
    ├── Options Strategies
    ├── Expiration Calendar (FIXED)                   2.2
    └── Income / Yield
```

### Sub-views (via tab dropdown)

| Sub-view | URL | State |
|---|---|---|
| Workspace (default) | `/dashboard/analysis` | new |
| Performance | `?view=performance` | upgraded · 2.4 |
| Trade Reviews | `?view=trade-reviews` | unchanged |
| Drill-down | `?view=drilldown` | new · 4.3 |

### URL redirects

`?mode=classification` and `?mode=factors` redirect to the new default (`/dashboard/analysis`). Old iPhone bookmarks land gracefully on Workspace.

### Tab count

**Stay at 6 desktop tabs** (Today / Accounts / Analysis / Research / Charts / Import). The 9→6 collapse from 2026-04-29 was deliberate; reversing it for "Construct" doesn't earn the cost.

### Security Detail integration

`/dashboard/security/[id]` gains a new `FactorProfileSection` (item 4.2) — slots between MarketDataPanel and Notes.

---

## 1 — Trust Layer

### 1.1 — Options Greeks fix

**Root cause** (confirmed against live DB 2026-05-10):

```
IBKR latest as_of_date:           2026-05-10 (TWS auto-refresh)
Vanguard Taxable latest:          2026-04-30 (statement)
Roth latest:                      2026-04-30 (statement)
Global MAX (current query):       2026-05-10
Survives WHERE h.as_of_date = MAX:
  IBKR options:                   1 of 3
  Vanguard Taxable options:       0 of 52
  Roth options:                   0 of 0
```

**Fix:** replace the global subquery with a per-(account, security) latest-as-of-date CTE:

```sql
WITH latest_holdings AS (
  SELECT h.*
  FROM holdings h
  WHERE h.as_of_date = (
    SELECT MAX(h2.as_of_date) FROM holdings h2
    WHERE h2.account_id = h.account_id
      AND h2.security_id = h.security_id
  )
  AND h.quantity != 0
)
```

**Two important deltas from the existing `LATEST_HOLDINGS_CTE`** in `lib/queries/analysis.ts:68-77`:

1. **Tighter join key.** The existing CTE keys MAX on `(h2.account_id)` only — fine for read-only allocation queries where stale per-security rows wash out via SUM. The Greeks query needs per-(account, security) latest because options held continuously across statement dates would otherwise drop when one security's row is older than the account's most recent refresh date. We don't extend `LATEST_HOLDINGS_CTE` itself (it'd alter behavior for 7 existing call sites); we introduce a Greeks-specific variant inline.
2. **Quantity filter.** Existing CTE has `AND h.quantity > 0`, which would silently drop short option positions (sell-to-open calls/puts with negative quantity). Greeks fix uses `h.quantity != 0` — short Greeks (negative delta on short calls, etc.) must surface.

**Plus:** add a diagnostic surface inside the Greeks card listing positions that *did* surface but couldn't compute Greeks, with reason: missing underlying price · expired · missing strike data · missing IV. Turns blank-row failures into actionable problem statements.

**Files:** `lib/compute/options-greeks.ts` (query rewrite + diagnostic return type), `app/dashboard/components/OptionsGreeksCard.tsx` (render diagnostic block), regression test in `tests/compute/options-greeks.test.ts` with multi-account fixture covering both stale-statement and short-quantity cases.

### 1.2 — Options Expirations fix

**Root cause:** `ExpirationCalendar` fetches `/api/compute/options-greeks` and filters client-side. Inherits the bug from 1.1.

**Fix:** the 1.1 fix resolves Expirations transitively. **Additionally**, decouple the data source:

- New API route `/api/compute/options-expirations?scope=&days=90` — uses the same `LATEST_HOLDINGS_CTE` pattern, returns positions filtered by DTE, does *not* require Greeks computation. Renders even when underlying prices are missing.
- New compute module `lib/compute/options-expirations.ts` — pure positions-by-expiration query.

**Files:** new `app/api/compute/options-expirations/route.ts`, new `lib/compute/options-expirations.ts`, `app/dashboard/components/ExpirationCalendar.tsx` (switch endpoint), tests.

### 1.3 — Factor Coverage truth-meter (Trust Strip)

**Five cells, top-of-page horizontal strip.** Each clickable.

| Cell | Source | Click action |
|---|---|---|
| Factor coverage | existing `getFactorCoverage` | Drawer with missing names + "Re-classify all / selected" |
| Last classification | new query on `security_factors.updated_at` | Trigger `autoClassifyFactors` mutation |
| Performance reconciled-thru | new `reconcileTwrAgainstStatements` | Open Performance sub-view, audit details |
| Stale prices | new query on `prices.date` vs today | Trigger TWS quick refresh |
| Bond duration coverage | securities WHERE security_type='bond' AND duration_years IS NULL | Open Diagnostics → Fixed Income card |

**New query:** `getAnalysisTrustState(db, accountIds): AnalysisTrustState` — single query returning all five dimensions.

**Component:** `app/dashboard/components/analysis/TrustStrip.tsx` + `TrustStripDrawer.tsx`. Strip uses the same Bloomberg-Amber + Plex Mono aesthetic as the rest of the redesign.

### 1.4 — Performance audit + upgrade

**Audit deliverable.** New module `lib/compute/twr-reconcile.ts` exposing `reconcileTwrAgainstStatements(db, accountId, periodEnd): ReconciliationResult`. Compares computed `computeTwr` against:
- IBKR activity-statement `twr` field (already imported, `monthly_snapshots.twr` for source `ibkr-activity`)
- Vanguard year-end-statement `twr` (December rows with annual `starting_value`)

Returns: `{ computed, statementReported, divergenceBp, withinTolerance }` with default tolerance 5bp. Surfaces in Trust Strip cell 3 ("reconciled thru Apr 2026 · +0.02% within tolerance") and as a strip atop the Performance sub-view.

**Pre-merge requirement.** Run `scripts/audit-twr-vs-statements.ts` against current DB *before* P1 ships. If divergence exceeds 50bp for &gt;20% of months, the audit becomes a fix (not just receipts). Investigate before locking phase.

**Performance page upgrade.** Adds:
- Reconciliation strip at top
- Max Drawdown + Sharpe alongside TWR/MWR (compute exists in `lib/compute/risk.ts`)
- Equity curve with benchmark overlay (uses scope-aware default benchmark)
- Period attribution: top contributors / detractors / sector contribution / beta-vs-alpha decomposition

**Reuses:** existing `computeTwr`, `computeXirr`, `computeRiskMetrics`. New: `lib/compute/period-attribution.ts`.

---

## 2 — Construction Mode

The new center of gravity. Three cards in the Workspace above the fold.

### 2.1 — Cash-Deploy

**Algorithm:**

1. User enters a dollar amount in current scope (Roth/Vanguard/IBKR).
2. Compute current sector & factor weights for the scope.
3. Compare against scope-aware **benchmark composition** (VTI/QQQ/SPY/DIA via `DEFAULT_BENCHMARK_BY_SCOPE` from Phase 5).
4. Identify gaps &gt; threshold (default ±2pp).
5. Pull watchlist names where `group_name` matches the scope (`vanguard_buy`, `ibkr_buy_next`, `roth_buy_next`).
6. Rank each candidate by gap-closure score: `Σ (gap_reduction × gap_magnitude × (1 if positive direction else 0))`.
7. Solve a small allocation: greedy fill of the cash to the top gaps, capped per name by `construction_caps_<scope>`.
8. Render with what-if delta inline (uses 2.2 engine).

**Toggle:** "Sector mode" (vs benchmark) ↔ "Factor balance mode" (vs your own current tilts, e.g., reduce ai_exposure if Very-High weight is the largest concentration).

**Watchlist coupling.** Existing infrastructure — no new table needed. The `group_name` column already supports `"vanguard_buy"`, `"ibkr_buy_next"`, etc.

**New required:** ETF composition data. No public free API for VTI/QQQ/SPY/DIA sector weights — hand-curated CSV, monthly refresh script. Stored in new `benchmark_compositions` table (migration 049).

**Component:** `CashDeployCard.tsx`. **Compute:** `lib/compute/cash-deploy.ts::suggestAllocation(db, scope, cashAmount): CashDeploySuggestion`.

### 2.2 — What-if Calculator

**Engine:** `lib/compute/exposure-delta.ts::computeExposureDelta(db, scope, hypotheticalLegs[]): ExposureDelta` — pure function over a synthetic `HoldingsView` that splices the legs into current holdings.

**Multi-leg support.** "Buy $5K AAPL AND sell $2K GOOG" — supports rebalancing what-if, not just additions.

**Returns:**
- `before/after` for: portfolio beta, factor tilts (all 9 dimensions), sector weights, top-N concentrations, vol estimate, drawdown estimate.
- `flags`: array of triggered sanity flags (top-1 &gt; 10%, sector &gt; 35%, beta out of [0.7, 1.2]). Configurable per scope via `construction_caps_<scope>` settings rows.

**Used by Cash-Deploy** internally for every candidate ticker. Saves duplicating math.

**Component:** `WhatIfCalculator.tsx` — multi-leg input row + before/after delta panel + sanity flag list.

### 2.3 — Replace Scenario Modeling

**Replace** the current 9 arbitrary presets in `lib/compute/scenarios.ts` with **8 factor-anchored scenarios** in new `lib/compute/scenario-recipes.ts`:

| # | Scenario | Sensitivity from |
|---|---|---|
| 1 | Rate shock ±25bp | bond duration · `interest_rate_sensitive` |
| 2 | USD ±5% | `international_exposure` |
| 3 | Tariff escalation +10pt | `tariff_exposure` |
| 4 | AI capex pause | `ai_exposure` (NDX-95 analog) |
| 5 | Oil shock +$10/bbl | sector + `cyclical` |
| 6 | Semi cycle -15% | industry + `tariff_exposure` |
| 7 | Healthcare reg shock | `regulatory_risk` + sector |
| 8 | Crypto -30% | `crypto_adjacent` |

**Each scenario.** Recipe = `{ shockMagnitude, factorMultipliers: Record<factor, number>, methodology: string }`. Per-position P&L = `Σ position_value × factor_sensitivity × shock_magnitude`. Methodology shown to the user — "rate +25bp × duration 5.6y × $27k bond ladder = -$380."

**Confidence intervals.** Derived from historical analog returns. New `lib/compute/scenario-confidence.ts::computeAnalogCI(db, scenario)` — looks up similar magnitude shocks in the past 5 years (FRED for rates, OHLCV for sector ETFs), measures portfolio response on those days, returns 95% CI.

**Custom scenario mode kept** — but powered by the new factor-sensitivity inputs, not bare market-move %. POST `/api/compute/scenarios` body schema gains `factorOverrides` field.

**Constants:** `FACTOR_SHOCK_SENSITIVITIES` in `lib/compute/scenario-recipes.ts` — per-factor-bucket multipliers (e.g., `interest_rate_sensitive: { Low: 0.1, Moderate: 0.5, High: 1.0 }`). Calibrated from historical regression once, hardcoded.

---

## 3 — Narrative Layer

### 3.1 — Factor narratives

**Surface-level only.** Quant Factor Analysis · Factor Heatmap · Risk Metrics · Position Risk. Not on every chip — page must not become a wall of prose.

**Generation.** Sonnet 4.6 via existing AI Gateway. New feature key `analysisFactorNarrative` in `FEATURE_MODELS`.

**Caching.** `analysis_narratives` (migration 051): `(scope, surface_key, week_of)` UNIQUE. One generation per surface per scope per week. 4 surfaces × 4 scopes × 1/wk × ~$0.005 = ~$0.08/week.

**Pre-generation hook.** Sunday 3 PM briefing pipeline (`sendBriefingEmail`). Already runs `syncCalendarForWeek` and reads research articles — perfect attachment point. Fresh narratives ready for Monday open.

**On-demand fallback.** First visit in a new week without cached narrative triggers generation client-side; subsequent views served from cache.

**Render.** `<NarrativeBlock>` component. Italic, indented, bordered with gold left edge. 13px line-height 1.6.

### 3.2 — Per-security factor lens

**New section on Security Detail page** between MarketDataPanel and Notes.

**Three pieces:**

1. **Qualitative profile** — read from existing `security_factors` table (sector, industry, all 9 factor values).
2. **Quantitative regression** — new `lib/compute/security-regression.ts::computeSecurityRegression(db, securityId, benchmarkSymbol, days=252): SecurityRegression`. Mirrors portfolio-level `computeMarketRegression` for one security. Returns beta, vol, R², correlation to portfolio.
3. **Portfolio share contribution** — for each factor: `position_factor_value × position_value ÷ Σ scope factor exposure`. Answers "if I sold this, here's exactly which factor exposures shift."

**Caching.** `security_regressions` (migration 050): per-(security, benchmark, day). Populated by daily-valuations cron extension. ~60 securities × 1 query each = trivial overhead.

**Component:** `app/dashboard/security/[id]/FactorProfileSection.tsx` — uses existing `<TerminalSection>` primitive.

### 3.3 — Classification drill-down

**Generic component:** `<DrillDownPanel kind="classification|factor|sector|risk" filter={...}>`.

**Trigger surfaces:** classification pie slices, factor heatmap chips, sector tilt buckets, risk-contribution rows. Any UI element representing "this group has N items inside" gets a hover-cue + click-trigger.

**Render.** Slides in from right (desktop, 480px wide), full-screen on mobile. Dismissable. Lists holdings inside the bucket with: ticker · weight · position value · key factor exposures (AI, Reg, Style, Beta) · clickable to Security Detail. Sortable by any column. Plus filter chips ("AI=High", "Beta&gt;1").

**Query:** `lib/queries/drill-down.ts::getHoldingsInBucket(db, scope, dimension, bucketLabel): DrillDownRow[]` — joins `holdings` + `securities` + `security_factors` + `security_regressions` for the cached betas.

### 3.4 — Week-over-week deltas

**Approach:** compute deltas on read — no new snapshot table for v1. Existing compute functions (`computeFactorAnalysis`, `computeRiskMetrics`, `computeFactorTilts`) gain optional `asOfDate` param. API routes call each twice (now, 7d ago) and zip the results into the response.

**Surfaces.** Every metric on every diagnostic card. Format: `↑ +0.04 / 7d` (up arrow + signed magnitude + period). Color-coded **neutral gray by default** for direction-ambiguous metrics (beta down can be good or bad depending on context); explicit green/red only for unambiguous metrics like alpha or return.

**Falls back gracefully.** No 7d-ago data (new portfolio, gap) → badge shows `—`.

**Defer (v2).** If perf bites at multi-account scale (60+ securities × 4 scopes × 2 calls per page load), add nightly `analysis_snapshots` table written by a cron extension to `computeDailyValuations`. Profile first; don't preemptively optimize.

**Component:** `<WeekOverWeekBadge value={delta} kind="neutral|signed">` — tiny pill, 9-10px font.

---

## 4 — Macro Overlay

### 4.1 — Data flow

**Inputs (last 7d, all existing):**
- `research_articles` — sentiment + mentioned_symbols + raw_text
- `calendar_events` — actual_value, reaction_snapshot, enriched_at
- `level_alerts` — levels that fired this week
- `security_factors` — your factor exposure profile
- `daily_valuations` — weight per position

**Generation.** Sonnet 4.6 via AI Gateway. New feature key `analysisMacroThemes`. Prompt: "Given the inputs, identify 3-5 macro themes that actually moved markets this week. For each: name, factor mapping (from FACTOR_LABELS), direction (risk-on / off / neutral), 1-sentence summary." Output validated via Zod schema.

**Post-process.** For each theme:
- Look up `factor_label` → user's scope portfolio weight in that factor bucket
- Bucket exposure: low / moderate / high / very-high
- Attach top-3 contributing positions

**Cache.** `analysis_macro_themes` (migration 052): `(week_of, scope)` UNIQUE.

### 4.2 — Render

Workspace card 3. Title: "Macro this week · {scope}". For each theme: sentiment dot · name · "your exposure: {bucket}" · 1-sentence summary with linked tickers · sources line ("3 articles + Mar PCE reaction"). Plus refresh-now button (rate-limited 1/day/scope), expand-to-5, last-week link.

**Component:** `MacroOverlayCard.tsx`.

### 4.3 — Cadence + cost

Generated as part of Sunday 3 PM briefing pipeline. Covers all 4 scopes in one pass. Cost: 4 scopes × 1/wk × ~$0.05 = $0.20/week ≈ $0.85/month. On-demand regen rare.

### 4.4 — Cross-cuts

- **Briefing email integration.** Same themes feed the Sunday briefing's "Macro context" section. One source of truth for "what's hot this week."
- **Cash-Deploy gap prioritization.** When ranking gaps, prefer gaps that go *against* active themes (e.g., active "Tariff escalation high" theme + Healthcare gap → boost Healthcare since it's tariff-neutral).
- **Scenario picker hint.** Active themes pre-highlight relevant scenarios (e.g., active "Tariff escalation week" → Tariff +10pt scenario gets "live now" badge in Construction Mode 2.3).
- **Audit trust.** `source_summary` field stores which articles + events + alerts informed each theme — clickable for receipt.

---

## 5 — Cross-Cutting Concerns

### 5.1 — Data model (5 migrations: 049-053)

```sql
-- 049_benchmark_compositions.sql
CREATE TABLE benchmark_compositions (
  benchmark_symbol TEXT NOT NULL,
  sector TEXT NOT NULL,
  weight REAL NOT NULL,
  market_cap_bucket TEXT,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (benchmark_symbol, sector, market_cap_bucket)
);
-- Seeded one-time from hand-curated CSV: VTI, QQQ, SPY, DIA.
-- Monthly refresh via scripts/refresh-benchmark-compositions.ts (manual or launchd).

-- 050_security_regressions.sql
CREATE TABLE security_regressions (
  security_id INTEGER NOT NULL,
  benchmark_symbol TEXT NOT NULL,
  computed_at_day TEXT NOT NULL,
  beta REAL,
  vol REAL,
  correlation REAL,
  r_squared REAL,
  data_points INTEGER,
  PRIMARY KEY (security_id, benchmark_symbol, computed_at_day),
  FOREIGN KEY (security_id) REFERENCES securities(id)
);
-- Populated by computeDailyValuations cron extension. ~60 ops/day.

-- 051_analysis_narratives.sql
CREATE TABLE analysis_narratives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  surface_key TEXT NOT NULL,
  week_of TEXT NOT NULL,
  narrative_md TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model_used TEXT NOT NULL,
  UNIQUE (scope, surface_key, week_of)
);
-- surface_key examples: 'factor-analysis', 'risk-metrics', 'position-risk', 'factor-heatmap'.

-- 052_analysis_macro_themes.sql
CREATE TABLE analysis_macro_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_of TEXT NOT NULL,
  scope TEXT NOT NULL,
  themes_json TEXT NOT NULL,
  source_summary TEXT,
  generated_at TEXT NOT NULL,
  model_used TEXT NOT NULL,
  UNIQUE (week_of, scope)
);
-- themes_json validated via Zod at write time.

-- 053_construction_caps.sql (no new table — settings rows)
INSERT INTO settings (key, value) VALUES
  ('construction_caps_roth', '{"top1_max":0.10,"top3_max":0.25,"sector_max":0.35,"beta_range":[0.7,1.2]}'),
  ('construction_caps_vanguard', '{"top1_max":0.08,"top3_max":0.22,"sector_max":0.30,"beta_range":[0.7,1.1]}'),
  ('construction_caps_ibkr', '{"top1_max":0.15,"top3_max":0.40,"sector_max":0.45,"beta_range":[0.5,1.5]}'),
  ('construction_caps_all', '{"top1_max":0.10,"top3_max":0.25,"sector_max":0.35,"beta_range":[0.7,1.2]}');
-- User-editable via Settings UI (deferred — not a P1 blocker; defaults are fine for v1).
```

### 5.2 — AI feature keys + cost

**Two new keys in `lib/ai/feature-keys.ts` and `lib/ai/models.ts::FEATURE_MODELS`:**

| Feature Key | Model | Cost/call | Frequency | $/month |
|---|---|---|---|---|
| `analysisFactorNarrative` | `anthropic/${SONNET_MODEL}` | ~$0.005 | 4 surfaces × 4 scopes × 1/wk | ~$0.32 |
| `analysisMacroThemes` | `anthropic/${SONNET_MODEL}` | ~$0.05 | 4 scopes × 1/wk | ~$0.85 |

**Total added: ~$1.20/month.** Negligible vs current run-rate.

**Both route through AI Gateway** (existing infrastructure) with `cf-aig-metadata: {"feature": "<key>"}` for per-feature cost dashboarding. Both use Anthropic native (not Workers AI) — these are reasoning-heavy structured-output tasks where the documented Workers AI gotchas (max-tokens reasoning consumption, JSON-shape auto-parsing) make them unsuitable.

**Caching is the cost moat.** One generation/scope/week regardless of view count. On-demand regen rate-limited 1/day/scope.

### 5.3 — File layout (post-refactor)

The 612-line `AnalysisView.tsx` carves into focused subcomponents under `app/dashboard/components/analysis/`:

```
app/dashboard/components/analysis/
  AnalysisView.tsx              ~150 lines, pure orchestrator
  WorkspacePanel.tsx            Construction-mode trio container
  CashDeployCard.tsx            2.1
  WhatIfCalculator.tsx          2.2
  MacroOverlayCard.tsx          4
  TrustStrip.tsx                1.3
  TrustStripDrawer.tsx          drawer that slides in on cell click
  DiagnosticsGrid.tsx           below-the-fold orchestrator
  ClassificationCard.tsx        existing pie + bar (extracted)
  DrillDownPanel.tsx            3.3 generic panel
  WeekOverWeekBadge.tsx         3.4 tiny pill
  NarrativeBlock.tsx            3.1 italic prose block
```

**Existing components (no file moves):** `FactorAnalysis.tsx`, `FactorHeatmap.tsx`, `RiskMetrics.tsx`, `PositionRisk.tsx`, `ScenarioModeling.tsx`, `FixedIncomeCard.tsx`, `OptionsGreeksCard.tsx`, `OptionsStrategies.tsx`, `ExpirationCalendar.tsx`. They get narrative integration but stay where they are.

**New compute modules:**

```
lib/compute/
  exposure-delta.ts             2.2 What-if engine
  cash-deploy.ts                2.1 allocation solver
  scenario-recipes.ts           2.3 replaces hardcoded preset list
  scenario-confidence.ts        2.3 historical analog CI
  security-regression.ts        3.2 single-name beta
  period-attribution.ts         1.4 contributors / sector / beta-vs-alpha
  twr-reconcile.ts              1.4 statement vs computed TWR
  options-expirations.ts        1.2 decoupled from Greeks compute
```

**New queries:**

```
lib/queries/
  analysis-trust-state.ts       1.3 single-shot trust dimensions
  drill-down.ts                 3.3 holdings-in-bucket
  benchmark-compositions.ts     2.1 ETF sector weights lookup
  analysis-narratives.ts        3.1 cache reads
  analysis-macro-themes.ts      4 cache reads
```

### 5.4 — Testing strategy

**Unit (Vitest, in-memory SQLite):**

- `computeExposureDelta` — multi-leg, scope-aware, sanity flags (~12 tests)
- `computeSecurityRegression` — single-name beta, vol, correlation against benchmark fixture (~6 tests)
- `scenario-recipes` — each of 8 new scenarios with synthetic factor classifications + verified P&L math (~16 tests)
- `reconcileTwrAgainstStatements` — divergence detection at 5bp / 50bp / 500bp boundaries (~4 tests)
- `getAnalysisTrustState` — all 5 dimensions populate correctly with mixed-source fixture (~5 tests)
- **Greeks bug regression** — two-account fixture, statement-source + TWS-source on different dates, assert all positions surface (~3 tests)
- `cash-deploy::suggestAllocation` — gap detection, watchlist filtering, allocation solver (~8 tests)
- `period-attribution` — contributor / sector / beta-vs-alpha decomposition with synthetic returns (~6 tests)

**Integration (API contract tests):**

New endpoints, each with shape contract (Zod) + scope-filter correctness + null-data graceful degradation:
- `/api/analysis/trust-state`
- `/api/analysis/cash-deploy`
- `/api/analysis/what-if` (POST)
- `/api/analysis/macro-themes`
- `/api/analysis/narrative`
- `/api/analysis/drill-down`
- `/api/compute/options-expirations`

**Visual (agent-browser nightly QA extension):**

- Add to existing 8-tab nightly sweep: Workspace, Trust Strip + Drawer, Drill-down panel, Security Detail Factor Profile
- Light + dark mode parity for each
- Mobile (390×844) Workspace cards stacking + drill-down full-screen behavior

**Reconciliation (live data, pre-merge):**

- `scripts/audit-twr-vs-statements.ts` against current DB; assert IBKR computed TWR within 5bp of statement-reported TWR for ≥80% of months
- Cross-check: recomputed factor coverage % matches what Trust Strip surfaces against `getFactorCoverage`

**Test count.** 1766 → ~1850 (+84). Per-phase target: P1 +25, P2 +30, P3 +20, P4 +9.

### 5.5 — Rollout phases

| Phase | Items | Hours | Ship state |
|---|---|---|---|
| **P1 Trust** | Greeks fix · Expirations fix · Trust Strip · Performance audit + reconciliation | ~14h | Page is trustworthy; old layout still default |
| **P2 Construction** | AnalysisView refactor · What-if engine · Cash-Deploy · Replace Scenarios · Workspace becomes default landing | ~28h | Workspace ships value |
| **P3 Narrative** | Factor narratives · per-security factor lens · Classification drill-down · W-o-W deltas | ~16h | Page reads, not just shows |
| **P4 Macro+polish** | Macro overlay · briefing integration · scenario-theme cross-link · final QA | ~12h | Full vision shipped |
| **Total** | | **~70h** | 2-3 weeks at user's pace |

**Phase boundaries are pure delivery rhythm.** The mega-spec locks design coherence; phasing decisions can shift based on what's easy to test and ship in isolation.

**P1 prerequisites.** Run `scripts/audit-twr-vs-statements.ts` against live DB. If divergence exceeds 50bp for &gt;20% of months, expand P1 to include the underlying TWR fix.

### 5.6 — Risks + mitigations

**Confidence-builders (low risk):**
- Greeks bug root-caused; fix is a 30-line query change with known-good pattern
- All AI integrations follow existing `FEATURE_MODELS` + Cloudflare Gateway pattern
- Watchlist + factor classifications + calendar enrichment all already shipping
- Refactor is mechanical; existing 612-line file has clean section boundaries
- Test fixtures exist (in-memory SQLite, multi-account scenarios)

**Real risks:**

1. **ETF composition data sourcing.** No public free API for VTI/QQQ/SPY/DIA sector weights. Mitigation: hand-curated CSV (~30 min one-time + 5 min monthly), `scripts/refresh-benchmark-compositions.ts`, fallback to "by-sector heuristic" if `benchmark_compositions` table is empty (still useful, less accurate).
2. **TWR reconciliation surprises.** If computed TWR diverges &gt;50bp from statement, P1 expands to include the underlying TWR fix. Mitigation: pre-merge audit script blocks P1 ship until reconciled or divergence is documented.
3. **Per-security regression at scale.** ~60 securities × daily compute = 60 ops/day. Backfill of historical betas is one-time ~1 hour. Acceptable.
4. **Macro overlay quality.** Sonnet might generate generic themes if newsletter input is sparse (rare day with few articles). Mitigation: minimum source threshold (≥2 articles or ≥1 enriched event), fallback to "no actionable themes" rather than fabricating. Strict-mode validation in composer (mirrors `lib/digest/synthesize.ts` strict checks).
5. **Visual mockup ≠ implementation reality.** Workspace 3-card layout may need adjustment at narrow widths or with chat right-rail open. Mitigation: agent-browser nightly QA at 390×844, 1024×768, 1280, 1536, plus `[data-chat-rail="open"]` media-query breakpoint following the EarningsHub precedent.

---

## 6 — Open Questions

These are decisions deferred to implementation phase but recorded for traceability:

- **Macro Overlay refresh-now rate-limit storage.** Use existing `last_*` settings keys pattern, or a dedicated `rate_limits` table? Probably settings keys for v1.
- **Drill-down filter state persistence.** Persist filter choices in URL params (shareable) or in-component state (ephemeral)? Default URL params for consistency with Performance/sort param patterns.
- **Per-security regression backfill window.** How far back to compute beta history? Default 252 days (1 year). Storage is cheap; users may want longer for trend analysis later.
- **Construction caps editor in Settings UI.** Defer to post-P4 polish unless user pushes. v1 ships with sensible defaults per scope.
- **Scenario confidence interval method.** Historical analog (proposed) is simplest. Alternative: Monte Carlo from factor return distributions. Defer to P2 implementation; ship analog first, upgrade if needed.
- **W-o-W delta direction-coloring rules.** Most metrics are direction-ambiguous (beta up or down can be good or bad). Default to neutral gray. Explicit green/red for unambiguous metrics: alpha, period return, drawdown improvement.

---

## 7 — Decision Log

| Decision | Choice | Reason |
|---|---|---|
| Single mega-spec vs phased specs | Mega-spec | Coherent design; user precedent (Bloomberg-Amber, evening-email) |
| Default landing | Workspace (was Classification pie) | User's primary use case is portfolio construction, not metric display |
| Tab count | Stay at 6 | 9→6 collapse was deliberate; reversing for "Construct" doesn't earn cost |
| Use case priority | B (decision support), C (weekly review), D (explanation) | User-stated; A (daily check-up) explicitly out |
| Scope ambition | All 13 dials | User: "all. full ambition." |
| AI provider for narratives + themes | Anthropic Sonnet 4.6 | Workers AI gotchas (max-tokens, JSON parsing) make it unsuitable for reasoning-heavy structured output |
| Caching strategy | Per-(scope, week) for narratives + themes | One gen/wk = view-count-independent cost |
| W-o-W deltas storage | Compute on read (v1) | No new schema; defer optimization until measured |
| Scenario replacement | Factor-anchored, not market-move-% | Defendable methodology over confident-looking presets |
| ETF composition source | Hand-curated CSV | No free public API; monthly maintenance overhead acceptable |
| Refactor scope | All ~10 subcomponents extracted in P2 | Same campaign; avoid revisiting later |
| Greeks fix approach | Replace global subquery with `LATEST_HOLDINGS_CTE` | Canonical pattern already in codebase |

---

## 8 — Implementation Plan Reference

The implementation plan (separate document) will translate this spec into ordered tasks with explicit files-touched, test counts, and ship gates per phase. Generated via `superpowers:writing-plans` after this spec passes review.
