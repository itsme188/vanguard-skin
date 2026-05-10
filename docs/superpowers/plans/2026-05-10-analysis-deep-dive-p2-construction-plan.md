# Analysis Deep Dive — Phase 2 (Construction) Implementation Plan

**Goal:** Make Workspace (construction mode) the new center of gravity for `/dashboard/analysis`. Three new cards above the fold (Cash-Deploy, What-if Calculator, Macro Overlay placeholder), replace the 9 arbitrary scenario presets with 8 factor-anchored recipes, refactor `AnalysisView.tsx` (612 lines → ~10 focused subcomponents), flip default landing.

**Architecture:** Five vertical slices, each shippable and committable independently.

- **Slice A** — Refactor `AnalysisView.tsx`. No behavior change. Extracts MetricCard, ClassificationCard, FactorModeCard. Enables every other slice to slot focused components into a clean shell.
- **Slice B** — What-if Calculator engine (`lib/compute/exposure-delta.ts`) + `/api/analysis/what-if` + `WhatIfCalculator.tsx`. Pure compute over a synthetic HoldingsView. Used internally by Cash-Deploy in Slice C.
- **Slice C** — Cash-Deploy. Migration 049 `benchmark_compositions` + hand-curated seed + `lib/compute/cash-deploy.ts::suggestAllocation` + `/api/analysis/cash-deploy` + `CashDeployCard.tsx`. Graceful fallback ("by-sector heuristic") when composition table is empty.
- **Slice D** — Replace `lib/compute/scenarios.ts` with `lib/compute/scenario-recipes.ts`: 8 factor-anchored scenarios with per-factor sensitivity multipliers. Optional `scenario-confidence.ts` (historical analog CI) deferred to P3 unless trivial. Wire to existing `ScenarioModelingCard`.
- **Slice E** — Wire Workspace as the default landing. `?mode=classification|factors` redirect to new default. Old iPhone bookmarks land on Workspace; old query strings honored only when explicitly requested.

**Spec:** [docs/superpowers/specs/2026-05-10-analysis-deep-dive-design.md](../specs/2026-05-10-analysis-deep-dive-design.md) (Section 2, 5.1, 5.3)

**Phase ship target:** ~28h, +30 tests (1791 → ~1821).

---

## File Structure (P2)

**Create:**
- `lib/db/migrations/049_construction_caps.sql` — seed `settings` rows for per-scope caps (needed by Slice B flags + Slice C solver)
- `lib/db/migrations/050_benchmark_compositions.sql`
- `lib/compute/exposure-delta.ts` — What-if engine, pure function over synthetic holdings view
- `lib/compute/cash-deploy.ts` — gap detection + allocation solver
- `lib/compute/scenario-recipes.ts` — 8 factor-anchored scenarios + per-bucket shock multipliers
- `lib/queries/benchmark-compositions.ts` — read seeded composition rows
- `lib/queries/construction-caps.ts` — read per-scope caps from settings
- `app/api/analysis/what-if/route.ts` — POST with hypothetical legs, returns ExposureDelta
- `app/api/analysis/cash-deploy/route.ts` — GET with scope + cashAmount, returns CashDeploySuggestion
- `app/dashboard/components/analysis/WorkspacePanel.tsx` — Construction-mode trio container
- `app/dashboard/components/analysis/CashDeployCard.tsx`
- `app/dashboard/components/analysis/WhatIfCalculator.tsx`
- `app/dashboard/components/analysis/MacroOverlayPlaceholder.tsx` — empty-state shell; full overlay in P4
- `app/dashboard/components/analysis/MetricCard.tsx` — extracted from AnalysisView
- `app/dashboard/components/analysis/ClassificationCard.tsx` — extracted (pie + table + concentration + coverage)
- `app/dashboard/components/analysis/FactorModeCard.tsx` — extracted (pie + table + heatmap + factor coverage)
- `scripts/seed-benchmark-compositions.ts` — one-time seed from hand-curated CSV
- `tests/compute/exposure-delta.test.ts` (~12 tests)
- `tests/compute/cash-deploy.test.ts` (~8 tests)
- `tests/compute/scenario-recipes.test.ts` (~16 tests)
- Tests for the route shapes (contract tests)

