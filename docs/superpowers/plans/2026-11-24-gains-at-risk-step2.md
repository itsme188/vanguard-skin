# Gains at Risk, Step 2 (try a position before trading it) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner add trial positions (an option to buy or write, shares to buy or sell) on the Gains at risk page and see the book with them beside the book as it is, net of what they cost, with a one-click broker quote and a one-symbol daily-bar fetch.

**Architecture:** The engine takes trial positions as extra rows in the same run and returns, per case, the book with them, the trial rows and their cost; with none it is byte-identical to step 1. A trial option is fixed at the click (price paid, underlying price, solved volatility) by a pure solver behind a thin entry route, so every later run values it at the current underlying price with the recorded volatility. A one-security capture entry point and a one-contract quote function in `lib/tws/` sit behind two thin routes. The page holds trial positions in a client provider above the per-scope remount.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, better-sqlite3, `@stoqey/ib`, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-gains-at-risk-step2-trial-positions-design.md` (its "Rulings after the plan review" P1-P11 win over everything above them, and "Rulings after the builder check" R1-R10 over the text before those). It builds on `docs/superpowers/specs/2026-11-24-gains-at-risk-design.md`, whose rulings (owner rulings 1-6, F1-F20, B1-B7, C1-C14) still bind.

## Global Constraints

- Every Global Constraint of `docs/superpowers/plans/2026-11-24-gains-at-risk-step1.md` and its addendum still binds: read-only engine, no migration, no new dependency, no AI call, Mac-only (no Worker mirror, snapshot field, email or push), synthetic ZZ* fixtures only and no ticker the owner holds, `todayET()` for today, option expiry only through `lib/compute/option-expiry.ts` and `isExpiredAsOf` / `yearsToExpiry`, `getRiskFreeRate(db)`, scope semantics (`undefined` every account, `[]` none), privacy components for every portfolio figure, the exact label "Year's gain so far", never "hedge", down direction only, the test prefix `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH`.
- The repo `CLAUDE.md` block "Rules from the 2026-11-24 Gains at risk build" and `lib/tws/CLAUDE.md` bind. In particular: betas only from daily bars on both legs; branch on `outcome`; `dailyBarCaptureEligibility` is the one fetch rule; the client boundary import walk.
- **Git:** implementer agents never run git. Each task hands back its file list; the controller reviews and commits with `git commit -F <scratchpad file> -- <paths>`, never a bare commit, never `git stash`; every message ends with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- **No live systems in a task:** never connect to TWS and never open the real database. Tests use an in-memory migrated schema and a fake IB API (`vi.mock("@/lib/tws/client")` or an injected `api`).
- Reviewer scratch never goes under the repo as `*.test.ts`.
- The only new write is the one-symbol daily-bar fetch, into `ohlcv_bars`, through the existing capture body. Quotes go through the market-data snapshot path, never the historical-data budget.
- Nothing about trial positions is stored, server or browser. Copy: "Not stored. Nothing is traded from this page."
- A trial option's volatility is solved once, at the click; no later run re-solves it; the broker's underlying volatility is never a fallback for it.
- The contract multiplier for a trial option is 100 (`TRIAL_OPTION_MULTIPLIER`); the form says an adjusted contract is out of scope.
- Every portfolio figure (contracts, share quantities, cost, cash, results) goes through the privacy components; quote prices, strikes and betas are market data and plain.

## Review Focus

1. **A trial put added before a fall, then the stored prices refresh lower:** its gain since the click stays in the line (it is valued at the new, lower underlying with the recorded volatility, less the price paid) and it is never refused as "below exercise value". Pinned in S1.
2. **The same option held and tried at once:** the held row is unchanged, the trial row is separate, `holdingsNowByAccount` reports the held count per account, conservation holds. Pinned in S1.
3. **A trial sale larger than the holding in the stress scope but not across all accounts:** no "leaves you short" flag (R5 counts every account); two sales each within the holding but together beyond it are flagged on the second, with the exact shortfall (P4). Pinned in S1.
4. **A quote that arrives one-sided:** nothing is filled, the reason is `no-two-sided-quote`, the last price is still reported, and no model price appears. Pinned in S3.
5. **Twelve positions, then a thirteenth:** the route answers 400 naming `trialPositions`, and the form disables Add with a sentence before any request. Pinned in S3 and S4.

Also pinned (in S1): a trial option expiring before the valuation date (worse of the two cases), a trial on the driver itself (beta 1), a trial whose underlying loses its price row (listed as not modelled, contributes zero, the book is unchanged), and a retained trial whose contract has expired across an Eastern-date rollover (refused `expired`, the other trials still count, P11).

---

## Dependency graph and file ownership

```
S5a (controller: commit the owner's two pending changes; settled) ───────────┐
S1 ──┐                                                                         │
S2 ──┴─(controller: commit each, one full suite)─> S3 ──> S4 (after S5a) ──> S5
```

S1 and S2 share no file and run as parallel subagents. S3 needs S1 (`solveTrialEntry`, `buildTrialEntry`, the input types and bounds) and S2 (`ensureDailyBarsForSecurity`). S4 needs S3 and S5a. S5 runs last.

| Task | Files it alone may edit |
|---|---|
| S1 | `lib/compute/gains-at-risk.ts`, `lib/compute/gains-at-risk-trial.ts` (new), `lib/analysis/gains-at-risk-constants.ts`, `tests/compute/gains-at-risk.test.ts`, `tests/compute/gains-at-risk-trial.test.ts` (new), `tests/fixtures/gains-at-risk-no-trial-pin.json` (new) |
| S2 | `lib/tws/daily-bar-capture.ts`, `tests/tws/daily-bar-capture.test.ts`, `tests/tws/daily-bar-ensure.test.ts` (new), `tests/fixtures/daily-bar-capture-pin.json` (new) |
| S3 | `lib/tws/option-quote.ts` (new), `lib/calendar/market-session.ts` (new), `lib/calendar/market-holidays.ts` (early-close list only), `lib/analysis/gains-at-risk-input.ts`, `app/api/compute/gains-at-risk/route.ts`, `app/api/compute/gains-at-risk/trial-entry/route.ts` (new), `app/api/tws/option-quote/route.ts` (new), `app/api/tws/daily-bars/ensure/route.ts` (new), `tests/tws/option-quote.test.ts` (new), `tests/calendar/market-session.test.ts` (new), `tests/api/compute-gains-at-risk.test.ts`, `tests/api/gains-at-risk-trial-entry.test.ts` (new), `tests/api/tws-option-quote.test.ts` (new), `tests/api/tws-daily-bars-ensure.test.ts` (new) |
| S4 | `lib/analysis/gains-at-risk-view.ts`, `lib/analysis/gains-at-risk-trial-view.ts` (new), `app/dashboard/components/gains-at-risk/GainsAtRiskSection.tsx`, `GainsAtRiskView.tsx`, `GainsAtRiskChart.tsx`, `TrialPositionsProvider.tsx` (new), `TrialPositionForm.tsx` (new), `TrialPositionList.tsx` (new), `tests/lib/gains-at-risk-view.test.ts`, `tests/lib/gains-at-risk-trial-view.test.ts` (new), `tests/dashboard/gains-at-risk-view-source.test.ts`, `tests/dashboard/gains-at-risk-trial-source.test.ts` (new) |
| S5a / S5 | commits only for S5a; `docs/DECISIONS.md`, `CLAUDE.md`, `docs/plans/TODO.md` for S5; `lib/ui/positions-freshness-label.ts` and `tests/ui/positions-freshness-label.test.ts` are committed by S5a as they stand, never edited |

---

### Task S1: Engine: trial positions

**Files:**
- Create: `lib/compute/gains-at-risk-trial.ts`, `tests/compute/gains-at-risk-trial.test.ts`, `tests/fixtures/gains-at-risk-no-trial-pin.json`
- Modify: `lib/compute/gains-at-risk.ts` (input, result, a trial pass after the book rows reusing the run's clock, betas memo, `caseBetas` and `sideOf`), `lib/analysis/gains-at-risk-constants.ts` (bounds; stays import-free), `tests/compute/gains-at-risk.test.ts`

**Interfaces:**
- Consumes: `repriceOptionUnderShock` (unchanged), `resolveDriverBeta`, `barSeriesSecurityId`, `latestHoldingsPredicate`, `getLatestDailyBar` and `getOhlcvBars` (`lib/queries/ohlcv.ts`), `DAILY_BAR_WINDOW_DAYS`, `normalizeOptionExpiration`, `isExpiredAsOf`, `previousTradingDay`, `getRiskFreeRate`.
- Produces (constants, import-free):
  ```ts
  export const TRIAL_OPTION_MULTIPLIER = 100;
  export const TRIAL_POSITION_BOUNDS = Object.freeze({
    maxPositions: 12, maxContracts: 500, maxShares: 1_000_000, maxPrice: 100_000, maxStrike: 100_000, idMaxLength: 40,
  });
  ```
- Produces (`gains-at-risk.ts`, the input type, verbatim):
  ```ts
  export type TrialPositionInput =
    | {
        kind: "option";
        /** Client-supplied, unique within the request (≤ 40 chars). */
        id: string;
        /** securities.id of the underlying (a non-option row). */
        underlyingSecurityId: number;
        right: "put" | "call";
        side: "buy" | "write";
        /** YYYY-MM-DD. */
        expiry: string;
        strike: number;
        /** Whole contracts, 1..maxContracts. Multiplier is TRIAL_OPTION_MULTIPLIER. */
        contracts: number;
        /** Per share, at the click (R1). */
        pricePaid: number;
        /** The underlying's price used at the click (R1, R2). */
        entryUnderlyingPrice: number;
        /** Solved at the click by solveTrialEntry; never re-solved (R1). */
        entryVolatility: number;
      }
    | {
        kind: "shares";
        id: string;
        /** securities.id of a non-option row. */
        securityId: number;
        side: "buy" | "sell";
        /** Whole shares, 1..maxShares. */
        quantity: number;
        /** The typed price per share (R3). */
        price: number;
      };
  // GainsAtRiskInput gains: trialPositions?: TrialPositionInput[];
  ```
- Produces (result additions, verbatim):
  ```ts
  export type TrialRefusal =
    | "unknown-security" | "is-an-option" | "foreign-currency" | "no-fx-rate"
    | "no-underlying-price" | "expired" | "no-option-terms";
  export type TrialCost =
    | { kind: "premium-paid"; usd: number }      // bought option: price paid x contracts x 100
    | { kind: "premium-received"; usd: number }  // written option: an obligation, not a gain (R7)
    | { kind: "cash-used"; usd: number }         // bought shares
    | { kind: "cash-raised"; usd: number };      // sold shares
  export interface GainsAtRiskTrialRow {
    id: string;
    kind: "option" | "shares";
    /** The traded security for shares, the underlying for an option. */
    identitySecurityId: number;
    symbol: string;
    name: string | null;
    betaSource: GainsAtRiskBetaSource;
    measuredBeta: number | null;
    evidence?: DailyBarEvidence;
    noMeasuredLinkReason?: NoMeasuredLinkReason;
    /** A trial option whose underlying has no measured link and no owner's figure: its protection is not counted in the measured case. */
    noLinkWarning: boolean;
    /** The valuation price of the shares or of the underlying (P2): the book's price when the stress scope's book has any row for the name, else the latest priced daily bar. */
    valuation: { price: number; date: string; source: "book" | "daily-bar" } | null;
    expiresBeforeDate?: true;
    refusal?: TrialRefusal;
    /** Signed USD mark now (shares at the valuation price; option at its model value at the recorded volatility); null when refused. */
    valueUsd: number | null;
    cost: TrialCost;
    /** R4/P3: account id → holdings of that exact security (shares) or contract (option) now, every account; accounts at 0 omitted. */
    holdingsNowByAccount: Record<number, number>;
    /** P4: sold shares only: the part of the name's projected shortfall attributed to this sale in list order; null otherwise. */
    leavesShortBy: number | null;
    cases: Record<GainsAtRiskCaseKey, GainsAtRiskPositionCase>;
  }
  export interface GainsAtRiskTrialMoveRow { move: number; trialPnlUsd: number; bookWithTrialPnlUsd: number }
  /** P5: over the moves at or below 0, by deepening fall; "better" = trial total > 0 (exactly 0 is not better). */
  export type GainsAtRiskTrialCrossing =
    | { kind: "better-at-every-move" }
    | { kind: "worse-at-every-move"; deepestMove: number }
    | { kind: "no-trial-effect" }
    | { kind: "pays-beyond"; move: number }
    | { kind: "helps-until"; move: number }
    | { kind: "changes-more-than-once"; firstHelpFrom: number; firstHelpTo: number };
  export interface GainsAtRiskTrialCase {
    moves: GainsAtRiskTrialMoveRow[];
    /** −(Σ trial P&L at move 0) at the date; null when 0 is not in the sweep. Positive = a cost. */
    noMoveCostUsd: number | null;
    crossing: GainsAtRiskTrialCrossing;
  }
  export interface GainsAtRiskTrialResult {
    rows: GainsAtRiskTrialRow[];
    /** Σ: −premium paid + premium received − cash used + cash raised, over rows not refused. */
    netCashUsd: number;
    count: number;
    refusedCount: number;
    noLinkWarningCount: number;
    /** P4: one entry per name the whole trial list leaves short. */
    shortByName: { securityId: number; symbol: string; shortBy: number }[];
    cases: Record<GainsAtRiskCaseKey, GainsAtRiskTrialCase>;
  }
  // GainsAtRiskResult gains: trial?: GainsAtRiskTrialResult   (the key is ABSENT when trialPositions is absent or empty)
  ```
- Produces (`gains-at-risk-trial.ts`):
  ```ts
  export type TrialEntrySolve =
    | { ok: true; volatility: number }
    | { ok: false; reason: "below-intrinsic" | "not-solvable" | "expired" | "no-option-terms" };
  export function solveTrialEntry(input: { right: "put" | "call"; strike: number; expiry: string; price: number;
    underlyingPrice: number; riskFreeRate: number; today?: string; now?: Date }): TrialEntrySolve;
  export type TrialEntryRequest =
    | { kind: "option"; symbol: string; right: "put" | "call"; side: "buy" | "write"; expiry: string; strike: number;
        contracts: number; price: number; quotedUnderlyingPrice?: number }
    | { kind: "shares"; symbol: string; side: "buy" | "sell"; quantity: number; price: number };
  export type TrialEntryRefusal = "unknown-symbol" | "is-an-option" | "foreign-currency" | "no-underlying-price"
    | "below-intrinsic" | "not-solvable" | "expired" | "no-option-terms";
  export type TrialEntryResult =
    | { ok: true; position: Omit<TrialPositionInput, "id">; symbol: string; name: string | null;
        underlyingPrice: number; underlyingPriceDate: string; underlyingPriceSource: "quote" | "stored-price" | "daily-bar";
        /** "priced against the <date> close" (R2): set when no quote was used and the date is before previousTradingDay(today). */
        staleCloseDate: string | null;
        /** R4/P3 snapshot: account id → holdings of that exact security or contract now (accounts at 0 omitted). */
        holdingsAtAddByAccount: Record<number, number>; hasContractId: boolean }
    | { ok: false; reason: TrialEntryRefusal; symbol: string };
  export function buildTrialEntry(db, req: TrialEntryRequest, opts?: { today?: string; now?: Date }): TrialEntryResult;
  export function lookupTrialSecurity(db, symbol: string, opts?: { today?: string }): { securityId: number; symbol: string;
    name: string | null; price: number | null; priceDate: string | null; hasContractId: boolean;
    /** P8: priced daily bars in [today - DAILY_BAR_WINDOW_DAYS, today). */
    dailyBars: { count: number; through: string | null } } | null;   // non-option row, exact upper-cased symbol
  export type TrialSecurityRefusal = "not-found" | "is-an-option" | "foreign-currency" | "no-contract-id";
  /** P9: the one server-side check every trial route runs before a broker request or a write. */
  export function checkTrialSecurity(db, securityId: number, opts: { requireContractId: boolean }):
    { ok: true; symbol: string; ibConId: number | null } | { ok: false; reason: TrialSecurityRefusal };
  /** P2: price of `securityId` from the stress scope's loaded rows when any row has that identity, else the latest priced daily bar. */
  export function trialValuationPrice(db, securityId: number, bookRows: ScenarioPositionAccountRow[]): GainsAtRiskTrialRow["valuation"];
  export function trialHoldingsByAccount(db, position: TrialPositionInput | Omit<TrialPositionInput, "id">): Record<number, number>;
  /** P4: per sale row in list order, and per name. */
  export function trialShortfalls(positions: TrialPositionInput[], heldBySecurity: Map<number, number>):
    { bySaleId: Map<string, number>; byName: Map<number, number> };
  export function trialCrossing(moves: number[], trialPnlByMove: number[]): GainsAtRiskTrialCrossing;
  ```

Rules:
- **Entry (R1):** `solveTrialEntry` calls `repriceOptionUnderShock` with `own_price = price`, `underlying_price = underlyingPrice`, `underlying_iv: null`, move 0 and no new option, and accepts only `modelled && ivSource === "own-price"` (step 1's typed-price probe); a price below intrinsic at that underlying is `below-intrinsic`, any other failure `not-solvable`. There is no broker volatility input at all. `buildTrialEntry` resolves the symbol (R10), runs `checkTrialSecurity`, refuses an expiry before today (P11: a NEW entry only), takes the underlying price at the click (R2: `quotedUnderlyingPrice` when given, else the newer of the stored price and the latest priced daily bar, with its date), solves, and snapshots holdings per account (P3).
- **Valuation (P2):** the loader's `latest_prices` close for the identity, read from the stress scope's rows: `own_price` on the name's own row or `underlying_price` on an option row whose underlying is the name (the same `prices` row). Only a name with no row of either kind falls to the latest priced daily bar close. Neither: refusal `no-underlying-price`.
- **Expired (P11):** a trial option for which `isExpiredAsOf(expiry, today, now)` holds is accepted, returned with `refusal: "expired"`, zero at every move and no cost in the net cash; every other trial still computes.
- **Shortfall (P4):** per name, start from every account's holding plus all trial buys of it; walk the trial sales in list order; each sale's `leavesShortBy` is the part of it the running holding cannot cover; `shortByName` lists every name whose final figure is short.
- **Option P&L (R1):** `repriceOptionUnderShock` with `own_price: null`, `underlying_iv: entryVolatility`, `modelWhenUnpriced: true`, the run's `valuationDate`, `volChange`, and `underlyingMove = max(caseBeta x move, -1)`; per-share P&L = `v1 - pricePaid` (buy) or `pricePaid - v1` (write); expires before the date: the worse for the owner of `v1` and `v1IfMoveFirst` (F4); dollars = per-share P&L x contracts x 100. A non-USD underlying is `foreign-currency`.
- **Shares P&L (R3):** `sign x quantity x (P x (1 + max(caseBeta x move, -1)) - price) x usd_per_unit`, sign +1 buy, -1 sell; missing FX row `no-fx-rate`.
- **Betas:** the engine's memoised ladder for the identity, `caseBetas` with the owner's figure (`betaOverrides` keyed by `identitySecurityId`), so a trial on the driver is 1. A key that matches only a trial identity is applied, not counted as ignored.
- **R6:** trial rows are never in `positions`, `grossBookUsd`, `unknownValueCount`, `betaEvidence` or any case disclosure.
- **Per case:** `bookWithTrialPnlUsd = bookPnlUsd + trialPnlUsd` for every move, each rounded the engine's way (under half a cent is 0). `side` and `exposureUsd` per trial row come from the engine's `sideOf` and the same finite-difference exposure.
- **Crossing (P5):** over the moves at or below 0, ordered by deepening fall, each point is better (trial total > 0) or not (≤ 0). All zero: `no-trial-effect`; all better: `better-at-every-move`; none better: `worse-at-every-move`; one change from not-better to better: `pays-beyond`; one change from better to not-better: `helps-until`; more than one: `changes-more-than-once` with the first interval that helps. A boundary between two points is found by linear interpolation of the trial total to 0; a point at exactly 0 is itself the boundary.
- **Validation:** the engine throws `GainsAtRiskInputError` for more than 12 positions, a duplicate or over-long id, a non-safe-integer security id, or a number outside `TRIAL_POSITION_BOUNDS` (the route refuses these first). A past expiry is not an input error (P11).

- [ ] **Step 1: Freeze step 1.** With the code unchanged and `vi.setSystemTime(new Date("2026-11-10T15:00:00Z"))`, a one-off `npx tsx` command (not committed) runs `computeGainsAtRisk` over the seeds of `tests/compute/gains-at-risk.test.ts` (book with stock, measured and no-link names, options, leveraged fund, foreign row, empty scope) and writes the results to the fixture.
- [ ] **Step 2: Write the failing tests.** `tests/compute/gains-at-risk.test.ts` adds:

```ts
it("unchanged without trial positions: whole result equal to step 1, key absent", () => {
  for (const c of pin) {
    for (const trialPositions of [undefined, []]) {
      const r = computeGainsAtRisk(db, { ...c.input, trialPositions });
      expect(r).toStrictEqual(c.result); expect("trial" in r).toBe(false);
    }
  }
});
it("conservation per case to the cent: book with trial = book + Σ trial rows", () => {});
it("a bought put at a 0% move today is zero; at a later date it shows time decay; a written call the reverse", () => {});
it("a bought put on the driver improves the fall by an independent Black-Scholes less its cost", () => {
  // driver ZZQ beta 1: trial pnl at -10% === 10 x 100 x (putPrice(S*0.9, K, T1, r, σ) - pricePaid) within 0.005
});
it("selling held shares removes exactly that share of the holding's loss", () => { /* sell 40 of 100: trial pnl = -0.4 x holding pnl */ });
it("leaves you short counts every account: no flag when other accounts cover the sale; the exact shortfall otherwise", () => {
  // scope [A1] holds 50, A2 holds 100; sell 120 → leavesShortBy 0; sell 200 → 50
});
it("two sales each within the holding but together beyond it: the second carries the shortfall; a buy covers a sale", () => {
  // hold 100; sell 75, sell 75 → 0 and 50, shortByName [{ shortBy: 50 }]; buy 50 then sell 120 → 0, shortByName []
});
it("the same option held and tried: held row unchanged, holdingsNowByAccount = held contracts per account, conservation", () => {});
it("one valuation price per name: an option-only name is valued at the book's underlying price, not its daily close", () => {
  // ZZB held only through a put; prices close 50, latest daily bar 48: trial shares on ZZB valued at 50, source "book"
  // the same name in a scope with no row for it: 48, source "daily-bar"
});
it("an Eastern-date rollover: a retained expired trial is refused expired with zero effect, the live one still counts", () => {
  // today 2026-11-10; expiry 2026-11-09 → refusal "expired", pnl 0 everywhere, not in netCashUsd; other trial unchanged
});
it("a size-only change after prices moved keeps the accrued result per contract", () => {
  // same entry fields, contracts 10 → 20: pnl at every move exactly doubles
});
it("a trial put added before a fall keeps its gain after the price refreshes lower, and is never refused", () => {
  // entry S=100, σ from price 3; book price now 90: trial pnl at move 0 > 0; refusal undefined
});
it("expiry before the valuation date takes the worse case for a bought and for a written trial option", () => {});
it("a trial on the driver has beta 1", () => {});
it("a trial whose underlying loses its price row is listed with no-underlying-price and contributes zero", () => {});
it("no measured link: the trial option shows only decay in measured, carries the warning, moves in selloff", () => {});
it("an owner's figure keyed to a trial-only identity is applied and not counted as ignored", () => {});
it("R6: gross book, unknown counts and every disclosure are those of the book as it is", () => {});
it("R7 costs and net cash", () => { /* premium-paid, premium-received, cash-used, cash-raised; netCashUsd signed */ });
it("refuses a 13th position, a duplicate id and an out-of-bounds number", () => {});
```

`tests/compute/gains-at-risk-trial.test.ts`:
```ts
it("solveTrialEntry recovers the volatility a price was made from", () => { /* putPrice(100, 95, T, r, 0.3) → 0.3 within 1e-6 */ });
it("solveTrialEntry refuses a price below intrinsic and one no volatility explains; never uses a broker volatility", () => {});
it("buildTrialEntry: unknown symbol, an option symbol, a non-USD underlying", () => {});
it("buildTrialEntry takes the quote's underlying price, else the newer stored price or bar, and flags a stale close", () => {
  // bar 2026-11-05 newer than price 2026-11-03, today 2026-11-10 → underlyingPriceDate "2026-11-05", staleCloseDate "2026-11-05"
});
it("holdings snapshot is per account and counts the exact contract only", () => {
  // A1 +10 and A2 -10 since the click: maps differ though the total is equal
});
it("lookup reports priced daily bars: a known, priced security with zero bars", () => {
  expect(lookupTrialSecurity(db, "ZZN", { today })).toMatchObject({ price: 40, dailyBars: { count: 0, through: null } });
});
it("checkTrialSecurity: unknown id, an option row, a non-USD row, no contract id when required", () => {});
it("trialCrossing covers every pattern", () => {
  expect(trialCrossing([0, -0.05, -0.1], [-100, -20, 60])).toEqual({ kind: "pays-beyond", move: expect.closeTo(-0.0625, 9) });
  expect(trialCrossing([0, -0.05, -0.1], [10, 20, 30])).toEqual({ kind: "better-at-every-move" });
  expect(trialCrossing([0, -0.05, -0.1], [-10, -20, -30])).toEqual({ kind: "worse-at-every-move", deepestMove: -0.1 });
  expect(trialCrossing([0, -0.05, -0.1], [40, 10, -30])).toEqual({ kind: "helps-until", move: expect.closeTo(-0.0625, 9) });
  expect(trialCrossing([0, -0.05, -0.1, -0.15], [-10, 10, -10, 10])).toMatchObject({ kind: "changes-more-than-once",
    firstHelpFrom: expect.closeTo(-0.025, 9), firstHelpTo: expect.closeTo(-0.075, 9) });
  expect(trialCrossing([0, -0.05], [0, 0])).toEqual({ kind: "no-trial-effect" });
  expect(trialCrossing([0, -0.05], [0, 20])).toEqual({ kind: "pays-beyond", move: 0 });   // exactly 0 is not better
});
```

- [ ] **Step 3: Run to verify they fail.** Expected: FAIL (the pin passes; it is the guard).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run both files, `tests/compute/option-reprice*.test.ts`, `tests/compute/driver-beta.test.ts`, `tests/compute/scenario-positions-pin.test.ts`.** Expected: PASS.
- [ ] **Step 6: Hand back** the six files (implementers never run git). Controller commits ("Gains at risk engine: trial positions fixed at the click, in the same run").

---

### Task S2: Capture: one-security entry point

**Files:**
- Modify: `lib/tws/daily-bar-capture.ts` (the loop body of `runDailyBarCapture` moves into an exported function; the loop calls it)
- Create: `tests/tws/daily-bar-ensure.test.ts`, `tests/fixtures/daily-bar-capture-pin.json`
- Modify: `tests/tws/daily-bar-capture.test.ts` (adds the pin)

**Interfaces:**
- Produces:
  ```ts
  export interface DailyBarCaptureContext {
    today: string; maxBarDate: string; windowStart: string; fullHistoryFloor: string;
    fetch: typeof fetchOhlcvBars;
    /** Counters the caller sums (fullRefetches, basisChanges, staleOlderBarsDeleted). */
    counters: Pick<DailyBarCaptureResult, "fullRefetches" | "basisChanges" | "staleOlderBarsDeleted">;
  }
  /** One security: overlap or full fetch, basis check, short-reply guard, write. Throws on failure; never touches the ledger. */
  export function captureDailyBarsForSecurity(db, securityId: number, ctx: DailyBarCaptureContext): Promise<"succeeded" | "exhausted">;
  export function dailyBarCaptureContext(today: string, fetch?: typeof fetchOhlcvBars): DailyBarCaptureContext;
  export type EnsureDailyBarsRefusal =
    | "not-connected" | "batch-running" | "not-found" | "no-contract-id" | "ineligible" | "failed";
  export type EnsureDailyBarsResult =
    | { ok: true; outcome: "succeeded" | "exhausted" | "already-today" }
    | { ok: false; reason: EnsureDailyBarsRefusal; ineligibleReason?: DailyBarIneligibleReason };
  export function ensureDailyBarsForSecurity(db, api: IBApiNext | null, securityId: number,
    opts?: { today?: string; fetch?: typeof fetchOhlcvBars }): Promise<EnsureDailyBarsResult>;
  ```

Rules (R9): `ensureDailyBarsForSecurity` refuses `not-connected` (no `api`), `batch-running` (`__tws_dailyBarRunning`), `not-found`, `no-contract-id`, `ineligible` (`dailyBarCaptureEligibility` on the row); answers `already-today` with no request when the ledger already has the security as succeeded or exhausted today; is not subject to the 25-minute window and does not move `__tws_dailyBarLastBatchAt`; holds `__tws_dailyBarRunning` while it runs, so a batch started meanwhile is `already-running`; records `succeeded`, `exhausted` or `failed` in the daily ledger, so the next batch skips it. Every request goes through the same `fetchOhlcvBars` limiter. The sync and the backfill script still call `runDailyBarCapture`, whose behaviour is unchanged.

The engine's `namesNotCaptured` counts only identities whose reason is `no-daily-bars` and that are not capture targets. A name fetched this way has priced daily bars afterwards, so its reason is no longer `no-daily-bars`: it is in neither count (confirmed from `computeGainsAtRisk`, which counts `namesWaitingForBars` / `namesNotCaptured` over `no-daily-bars` identities only). A trial-only name is not a book position and is in neither count either way.

- [ ] **Step 1: Freeze the batch.** With the code unchanged, a one-off command runs `runDailyBarCapture` over the existing test seeds and fake fetch sequences (first fill, overlap agree, too-few, basis change, short reply, failure, disconnect mid-run) and writes each result plus the stored bars to the fixture.
- [ ] **Step 2: Write the failing tests.** The pin: the same runs `toStrictEqual` the fixture. `tests/tws/daily-bar-ensure.test.ts`:

```ts
it("fetches one security through the capture body and records success in the ledger", () => {
  // a following runDailyBarCapture does not fetch it again today
});
it("is not held to the 25-minute batch window and does not move it", () => {});
it("is refused while a batch is running; a batch started during it answers already-running", () => {});
it("refuses an ineligible row (a mutual fund), a row with no contract id, an unknown id, and no connection", () => {});
it("a failure is recorded and answered failed, never thrown", () => {});
it("already-today makes no request", () => {});
it("writes nothing outside ohlcv_bars", () => { /* row counts of every other table unchanged */ });
```

- [ ] **Step 3: Run to verify they fail.** Expected: the new file FAILS; the pin PASSES.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run both files, `tests/scripts/backfill-daily-bars.test.ts`, `tests/tws/auto-refresh-integration.test.ts`.** Expected: PASS.
- [ ] **Step 6: Hand back** the four files. Controller commits ("Daily-bar capture: one body, and a one-security entry point").

**Controller gate after S1 and S2:** `bash scripts/verify.sh full --base main` passes before S3 starts.

---

### Task S3: Broker quote and routes

**Files:** as in the ownership table.

**Interfaces:**
- Consumes: S1 (`TrialPositionInput`, `TRIAL_POSITION_BOUNDS`, `buildTrialEntry`, `lookupTrialSecurity`, `checkTrialSecurity`); S2 (`ensureDailyBarsForSecurity`); `getIbApi`; `isMarketClosed`, `nowET`.
- Produces:
  ```ts
  // lib/tws/option-quote.ts
  export type OptionQuoteRefusal = "not-connected" | "no-underlying-contract" | "no-contract" | "no-two-sided-quote" | "timeout";
  export type QuoteTickKind = "live" | "delayed";
  export interface OptionQuoteRequest { underlyingSecurityId: number; right: "put" | "call"; expiry: string; strike: number }
  export type OptionQuoteResult =
    | { ok: true; bid: number; ask: number; mid: number; last: number | null; underlyingLast: number | null;
        tickKind: QuoteTickKind; fetchedAt: string /* ISO instant of the click */ }
    | { ok: false; reason: OptionQuoteRefusal; bid: number | null; ask: number | null; last: number | null };
  export function fetchOptionQuote(db, req: OptionQuoteRequest,
    deps?: { api?: IBApiNext | null; now?: () => Date; timeoutMs?: number }): Promise<OptionQuoteResult>;  // never throws
  // lib/calendar/market-holidays.ts (P10): beside NYSE_FULL_CLOSURES, same source, same comment convention
  export const NYSE_EARLY_CLOSES: Readonly<Record<string, string>>;   // "YYYY-MM-DD" → "13:00"
  export function earlyCloseTime(date: string): string | null;
  // lib/calendar/market-session.ts (pure)
  export function quoteSessionLabel(now: Date): "regular-session" | "market-closed";
  // lib/analysis/gains-at-risk-input.ts (P9, P11; value-imports only the constants module)
  // GainsAtRiskBody gains trialPositions?: TrialPositionInput[]; gainsAtRiskBodyProblem refuses a non-array, > 12 entries,
  // a duplicate or over-long id, a security id that is not a positive safe integer, an unknown kind/right/side,
  // a non-whole or out-of-bounds count, a non-finite, non-positive or out-of-bounds price/strike/underlying price/volatility,
  // and an expiry that is not a real calendar day. A PAST expiry is accepted here (P11).
  export type TrialEntryBody = { action: "lookup"; symbol: string } | { action: "entry"; request: TrialEntryRequest };
  export function trialEntryBodyProblem(body: unknown, today: string): string | null;   // entry: expiry not before today
  export function optionQuoteBodyProblem(body: unknown): string | null;               // { underlyingSecurityId, right, expiry, strike }
  export function ensureBarsBodyProblem(body: unknown): string | null;                // { securityId }
  ```

Rules:
- **Order in every new route (P9):** parse JSON, run the body check (400), run `checkTrialSecurity` on the server (422; `requireContractId: true` for the quote and the bar fetch), and only then call the broker or write. The compute route also runs `checkTrialSecurity` on each trial's security id (without the contract requirement) and answers 422 for a bad one.
- **Quote (R8, R10):** the underlying's `ib_con_id` and symbol come from its securities row (none: `no-underlying-contract`). One `getContractDetails` for `{ symbol, secType: OPT, exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth: YYYYMMDD, strike, right: "P" | "C", multiplier: "100" }` (no match: `no-contract`), then one market-data snapshot of the contract and one of the underlying (by `conId`), following `lib/tws/atm-straddle.ts` (DELAYED_FROZEN set and restored, `extractTick` sentinel rule, a 15-second timeout each). `tickKind` is `delayed` when any figure used came from a DELAYED_* tick, else `live`. Fills `ok: true` only with both bid and ask positive; else `no-two-sided-quote` with what arrived. Never a model price. Not on the historical limiter.
- **Session label (P10):** the market calendar is `lib/calendar/market-holidays.ts`, whose full-day list is sourced from the official NYSE yearly trading calendar (nyse.com) and already names one early close in its comments (Jul 2 2026, 1pm). Early closes go in a new `NYSE_EARLY_CLOSES` beside it, from that same NYSE calendar, for the years the file already covers; the S3 implementer adds only dates the controller has checked against nyse.com (pre-step below), never a derived one. `isMarketClosed` is unchanged. The label is `market-closed` on `isMarketClosed(day)`, before 09:30, at or after the day's close (`earlyCloseTime(day) ?? "16:00"`), and, on a day not in `NYSE_EARLY_CLOSES` whose previous or next weekday is a full closure, at or after 13:00 (the conservative rule for a day the calendar cannot confirm). The route returns it beside the quote; the page shows "market closed: the last quote" then.
- **Entry route — a third route, `POST /api/compute/gains-at-risk/trial-entry`.** Why not the compute route: the compute route runs on every control change, and R1 requires the solve to happen exactly once, at the click; folding it in would either re-solve on every run or make the sweep carry a second job. The entry route is called once per add or edit: `lookup` returns `lookupTrialSecurity` (the R10 sentence when null; the form fills the shares price from it); `entry` returns `buildTrialEntry` (the page stores `position`, `holdingsAtAddByAccount`, `staleCloseDate` and the price source). It is called only for a new entry (P1): a size-only edit makes no call. 400 for a body problem; 422 with the refusal's sentence for `ok: false`.
- **`POST /api/tws/option-quote`:** 503 when `getIbApi()` is null; otherwise 200 with the result and `session`.
- **`POST /api/tws/daily-bars/ensure`:** body `{ securityId }`; 503 not connected; 409 `batch-running` ("try again in a moment"); 422 for `not-found`, `no-contract-id`, `ineligible`; 502 `failed`; 200 otherwise.
- **Compute route:** validates `trialPositions` (a past expiry is accepted and left to the engine's `expired` refusal, P11) and passes them through; the result is returned untouched.
- All new routes are thin wrappers, `{ success, data }` envelope, and classify as `human` by default (`classifyRoute`); no edit to `proxy.ts`. Content-free log lines.

- [ ] **Step 0 (controller): early closes.** Read the NYSE trading calendar on nyse.com for the years `market-holidays.ts` covers and write the early-close dates and times into the S3 brief. Without them the conservative rule alone applies, and the tests below still pass.
- [ ] **Step 1: Write the failing tests.**

```ts
// tests/tws/option-quote.test.ts (fake api)
it("two-sided live quote fills the mid", () => { expect(r).toMatchObject({ ok: true, bid: 6.3, ask: 6.5, mid: 6.4, tickKind: "live" }); });
it("delayed ticks are labelled delayed", () => {});
it("one-sided: no-two-sided-quote, nothing filled, last still reported", () => {
  expect(r).toEqual({ ok: false, reason: "no-two-sided-quote", bid: 6.3, ask: null, last: 6.1 });
});
it("an unlisted contract is no-contract; no contract id on the underlying is no-underlying-contract", () => {});
it("not connected and a timeout never throw", () => {});
it("the contract carries multiplier 100 and the underlying's conId", () => {});
it("restores the realtime market-data type after the request", () => {});
// tests/calendar/market-session.test.ts
it.each([
  ["2026-11-10T15:00:00Z", "regular-session"],   // Tue 10:00 ET
  ["2026-11-10T13:00:00Z", "market-closed"],     // pre-open 08:00 ET
  ["2026-11-10T21:30:00Z", "market-closed"],     // after the close 16:30 ET
  ["2026-11-14T16:00:00Z", "market-closed"],     // Saturday
  ["2026-11-26T16:00:00Z", "market-closed"],     // Thanksgiving
  ["2026-11-27T17:00:00Z", "regular-session"],   // day after a Thursday holiday, 12:00 ET
  ["2026-11-27T18:30:00Z", "market-closed"],     // same day, 13:30 ET (early close or the conservative rule)
  ["2026-12-24T18:30:00Z", "market-closed"],     // eve of a holiday, 13:30 ET
  ["2026-12-22T18:30:00Z", "regular-session"],   // an ordinary Tuesday, 13:30 ET
])("%s → %s", (iso, label) => { expect(quoteSessionLabel(new Date(iso))).toBe(label); });
it("isMarketClosed is unchanged by the early-close list", () => { expect(isMarketClosed("2026-11-27")).toBe(false); });
// tests/api/compute-gains-at-risk.test.ts
it.each([
  [{ trialPositions: {} }], [{ trialPositions: Array(13).fill(opt) }], [{ trialPositions: [opt, opt] }],   // duplicate id
  [{ trialPositions: [{ ...opt, contracts: 1.5 }] }], [{ trialPositions: [{ ...opt, expiry: "2026-02-30" }] }],
  [{ trialPositions: [{ ...shares, price: 0 }] }],
])("refuses %o with 400 naming trialPositions", () => {});
it("passes trial positions to the engine and returns its result untouched", () => {});
it("accepts a retained trial whose expiry has passed; the engine returns it refused expired", () => {});
it("refuses a trial security id that is not a positive safe integer, and one checkTrialSecurity rejects", () => {});
// tests/api/gains-at-risk-trial-entry.test.ts
it("lookup: a known symbol, and the R10 sentence for an unknown one", () => {
  expect(body.error).toBe("The app does not know ZZZZ yet. Add it to the watchlist first.");
});
it("entry: an option record with the solved volatility and the holdings snapshot; an unsolvable price is 422", () => {});
// tests/api/tws-option-quote.test.ts and tests/api/tws-daily-bars-ensure.test.ts
it("503 when not connected; 200 with the result and the session label", () => {});
it("ensure: 409 while a batch runs, 422 for an ineligible security", () => {});
it.each(["{", "[]", '{"securityId":0}', '{"securityId":1.5}', '{"underlyingSecurityId":1,"right":"X"}',
  '{"underlyingSecurityId":1,"right":"put","expiry":"2026-02-30","strike":5}', '{"underlyingSecurityId":1,"right":"put","expiry":"2027-01-15","strike":-1}'])(
  "a malformed body %s answers 400 with zero broker requests and zero writes", () => {
  // spy on the fake api: no getContractDetails, no getMarketDataSnapshot, no historical request; ohlcv_bars row count unchanged
});
it("an option row, a non-USD row and a row with no contract id are refused 422 before any broker request", () => {});
it("entry refuses an expiry before today", () => {});
it("all four routes are human routes", () => {});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `gains-at-risk-input.ts` value-imports only the constants module.
- [ ] **Step 4: Run the seven files, `tests/auth/route-policy.test.ts`, `tests/tws/atm-straddle.test.ts`, `tests/dashboard/gains-at-risk-view-source.test.ts`.** Expected: PASS.
- [ ] **Step 5: Hand back** the fourteen files. Controller commits ("Gains at risk: broker quote, one-symbol bars, trial entry route").

---

### Task S4: The page

Starts after S3 and after S5a has committed the owner's pending changes to the view files.

**Interfaces:**
- Consumes: S1 result types (type-only), S3 routes, `TRIAL_POSITION_BOUNDS`, `GET /api/tws/option-chain?symbol=`, `GET /api/tws/status`.
- Produces (`lib/analysis/gains-at-risk-trial-view.ts`, plain module, no compute/query/db/tws value import):
  ```ts
  export interface TrialPositionState {
    position: TrialPositionInput;           // what the engine receives
    symbol: string;
    holdingsAtAddByAccount: Record<number, number>;   // R4/P3, kept through a size-only edit (P1)
    priceSource: "typed" | "quote-mid";
    quote?: { tickKind: QuoteTickKind; session: "regular-session" | "market-closed"; bid: number; ask: number; fetchedAt: string };
    staleCloseDate: string | null;          // R2
  }
  export const TRIAL_NOT_STORED_NOTE = "Not stored. Nothing is traded from this page.";
  export const TRIAL_CHART_NOTE = "With trial positions on, the line without the offsetting positions is hidden.";
  export const TRIAL_MULTIPLIER_NOTE = "Options with 100 shares per contract only.";
  export function trialPositionLabel(t: TrialPositionState): string;          // "Buy 10 ZZQ 2027-03-20 500 put" (count masked by the caller)
  export function trialCostLine(row: GainsAtRiskTrialRow): { verb: string; usd: number; note: string | null };
    // "costs" / "premium received" + "(an obligation, not a gain)" / "uses … of cash" / "raises"
  export function trialCostShareOfGain(row: GainsAtRiskTrialRow, yearGain: YearGainResult): number | null; // premium-paid only, gainGivenBackShare's rule (R7)
  export function holdingsChanged(atAdd: Record<number, number>, now: Record<number, number>): boolean; // P3: any account differs (missing = 0)
  export function holdingsChangedNote(t: TrialPositionState, row: GainsAtRiskTrialRow): string | null; // the R4 sentence when holdingsChanged
  export function leavesShortNote(row: GainsAtRiskTrialRow): string | null;   // per sale row (P4)
  export function shortByNameLines(trial: GainsAtRiskTrialResult): { securityId: number; symbol: string; shortBy: number; text: string }[];
    // "Your trial positions leave you short <n> <symbol>, counted across every account."
  export const TRIAL_EXPIRED_NOTE = "This contract has expired. Remove it.";   // P11
  export function noLinkWarningNote(row: GainsAtRiskTrialRow): string | null;
  export function quoteLabel(t: TrialPositionState): string | null;           // "mid of 6.30 / 6.50, live, fetched 14:32" or "market closed: the last quote"
  export function staleCloseNote(t: TrialPositionState): string | null;       // "priced against the <date> close"
  export function noMoveCostSentence(c: GainsAtRiskTrialCase): { usd: number; text: string } | null;
  export function crossingSentence(c: GainsAtRiskTrialCase, driver: string): string | null;   // P5, one sentence per `kind`:
    // better-at-every-move "They do better at every move shown." / worse-at-every-move "They cost more than they return at every fall shown." /
    // pays-beyond "They pay for themselves once <driver> falls more than X%." / helps-until "They help in a small fall and cost more beyond X%." /
    // changes-more-than-once "They help between X% and Y%. The picture changes more than once; read the table." / no-trial-effect → null
  export function trialRequestPositions(list: TrialPositionState[]): TrialPositionInput[];
  export function trialFormProblem(draft: TrialDraft, count: number, today: string): string | null;  // includes the 12-position limit
  /** P1: a size-only change keeps the entry and the snapshot; a change of terms, side or price needs a new entry. */
  export function applyTrialEdit(prev: TrialPositionState, draft: TrialDraft):
    { kind: "resize"; next: TrialPositionState } | { kind: "new-entry" };
  /** P6: the form's request state. */
  export type TrialFormRequestKind = "lookup" | "chain" | "quote" | "ensure" | "entry";
  export interface TrialFormState { open: boolean; revision: number; contractKey: string; draft: TrialDraft;
    quote: TrialPositionState["quote"] | null; pending: Partial<Record<TrialFormRequestKind, number>> }
  export type TrialFormAction =
    | { type: "open"; draft: TrialDraft } | { type: "edit"; patch: Partial<TrialDraft> } | { type: "cancel" }
    | { type: "request"; kind: TrialFormRequestKind }
    | { type: "reply"; kind: TrialFormRequestKind; revision: number; contractKey: string; payload: unknown };
  export function trialContractKey(d: TrialDraft): string;   // kind|symbol|right|strike|expiry
  export function trialFormReducer(state: TrialFormState, action: TrialFormAction): TrialFormState;
    // every edit bumps revision; an edit that changes trialContractKey clears quote; a reply whose revision or
    // contractKey no longer matches, or that arrives after cancel, is dropped (state returned unchanged)
  ```
  `gains-at-risk-view.ts` additions: `sortPositions` becomes generic over the fields it reads, and `nameTableRows(result)` returns book rows plus trial rows adapted as `{ ...fields, accountName: "trial", trialId }`, marked "trial", sortable with the rest; trial rows own a beta editor only for an identity no book row has. The request reducer gains `trialVersion`: every trial add, edit or remove dispatches `start` (the shown result is cleared); a `reset` from server props while trial positions exist does not show those props as the answer and the view asks again with the trial positions. `initialGainsRequestState(data, { hasTrials })` (P7): with trial positions it starts pending (`result: null`, `previous: data` for layout, `loading: true`) and the view's mount effect sends the request at once, on first paint and on every scope remount.

Decisions:
- **State across a scope switch (R5):** a new client `TrialPositionsProvider` (context: list, add, edit, remove) is rendered by `GainsAtRiskSection` AROUND the keyed `<GainsAtRiskView key={scope}>`, unkeyed. A scope pill is a soft navigation, so the provider keeps its state while the view still remounts with the scope; driver, date, volatility, case and typed figures still reset per scope as today, and only trial positions carry over. A reload or leaving the page loses them. The provider holds no other state and stores nothing.
- **The chart, selected case:** with trial positions, two lines: book as it is and book with trial positions; the without-offsets line is hidden with `TRIAL_CHART_NOTE`. With none, step 1's chart exactly.
- **The table:** columns "Book as it is", "With trial positions", "Difference", "Gain given back (as is -> with)", every figure through `<Money>` / `<Pct>`.
- **The form:** kind (option or shares); for an option: symbol, put or call, buy or write, expiry and strike (native selects from the chain route when the broker is connected, typed otherwise), contracts, price, Get quote (disabled with "Connect the broker to fetch quotes." when not connected). Symbol entry calls `lookup`; when its `dailyBars.count` is 0 (P8) and the broker is connected, the form calls `ensure` before `entry`. Every form request goes through `trialFormReducer` (P6). Editing an existing trial runs `applyTrialEdit` first: a resize replaces the stored position's size with no server call; anything else is a new entry. Contracts and quantities are `<PrivateNumberInput>`; prices and strikes are plain inputs.
- **The list:** each row with `trialPositionLabel`, `quoteLabel`, `staleCloseNote`, the cost line (share of gain for premium paid only), `holdingsChangedNote`, `leavesShortNote`, `noLinkWarningNote`, `TRIAL_EXPIRED_NOTE` for a row refused `expired`, edit (reopens the form filled) and remove; one `shortByNameLines` line per name; the net cash line; `TRIAL_NOT_STORED_NOTE`.

- [ ] **Step 1: Write the failing tests.** `tests/lib/gains-at-risk-trial-view.test.ts`: every sentence helper (R7 wordings for the four costs; the share of gain only for premium paid and only when the gain is positive and not "differs"; the six crossing kinds; the market-closed quote label; the stale close note; the expired note); `holdingsChanged` true for `{1: 10, 2: 0}` vs `{1: 0, 2: 10}` (P3) and false for an equal map with a zero entry left out; leaves-short per sale and per name (P4); `trialFormProblem` refuses a 13th position, a fractional count, a past expiry; `applyTrialEdit` (P1): a contracts-only change after prices moved returns `resize` with the entry fields and `holdingsAtAddByAccount` unchanged, so a changed-holdings flag stays; a strike, expiry, side or price change returns `new-entry`; `trialFormReducer` (P6): a quote reply for an older revision or another contract key is dropped, replies arriving out of order keep only the latest, an edit to the strike clears the quote, a reply after `cancel` is dropped, a size edit keeps the quote. `tests/lib/gains-at-risk-view.test.ts`: `nameTableRows` puts trial rows in the table and `sortPositions` sorts them with the book under every key; the reducer drops a reply for an older trial set and asks again after a reset while trial positions exist; `initialGainsRequestState(data, { hasTrials: true })` is pending with `result: null` (P7). `tests/dashboard/gains-at-risk-trial-source.test.ts`: the provider wraps the keyed view and is not keyed; the form disables Get quote when not connected; contracts and quantities use `PrivateNumberInput`; the chart hides the without-offsets line when trial positions exist; the not-stored note renders; no "hedge" string. `tests/dashboard/gains-at-risk-view-source.test.ts`: the import walk covers the four new files.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the four files plus every `tests/**/gains-at-risk*` test and `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build`.** Expected: PASS and the build completes.
- [ ] **Step 5: Hand back** the changed files. Controller commits ("Gains at risk page: try a position").

---

### Task S5: Verification, commits and docs

- [ ] **S5a (before S4 starts): the owner's pending changes.** Run `tests/lib/gains-at-risk-view.test.ts`, `tests/dashboard/gains-at-risk-view-source.test.ts`, `tests/ui/positions-freshness-label.test.ts`. Expected: PASS. Commit as two commits with pathspecs: (1) `lib/analysis/gains-at-risk-view.ts app/dashboard/components/gains-at-risk/GainsAtRiskView.tsx tests/lib/gains-at-risk-view.test.ts tests/dashboard/gains-at-risk-view-source.test.ts` ("Gains at risk: the per-name table sorts"); (2) `lib/ui/positions-freshness-label.ts tests/ui/positions-freshness-label.test.ts` ("Positions freshness: reworded label").
- [ ] **Step 1:** `npm run verify:changed`, `npm run verify:smoke`, `npx next build`, then `bash scripts/verify.sh full --base main`, all with the PATH prefix. Expected: each passes; report the test count.
- [ ] **Step 2: Browser pass, broker disconnected** (`npm run -s sandbox -- up --task <task>`, typed prices): add a bought put, a written call, a share sale and a share buy; edit one, remove one; the two sentences and net cash; the table's four columns; the chart's two lines and the hidden-line note; switch scope (trial positions stay, "leaves you short" unchanged); refresh the data (they stay); reload (they are gone); phone width; privacy on (contracts, quantities, cost, cash and results masked; quote prices and betas plain); sort the per-name table with trial rows under every key; a 13th position refused; an unknown symbol's sentence; Get quote disabled with its sentence.
- [ ] **Step 3: What only a connected broker can show**, listed for the owner to confirm: a real quote with its kind and fetched time, and "market closed: the last quote" outside the session; the expiry and strike selects from the chain; an unlisted strike's sentence; the one-symbol bar fetch for an underlying with no bars, and that the next sync batch skips it.
- [ ] **Step 4: Docs.** `docs/DECISIONS.md` entry "2026-11-24 Gains at risk, step 2": R1-R10 and P1-P11 as built, the entry route decision, the early-close list and its source, the provider decision, the bounds, the crossing rule, the notes below. `CLAUDE.md` rule block gains: trial positions are page state only; a trial option is fixed at the click (`solveTrialEntry`, never re-solved, no broker volatility); P2 one valuation price per name, the book's; P1 a size-only edit keeps the click; P3 per-account snapshot; P9 every trial route checks its body and the security before any broker request; R6 the book's figures never include trial rows; the one-contract quote (`fetchOptionQuote`, snapshot path, multiplier 100, live/delayed from the tick, session from the clock); `ensureDailyBarsForSecurity` is the capture's third caller. `docs/plans/TODO.md`: G3 done; step 3 remains (candidate grid, single-stock driver, rise in the index).
- [ ] **Step 5: Hand back.** Controller commits the docs. No deploy step.

---

## Notes (no conflict with the contract)

1. The trial option reuses `repriceOptionUnderShock` unchanged: valuing it at the recorded volatility is the function's existing "no own price, model at the given volatility" path (`own_price: null`, `underlying_iv: entryVolatility`, `modelWhenUnpriced: true`), so `option-reprice.ts` is not edited and its step 1 pins stand.
2. The engine imports `listDailyBarTargets` from `lib/tws/daily-bar-capture.ts`, which S2 edits; S2 keeps that export's signature and behaviour, so S1 and S2 stay independent.
3. A trial option on a non-USD underlying is refused (`foreign-currency`): the quote path asks for a USD contract and step 1 measures no non-USD name.
4. `quoteSessionLabel` reads the early-close list kept beside the full-day holidays (P10); `isMarketClosed` and every other reader of the holiday calendar are unchanged.

## Self-review

- **Plan-review rulings:** P1 S4 (`applyTrialEdit`) and S1 (resize test); P2 S1 (`trialValuationPrice` over the book's rows); P3 S1 (`trialHoldingsByAccount`) and S4 (`holdingsChanged`); P4 S1 (`trialShortfalls`, `shortByName`) and S4; P5 S1 (`trialCrossing` kinds) and S4 (sentences); P6 S4 (`trialFormReducer`); P7 S4 (`initialGainsRequestState`); P8 S1 (`dailyBars`) and S4; P9 S1 (`checkTrialSecurity`) and S3 (body checks, zero-request tests); P10 S3 (`NYSE_EARLY_CLOSES`, conservative rule); P11 S1 (expired refusal), S3 (split validation), S4 (note).
- **Spec coverage:** R1 (S1 solve, valuation; S3 entry route), R2 (S1 valuation and entry price, S4 note), R3 (S1), R4 (S1 snapshot and `holdingsNowByAccount`, S4 note), R5 (S1 every-account count, S4 provider), R6 (S1), R7 (S1 cost kinds, S4 wording), R8 (S3 tick kind and session, S4 label), R9 (S2), R10 (S1 lookup, S3 sentence). Tests that must exist: unchanged pin, conservation, cost inside the line, driver put vs Black-Scholes, selling shares, no measured link, refusals, the quote, ensure bars, stale replies, crossing: S1-S4. Browser pass: S5.
- **Types:** `TrialPositionInput`, `GainsAtRiskTrialRow` (with `holdingsNowByAccount`), `GainsAtRiskTrialCrossing` (six kinds), `GainsAtRiskTrialResult` (with `shortByName`), `TrialEntryResult` (with `holdingsAtAddByAccount`), `OptionQuoteResult`, `EnsureDailyBarsResult` are defined once and consumed by name downstream; no task still names `holdingsNow`, `holdingsAtAdd` or the old crossing `reason`.
- **Steps:** signatures, rules and assertions only; every task ends in a hand-back.
- **Proportion:** shorter than the step 1 plan.

## Settled

- The owner's two pending changes are committed first, as S5a, before S4 edits the same files (accepted by the controller).
- A side change (buy or write, buy or sell) on an existing trial is a new entry under P1, recorded in the spec's P1 wording.

## OPEN — conflicts with the contract

None.
