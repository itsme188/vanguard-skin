# Gains at Risk, Step 1 (the line and the table) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Analysis view, `view=gains`, that shows for an index driver (SPY, QQQ or VTI) and a valuation date the book's profit or loss across a sweep of falling driver moves, with and without the offsetting positions, measured against the year's gain so far on every account.

**Architecture:** Three independent building blocks (time-aware option repricing, a beta-to-the-driver resolver over correctly dated price series, a currency-aware year's-gain function) feed one pure engine, `lib/compute/gains-at-risk.ts`, which reads every held position through a loader shared with the custom scenario engine. A thin POST route wraps the engine; the Analysis page paints the default result on the server and a client component re-requests on every control change through a sequence-numbered reducer that drops stale responses.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, better-sqlite3, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-gains-at-risk-design.md`: build step 1, owner rulings 1-6, and "Rulings after the plan review (2026-11-24)" F1-F20. Steps 2 and 3 are out of scope; the engine input keeps a driver symbol so they can be added, and step 3 adds the direction control (F15).

## Global Constraints

- Read-only over the database. No migration. No new dependency. No AI call.
- Mac-only: no Worker mirror, no snapshot field, no email, no push.
- Synthetic fixtures only (ZZ* tickers, round numbers). No real portfolio figure, and no ticker the owner holds, in any committed file. Task 0 output goes to gitignored `docs/private/` only.
- "Today" is `todayET()`; dates are `YYYY-MM-DD`. Tests that need a fixed day use `vi.setSystemTime` or pass `today`/`now`. Any test that touches `security_regressions` fixes the clock after `REGRESSION_ENGINE_SINCE` (`2026-10-21`); this plan uses `2026-11-10T15:00:00Z`.
- Valuation timing (F16): a valuation date of today means the current instant; a later date means the close of that day.
- An option expiry is read only through `lib/compute/option-expiry.ts` (`liveOptionExpirationSql`, `daysToExpiry`, `normalizeOptionExpiration`) and `isExpiredAsOf` / `yearsToExpiry` in `lib/compute/options-greeks.ts`.
- Risk-free rate only through `getRiskFreeRate(db)`. Transaction currency only through `lib/queries/transaction-amount-currency.ts`.
- Account scope: `undefined` is every account, `[]` is no accounts and reads nothing. Never collapse a scope to its first id.
- `DEFAULT_OPTION_ELASTICITY` and `DEFAULT_FALLBACK_VOL` are never read by new code. No beta is ever divided by an assumed 1.
- Every portfolio dollar, percent or count on screen goes through `<Money>` / `<Pct>` / `<Count>` (`lib/privacy/components.tsx`; `<Pct>` takes percent units, 15 means 15%); chart formatters through `usePrivateFormatter`; editable figures through `<PrivateNumberInput>`.
- The headline label is exactly "Year's gain so far"; no shipped copy says what the figure is used for.
- The page words the split as "offsetting positions", never "hedges". Step 1 shows one direction, down (F15).
- The custom scenario engine, the preset engine, Defense, Diagnostics and What-if keep their figures (pinned in Tasks 1, 2 and 4).
- Tests: `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx vitest run <file>`.
- **Git (F20):** implementer agents never run git. Each task ends by handing back its file list. The controller reviews it, writes the message to a scratchpad file and runs `git commit -F <file> -- <paths>` with exactly that task's paths. Never a bare `git commit`, never `git stash`. Every message ends with the line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- One owner per file (table below). A task edits only the files it owns.

## Review Focus

1. **Valuation date equal to today**, including a contract that expires today before the 16:00 close: the 0% row with no volatility change is exactly zero for every position. Pinned in Task 1 (`valuation date today keeps the identity`).
2. **A contract that expired today after the close**, with a later valuation date: it contributes exactly 0 at every move, is listed under "not modelled" with reason `expired`, and never produces NaN. Pinned in Tasks 1 and 4.
3. **A driver the scope does not hold, and an option on the driver whose underlying has no `securities` row**: no throw; the option's beta is 1 with source `driver` through the real loader; the driver's SPY beta comes from `benchmark_prices` alone. Pinned in Tasks 2 and 4.
4. **A short stock whose name has a negative measured beta**: its exposure to the driver is positive, it sits on the losing side, and its P&L in a -10% move is negative. Pinned in Task 4.
5. **A foreign-currency position**: an unpriced option converts once through `usd_per_unit`; a position in a currency with no `fx_rates` row is not modelled with value unknown (never read as dollars); a foreign in-kind transfer is converted once in the year's gain. Pinned in Tasks 3 and 4.

---

## Dependency graph and file ownership

```
Task 1 ──┐
Task 2 ──┼─ controller commits each, then ONE full suite ─> Task 4 ──┐
Task 3 ──┘                                                            ├─> Task 5 ──> Task 6 ──> Task 7
            Task 3 ──> Task 0(b) (controller) ──────── blocks Task 7 ─┘
            Task 0(a) (controller audit, any time before Task 7; evidence for the decision entry)
```

Tasks 1, 2 and 3 share no file and no data dependency: run them as parallel subagents in one message. The full suite runs once after all three are committed, before Task 4 starts.

| Task | Files it alone may edit |
|---|---|
| 0 | `docs/private/2026-11-24-gains-at-risk-precheck.md` (gitignored, never committed) |
| 1 | `lib/compute/option-reprice.ts`, `tests/compute/option-reprice-valuation-date.test.ts`, `tests/fixtures/option-reprice-legacy-pin.json` |
| 2 | `lib/compute/security-regression.ts`, `lib/compute/driver-beta.ts`, `lib/securities/leveraged-tracked-index.ts`, `tests/compute/security-regression-source-filter.test.ts`, `tests/compute/driver-beta.test.ts` |
| 3 | `lib/compute/flow-adjusted.ts` (new sibling function only), `lib/compute/year-gain.ts`, `tests/compute/flow-adjusted-usd.test.ts`, `tests/compute/year-gain.test.ts` |
| 4 | `lib/compute/scenario-positions.ts`, `lib/compute/scenarios.ts`, `lib/compute/gains-at-risk.ts`, `tests/compute/scenario-positions-pin.test.ts`, `tests/fixtures/custom-scenario-loader-pin.json`, `tests/compute/gains-at-risk.test.ts` |
| 5 | `app/api/compute/gains-at-risk/route.ts`, `lib/analysis/gains-at-risk-input.ts`, `tests/api/compute-gains-at-risk.test.ts` |
| 6 | `lib/analysis/view-param.ts`, `lib/analysis/gains-at-risk-view.ts`, `app/dashboard/analysis/page.tsx`, `app/dashboard/components/AnalysisViewToggle.tsx`, `app/dashboard/components/nav-tabs.ts`, `app/dashboard/components/gains-at-risk/GainsAtRiskSection.tsx`, `app/dashboard/components/gains-at-risk/GainsAtRiskView.tsx`, `app/dashboard/components/gains-at-risk/GainsAtRiskChart.tsx`, `tests/lib/analysis-view-param.test.ts`, `tests/lib/gains-at-risk-view.test.ts`, `tests/dashboard/gains-at-risk-view-source.test.ts` |
| 7 | `docs/DECISIONS.md`, `CLAUDE.md`, `docs/plans/TODO.md` |

---

### Task 0: Pre-checks (controller, read-only)

Nothing here is committed. Results go to `docs/private/2026-11-24-gains-at-risk-precheck.md`. Run read-only queries against a copy made with `npm run backup -- --purpose gains-at-risk-precheck` (never `cp` the live database).

- [ ] **(a) Price-dating audit (F8/F9: evidence, not a gate on a list).** For every series the beta ladder reads (each held security and each option underlying, split by `prices.source`; and the `benchmark_prices` series for SPY, QQQ, VTI and every symbol in `LEVERAGED_TRACKED_INDEX_SEEDS`), compare closes on dates where a `tws` or statement-sourced close exists for the same security and date, and compare same-day against one-session-late return correlation with SPY over 252 days. Each series gets one outcome: **dated right** (same-date closes agree within 0.5% and same-day correlation is the higher), **misdated** (either test fails), or **insufficient evidence** (fewer than 30 overlapping pairs or no authoritative same-date close). Insufficient evidence is never reported as a pass. The outcome table (counts by source, no symbols in any committed file) feeds the decision entry in Task 7. If any non-Plaid series is misdated, stop and raise a `decision` record: the runtime rule in Task 2 excludes Plaid rows only.
- [ ] **(b) IBKR year's gain reconciliation, after Task 3.** Run `computeYearGain(db, { accountIds: [<IBKR account id>] })` on the copy and obtain the broker's own figures for the same period (opening value at Dec 31, closing value at the same as-of date, deposits and withdrawals) from the activity statement or PortfolioAnalyst, read-only. **Pass:** `baseValueUsd` equals the broker's opening value to the cent; `netFlowsUsd` equals the broker's deposits minus withdrawals, or every difference is a named row (an internal-transfer withdrawal per ruling 3, an in-kind leg at stored value, a timing difference at the as-of date); `gainUsd` differs from the broker's figure only by those rows plus the positions-age gap. **Fail:** any unexplained difference over $1 blocks Task 7's landing; record it as a `decision` record.

---

### Task 1: Time-aware repricing

**Files:**
- Modify: `lib/compute/option-reprice.ts:31-56` (`OptionRepriceShock`, `OptionRepriceResult`), `:72-133` (`repriceOptionUnderShock`)
- Create: `tests/fixtures/option-reprice-legacy-pin.json`
- Test: `tests/compute/option-reprice-valuation-date.test.ts`

**Interfaces:**
- Consumes: `yearsToExpiry`, `isExpiredAsOf` (`options-greeks.ts`); `daysToExpiry` (`option-expiry.ts`).
- Produces:
  ```ts
  interface OptionRepriceShock {
    underlyingMove: number; volChange?: number; riskFreeRate: number; today?: string; now?: Date;
    /** YYYY-MM-DD, not before `today`. Today = the current instant; later = that day's close. */
    valuationDate?: string;
    /** With no own price: value both legs from the model at the broker's underlying IV. */
    modelWhenUnpriced?: boolean;
  }
  type OptionPriceSource = "own-price" | "model";
  // The modelled branch carries these keys ONLY when valuationDate or modelWhenUnpriced is passed (F17):
  //   priceSource: OptionPriceSource;
  //   expiresBeforeDate?: true;
  //   v1IfMoveFirst?: number;   // expiresBeforeDate only: intrinsic at the MOVED price, per share
  // v0, v1 stay per-share (pre-multiplier).
  ```

Rules (spec "The engine" item 4 and 5, rulings F4, F16, F17):
- `T0 = yearsToExpiry(expiry, today, now)`; volatility is solved at `T0` exactly as now.
- `valuationDate` absent or equal to `today`: `T1 = T0` (the identity holds, including a same-day contract before the close).
- `valuationDate` after `today`: `d = daysToExpiry(expiry, valuationDate)`. `d > 0`: `v1` = model at moved price, shocked vol, `T1 = d / 365`. `d === 0`: `v1 = intrinsic(S x (1 + move))`. `d < 0`: `v1 = intrinsic(S)` at today's underlying price, `v1IfMoveFirst = intrinsic(S x (1 + move))`, `expiresBeforeDate: true`. The caller picks the worse case for the owner (Task 4).
- `valuationDate` before `today`: throw `Error("valuationDate is before today")`.
- `isExpiredAsOf(expiry, today, now)` still returns `{ modelled: false, reason: "expired" }` whatever `valuationDate` says.
- No own price with `modelWhenUnpriced`: `no-underlying-price` if `S` is missing; `no-volatility` if `underlying_iv` is missing or not positive; else `sigma = underlying_iv`, `ivSource = "broker-underlying"`, `priceSource = "model"`, `v0` and `v1` from the model, `changePercent = v0 > 0 ? max(-1, perShareChange / v0) : 0`. Without the flag the reason stays `no-option-price`.
- The exact-zero shortcut applies only when move is 0, vol is unchanged and `T1 === T0`.

- [ ] **Step 1: Freeze today's outputs.** With the code unchanged, a one-off `npx tsx` command (not committed) runs `repriceOptionUnderShock` over at least 12 synthetic cases (put and call; ITM/ATM/OTM; own-price and broker-underlying sources; moves -0.5, -0.2, 0, +0.2; vol change -0.1, 0, +0.3; a stale quote below intrinsic; each unmodelled reason; a compact `YYYYMMDD` expiry), with `today: "2026-06-01"`, `now: new Date("2026-06-01T15:00:00Z")`, and writes `{ input, shock, result }[]` to the fixture.

- [ ] **Step 2: Write the failing tests:**

```ts
it("legacy pin: without the new options the result is exactly the legacy object", () => {
  for (const c of pin) {
    const r = repriceOptionUnderShock(c.input, c.shock);
    expect(r).toStrictEqual(c.result);
    expect("priceSource" in r).toBe(false);
  }
});
it("valuation date today keeps the identity", () => {
  // move 0, vol 0, valuationDate === today: a 90-day put AND a contract expiring today at 11:00 ET
  expect(r.perShareChange).toBe(0);
});
it("time decay: 0% move at a later date loses on the long, gains on the written", () => {
  // valuationDate today+30, expiry today+90: v1 < v0 for both put and call
});
it("expires on the date: intrinsic at the moved price", () => {
  // K=50 put, S=60, move -0.2, valuationDate === expiry > today: v1 === 2
});
it("expires before the date: both cases are returned and flagged", () => {
  // K=50 put, S=60, move -0.3: v1 === 0, v1IfMoveFirst === 8, expiresBeforeDate === true
});
it("expired after the close is still 'expired' with a valuation date", () => {
  // expiry === today, now 21:00Z: toStrictEqual({ modelled: false, reason: "expired" })
});
it("unpriced option: modelled from the broker IV and flagged", () => {
  // own_price null, underlying_iv 0.3, modelWhenUnpriced: priceSource "model", sigma 0.3, v0 === putPrice(60,50,T,R,0.3)
});
it("unpriced option with no IV is not modelled; the default volatility is never read", () => {
  // { modelled: false, reason: "no-volatility" }; without the flag: reason "no-option-price"
});
it("an own price above the no-arbitrage bound falls back to the broker IV (ivSource tells)", () => {
  // call, own_price 70 with S 60: ivSource "broker-underlying" (Task 4's not-solvable rule reads this)
});
it("valuation date before today throws", () => { expect(() => …).toThrow("valuationDate is before today"); });
```

- [ ] **Step 3: Run to verify they fail.** Expected: the new cases FAIL; the legacy pin PASSES (it is the guard).
- [ ] **Step 4: Implement** the rules in `lib/compute/option-reprice.ts`. `DEFAULT_FALLBACK_VOL` is not imported.
- [ ] **Step 5: Run the new file plus `tests/compute/option-reprice.test.ts`, `tests/compute/scenarios-custom-option-repricing.test.ts`, `tests/compute/scenario-option-engine-parity.test.ts`, `tests/compute/scenario-recipes.test.ts`, `tests/repo/scenario-option-no-linear-fallback.test.ts`.** Expected: all PASS.
- [ ] **Step 6: Hand back** the three files. Controller commits ("Gains at risk: reprice an option at a valuation date and from the model when unpriced").

---

### Task 2: Driver beta

**Files:**
- Modify: `lib/compute/security-regression.ts:45-150` (extract the OLS core; add an optional source filter; add a benchmark-to-benchmark regression)
- Create: `lib/compute/driver-beta.ts`, `lib/securities/leveraged-tracked-index.ts`
- Test: `tests/compute/security-regression-source-filter.test.ts`, `tests/compute/driver-beta.test.ts`

**Interfaces:**
- Consumes: `regressionBetaVerdict` (same file); `getCachedRegression`, `REGRESSION_ENGINE_SINCE` (`lib/queries/security-regressions.ts`); `LeveragedExposure` (`lib/compute/leveraged-fund.ts`).
- Produces:
  ```ts
  // security-regression.ts
  export function computeSecurityRegression(db, securityId, benchmarkSymbol, days = 252,
    opts?: { excludePriceSources?: readonly string[] }): SecurityRegression | null;   // opts absent = today's behaviour
  export function computeBenchmarkRegression(db, symbol: string, againstSymbol: string, days = 252): SecurityRegression | null; // benchmark_prices only

  // leveraged-tracked-index.ts (pattern of LEVERAGE_FACTOR_SEEDS in lib/securities/leverage-factor.ts)
  export const LEVERAGED_TRACKED_INDEX_SEEDS: Readonly<Record<string, string>>;  // fund symbol -> benchmark symbol it tracks
  export function trackedIndexFor(fundSymbol: string): string | null;

  // driver-beta.ts
  export const MEASURED_BETA_EXCLUDED_PRICE_SOURCES = ["plaid"] as const;
  export const REGRESSION_CACHE_MAX_AGE_DAYS = 7;
  export const MIN_USABLE_DRIVER_MARKET_BETA = 0.2;
  export type DriverBetaSource = "driver" | "measured" | "market-converted" | "estimated" | "fixed" | "leveraged";
  export type DriverBetaRefusal =
    | "leveraged-no-factor" | "leveraged-no-tracked-index" | "tracked-index-not-measured" | "no-driver-conversion";
  export type DriverBeta =
    | { beta: number; source: DriverBetaSource }
    | { beta: null; source: "not-modelled"; reason: DriverBetaRefusal };
  export interface DriverBetaInput {
    securityId: number;
    /** equityIdentity(pos).symbol: the underlying for an option, else the row's own symbol. */
    identitySymbol: string;
    /** An option's stored securities.underlying_symbol, kept even when no underlying row exists (F7); else null. */
    storedUnderlyingSymbol: string | null;
    /** securities.id of the identity row; null when not on file. */
    identitySecurityId: number | null;
    leveraged: LeveragedExposure;
    /** The custom engine's fixed beta (cash-equivalent 0, bond 0.1, bond fund with no market move 0), else null. */
    fixedBeta: number | null;
    /** estimateBeta(...) for the identity: a beta to the broad market. */
    heuristicMarketBeta: number;
    /** Leveraged rows: trackedIndexFor(identity symbol). */
    trackedIndexSymbol: string | null;
  }
  export function resolveDriverBeta(db, input: DriverBetaInput, driverSymbol: string, opts?: { today?: string }): DriverBeta;
  export function driverMarketBeta(db, driverSymbol: string, opts?: { today?: string }): number | null; // null = not usable
  ```

Rules, first match wins (symbols trimmed and upper-cased):
1. `leveraged.flagged`: no factor gives `leveraged-no-factor`; no `trackedIndexSymbol` gives `leveraged-no-tracked-index`. Tracked beta is 1 when the tracked index is the driver, else `computeBenchmarkRegression(tracked, driver)` passing `regressionBetaVerdict` (no `benchmark_prices` series or a failed gate gives `tracked-index-not-measured`). `beta = trackedBeta x factor`, source `"leveraged"`. The fund's own regression is never read (F5).
2. `identitySymbol` or `storedUnderlyingSymbol` is the driver: 1, `"driver"`.
3. `fixedBeta !== null`: that value, `"fixed"`.
4. A regression of `identitySecurityId` against the driver passing the gate: `"measured"`.
5. Otherwise the conversion needs `driverMarketBeta`; null gives `no-driver-conversion` (never a divide by 1, F6). The identity's measured SPY regression over the driver market beta: `"market-converted"`; else `heuristicMarketBeta / driverMarketBeta`: `"estimated"`.

`driverMarketBeta`: exactly 1 for SPY; else `computeBenchmarkRegression(driver, "SPY")`, usable only when it passes the gate, is finite and has absolute value at least `MIN_USABLE_DRIVER_MARKET_BETA`. Independent of holdings.

Measured regressions (rules 4 and 5, F8/F9): built only from correctly dated rows, i.e. with `excludePriceSources: MEASURED_BETA_EXCLUDED_PRICE_SOURCES` (`lib/plaid/refresh.ts` stamps every price it writes `source = 'plaid'`, and its mutual-fund rows are dated on Plaid's own as-of date). Too few pairs left means the gate fails and the next rule applies. The cache is read only when the security has no `prices` row with an excluded source inside the window and the cached row's `computedAtDay` is within `REGRESSION_CACHE_MAX_AGE_DAYS` of today (`getCachedRegression` already ignores rows before `REGRESSION_ENGINE_SINCE`); otherwise compute on demand. Never `upsertRegression`: this module writes nothing.

`LEVERAGED_TRACKED_INDEX_SEEDS` ships with entries only on the owner's hand-check (gathered by the controller into the private pre-check file); the plan names none. Its doc comment states the same rule as `LEVERAGE_FACTOR_SEEDS`.

- [ ] **Step 1: Write the failing tests.** Migrated `:memory:` schema; `vi.setSystemTime(new Date("2026-11-10T15:00:00Z"))`; 60 business days of synthetic `benchmark_prices` for SPY, QQQ, VTI and `prices` for ZZ names built as exact multiples (r² = 1).

`tests/compute/security-regression-source-filter.test.ts`:
```ts
it("without opts the result is unchanged", () => { /* toStrictEqual the call without the 5th argument */ });
it("excluded sources are left out of the security series", () => {
  // ZZA: tws rows 1.5x QQQ, plus 'plaid' rows one session late; with the filter beta === 1.5
});
it("too few pairs left returns a failing-gate result or null", () => { /* only 20 tws pairs */ });
it("benchmark-to-benchmark regression reads benchmark_prices only", () => { /* QQQ = 1.25x SPY, no securities rows → 1.25 */ });
```

`tests/compute/driver-beta.test.ts`:
```ts
it("the driver and an option on it are 1, even with no underlying row", () => {
  // identitySecurityId null, storedUnderlyingSymbol "QQQ" → { beta: 1, source: "driver" }
});
it("measured against the driver when the gate passes", () => { /* { beta: 1.5, source: "measured" } */ });
it("market-converted: SPY beta over the driver's benchmark SPY beta", () => { /* ZZB 1.5x SPY, QQQ 1.25x SPY → 1.2 */ });
it("estimated: heuristic over the driver's SPY beta", () => { /* 1.15 / 1.25 = 0.92 */ });
it("no usable driver conversion: not modelled, never divided by 1", () => {
  // no QQQ benchmark rows → { beta: null, source: "not-modelled", reason: "no-driver-conversion" }
  // QQQ beta to SPY 0.1 → same refusal
});
it("fixed values for cash, bonds and bond funds", () => { /* { beta: 0, source: "fixed" } */ });
it("leveraged: tracked beta times the signed factor, never its own regression", () => {
  // own regression vs QQQ seeded at 9; tracked "QQQ", factor 3 → 3; factor -3 → -3
  // tracked "ZZIDX" with benchmark rows 0.8x QQQ, factor 2 → 1.6
  // no factor → leveraged-no-factor; no tracked index → leveraged-no-tracked-index; tracked with no series → tracked-index-not-measured
});
it("plaid-sourced rows never feed a measured beta", () => { /* plaid-only series → falls to market-converted or estimated */ });
it("cache: used at 7 days old, recomputed at 8, ignored when the security has plaid rows", () => {
  // cache beta 2.0 vs computed 1.5; computedAtDay "2026-11-03" → 2.0; "2026-11-02" → 1.5; plaid row in window → 1.5
});
it("cache: a row from before REGRESSION_ENGINE_SINCE is never read", () => { /* computedAtDay "2026-10-20" → 1.5 */ });
it("reads only: no table changes after on-demand computation", () => { /* row counts of security_regressions unchanged */ });
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the regression changes (the existing body becomes a private aligned-series OLS core used by both public functions), the seed module, and `driver-beta.ts`. No import from `lib/compute/scenarios.ts`.
- [ ] **Step 4: Run both files plus `tests/compute/security-regression.test.ts`, `tests/compute/security-regression-split-adjust.test.ts`, `tests/compute/security-regression-backfill.test.ts`.** Expected: PASS.
- [ ] **Step 5: Hand back** the five files. Controller commits ("Gains at risk: beta to the driver from correctly dated series").

---

### Task 3: Year's gain

**Files:**
- Modify: `lib/compute/flow-adjusted.ts` (add `fetchNetFlowsUsdByDate` after `fetchNetFlowsByDate:65-99`; `fetchNetFlowsByDate` itself is unchanged)
- Create: `lib/compute/year-gain.ts`
- Test: `tests/compute/flow-adjusted-usd.test.ts`, `tests/compute/year-gain.test.ts`

**Interfaces:**
- Consumes: `getPortfolioCurrentValues` (`lib/queries/dashboard.ts:297`), `fetchMonthSnapshot` (`lib/compute/monthly-snapshot-utils.ts`), `transactionAmountUsdSql` (`lib/queries/transaction-amount-currency.ts`), `SIGNED_EXTERNAL_FLOW_SQL`'s sign rule, `computeMonthlyPerformance`, `FLOW_AGREEMENT_TOL_USD` (`lib/compute/monthly-performance.ts`).
- Produces:
  ```ts
  // flow-adjusted.ts: same window (start, end], same scope rule; a TRANSFER_OUT signed -ABS; amounts in USD
  // through transactionAmountUsdSql (a USD-stored row as is, a native row times its rate).
  export function fetchNetFlowsUsdByDate(db, accountIds: number[] | undefined, startDate: string, endDate: string):
    { flows: { date: string; net: number }[]; unconvertedCount: number };   // a native row with no fx_rates row is counted, not summed

  // year-gain.ts
  export interface YearGainAccount { accountId: number; name: string; valueUsd: number | null; asOfDate: string | null }
  export interface YearGainResult {
    gainUsd: number | null;
    valueNowUsd: number; baseValueUsd: number; netFlowsUsd: number;
    baseDate: string;                                                  // `${year - 1}-12-31`
    accounts: YearGainAccount[];                                       // each account's value and value date (F14)
    missingBaseAccounts: { accountId: number; name: string }[];
    unusableCurrentAccounts: { accountId: number; name: string; reason: "no-current-value" | "value-before-year" }[]; // F3
    unconvertedFlowAccounts: { accountId: number; name: string; count: number }[];
    reconciliation: { status: "agrees" | "differs" | "not-checked"; throughMonth: string | null; differenceUsd: number | null };
  }
  export function computeYearGain(db, opts: { accountIds?: number[]; today?: string }): YearGainResult;
  ```

Formula per account (year = year of `today ?? todayET()`): current value and as-of date from `getPortfolioCurrentValues(db, accountIds).accounts`; base = `fetchMonthSnapshot(db, id, baseDate).total_value` (statement rows only); flows = `fetchNetFlowsUsdByDate(db, [id], baseDate, asOfDate)` (F1). `gainUsd` is null, with the account listed, when any account has no base, a null current value or an as-of date before Jan 1 of the year (F3), or unconverted flows. `[]` returns before any read: `gainUsd: null`, zeros, empty lists, `not-checked`.

Reconciliation: `throughMonth` = the latest month-end of the year, before `today`, with a statement row for every scoped account (none: `not-checked`). For each month January through `throughMonth`, `computeMonthlyPerformance(db, accountIds, m).blended.gainLoss`; any null gives `not-checked`. Else compare their sum with `Σ(statement at throughMonth - base - USD flows (baseDate, throughMonth])`: `agrees` within `FLOW_AGREEMENT_TOL_USD`, else `differs` with `differenceUsd = statement gain - monthly sum`. What the page does with each status is Task 6's rule (F2).

- [ ] **Step 1: Write the failing tests** (migrated schema; the seeded accounts renamed as in `tests/compute/monthly-performance.test.ts`; `today: "2026-06-15"`).

`tests/compute/flow-adjusted-usd.test.ts`:
```ts
it("a native in-kind leg is converted once", () => {
  // ZZD security currency 'ZZD', fx 0.5; TRANSFER_IN amount 10_000 → net 5_000
});
it("a USD-stored row on a foreign security is not converted again", () => {
  // DEPOSIT 1_000 with security_id on the ZZD security → net 1_000
});
it("a native row with no rate is counted, not summed", () => { /* currency 'ZZQ', no fx row → unconvertedCount 1 */ });
it("fetchNetFlowsByDate is unchanged", () => { /* same seed: raw sum 10_000 as before */ });
```

`tests/compute/year-gain.test.ts`:
```ts
it("value now minus the Dec 31 statement minus the year's USD flows", () => {
  // A1: base 100_000, deposit +10_000 on 2026-03-02, live value 125_000 → gain 15_000
});
it("a withdrawal noted as an internal transfer to another account is an ordinary withdrawal", () => {
  // WITHDRAWAL -20_000, is_external_flow 1, notes "Internal transfer to account ZZ-OTHER": counted as -20_000
});
it("a foreign in-kind transfer is converted", () => { /* TRANSFER_OUT 4_000 ZZD at 0.5 → flows -2_000 */ });
it("a flow with no rate prints no gain and names the account", () => {});
it("a live snapshot on Dec 31 is not a base", () => { /* only 'tws' on 2025-12-31 → gainUsd null, listed */ });
it("an account with no current value, or valued before Jan 1, prints no gain", () => {
  // reasons "no-current-value" and "value-before-year"
});
it("empty scope reads nothing", () => {
  const spy = vi.spyOn(db, "prepare");
  expect(computeYearGain(db, { accountIds: [] }).gainUsd).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});
it("equals the sum of the monthly gains through the last statement month-end", () => {
  // Jan..May statements and ledger flows everywhere: "agrees", differenceUsd 0, throughMonth "2026-05-31"
});
it("differs when the statement shows a deposit the ledger lacks", () => { /* status "differs", differenceUsd !== 0 */ });
it("not checked when a month has no figure", () => {});
it("each account's flows stop at its own as-of date; accounts carry their value dates", () => {});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** `fetchNetFlowsUsdByDate` and `computeYearGain`.
- [ ] **Step 4: Run both files plus every `tests/compute/*flow*` test.** Expected: PASS.
- [ ] **Step 5: Hand back** the four files. Controller commits ("Gains at risk: the year's gain so far, statement-based and in dollars").

**Controller gate after Tasks 1-3:** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH bash scripts/verify.sh full --base main` passes before Task 4 starts.

---

### Task 4: Engine

**Files:**
- Create: `lib/compute/scenario-positions.ts`, `lib/compute/gains-at-risk.ts`, `tests/fixtures/custom-scenario-loader-pin.json`
- Modify: `lib/compute/scenarios.ts:182-289` (the custom engine's query and row type move to the loader; the price filter at `:244` moves into `computeScenario`), `:619` and `:640` (export `isBondFundWithoutMarketMove` and `estimateBeta`, bodies unchanged)
- Test: `tests/compute/scenario-positions-pin.test.ts`, `tests/compute/gains-at-risk.test.ts`

**Interfaces:**
- Consumes: Task 1 (`valuationDate`, `modelWhenUnpriced`, `priceSource`, `expiresBeforeDate`, `v1IfMoveFirst`, `ivSource`); Task 2 (`resolveDriverBeta`, `trackedIndexFor`, `DriverBetaSource`, `DriverBetaRefusal`); `equityIdentity` (`scenario-recipes.ts:690`); `resolveLeveragedExposure`; `isCashEquivalentSecurity`; `getRiskFreeRate`.
- Produces:
  ```ts
  // scenario-positions.ts: ONE SQL builder, two readers; no price filter in either (F10)
  export type ScenarioPositionRow = /* the existing row type, plus: */ {
    total_qty: number; multiplier: number;              // COALESCE(s.multiplier, 1)
    usd_per_unit: number; fx_usd_per_unit: number | null; // COALESCE(fx.usd_per_unit, 1) and the raw rate
    underlying_security_id: number | null;              // s_u.id
    stored_underlying_symbol: string | null;            // s.underlying_symbol, kept when s_u is absent (F7)
  };
  export function loadScenarioPositions(db, accountIds: number[] | undefined): ScenarioPositionRow[];                  // netted by security
  export function loadScenarioPositionsByAccount(db, accountIds: number[] | undefined):
    (ScenarioPositionRow & { account_id: number; account_name: string })[];                                           // F11
  // computeScenario keeps its output by filtering: (own_price ?? 0) > 0 || isOptionSecurityType(security_type)

  // gains-at-risk.ts
  export interface GainsAtRiskInput {
    accountIds?: number[]; driverSymbol: string; valuationDate: string; moves: number[];
    volChangePoints: number; priceOverrides?: Record<number, number>; today?: string; now?: Date;
  }
  export type GainsAtRiskSide = "loses" | "offsets" | "flat";   // the down split, fixed (F15)
  export type GainsAtRiskUnmodelled = DriverBetaRefusal | OptionUnmodelledReason | "no-price" | "no-fx-rate";
  export interface GainsAtRiskPosition {
    accountId: number; accountName: string; securityId: number; symbol: string; name: string | null;
    side: GainsAtRiskSide; beta: number | null; betaSource: DriverBetaSource | "not-modelled";
    assumedMovePerUnitDriver: number | null; pnlByMove: number[];
    priceSource: "own-price" | "model" | "override" | null; modelPricePerShare?: number;
    expiresBeforeDate?: true; expiry?: string; unmodelledReason?: GainsAtRiskUnmodelled;
    overrideRefusal?: "not-positive" | "below-intrinsic" | "row-has-price" | "not-solvable";
    valueUsd: number | null;   // null = value unknown (F12)
    exposureUsd: number;       // dollar change per unit driver move at today's prices
  }
  export interface GainsAtRiskMoveRow { move: number; bookPnlUsd: number; losersPnlUsd: number; offsetsPnlUsd: number }
  export interface GainsAtRiskDisclosure { count: number; shareOfBook: number | null; unknownValueCount: number; symbols: string[] }
  export interface GainsAtRiskResult {
    driverSymbol: string; valuationDate: string; volChangePoints: number;
    grossBookUsd: number; unknownValueCount: number;
    moves: GainsAtRiskMoveRow[]; positions: GainsAtRiskPosition[];
    disclosures: { notModelled: GainsAtRiskDisclosure; betaEstimated: GainsAtRiskDisclosure; pricedFromModel: GainsAtRiskDisclosure; expiresBeforeDate: GainsAtRiskDisclosure };
  }
  export function computeGainsAtRisk(db, input: GainsAtRiskInput): GainsAtRiskResult;
  ```

Rules:
- `[]` returns an empty result before any read. Read `today`/`now` once. Rows: `loadScenarioPositionsByAccount`; P&L is computed per row (linear in quantity, so the sum per security equals the netted figure). Beta per row through `resolveDriverBeta`, memoized by identity; `fixedBeta` and `heuristicMarketBeta` from the exported `estimateBeta` / `isBondFundWithoutMarketMove` with the custom engine's exact arguments; `storedUnderlyingSymbol` from the loader; `trackedIndexSymbol = trackedIndexFor(identity symbol)` for a flagged row.
- A non-USD row with no `fx_rates` row: not modelled `no-fx-rate`, `valueUsd: null`. A non-option with no positive price: not modelled `no-price`, `valueUsd: null`.
- Underlying move = `beta x move`, floored at -1. Stock, fund, bond: `pnl = market_value x underlyingMove`.
- Option: `repriceOptionUnderShock(row, { underlyingMove, volChange: volChangePoints / 100, riskFreeRate, today, now, valuationDate, modelWhenUnpriced: true })`. Own-price rows: `pnl = market_value x changePercent`. Model, override and `expiresBeforeDate` rows: per-share change x `total_qty x multiplier x usd_per_unit`. For `expiresBeforeDate`, compute both `(v1 - v0)` and `(v1IfMoveFirst - v0)` dollars and keep the smaller (the worse for the owner, sign carried by quantity; F4). Unmodelled options: `pnl = 0`, listed, `valueUsd` = market value when priced, else null.
- `priceOverrides[securityId]` (per share) applies only to a row with no own price: `not-positive`, `below-intrinsic` (at today's underlying price), `row-has-price`, and `not-solvable` when the reprice with that price does not return `ivSource === "own-price"` (F13). A refused row keeps the model price. An accepted value becomes `own_price` and `priceSource: "override"`.
- `exposureUsd = (pnl(+0.01) - pnl(-0.01)) / 0.02` at `valuationDate = today`, vol change 0. `side`: positive `loses`, negative `offsets`, zero or not modelled `flat`. For every move, `offsetsPnlUsd` sums the `offsets` rows and `losersPnlUsd` every other row, so `book = losers + offsets` and the chart's second line is `losersPnlUsd` (F15).
- `valueUsd` = market value, or model value for a model-priced row, or accepted override price x signed quantity x multiplier x FX for an override row (never the stored zero). `grossBookUsd = Σ|valueUsd|` over rows with known value, per account row (F11). `shareOfBook = grossBookUsd > 0 ? Σ|known listed values| / grossBookUsd : null`; `unknownValueCount` counts listed rows with `valueUsd: null` (F12). `betaEstimated` counts sources `market-converted` and `estimated`. Counts are per account row; symbols sorted and unique.

- [ ] **Step 1: Freeze the custom engine.** Code unchanged, `vi.setSystemTime(new Date("2026-06-01T15:00:00Z"))`, a synthetic book (stock, ETF with sector weights, money-market fund, bond with duration, bond fund, leveraged fund with and without a factor, long put, short call, unpriced put, unpriced stock, short stock, a `ZZD` currency row with `fx_rates` 0.5, the same security held long in one account and short in another); write `computeScenario` results for `{ marketMove: -0.2 }`, `{ marketMove: 0.1, volMove: 20 }`, `{ marketMove: -0.1, rateMove: 50, sectorMoves: { Technology: -0.25 } }` over scopes `undefined`, `[1]`, `[]` to the fixture with a one-off `npx tsx` command.
- [ ] **Step 2: Write the pin test**: same seed and clock, `expect(computeScenario(db, s, { accountIds })).toStrictEqual(fixture[i])` for every case.
- [ ] **Step 3: Extract** the loader with the added columns and no price filter, move the filter into `computeScenario`, export the two helpers. Run the pin plus every `tests/compute/scenario*.test.ts` and `tests/compute/scenarios*.test.ts`. Expected: PASS, unchanged.
- [ ] **Step 4: Hand back** the loader files (`lib/compute/scenario-positions.ts lib/compute/scenarios.ts tests/compute/scenario-positions-pin.test.ts tests/fixtures/custom-scenario-loader-pin.json`). Controller commits them alone ("Scenarios: share a complete position loader; output pinned unchanged").
- [ ] **Step 5: Write the failing engine tests** (migrated schema, `vi.setSystemTime(new Date("2026-11-10T15:00:00Z"))`, driver QQQ, synthetic `benchmark_prices` and measured series; the leveraged cases `vi.mock("@/lib/securities/leveraged-tracked-index")` with a ZZ entry):

```ts
it("conservation: book = Σ rows = losers + offsets, to the cent, for every move", () => {
  for (const [i, m] of r.moves.entries()) {
    expect(Math.abs(m.bookPnlUsd - sum(r.positions.map((p) => p.pnlByMove[i])))).toBeLessThan(0.005);
    expect(Math.abs(m.bookPnlUsd - (m.losersPnlUsd + m.offsetsPnlUsd))).toBeLessThan(0.005);
  }
});
it("identity at rest: 0% today with no vol change is zero for every position", () => {});
it("time decay: 0% at a later date loses on a long option, gains on a written one, nothing on a stock", () => {});
it("expiry before the date: the worse case for a long put AND for a written put", () => {
  // long put pnl at -20% === lost time value (move after expiry); written OTM put pnl at -20% is the loss of the move-first case
  // both listed under expiresBeforeDate
});
it("expires on the date: intrinsic at the moved price", () => {});
it("leveraged: a 3x fund on the driver moves three times, not nine; an inverse fund gains in a fall", () => {
  // own regression vs QQQ seeded at 9; seed maps ZZ3X → QQQ: assumedMovePerUnitDriver === 3; factor -3 → gain at -10%
});
it("leveraged with a factor but no tracked index is not modelled and listed", () => {});
it("an option on the driver with no underlying row has beta 1 through the loader", () => {});
it("unpriced option: modelled from the broker IV and flagged; with no IV listed with value unknown", () => {
  // pricedFromModel.count 1, valueUsd = v0 x qty x mult x fx; no-IV row: "no-volatility", valueUsd null, unknownValueCount 1
  // accepted override: valueUsd = override x qty x mult x fx and grossBookUsd includes it; clearing the override returns valueUsd and grossBookUsd to the model figures
});
it("an unpriced stock is listed as not modelled, never dropped", () => { /* unmodelledReason "no-price" */ });
it("overrides: accepted, below intrinsic, and above the no-arbitrage bound", () => {
  // {[put]: 4} → "override"; {[ITM put]: 0.01} → "below-intrinsic"; {[call]: 70} with S 60 → "not-solvable", priceSource "model"
});
it("beta source: measured when the gate passes, otherwise estimated, flagged and counted", () => {});
it("gross book is per account: a long and an equal short in two accounts both count", () => {
  // grossBookUsd === 2 x the long's value; two position rows
});
it("a short of a negative-beta name loses in a fall", () => { /* beta -0.5, qty -100: side "loses", pnl at -10% < 0 */ });
it("a foreign-currency unpriced option converts once; a currency with no rate is not modelled", () => {
  // usd_per_unit 0.5: pnl === perShareChange x qty x mult x 0.5; currency 'ZZQ' with no fx row → "no-fx-rate", valueUsd null
});
it("a book of only unknown values prints share null, never 0% or NaN", () => {});
it("expired after the close contributes zero and is listed", () => { /* expiry today, now 21:00Z */ });
it("empty scope reads nothing", () => {
  const spy = vi.spyOn(db, "prepare");
  const r = computeGainsAtRisk(db, { ...input, accountIds: [] });
  expect(spy).not.toHaveBeenCalled(); expect(r.positions).toEqual([]);
});
```

- [ ] **Step 6: Run to verify they fail.** Expected: FAIL, module not found.
- [ ] **Step 7: Implement `computeGainsAtRisk`.**
- [ ] **Step 8: Run the engine tests and the pin.** Expected: PASS.
- [ ] **Step 9: Hand back** `lib/compute/gains-at-risk.ts tests/compute/gains-at-risk.test.ts`. Controller commits ("Gains at risk: engine over the shared position loader").

---

### Task 5: Route

**Files:**
- Create: `app/api/compute/gains-at-risk/route.ts`, `lib/analysis/gains-at-risk-input.ts`
- Test: `tests/api/compute-gains-at-risk.test.ts`

**Interfaces:**
- Consumes: Task 3 `computeYearGain`, `YearGainResult`; Task 4 `computeGainsAtRisk`, `GainsAtRiskResult`; `ANALYSIS_SCOPES` (`lib/analysis/view-param.ts`); `resolveScope` (`lib/queries/accounts.ts:38`, unchanged); `getPositionsFreshness` (`lib/queries/positions-freshness.ts:111`); `VOL_MOVE_MIN`, `VOL_MOVE_MAX`.
- Produces:
  ```ts
  // lib/analysis/gains-at-risk-input.ts (plain module)
  export const GAINS_AT_RISK_DRIVERS = ["SPY", "QQQ", "VTI"] as const;
  export type GainsAtRiskDriver = (typeof GAINS_AT_RISK_DRIVERS)[number];
  export const GAINS_AT_RISK_BOUNDS = { moveAbsMax: 0.6, maxMoves: 41, maxOverrides: 200, maxYearsOut: 2 } as const;
  export interface GainsAtRiskBody { scope: AnalysisScope; driverSymbol: string; valuationDate: string; moves: number[]; volChangePoints: number; priceOverrides?: Record<string, number> }
  export function gainsAtRiskBodyProblem(body: unknown, today: string): string | null;   // null = valid
  export function gainsAtRiskAccountIds(db, scope: AnalysisScope): number[] | undefined;  // "all" → undefined; a token matching no account → []
  export interface GainsAtRiskResponse {
    result: GainsAtRiskResult;
    yearGain: YearGainResult;
    yearGainFreshness: PositionsFreshness;   // ALL accounts (F14)
    scopeFreshness: PositionsFreshness;      // the stress scope
  }
  ```

Validation, one plain sentence naming the field: `scope` is one of `ANALYSIS_SCOPES` (anything else, a non-string or absent: 400, F18); `driverSymbol` in `GAINS_AT_RISK_DRIVERS`; `valuationDate` a real `YYYY-MM-DD` day, not before `today`, not after the same month and day two years on; `moves` a non-empty array of at most 41 finite numbers within -0.6..+0.6; `volChangePoints` finite within `VOL_MOVE_MIN..VOL_MOVE_MAX`; `priceOverrides` absent or an object of at most 200 entries with positive-integer-string keys and finite values (positivity, intrinsic and solvability are the engine's per-row refusals).

Route: parse; `gainsAtRiskBodyProblem(body, todayET())` (400 `{ success: false, error }`); `accountIds = gainsAtRiskAccountIds(db, scope)`; `computeGainsAtRisk`, `computeYearGain(db, {})` (all accounts, ruling 1), `getPositionsFreshness(db, undefined, today)` and `getPositionsFreshness(db, accountIds, today)`. 500 with the message on a throw. The route classifies as `human` by default in `lib/auth/route-policy.ts`, like `/api/compute/scenarios`; no edit to `proxy.ts` (note 2 below).

- [ ] **Step 1: Write the failing tests** (pattern `tests/api/compute-fixed-income.test.ts`: `vi.mock("@/lib/db")` over a migrated `:memory:` db):

```ts
it("returns the engine result, the all-accounts year's gain, and two freshness readings", async () => {
  // scope "ibkr": positions only IBKR rows; yearGain.accounts has all three; yearGainFreshness covers all, scopeFreshness one
});
it.each([
  [{ scope: "everything" }, "scope"], [{ scope: 3 }, "scope"], [{ scope: undefined }, "scope"],
  [{ driverSymbol: "ZZZZ" }, "driverSymbol"],
  [{ moves: [0.7] }, "moves"], [{ moves: Array(42).fill(0) }, "moves"],
  [{ volChangePoints: 61 }, "volChangePoints"],
  [{ valuationDate: "<yesterday>" }, "valuationDate"], [{ valuationDate: "<three years out>" }, "valuationDate"],
  [{ valuationDate: "2026-02-30" }, "valuationDate"],
  [{ priceOverrides: { abc: 1 } }, "priceOverrides"],
])("refuses %o with 400 naming %s", async (patch, field) => { expect(res.status).toBe(400); expect(body.error).toContain(field); });
it("a scope token matching no account returns an empty result, never every account", async () => {
  // rename the Roth account so nothing matches "roth": result.positions [] and every move 0
});
it("accepts a valuation date of today", async () => {});
it("is a human route", () => { expect(classifyRoute("POST", "/api/compute/gains-at-risk")).toBe("human"); });
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL, route not found.
- [ ] **Step 3: Implement** the input module and the route.
- [ ] **Step 4: Run the route test and `tests/auth/route-policy.test.ts`.** Expected: PASS.
- [ ] **Step 5: Hand back** the three files. Controller commits ("Gains at risk: compute route").

---

### Task 6: View

**Files:**
- Modify: `lib/analysis/view-param.ts` (add `"gains"` to `AnalysisSubView` and `resolveAnalysisView`; add `GAINS_AT_RISK_DEFAULT_SCOPE`, `resolveGainsAtRiskScope`), `app/dashboard/analysis/page.tsx` (`VIEW_TITLES.gains = "Analysis · Gains at risk"`; a `resolved.view === "gains"` branch before `"giving"`), `app/dashboard/components/AnalysisViewToggle.tsx` (`{ key: "gains", label: "Gains at risk", query: "view=gains" }` LAST), `app/dashboard/components/nav-tabs.ts` (`{ name: "Gains at risk", href: "/dashboard/analysis?view=gains", matchParam: { key: "view", value: "gains" } }` LAST), `tests/lib/analysis-view-param.test.ts`
- Create: `lib/analysis/gains-at-risk-view.ts`, `app/dashboard/components/gains-at-risk/GainsAtRiskSection.tsx` (server), `GainsAtRiskView.tsx` and `GainsAtRiskChart.tsx` (`"use client"`)
- Test: `tests/lib/gains-at-risk-view.test.ts`, `tests/dashboard/gains-at-risk-view-source.test.ts`

**Interfaces:**
- Consumes: Task 5 `GainsAtRiskResponse`, `GAINS_AT_RISK_DRIVERS`, `gainsAtRiskAccountIds`; Tasks 3 and 4 directly for the first paint; `positionsFreshnessCell` (`lib/ui/positions-freshness-label.ts`); `readMutationResult`, `networkFailureMessage` (`lib/ui/mutation-result.ts`); `apiFetch` (`lib/http/apiFetch`).
- Produces (`lib/analysis/gains-at-risk-view.ts`, plain module, no React):
  ```ts
  export const DEFAULT_DRIVER: GainsAtRiskDriver = "QQQ";
  export const TABLE_MOVES = [0, -0.05, -0.1, -0.15] as const;
  export function defaultSweep(): number[];                     // (-200 + 25i) / 1000, i = 0..12 (chart may run to +10%)
  export function defaultValuationDate(today: string): string;  // `${year}-12-31`
  export function customMoveProblem(move: number): string | null; // must be finite, ≤ 0, ≥ -0.6 (F15)
  export function requestMoves(sweep: number[], custom: number | null): number[]; // sweep ∪ table ∪ custom, sorted, unique
  export function gainGivenBackShare(bookPnlUsd: number, yearGain: YearGainResult): number | null; // -book / gain; null unless gain > 0 and status !== "differs" (F2)
  export function gainKeptShare(bookPnlUsd: number, yearGain: YearGainResult): number | null;      // 1 + book / gain; same nulls
  export function yearGainNote(g: YearGainResult): string | null; // missing base / unusable value / unconverted flow (names accounts), gain not positive, "differs" (why no ratio), "not-checked" (ratio kept, note)
  export const YEAR_GAIN_LABEL = "Year's gain so far";
  export const COLUMN_LABELS = { move: "move", losers: "Positions that lose", offsets: "Offsets give back", book: "Book", givenBack: "Gain given back" } as const;
  export const LINE_LABELS = { book: "book", without: "without the offsetting positions" } as const;
  export function disclosureSentences(d: GainsAtRiskResult["disclosures"]): { key: string; text: string; count: number; shareOfBook: number | null; unknownValueCount: number }[];
  // Stale-result guard as a pure reducer (F19)
  export type GainsRequestState = { latestSeq: number; result: GainsAtRiskResponse | null; error: string | null; loading: boolean };
  export type GainsRequestAction =
    | { type: "start"; seq: number } | { type: "success"; seq: number; data: GainsAtRiskResponse }
    | { type: "failure"; seq: number; message: string } | { type: "reset"; data: GainsAtRiskResponse };
  export function gainsRequestReducer(state: GainsRequestState, action: GainsRequestAction): GainsRequestState;
  ```
  `view-param.ts`: `GAINS_AT_RISK_DEFAULT_SCOPE: AnalysisScope = "all"`; `resolveGainsAtRiskScope(scope?: string): AnalysisScope` (ruling 1; `DEFAULT_ANALYSIS_SCOPE` stays `"vanguard"`).

Screen (spec "The screen", rulings F2, F14, F15): stress-scope pills (links `?view=gains&scope=<key>`); headline "Year's gain so far" through `<Money>`, beside it the all-accounts freshness cell and each account's value date, and the reconciliation line ("agrees with the statements through <month>", the difference through `<Money>`, or "not checked"); controls: driver select, date input (min today), vol change in points; the line chart (x: driver move; y: P&L dollars; series `bookPnlUsd` and `losersPnlUsd`; a right-hand "gain kept" axis only when `gainKeptShare` is non-null; ticks and tooltips through `usePrivateFormatter`) with the stress-scope freshness cell beside it; the table (rows `TABLE_MOVES` plus a custom row validated by `customMoveProblem`; "Gain given back" through `<Pct>`, hidden with `yearGainNote` shown when null); the per-name table (account, symbol, assumed move per unit driver, beta and source, P&L at the selected row); the four disclosure lines with `<Count>` and `<Pct>`, "share not known" for unknown values; on each `priceSource` `"model"` or `"override"` row a `<PrivateNumberInput>` holding the per-share price, committed on blur or Enter into `priceOverrides` (page state only), a Clear control, and the refusal sentence for `overrideRefusal`. Labels "priced from model", "your price". A short line says step 1 shows falling moves only.

Request rule: every control change dispatches `start` with the next sequence number (the reducer clears `result`), then posts; responses dispatch `success`/`failure` with their own number and the reducer drops any that is not the latest; new server props dispatch `reset`. Errors read through `readMutationResult` / `networkFailureMessage`.

- [ ] **Step 1: Write the failing tests.** `tests/lib/analysis-view-param.test.ts`: `resolveAnalysisView({ view: "gains" })` equals `{ view: "gains", mode: "classification" }`. `tests/lib/gains-at-risk-view.test.ts`:

```ts
expect(defaultSweep()).toEqual([-0.2, -0.175, -0.15, -0.125, -0.1, -0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075, 0.1]);
for (const m of TABLE_MOVES) expect(defaultSweep()).toContain(m);
expect(defaultValuationDate("2026-11-24")).toBe("2026-12-31");
expect(customMoveProblem(0.05)).not.toBeNull(); expect(customMoveProblem(-0.07)).toBeNull();
expect(requestMoves(defaultSweep(), -0.07)).toHaveLength(14);
expect(gainGivenBackShare(-61_000, gain(400_000, "agrees"))).toBeCloseTo(0.1525);
expect(gainGivenBackShare(-61_000, gain(400_000, "not-checked"))).toBeCloseTo(0.1525);
expect(gainGivenBackShare(-61_000, gain(400_000, "differs"))).toBeNull();
expect(gainGivenBackShare(-1, gain(0, "agrees"))).toBeNull(); expect(gainGivenBackShare(-1, gain(null, "agrees"))).toBeNull();
expect(yearGainNote(gain(400_000, "differs"))).toMatch(/statements/);
expect(resolveGainsAtRiskScope(undefined)).toBe("all"); expect(DEFAULT_ANALYSIS_SCOPE).toBe("vanguard");
expect(YEAR_GAIN_LABEL).toBe("Year's gain so far");
// reducer
let s = gainsRequestReducer(init(A), { type: "start", seq: 1 }); expect(s.result).toBeNull();
s = gainsRequestReducer(s, { type: "start", seq: 2 });
expect(gainsRequestReducer(s, { type: "success", seq: 1, data: B })).toBe(s);          // older response dropped
expect(gainsRequestReducer(s, { type: "failure", seq: 1, message: "x" })).toBe(s);
expect(gainsRequestReducer(s, { type: "success", seq: 2, data: C }).result).toBe(C);
expect(gainsRequestReducer(s, { type: "reset", data: D }).result).toBe(D);            // server props win, later responses dropped
```

`tests/dashboard/gains-at-risk-view-source.test.ts` (source pins with `anchorIndex`):
```ts
// page.tsx: the "gains" branch calls resolveGainsAtRiskScope(params.scope) and renders <GainsAtRiskSection
// GainsAtRiskSection.tsx: no "use client"; imports from GainsAtRiskView.tsx only the component name
// GainsAtRiskView.tsx: "use client"; uses gainsRequestReducer via useReducer; <Money, <Pct, <Count, PrivateNumberInput,
//   apiFetch, readMutationResult; dispatches { type: "start" before apiFetch(
// GainsAtRiskChart.tsx: every tickFormatter / formatter is a usePrivateFormatter result; the second series reads losersPnlUsd
// no string literal in the view files or lib/analysis/gains-at-risk-*.ts matches /\bhedges?\b/i
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the view-param entries, the page branch (passes `resolveGainsAtRiskScope(params.scope)`; `tests/lib/analysis-default-scope.test.ts` forbids a literal `: "all";` in `page.tsx`), the toggle and nav entries, the server section (calls the engine with the defaults, `computeYearGain(db, {})` and both freshness readings, and passes them as the client's initial state) and the two client components.
- [ ] **Step 4: Run the three test files plus `tests/lib/analysis-default-scope.test.ts`, `tests/dashboard/tab-dropdown-preserved-params.test.ts`, `tests/dashboard/nav-chrome-b25.test.ts`, `tests/dashboard/analysis-scope-memory.test.ts`, and `tests/repo/`.** Expected: PASS.
- [ ] **Step 5: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build`** (seat an already-migrated `data/vanguard.db` copy in the worktree first, per CLAUDE.md). Expected: build completes.
- [ ] **Step 6: Hand back** the Task 6 files. Controller commits ("Gains at risk: the Analysis view").

---

### Task 7: Verification and docs

**Files:**
- Modify: `docs/DECISIONS.md`, `CLAUDE.md`, `docs/plans/TODO.md`

- [ ] **Step 1:** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npm run verify:changed`, then `npm run verify:smoke`. Expected: both pass.
- [ ] **Step 2:** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx next build`. Expected: build completes.
- [ ] **Step 3:** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH bash scripts/verify.sh full --base main`. Expected: `result=passed`; report the test count.
- [ ] **Step 4: Browser pass** on a sandbox copy (`npm run -s sandbox -- up --task <task>`). No scope opens on All. For each scope pill: the line and table render; the headline keeps the all-accounts gain and its freshness while the line's freshness follows the scope. Date set to today: the 0% row reads exactly $0 everywhere. A later date: the 0% row is non-zero when options are held. A positive custom move is refused with its sentence. Type a price in a "priced from model" row: the flag reads "your price" and the line moves; a price below intrinsic and one above the stock price each show their refusal; Clear restores the model price. Change a control twice quickly: only the last result shows. Privacy toggle on: every figure, tick, tooltip and the edit box are masked. Check the always-dark chart panel on a light page. Screenshots to `docs/private/`.
- [ ] **Step 5: Docs.** `docs/DECISIONS.md` entry "2026-11-24 Gains at risk, step 1": the down split by exposure sign; the beta ladder, the Plaid price-source exclusion with Task 0(a)'s outcome counts, the driver conversion from `benchmark_prices` and its 0.2 floor, the tracked-index seed; the year's gain in dollars (F1-F3) and the ratio rule (F2); the expiry-before-date worse case (F4); valuation timing (F16); the unpriced-option model price and override (F13); the stated limits (spec "Known limits"); notes 1 and 2 below. `CLAUDE.md`: a short rule block under Conventions (one reader each: `computeGainsAtRisk`, `resolveDriverBeta`, `computeYearGain`, `fetchNetFlowsUsdByDate`, `loadScenarioPositions` / `loadScenarioPositionsByAccount`; the legacy reprice shape when no new option is passed; no beta divided by an assumed 1; a measured beta never reads `plaid` price rows; "Year's gain so far" is the only label; default scope "all" by ruling). `docs/plans/TODO.md`: step 1 landed; steps 2 and 3 open (step 3 adds the direction control); tracked-index seed entries pending the owner's hand-check if any are missing; Task 0 follow-ups.
- [ ] **Step 6: Hand back.** Controller commits the three docs ("Gains at risk step 1: decision entry, rule block, TODO"). No deploy step.

---

## Self-review

- **Spec coverage:** screen (Task 6); engine items 1-6 (Tasks 1, 2, 4); offsetting split, down only (Task 4, F15); year's gain and reconciliation (Task 3); owner rulings 1 (Tasks 5, 6), 2 (Task 6 label), 3 (Task 3 test), 4 (Task 0(b), F14 freshness in Tasks 5-6), 5 (Tasks 1, 4, 6), 6 (Tasks 2, 4). Plan-review rulings: F1, F3 Task 3; F2 Tasks 3, 6; F4 Tasks 1, 4; F5, F6, F8/F9 Task 2 (+ Task 0(a) audit); F7, F10-F13 Task 4; F14, F18 Task 5 (+ Task 6 display); F15 Tasks 4, 6; F16, F17 Task 1; F19 Tasks 2, 3, 4, 6; F20 header and every hand-back step. Named spec tests are all in Tasks 1-4; trial-leg tests belong to step 2.
- **Types:** `priceSource`, `v1IfMoveFirst`, `DriverBetaRefusal`, `ScenarioPositionRow`, `GainsAtRiskResult` (no `sweepDirection`, no `withoutOffsetsPnlUsd`, no `trackedBetaEstimated`, no exclusion set), `YearGainResult` with `accounts` / `unusableCurrentAccounts` / `unconvertedFlowAccounts`, and `GainsAtRiskResponse` with two freshness fields are each defined once and used with the same names downstream.
- **Steps:** every code step names its signature and pinned values; no function bodies; every task ends in a hand-back, never a git command by the implementer.
- **Proportion:** signatures and assertions only.

## Notes (no conflict with the contract)

1. **Task 2 does not call `estimateBeta` itself.** `estimateBeta` and `isBondFundWithoutMarketMove` are private to `lib/compute/scenarios.ts`, which Task 4 owns; to keep Tasks 1-3 parallel with one owner per file, the caller passes `heuristicMarketBeta` and `fixedBeta` in the input, and Task 4 exports the two helpers unchanged.
2. **No `proxy.ts` edit.** `proxy.ts` delegates to `classifyRoute` (`lib/auth/route-policy.ts`), which defaults every route not on an allowlist to `human`; `/api/compute/scenarios` is classified that way. Task 5 pins `classifyRoute("POST", "/api/compute/gains-at-risk") === "human"`.
3. **A position in a currency with no `fx_rates` row is not modelled** (Task 4) rather than read at the repo's 1.0 placeholder, because a missing rate would print a native figure as dollars on a page about losses. An existing `fx_rates` row is used as stored.
4. **A foreign in-kind leg converts at the stored rate in `fx_rates`**, the repo's one-rate convention, not a transfer-date rate. Stated as a known limit in the decision entry.

## OPEN — conflicts with the contract

None.
