# Gains at Risk, Step 1 Addendum: Betas from Daily Closes, Two Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the engine's unusable measured betas with betas from true daily closes on both legs, remove every estimated rung, return a measured case and a selloff case with an owner's per-name figure, and capture the daily bars the betas need.

**Architecture:** A bar-to-bar regression in `lib/compute/security-regression.ts` reads `ohlcv_bars` daily bars for the security AND for the driver, with a residual outlier guard, and always returns its evidence and reason. `resolveDriverBeta` loses its conversion rungs. `computeGainsAtRisk` runs every position under two beta sets. A capped step after each TWS sync keeps `ohlcv_bars` correct (trailing overlap refetched, basis changes detected), and a one-shot script does the first fill.

**Tech Stack:** Next.js 16, TypeScript 5, better-sqlite3, `@stoqey/ib`, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-gains-at-risk-design.md`, section "Rulings after the first run on real data (2026-11-24)": B1-B7 and the review rulings C1-C14, which win over earlier sections. Base plan: `docs/superpowers/plans/2026-11-24-gains-at-risk-step1.md` (Tasks 1-5 committed; Task 6 in progress).

## Global Constraints

- Every Global Constraint of the base plan still binds (read-only engine, no migration, no new dependency, no AI call, Mac-only, synthetic ZZ* fixtures only and no ticker the owner holds, `todayET()`, option expiry only through `lib/compute/option-expiry.ts`, `getRiskFreeRate(db)`, scope semantics, privacy components, the exact label "Year's gain so far", never "hedge", the test command prefix `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH`).
- **F20 git rule:** implementer agents never run git. Each task hands back its file list; the controller reviews and commits with `git commit -F <file> -- <paths>`, message ending `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- **Order (C11):** base Task 6 is committed before A2 starts. A1 and A4 may run before that. A2, A3 and A5 land as three consecutive commits after one `npx tsc --noEmit` over all three and the full suite.
- This engine reads no `benchmark_prices` row and no `prices` row for a beta (C3, B1). Both legs of every bar regression come from `ohlcv_bars` (`bar_size = '1 day'`, `PRICED_BAR_SQL`), dated before the injected `today`.
- Not changed: `computeSecurityRegression` and `computeBenchmarkRegression` for their callers, `security_regressions`, `isSplitSignatureReturnPair`, `security_betas`, Defense, the custom scenario engine, `lib/tws/benchmark.ts`.
- The capture writes only `ohlcv_bars`, only from TWS, through the existing bad-bar guard. No third-party price source for a held security.
- The selloff case is labelled an assumption on every surface.

## Review Focus

1. **A partial bar for today stored by the Charts page, still there tomorrow**: the next capture replaces it with the true close, and until then a corrupt or partial latest row never marks the security fresh. Pinned in A4.
2. **A split between two captures**: the overlap shows a basis change, the full two years are refetched and replaced in one transaction, and no series mixes bases. Pinned in A4.
3. **A driver whose daily bars are not on file**: every measured-candidate row reports `driver-bars-missing`; nothing falls back to `benchmark_prices`. Pinned in A1 and A2.
4. **An option on a name with no measured link, measured case, valuation date in a month**: the underlying is held unchanged, a long option still loses time value and a written one still gains it. Pinned in A2.
5. **An underlying held only through options**: one owner's figure keyed by `identitySecurityId` moves every option on it in both cases. Pinned in A2 and A5.

---

## Dependency graph and file ownership

```
A1 ─────────────────┐
A4 (parallel) ──────┼──────────────────────────────┐
base Task 6 committed ──> A2 (needs A1) ──> A3 ──> A5 ──> A6 (controller, needs A4) ──> A7
```