**Modify:**
- `lib/compute/scenarios.ts` — keep `ScenarioResult` + `PositionImpact` types; reroute `computeScenario` to use new factor recipes when scenario.id matches a recipe, fall through to legacy logic for any custom one-off
- `app/dashboard/components/AnalysisView.tsx` — strip extracted code, keep only orchestration; rename to `DiagnosticsGrid` mentally but keep filename to avoid huge diff churn
- `app/dashboard/analysis/page.tsx` — workspace becomes default; redirect legacy `?mode=` params

**Test target:** +30. P1 final was 1791; target 1821.

---

## Conventions (read once, apply throughout)

- **All DB queries take `db: Database.Database`** (DI for in-memory tests).
- **Scope resolution:** use `resolveScope(db, scope)` from `lib/queries/accounts.ts`.
- **Per-(account, security) latest-holdings CTE** (Slice A precedent from P1): MAX keys on BOTH `account_id` AND `security_id`, filter `quantity != 0`. Both What-if and Cash-Deploy must use this shape — otherwise IBKR intra-day rows mask Vanguard statement positions, repeating the Greeks bug.
- **Privacy-aware formatters:** `<Money>` / `<Pct>` / `<Shares>` for portfolio-derived numbers. Public market data (benchmark sector weights, scenario shocks) uses bare `formatPercent`.
- **Commit cadence:** one commit per slice, HEREDOC for messages.

---

## Slice A — AnalysisView refactor (~4h, +2 tests for the extracted components)

Decompose the 612-line `AnalysisView.tsx` into focused subcomponents. No behavior change — same data flow, same props, identical render output.

Extract:
- `MetricCard.tsx` (lines 593-612 of AnalysisView)
- `ClassificationCard.tsx` (lines 432-569: concentration metrics + classification coverage + bar chart, lifts the classification-mode branch wholesale)
- `FactorModeCard.tsx` (lines 394-429: factor heatmap + factor coverage + auto-classify, lifts the factor-mode branch wholesale)
- Top of file (lines 31-97) — constants & helpers stay (single-file utilities used by all extracted components, exported)

Keep the pie chart + breakdown table (lines 284-391) in AnalysisView for now — the chart is the shared visual across both modes and the natural pivot point.

Final AnalysisView shrinks to ~250 lines: orchestrator + scope/mode/dimension pills + shared pie+table + delegates to mode-specific subcomponent + diagnostics-section invocations (which still call existing FactorAnalysisCard, RiskMetrics, etc.).

**Tests:** small smoke test that the page renders with both modes, plus existing tests still pass.

---

## Slice B — What-if Calculator (~6h, +12 tests)

### B1 — Engine: `lib/compute/exposure-delta.ts`

```ts
export interface HypotheticalLeg {
  symbol: string;
  action: "buy" | "sell";
  dollarAmount: number;
}

export interface ExposureSnapshot {
  totalValue: number;
  beta: number; // weighted-average using security_betas (lookback 252)
  factorTilts: Record<FactorColumn, Record<string, number>>; // factor → bucket → weight
  sectorWeights: Record<string, number>;
  topConcentrations: Array<{ symbol: string; weightPct: number }>;
  volEstimate: number;
}

export interface ExposureDelta {
  before: ExposureSnapshot;
  after: ExposureSnapshot;
  flags: Array<{
    severity: "warn" | "error";
    message: string;
    metric: string;
    capValue?: number;
  }>;
}

export function computeExposureDelta(
  db: Database.Database,
  accountIds: number[] | undefined,
  legs: HypotheticalLeg[]
): ExposureDelta
```

**Algorithm:**
1. Build current snapshot from per-(account, security) latest-holdings CTE + latest prices.
2. Compute current factorTilts via the existing factor classification join (mirrors `getAllocationByDimension` for each factor column).
3. Compute beta from `security_betas` (lookback 252), fall back to 1.0 when missing.
4. Apply each leg to a copy of the snapshot: BUY adds `dollarAmount / latest_price` shares to the (synthetic) holdings view; SELL subtracts (clamped at 0). New positions land in a synthetic account_id `-1`. Recompute snapshot.
5. Sanity flags from `construction_caps_<scope>` settings (top1, top3, sector_max, beta_range).

