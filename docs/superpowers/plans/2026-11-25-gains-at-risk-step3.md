# Gains at Risk, Step 3 (one stock as the driver, and a table of candidate options) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner stress one held name in both directions with every other position held still, and compare up to 30 broker-quoted bought options on one book, each sized to one dollar budget, then move any row into the step 2 trial list unchanged.

**Architecture:** The engine gains a driver kind (index, as today, or one name with a fixed ladder: the name and its share classes at 1, everything else held unchanged) and a candidate pass that prices each sized candidate with the same per-trial body, on one run context loaded once. Two broker functions in `lib/tws/` (a guarded chain reader and a quote batch) sit behind one market-data-type setter, a lock shared with step 2's single quote, and a count-then-take limiter. Sizing and the call-2 validator are import-free pure modules over one exact money unit. Five thin routes wrap them. The page adds a driver kind and a collapsed candidate section whose state lives in a plain reducer module.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, better-sqlite3, `@stoqey/ib` 1.5.3, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-gains-at-risk-step3-candidates-design.md` (owner approved 2026-11-25). Its D1-D11 win over P1-P23 where they differ. It builds on the step 1 and step 2 specs, whose rulings still bind.

## Global Constraints

- Every Global Constraint of `docs/superpowers/plans/2026-11-24-gains-at-risk-step2.md` still binds (read-only engine, no migration, no new dependency, no AI call, Mac-only with no Worker mirror or snapshot field, `todayET()`, option expiry only through `lib/compute/option-expiry.ts` / `isExpiredAsOf`, `getRiskFreeRate(db)`, scope `undefined` = every account and `[]` = none, the privacy components, "Year's gain so far", never "hedge"). The CLAUDE.md blocks "Rules from the 2026-11-24 Gains at risk build" and "Rules from the 2026-11-25 Gains at risk step 2" and `lib/tws/CLAUDE.md` bind.
- **Git:** implementers never run git. Each task hands back its file list; the controller commits with `git commit -F <scratchpad file> -- <paths>`, never a bare commit, never `git stash`, ending with the attribution line the controller's session states.
- **No live systems in a task:** never connect to TWS, never open the real database. Fake broker API (an injected `api` or `vi.mock("@/lib/tws/client")`), in-memory migrated SQLite, synthetic ZZ* tickers and invented figures only (the repo is public). A test needing today calls `todayET()` or injects `today`. Reviewer scratch never under the repo as `*.test.ts`.
- **Commands** run from the repo root with `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH`.
- **Exact values (from the spec, or fixed here where the spec left them to the plan):**
  - Single-name moves: `-0.8` to `+1.0` (P5); default sweep `-0.40` to `+0.40` in `0.05` steps (17 moves); at most `GAINS_AT_RISK_BOUNDS.maxMoves` (41). Index moves unchanged: down only on the page, `|move| <= 0.6` in the body.
  - Candidates: at most 15 contracts per quotes call, one underlying (D4); at most 3 expiries per chain pull; 5 default strikes per expiry; at most 30 candidates per compute (P10); contracts capped at `TRIAL_POSITION_BOUNDS.maxContracts` (500); Add respects `maxPositions` (12).
  - Money unit (D9): **1/10,000 of a dollar** ("units"). Budget accepted in whole cents only, above 0, at most **$10,000,000** (`maxBudgetUsd`, a round figure; spec "What is left to the builder"). Bid and ask must lie on the 1/10,000 grid (every US listed option tick, 0.01 or 0.05, does); a price off it is refused, never rounded. Per-contract price in units = `(bidUnits + askUnits) x 50` (exact: mid x 100 x 10,000). `contracts = min(floor(budgetUnits / perContractUnits), 500)` by integer division; `cost = contracts x perContractUnits`; `unspent = budgetUnits - cost`.
  - Quote limiter: 30 slots per rolling 60 s, shared with step 2's Get quote (`OPTION_QUOTE_RATE_LIMIT`, `OPTION_QUOTE_RATE_WINDOW_MS`).
  - Chain reader bound (D7): **12 broker requests per rolling 60 s** (`OPTION_CHAIN_RATE_LIMIT`); one expiries pull costs 1, one strikes pull costs one per chosen expiry. This is the app's own figure, not a broker figure.
  - Observation gap (D6): `CANDIDATE_MAX_OBSERVATION_GAP_SECONDS = 30`. Confirmed against the package: a snapshot completes "after 11s latest" (`node_modules/@stoqey/ib/dist/api-next/api-next.d.ts`, `getMarketData` `snapshot` parameter), so one contract's quote fits well inside 30 s of a fresh underlying snapshot.
  - Batch: contracts are requested ONE AFTER ANOTHER (no concurrency, so no broker pacing figure is relied on); overall deadline `OPTION_QUOTE_BATCH_DEADLINE_MS = 120_000`, checked after the lock and before every new broker operation, never during one (controller ruling on the snapshot cancel and F7, 2026-11-25); a snapshot in flight is awaited to its own end, with a per-snapshot backstop `OPTION_SNAPSHOT_BACKSTOP_MS = 13_000` (a little above the package's 11 s); worst-case overrun past the deadline is one operation. A contract-details call keeps `OPTION_QUOTE_TIMEOUT_MS` (15 s).
  - Old quote: `CANDIDATE_QUOTE_OLD_AFTER_MINUTES = 15` (14:59 not flagged, 15:00 flagged).
- **The market-data type is set only through `setMarketDataTypeCounted`** (`lib/tws/market-data-type.ts`, D2). No other `setMarketDataType(` call under `lib/` or `app/`.
- **Nothing about a candidate or a quote is stored.** No broker request before the body, the security, the connection, the sync and the limiter checks pass.

## Review Focus

The five input classes most likely to bite the owner that no spec test names; each now has a pinning test in the owning task.

1. **A share-class sibling as the driver** (the owner picks one class; the book holds the other class and options on it): every sibling row and option moves by exactly the driver move; a candidate on the sibling is not "held unchanged". `issuerSiblings` is a hard-coded map of real tickers, so the engine takes an injected `siblingsOf` and the test passes a ZZ family. Pinned in S1 and S3.
2. **A driver whose underlying has no securities row** (held only through options; picked by symbol, `securityId: null`): the options move by the driver move; the driver list carries it with no id; the candidate section refuses to open a chain for it. Pinned in S1 (engine, list), S4 (route), S6 (section).
3. **A budget that buys exactly N contracts at a price a double cannot hold** (mid 0.15, budget $45.00: a floating floor gives 2): contracts is 3, unspent is 0. Pinned in S3.
4. **A candidate on a name whose stored price is far from the quote's underlying price** (relative marking): at a 0% move on today's date its figure is exactly 0 less nothing (the entry was solved there), never "below exercise value", and its row is not refused. Pinned in S3.
5. **An empty stress scope (`[]`) with trial positions and candidates:** the book is empty, trials and candidates still price, and conservation holds with a zero book. Pinned in S3.

Also pinned: a selected move of exactly 0 in single-name mode reads "falls" (D5, S1); a single-name sweep with no negative move (S1); a locked quote (bid = ask) accepted by both calls (S2, S3).

---

## Rulings after the plan review (controller, 2026-11-25; all accepted, folded into the tasks below)

- **F1. Candidate state lives in an unkeyed `CandidatesProvider`** beside `TrialPositionsProvider`, above the scope-keyed `GainsAtRiskView` (`GainsAtRiskSection.tsx` renders the keyed view inside the provider today). A scope change keeps the rows and quotes, clears their figures, recomputes. Why: a scope pill must not throw away broker pulls. (S6)
- **F2. Call 1 returns, and the row keeps, the complete solved entry** (`buildTrialEntryById`'s ok record plus the price source and `appValuation`, the shape `trialStateFromEntry` already reads). Add passes it through; `candidateToTrial` looks nothing up. Why: a trial must be the very entry the row was measured with. (S4, S6)
- **F3. Broker contract identity end to end:** optional `brokerContractId` on the option trial input, the candidate entry, trial state and `cleanTrialPositions`. The holdings match uses it when both sides have one, else today's terms match. Absent: today's behaviour, both pins byte-identical. Why: an adjusted contract shares terms with a standard one. (S3, S4)
- **F4. The call-2 validator checks the whole entry** (strike, expiry through the option-expiry reader, `entryUnderlyingPrice`, `valuationPriceAtEntry`, `entryVolatility`, price paid, all inside `TRIAL_POSITION_BOUNDS`) and that every scaled-integer product is a safe integer; one 400 per field. Why: the body is client-supplied. The expiry reader is under `lib/compute`, so the validator moves there (OPEN 1). (S3)
- **F5. A failed observation-gap check is a refusal:** "not quoted: prices read too far apart", no entry; likewise an underlying snapshot with no price. `buildTrialEntryById` is never called for a candidate without the quote's own underlying price. Why: a stale underlying gives false refusals and false volatilities. (S2, S4)
- **F6. An accepted quote or entry replacement is a compute-input revision:** it bumps the compute sequence and clears the table's figures. Why: figures must answer the quotes on screen. (S6)
- **F7. Deadline and sync checks after the lock and before every new broker operation** (contract details, underlying snapshot, option snapshot, the retry); `isSyncing()` re-checked after the lock; only an operation already started is awaited. Why: the lock wait can be long. (S2)
- **F8. The candidate underlying list is server-built:** the driver list, SPY / QQQ / VTI, and the watchlist through its id reader `getActiveWatchlistSecurityIds` (`lib/queries/watchlist.ts:75`), each only when `checkTrialSecurity(requireContractId: true)` passes. Folded into the drivers route's reply (`candidateUnderlyings`). Default: the driver. (S1, S4, S6)
- **F9. One injected clock, `now: () => Date`,** through the batch, the chain reader, the quotes orchestrator and `buildTrialEntryById` (today derived as `todayET(now())`). Why: one instant per pull, testable. (S2, S3, S4)
- **F10. Add is enabled only for a priced, not refused row with contracts above 0 whose figures answer the inputs on screen, and only below `maxPositions`.** One test per disabled state. (S6)

---

## Pre-flight (controller, before any task)

- [ ] **Import ownership.** Who imports whom, value imports only (type imports are free):

| Module (owner) | May value-import | Must not value-import |
|---|---|---|
| `lib/analysis/gains-at-risk-constants.ts` (S0) | nothing | anything |
| `lib/analysis/gains-at-risk-candidate-money.ts` (S3) | the constants module | `lib/compute/*`, `lib/queries/*`, `lib/db*`, `lib/tws/*` |
| `lib/analysis/gains-at-risk-candidates-input.ts` (S4), `gains-at-risk-input.ts` (S4 after S2) | constants, money, `view-param` | as above |
| `lib/analysis/gains-at-risk-candidates-view.ts` (S6), `-view.ts`, `-trial-view.ts` (S5) | the `lib/analysis` modules above | as above |
| `lib/compute/gains-at-risk-candidate-check.ts` (S3, server only; see F4 and OPEN 1) | constants, money, `option-expiry`, `isTrialCalendarDay` | `lib/tws/*` |
| `lib/compute/gains-at-risk.ts`, `-trial.ts` (S1, then S3) | constants, existing imports, `lib/securities/issuer-family.ts` | `lib/tws/*` beyond today's `listDailyBarTargets` and type map |
| `lib/compute/gains-at-risk-drivers.ts` (S1) | `latest-holdings`, `option-expiry`, `cash-equivalents`, `security-type-map`, `checkTrialSecurity` / `lookupTrialSecurity`, `getActiveWatchlistSecurityIds` (`lib/queries/watchlist.ts:75`), `GAINS_AT_RISK_DRIVERS` | the engine |
| `lib/compute/gains-at-risk-candidates.ts` (S3) | the engine, money, check | `lib/tws/*` |
| `lib/tws/market-data-type.ts`, `option-quote.ts`, `option-quote-batch.ts`, `option-chain-reader.ts` (S2) | `@stoqey/ib`, `client`, `sync-state`, each other, the constants module | `lib/compute/*` |
| `lib/compute/gains-at-risk-candidate-quotes.ts` (S4) | the batch, `buildTrialEntryById`, `market-session`, money | — |
| Client components (S5, S6) | `lib/analysis/*`, `lib/ui/*`, `lib/privacy/*` | compute, queries, db, tws |

  A source test (S4 adds the new `lib/analysis` files, S6 the new components) walks this graph (T22).
- [ ] **S0 (controller): constants.** Append to `lib/analysis/gains-at-risk-constants.ts` (stays import-free), run `tests/lib/gains-at-risk-view.test.ts`, commit. S1 and S2 both read it; neither edits it.

```ts
/** Step 3 (P5): a single-name driver can fall or rise. Index drivers keep GAINS_AT_RISK_BOUNDS.moveAbsMax, down only. */
export const SINGLE_NAME_MOVE_BOUNDS = Object.freeze({ min: -0.8, max: 1.0 });
/** Step 3: the default single-name sweep, -40% to +40% in 5% steps. */
export const SINGLE_NAME_DEFAULT_SWEEP = Object.freeze({ from: -0.4, to: 0.4, step: 0.05 });
/** Step 3 (P10, P11, D4, D9). */
export const CANDIDATE_BOUNDS = Object.freeze({
  maxContractsPerPull: 15,
  maxExpiriesPerPull: 3,
  defaultStrikesPerExpiry: 5,
  maxCandidates: 30,
  maxBudgetUsd: 10_000_000,
});
/** Step 3 (P15): a quote this old is flagged "old quote". */
export const CANDIDATE_QUOTE_OLD_AFTER_MINUTES = 15;
/** Step 3 (D6): the largest gap between the underlying's and the option's arrival times. */
export const CANDIDATE_MAX_OBSERVATION_GAP_SECONDS = 30;
/** Step 3 (D9): money is computed in whole units of 1/10,000 of a dollar. */
export const MONEY_UNITS_PER_DOLLAR = 10_000;
```

- [ ] **`next build` at the first UI task:** S5 step 4 runs `npx next build` (seat a migrated `data/vanguard.db` copy in the worktree first, per CLAUDE.md "Dev Server Gotchas").

---

## Dependency graph and file ownership

```
S0 ──┬──> S1 ──> S3 ──┐
     └──> S2 ─────────┴──> S4 ──> S5 ──> S6 ──> S7
```

S1 and S2 share no file and run as parallel subagents. S3 needs S1 only and may start while S2 still runs (disjoint files). S4 needs S2 and S3. S5 needs S4. S6 needs S5 (it mounts in `GainsAtRiskSection.tsx` and `GainsAtRiskView.tsx` and extends the import-walk test). Controller gate after S1+S2 and after S3: `bash scripts/verify.sh full --base main`.

| Task | Files it alone may edit (during the task) | Must not touch |
|---|---|---|
| S0 | `lib/analysis/gains-at-risk-constants.ts` | everything else |
| S1 | `lib/compute/gains-at-risk.ts`, `lib/compute/gains-at-risk-trial.ts` (crossing direction only), `lib/compute/gains-at-risk-drivers.ts` (new), `lib/analysis/gains-at-risk-view.ts` (ONLY the two `BETA_SOURCE_LABELS` entries and the two `case` lines in `betaSourceLine` that the widened union forces), `tests/compute/gains-at-risk.test.ts`, `tests/compute/gains-at-risk-trial.test.ts`, `tests/compute/gains-at-risk-single-name.test.ts` (new), `tests/compute/gains-at-risk-drivers.test.ts` (new), `tests/fixtures/gains-at-risk-with-trial-pin.json` (new) | `lib/tws/*`, any route, any component |
| S2 | `lib/tws/market-data-type.ts` (new), `lib/tws/option-quote.ts`, `lib/tws/option-quote-batch.ts` (new), `lib/tws/option-chain-reader.ts` (new), `lib/tws/snapshot.ts`, `lib/tws/atm-straddle.ts`, `lib/tws/streaming.ts` (one-line setter swaps only), `lib/analysis/gains-at-risk-input.ts` (ONLY the new cases in `optionQuoteRefusalSentence`), `tests/tws/option-quote.test.ts`, `tests/tws/option-quote-batch.test.ts` (new), `tests/tws/option-chain-reader.test.ts` (new), `tests/tws/market-data-type.test.ts` (new), `tests/tws/snapshot.test.ts`, `tests/tws/atm-straddle.test.ts`, `tests/tws/streaming.test.ts` (fake updates only), `tests/repo/one-market-data-type-setter.test.ts` (new) | `lib/compute/*`, routes, components |
| S3 | `lib/compute/gains-at-risk.ts`, `lib/compute/gains-at-risk-trial.ts`, `lib/compute/gains-at-risk-candidates.ts` (new), `lib/compute/gains-at-risk-candidate-check.ts` (new), `lib/analysis/gains-at-risk-candidate-money.ts` (new), `tests/compute/gains-at-risk-candidates.test.ts` (new), `tests/compute/gains-at-risk-candidate-payoff.test.ts` (new), `tests/compute/gains-at-risk-candidate-check.test.ts` (new), `tests/lib/gains-at-risk-candidate-money.test.ts` (new), `tests/compute/gains-at-risk-trial.test.ts`, `tests/compute/gains-at-risk.test.ts` (F3 pin cases) | `lib/tws/*`, routes, components |
| S4 | `lib/analysis/gains-at-risk-input.ts`, `lib/analysis/gains-at-risk-candidates-input.ts` (new), `lib/compute/gains-at-risk-candidate-quotes.ts` (new), `app/api/compute/gains-at-risk/route.ts`, `app/api/compute/gains-at-risk/single-name-drivers/route.ts` (new), `app/api/compute/gains-at-risk/candidates/route.ts` (new), `app/api/tws/option-candidates/chain/route.ts` (new), `app/api/tws/option-candidates/quotes/route.ts` (new), `tests/api/compute-gains-at-risk.test.ts`, `tests/api/gains-at-risk-single-name-drivers.test.ts` (new), `tests/api/gains-at-risk-candidates.test.ts` (new), `tests/api/tws-option-candidates-chain.test.ts` (new), `tests/api/tws-option-candidates-quotes.test.ts` (new), `tests/auth/gains-at-risk-step3-routes.test.ts` (new), `tests/dashboard/gains-at-risk-view-source.test.ts` (ONLY adding the new `lib/analysis` files to the walk) | `lib/auth/route-policy.ts`, `proxy.ts`, `app/api/tws/option-chain/route.ts` |
| S5 | `lib/analysis/gains-at-risk-view.ts`, `lib/analysis/gains-at-risk-trial-view.ts`, `app/dashboard/components/gains-at-risk/GainsAtRiskSection.tsx`, `GainsAtRiskView.tsx`, `GainsAtRiskChart.tsx`, `DriverControl.tsx` (new), `tests/lib/gains-at-risk-view.test.ts`, `tests/lib/gains-at-risk-trial-view.test.ts`, `tests/dashboard/gains-at-risk-view-source.test.ts`, `tests/dashboard/gains-at-risk-single-name-source.test.ts` (new) | `TrialPositionForm.tsx`, `TrialPositionList.tsx`, `TrialPositionsProvider.tsx`, every candidate file |
| S6 | `lib/analysis/gains-at-risk-candidates-view.ts` (new), `app/dashboard/components/gains-at-risk/CandidatesProvider.tsx` (new, F1), `CandidateSection.tsx` (new), `CandidatePicker.tsx` (new), `CandidateTable.tsx` (new), `GainsAtRiskSection.tsx` (ONLY mounting `CandidatesProvider` beside `TrialPositionsProvider`), `GainsAtRiskView.tsx` (ONLY the import and the one mount line), `tests/lib/gains-at-risk-candidates-view.test.ts` (new), `tests/dashboard/gains-at-risk-candidates-source.test.ts` (new), `tests/dashboard/gains-at-risk-view-source.test.ts` (ONLY adding the new files to the walk) | every other file |
| S7 | `docs/DECISIONS.md`, `CLAUDE.md`, `docs/plans/TODO.md` | code |

Why S1 and S2 each touch a later task's file: S1 widens `GainsAtRiskBetaSource` and S2 widens `OptionQuoteRefusal`; both are read by exhaustive `Record` / `switch` code that fails the type-check until the new members are named. Each edit is the minimum, made before the owning later task starts, so no two tasks hold one file at once.

---

### Task S1: Engine, single-name driver

**Files:** as in the table.

**Interfaces:**
- Consumes: S0 constants; `issuerSiblings` (`lib/securities/issuer-family.ts`); `resolveLeveragedExposure`, `trackedIndexFor`; `latestHoldingsPredicate`; `liveOptionExpirationSql`; `isCashEquivalentSecurity`; `mapSecurityType`; `checkTrialSecurity`, `lookupTrialSecurity`; `getActiveWatchlistSecurityIds`; `GAINS_AT_RISK_DRIVERS`.
- Produces (`gains-at-risk.ts`, verbatim):
  ```ts
  export type GainsAtRiskDriverInput =
    | { kind: "index" }
    | { kind: "single-name"; symbol: string; securityId: number | null };
  // GainsAtRiskInput gains:
  //   driver?: GainsAtRiskDriverInput;   // absent = index, today's behaviour (P8)
  //   selectedMove?: number;             // must be one of `moves`; read for the crossing direction (D5) and by the candidate pass
  // In single-name mode `driverSymbol` is ignored for pricing; result.driverSymbol is driver.symbol (upper-cased).
  export interface GainsAtRiskOptions {
    trackedIndexSeeds?: Readonly<Record<string, string>>;
    /** Share-class family; default issuerSiblings. Tests inject a ZZ family (the shipped map holds real tickers). */
    siblingsOf?: (symbol: string) => readonly string[];
  }
  export type GainsAtRiskBetaSource =
    | DriverBetaSource | "owner" | "no-measured-link" | "not-modelled"
    | "held-unchanged"          // single-name: not the driver, not a sibling (never "no measured link")
    | "leveraged-not-linked";   // single-name: a flagged fund whose seed does not name the driver or a sibling
  // GainsAtRiskPositionCase gains (single-name mode only; absent in index mode):
  //   sideDown?: GainsAtRiskSide; sideUp?: GainsAtRiskSide;    // `side` equals sideDown in single-name mode
  // GainsAtRiskMoveRow gains (single-name mode only): split?: "down" | "up" | "none";
  //   on "none" (move 0) losersPnlUsd and offsetsPnlUsd are 0 and only bookPnlUsd is meaningful
  // GainsAtRiskCase["disclosures"] gains (single-name mode only): leveragedNotLinked?: GainsAtRiskDisclosure;
  // GainsAtRiskBetaEvidence gains (single-name mode only): notApplicable?: true   (all counts 0, driverBarsThrough null)
  // GainsAtRiskResult gains (single-name mode only): driverKind?: "single-name";
  // GainsAtRiskTrialCase gains (single-name mode only): crossingDirection?: "fall" | "rise";
  ```
- Produces (`gains-at-risk-trial.ts`): `trialCrossing(moves: number[], trialPnlByMove: number[], direction: "fall" | "rise" = "fall"): GainsAtRiskTrialCrossing`.
- Produces (`gains-at-risk-drivers.ts`, new):
  ```ts
  export type SingleNameDriverReason = "held" | "option-underlying" | "trial";
  export interface SingleNameDriverEntry {
    symbol: string;              // upper-cased, trimmed
    name: string | null;
    securityId: number | null;   // null: an option underlying with no securities row (F7)
    reasons: SingleNameDriverReason[];   // in this order, no duplicates
    /** A broker contract id is on file: candidates can be pulled for it. */
    hasContractId: boolean;
  }
  export function listSingleNameDrivers(db: Database.Database,
    opts: { trialUnderlyingIds: readonly number[]; today?: string }): SingleNameDriverEntry[];   // sorted by symbol
  export function findSingleNameDriver(list: readonly SingleNameDriverEntry[],
    req: { securityId: number } | { symbol: string }): SingleNameDriverEntry | null;
  /** F8: names the candidate section may pull a chain for. */
  export type CandidateUnderlyingReason = "driver-list" | "index" | "watchlist";
  export interface CandidateUnderlyingEntry { securityId: number; symbol: string; name: string | null; reasons: CandidateUnderlyingReason[] }
  export function listCandidateUnderlyings(db: Database.Database,
    opts: { drivers: readonly SingleNameDriverEntry[]; today?: string }): CandidateUnderlyingEntry[];   // sorted by symbol
  ```

Rules:
- **List (P1):** every non-option security held (non-zero latest row, `latestHoldingsPredicate({ includeShorts: true })`) in ANY account; the underlying of every held live option (`liveOptionExpirationSql`), by its row when one exists, else its stored `underlying_symbol` with `securityId: null`; every id in `trialUnderlyingIds` that is a non-option row. Left out: `isCashEquivalentSecurity` rows and rows whose `mapSecurityType(security_type)` is the bond class. One entry per security id, or per upper-cased symbol when there is no id. The list never depends on the stress scope.
- **Candidate underlyings (F8):** every driver-list entry with a security id; the rows `lookupTrialSecurity` finds for `GAINS_AT_RISK_DRIVERS` (SPY, QQQ, VTI); every id from `getActiveWatchlistSecurityIds(db)` (the watchlist's one id reader, `lib/queries/watchlist.ts:75`). Each kept only when `checkTrialSecurity(db, id, { requireContractId: true }).ok`; one entry per id with its reasons. A symbol-only driver entry (no row) is never on it.
- **Ladder (engine change 2):** in single-name mode `resolveDriverBeta` is never called and no driver bars are read. First match wins: identity symbol or stored underlying symbol in `siblingsOf(driver.symbol)` (case-insensitive; includes the driver), or identity id equal to `driver.securityId`: beta 1, source `"driver"`; a flagged leveraged fund (`resolveLeveragedExposure`) whose `trackedIndexFor` seed names the driver or a sibling: signed factor, source `"leveraged"` with `trackedBeta: 1`; any other flagged fund: 0, `"leveraged-not-linked"`; everything else (cash-equivalent, bond, every other name): 0, `"held-unchanged"`. No `evidence`, no `noMeasuredLinkReason`. Every `betaOverrides` key is counted ignored and none is applied (T5). One case computed; `measured` and `selloff` hold equal values (P20).
- **Volatility (P4):** `volChange` reaches an option only when its identity is the driver or a sibling; 0 for every other option, book or trial.
- **Sides (engine change 4):** `sideDown = sideOf(exposure, pnl, expires ? mostNegativeIndex : null)`; `sideUp = sideOf(-exposure, pnl, expires ? mostPositiveIndex : null)`. `caseFor` totals a move `< 0` with `sideDown`, `> 0` with `sideUp`, `0` as `split: "none"`. Index mode: no new field anywhere (P8).
- **Bounds:** in single-name mode a move below `SINGLE_NAME_MOVE_BOUNDS.min` or above `.max` throws `GainsAtRiskInputError`; `selectedMove`, when given, must equal one of `moves` (throws otherwise). Index mode keeps today's checks only.
- **Crossing (engine change 8, D5):** `"rise"` reads moves `>= 0` ordered by growing size with the same six kinds (`worse-at-every-move.deepestMove` is then the highest move). Direction: index mode always `"fall"` and no `crossingDirection` key; single-name `"fall"` when `selectedMove` is absent, negative or zero, `"rise"` when positive; never from a row's right.
- **Trials in single-name mode:** the same ladder, side and volatility rules as book rows (P7).

- [ ] **Step 1: Freeze step 2 with trials.** With the code unchanged and `vi.setSystemTime(new Date("2026-11-10T15:00:00Z"))`, a one-off `npx tsx` command (not committed) runs `computeGainsAtRisk` over the step 2 trial seeds of `tests/compute/gains-at-risk.test.ts` (a bought put on the driver, a written call, a share sale leaving a shortfall, an expired retained option, a no-link name) and writes `tests/fixtures/gains-at-risk-with-trial-pin.json` with the same reviver convention as the no-trial pin.
- [ ] **Step 2: Write the failing tests.** `tests/compute/gains-at-risk.test.ts` adds:

```ts
it("T1 index mode unchanged: both pins byte-identical with driver absent and with { kind: 'index' }; no step 3 key", () => {
  for (const c of [...pin, ...withTrialPin]) for (const driver of [undefined, { kind: "index" } as const]) {
    const r = computeGainsAtRisk(db, { ...c.input, driver });
    expect(r).toStrictEqual(c.result);
    for (const k of ["driverKind", "candidates"]) expect(k in r).toBe(false);
  }
});
```

`tests/compute/gains-at-risk-single-name.test.ts` (ZZA driver, ZZA2 its sibling via injected `siblingsOf`, ZZB another name, ZZQ an index, a 2x fund ZZL, an inverse fund ZZI, an option whose underlying ZZN has no row):
```ts
const sweep = [-0.4, -0.35, /* … */ 0, /* … */ 0.4];   // 17 moves
it("T2 conservation both directions: per move book = Σ rows = losers + offsets to the cent; zero row: book = Σ rows, split none", () => {});
it("T3 what moves: ZZA and ZZA2 shares change by exactly value x move; an option on either repriced at the move; ZZB shares exactly 0; a ZZB option equals its time-only figure", () => {});
it("an option on ZZN (no row) moves with a driver picked by symbol, securityId null", () => {});
it("T4 +20 vol points: ZZB options equal the 0-point run; ZZA options change", () => {});
it("T5 betaOverrides on ZZB and ZZA: result equals the run without them; betaOverridesIgnored === 2", () => {});
it("T6 split: up row: short ZZA and a bought ZZA put lose, a bought ZZA call offsets; down row the reverse; an expiring row takes sideDown at -0.4 and sideUp at +0.4", () => {});
it("T7 seed { ZZL: 'ZZA' }: ZZL moves 2x, ZZI against; no seed: both held unchanged and listed under leveragedNotLinked", () => {});
it("T8 a move of -0.81 or 1.01 throws; selectedMove not in moves throws", () => {});
it("P20 measured and selloff are toStrictEqual; driverKind 'single-name'; betaEvidence.notApplicable; driver bars never read (spy getOhlcvBars)", () => {});
it("a sweep with no negative move: no crash, sideDown present, every row split 'up' or 'none'", () => {});
it("trials: a ZZA trial put moves; a ZZB trial put shows time only; crossingDirection follows selectedMove", () => {});
```
`tests/compute/gains-at-risk-trial.test.ts` adds:
```ts
it("T21 trialCrossing rise mirrors every fall pattern", () => {
  expect(trialCrossing([0, 0.05, 0.1], [-100, -20, 60], "rise")).toEqual({ kind: "pays-beyond", move: expect.closeTo(0.0625, 9) });
  expect(trialCrossing([0, 0.05, 0.1], [-10, -20, -30], "rise")).toEqual({ kind: "worse-at-every-move", deepestMove: 0.1 });
  expect(trialCrossing([0, 0.05, 0.1], [40, 10, -30], "rise")).toEqual({ kind: "helps-until", move: expect.closeTo(0.0625, 9) });
  expect(trialCrossing([0, -0.05], [-10, 20], "rise")).toEqual({ kind: "worse-at-every-move", deepestMove: 0 });   // falls ignored
  expect(trialCrossing([0, -0.05, -0.1], [-100, -20, 60])).toEqual({ kind: "pays-beyond", move: expect.closeTo(-0.0625, 9) }); // default fall unchanged
});
it("T21 engine: selectedMove 0 and -0.2 read fall, +0.2 reads rise; index mode reads fall with no crossingDirection key", () => {});
it("T21 a call on an inverse fund on the driver (seeded) and a name with a negative owner figure (index mode) are read by the driver's direction, not their right", () => {});
```
`tests/compute/gains-at-risk-drivers.test.ts`:
```ts
it("T20 lists held non-options, option underlyings with and without a row, and trial underlyings, with reasons in order", () => {});
it("leaves out a cash-equivalent fund and a bond; a security held in no account and not a trial is absent", () => {});
it("findSingleNameDriver by id and by symbol; a name not listed is null", () => {});
it("hasContractId false for a row with no ib_con_id and for a symbol-only entry", () => {});
it("F8 candidate underlyings: driver-list names, the index rows and active watchlist names, each with a contract id, non-option and US-dollar; a contract-less, a non-dollar and an inactive watchlist name are absent; a symbol-only driver is absent", () => {});
```
- [ ] **Step 3: Run to verify they fail.** `npx vitest run tests/compute/gains-at-risk*.test.ts`. Expected: new tests FAIL; both pins PASS.
- [ ] **Step 4: Implement.** No function bodies are fixed here beyond the rules above.
- [ ] **Step 5: Run** the four files, `tests/compute/driver-beta.test.ts`, `tests/compute/option-reprice*.test.ts`, `tests/lib/gains-at-risk-view.test.ts`, then `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Hand back** the files. Controller commits ("Gains at risk engine: one stock or fund as the driver").

---

### Task S2: Broker, one setter, a lock, the chain reader and the quote batch

**Files:** as in the table. No file shared with S1.

**Interfaces:**
- Consumes: `@stoqey/ib` 1.5.3 (`IBApiNext.setMarketDataType`, `getMarketData(contract, genericTickList, snapshot, regulatorySnapshot): Observable<MarketDataUpdate>`, `getContractDetails(contract): Promise<ContractDetails[]>`, `getSecDefOptParams(symbol, futFopExchange, SecType, conId): Promise<SecurityDefinitionOptionParameterType[]>`); `getIbApi`; `isSyncing` (`lib/tws/sync-state.ts:104`); S0 constants.
- Produces (`lib/tws/market-data-type.ts`, new):
  ```ts
  /** The ONE caller of api.setMarketDataType. Sets the type, bumps the process counter (globalThis), returns the new value. */
  export function setMarketDataTypeCounted(api: Pick<IBApiNext, "setMarketDataType">, type: MarketDataType): number;
  export function marketDataTypeGeneration(): number;
  ```
- Produces (`lib/tws/option-quote.ts`, additions):
  ```ts
  export type OptionQuoteRefusal = /* today's seven */ | "broker-busy";
  /** Serialises the single quote and the batch (globalThis promise chain). Waiting counts toward the caller's own deadline. */
  export function withOptionQuoteLock<T>(fn: () => Promise<T>): Promise<T>;
  /** D7 count-then-take: takes min(n, free) slots synchronously (one call, no slot can change hands between count and take). */
  export function reserveOptionQuoteSlots(n: number, now?: number): { granted: number; retryAfterSeconds: number | null };
  /** The shared single-contract read: one snapshot subscription, the tick rules (sentinel, live then delayed). Resolves on the
   *  snapshot's own completion, on the backstop (`OPTION_SNAPSHOT_BACKSTOP_MS`), on a disconnect, or on a throw; always unsubscribes.
   *  Never resolves early for a caller's deadline. Used by fetchOptionQuote and the batch; never copied. */
  export const OPTION_SNAPSHOT_BACKSTOP_MS = 13_000;
  export function snapshotTicks(api: IBApiNext, contract: Contract,
    opts: { backstopMs?: number; now: () => Date }):
    Promise<{ ok: true; ticks: ReadonlyMap<number, { value?: number }>; arrivedAt: string } | { ok: false; reason: "timeout" | "disconnected" | "error"; error?: unknown }>;
  /** The two-sided rule (both positive, bid <= ask; a locked market is a market). */
  export function twoSidedQuote(ticks: ReadonlyMap<number, { value?: number }>):
    { ok: true; bid: TickFigure; ask: TickFigure; last: TickFigure | null } | { ok: false; bid: number | null; ask: number | null; last: number | null };
  export interface TickFigure { value: number; delayed: boolean }
  // fetchOptionQuote: unchanged signature and result; now runs under withOptionQuoteLock, sets the type through
  // setMarketDataTypeCounted, reads through snapshotTicks / twoSidedQuote, and retries ONCE when the generation
  // moved while in flight, then answers "broker-busy".
  ```
- Produces (`lib/tws/option-chain-reader.ts`, new):
  ```ts
  export const OPTION_CHAIN_RATE_LIMIT = 12;
  export const OPTION_CHAIN_RATE_WINDOW_MS = 60_000;
  /** All or nothing: n slots or none, with the retry time. */
  export function reserveOptionChainSlots(n: number, now?: number): { ok: true } | { ok: false; retryAfterSeconds: number };
  export function resetOptionChainLimiter(): void;   // tests only
  export interface ChainContract { conId: number; strike: number; tradingClass: string; multiplier: 100 }
  export type OptionChainRequest = { underlyingSecurityId: number; right: "put" | "call"; expiries?: string[] };   // 1..3 when present
  export type OptionChainResult =
    | { ok: true; kind: "expiries"; expiries: string[] }   // YYYY-MM-DD, today or later, ascending, unique
    | { ok: true; kind: "strikes"; byExpiry: { expiry: string; contracts: ChainContract[]; droppedNonStandard: number; droppedAmbiguous: number }[] }
    | { ok: false; reason: "not-connected" | "no-underlying-contract" | "rate-limit" | "timeout" | "broker-error"; retryAfterSeconds?: number };
  export function fetchOptionChain(db: Database.Database, req: OptionChainRequest,
    deps?: { api?: IBApiNext | null; now?: () => Date; timeoutMs?: number }): Promise<OptionChainResult>;   // today = todayET(now()) (F9)
  ```
- Produces (`lib/tws/option-quote-batch.ts`, new):
  ```ts
  export const OPTION_QUOTE_BATCH_DEADLINE_MS = 120_000;
  export interface BatchContractRequest { conId: number; right: "put" | "call"; expiry: string; strike: number; multiplier: 100; tradingClass: string }
  export interface OptionQuoteBatchRequest { underlyingSecurityId: number; contracts: BatchContractRequest[] }   // 1..15
  export type BatchContractRefusal =
    | "not-standard-contract" | "not-quoted-rate-limit" | "not-quoted-timed-out" | "broker-disconnected"
    | "not-quoted-broker-busy" | "not-quoted-sync-running"
    | "not-quoted-prices-too-far-apart"    // F5: the gap check failed after one fresh underlying snapshot
    | "not-quoted-no-underlying-price"     // F5: the underlying snapshot carried no positive last
    | "off-tick-grid" | "no-two-sided-quote" | "timeout" | "broker-error";
  export type BatchContractResult =
    // F5: an ok row ALWAYS carries the underlying's own price and both arrival times, at most 30 s apart.
    | { conId: number; ok: true; bid: number; ask: number; mid: number; last: number | null; tickKind: QuoteTickKind;
        optionObservedAt: string; underlyingObservedAt: string; underlyingPrice: number }
    | { conId: number; ok: false; reason: BatchContractRefusal; retryAfterSeconds?: number;
        bid: number | null; ask: number | null; last: number | null };
  export type OptionQuoteBatchResult =
    | { ok: true; contracts: BatchContractResult[] }   // request order, one per requested contract
    | { ok: false; reason: "not-connected" | "no-underlying-contract" | "sync-running" | "rate-limit"; retryAfterSeconds?: number };
  export function fetchOptionQuoteBatch(db: Database.Database, req: OptionQuoteBatchRequest,
    deps?: { api?: IBApiNext | null; now?: () => Date; timeoutMs?: number; deadlineMs?: number; isSyncing?: () => boolean }): Promise<OptionQuoteBatchResult>;
  ```

Rules:
- **Setter (D2):** the four modules swap each `api.setMarketDataType(X)` for `setMarketDataTypeCounted(api, X)` (`streaming.ts:262` becomes `if (api) setMarketDataTypeCounted(api, MarketDataType.REALTIME)`), with no other change. `tests/repo/one-market-data-type-setter.test.ts` scans `lib/` and `app/` and allows `setMarketDataType(` only in `lib/tws/market-data-type.ts`.
- **Snapshot form (D7, controller ruling 2026-11-25):** `snapshotTicks` subscribes `api.getMarketData(contract, "", true, false)`, keeps the latest `update.all`, and resolves on the snapshot's completion or, as a backstop only, after `OPTION_SNAPSHOT_BACKSTOP_MS`. It is never cut short for a deadline. On a disconnect or a throw it unsubscribes and resolves `ok: false`; late ticks after unsubscribe are ignored. **Package fact:** in `@stoqey/ib` 1.5.3 unsubscribing a SNAPSHOT sends no `cancelMktData` (`node_modules/@stoqey/ib/dist/api-next/api-next.js:1607-1611`), so no code or comment claims a broker-side cancel; the broker closes a snapshot itself within 11 s (package doc on `getMarketData`). Why: restoring the type under a pending snapshot is the race D2 exists to stop.
- **Batch order (P10, D2, D7):** connection (`not-connected`), underlying row with `ib_con_id` (`no-underlying-contract`), `isSyncing()` (`sync-running`), then `reserveOptionQuoteSlots(contracts.length)`: 0 granted refuses the whole pull (`rate-limit` with `retryAfterSeconds`) and sends nothing; `granted < n` quotes the first `granted` and returns the rest `not-quoted-rate-limit` with no request for them. Only then: acquire `withOptionQuoteLock` (the wait counts toward the deadline); re-check `isSyncing()` (F7: a sync started during the wait refuses the whole pull `sync-running`, zero broker requests); set DELAYED_FROZEN once through the helper (record the generation); take ONE underlying snapshot; then per contract in order: one `getContractDetails({ conId, secType: OPT, exchange: "SMART", currency: "USD" })`; the D1 check; the D6 check; one option snapshot, awaited to its own end; the generation check. **F7: before EVERY new broker operation** (the type setting, each contract-details request, each underlying snapshot, each option snapshot, the one retry) the batch checks the deadline and `isSyncing()`: past the deadline, this and every later contract read `not-quoted-timed-out`; a sync running, they read `not-quoted-sync-running`; in both cases nothing more is sent. Only an operation already started is awaited. The type is restored and the lock released only after no snapshot is pending: in a `finally`, after the in-flight snapshot has settled (or, on a disconnect or throw, after it is unsubscribed), restore REALTIME once through the helper when still connected, then release the lock.
- **D1 check:** exactly one returned detail whose `contract.conId` equals the request, `contract.symbol` equals the underlying's symbol, `right` matches, `lastTradeDateOrContractMonth` equals the expiry as YYYYMMDD, `strike` equals exactly, `Number(multiplier) === 100`, `tradingClass` equals the request's AND the underlying's symbol. Anything else, or two matches: `not-standard-contract`, no price.
- **D6:** before each option snapshot, when `now - underlyingObservedAt > (gap - 11 s)`, take a fresh underlying snapshot first. After the option arrives, when `|optionObservedAt - underlyingObservedAt| > gap`, take one more underlying snapshot (subject to the F7 checks); if the gap still exceeds 30 s the row is refused `not-quoted-prices-too-far-apart` with no price (F5, never a fallback). An underlying snapshot with no positive last refuses every contract that would use it `not-quoted-no-underlying-price`.
- **Generation (D2):** if the generation differs from the batch's own after a contract's snapshot, set the type again (new own generation) and re-request that contract once; a second change: `not-quoted-broker-busy`. The single quote does the same.
- **Mid on the grid:** bid and ask must be whole multiples of 1/10,000 (`|x x 10_000 - round| <= 1e-6`), else `off-tick-grid` with no price; `mid = (bidUnits + askUnits) / 20_000`, never rounded to a coarser grid.
- **Deadline / disconnect / throw:** the deadline is checked before every new broker operation and never interrupts one already started (F7), so the worst-case overrun is one operation (a snapshot up to the backstop, or a contract-details call up to its 15 s timeout). Contracts not reached read `not-quoted-timed-out`, or `broker-disconnected` when `getIbApi()` is null; never a throw out of the function. One content-free log line per failure stage (stage and code only).
- **Chain (P11, D1, D7):** order: connection, underlying row with `ib_con_id`, `reserveOptionChainSlots(expiries ? expiries.length : 1)`, then the broker. Without expiries: one `getSecDefOptParams(symbol, "", SecType.STK, conId)`; expiries from entries with `Number(multiplier) === 100`, today or later. With expiries: per expiry one `getContractDetails({ symbol, secType: OPT, exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth, right, multiplier: 100 })`; keep details with `conId > 0`, `Number(multiplier) === 100`, `tradingClass === symbol` and matching expiry (others counted `droppedNonStandard`); a strike with two kept contracts is dropped (`droppedAmbiguous`). Strikes ascending. Contract-details requests have no cancel; on a timeout the reader stops sending and ignores late replies. Not on the historical-data limiter.

- [ ] **Step 1: Write the failing tests** (fake `IBApiNext`: `getMarketData` returns a controllable Observable whose subscriptions are counted and whose unsubscribe is spied; `getContractDetails` and `getSecDefOptParams` scripted; a fake clock).

```ts
// tests/tws/market-data-type.test.ts
it("sets the type and bumps the generation by one per call", () => {});
// tests/repo/one-market-data-type-setter.test.ts
it("T25 no setMarketDataType( call under lib/ or app/ outside lib/tws/market-data-type.ts", () => {});
// tests/tws/snapshot.test.ts, atm-straddle.test.ts, streaming.test.ts: existing cases unchanged and green;
// one added case each: the same DELAYED_FROZEN / REALTIME sequence as before, now through the helper (generation moves).
// tests/tws/option-quote.test.ts (fakes move from getMarketDataSnapshot to getMarketData; every existing expectation kept)
it("T25 a generation change in flight retries once; a second change answers broker-busy", () => {});
it("T25 a single quote started during a batch waits for the lock: the fake sees no interleaved request", () => {});
it("T13 one-sided, crossed and empty quotes fill nothing; a locked quote (bid === ask) fills", () => {});
// tests/tws/option-quote-batch.test.ts
it("refusals before sending: not connected, no contract id, a sync running → zero broker calls (spies)", () => {});
it("T15 no free slot: whole pull refused with retryAfterSeconds, zero calls; 30 - 25 = 5 free of 8 asked: 5 quoted, 3 not-quoted-rate-limit, no request for them", () => {});
it("T24 a description differing in symbol, right, expiry, strike, multiplier or trading class, or matching twice → not-standard-contract, no price", () => {});
it("one type setting per batch, restored once; contracts requested one after another (never two open subscriptions)", () => {});
it("T27 with a fake clock, a contract whose quote would land more than 30 s after the underlying gets a fresh underlying snapshot first", () => {});
it("F5 a gap still over 30 s after the fresh snapshot: not-quoted-prices-too-far-apart, no bid/ask filled; an underlying with no last: not-quoted-no-underlying-price", () => {});
it("F7 lock-wait overrun: the deadline passes while waiting for the lock → every row timed out, zero broker calls, type never set", () => {});
it("F7 a sync starting during the lock wait → whole pull sync-running, zero broker calls", () => {});
it("F7 lookup overrun: the deadline passes during a contract-details call → its reply is awaited, no snapshot is sent for it, later rows timed out", () => {});
it("F7 retry overrun: the deadline passes before the one generation retry → the retry is not sent; the row is timed out", () => {});
it("F7 a sync starting mid-batch: later rows not-quoted-sync-running, no request for them", () => {});
it("F9 one injected now(): every arrival time and the deadline read it", () => {});
it("T28 a deadline passing while a snapshot is pending (controllable fake snapshot): the lock is held and REALTIME not restored until it settles; then restored once, lock released", () => {});
it("T28 no broker operation starts after the deadline (no getContractDetails, no getMarketData); unreached rows read not-quoted-timed-out", () => {});
it("T28 a snapshot that never completes ends at the 13 s backstop, then the type is restored and the lock released", () => {});
it("T28 a disconnect and a throw: the subscription is unsubscribed, the type restored only if still connected, the lock released in finally; unreached rows broker-disconnected", () => {});
it("no broker cancel is claimed: the fake's cancelMktData is never called for a snapshot", () => {});
it("bid 0.15, ask 0.15 locked: ok, mid 0.15; bid 0.12345 → off-tick-grid", () => {});
it("reserveOptionQuoteSlots shares the 30-per-minute window with takeOptionQuoteSlot", () => {});
// tests/tws/option-chain-reader.test.ts
it("expiries: today or later, multiplier 100 only, ascending, unique", () => {});
it("T24 strikes per expiry: conId, trading class, multiplier 100 per strike; non-standard and doubled strikes dropped and counted", () => {});
it("D7 bound: a pull needing more than the free slots is refused with retryAfterSeconds and sends nothing", () => {});
it("refusals before sending: not connected, no contract id → zero calls", () => {});
```
- [ ] **Step 2: Run to verify they fail.** Expected: new tests FAIL; existing broker tests PASS until the fakes are switched in step 3.
- [ ] **Step 3: Implement**, including the minimum `optionQuoteRefusalSentence` case for `"broker-busy"`: "The broker was busy with another request. Try again in a moment."
- [ ] **Step 4: Run** every `tests/tws/*` file listed, `tests/repo/one-market-data-type-setter.test.ts`, `tests/api/tws-option-quote.test.ts`, then `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Hand back.** Controller commits ("Broker: one market-data-type setter, a quote lock, the chain reader and the quote batch").

**Controller gate after S1 and S2:** `bash scripts/verify.sh full --base main` passes.

---

### Task S3: Engine, candidates, sizing and the call-2 validator

Starts after S1 (same engine files).

**Interfaces:**
- Consumes: S1 (driver kind, sides, `trialCrossing` direction); S0 constants.
- Produces (`lib/analysis/gains-at-risk-candidate-money.ts`, new, imports only the constants module):
  ```ts
  /** Exact units of 1/10,000 of a dollar, or null when not finite, negative, or off the grid (|x*10_000 - round| > 1e-6). */
  export function toMoneyUnits(x: number): number | null;
  /** Whole cents only, above 0, at most maxBudgetUsd; else null. */
  export function budgetToUnits(budgetUsd: number): number | null;
  export interface CandidateSizing {
    perContractUnits: number;   // (bidUnits + askUnits) x 50
    contracts: number;          // min(floor(budget / perContract), maxContracts)
    capped: boolean;            // the floor exceeded maxContracts
    costUnits: number;          // contracts x perContractUnits
    unspentUnits: number;       // budgetUnits - costUnits
  }
  export function sizeCandidate(budgetUnits: number, bidUnits: number, askUnits: number, maxContracts?: number): CandidateSizing;
  export function unitsToUsd(units: number): number;   // display and the engine's dollars: units / 10_000
  ```
- Produces (`lib/compute/gains-at-risk-candidate-check.ts`, new, server only; value-imports constants, money, `normalizeOptionExpiration`, `isTrialCalendarDay`; F4 and OPEN 1):
  ```ts
  export interface CandidateQuoteFields {
    bid: number; ask: number; mid: number; tickKind: "live" | "delayed";
    session: "regular-session" | "market-closed";
    // F5: always the quote's own underlying, at most 30 s from the option.
    optionObservedAt: string; underlyingObservedAt: string; underlyingPrice: number;
  }
  export interface CandidateRequestItem {
    conId: number; underlyingSecurityId: number;
    right: "put" | "call"; expiry: string; strike: number; multiplier: 100; tradingClass: string;
    quote: CandidateQuoteFields;
    /** As call 1 returned it (buildTrialEntryById's position), never re-solved. brokerContractId === conId (F3). */
    entry: { kind: "option"; underlyingSecurityId: number; right: "put" | "call"; side: "buy"; expiry: string; strike: number;
             contracts: number; pricePaid: number; entryUnderlyingPrice: number; valuationPriceAtEntry: number; entryVolatility: number;
             brokerContractId: number };
  }
  /** D3 + F4: null, or one sentence naming the field (`candidates[i].<field>`). */
  export function candidateItemProblem(item: unknown, index: number): string | null;
  /** The list: 1..maxCandidates, unique conId, each item checked. */
  export function candidatesProblem(value: unknown): string | null;
  ```
- Produces (`gains-at-risk.ts`, additions):
  ```ts
  export interface GainsAtRiskCandidateInput { id: string; position: Extract<TrialPositionInput, { kind: "option" }> }   // side "buy", contracts >= 1
  // GainsAtRiskInput gains: candidates?: GainsAtRiskCandidateInput[];   (requires selectedMove; at most maxCandidates; unique ids)
  export interface GainsAtRiskCandidateCase {
    beta: number | null;
    pnlByMove: number[];           // the candidate alone, net of its price paid, per input move
    atSelectedMoveUsd: number;
    atZeroMoveUsd: number;         // evaluated on the run context whether or not 0 is in moves (D10)
    crossing: GainsAtRiskTrialCrossing;
    crossingDirection: "fall" | "rise";
    /** P13a: this run holds the candidate's underlying unchanged in this case. */
    heldUnchanged: boolean;
  }
  export interface GainsAtRiskCandidateResult {
    id: string; identitySecurityId: number; symbol: string;
    betaSource: GainsAtRiskBetaSource;
    refusal?: TrialRefusal;
    valueUsd: number | null;
    cost: TrialCost | null;        // premium-paid
    cases: Record<GainsAtRiskCaseKey, GainsAtRiskCandidateCase> | null;   // null when refused
  }
  // GainsAtRiskResult gains: candidates?: GainsAtRiskCandidateResult[]   (ABSENT when candidates is absent or empty)
  ```
- Produces (`gains-at-risk-trial.ts`):
  ```ts
  export type TrialEntryByIdRequest = { kind: "option"; underlyingSecurityId: number; right: "put" | "call"; side: "buy" | "write";
    expiry: string; strike: number; contracts: number; price: number;
    /** F5: required for a candidate (the quote's own underlying); the step 2 symbol path may still omit it. */
    quotedUnderlyingPrice?: number;
    /** F3: copied onto position.brokerContractId. */
    brokerContractId?: number };
  /** Engine change 7: buildTrialEntry's body for a security id; no symbol lookup. buildTrialEntry = symbol lookup + this body.
   *  F9: one clock; today = todayET(now()). buildTrialEntry's own (today, now: Date) options are unchanged for step 2. */
  export function buildTrialEntryById(db: Database.Database, req: TrialEntryByIdRequest, opts?: { now?: () => Date }): TrialEntryResult;
  // F3 (gains-at-risk.ts): the option arm of TrialPositionInput gains `brokerContractId?: number` (a positive safe integer when
  // present; checkTrialPositions refuses anything else). trialHoldingsByAccount: an option row whose securities.ib_con_id and the
  // trial's brokerContractId are both present matches by id equality only; otherwise today's terms match. Absent: exactly today.
  ```
- Produces (`lib/compute/gains-at-risk-candidates.ts`, new):
  ```ts
  export type CandidateRow =
    | { conId: number; status: "priced"; contracts: number; capped: boolean; perContractUsd: number; costUsd: number; unspentUsd: number;
        quote: CandidateQuoteFields & { source: "client-supplied" }; engine: GainsAtRiskCandidateResult }
    | { conId: number; status: "zero-contracts"; perContractUsd: number; quote: CandidateQuoteFields & { source: "client-supplied" } }
    | { conId: number; status: "refused"; refusal: TrialRefusal; contracts: number; perContractUsd: number;
        quote: CandidateQuoteFields & { source: "client-supplied" } };
  /** Sizes (D9), then ONE engine run with every candidate of at least one contract. `result` carries no candidates key. */
  export function computeGainsAtRiskCandidates(db: Database.Database, input: GainsAtRiskInput,
    req: { budgetUsd: number; selectedMove: number; candidates: CandidateRequestItem[] }, opts?: GainsAtRiskOptions):
    { result: GainsAtRiskResult; rows: CandidateRow[] };   // rows in request order
  ```

Rules:
- **Run context (engine change 6):** the trial pass's per-row body becomes one function over a run context (loaded rows, risk-free rate, betas memo, `ladderFor`, clock, volatility rule, sides); trials and candidates call it. The book is loaded once per run (T11). Candidate rows never enter `positions`, `trial`, net cash, shortfalls, a disclosure or `betaOverridesIgnored`.
- **Per candidate and case:** the trial body's `pnlByMove` at the candidate's size; `atSelectedMoveUsd` = its figure at `selectedMove`; `atZeroMoveUsd` = the same body priced at move 0 at the valuation date (D10, an extra pricing when 0 is not in `moves`); `crossing = trialCrossing(moves, pnlByMove, direction)` with direction from the driver (S1 rule); `heldUnchanged` when the case beta is 0 and the source is `held-unchanged`, `leveraged-not-linked` or `no-measured-link`. Refusals are the trial refusals.
- **Sizing (D9):** `computeGainsAtRiskCandidates` reads bid and ask through `toMoneyUnits`, sizes, sets `position.contracts = contracts` and `position.pricePaid = entry.pricePaid` (equal to the mid by D3), and leaves zero-contract rows out of the engine call. `costUsd = unitsToUsd(costUnits)`; the engine's own premium-paid cost must equal it to the cent (asserted in a test).
- **Validator (D3, F4):** a written option, an unknown right, a non-positive or crossed quote (bid > ask; bid === ask accepted), a bid or ask off the grid, `2 x mid` off the 1/20,000 grid or not equal to `bid + ask` in units, `entry.pricePaid !== quote.mid`, entry contract fields (underlying, right, expiry, strike, `brokerContractId`) differing from the item's, `multiplier !== 100`, a `tradingClass` that is empty, a non-positive-integer `conId`, a duplicate `conId`, more than 30. F4, the whole entry: `strike` above 0 and at most `maxStrike`; `expiry` with `normalizeOptionExpiration(expiry) === expiry` and `isTrialCalendarDay(expiry)`; `entryUnderlyingPrice`, `valuationPriceAtEntry` and `pricePaid` finite, above 0, at most `maxPrice`; `entryVolatility` above 0 and at most `maxVolatility`; `quote.underlyingPrice` above 0 and at most `maxPrice`; and every scaled product (`bidUnits`, `askUnits`, `(bidUnits + askUnits) x 50`, `budgetUnits`, and `contracts x perContractUnits` at the 500 cap) is `Number.isSafeInteger`. Each answers its own sentence naming the field.
- **F3 holdings match and pins:** both pin files stay byte-identical (no trial in either carries `brokerContractId`).

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/lib/gains-at-risk-candidate-money.test.ts
it("T12 exact budget: mid 0.15 (bid 0.10, ask 0.20), budget 45.00 → 3 contracts, cost 45.00, unspent 0", () => {
  const s = sizeCandidate(budgetToUnits(45)!, toMoneyUnits(0.1)!, toMoneyUnits(0.2)!);
  expect(s).toEqual({ perContractUnits: 150_000, contracts: 3, capped: false, costUnits: 450_000, unspentUnits: 0 });
});
it("T12 half-cent mid: bid 0.01, ask 0.02 → per contract $1.50 exactly", () => {
  expect(sizeCandidate(budgetToUnits(10)!, 100, 200).perContractUnits).toBe(15_000);
});
it("T12 cap: mid 0.05, budget 10,000 → 500 contracts, capped, unspent 7,500", () => {});
it("T12 one cent under one contract: mid 3.20, budget 319.99 → 0 contracts, unspent = budget", () => {});
it("T12 property: for 2,000 random grid prices and whole-cent budgets, cost + unspent === budget and cost === contracts x perContract (integers)", () => {});
it("budgetToUnits refuses 10.005, 0, -1 and 10,000,000.01", () => {});
// tests/compute/gains-at-risk-candidate-check.test.ts
it.each([/* written, right 'x', bid 0, bid > ask, bid 0.12345, mid 0.16 for 0.10/0.20, pricePaid !== mid,
           entry strike differs, entry expiry differs, entry brokerContractId differs, multiplier 10, duplicate conId, 31 items */])(
  "T26 refuses %s naming the field", () => {});
it.each([
  ["entry.strike", 0], ["entry.strike", 100_001], ["entry.expiry", "2027-02-30"], ["entry.expiry", "20270219"],
  ["entry.entryUnderlyingPrice", 0], ["entry.entryUnderlyingPrice", 100_001], ["entry.valuationPriceAtEntry", 0],
  ["entry.valuationPriceAtEntry", -1], ["entry.entryVolatility", 0], ["entry.entryVolatility", 10.01],
  ["entry.pricePaid", 100_001], ["quote.underlyingPrice", 0], ["quote.bid", 1e12],   // last: (bid + ask) x 50 not a safe integer
])("F4 refuses %s = %o with a sentence naming candidates[0].%s", () => {});
it("T26 accepts a locked quote (bid === ask) and an odd-unit half-unit mid", () => {});
// tests/compute/gains-at-risk.test.ts and gains-at-risk-trial.test.ts (F3)
it("F3 both pins byte-identical; a trial without brokerContractId matches holdings by terms exactly as today", () => {});
it("F3 a held adjusted contract with the same terms but another ib_con_id is not counted for a trial carrying brokerContractId; the held standard one is", () => {});
it("F3 a held row with no ib_con_id is matched by terms even when the trial carries an id", () => {});
it("F3 brokerContractId 0, 1.5 or '7' throws GainsAtRiskInputError", () => {});
it("F9 buildTrialEntryById reads one injected now() for today and the expiry check", () => {});
// tests/compute/gains-at-risk-candidates.test.ts (ZZ book; driver index and single-name variants)
it("T9 per case and move: (book + trials + candidate) − (book + trials) === the candidate's own row, within 0.005, by a second engine run with the candidate as a trial", () => {});
it("T10 result toStrictEqual computeGainsAtRisk with the same input and no candidates", () => {});
it("T11 the position loader is called once for 1 and for 30 candidates (spy on loadScenarioPositionsByAccount)", () => {});
it("T16 a budget change changes contracts and dollars only; entry fields identical; no re-solve (spy solveTrialEntry: 0 calls)", () => {});
it("T17 a candidate at N contracts equals, to the cent, the same position sent as a trial at N contracts in the next run", () => {});
it("T30 atZeroMoveUsd is the same with moves [-0.2, -0.1] and [-0.2, -0.1, 0]; the book's sweep is unchanged", () => {});
it("T1 candidates absent or []: result byte-identical to both pins, no candidates key", () => {});
it("P13a: single-name driver ZZA, a candidate on ZZB is heldUnchanged; on sibling ZZA2 it is not; index measured, a no-link underlying is heldUnchanged in measured and not in selloff", () => {});
it("D5: a call on ZZA with selectedMove +0.2 reads rise; with -0.2 fall; index mode fall", () => {});
it("zero-contract and refused rows have no book figures and are out of every total", () => {});
it("Review Focus 4: a candidate whose quote underlying (100) differs from the stored price (90) is 0 at move 0 today and never refused", () => {});
it("Review Focus 5: accountIds [] with one trial and two candidates: book zero, rows priced, T9 holds", () => {});
it("engine costUsd for each priced row equals unitsToUsd(costUnits) to the cent", () => {});
// tests/compute/gains-at-risk-candidate-payoff.test.ts (hand-worked, D11)
it.each([
  // valuation date = the candidate's own expiry, after the close; driver index ZZQ, the underlying is the driver (beta 1)
  // S0 = 100, pricePaid 3.00, 2 contracts. Figure = (intrinsic - 3.00) x 2 x 100, worked by hand:
  ["put 95,  move -10% (S=90)",  { right: "put",  strike: 95,  move: -0.1 }, (5 - 3) * 200],    //  400
  ["put 95,  move   0  (S=100)", { right: "put",  strike: 95,  move: 0 },    (0 - 3) * 200],    // -600
  ["call 105, move +10% (S=110)", { right: "call", strike: 105, move: 0.1 }, (5 - 3) * 200],    //  400 (single-name driver)
  ["call 105, move   0",          { right: "call", strike: 105, move: 0 },   (0 - 3) * 200],    // -600
])("T31 %s", () => {});
```
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL; both pins PASS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the five new files, every `tests/compute/gains-at-risk*.test.ts`, `tests/api/gains-at-risk-trial-entry.test.ts`, then `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Hand back.** Controller commits ("Gains at risk engine: candidates on one run, exact sizing, the call-2 check").

---

### Task S4: Routes

Starts after S2 and S3.

**Interfaces:**
- Consumes: S1 (`listSingleNameDrivers`, `findSingleNameDriver`, `listCandidateUnderlyings`, engine input); S2 (`fetchOptionChain`, `fetchOptionQuoteBatch`); S3 (`buildTrialEntryById`, `computeGainsAtRiskCandidates`, the check and money modules); `checkTrialSecurity`, `trialValuationPrice`, `quoteSessionLabel`, `getIbApi`, `decideRequest` / `classifyRoute` (tests).
- Produces (`lib/analysis/gains-at-risk-input.ts`):
  ```ts
  // GainsAtRiskBody gains:
  //   driver?: { kind: "single-name"; securityId: number } | { kind: "single-name"; symbol: string };
  //   selectedMove?: number;   // one of moves
  // driverSymbol stays required and stays an index symbol (the page keeps its index choice; the engine ignores it in single-name mode).
  // gainsAtRiskBodyProblem: with a single-name driver each move lies in SINGLE_NAME_MOVE_BOUNDS; otherwise |move| <= 0.6 as today.
  // F3: trialPositionsProblem accepts an option's optional brokerContractId (a positive safe integer); cleanTrialPositions copies it
  // ONLY when present (a step 2 trial is rebuilt with exactly today's keys).
  ```
- Produces (`lib/analysis/gains-at-risk-candidates-input.ts`, new, plain module):
  ```ts
  export function singleNameDriversBodyProblem(body: unknown): string | null;   // { trialUnderlyingIds: positive ints, at most maxPositions }
  export function chainBodyProblem(body: unknown, today: string): string | null; // { underlyingSecurityId, right, expiries?: 1..3 real days >= today, unique }
  export function quotesBodyProblem(body: unknown, today: string): string | null; // { underlyingSecurityId, contracts: 1..15 BatchContractRequest, unique conId, expiry >= today }
  export interface CandidatesBody extends GainsAtRiskBody { budgetUsd: number; selectedMove: number; candidates: CandidateRequestItem[] }
  /** Shape only: gainsAtRiskBodyProblem, budgetToUnits, selectedMove in moves, candidates an array. The route then runs the
   *  server-side candidatesProblem (lib/compute/gains-at-risk-candidate-check.ts, F4) before anything else. */
  export function candidatesBodyProblem(body: unknown, today: string): string | null;
  /** The drivers route's `data` (F8 folded in). */
  export interface SingleNameDriversResponse { drivers: SingleNameDriverEntry[]; candidateUnderlyings: CandidateUnderlyingEntry[] }
  /** F2: what call 1 returns for a solved row and what the page keeps, the shape trialStateFromEntry reads. */
  export interface CandidateEntryRecord {
    entry: Extract<TrialEntryResult, { ok: true }>;   // position (with brokerContractId), symbol, name, underlyingPrice / Date / Source,
                                                       // staleCloseDate, holdingsAtAddByAccount, hasContractId
    underlyingPriceSource: "client-quote";            // F5: a candidate is always solved at the quote's own underlying
    appValuation: { price: number; date: string; source: "book" | "daily-bar" | "stored-price" } | null;
  }
  /** P11 default: the n strikes nearest `price` on the out-of-the-money side (put: strictly below; call: strictly above). */
  export function defaultCandidateStrikes(contracts: readonly ChainContract[], price: number | null, right: "put" | "call", n?: number): number[];
  export type ChainResponse =
    | { kind: "expiries"; underlyingSecurityId: number; right: "put" | "call"; expiries: string[] }
    | { kind: "strikes"; underlyingSecurityId: number; right: "put" | "call"; valuationPrice: number | null;
        byExpiry: { expiry: string; contracts: ChainContract[]; defaultConIds: number[]; droppedNonStandard: number; droppedAmbiguous: number }[] };
  export interface QuotesResponse { underlyingSecurityId: number; requestedConIds: number[]; rows: QuoteRow[] }
  export type QuoteRow =
    | { conId: number; status: "quoted"; quote: CandidateQuoteFields; record: CandidateEntryRecord }   // F2: the complete entry
    | { conId: number; status: "no-entry"; quote: CandidateQuoteFields; refusal: TrialEntryRefusal; sentence: string }
    | { conId: number; status: "not-quoted"; reason: BatchContractRefusal; retryAfterSeconds?: number; sentence: string;
        bid: number | null; ask: number | null };
  export type CandidatesResponse = GainsAtRiskResponse & { budgetUsd: number; selectedMove: number; rows: CandidateRow[] };
  export function batchRefusalSentence(reason: BatchContractRefusal): string;
  ```
- Produces (`lib/compute/gains-at-risk-candidate-quotes.ts`, new):
  ```ts
  export function quoteCandidates(db: Database.Database, body: { underlyingSecurityId: number; contracts: BatchContractRequest[] },
    deps?: Parameters<typeof fetchOptionQuoteBatch>[2]):   // F9: its one `now: () => Date` is passed to the batch and to buildTrialEntryById
    Promise<{ ok: true; data: QuotesResponse } | { ok: false; reason: "not-connected" | "no-underlying-contract" | "sync-running" | "rate-limit"; retryAfterSeconds?: number }>;
  ```
  Per ok batch row: `buildTrialEntryById({ kind: "option", underlyingSecurityId, right, side: "buy", expiry, strike, contracts: 1, price: mid, quotedUnderlyingPrice: row.underlyingPrice, brokerContractId: conId }, { now })`. F5: an ok batch row always carries the quote's own underlying within 30 s (the batch refuses otherwise), and the orchestrator asserts it: a row without it is answered `not-quoted` (`not-quoted-prices-too-far-apart`) and `buildTrialEntryById` is not called. The record's `appValuation` is `trialValuationPrice(db, underlyingSecurityId, { today })`. The session is `quoteSessionLabel(new Date(optionObservedAt))`.

Routes (all thin, `{ success, data }` / `{ success: false, error }`, human by default with no edit to `route-policy.ts` or `proxy.ts`, content-free logs):

| Route | Order and statuses |
|---|---|
| `POST /api/compute/gains-at-risk` (extended) | body 400; with `driver`: build the list (trial underlyings from the body), not on it 400 "driver is not one of the names this page can stress."; engine `driver: { kind: "single-name", symbol, securityId }`, `selectedMove`. No `driver`: today's code path, reply byte-identical (P8). |
| `POST /api/compute/gains-at-risk/single-name-drivers` | body 400; 200 `SingleNameDriversResponse` (`drivers`, and F8's `candidateUnderlyings` from `listCandidateUnderlyings`). Read-only, no broker. The section's first paint reads the same two functions. |
| `POST /api/tws/option-candidates/chain` | body 400; `checkTrialSecurity(requireContractId: true)` 422; `getIbApi()` null 503; reader `rate-limit` 429 with `Retry-After`; `timeout` 504; `broker-error` 502; 200 `ChainResponse` (defaults from `trialValuationPrice`). |
| `POST /api/tws/option-candidates/quotes` | body 400; security 422; 503; `sync-running` 409 "A sync is running. Try again in a moment."; `rate-limit` 429 with `Retry-After`; 200 `QuotesResponse` (a refused contract is a 200 row). |
| `POST /api/compute/gains-at-risk/candidates` | body 400 naming the field (`candidatesBodyProblem`, then `candidatesProblem`); each candidate's underlying `checkTrialSecurity(requireContractId: false)` 422; single-name driver checked as in the compute route; `computeGainsAtRiskCandidates`; 200 `CandidatesResponse` whose `result`, `yearGain` and freshness equal the compute route's for the same body. No broker. |

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/api/compute-gains-at-risk.test.ts
it("T1 no driver: reply byte-identical to the step 2 reply for the same bodies", () => {});
it("T20 a driver not on the list is 400; on the list by id and by symbol (no row) is 200 with driverKind", () => {});
it("T8 single-name: a move of -0.81 or 1.01 is 400; 1.0 and -0.8 pass; index: 0.61 is 400 as today", () => {});
// tests/api/gains-at-risk-single-name-drivers.test.ts
it("returns the list and candidateUnderlyings; a body with 13 ids or a non-integer id is 400", () => {});
// tests/api/compute-gains-at-risk.test.ts (F3)
it("F3 a trial with brokerContractId round-trips through cleanTrialPositions; one without has exactly today's keys; brokerContractId 0 is 400", () => {});
// tests/api/tws-option-candidates-chain.test.ts and -quotes.test.ts (fake api with spies)
it.each([/* "{", "[]", 0 id, 16 contracts, duplicate conId, past expiry, right "x", multiplier 10 */])(
  "T14 malformed %s: 400 and zero broker requests", () => {});
it("T14 unknown, option, non-dollar and contract-less securities: 422, zero broker requests", () => {});
it("T14 not connected 503 and a running sync 409, zero broker requests; chain over its bound 429 with Retry-After, zero requests", () => {});
it("quotes: a two-sided row carries the complete record (F2): position with brokerContractId === conId, holdingsAtAddByAccount, staleCloseDate, underlyingPrice/Date, underlyingPriceSource 'client-quote', appValuation", () => {});
it("quotes: a below-intrinsic mid is a no-entry row with the sentence; a refused contract is a 200 row", () => {});
it("F5 quotes: a batch row refused prices-too-far-apart comes back not-quoted with that sentence and no entry; buildTrialEntryById spy: 0 calls for it", () => {});
it("F9 quotes: one injected now() reaches the batch and the entry (the entry's today equals todayET(now()))", () => {});
it("chain: defaultConIds are the five nearest out-of-the-money strikes per expiry", () => {});
// tests/api/gains-at-risk-candidates.test.ts
it("T10 result, yearGain and freshness equal the compute route's for the same body", () => {});
it("T26/F4 each D3 and F4 refusal answers 400 naming candidates[i].<field> before any database read beyond the security check; budget 10.005 and 0 answer 400 naming budgetUsd", () => {});
it("selectedMove not among moves is 400; 31 candidates is 400", () => {});
// tests/auth/gains-at-risk-step3-routes.test.ts
it("D11 the four new routes classify human", () => {});
it("D11 no session and a failing CSRF check are denied by decideRequest for each new route; the route module is never loaded (fake api untouched)", () => {});
// tests/dashboard/gains-at-risk-view-source.test.ts
it("T22 the import walk covers gains-at-risk-candidates-input.ts and -candidate-money.ts (the check module is server only and never reached from a client file)", () => {});
```
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the seven files, `tests/auth/route-policy.test.ts`, `tests/auth/boundary-matrix.test.ts`, `tests/api/tws-option-quote.test.ts`, `tests/api/gains-at-risk-trial-entry.test.ts`, then `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Hand back.** Controller commits ("Gains at risk: single-name driver, chain, quotes and candidates routes").

---

### Task S5: Page, single-name mode

Starts after S4. First UI task: `next build` runs here.

**Interfaces:**
- Consumes: S1 types (type-only), S4 routes and body types, S0 constants.
- Produces (`lib/analysis/gains-at-risk-view.ts` additions):
  ```ts
  export type DriverChoice = { kind: "index"; symbol: GainsAtRiskDriver } | { kind: "single-name"; entry: SingleNameDriverEntry };
  export const SINGLE_NAME_TABLE_MOVES = [-0.4, -0.2, 0, 0.2, 0.4] as const;
  export const DEFAULT_SINGLE_NAME_SELECTED_MOVE = -0.2;
  export const HELD_UNCHANGED_NOTE = "Other positions held unchanged. Their options still lose time value to the date.";
  export const SINGLE_NAME_VOL_NOTE = (symbol: string) => `(options on ${symbol} only)`;
  export function singleNameSweep(): number[];                         // from SINGLE_NAME_DEFAULT_SWEEP, 17 moves
  export function customMoveProblemFor(kind: DriverChoice["kind"], move: number): string | null;   // index as today; single-name -80% to +100%
  export function driverRequestFields(choice: DriverChoice): Pick<GainsAtRiskBody, "driver">;    // index: {} (P8)
  export function singleNameRowCells(row: GainsAtRiskMoveRow): { loses: number | null; offsets: number | null; book: number };  // split "none": nulls
  export function singleNameHeadline(row: GainsAtRiskMoveRow, symbol: string, yearGain: YearGainResult): { usd: number; share: number | null; text: string };
  // GainsControls gains driver: DriverChoice; switching kind resets the sweep and selected move to that kind's defaults,
  // keeps date, vol change and trial positions; betaOverrides kept in state, not sent in single-name mode.
  ```
- Produces (`lib/analysis/gains-at-risk-trial-view.ts`): `crossingSentence(c, driver, tableMoves?)` reads `c.crossingDirection` ("rise" mirrors every sentence with "rises"; absent or "fall" is today's text).

Decisions:
- `GainsAtRiskSection.tsx` loads `listSingleNameDrivers(db, { trialUnderlyingIds: [] })` and `listCandidateUnderlyings` for the first paint and passes both to the view (the candidate list is unused until S6); the view re-asks the drivers route when the trial list's underlyings change.
- `DriverControl.tsx` (new, client): two radio kinds, the index select as today, a native `<select>` of the list (no carets, house rule).
- Single-name mode: no case switch and no per-name figure boxes; the chart draws the book line (and the book with trial positions) and never the without-offsets line; the table's zero row shows the book only; `HELD_UNCHANGED_NOTE` under the controls; the share of the year's gain on a loss only, when the gain is positive and reconciled (`gainGivenBackShare`).

- [ ] **Step 1: Write the failing tests.** `tests/lib/gains-at-risk-view.test.ts`: `singleNameSweep()` is 17 moves from -0.4 to 0.4; `customMoveProblemFor("single-name", 1.0)` null and `1.01`, `-0.81` refused, index `0.1` refused as today; `driverRequestFields({ kind: "index" … })` is `{}`; `singleNameRowCells` of a zero row is `{ loses: null, offsets: null }`; the headline share is null for a gain and for an unreconciled year's gain; switching kind resets the sweep and keeps the trial list and date. `tests/lib/gains-at-risk-trial-view.test.ts`: the six sentences mirrored for "rise", e.g. `"They pay for themselves once ZZA rises more than 9%."`. `tests/dashboard/gains-at-risk-single-name-source.test.ts`: the native select; no case switch rendered in single-name mode; the chart hides the without-offsets line in single-name mode; `HELD_UNCHANGED_NOTE` renders; betaOverrides not sent in single-name mode; every dollar through `<Money>`, every share through `<Pct>`; no "hedge". `tests/dashboard/gains-at-risk-view-source.test.ts`: the walk covers `DriverControl.tsx`.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four files, every `tests/**/gains-at-risk*` test, `npx tsc --noEmit`, and `npx next build`. Expected: PASS and the build completes.
- [ ] **Step 5: Hand back.** Controller commits ("Gains at risk page: one stock or fund as the driver").

---

### Task S6: Page, candidates section

Starts after S5. Touches `GainsAtRiskSection.tsx` only to mount `CandidatesProvider` and `GainsAtRiskView.tsx` only for the import and the mount line.

**Interfaces:**
- Consumes: S4 routes and response types (`SingleNameDriversResponse`, `ChainResponse`, `QuotesResponse`, `CandidateEntryRecord`, `CandidatesResponse`; type-only), S3 money module and check types (type-only), S0 constants, `useTrialPositions()`, `readMutationResult` / `networkFailureMessage`.
- Produces (`lib/analysis/gains-at-risk-candidates-view.ts`, new, plain module):
  ```ts
  export interface CandidateRowState {
    conId: number; underlyingSecurityId: number; symbol: string;
    contract: { right: "put" | "call"; expiry: string; strike: number; tradingClass: string; multiplier: 100 };
    quote: CandidateQuoteFields | null;
    /** F2: the complete solved entry from call 1, kept untouched; null when the row has no entry. */
    record: CandidateEntryRecord | null;
    quoteProblem: string | null;          // no quote / not quoted / no entry: the sentence
    /** Only from an answer to the inputs on screen (P15): the reply's seq equals figuresSeq. */
    figures: CandidateRow | null;
  }
  export interface CandidatesState {
    open: boolean; underlyingSecurityId: number | null; right: "put" | "call";
    chainRevision: number; chain: ChainResponse | null; chosenConIds: number[];   // at most 15
    rows: CandidateRowState[];                    // keyed by conId; request order
    pulls: Record<number /* conId */, number /* pull revision */>;
    /** Bumped by every compute-input revision (P15, F6); a compute reply is shown only for the current value. */
    computeSeq: number;
    budgetUsdText: string;
  }
  export type CandidatesAction =
    | { type: "open" } | { type: "close" } | { type: "clear" }
    | { type: "set-underlying"; securityId: number } | { type: "set-right"; right: "put" | "call" }
    | { type: "chain-request" } | { type: "chain-reply"; revision: number; underlyingSecurityId: number; right: "put" | "call"; reply: ChainResponse }
    | { type: "choose"; conIds: number[] }
    | { type: "quotes-request"; pullId: number; conIds: number[] }
    | { type: "quotes-reply"; pullId: number; underlyingSecurityId: number; reply: QuotesResponse }
    | { type: "remove"; conId: number }
    /** Scope (F1), driver, date, moves, volatility, overrides, trial list, budget, selected move. */
    | { type: "inputs-changed" }
    | { type: "compute-request"; seq: number } | { type: "compute-reply"; seq: number; reply: CandidatesResponse }
    | { type: "budget"; text: string };
  export function initialCandidatesState(): CandidatesState;
  export function candidatesReducer(state: CandidatesState, action: CandidatesAction): CandidatesState;
  export function refreshBatches(rows: readonly CandidateRowState[]): { underlyingSecurityId: number; conIds: number[] }[];  // per underlying, <= 15 each
  export function isOldQuote(optionObservedAt: string, now: Date): boolean;   // >= CANDIDATE_QUOTE_OLD_AFTER_MINUTES
  export function defaultCandidateUnderlying(list: readonly CandidateUnderlyingEntry[], driver: DriverChoice): number | null;  // F8: the driver's row when listed, else null
  export function candidateCrossingText(c: GainsAtRiskCandidateCase, symbol: string): string;   // "ZZA -6.1%" / "does not pay within the moves shown"
  export function crossingHeading(direction: "fall" | "rise", symbol: string): string;          // "Pays once ZZA falls past" / "… rises past"
  export function heldUnchangedNote(symbol: string): string;   // "ZZQ is held unchanged in this run, so this row shows cost only."
  export function candidateCostShareOfGain(costUsd: number, yearGain: YearGainResult): number | null;
  export type CandidateSortKey = "none" | "cost" | "contracts" | "atSelected" | "atZero" | "crossing" | "costShare";
  export function sortCandidateRows(rows: readonly CandidateRowState[], key: CandidateSortKey, caseKey: GainsAtRiskCaseKey): CandidateRowState[];
  /** F10: null when Add is allowed; else the sentence. */
  export type AddBlocked = "no-entry" | "refused" | "zero-contracts" | "figures-not-current" | "trial-limit";
  export function candidateAddBlocked(row: CandidateRowState, state: Pick<CandidatesState, "computeSeq">, figuresSeq: number | null,
    trialCount: number): { reason: AddBlocked; text: string } | null;
  /** P14, F2: the trial is the row's own record; nothing looked up or guessed. */
  export function candidateToTrial(row: CandidateRowState & { record: CandidateEntryRecord; figures: Extract<CandidateRow, { status: "priced" }> },
    id: string): TrialPositionState;
  export const CANDIDATES_NOT_STORED_NOTE = "Quotes come from the broker. Nothing is stored. Nothing is traded from this page.";
  ```
- Components: `CandidatesProvider.tsx` (F1: client context over `candidatesReducer`, unkeyed, rendered by `GainsAtRiskSection` beside `TrialPositionsProvider` and AROUND the `key={scope}` view; stores nothing), `CandidateSection.tsx` (collapsed by default; reads the provider; the four fetches, Refresh quotes and Clear; dispatches `inputs-changed` on mount (a scope remount) and on every input change), `CandidatePicker.tsx` (underlying: a native select of the server's `candidateUnderlyings`, default `defaultCandidateUnderlying`; right; up to 3 expiries; per-expiry strike checkboxes capped at 15 in all), `CandidateTable.tsx` (rows, sort select with "none" first, Add and Remove; a phone shows one card per row).

Rules (reducer):
- **F1:** state survives a scope change because the provider sits above the keyed view; the remount's `inputs-changed` keeps every row, quote and record, clears every `figures`, bumps `computeSeq`, and the section recomputes.
- **D8:** a chain reply is dropped when its revision is not current, or underlying or right changed, or the section was cleared or closed. A quotes reply replaces only rows whose `pulls[conId]` equals its `pullId`; a reply for a removed row or after clear never recreates it; a refused-by-limiter row keeps its old quote and record.
- **F6:** a quotes reply that replaces at least one row's quote or record is a compute-input revision: it clears every row's `figures` and bumps `computeSeq`, so a compute reply sent before it is dropped.
- **P15 / T18:** `inputs-changed` clears every row's `figures` and bumps `computeSeq`; a compute reply whose `seq` is not current is dropped.
- **Add (P14, F10):** enabled only when `candidateAddBlocked` returns null: the row has a record and priced figures (`status: "priced"`), is not refused, has contracts above 0, its figures answer the current `computeSeq`, and the trial list holds fewer than 12 (else `TRIAL_LIMIT_TEXT`). `candidateToTrial` builds `TrialPositionState` from the record exactly as `trialStateFromEntry` does: `position = { ...record.entry.position, id, contracts: figures.contracts }` (brokerContractId kept), `symbol`, `name`, `holdingsAtAddByAccount`, `staleCloseDate`, `underlyingPrice`, `underlyingPriceDate`, `underlyingPriceSource: "client-quote"`, `appValuation` from the record; `priceSource: "quote-mid"`; `quote: { tickKind, session, bid, ask, mid, underlyingLast: quote.underlyingPrice, fetchedAt: quote.optionObservedAt }`.
- **Disconnected (P16):** Get quotes and Refresh quotes disabled with "Connect the broker to fetch quotes."; rows stay and recompute.

- [ ] **Step 1: Write the failing tests.** `tests/lib/gains-at-risk-candidates-view.test.ts`:
```ts
it("T18 a compute reply for an older seq, or after inputs-changed, is never shown", () => {});
it("F1 a scope change (inputs-changed after a remount): rows, quotes and records kept, figures null, computeSeq bumped", () => {});
it("F6 an old compute reply arriving after a refresh that replaced a quote is dropped; a refresh that replaced nothing leaves figures", () => {});
it("T19 isOldQuote: 14:59 ago false, 15:00 true", () => {});
it("T29 chain and quote replies dropped after clear, remove, underlying change, right change, a newer pull for the same contract, and close; never recreate a row", () => {});
it("D4 refreshBatches splits two underlyings and 20 rows of one into calls of at most 15, per underlying", () => {});
it("a row the limiter refused keeps its old quote and record and is flagged by age", () => {});
it("T17/F2 candidateToTrial equals, field for field, a hand-built TrialPositionState from the record (toStrictEqual), contracts = row contracts, brokerContractId kept", () => {});
it.each([
  ["no-entry", /* record null */], ["refused", /* status refused */], ["zero-contracts", /* status zero-contracts */],
  ["figures-not-current", /* figures from an older seq, and figures null while computing */], ["trial-limit", /* 12 trials */],
])("F10 Add blocked: %s", () => {});
it("F10 Add allowed for a priced, current row with contracts > 0 and 11 trials", () => {});
it("F8 defaultCandidateUnderlying: the single-name driver's row; the index driver's row; null when the driver is not listed", () => {});
it("P22 no default sort; rows with no figures sort last under every key", () => {});
it("D5 crossingHeading and candidateCrossingText name the direction; heldUnchangedNote", () => {});
```
`tests/dashboard/gains-at-risk-candidates-source.test.ts`: F1 `GainsAtRiskSection` renders `CandidatesProvider` beside `TrialPositionsProvider`, around the keyed view, and the provider carries no `key`; T23 the budget through `<PrivateNumberInput>`, contracts through `<Count>`, cost and figures through `<Money>` / `<Pct>`, bid, ask, strike plain; the underlying picker reads `candidateUnderlyings` (no client-side list); the sort is a native select with "none" first; Add's disabled state reads `candidateAddBlocked`; handlers read through `readMutationResult`; `CANDIDATES_NOT_STORED_NOTE` renders; no "hedge", no "best". `tests/dashboard/gains-at-risk-view-source.test.ts`: the walk covers the five new files.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files, every `tests/**/gains-at-risk*` test, `npx tsc --noEmit`, `npx next build`. Expected: PASS.
- [ ] **Step 5: Hand back.** Controller commits ("Gains at risk page: compare candidate options").

---

### Task S7: Close-out (controller)

- [ ] **Step 1:** `npm run verify:changed`, `npm run verify:smoke`, `npx next build`, `bash scripts/verify.sh full --base main`, all with the PATH prefix. Report the test count.
- [ ] **Step 2: Browser pass, broker disconnected, deterministic (D11)** on `npm run -s sandbox -- up --task <task>`: single-name results falling and rising (columns per P6, zero row total only, no case switch, held-unchanged note); two underlyings in one table (rows seeded through the candidates route with typed client quotes); a refresh race (two pulls in flight, the later wins, a removed row stays removed); privacy on (budget, contracts, cost and figures masked; strikes, bid, ask plain); a scope change with rows present (rows and quotes kept, figures clear, then return: F1); Add disabled on a no-quote, refused, zero-contract and computing row (F10); Add then the trial list figures equal the row's; phone width. Real screenshots, responses and logs go only to gitignored `docs/private/` or the sandbox's own folder.
- [ ] **Step 3: Live checklist for the owner** (P19): a real chain pull (expiries, then strikes per expiry, defaults); a 15-contract pull in the session and outside it (session label, delayed label); a rate-limit refusal; a pull during a sync (409); a pull while the live-quotes stream runs (busy retry or refusal); Add on a row; a single quote and a batch at once (they never interleave).
- [ ] **Step 4: Docs.** `docs/DECISIONS.md` "2026-11-25 Gains at risk, step 3": R1-R4, P1-P22, D1-D11 as built, the money unit, the budget bound, the chain bound, serial requests and the between-contracts deadline, the snapshot-cancel ruling (no broker cancel for a snapshot; the type is restored only after the in-flight snapshot settles). `CLAUDE.md` rule block "Rules from the 2026-11-25 Gains at risk step 3": `setMarketDataTypeCounted` is the one setter; the quote lock; count-then-take; the batch's order of checks; candidate identity is the broker contract id; sizing in 1/10,000 units with cost + unspent = budget; the call-2 validator; the single-name ladder and `held-unchanged`; the crossing follows the driver's direction; candidates never enter the book's figures; F1-F10 (candidate state above the scope key, the complete entry carried to Add, `brokerContractId` end to end, the whole-entry validator, a gap failure is a refusal, a quote replacement is a compute revision, checks before every broker operation, the server-built underlying list, one clock, Add's five blocked states). `docs/plans/TODO.md`: step 3 done; the live checklist; a rise in an index stays out.
- [ ] **Step 5:** Controller commits the docs. No deploy step.

---

## Self-review

- **Rulings:** P1 S1 (list), S4 (route); P2-P8 S1; P9 S3 (validator refuses a written option); P10 S2 (batch), S4 (route); P11 S2 (reader), S4 (defaults); P12 S3; P13 S3 (`buildTrialEntryById`), S4 (orchestrator); P13a S3, S6; P14 S6; P15 S6; P16 S6; P17 S6 (T23); P18 pre-flight, S4/S6 walks; P19 S7; P20 S1; P21 S4; P22 S6. D1 S2, S3 (row key), S6; D2 S2; D3 S3; D4 S4, S6; D5 S1, S3, S5, S6; D6 S2, S4; D7 S2, S4; D8 S6; D9 S3; D10 S3; D11 S3 (payoffs), S4 (auth), S7 (browser).
- **Plan-review rulings:** F1 S6 (provider, reducer test, source pin, browser); F2 S4 (`CandidateEntryRecord`), S6 (`candidateToTrial`, T17 strict equality); F3 S3 (input, holdings match, pins), S4 (`cleanTrialPositions`); F4 S3 (validator, one test per field), S4 (400s); F5 S2 (refusals), S4 (no entry, spy); F6 S6; F7 S2 (four overrun tests and mid-batch sync); F8 S1 (`listCandidateUnderlyings`), S4 (drivers route), S6 (picker, default); F9 S2, S3, S4; F10 S6 (one test per disabled state).
- **Tests T1-T31:** T1 S1, S3, S4; T2-T8 S1; T9-T12 S3; T13 S2, S3; T14 S4; T15 S2; T16-T17 S3, S6; T18-T19 S6; T20 S1, S4; T21 S1, S5; T22 S4, S5, S6; T23 S6; T24 S2; T25 S2; T26 S3, S4; T27-T28 S2; T29 S6; T30-T31 S3.
- **Conservation invariants as named tests:** single-name loses + offsets = book both directions (S1 T2); candidate difference and the hand-worked expiry payoff (S3 T9, T31); sizing cost + unspent = budget and cost = contracts x per-contract (S3 T12); index mode byte-identical (S1 T1, S3 T1, S4 T1).
- **Types defined once:** `GainsAtRiskDriverInput`, `SingleNameDriverEntry`, `CandidateUnderlyingEntry`, `CandidateEntryRecord`, `SingleNameDriversResponse`, `BatchContractRequest`, `BatchContractResult`, `ChainContract`, `CandidateQuoteFields`, `CandidateRequestItem`, `GainsAtRiskCandidateResult`, `CandidateRow`, `QuoteRow`, `CandidatesResponse`, `CandidateRowState`.

## OPEN: conflicts with the contract

1. **F4 says the validator reads the expiry "through the option-expiry reader"; the plan had placed the validator under `lib/analysis/`, which may not value-import `lib/compute/*`** (P18; guard `tests/dashboard/gains-at-risk-view-source.test.ts:397`, "no lib/db, lib/queries, lib/compute, lib/tws ... as a value"; the reader is `lib/compute/option-expiry.ts`, `normalizeOptionExpiration` at line 106). Plan default, already applied: the validator lives at `lib/compute/gains-at-risk-candidate-check.ts` (server only; only the candidates route calls it); its `CandidateRequestItem` / `CandidateQuoteFields` types reach the page by type-only import. CONFIRMED by the controller 2026-11-25: the validator is server code and belongs in `lib/compute/`. Nothing is open.

Resolved earlier: the snapshot-cancel item (D7/P10 said unsubscribing a snapshot sends the broker's cancel; `@stoqey/ib` 1.5.3 does not, `api-next.js:1607-1611`), by the controller ruling of 2026-11-25, folded into S2: keep the snapshot form, await an in-flight operation to its own end (13 s snapshot backstop), check the deadline only before a new operation, and restore the type and release the lock only after nothing is pending. Cost if wrong: a pull can run up to one operation past its deadline.

Notes (no conflict): the "with-trial pin" P8 names does not exist yet; S1 step 1 freezes it from the current code. The broker's general pacing figure (messages per second) is not in the package; the plan relies on none, since every request is serial.