| Task | Files it alone may edit |
|---|---|
| A1 | `lib/compute/security-regression.ts`, `tests/compute/security-regression-daily-bars.test.ts` |
| A2 | `lib/analysis/gains-at-risk-constants.ts` (new, import-free), `lib/compute/driver-beta.ts`, `lib/compute/gains-at-risk.ts`, `tests/compute/driver-beta.test.ts`, `tests/compute/gains-at-risk.test.ts` |
| A3 | `lib/analysis/gains-at-risk-input.ts`, `app/api/compute/gains-at-risk/route.ts`, `tests/api/compute-gains-at-risk.test.ts` |
| A4 | `lib/tws/daily-bar-capture.ts` (new), `lib/tws/ohlcv.ts`, `lib/queries/ohlcv.ts`, `lib/mutations/ohlcv.ts`, `lib/tws/auto-refresh.ts`, `scripts/backfill-daily-bars.ts` (new), `tests/tws/daily-bar-capture.test.ts`, `tests/scripts/backfill-daily-bars.test.ts` |
| A5 | the base plan's Task 6 files (`lib/analysis/gains-at-risk-view.ts`, `app/dashboard/components/gains-at-risk/*.tsx`, `tests/lib/gains-at-risk-view.test.ts`, `tests/dashboard/gains-at-risk-view-source.test.ts`) |
| A6 | `docs/private/2026-11-24-gains-at-risk-betas-check.md` and a throwaway script under `docs/private/` (gitignored, never committed) |
| A7 | `docs/DECISIONS.md`, `CLAUDE.md`, `docs/plans/TODO.md` (folds into the base plan's Task 7) |

---

### Task A1: Bar-to-bar regression with evidence

**Files:**
- Modify: `lib/compute/security-regression.ts` (the private `regressAlignedSeries` is split into a pair builder that also counts what it drops, and the existing OLS; both existing public functions keep their exact results)
- Test: `tests/compute/security-regression-daily-bars.test.ts`

**Interfaces:**
- Consumes: `getOhlcvBars(db, id, "1 day", { startDate })` (`lib/queries/ohlcv.ts`, priced bars only); `securities.currency`.
- Produces:
  ```ts
  export const DAILY_BAR_WINDOW_DAYS = 730;
  export const DAILY_BAR_MIN_PAIRS = 60;
  export const DAILY_BAR_MIN_R_SQUARED = 0.1;
  export const OUTLIER_RESIDUAL_LOG_BOUND = 0.35;
  export const MAX_RETURN_GAP_DAYS = 7;   // exported for the boundary test; value unchanged
  export type NoMeasuredLinkReason =
    | "foreign-session" | "driver-bars-missing" | "no-daily-bars" | "short-history" | "flat-driver" | "low-fit";
  export interface DailyBarEvidence {
    outcome: "measured" | NoMeasuredLinkReason;
    beta: number | null; rSquared: number | null;          // set whenever OLS could run
    pairs: number;                                         // aligned pairs kept after both guards
    securityBars: number; driverBars: number;              // priced bars in the window
    droppedOutlierPairs: number; droppedGapPairs: number;
    firstDate: string | null; lastDate: string | null;     // of the pairs kept
  }
  export function isOutlierReturnPair(securityLogReturn: number, driverLogReturn: number): boolean; // |rs - rb| > 0.35
  export function isUsSessionSecurity(currency: string | null): boolean;  // UPPER(TRIM(currency ?? 'USD')) === 'USD'
  export function computeDailyBarRegression(db, securityId: number, driverSecurityId: number | null,
    opts?: { days?: number; today?: string }): DailyBarEvidence;
  ```

Rules. Outcome order: `foreign-session` (the security's or driver's currency is not USD, C4); `driver-bars-missing` (`driverSecurityId` null, or no priced driver bar in the window); `no-daily-bars` (no priced security bar in the window); then pairs on dates both series carry, a pair dropped when its dates are more than 7 calendar days apart or by the residual guard; `short-history` (fewer than 60 pairs, including none); `flat-driver` (zero driver variance); `low-fit` (r-squared below 0.10); else `measured`. The window is `[today - 730, today)`, `today` from `opts.today ?? todayET()` for both legs. No `corporate_actions` adjustment (TWS bars are split-adjusted when fetched) and no ratio-shaped split guard on this path.

The residual guard drops a pair whose security and driver log returns differ by more than 0.35. It drops an unrecorded 3:2 (0.405), 2:1 (0.693) or 3:1 (1.099) split when nothing else moved the security that day, and it keeps a day on which both fall together (driver -12%, security -25%: 0.16). It is not a guarantee (C14): a split on a day the security also moved a lot against the driver can partly cancel and pass; such a pair stays in and moves the beta. A4's basis check (C2) is what keeps a split out of stored bars.

- [ ] **Step 1: Write the failing tests** (migrated `:memory:` schema, `vi.setSystemTime(new Date("2026-11-10T15:00:00Z"))`, 400 business days of synthetic daily bars for a ZZQ driver row and ZZ names, exact multiples):

```ts
it("measures bar to bar: ZZA = 1.5x the driver", () => { expect(e).toMatchObject({ outcome: "measured", beta: 1.5, rSquared: 1 }); });
it("reads no prices or benchmark_prices row", () => { /* 3x rows in both tables: beta still 1.5 */ });
it("ignores a bar dated today on either leg", () => { /* lastDate "2026-11-09" */ });
it("drops a 3:1 split on a day the driver falls 4%", () => { expect(e.droppedOutlierPairs).toBe(1); expect(e.beta).toBeCloseTo(1.5, 6); });
it("keeps a crash day on which both fall", () => { /* driver -12%, ZZA -25%: droppedOutlierPairs 0 */ });
it("documented limit: a 3:2 split cancelled by a +40% relative move passes the guard", () => {
  expect(isOutlierReturnPair(Math.log(1.4 / 1.5), 0)).toBe(false);
});
it("each reason", () => {
  // ZZD currency 'ZZC' → "foreign-session"; driverSecurityId null → "driver-bars-missing";
  // no security bars → "no-daily-bars"; bars on dates the driver lacks → "short-history", pairs 0;
  // 59 pairs → "short-history"; constant driver → "flat-driver"; noise → "low-fit"
});
it("gap guard boundary: 7 calendar days kept, 8 dropped", () => { /* droppedGapPairs 0 then 1 */ });
it("the existing regressions are unchanged", () => { /* computeSecurityRegression, computeBenchmarkRegression toStrictEqual pre-change values */ });
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file plus `tests/compute/security-regression*.test.ts`.** Expected: PASS.
- [ ] **Step 5: Hand back** the two files. Controller commits ("Bar-to-bar regression with its evidence and a residual guard").

---

### Task A2: Ladder rework and the two cases

Starts only after base Task 6 is committed (C11).

**Files:**
- Create: `lib/analysis/gains-at-risk-constants.ts` (import-free: `BETA_OVERRIDE_BOUNDS = { min: -5, max: 5, maxEntries: 200 }`; C12)
- Modify: `lib/compute/driver-beta.ts`, `lib/compute/gains-at-risk.ts`
- Test: `tests/compute/driver-beta.test.ts`, `tests/compute/gains-at-risk.test.ts` (assertions for removed sources are rewritten)

**Interfaces:**
- Consumes: A1 (`computeDailyBarRegression`, `DailyBarEvidence`, `NoMeasuredLinkReason`).
- Deleted from `driver-beta.ts`: `MEASURED_BETA_EXCLUDED_PRICE_SOURCES`, `REGRESSION_CACHE_MAX_AGE_DAYS`, `MIN_USABLE_DRIVER_MARKET_BETA`, `driverMarketBeta`, the private `measuredRegression`, `hasExcludedPriceRow` and `usableBeta`, the imports of `getCachedRegression`, `computeSecurityRegression`, `computeBenchmarkRegression` and `regressionBetaVerdict`, the sources `"market-converted"` and `"estimated"`, the refusals `"no-driver-conversion"` and `"no-heuristic-beta"`, and `DriverBetaInput.heuristicMarketBeta`. `estimateBeta` is still called by the engine only for the bond's fixed 0.1.
- Produces:
  ```ts
  // driver-beta.ts
  export type DriverBetaSource = "driver" | "fixed" | "leveraged" | "measured";
  export type DriverBetaRefusal = "leveraged-no-factor" | "leveraged-no-tracked-index" | "tracked-index-not-measured";
  export type DriverBeta =
    | { beta: number; source: "driver" | "fixed" }
    | { beta: number; source: "leveraged"; trackedBeta: number; factor: number; evidence: DailyBarEvidence | null }
    | { beta: number; source: "measured"; evidence: DailyBarEvidence }
    | { beta: null; source: "no-measured-link"; reason: NoMeasuredLinkReason; evidence: DailyBarEvidence }
    | { beta: null; source: "not-modelled"; reason: DriverBetaRefusal };
  /** The securities row whose daily bars stand for a symbol: non-option, ib_con_id set, most priced daily bars. */
  export function barSeriesSecurityId(db, symbol: string): number | null;
  export function resolveDriverBeta(db, input: DriverBetaInput, driverSymbol: string,
    opts: { today?: string; driverSecurityId: number | null }): DriverBeta;

  // gains-at-risk.ts
  export type GainsAtRiskCaseKey = "measured" | "selloff";
  // GainsAtRiskInput gains betaOverrides?: Record<number, number>   (keyed by identitySecurityId, C6)
  export type GainsAtRiskBetaSource = DriverBetaSource | "owner" | "no-measured-link" | "not-modelled";
  export interface GainsAtRiskPositionCase {
    beta: number | null;                       // the underlying's move per unit driver move; 0 = held unchanged
    pnlByMove: number[]; side: GainsAtRiskSide; exposureUsd: number;
  }
  // GainsAtRiskPosition: side, beta, assumedMovePerUnitDriver, pnlByMove, exposureUsd move into
  //   cases: Record<GainsAtRiskCaseKey, GainsAtRiskPositionCase>; it gains
  //   identitySecurityId: number | null; betaSource: GainsAtRiskBetaSource; measuredBeta: number | null;
  //   evidence?: DailyBarEvidence; noMeasuredLinkReason?: NoMeasuredLinkReason;
  //   betaOverrideRefusal?: "fixed-row" | "is-driver" | "out-of-bounds"
  export interface GainsAtRiskCase {
    moves: GainsAtRiskMoveRow[];
    disclosures: {
      notModelled: GainsAtRiskDisclosure;
      noMeasuredLink: GainsAtRiskDisclosure & { reasons: Record<NoMeasuredLinkReason, number> };
      ownerFigure: GainsAtRiskDisclosure;
      pricedFromModel: GainsAtRiskDisclosure;
      expiresBeforeDate: GainsAtRiskDisclosure;
    };
  }
  // GainsAtRiskResult: moves and disclosures move into cases: Record<GainsAtRiskCaseKey, GainsAtRiskCase>; it gains
  //   betaEvidence: { driverBarsThrough: string | null; driverBarsMissing: boolean; namesWaitingForBars: number };
  //   betaOverridesIgnored: number
  ```

Ladder, first match wins: leveraged (tracked index's beta to the driver is 1 when it is the driver, else `computeDailyBarRegression(barSeriesSecurityId(tracked), driverSecurityId)` with outcome `measured`; anything else is `tracked-index-not-measured`; times the signed factor); the driver or an option on it (1); fixed; `computeDailyBarRegression(identitySecurityId, driverSecurityId)` measured; otherwise `no-measured-link` with its reason (`no-daily-bars` when `identitySecurityId` is null). The engine resolves `driverSecurityId = barSeriesSecurityId(db, driver)` once per run.

Per-case beta of a position's identity:

| Row | measured | selloff |
|---|---|---|
| owner's figure (accepted) | the figure | the figure |
| driver | 1 | 1 |
| fixed (cash-equivalent, bond, bond fund) | fixed value | fixed value |
| leveraged | `trackedBeta x factor` | `max(trackedBeta, 1) x factor` |
| measured, equity-like | measured | `max(measured, 1)` (a negative measured beta becomes 1) |
| no measured link (any reason), equity-like | 0: underlying held unchanged, listed | 1, listed |
| not modelled (leveraged refusal, price, FX, option reason) | no P&L, listed | no P&L, listed |

Equity-like is an identity typed stock, ETF or mutual fund (case-insensitive). A beta of 0 means the underlying does not move: a stock or fund row has P&L exactly 0, and an option on it is still repriced at a 0% underlying move for time to the valuation date, the volatility change and expiry (C5). The owner's figure is keyed by `identitySecurityId` (the underlying's id for an option, the row's own otherwise; null when the underlying has no securities row, in which case it cannot be overridden); accepted when finite and within `BETA_OVERRIDE_BOUNDS` on an identity that is neither fixed nor the driver; a key matching no position is ignored and counted in `betaOverridesIgnored`.

Per case: `exposureUsd`, `side`, the losers/offsets split, conservation and every disclosure come from that case's betas. `noMeasuredLink` lists the same rows in both cases. `namesWaitingForBars` counts distinct identities with reason `no-daily-bars` only (C13). Evidence is memoized by identity within one call; nothing is cached across requests.

- [ ] **Step 1: Rewrite the tests.** `driver-beta.test.ts`: the five outcomes; a name with only `prices` and `benchmark_prices` rows → `no-measured-link`, `no-daily-bars`; `driverSecurityId: null` → `driver-bars-missing`; a non-USD name → `foreign-session`; leveraged with tracked index ZZT measured from bars (`trackedBeta 0.8`), and `tracked-index-not-measured` when ZZT has no bars; `barSeriesSecurityId` picks the row with a contract id and the most bars; no table changes. `gains-at-risk.test.ts` keeps every base-plan test run for BOTH cases, and adds:

```ts
it("no measured link: a stock is exactly 0 in measured and moves 1:1 in selloff", () => {});
it("no measured link: options on it are still repriced at a 0% underlying move", () => {
  // valuation date today+30, move -10%: long call pnl < 0 at every move (time decay), written put pnl > 0; same at every move
});
it("selloff floors 0.6 at 1, keeps 1.4, and turns -0.5 into 1", () => {});
it("a short of a negative-beta name loses in measured and offsets in selloff", () => {});
it("an inverse fund still offsets in the selloff case", () => { /* trackedBeta 0.8, factor -2 → selloff beta -2 */ });
it("fixed rows are the same in both cases", () => {});
it("an underlying held only through options takes one owner's figure for all its options", () => {
  // betaOverrides { [underlyingId]: 0.4 }: both option rows betaSource "owner", identitySecurityId === underlyingId, beta 0.4 in both cases
});
it("an owner's figure is refused on a cash fund, the driver, out of bounds; an unknown id is ignored and counted", () => {});
it("driver bars missing: every measured candidate reports driver-bars-missing and betaEvidence.driverBarsMissing", () => {});
it("namesWaitingForBars counts no-daily-bars only", () => { /* one no-daily-bars, one short-history, one foreign-session → 1 */ });
it("conservation holds per case to the cent", () => {});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `gains-at-risk.ts` imports `BETA_OVERRIDE_BOUNDS` from the constants module.
- [ ] **Step 4: Run both files plus `tests/compute/scenario-positions-pin.test.ts`.** Expected: PASS.
- [ ] **Step 5: Hand back** the five files (held for the landing order).

---

### Task A3: Route and input module

**Files:**
- Modify: `lib/analysis/gains-at-risk-input.ts`, `app/api/compute/gains-at-risk/route.ts`
- Test: `tests/api/compute-gains-at-risk.test.ts`

**Interfaces:**
- Consumes: `BETA_OVERRIDE_BOUNDS` from `lib/analysis/gains-at-risk-constants.ts` only (no value import from `lib/compute/gains-at-risk.ts`, C12); A2's `GainsAtRiskResult` as a type import.
- Produces: `GainsAtRiskBody.betaOverrides?: Record<string, number>`; `gainsAtRiskBodyProblem` refuses a non-object, more than 200 entries, a key that is not a positive whole number, or a value that is not finite or outside -5..5, naming `betaOverrides`. The route passes the overrides keyed by id. `GainsAtRiskResponse` keeps its four fields; `result` carries `cases`, `betaEvidence`, `betaOverridesIgnored`.

- [ ] **Step 1: Write the failing tests:** refusals for `[]`, `{ abc: 1 }`, `{ 7: 5.5 }`, `{ 7: null }`, 201 entries (each 400 naming `betaOverrides`); an accepted figure returns `betaSource: "owner"` in both cases; the response carries both cases and `betaEvidence`; a source pin that `gains-at-risk-input.ts` has no non-type import from `@/lib/compute/`.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the route test and `tests/auth/route-policy.test.ts`.** Expected: PASS.
- [ ] **Step 5: Hand back** the three files (held for the landing order).

---

### Task A4: Daily-bar capture and backfill script

**Files:**
- Create: `lib/tws/daily-bar-capture.ts`, `scripts/backfill-daily-bars.ts`
- Modify: `lib/tws/ohlcv.ts` (`FetchOhlcvOptions.maxBarDate`, `store`), `lib/queries/ohlcv.ts` (`getPricedDailyBarRange`, `getPricedDailyCloses`), `lib/mutations/ohlcv.ts` (`replaceDailyBarsInWindow`), `lib/tws/auto-refresh.ts` (Step 7 after Step 6)
- Test: `tests/tws/daily-bar-capture.test.ts`, `tests/scripts/backfill-daily-bars.test.ts`

**Interfaces:**
- Consumes: `fetchOhlcvBars` and its global OHLCV limiter (55 per 10 minutes, 500 ms pacing); the bad-bar guard in `upsertOhlcvBars`; `getIbApi`, `connectTws`; `isMarketClosed`, `previousTradingDay`; `latestHoldingsPredicate`, `isCashEquivalentSecurity`; `LEVERAGED_TRACKED_INDEX_SEEDS`; `GAINS_AT_RISK_DRIVERS`; `isUsSessionSecurity` (A1); `takeBackup` (`lib/backup/take-backup.ts`).
- Produces:
  ```ts
  // lib/tws/ohlcv.ts: maxBarDate drops bars after it and on closed market days; store:false returns bars without writing. Absent = unchanged.
  interface FetchOhlcvOptions { /* existing */ maxBarDate?: string; store?: boolean }
  export function storableDailyBars<T extends { date: string }>(bars: T[], maxBarDate: string): T[];
  // lib/queries/ohlcv.ts (both through PRICED_BAR_SQL, bar_size '1 day')
  export function getPricedDailyBarRange(db, securityId: number): { earliest: string; latest: string } | null;
  export function getPricedDailyCloses(db, securityId: number, fromDate: string): Map<string, number>;
  // lib/mutations/ohlcv.ts: one transaction; deletes the security's '1 day' rows dated >= startDate, then writes `bars` through the bad-bar guard
  export function replaceDailyBarsInWindow(db, securityId: number, startDate: string, bars: OhlcvBar[]): { inserted: number; rejected: number };
  // lib/tws/daily-bar-capture.ts
  export const DAILY_BAR_CAPTURE_MAX_PER_BATCH = 20;
  export const DAILY_BAR_BATCH_MIN_INTERVAL_MS = 25 * 60 * 1000;
  export const DAILY_BAR_HISTORY_DAYS = 730;
  export const DAILY_BAR_OVERLAP_CALENDAR_DAYS = 14;   // at least 5 sessions in any two weeks
  export const DAILY_BAR_MIN_OVERLAP_SESSIONS = 5;
  export const DAILY_BAR_BASIS_TOLERANCE = 0.005;      // 0.5% on a close
  export function listDailyBarTargets(db, today: string): { targets: number[]; foreignSession: number; noContractId: number };
  export interface DailyBarCaptureResult {
    attempted: number; written: number; fullRefetches: number; basisChanges: number; failed: number;
    doneToday: number; exhausted: number; foreignSession: number; noContractId: number;
    skippedReason?: "tws-not-connected" | "already-running" | "batch-window";
  }
  export function runDailyBarCapture(db, opts?: { today?: string; now?: number; maxSecurities?: number;
    ignoreBatchWindow?: boolean; fetch?: typeof fetchOhlcvBars }): Promise<DailyBarCaptureResult>;
  ```

Rules:
- **Targets:** the distinct identities of every held row (latest holdings, any account, non-zero quantity: the security for a non-option, the underlying's row for an option), plus the three drivers and every symbol in `LEVERAGED_TRACKED_INDEX_SEEDS`, held or not, whenever a securities row with `ib_con_id` exists (C3). Left out: options, bonds, cash-equivalents, a non-USD security (`foreign-session`, C4), a row with no contract id (each counted). Order: no priced bars first, then the oldest priced latest bar (`getPricedDailyBarRange`, so a corrupt row never counts, C1).
- **Skips (C1, C9):** a per-process ledger on `globalThis.__tws_dailyBarLedger = { day, succeeded: Set, exhausted: Set, failed: Set }`, reset when the Eastern day changes. A security in any set today is not tried again today. Nothing else marks a security fresh: a stored latest date never does.
- **Each capture:** with a priced range, fetch with `store: false` from 14 calendar days before the stored latest priced bar through `maxBarDate = previousTradingDay(today)`; with none, or an earliest bar later than `today - 723`, fetch the full two years (`durationStr: "2 Y"`, `incremental: false`). Then:
  - Compare the refetched overlap with stored closes for the same dates, leaving out the stored latest bar (it may be a mid-session bar). Fewer than 5 compared sessions, or any compared close differing by more than 0.5%, is a basis change (C2): fetch the full two years and `replaceDailyBarsInWindow(id, today - 730, bars)`.
  - Otherwise upsert the refetched bars, which overwrites the stored trailing bars with true closes (C1).
  - A full fetch whose earliest returned bar is later than `today - 723` marks the security `exhausted` (its history is shorter than two years); success marks it `succeeded`; a failure marks it `failed`. None is retried that day.
- **Batches (C8):** at most 20 securities per run and at most one run per 25 minutes per process (`globalThis.__tws_dailyBarLastBatchAt`); a run inside the window returns `batch-window`. One run at a time (`already-running`); not connected returns `tws-not-connected`. Every request goes through the OHLCV limiter the daily Charts path uses. The intraday Charts path and the benchmark fetch call TWS outside that limiter, so the cap leaves headroom rather than reserving a broker-wide budget; IBKR's own pacing errors surface as a counted failure.
- **Sync step:** `auto-refresh.ts` Step 7 runs after Step 6 on both refresh levels, only when `getIbApi()` is set, NOT awaited: `void runDailyBarCapture(db).then(log).catch(log)`, content-free log, nothing pushed to the sync's `errors`.
- **Script (C10):** `scripts/backfill-daily-bars.ts` resolves the database from `BACKFILL_DB_PATH` or `--db`, else the app's default path, and prints it as its first line. It never imports `@/lib/db`. The dry run (default) opens the file with `new Database(path, { readonly: true, fileMustExist: true })`, prints the target and skip counts, the number of requests, and the time at 55 per 10 minutes, and writes nothing. `--apply` refuses when anything answers on 127.0.0.1:3099 (the app must be quit), takes a backup through `takeBackup` with purpose `daily-bar-backfill`, opens its own writable connection, connects TWS as client id 1, runs `runDailyBarCapture` with `ignoreBatchWindow: true` and no cap, prints the result, and disconnects. It is run from the repo root under the coordination `tws` lock:
  `npm run coord -- lock run tws --task <id> -- env PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/backfill-daily-bars.ts --apply`

- [ ] **Step 1: Write the failing tests.** `tests/tws/daily-bar-capture.test.ts` (migrated schema, injected `fetch`, `vi.mock("@/lib/tws/client")`):

```ts
it("targets held identities, option underlyings, the drivers and seeded tracked indexes; never options, bonds, cash or non-USD", () => {});
it("a mid-session bar stored yesterday by Charts is replaced by the true close on the next capture", () => {
  // stored 2026-11-09 close 101.3 (partial); refetch says 100.0 → stored close 100.0
});
it("a corrupt latest row does not mark a security fresh", () => { /* latest row close 0: still targeted, range from priced bars */ });
it("a split between two captures triggers one full refetch that replaces the window", () => {
  // stored closes on the old basis, refetch on a 1/2 basis: fullRefetches 1, basisChanges 1, every stored close in the window on the new basis
});
it("the stored latest bar alone differing is not a basis change", () => {});
it("caps at 20 and runs at most one batch per 25 minutes", () => {
  // run at t0: 20 fetched; run at t0 + 10 min: skippedReason "batch-window"; at t0 + 26 min: next 20
});
it("fairness: 45 short-history targets are each fetched once per day across three batches", () => {
  // exhausted after their full fetch; batches 1-3 fetch 20, 20, 5 distinct ids; a fourth batch the same day fetches 0
});
it("passes maxBarDate = previous trading day; storableDailyBars drops today and closed days", () => {
  expect(storableDailyBars(bars, "2026-11-06").map((b) => b.date)).toEqual(["2026-11-05", "2026-11-06"]);
});
it("a failure is counted, never thrown, and not retried that day", () => {});
it("not connected and already-running are no-ops", () => {});
it("auto-refresh starts Step 7 after Step 6 without awaiting it and never adds to errors", () => { /* source pin with anchorIndex */ });
```

`tests/scripts/backfill-daily-bars.test.ts`:
```ts
it("dry run changes nothing", () => {
  // a migrated temp db file with bars; run the dry-run entry against it; reopen: total_changes() 0 on the script's handle, file bytes identical
});
// source pins: prints the path first; never imports "@/lib/db"; readonly: true on the dry-run path;
// connectTws, takeBackup and the 3099 probe appear only on the --apply path
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** the eight files.
- [ ] **Step 4: Run both test files plus `tests/tws/auto-refresh-integration.test.ts`, `tests/tws/closed-market-day-writers.test.ts`, `tests/tws/benchmark-u10.test.ts` and every existing `tests/**/ohlcv*` test.** Expected: PASS.
- [ ] **Step 5: Hand back** the eight files. Controller commits ("Daily-bar capture that refreshes its overlap and detects basis changes, and a one-shot backfill").

---

### Task A5: The page

Runs after A3. Edits only the Task 6 files.

**Interfaces:**
- Consumes: A2/A3 result shape; `BETA_OVERRIDE_BOUNDS` from the constants module.
- Produces (`lib/analysis/gains-at-risk-view.ts` additions):
  ```ts
  export const CASE_LABELS = { measured: "Measured", selloff: "Selloff case" } as const;
  export const SELLOFF_NOTE = "Assumption: every stock and fund moves at least one-for-one with the driver.";
  export function betaEvidenceCaption(e: GainsAtRiskResult["betaEvidence"], driver: string): string;
    // "Betas from daily closes of each name and of <driver> through <date>. <n> names wait for daily bars."
    // driverBarsMissing → "<driver>'s daily closes are not on file yet, so no name is measured."
  export function noMeasuredLinkSentence(d: GainsAtRiskCase["disclosures"]["noMeasuredLink"], caseKey: GainsAtRiskCaseKey): string;
    // reasons with counts; "held unchanged (options still lose or gain time value)" for measured, "taken one-for-one" for selloff
  export function betaOverrideProblem(raw: string): string | null;   // finite, within BETA_OVERRIDE_BOUNDS
  ```

Screen changes: a two-option case switch, default "Measured", with `SELLOFF_NOTE` shown with the selloff case; the chart shows the book line for both cases plus the without-offsets line for the selected case; the table and disclosure lines follow the selected case, "no measured link" replacing "beta estimated"; the per-name table shows measured beta, source ("measured", "driver", "fixed", "leveraged", "your figure", "no measured link" with its reason), pairs, and a plain `<input type="number" step="0.05" min="-5" max="5">` for the owner's figure, keyed and stored by `identitySecurityId` (one editor per identity; option rows show the figure of their underlying; a row with `identitySecurityId: null` has no editor), committed on blur or Enter into `betaOverrides`, with Clear and the refusal sentence. A beta is not a portfolio figure, so the input is not masked; dollar columns stay in `<Money>`. The caption from `betaEvidenceCaption`. Every change goes through the existing sequence-numbered reducer.

- [ ] **Step 1: Write the failing tests:** helper tests (`betaEvidenceCaption` with 0 and 3 waiting and with the driver missing; `noMeasuredLinkSentence` for both cases; `betaOverrideProblem("6")` refused, `("-0.4")` accepted); source pins (case switch defaults to `"measured"`; `SELLOFF_NOTE` rendered with the selloff case; the figure input is `type="number"`, not `PrivateNumberInput`, and keyed on `identitySecurityId`; no "estimated" string in the view files; no non-type import from `@/lib/compute/` in client files; the hedge-word scan still passes).
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Task 6 tests and `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build`.** Expected: PASS and the build completes (C12).
- [ ] **Step 5: Hand back** the changed files (third in the A2-A3-A5 landing).

---

### Task A6: Real-data check (controller, read-only until the owner says go)

Results to `docs/private/2026-11-24-gains-at-risk-betas-check.md` only.

- [ ] **Step 1:** From the repo root, the dry run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/backfill-daily-bars.ts`. Record target counts and request time.
- [ ] **Step 2:** Ask the owner for the go-ahead to apply on the live database, stating the target count, the request time, that the app must be quit for the run, that a backup is taken first, and that only `ohlcv_bars` is written. Without a yes, stop and record "not applied".
- [ ] **Step 3 (after the yes):** quit the app, run the `--apply` command under the `tws` lock (A4), relaunch the app, record the result counts.
- [ ] **Step 4:** On a VACUUM copy, run the engine read-only for drivers SPY and QQQ. **Pass gate (C14):** for five or more liquid names, a throwaway script reads the same `ohlcv_bars` rows, builds the aligned pairs independently (same window, gap and residual rules) and computes OLS beta; each equals the engine's beta to 1e-9, with the same pair count. **Observations, not gates:** each name's beta to SPY and QQQ, r-squared, pairs, dropped outliers, the reason counts, and the share of the book with no measured link.

---

### Task A7: Verification and docs

Folds into the base plan's Task 7 (run once, after A6).

- [ ] **Step 1:** the base plan's Task 7 Steps 1-3 (verify:changed, verify:smoke, `next build`, the full suite). Expected: passed; report the count.
- [ ] **Step 2:** the base plan's browser pass, plus: the case switch; a no-link stock flat in Measured and one-for-one in Selloff, an option on it still decaying in Measured; one figure on an underlying held only through options moving all its options; a figure refused at 6 and cleared; the caption's date and waiting count.
- [ ] **Step 3: Docs.** `docs/DECISIONS.md` adds B1-B7, C1-C14 and A6's outcome (counts only). `CLAUDE.md` rule block: this engine's betas come only from daily bars on both legs (`computeDailyBarRegression`: 730 days, 60 pairs, r² 0.10, residual 0.35, reasons as listed); no estimated beta; no `benchmark_prices` read; the selloff case is an assumption; the owner's figure is page state keyed by `identitySecurityId`; the capture step (20 per batch, one batch per 25 minutes, 14-day overlap, 0.5% basis check) and `scripts/backfill-daily-bars.ts` under the `tws` lock. `docs/plans/TODO.md` gets the follow-ups below.
- [ ] **Step 4: Hand back.** Controller commits the docs.

---

## Follow-ups (out of scope)

1. (B7) The sync writers that stamp the previous session's close with today's date and keep a mid-session snapshot as the day's price (`lib/tws/snapshot.ts`, `lib/tws/streaming.ts`, `lib/tws/positions.ts`, `lib/ibkr/refresh.ts`); also read by Defense, Significant Moves and the security regression card.
2. (B7) The missing split record for one sector ETF's `prices` series: a data repair with its own rehearsal and the owner's go-ahead.
3. (B7) `security_betas` and `resolveProxyBeta` in Defense, including the undocumented "never chart bars" phrase in CLAUDE.md.
4. `lib/tws/benchmark.ts` copies `prices` rows into `benchmark_prices` when a TWS fetch fails; every other reader of `benchmark_prices` still trusts it.
5. Exchange-aware session alignment, so a non-USD listing can be measured.
6. An owner-supplied twin for an index mutual fund with no daily bars.
7. One broker-wide budget for every TWS historical request (Charts intraday, benchmarks, capture).
8. A basis-change refetch replaces daily bars inside the two-year window only (C2); any older Charts bars for that security stay on the old basis until the Charts page refetches them.

## Self-review

- **Rulings coverage:** B1, B2, C3, C4, C13, C14 (guard) → A1; B3, B4, C5, C6, C12 (constants) → A2; B4 input, C12 → A3; B5, C1, C2, C8, C9, C10 → A4; B6, C6 (editor), C12 (build) → A5; C14 (gate) → A6; C11 → graph and A2's start; B7 → Follow-ups.
- **Types:** `NoMeasuredLinkReason` and `DailyBarEvidence` (A1) are used unchanged by A2 and A5; `identitySecurityId`, `GainsAtRiskCase`, `betaEvidence.driverBarsMissing`, `betaOverridesIgnored` (A2) are read by A3 and A5; `BETA_OVERRIDE_BOUNDS` lives only in the constants module; no later task names a deleted symbol.
- **Steps:** signatures, rules and assertions only; every task ends in a hand-back.
- **Proportion:** shorter than the base plan.

## OPEN — conflicts with the contract

1. **`excludePriceSources` becomes dead code.** The option on `computeSecurityRegression` and its committed test (`tests/compute/security-regression-source-filter.test.ts`) were added for the engine's old measured path; after A2 nothing calls it. Removing it means deleting a committed test file, which needs the owner's word. The addendum keeps both; deleting them is a one-line follow-up once approved.