**Tests:** 12 cases — additive leg, subtractive leg, mixed multi-leg, top1 flag, sector-cap flag, beta-out-of-range flag, factor tilt shift detection, missing-price-graceful-degrade, missing-beta-default-1, account-scope correctness, all-accounts scope, empty-legs no-op.

### B2 — Route: `app/api/analysis/what-if/route.ts`

POST body `{ scope: string, legs: HypotheticalLeg[] }`. Returns `ExposureDelta`. Resolves scope via `resolveScope`. Zod-validate body.

### B3 — UI: `WhatIfCalculator.tsx`

Multi-leg input rows + before/after delta panel + flags. Use `<TerminalSection>` primitive for visual consistency with P1.

---

## Slice C — Cash-Deploy (~8h, +8 tests)

### C1 — Migration 049 + 050

```sql
-- 049_benchmark_compositions.sql
CREATE TABLE IF NOT EXISTS benchmark_compositions (
  benchmark_symbol TEXT NOT NULL,
  sector TEXT NOT NULL,
  weight REAL NOT NULL,
  market_cap_bucket TEXT DEFAULT '',
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (benchmark_symbol, sector, market_cap_bucket)
);
CREATE INDEX IF NOT EXISTS idx_benchmark_compositions_symbol ON benchmark_compositions(benchmark_symbol);

-- 050_construction_caps.sql
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('construction_caps_roth',     '{"top1_max":0.10,"top3_max":0.25,"sector_max":0.35,"beta_range":[0.7,1.2]}'),
  ('construction_caps_vanguard', '{"top1_max":0.08,"top3_max":0.22,"sector_max":0.30,"beta_range":[0.7,1.1]}'),
  ('construction_caps_ibkr',     '{"top1_max":0.15,"top3_max":0.40,"sector_max":0.45,"beta_range":[0.5,1.5]}'),
  ('construction_caps_all',      '{"top1_max":0.10,"top3_max":0.25,"sector_max":0.35,"beta_range":[0.7,1.2]}');
```

### C2 — Seed script `scripts/seed-benchmark-compositions.ts`

Hand-curated VTI/QQQ/SPY/DIA sector weights from the latest fund-sheet snapshots. Stored as a constant in the script; idempotent re-runs replace existing rows for that benchmark. **Approximate values OK for v1** — user can refresh monthly. If the composition table is empty at runtime, Cash-Deploy falls back to a "by-sector heuristic" that targets equal-weight across the user's current sectors (still useful, less accurate).

### C3 — `lib/compute/cash-deploy.ts::suggestAllocation`

```ts
export interface CashDeploySuggestion {
  scope: string;
  cashAmount: number;
  benchmarkSymbol: string;
  mode: "benchmark" | "factor_balance" | "heuristic"; // heuristic = fallback
  gaps: Array<{
    sector: string;
    currentWeight: number;
    targetWeight: number;
    gapPp: number; // percentage-point gap, signed
    dollarGap: number;
  }>;
  picks: Array<{
    symbol: string;
    securityId: number | null; // null when from watchlist with no security yet
    sectorTarget: string;
    allocationDollars: number;
    gapClosureScore: number;
    rationale: string;
    exposureDelta: ExposureDelta; // before/after this single pick
  }>;
  totalAllocated: number;
  cashRemaining: number;
  notes: string[];
}
```

**Algorithm:**
1. Compute current sector weights for scope.
2. Look up benchmark sector weights from `benchmark_compositions` (scope-aware via `DEFAULT_BENCHMARK_BY_SCOPE`, in `FactorAnalysis.tsx`).
3. Compute gaps; surface those ≥ 2pp threshold.
4. Pull watchlist names where `group_name` matches `<scope>_buy`.
5. Rank candidates by gap-closure score using `computeExposureDelta` (Slice B engine).
6. Greedy fill cash to top gaps, capped per-name by construction_caps and per-position by remaining cash.
7. Return picks + notes.

**Tests:** 8 cases — basic gap detection, watchlist scope filter, allocation respects construction caps, factor-balance mode toggle, empty watchlist graceful degrade, empty composition table → heuristic mode, zero cash → no picks, scope correctness.

### C4 — Route + UI

`/api/analysis/cash-deploy?scope=&cash=&mode=` returns `CashDeploySuggestion`. `CashDeployCard.tsx` renders gap-bars + candidate picks with inline what-if delta + "deploy" action (writes a note for now; trade execution out of scope).

---

## Slice D — Replace Scenarios (~7h, +16 tests)

### D1 — `lib/compute/scenario-recipes.ts`

```ts
export const FACTOR_SHOCK_SENSITIVITIES = {
  interest_rate_sensitive: { No: 0, Low: 0.10, Moderate: 0.50, High: 1.00, "Very High": 1.50 },
  growth_vs_value: { /* ... */ },
  // ...one entry per FACTOR_COLUMN
} as const;

export interface ScenarioRecipe {
  id: string;
  name: string;
  description: string;
  category: "rate" | "fx" | "tariff" | "ai" | "energy" | "semi" | "healthcare" | "crypto";
  shockMagnitude: number;
  primaryFactor: FactorColumn;
  factorMultipliers?: Partial<Record<FactorColumn, number>>;
  methodology: string;
}

export const SCENARIO_RECIPES: ScenarioRecipe[] = [
  { id: "rate_shock_up_25bp", ... },
  { id: "usd_strength_5pct", ... },
  { id: "tariff_escalation_10pt", ... },
  { id: "ai_capex_pause", ... },
  { id: "oil_shock_10dollar", ... },
  { id: "semi_cycle_minus_15pct", ... },
  { id: "healthcare_reg_shock", ... },
  { id: "crypto_minus_30pct", ... },
];

export function computeRecipeScenario(
  db: Database.Database,
  recipe: ScenarioRecipe,
  accountIds: number[] | undefined
): ScenarioResult
```

Per-position P&L = `position_value × factorBucketMultiplier × shockMagnitude × sign(factor_sensitivity)`. Falls back to legacy beta for unclassified positions.

### D2 — Reroute `computeScenario`

`lib/compute/scenarios.ts::computeScenario` keeps its current signature but checks if `scenario.id` is in `SCENARIO_RECIPES` first — if so, dispatches to `computeRecipeScenario`. Custom scenarios from the POST endpoint still flow through legacy path. `PRESET_SCENARIOS` array updates to expose the 8 new recipe ids as `ScenarioDefinition` (computed from `SCENARIO_RECIPES`).

### D3 — UI hook: existing `ScenarioModelingCard` unchanged

The card renders preset scenarios via id; it's data-driven from `PRESET_SCENARIOS` already. Methodology gets surfaced in a small expand-on-click block per scenario card.

**Tests:** 8 recipes × 2 cases each (mainline + edge) — synthetic 3-security portfolio with verified factor classifications, expected per-position P&L computed by hand.

---

## Slice E — Workspace default landing (~3h, +2 tests)

### E1 — Page restructure

`app/dashboard/analysis/page.tsx`:
- Default render: `WorkspacePanel` (3 cards) above the fold + `DiagnosticsGrid` (existing AnalysisView contents) below
- When `?mode=classification|factors` is present, render legacy AnalysisView layout (Trust Strip still on top)
- `?view=performance` and `?view=trade-reviews` unchanged from P1

### E2 — URL redirects

No hard redirects (preserve iPhone bookmarks). Just: when no `?mode=` param, render new Workspace layout. When `?mode=classification` or `?mode=factors` is explicit, render legacy. This is the "land gracefully on Workspace" behavior the spec calls for.

### E3 — Tests

Smoke test: page renders Workspace by default; renders legacy layout when `?mode=classification`.

---

## Ship Gates

- Run `npx vitest run` after every slice; numbers must climb monotonically.
- Pre-merge: run TypeScript build (`npx tsc --noEmit`) for the modified files.
- Slice C requires Slice B to be merged first (cash-deploy depends on what-if engine).
- No new launchd plists, no new env vars, no new AI calls in this phase. (Narrative + macro overlay AI integration is Phase 3/4.)

## Deferred from spec to P3/P4

- Macro Overlay AI generation (P4)
- Factor narratives AI (P3)
- Per-security factor lens on Security Detail (P3)
- Classification drill-down panel (P3)
- Week-over-week deltas (P3)
- Scenario confidence intervals via historical analog (P3 — ship without first; analog CI is enhancement, not blocker)
- Construction caps editor in Settings UI (post-P4 polish)

These are all out-of-scope for P2 ship.
