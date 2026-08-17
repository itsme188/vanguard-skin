> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# Conventions — full detail

> Note carried over from the original CLAUDE.md section header: expanded rationale, dated provenance,
> commit hashes, root-cause war-stories, and regression-test names for the longer rules live in
> **`docs/conventions-detail.md`** (git-tracked, read on demand). The CLAUDE.md section keeps the
> actionable rule + canonical file path.

Earnings-specific conventions live in `docs/reference/earnings-pipeline.md`.

Contents:

- [A. Data layer & DB conventions](#a-data-layer--db-conventions)
- [B. Dates, times and time zones](#b-dates-times-and-time-zones)
- [C. Ledger integrity, securities and tax lots](#c-ledger-integrity-securities-and-tax-lots)
- [D. Valuation, FX and prices](#d-valuation-fx-and-prices)
- [E. Scoping, returns and risk compute](#e-scoping-returns-and-risk-compute)
- [F. Classification: sectors, factors, look-throughs](#f-classification-sectors-factors-look-throughs)
- [G. AI / LLM output handling](#g-ai--llm-output-handling)
- [H. Digest, briefing and anomaly emails](#h-digest-briefing-and-anomaly-emails)
- [I. Brokers and connectors — IBKR, TWS, Plaid](#i-brokers-and-connectors--ibkr-tws-plaid)
- [J. Levels and alerts](#j-levels-and-alerts)
- [K. Imports: canonical CSV, PDFs, statements](#k-imports-canonical-csv-pdfs-statements)
- [L. UI and frontend conventions](#l-ui-and-frontend-conventions)
- [M. Electron and packaging](#m-electron-and-packaging)

---

## A. Data layer & DB conventions

### Module split

- All DB **query** functions live in `lib/queries/` — read-only.
- All DB **mutation** functions live in `lib/mutations/` — writes.
- Every DB function takes a `db: Database.Database` parameter (dependency injection for testing with
  `:memory:` DBs).

### Records, keys and batches

- Every imported record gets a deterministic `source_key` — re-import is a no-op.
- Every import creates an `import_batches` record with undo capability.
- Monthly snapshots use last-day-of-month dates (or today's date for TWS live snapshots with
  `source='tws'`).

### Transaction-type casing

- Transaction types are UPPERCASE: BUY, SELL, DIVIDEND, REINVESTMENT, TAX_WITHHELD, BUY_TO_OPEN,
  SELL_TO_CLOSE, etc.
- `computeTaxLots` matches on uppercase BUY/SELL — parsers must output uppercase.

### SQLite gotchas

- Always use `COALESCE(s.multiplier, 1)` in queries — SQLite `DEFAULT` is bypassed by an explicit
  `INSERT NULL`.
- **Compare timestamps with SQLite `datetime()` on BOTH sides, never raw strings**: columns written
  via `datetime('now')` are space-separated (`"2026-04-22 22:53:41"`); ISO-Z filters from
  `toISOString()` use `'T'`. A raw compare mis-sorts (space 32 < `'T'` 84) → silent zero rows. Wrap
  both sides in `datetime()`.

### Per-(account, security) latest-holdings CTE pattern

Never a global `MAX(as_of_date)` subquery — IBKR's intraday date hides month-end Vanguard rows (the
Slice A Greeks bug dropped 52/55 option positions).

Single source: `lib/queries/latest-holdings.ts::latestHoldingsPredicate({ keyBy?, includeShorts?,
asOfDate?, accountFilter? })`.

The per-(account, security) variant keys on `account_id` AND `security_id` + `quantity != 0` (shorts
surface) and is the universe for ~10 consumers: options-greeks, exposure-delta,
`computeTilts`/`Concentration`/`PositionRisk`, scenarios, cost-basis-reconciliation, and — since
2026-07-28 — `analysis.ts`'s allocation/concentration/heatmap/coverage CTE +
`getPortfolioExposureSummary`.

Those last two previously used the per-account `keyBy` form, which dropped any security whose newest
row predated the account's newest row (4 live option positions vanished from allocation), and whose
`includeShorts:false` hid short exposure behind a false "N of N (100%)" coverage badge. The user
overruled the staleness-washing rationale; closed positions are excluded by the reconcilers'
quantity-0 tombstones, so the account-date wash is no longer needed.

`asOfDate?` literal-substitutes a regex-validated date for week-over-week deltas.

One exception keeps an inline `MAX` for a positional bind in a hot loop: `computeDailyValuations`
(`lib/compute/daily-valuation.ts`). **Never re-introduce inline copies.**

### Upsert priority — statement always wins

- **Snapshot upsert**: `lib/import/engine.ts` uses
  `ON CONFLICT(account_id, month_end_date) DO UPDATE … WHERE source IN ('tws','manual')`;
  `lib/tws/positions.ts` is symmetric (TWS only writes when no statement row exists). Statement
  re-imports stay idempotent. (Pre-fix `INSERT OR IGNORE`/`REPLACE` meant whoever ran last won — the
  IBKR April snapshot was a sparse TWS row.)
- **Holdings upsert**: same pattern,
  `ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE … WHERE holdings.source_key LIKE 'tws-%'`.
  Statement holdings (`ibkr:pos:`, `canonical:hold:`, …) overwrite the day's TWS intra-day rows;
  re-imports idempotent (the WHERE filters non-tws source_keys).

### Live vs statement snapshot rows

- **ALL portfolio queries exclude TWS snapshots** (`source != 'tws'`) — TWS rows are live-sync data
  for daily valuations, not month-end statements. Including them breaks Modified Dietz, corrupts
  change calcs (shifts the global MAX date), and adds irregular chart points. Applies to TWR, XIRR,
  totals, account summaries, chart data. TWR format is source-aware (`ibkr-activity` percentage,
  `canonical` decimal).
- **Live snapshot sources are single-sourced**: `lib/db/live-sources.ts::LIVE_SNAPSHOT_SOURCES =
  ('tws','plaid')` — every `monthly_snapshots` historical read excludes live rows via
  `excludeLiveSnapshotsSql()`; a lint test rejects raw `!= 'tws'`. (Plaid path details in §I.)
- **December annual snapshots**: Vanguard year-end statements produce December rows with annual
  `starting_value` and cumulative `deposits_withdrawals`. TWR/XIRR detect these (starting_value
  mismatch >10% from the prior month) and compute December-only values.
- Dashboard "as of" dates: `getAccountSummaries()` prefers `daily_valuations` over
  `monthly_snapshots` when more recent.
- Daily valuations infer cash from monthly snapshot anchors: `cash = snapshot_total -
  holdings_value`. Cash carries forward between snapshots.

### Testing contracts

**API contract tests**: `tests/contracts/api-component-contracts.test.ts` verifies compute-function
return shapes match component expectations. Add a test here whenever a new client component fetches
from an API.

### Concurrency

**Snapshot range boundaries BEFORE long awaits in concurrent endpoints**: read
`getLastDigestSentAt(db)` at function entry (`sendDigestEmail`), **NOT** after the 60–90s sync awaits
— else a concurrent trigger updates `last_digest_sent_at` to "now" and the cron reads a future cutoff
→ silent skip. Applies to any "last X done" timestamp two paths can update mid-process. Test:
`tests/digest/send-digest-race.test.ts`.

---

## B. Dates, times and time zones

- All dates use `YYYY-MM-DD` format.
- **ET-anchor every "today / this week / outbound-email date"**: use `todayET()`
  (`lib/calendar/date-utils.ts`, mirrored `workers/cron/src/dst.ts`); never
  `new Date().toISOString().slice(0,10)` for a user-facing today (that's UTC). Every outbound-email
  date string passes `timeZone:"America/New_York"` to `toLocaleDateString`; the Worker briefing
  `weekOf` uses `briefingWeekOf()`. **The Mac travels, the Worker is UTC.**

---

## C. Ledger integrity, securities and tax lots

### IBKR ledger is native-statement-sourced 2024→present (2026-08-03 rebuild)

Canonical batch 17 (`dashboard_IBKR_transactions.csv`, the Co-Work-era backfill) was **retired** and
2024-01→2026-03 + 2026-07 re-imported from real activity statements (backup
`data/backups/pre-ibkr-rebuild-2026-08-03.db`).

- The `ibkr-activity` parser reads the statement **Transfers section**: ACATS in-kind →
  `TRANSFER_IN`/`TRANSFER_OUT`, priced at transfer-date MV; non-Stocks security legs warn.
- `computeTaxLots` treats a security **`TRANSFER_IN` as lot-creating**. `TRANSFER_OUT` is
  deliberately **NOT** a disposal — that's the R4 donation workstream.
- **In-kind donation routing** (R4, 2026-08): a pair of matching TRANSFER_IN/TRANSFER_OUT legs links
  via `donation_leg_links` (import source, role: `OUT` routes, `IN` artifact). ON A PRINT, decide
  donor-advised-fund (DAF) routing in Analysis › Giving (never at CSV authoring time); the `IN` leg
  is demoted via `donation_leg_links` with `is_external_flow=0` (non-cash-contributing), never
  deleted. `TRANSFER_OUT` remains disposal-neutral. Amount carries transfer-date FMV, signed by type.
- The 4 Jan-2024 Robinhood ACATS positions carry worksheet-exact original lots via
  `scripts/repair-acats-opening-lots.ts`. The autos are qty-0/price-NULL **tombstones** — **never
  delete them**; the occupied `source_key`s are what keeps a 2024-statement re-import a no-op.
- Acceptance tool: `scripts/audit-ibkr-ledger-vs-broker.ts` (`--as-of` for statement-lag). Rebuild
  driver: `scripts/rebuild-ibkr-ledger.ts` (single-use; the batch-17 gate now intentionally fails).
- **Negative `holding_period_days` in `tax_lot_sales` = genuine short round-trips** (a sale paired
  with a later cover, 1099-B-consistent) — not a defect; do not "fix" the pairing.
- Known residual: the statement `Corporate Actions` section is unparsed — CRWD's 2026-07-01 4:1 split
  is a +120-share ledger gap (TODO item, same family as the VGT split repair).

### `RECONCILE_CLOSE` transactions are ENGINE-OWNED synthetics (2026-07-26, `dc33080`)

`computeTaxLots` deletes every `type='RECONCILE_CLOSE'` row at the start of each run and regenerates
them only where a stock/ETF pair's latest holdings row is an explicit quantity-0 broker snapshot AND
open FIFO lots remain AND no position-changing transaction postdates the zero row (statement lag left
phantom "open" lots contradicting Positions on the same page).

- Close price = the latest `prices` row ≤ the zero date; breakeven at weighted-average cost when
  none.
- The real statement SELL supersedes automatically on the next run (delete-and-regenerate).
- **Never** import/emit this type from a parser, **never** treat it as user activity, and **never**
  add it to `HOLDINGS`-affecting logic — it exists solely so `tax_lot_sales` can carry the realized
  close (`sale_transaction_id` is NOT NULL + FK).
- Options/bonds excluded (EXPIRED/REDEMPTION own those lifecycles).

### Security type casing

The DB stores capitalized types (`Bond`/`Stock`/`ETF`/`Option`/`Mutual Fund`); always compare
case-insensitively (`.toLowerCase()` / `LOWER()`).

- `mapSecurityType()` in `lib/tws/security-type-map.ts` is the single source — never duplicate it (a
  PostToolUse lint hook rejects case-sensitive comparisons).
- `upsertSecurity` (`lib/mutations/securities.ts`) normalizes at the write boundary:
  lowercase→canonical, `YYYYMMDD`→ISO dates, and option `multiplier`→100 when missing/≤1 (else the
  option is valued at 1/100th, leaking into inferred cash; `scripts/fix-option-multipliers.ts`
  repairs old rows).

### Symbols

- Option symbols **MUST** use OCC format (e.g. `INTC  260320P00045000`), never bare tickers —
  `ensureOCCSymbol()` in `vanguard-pdf.ts` auto-converts. Bare tickers cause stock/option collisions
  in `upsertSecurity()`'s `UNIQUE(symbol)` constraint.
- `upsertSecurity()` has a type-conflict guard — it refuses to merge stock↔option on the same symbol
  to prevent data corruption.

### Issuer-family normalization

`lib/securities/issuer-family.ts::issuerSiblings(symbol)` is the single source for dual-class
siblings (GOOG/GOOGL, BRK A/B, FOX/FOXA, NWS/NWSA, UA/UAA, LBRDA/LBRDK, LSXMA/LSXMK, HEI/HEI.A). Use
it whenever rolling up positions across share classes; never symbol-string-equal. Extend the
`FAMILIES` constant.

### Import validation

`lib/import/validate.ts` runs before commit — it validates dates, quantities, prices, transaction
types, AND financial sanity (`isGarbageSymbol()` rejects timestamps, commas, >30 chars, purely
numeric). Bad rows are excluded with warnings.

### Derived-price repair precedent (per-contract option prices)

The 2026-05-04 canonical import (batch 66) wrote 16 option prices as per-CONTRACT values because
those securities were created with `multiplier=NULL` pre-`94dbce9`. Valuation then ×100'd them again,
inflating Vanguard Taxable holdings by **$3.56M on 4/30**, poisoning the month-end inferred-cash
anchor (**−$3.52M**) and turning every May daily valuation negative ("184% max drawdown").

Repaired via `scripts/repair-canonical-option-prices.ts` (÷100 with exact-value guards, idempotent) +
`computeDailyValuations`.

**Diagnostic signature for recurrence**: negative `daily_valuations.total_value` + constant
hugely-negative inferred cash month-long ⇒ check option/bond price rows at the month-end anchor date
for unit-convention drift.

---

## D. Valuation, FX and prices

### Market values

Market values use `adjustedMarketValueSQL()` from `lib/valuation.ts` — it handles bonds (÷100) and
options (×multiplier), and uses `LOWER()` for case-insensitive type matching.

Bond unrealized gain: apply the par-adjustment to **BOTH** current value AND cost basis.

### Foreign-currency valuation (single source, 2026-07-02)

`prices.close_price` and `holdings.cost_basis` are stored in the security's **native currency**
(`securities.currency`, **migration 061**, default `'USD'`); USD conversion happens ONLY at
read/valuation time.

**Helpers**

- `lib/queries/fx-rates.ts::getUsdPerUnit(db, currency)` — returns 1 for USD/null/unknown/missing-table;
  **never fabricates a rate**.
- `lib/mutations/fx-rates.ts::upsertFxRate` — rejects ≤0/non-finite, no-ops USD.
- `fx_rates(currency PK, usd_per_unit, as_of, source)` holds broker-sourced rates (never
  guessed/external).

**Primary source (2026-07-03 go-live): `ibkr_ledger`** — the Web API ledger's per-currency
`exchangerate` via `extractLedgerFxRates` (`lib/ibkr/map-positions.ts`), threaded through
`IbkrPortfolioSnapshot.fxRates`.

The original `deriveUsdPerUnit` (broker `marketValue` ÷ native `marketPrice × qty × mult`) was
**live-disproven on the Web API path** — its `mktValue` is NATIVE currency, so the derive yields a
bogus ~1.0; that path no longer derives (it skips when the ledger lacks a currency). The derive
survives only on the TWS path (`tws_derived`, base-currency assumption still unverified), and
`upsertFxRate` enforces **source precedence**: a derived write cannot overwrite an `ibkr_ledger` rate
fresher than 7 days (the skip is logged `[fx-rates] Skipped …`).

**Every per-holding $ value or weight must carry the FX factor**

- SQL sites: `adjustedMarketValueSQL(..., "COALESCE(fx.usd_per_unit,1)")` +
  `LEFT JOIN fx_rates fx ON fx.currency = <secAlias>.currency`.
- JS sites: `marketValue(..., getUsdPerUnit(db, currency))` (5th arg).
- Returned raw `cost_basis` columns: `* COALESCE(fx.usd_per_unit,1)`.
- The USD path is byte-identical (rate 1).

**Do NOT convert** currency-invariant things: % returns, log-ratio/beta regressions,
Sharpe/drawdown/vol (all `daily_valuations`-based), benchmark/index prices, or the `/100` bond
par-scaling.

**Options are USD-denominated** — force `currency:"USD"` on option TWS contracts
(`secType === SecType.OPT ? "USD" : sec.currency || "USD"`).

**Intentionally left native**

- `/api/tax-report` Form 8949 (`getClosedTaxLotSales` / `lib/compute/tax-report.ts`) —
  historical/tax FX is out of scope.
- Watchlist `current_price` vs user-entered `target_price` — converting one side breaks upside-%
  math; revisit only when a foreign name is watchlisted.
- LevelsPanel + chart bar series — levels are user-entered native, the chart plots native bars.

**Chart-adjacent display pattern (2026-07-06 read-surface sweep)**: when a surface feeds BOTH a
chart/ratio (needs native) and $-text (needs USD), the query returns native and the page threads
`SecurityDetailData.usdPerUnit`; `MarketDataPanel` / `QuoteStats` take a `usdPerUnit` prop and
multiply ONLY at `<Money>` / `formatUSDPrecise` sites (ATR% + 52wk-position ratios are
scale-invariant; the chart price-line stays native).

Pure-display query paths converted in SQL in that sweep: `getHoldingsByAccount` `cost_basis`, Today
IBKR per-share/prior close, `getLatestPrice` (Charts header), `reconcileCostBasis` BOTH sides,
briefing `buildCurrentPrices` (LLM prompt prices).

When adding ANY new surface that renders a holding's dollar value, thread the FX factor or it will
show a foreign holding as a currency-scaled phantom. Spec:
`docs/superpowers/specs/2026-07-01-foreign-currency-valuation-design.md`.

### Price source priority

`tws(1) > ibkr(2) > vanguard(3) > manual(4)` (conditional upsert in `engine.ts`).

Holdings-derived prices (`marketValue/quantity` in `commitImport` step 4b) inherit the parser
`sourceType` via `holdingDerivedPriceSource()` — **never hardcode `"canonical"`** (else every
Vanguard PDF drops to priority 4 and a stale manual price wins). Test: `tests/import/engine.test.ts`.

### TWS snapshot price date is ET-anchored + trading-day-guarded

`fetchSnapshotPrices` (`lib/tws/snapshot.ts`) stamps `todayET()` (**NOT** UTC) and early-returns when
`isMarketClosed(today)`. Never revert to a UTC date or drop the guard — every consumer (anomalies,
valuations) treats the latest `prices` row per date as that date's close. The date is injectable via
`options.asOfDate`. `DELAYED_FROZEN` is intentionally kept (the frozen close was accurate; the bug
was the date).

### Daily totals anchor to broker-reported NetLiq — reconstruction is a decomposition, never a replacement

On anchor dates `computeDailyValuations` Phase 2 infers cash (`snapshot_total − holdings_value`) so
`total_value ≡ monthly_snapshots.total_value`; `cash_value` is fallback-only (no priced row that
day). Preferring reported cash (2026-04-16 `ddb63f9`) paired real cash with ghost-inflated holdings →
fake ±13% days. `cash_balance` is a **residual** on broker-anchored days, not literal cash.

Companion source-hygiene: `syncPortfolio` calls `removeStaleSameDayTwsHoldings`
(`lib/mutations/same-day-tws-holdings.ts`) after each commit — it deletes same-day `tws-%` rows
absent from the current sync (intraday round-trips lingered: upsert never deletes + zero-qty
skipped), 50% shrink-guarded, statement rows untouched.

**Diagnostic for recurrence**: daily swings exceed the broker statement's best/worst day while
`monthly_snapshots` (source='tws') is smooth.

### Return-series code must guard the `prices` multi-month gap

`prices` mixes sparse month-end `canonical` anchors (last 2025-06-30) with dense `tws` daily rows
(from 2026-03-27) → a ~9-month hole; an `ln(price/prev)` spanning it injects a giant fake "daily"
return (NFLX β = −14.31). **Drop pairs where `calendarDaysBetween(a,b) > 7`.** Applied in
`refresh-vanguard-betas.ts` + `computePositionRisk` (windows that reach the anchor); not needed in
`security-regression.ts` or `daily_valuations`-based computes. See
`memory/project_prices_gap_guard.md`.

**Sibling split-signature guard (2026-08-05)**: `isSplitSignatureReturnPair` (`lib/compute/risk.ts`)
drops integer-multiple discontinuities (unadjusted splits — the VGT 8:1 read as a −87.5% "day") from
BOTH files' return loops.

**Options are EXEMPT in `computePositionRisk`** — premiums legitimately double/halve (ratio 2.0 sits
dead-center in the guard's band; 10+ real pairs in live data), same reasoning as the levels
plausibility guard's option exemption. The betas script is stock/ETF-only so needs none.

**Data repair**: `scripts/repair-split-prices.ts <SYM> [--apply]` (dry-run default; ÷ratio
prices/ohlcv + ×ratio `holdings.quantity` strictly before the split date; residual verification runs
INSIDE the transaction so a mis-detected ratio rolls back instead of half-adjusting; `cost_basis`
untouched — split-invariant total dollars). VGT repaired live 2026-08-05 (backup
`data/backups/pre-vgt-split-repair-2026-08-05.db`, betas refreshed).

---

## E. Scoping, returns and risk compute

### Account scoping rule

Pages with a scope selector — **EVERY query must accept/respect `accountIds`; no global queries**.
Resolve via `resolveScopeToSingleId()` / `resolveScope()` (`lib/queries/accounts.ts`).

**Scopes are disjoint**: `vanguard` excludes any "roth" account, so `all = vanguard + roth + ibkr`
partitions the portfolio.

### Multi-account compute scope — `accountIds[]`, never first-id

`computeFactorAnalysis` / `computeRiskMetrics` / `computePositionRisk` accept `accountId?` (legacy) +
`accountIds?: number[]`, normalized by `normalizeAccountIds` (`lib/compute/factors.ts`);
`computePeriodAttribution` takes `AttributionScope` (id | id[] | undefined = whole portfolio) since
`cc317ff` 2026-06-11.

Pull the valuation series from `getDailyValuationsForAccounts` (sum per-date BEFORE
drawdown/vol/Sharpe). **Never collapse a multi-account scope to `accountIds[0]`.** `/api/compute/*`
routes stay on `resolveScopeToSingleId` deliberately.

**Coverage-jump guard (single-sourced 2026-07-03 `0ce68b5`)**: per-account daily-valuation coverage
STARTS on different dates (IBKR 3/27, Vanguard + Roth 4/06) — a summed series "gains" an appearing
account's whole value as a fake return (+89% phantom YTD alpha; not an external flow, so risk's
flow-adjustment can't neutralize it). Pass `fullCoverageOnly: true` to
`getDailyValuationsForAccounts` / `getDailyValuationsCombined` (SQL `HAVING` vs max simultaneous
account coverage) — enabled in `computeMarketRegression`, `computeRiskMetrics`, and
`computePeriodAttribution`; chart/benchmark consumers are deliberately unfiltered (they display the
actual account-sum). **Any NEW multi-account summed-series consumer doing return math must pass the
flag.**

### TWR reconciliation gate

`reconcileTwrAgainstStatements` (`lib/compute/twr-reconcile.ts`) — **pass `startDate === endDate ===
periodEnd`** (else `computeTwr` returns CUMULATIVE TWR, incomparable to the per-month statement
value). `ibkr-activity` TWR is percentage (÷100); canonical/vanguard-pdf are decimal.
`scripts/audit-twr-vs-statements.ts` is the pre-merge gate (exits 1 if >20% out-of-tolerance).

### Scope-all TWR/XIRR are coverage-guarded; transfer flows are signed (2026-08-05, PR #30 + review fixes)

- `lib/compute/snapshot-coverage.ts` (`SNAPSHOT_FIRSTS_CTE` + `EXPECTED_ACCOUNTS_SQL`) skips
  aggregate months where any already-BORN account's statement is missing — a statement-lag month
  otherwise reads the absent account as a catastrophic fake return. Skipped months' deposits carry
  into the next covered month (fixed 0.5 Dietz weight — a documented approximation).
- **XIRR's terminal value carries its own anchor date**: flows dated after it are EXCLUDED and the
  liquidation flow lands ON the covered month's date, never `effectiveEnd` — a lagging-month deposit
  booked against an older terminal value reads as a loss (regression-pinned in
  `tests/compute/portfolio-snapshot-coverage.test.ts`).
- `SIGNED_EXTERNAL_FLOW_SQL` (`lib/compute/flow-adjusted.ts`) signs `TRANSFER_OUT` as `-ABS(amount)`
  at EVERY `is_external_flow` reader (transfer rows store positive magnitude in every era —
  live-verified; sign-idempotent by construction). **In-kind (non-cash) TRANSFER legs**: amount holds
  transfer-date FMV (positive); type (IN/OUT) carries direction; readers sign them. A `donation_leg_links`
  row flags a leg `is_external_flow=0` (routed, non-cash-contributing). **`excludeInKind` cash-stepping
  gate** (`lib/compute/daily-valuation.ts`): daily valuations exclude in-kind `deposits_withdrawals`
  (snapshots only have statement-authority cash flows), but risk/TWR readers pass the full-width flow
  set (a routed in-kind leg appears as a normal flow, time-valued but contributing zero cash). **TWR/XIRR
  snapshot path**: snapshot `deposits_withdrawals` never contains in-kind; `UNION` branches over
  snapshots prefer statement `deposits_withdrawals` or fall through to statement-anchored transaction
  sum (which includes in-kind, pre-signed) — never double-count legs via both paths.
- Cost-basis fallback single source: `lib/valuation.ts::scaledCostBasisFallbackSQL` scales a stale
  statement row's basis per-share to the current quantity and signs like the position (never serve a
  different share count's whole basis); consumers wrap it `NULLIF(<expr>, 0)` — a zero stored basis
  is "unknown", not "free" (MV − 0 rendered a phantom whole-MV gain).
- Short gain %: `lib/format.ts::unrealizedGainRatio` divides by `|basis|` so the percent follows the
  dollar gain's sign.
- Negative `holding_period_days` render `<HoldingPeriodBadge>` ("short" chip,
  `app/dashboard/components/HoldingPeriodBadge.tsx`) on all four surfaces — data stays signed; 8949
  CSV/TXF exports stay raw.
- Known dormant residual: `getCrossAccountPositions` + `data-health.ts` keep the old unscaled
  fallback (their `cost_basis` output has no numeric consumer — presence-only convention).

### Portfolio risk metrics are flow-adjusted — never compute on raw `daily_valuations` values

Single source `lib/compute/flow-adjusted.ts` (`fetchNetFlowsByDate` + `buildFlowAdjustedIndex`,
extracted 2026-07-26 — its own module because `risk.ts` imports `normalizeAccountIds` from
`factors.ts`, so factors importing them back from risk.ts would cycle).

`computeRiskMetrics` (`lib/compute/risk.ts`) AND `computeMarketRegression` (`lib/compute/factors.ts`,
since `5955c1f`) build the growth index `r_t = (V_t − F_t)/V_{t−1}` from `is_external_flow=1`
transactions (the same rows TWR uses; flows attribute to the next valuation date).

Raw values read a withdrawal as a crash (the 2026-06-10 fake 23% IBKR drawdown) or a fake regression
day (the 2026-07-26 beta-0.05/+63%-alpha finding — a −$100k withdrawal as a −20.9% "day").

**Smell test for any new metric: it must be invariant to depositing $1M and buying nothing.**

Drawdown dollar fields intentionally report raw account values at peak/trough dates. The flow lookup
no-ops when the `transactions` table is absent (minimal test DBs).

**Known residual, self-healing**: flows that exist in reality but not yet in the ledger (statement
lag — the +$189k 7/17 Plaid-anchor jump) still read as returns until the statement import lands their
flow row; the UI's `LOW_R2_THRESHOLD` caption (`lib/analysis/interpret.ts`, <10% R² → "noise, not
signal", `dataWindowNotice`'s sibling) covers the gap honestly.

### Daily-data window honesty (2026-07-21)

Any surface computing over `daily_valuations` under a user-selected period label (drawdown / Sharpe /
equity curve on Performance) must caption its ACTUAL window when shorter than the label — daily
history starts 2026-03-27 (risk full-coverage floor ~04-06) while TWR reads multi-year
`monthly_snapshots`, so 3Y/All labels otherwise silently show ~4-month metrics (QA ledger regression,
root-caused as a data floor, NOT wiring).

Single source: `lib/compute/data-window.ts::dataWindowNotice(requestedStart, seriesStart, seriesEnd)`
(7-day grace, null = covered); `computeRiskMetrics` exposes `seriesStart`/`seriesEnd` for it.

Self-heals as history accrues — never "fix" by widening to monthly-granularity Sharpe/drawdown
(month-end sampling understates drawdown).

Sibling of the explain-no-ops convention: What-if's `ExposureDelta.droppedLegs`
(`unknown_symbol`/`not_held`, `lib/compute/exposure-delta.ts`) is the same shape — an engine that
silently skips input must report what it skipped.

### Delta-adjusted exposure (single source)

`lib/compute/exposure.ts`:

- `getOptionExposureMap` — Δ × spot × multiplier × qty per option, from `computePortfolioGreeks`;
  signed, puts negative, shorts negative.
- `exposureForHolding` — non-options at MV.
- `optionExposureFallback` — ±`DEFAULT_OPTION_ELASTICITY` (2.5) × MV, a shared export from
  scenario-recipes, used when Greeks are unavailable.
- `getPortfolioExposureSummary` — net/gross vs holdings MV.

`AllocationEntry` carries `net_exposure` + `exposure_pct` (same MV denominator as `percentage` — the
columns are comparable); both allocation paths (JS-aggregated standard dims + sector look-through,
with exposure split across exploded parts by MV share) populate them.

UI: a "Net exp %" column + "Net exposure N% · gross N% of holdings" headline in `AnalysisView`
Breakdown (negative → `text-down`).

MV answers "where is my capital"; exposure answers "what moves my P&L" — a hedged bucket (stock +
puts) correctly reads exposure < MV and can go negative. Tests: `tests/compute/exposure.test.ts`,
`tests/queries/analysis-exposure.test.ts`.

---

## F. Classification: sectors, factors, look-throughs

### GICS sector normalization (single source)

`lib/securities/normalize-sector.ts::normalizeSector(raw) → GICS-11 | null` + `GICS_SECTORS` is the
canonical sector vocabulary (it matches the `benchmark_compositions` table — it uses `"Technology"`,
NOT `"Information Technology"`).

It maps only 1:1-safe strings (`Health Care`→`Healthcare`, `Basic Materials`→`Materials`,
`Information Technology`→`Technology`, …) → GICS; passes `Diversified`/`Fixed Income` through;
blank/unknown → null.

**FOUR Bloomberg buckets are DEMOTED (2026-07-28, never re-alias them): `Communications`,
`Consumer, Cyclical`, `Consumer, Non-cyclical`, `Financial`** — each spans several GICS sectors
(AMZN/HOOD/UBER/SHOP all sat in "Communications"; UNH/VRTX in "Non-cyclical"; REITs in "Financial"),
so they return null and the context-aware Claude classify tail fills the sector instead (the COALESCE
write sites make null a safe no-op). The doc comment in `normalize-sector.ts` carries the
live-verified damage table.

**`securities.sector` is written at THREE sites** (NOT via `upsertSecurity`): `lib/tws/contracts.ts`,
`lib/compute/classify-factors.ts`, `lib/import/engine.ts` — each `normalizeSector(...)`s the value and
preserves the raw vendor string into `industry` only when empty (`COALESCE(NULLIF(industry,''), ?)`).

**Never bucket on a raw `sector` string** (the portfolio was Bloomberg-tagged, the benchmark GICS →
garbage gaps). Option sectors derive from the underlying; options on non-held underlyings get
sectored by `lib/securities/classify-option-sectors.ts::classifyOptionSectors` (Claude, strict
GICS-11 guard).

**Any map keyed on sector names must use the canonical GICS-11 spellings**: `SECTOR_TO_ETF` in
`lib/calendar/reaction-snapshot.ts` + the Worker mirror `reaction-matcher.ts` were keyed "Health
Care" for months — every Healthcare earnings name silently logged a `sector_etf_gaps` row. Fixed
2026-07-06: `resolveSectorEtf` is now `normalizeSector`-defended Mac-side and the backlog was
reprocessed via `scripts/reprocess-sector-etf-gaps.ts`. Since 2026-07-06
`workers/cron/test/reaction-matcher-parity.test.ts` pins Worker↔Mac parity for `SECTOR_TO_ETF` +
`EVENT_SECTOR_MAP` AND asserts every key ∈ `GICS_SECTORS` — the vocabulary assertion is the one that
catches a both-sides-agree misspelling.

Shipped 2026-06-09; see `memory/project_analysis_classification_backbone.md`.

**Sector verification layer (2026-07-28, migration 071 + spec
`docs/superpowers/specs/2026-07-28-sector-tag-verification-design.md`)**

- `securities.sector_source` (`tws_bloomberg` / `ai_classify` / `csv_import` / `gics_verified` —
  stamped CASE-guarded at the three write sites) + `sector_verified_at` (owned SOLELY by the sweep).
- `scripts/verify-sector-tags.ts` (lib: `lib/securities/verify-sector-tags.ts`, feature key
  `sectorVerification` → `$frontier` + `web_search`) is the repair + standing resolution tool:
  dry-run default, `--apply`, named symbols re-verify. It stamps verified rows **EVEN when
  unchanged** — the stamp suppresses the Data Health "Sector disagreements" panel, which is how
  GOOG/META's legit `fund_category` divergence stays quiet without an allowlist. It cascades sectors
  onto option rows (never stamped — derived).
- 190 stocks verified live 2026-07-28; every stock sector is now true GICS-11.
- The Data Health panel flags UNVERIFIED `US Sector Equity (X)` disagreements only (panel-local
  aliases map fund-category-context `Financial`/`Communications` — do **NOT** re-add those to the
  global `ALIASES`).
- Consumers fixed in the same sweep: `macroEventToSectors` (briefing §6 sector clusters — its
  Bloomberg query strings had matched ZERO rows since June; now GICS-11 + a vocabulary-pin test), and
  the chat `query_holdings` sector filter (`normalizeSector` + chat-local legacy aliases in
  `lib/queries/chat-tools.ts`).

### ETF sector look-through

**Migration 059** `etf_sector_weights` (per-(etf, GICS sector) weights, sourced via Claude +
`web_search` in `lib/etf/sector-weights.ts` — Finnhub ETF endpoints are premium-gated, verified).

`lib/compute/explode-sector.ts::explodeHoldingBySector` distributes an ETF/MF's market value across
sectors by weight (single-bucket fallback otherwise). Currently wired ONLY into cash-deploy
(`loadCurrentHoldings`); reuse it for any sector-allocation surface rather than dumping ETFs in one
bucket.

### fund_category vocabulary normalization (single source)

`lib/securities/normalize-fund-category.ts::normalizeFundCategory(raw)` maps bare-sector synonyms
("Technology", "Semiconductor", "Financial Services", …) to the canonical `US Sector Equity (X)`
scheme. It is an **OPEN vocabulary** — unknown labels pass through unchanged (unlike
`normalizeSector`).

Applied at every `securities.fund_category` write site (`classifySecurities` static-map paths +
`classifyUnresolvedWithClaude`); the AI classify prompt also instructs the scheme. Backfill:
`scripts/backfill-fund-categories.ts` (idempotent; ran 2026-06-09, 74 rows).

Pre-fix the Classification allocation split one exposure across parallel buckets (Technology 12.1% +
US Sector Equity (Technology) 17.0%).

### Option→underlying classification look-through

`getAllocationByDimension` attributes an option's market value to its UNDERLYING's `fund_category` /
`geography` / `market_cap_category` / `style` (`LEFT JOIN securities s_u ON s_u.symbol =
s.underlying_symbol`, falling back to the option's own value → `'Options'` when the underlying is
missing/unclassified) — the same inheritance the factor dimensions already apply.

`asset_class` / `security_type` dimensions intentionally KEEP the Options grouping ("how much is in
options" lives there).

Pre-fix, 16.8% of the portfolio sat in one `'Options'` `fund_category` bucket and tech exposure read
14.1% instead of ~29%. Test: `tests/queries/analysis-option-lookthrough.test.ts`.

### Factor classification covers option underlyings + shorts (2026-06-09 `2d80eed`)

`classifyFactors` candidates = held non-option securities (`quantity != 0` — shorts carry factor
exposure) **PLUS** distinct underlyings of currently-held unexpired options, creating minimal
securities rows (`source_key 'underlying:SYM'`) when the underlying isn't in the DB.

Options themselves never get factor rows — they inherit from the underlying at query time, and
**every coverage surface must apply that inheritance**: `getFactorHeatmap`, `getFactorCoverage`, AND
`getAnalysisTrustState` all COALESCE-join `securities s_u ON s_u.symbol = s.underlying_symbol` →
`security_factors sf_u`. Any new factor-coverage consumer must do the same or it will contradict the
heatmap (the Trust Strip did exactly that for a month).

The result carries `candidates` + `underlyingsCreated` so UIs can explain no-op runs.

### Honest classify reporting

The sector/fund classifier (`classifySecurities`, static-map-only) has a Claude tail-fallback
`classifyUnresolvedWithClaude`; the route returns `unresolvedCount` and the toast surfaces it (never
a silent no-op).

The factor classifier exposes `isFactorClassifySuccess({classified, errors})` (failure ⇔
`classified === 0 && errors > 0`); `/api/compute/classify-factors` returns 502 and `FactorModeCard`
shows an error/info toast on all-batch failure (it was always-green even on 0-classified).

New AI feature keys: `securityClassification`, `etfSectorWeights` (Sonnet).

---

## G. AI / LLM output handling

### Claude model IDs

`lib/claude-models.ts` is the single source — import `OPUS_MODEL` / `SONNET_MODEL`, never inline a
string (Anthropic requires exact IDs, no "latest" alias).

### LLM structured-output ARRAY fields must be type-guarded — `jsonSchema()` does NOT runtime-validate

*(2026-07-15 digest outage)*

Despite an `array` schema, the model intermittently returns `key_themes` as a comma-joined STRING; a
string survives `.slice(0,5)` (5 chars, silently) and then `.join()` / `.map()` throws — this crashed
every Worker digest tick 9:00–10:30 ET **after** its ~10 Claude calls succeeded.

Guard at the model boundary: `normalizeThemes` (`workers/cron/src/fallback-digest.ts`, imported by
newsletter-fetch) + the inline guards in `lib/gmail/process.ts`. **Never `.slice()` / `.map()` /
`.join()` a `generateObject` array field without `Array.isArray` first.** Regression pin: "a string
key_themes from the model must never crash the compose" in
`workers/cron/test/fallback-digest.test.ts`.

**String-field variant (2026-07-21)**: the model also intermittently dumps its ENTIRE tagged response
INSIDE a string field (`summary` = `"...prose.</summary>\n<key_themes">[...]<sentiment>..."`) — a
valid string, so schema validation can never catch it; 9 `research_articles` rows shipped that way
7/07–7/20 and rendered raw markup in Feeds.

Guard at the storage boundary with `sanitizeModelSummary`. **Since 2026-07-23 the Mac-side sanitize
helpers live in `lib/gmail/theme-sanitize.ts`** — a deliberately zero-import module so `"use client"`
components can import it; `lib/gmail/process.ts` re-exports for back-compat (**edit
theme-sanitize.ts, not process.ts**) — with the Worker mirror in
`workers/cron/src/fallback-digest.ts` (semantic parity, change both; `SUMMARY_TAG_REMNANT` +
`cleanThemeElement` byte-parity is PINNED by `workers/cron/test/fallback-digest.test.ts`'s fs+regex
parity test). Repair paths: `scripts/repair-xml-summaries.ts` + `scripts/repair-key-themes.ts`
(idempotent, dry-run default).

**Element-level variant (2026-07-23)**: tag debris also lands INSIDE otherwise-valid array elements
(`<parameter name="key_themes">["theme"` — the 7/22 Research Desk leak) — `sanitizeThemeList` (Mac) /
`normalizeThemes` (Worker) clean per element at storage AND at every render site (digest composers,
Research Desk, group-by-company, chat tools, ThemePills, cloud-newsletter reconcile).

Any NEW prose-string or string-array field stored from `generateObject` output should get the same
cut-at-first-tag-remnant treatment, and any NEW `key_themes` reader must go through the sanitizer,
never bare `JSON.parse`.

### LLM JSON-array parsing

`lib/ai/extract-json.ts::extractJsonArray(text)` strips code fences + isolates first-`[`..last-`]` so
a model prose preamble ("I need to classify these…") doesn't break `JSON.parse`; it returns prose
unchanged when there's no array (so the batch still errors loudly, not silently). Use it at any
classify/extraction call site that `JSON.parse`s an LLM array — Sonnet emits preambles
intermittently and deterministically per batch.

**Companion defense (control chars)**: models also intermittently emit RAW unescaped newlines INSIDE
JSON string literals ("Bad control character…" — crashed macro-themes cold-cache AND the first live
sector sweep); retry the parse with C0 controls collapsed to spaces
(`json.replace(/[\u0000-\u001f]+/g, " ")` — legal JSON unaffected).

Precedents: `lib/compute/macro-themes.ts::parseThemesJson`,
`lib/securities/verify-sector-tags.ts::parseVerdicts`. **Any new LLM-JSON parse site gets both
defenses.**

### `joinClaudeTextBlocks` + citation-linebreak repair (2026-08-06/07)

Claude's `web_search` tool splits a single response across multiple `text` content blocks at citation
boundaries — `callClaude` (`lib/digest/send-earnings-email.ts`) **MUST join them with `""`, never
`"\n"`**.

A bare-newline join (the pre-fix code) plants a literal mid-sentence line break at every citation,
which `briefingToHtml` then renders as disjoint one-line paragraphs — the root cause of the "prose
doesn't flow" complaint, confirmed in 6/6 sampled sends.

A renderer-side fix (collapsing short lines in `briefingToHtml`) was tried and **rejected** — it also
merged genuine paragraph breaks (25→16 paragraphs on real data); fixing at the join is the only
correct layer.

Already-stored emails from before the fix get a read-boundary repair,
`lib/earnings/repair-citation-linebreaks.ts` — applied ONLY at the two earnings display read sites
(`GET /api/earnings/email-content` + `BogeysEditModal`'s fetch), **never at compose** (compose is
fixed at the root, so repairing there too would be redundant and risks double-processing).

Any other call site that assembles Claude `text` blocks from a `web_search`-enabled response should
join with `""` — **`lib/securities/verify-sector-tags.ts` and `lib/calendar/verify-earnings-dates.ts`
share this exact `join("\n")` shape and have NOT been fixed** (masked so far by the existing JSON
control-char retry in `lib/ai/extract-json.ts`, filed as a TODO item).

---

## H. Digest, briefing and anomaly emails

### Daily digest layouts

- The morning + evening emails use the **structured composer** (`generateDigestSinceAdaptive`, see
  the next entry).
- `generateDigestSince` (`lib/digest/daily-digest.ts`) = legacy per-source (`## SOURCE_NAME ·
  *sentiment*` headers — now the <5-commentary fallback shape + a preview pane).
- `generateDigestByCompanySince` (`lib/digest/group-by-company.ts`) = per-company (in-app only via
  `<DigestEmailViewer>` + `GET /api/digest/preview`).
- All share `formatTriggeredAlertsSection`.

### Digest structured composer (2026-06-09)

Morning/evening emails render: Late arrivals → alerts → **Overnight block → Today's-reporters block
(#18) → Call-transcripts block (#12)** (all three morning-only; 2026-07-15/16) → anomalies (evening)
→ `## The Session` / `## Overnight & Setup` + per-name synthesis (commentary only, cap 40 articles,
`maxOutputTokens: 8192` — 4096 truncated on heavy days and silently degraded to per-source) →
`## Research Desk` (essays, rendered in code, never merged).

`lib/digest/editions.ts` is the single source for source kinds (`commentary | essay`, unknown →
essay) and edition regexes (VK dawn/midday/recap supersedence, TMTB wraps) — the Worker mirror
`workers/cron/src/editions.ts` is byte-parity below the header (parity test
`workers/cron/test/editions.test.ts`); update **BOTH** when a newsletter changes its subject-line
format, and add new sources to `SOURCE_KINDS`.

Late-arrival rescue (`lib/digest/late-arrivals.ts`) flags articles received ≤60 min after the
previous send (only when the window start is a full ISO timestamp).

**Overnight-block BTC uses a rolling-24h window (2026-07-20)**: `OVERNIGHT_INSTRUMENTS` entries carry
`window: "rolling24h"` for 24/7 assets → `fetchYahooRolling24hPct` (hourly bars, latest vs the bar
nearest 24h back, null when none lands within 3h); the daily-close pair measured only the partial UTC
day at 8:45 ET (the chip said −0.1% while VK's quote said 75bp). The Worker mirror deliberately KEEPS
the daily pair for BTC — its one-spark design sits at 49/50 of the free-tier subrequest cap and only
runs Mac-asleep (documented in both files).

Essay→name cross-filing is deterministic post-processing
(`lib/digest/research-desk.ts::insertCrossFilePointers`, issuer-family aware) — never a prompt
instruction.

**Cloud-skip advances the marker**: `advanceDigestMarkerAfterCloudSend` (`lib/cron/marker-check.ts`)
runs in both cron routes' "cloud already sent" branches, forward-only, using the Worker marker's
`sentAt` (the KV value has always been an ISO timestamp) — without it the next Mac-won email
re-covers everything since the Mac last won (the 2026-06-09 7pm regression).

**On-wake reconcile (2026-07-15)**: a Mac asleep through the WHOLE window never runs that branch (the
pointer stuck at 7/13 while cloud sent 7/14 + 7/15 → the 7/15 evening recap re-covered two days).
`reconcileRecentCloudSends` (same file) reads digest + evening markers for yesterday and today
(`checkCloudMarker(type, {date})`; Worker `GET /internal/marker` honors `?date=` since 2026-07-15)
and advances from CONFIRMED sends only: `getMarkerStatus` returns `via: "sent" | "attempting"`, and
pointer advances must skip `"attempting"` (a failed attempt would drop its window's articles; skip
decisions still treat both as cloud-claimed). It runs at both cron routes' entry AND in
`GET /api/digest/status`, which is now cloud-aware (returns `cloudDigestToday`) so `DigestCatchup`
stops nagging "wasn't sent at 8:45" on cloud-sent days and shows a no-button "cloud sending…" state
mid-attempt.

Spec: `docs/superpowers/specs/2026-06-09-digest-redesign-design.md`.

### Synthesis prompt rules (pinned)

`lib/digest/synthesize.ts` `SYSTEM_PROMPT` has three blocks Sonnet must obey:

1. **COVERAGE-CHARACTERIZATION** — never "only mentioned in passing / indirectly / tangentially /
   without focus". If a symbol is in a source's bucket, that source covered it; narrate WHAT it said,
   not how prominently.
2. **HELD-TICKER PRIORITIZATION** — every held ticker with ANY coverage gets its own `##` section,
   never "## Also covered".
3. **TIMEFRAME & THREAD COHERENCE** (2026-06-07) — when a bucket spans multiple sessions, attribute
   each move to its trading day ("up Thu, down Fri" is two days, not a contradiction); keep
   structural catalyst threads separate from same-day tactical moves; don't assert an unsourced
   sector driver.

Pinned by `tests/digest/synthesize.test.ts`. **The same coherence rule is mirrored in the Worker
`workers/cron/src/fallback-evening.ts::buildSynthesisPrompt`** (the cloud path that actually sent the
6/5 GS recap), pinned by `workers/cron/test/fallback-evening.test.ts`.

**HELD-TICKER is also ENFORCED, not just requested (2026-07-20)**: `enforceHeldSections` (exported,
pure) runs as the last step of `synthesize()` — any held-symbol bucket (issuerSiblings-aware: a GOOG
heading satisfies a GOOGL bucket) with no matching `##` heading gets a deterministic citation stub
(the bucket's own source links + 240-char summary excerpts, marked "auto-surfaced") inserted before
`## Also covered`, with a console warning naming the dropped symbols. It exists because the 7/20
digest buried held CSX (two-article coverage) despite the prompt rule.

**Worker mirror (2026-07-20 evening)**: `workers/cron/src/fallback-evening.ts::enforceHeldSections` —
a semantic adaptation (Worker buckets are `Record<symbol, RecentArticleMeta[]>`, not the Mac's
`CompanyBucket[]`, so NOT byte-parity; `issuerSiblings` imported from `fallback-earnings`), wired as
the last step of `synthesizeViaAI`, pinned by pure + wired-through-`runFallbackEvening` tests. The
morning cloud digest (`fallback-digest.ts`) deliberately has NO backstop — it composes per-source,
no synthesis path. Relies on the prompt's "header MUST begin with the ticker" contract, same as
`insertCrossFilePointers`.

**Thin-coverage handling (2026-07-20 evening, spec
`docs/superpowers/specs/2026-07-20-digest-thin-coverage-design.md`)**: `lib/digest/thin-coverage.ts`
(pure) partitions held buckets whose EVERY article is a calendar-listing roundup
(`mentioned_symbols` breadth ≥ `LISTING_BREADTH_MIN = 8`; null/unparseable → NOT a listing) OUT of
synthesis input BEFORE `synthesize()` — the model never sees them and `enforceHeldSections` (which
iterates input buckets) can't stub them — rendering one deterministic `On this week's calendar: GS ·
JPM` roster line instead. Essays that `insertCrossFilePointers` can't file (its return is now
`{markdown, unfiled}`) render a `📄 Deep dives: …` pointer line (Mac only — Worker buckets include
essays so they get sections there). Both lines insert via the shared `insertBeforeAlsoCovered` helper
(a single placement source — both `enforceHeldSections` implementations were refactored onto it). The
Worker mirror is in `fallback-evening.ts` (roster only; semantic adaptation,
`LISTING_BREADTH_MIN` parity-pinned in `workers/cron/test/editions.test.ts`). **Never add a new
`.slice()`-style listing detector — extend `isListingArticle`.**

### Briefing self-admission regex + auto-regen

`lib/calendar/briefing-self-admission.ts` (`buildSelfAdmissionRegex` / `findSelfAdmissions` /
`buildSelfAdmissionAddendum`, cataloging "data looks corrupted" / "I can't verify" / "without access
to"). Consumed by the pre-send 1-shot auto-regen in `briefing.ts` (cap = 1) +
`scripts/verify-briefing-content.ts`.

`buildSelfAdmissionRegex()` returns a **FRESH RegExp per call** (the g-flag `lastIndex` is stateful)
— never cache.

### Briefing holdings: `quantity != 0` for portfolio context, `> 0` for sector clusters

The main holdings query (`lib/calendar/briefing.ts`) uses `!= 0` so net-shorts surface
(`formatHoldingsList` marks `NET SHORT` — a direction flag only, no quantity since 2026-08-02: count
× public price reconstructs $ exposure in a cc'd email; the Worker `renderBriefingHoldings` mirrors
this).

`querySymbolsBySectors` keeps `> 0` so the macro cluster narrates positive exposure only (shorts
would read as same-direction bets).

An inline comment documents the asymmetry — **don't "consistency"-refactor it**.

### Briefing EXCLUDES IBKR — Mac AND cloud (single source on the Mac)

IBKR is the short-term trading book, so the weekly briefing's portfolio context omits it (U4
2026-06-15).

`BRIEFING_EXCLUDE_IBKR_SQL` + `getBriefingHoldings` (`lib/calendar/briefing.ts`) are the single
source on every briefing-LOCAL Mac query.

The cloud Worker briefing must mirror this but **never re-derive scope in TS**:
`scripts/snapshot-state-to-r2.ts` runs `getBriefingHoldings` and ships the result as snapshot **v7
`briefingHoldings`** (Vanguard-only, `{symbol,name,sector,netQty}`);
`workers/cron/src/fallback-briefing.ts::renderBriefingHoldings` renders it (rich:
name/sector/`NET SHORT`) and the live-IBKR-symbol merge (`mergeLiveIbkrSymbols`) is **deleted** —
pre-v7 snapshots degrade to the cross-account `heldSymbols` flat list for one ≤24h cycle.

The OTHER four Worker fallbacks (digest / evening / earnings / newsletter) deliberately KEEP
cross-account `heldSymbols` (news/earnings coverage legitimately includes IBKR-held names — matching
the Mac's untouched `getHeldStockSymbols` / `getCrossAccountPositions`).

When adding any new cloud briefing surface, consume `briefingHoldings`, never `heldSymbols`. Fixed
2026-06-16 (`97c075f`); the leak was latent (it fires only when the Mac is asleep at Sunday briefing
time).

### Anomaly engine pins to a consecutive trading-day pair

`computeAnomalies` (`lib/digest/anomalies.ts`, shared by the evening email + Today
`SignificantMovesCard`) resolves ONE `(latest, prior)` pair from SPY via `resolveTradingDayPair()`
(phantom-row filtered, `nextTradingDay(prior) === latest`), compares every held name on those two
dates, and OMITS a security missing either close. **Never per-security `MAX(date)` pairing.** Guards
in `tests/digest/anomalies.test.ts`.

### Anomaly trigger is a hybrid two-gate

Flag when `|actualPct| >= 3.0` **AND** `z >= 2.0`, where
`z = |actualPct − spyPct × beta| / residual_std`.

Constants `MIN_ABS_MOVE_PCT` / `MIN_RESIDUAL_Z` / `RESIDUAL_STD_EPSILON` live in
`lib/digest/anomalies.ts` and are **mirrored byte-identical** (including the `localeCompare` sort
tie-break) in `workers/cron/src/fallback-evening.ts::evaluateAnomalies` (parity-tested).

`residual_std` on `security_betas` (**migration 056**, PERCENT); null/≤epsilon → a 3% floor only. The
email + card render `Nσ` and show ALL flags.

---

## I. Brokers and connectors — IBKR, TWS, Plaid

### IBKR headless OAuth data path

First-party OAuth 1.0a, fully headless (no TWS/Gateway/browser).

- **Mac**: `lib/ibkr/*`; `refreshIbkrHoldingsFromWebApi(db, cfg)` writes EXACTLY like the TWS sync
  (holdings `source_key='tws-…'`, prices/snapshot `source='tws'`, then `computeDailyValuations`);
  `/api/tws/auto-refresh` falls back to it when `getIbApi()` is null + OAuth is configured.
- **Worker**: `workers/cron/src/ibkr-{oauth,positions}.ts` (a WebCrypto + BigInt port), wired into
  `fallback-earnings` + `fallback-briefing` (best-effort → snapshot on any failure, read once per
  run).

**Invariants**

1. Live IBKR **REPLACES** the snapshot's IBKR-family rows (account-name `includes("ibkr")`), never
   APPENDS (`combineFamilyPositions`).
2. The signature key ships as PKCS8 DER base64 (`openssl pkcs8 -topk8`), **not** PKCS1.
3. `live_session_token_expiration` is epoch **millis**; the cached LST lives in KV `ibkr-lst` (24h
   TTL) and re-mints once on 401/403.

Setup: mint the access token AFTER the consumer key activates (overnight). 5 Worker secrets. Smoke:
`POST /internal/ibkr-test`. Topic: `memory/project_ibkr_connector.md`.

### IBKR market-data snapshot enrichment (migration 058, 2026-06-08)

`lib/ibkr/market-data.ts::getMarketDataSnapshot` batches `/iserver/marketdata/snapshot` (warm-up
re-poll — the first request returns sparse rows).

**Field codes VERIFIED via live probe** (never guess — data-integrity rule): `31` = last, `7283` =
IV%, `7284` = HV% (÷100 → fraction), `7293`/`7294` = 52wk hi/lo; the pure `parseSnapshotRow` maps
them.

The `security_quotes` table is the **single cache** (PK `security_id`, one row, latest wins) via
`lib/mutations/security-quotes.ts::upsertSecurityQuote` +
`lib/queries/security-quotes.ts::getSecurityQuote` / `getQuoteCandidateConids` (held + watchlist
equities, excluding cash).

**R1b 2026-07-07**: held options + bonds join as a `priceOnly` tier — snapshot last → `prices` row
only, **NEVER** a `security_quotes` row. Probe-verified: bonds are par-based, options per-share, and
field 31 carries a `C`/`H` prefix (`"C8.01"` = prior close) that `parseLastPrice` strips. Probe:
`scripts/probe-ibkr-optbond-snapshot.ts`; snapshot calls chunked at 80 conids.

`lib/ibkr/refresh.ts::fetchAndStoreQuotes` rides the existing OAuth session (best-effort, never
blocks holdings), caches IV/HV/52wk AND writes the snapshot price to `prices` (`source='tws'`) for
held + watchlist — the "free byproduct" scope (watchlist is the only new coverage; held-price +
Yahoo-benchmark paths untouched).

**Consumers**: `computePortfolioGreeks` uses `security_quotes.iv_underlying` as the fallback sigma
when an option has no market price (`OptionGreeks.ivSource: "computed" | "ibkr" | "default"` —
replacing the blind 30%); `<QuoteStats>` strip on Security Detail (52wk range + IV + HV — **public
market data → plain formatters, NOT privacy-masked**).

**Dividend yield deferred** — not in the raw snapshot (probe-confirmed); the column is nullable, fill
later from a fundamentals endpoint. Spec:
`docs/superpowers/specs/2026-06-08-ibkr-market-data-snapshot-design.md`.

### IBKR brokerage session: holdings paths are SESSIONLESS; `/iserver` sessions are `compete:"true"` gated on local TWS aliveness

*(pivoted 2026-07-21, supersedes the original `compete:"false"` design — see
`scripts/probe-ibkr-compete.ts` header for the full four-row probe verdict)*

`/portfolio/*` reads need **no `ssodh/init` at all** — probe-verified live: `/portfolio/accounts`,
`/portfolio/{acct}/positions/{page}`, `/portfolio/{acct}/ledger` all return full data on a signed LST
alone, in every scenario (TWS open or closed).

So Mac `fetchIbkrPortfolio` (`lib/ibkr/refresh.ts`) and Worker `fetchLiveIbkrPositions`
(`workers/cron/src/ibkr-positions.ts`) never open a brokerage session — **never add an `ssodh/init`
call to a `/portfolio`-only path**; they can't evict anything and always work, TWS or no TWS.

Only `/iserver`-needing consumers (earnings-intel's Web API road, quote enrichment) call
`openSession`, which **ALWAYS** uses `compete:"true"` — **this consumer key's force-compete capability
REJECTS `compete:"false"` outright** (probed 2026-07-21, both TWS-open and TWS-closed: `auth/status`
fails with `"Force compete capability must be used together with compete flag"` — there is no polite
variant for this key) — and is safe only because `openSession` (`lib/ibkr/web-api.ts`) gates it
behind `isTwsListeningLocally`: a raw TCP probe of the local TWS API port (host/port from
`getTwsStatus()`) run BEFORE any IBKR network call.

If TWS is listening locally, `openSession` throws `IbkrSessionYieldError` immediately (no LST mint,
no IBKR call); only when TWS is confirmed absent does `compete:"true"` reach IBKR, where it has
nothing to evict.

`isSessionYield` (Mac `lib/ibkr/web-api.ts`; the former Worker mirror was **DELETED outright** since
the sessionless Worker holdings path no longer inits sessions) stays as a DEFENSIVE post-init
backstop only — the local gate is the primary yield-detection mechanism. Single-machine assumption:
the local port check only sees a TWS running on this same Mac.

**History**: the original bug was `compete:"true"` used unconditionally, evicting the user's TWS
desktop login on every Web API touch (cockpit intel passes, disconnected-path refresh feedback loop,
Worker earnings ticks) — fixed first with a blanket `compete:"false"`, which the follow-up probe then
proved this key can never authenticate with, motivating this pivot.

**Earnings-intel straddle is still TWS-first** (`lib/tws/atm-straddle.ts::fetchTwsAtmStraddle`): the
Web API straddle road (which does call `openSession`) runs only when TWS is absent, so no enrichment
is lost at the desk.

### TWS portfolio sync

TWS portfolio sync filters to the personal account set via the `IBKR_ACCOUNT_CODE` env var (the
managed advisor account is excluded). `getAccountUpdates()` includes `marketPrice` in the position
data. On TWS connect, the auto-refresh pipeline runs automatically: positions → enrich → snapshot
prices → valuations → benchmarks.

### Plaid live-data path and gotchas

`lib/plaid/refresh.ts` mirrors the IBKR Web API path: holdings `plaid:{acct}:{sec}:{date}`
`source_key`s, `source='plaid'` snapshot + MF prices at priority tier 3, `cost_basis` NULL, statement
always wins.

All gotchas below were live-verified 2026-07-11 on the first real sync:

1. Plaid mislabels some option positions as the UNDERLYING's type (`etf` for an MTUM put) with an
   unpadded OCC-ish ticker — `mapPlaidHoldings` OCC-shape-detects tickers (`parseOccShapedTicker`)
   regardless of Plaid's type label; **never trust `type` alone for options**.
2. Plaid uses dotted share classes (`BRK.B`) where statements store slashes (`BRK/B`) —
   `writePlaidHoldings` resolves dot→slash against existing securities before creating; an unresolved
   dup gets phantom-closed by the equity reconciler (the `securitiesCreated` list in every sync
   result exists to surface this — review it after any sync that creates securities).
3. Plaid **production** REQUIRES an HTTPS, dashboard-registered `redirect_uri` (`http://localhost` is
   sandbox-only) — `PLAID_REDIRECT_URI` is opt-in (omitted from `/link/token/create` when unset;
   sandbox test-institutions need none) and connect/reauth runs through a temporary `cloudflared`
   quick tunnel (runbook comment in `.env.local`); daily syncs never touch it.
4. Plaid omits CUSIPs for treasuries/restricted names → they land in `unmatched` and stay
   statement-maintained (bonds are never reconciler-touched, so this is safe).
5. `proposeAccountMap` allowlists investment subtypes only (brokerage/mutual-fund → taxable, roth →
   Roth) — sandbox proved an unguarded else-branch maps checking/mortgage/529 accounts onto Vanguard
   Taxable; under-map by design, the Settings mapping UI completes it.

### Data Health

`/dashboard/data-health` — coverage, freshness, gaps, reconciliation. The
`DataConfidenceIndicator` header popover links there. The old `DataFreshness.tsx` is unused (replaced
by `DataConfidenceIndicator.tsx`).

---

## J. Levels and alerts

### Security levels effective price

For `price_source != 'static'`, the effective price is computed from `ohlcv_bars` via
`resolveLevelPrice()` (`lib/alerts/resolve-level-price.ts`). It returns `null` when bars are
insufficient — it **never** falls back to the creation-time snapshot (which drifts). Callers filter
null; the UI renders "insufficient history". `findCrossedLevels` already does this.

### Levels-and-alerts dedup

Triggering flips `is_active=0` (primary dedup) + inserts an alert; `hasAlertToday` is the secondary
net for re-activation. `triggerLevel` returns a discriminated union
(`{ deduped: true, reason: "already_alerted_today" }`) so the UI surfaces it. Reactivate clears
`triggered_at` + flips `is_active=1`.

### Levels scan filter

`findCrossedLevels` + siblings (`getActiveLevelCountsForSecurityIds`, `getLevelsNearPrice`) use
`review_status = 'auto_approved'` as an **inclusive whitelist** (a blacklist lets `rejected` rows slip
through). Mirror the whitelist in any new scan query.

### Levels stale-price guard

`findCrossedLevels` skips securities whose latest price row is >4 calendar days old (tolerates
Fri→Mon + long-weekend Mondays; longer gaps mean TWS was offline and prices are suspect).

### Levels plausibility guard (2026-07-12)

A level >50% from the current price is a unit/scale error (SPX levels stored on SPY, per-contract vs
per-share), never a hit — the scan is a threshold test, so a mis-scaled level would sit permanently
"hit" and re-fire after every dismiss.

Three layers, one threshold:

1. `findCrossedLevels` skips (`LEVEL_PLAUSIBILITY_MAX_DISTANCE` in `lib/queries/security-levels.ts`),
2. the Worker `isLevelCrossed` mirrors it (`workers/cron/src/level-scan.ts` — **keep in sync**),
3. `isImplausibleLevelPrice` drops mis-scaled extractions at store time
   (`lib/alerts/extract-newsletter-levels.ts`).

**Options are exempt on the Mac paths** — premiums legitimately double/halve, so a real option hit CAN
first appear >50% past the level (earnings pop); the Worker needs no exemption because OCC symbols
never resolve on Yahoo. Never re-narrow the exemption or tighten the threshold without checking
overnight-gap math.

### Levels benchmark fallback

`findCrossedLevels` CTEs both `prices` and `benchmark_prices` (joined via `securities.symbol`) so
levels on DIA/VOO/other tracked-not-held index ETFs fire.

### Newsletter review gate

`extractLevelsFromArticle` stages levels with `review_status='pending_review'`; the user approves on
`/dashboard/levels/review` before they arm. User-created levels default to `auto_approved`.
`ReviewBell` polls the pending count.

---

## K. Imports: canonical CSV, PDFs, statements

### Canonical CSV examples live in THREE places that must stay in sync

`CanonicalCsvGuide.tsx` (Import-tab prompt generator), `docs/canonical-csv-guide.md` (reference), and
`tests/import/canonical-csv.test.ts` (fixtures).

Update **all three** whenever you add/edit a transaction-type example — a stray comma / missing
signed-amount rule each silently corrupted months of imports.

### Canonical-CSV amount is the SIGNED CASH EFFECT (statement-import era, 2026-04+)

- Negative: BUY / BUY_TO_OPEN / BUY_TO_CLOSE / BUY_TO_COVER, TAX_WITHHELD, FEE, COMMISSION,
  WITHDRAWAL.
- Positive: SELL*, DIVIDEND, INTEREST, DEPOSIT, REINVESTMENT.
- Sweeps signed by VMFXX direction.

Fixed in all 3 synced places 2026-07-04 (`fd4bd5c`) — the guide example previously showed BUY
positive, which is why Co-Work emitted wrong signs monthly.

**Pre-2026-04 historical-backfill rows are legacy-positive BY DESIGN** — never "fix" them;
era-filter any convention query (`trade_date >= '2026-04-01'`).

### Canonical-CSV numeric parsing goes through `parseStrictNumber()`

`lib/import/parsers/canonical-csv.ts` — returns NaN for any comma-bearing string; never `parseFloat()`
a CSV field directly (`parseFloat("1,234.56")` → `1`, silent truncation). The existing `isNaN()`
guards + `validate.ts` then skip-with-warning instead of committing wrong numbers.

### Canonical-CSV transaction `source_key` includes integer cents

`canonical:txn:{acct}:{sym}:{date}:{type}:{cents}` (cents = `Math.round(amount*100)`) disambiguates
same-day same-symbol same-type fills. Identical-amount rows (zero-amount gift/journal transfers) get
a stable `:#N` ordinal on the 2nd+ occurrence (the first keeps the bare key → idempotent re-import).

**Always include an amount-derived disambiguator on new parser `source_key`s.**

### Canonical-CSV quantity is always positive — type carries direction

The parser auto-normalizes negative quantities to `Math.abs()` with a warning (so signed-quantity
Co-Work output doesn't drop). New parsers should mirror this — type is the direction signal, not
quantity sign.

### Canonical-CSV cash-only rows use symbol `CASH`

WITHDRAWAL, DEPOSIT, FEE, COMMISSION, INTEREST rows with no associated security MUST emit symbol
`CASH` (the parser drops blank-symbol rows). The Co-Work prompt enforces this; manual CSV authors
must remember.

### Monthly statement imports run through the `/import-monthly-statements` skill

`.claude/skills/import-monthly-statements/SKILL.md` — replaces the Claude Co-Work PDF-deciphering
flow (2026-07-04). It carries: pdftotext + DB-context canonical CSVs + an authoritative sign-mapping
table + the **quarterly-statement rule** (Mar/Jun/Sep/Dec statements are quarter-to-date: activity is
month-only but the snapshot `starting_value` MUST come from the prior month's DB row, never the
quarter-start overview) + 6 penny-level gates + post-import reconciliation. IBKR stays on the native
`ibkr-activity` parser.

**Known traps the skill defends**: statement `402340.KS` vs DB `402340` (KRW) foreign-symbol
duplication (a USD-defaulted dup → native price valued as dollars), and canonical holdings imports
not triggering the closed-equity sweep (`HOLDINGS_SNAPSHOT_SOURCES` excludes `canonical-csv`).

**Vanguard expanded statement format (2026-07 onward)**: monthly statements now print cost basis +
EAI/EY on every holding (extract `cost_basis` monthly, skip EAI/EY sub-lines); total account value =
holdings + margin credit (margin credit lands in inferred cash at the anchor — a residual ≈ margin
credit is correct); and the counterparty-perspective "Sweep in/out" signs previously exclusive to
quarter-end now appear every month.

**Corporate-action rows use existing types**: SPLIT (post-split symbol + a qty-0 tombstone holdings
row for a split-replaced OPTION symbol — no purge covers those), EXERCISED (premium rolls into stock
basis via `computeTaxLots`), CUSIP-change pairs on an unchanged ticker are skipped.

Last-trading-day sales leave a stale same-day pre-sale Plaid holdings row the statement can't
overwrite (there's no holdings row for a fully-sold symbol) — check anchor-date inferred cash vs
margin credit (HUN 2026-07 precedent).

### PDF holdings extraction

PDF holdings extraction uses **focused extraction** (holdings-only, no transactions) with multi-attempt
retry — asking Claude to extract both in one call causes attention dilution on 28-page PDFs, missing
50–70% of holdings. See `extractHoldingsFromPdf()` in `vanguard-pdf.ts`.

---

## L. UI and frontend conventions

### Mutating button handlers must explain no-ops and failures

Check `res.ok` **AND** `data.success`. A zero-result success gets a domain-language explanation
("Nothing to classify — every held security and option underlying already has factor
classifications"), never a bare count. Don't close the drawer/modal before the outcome message is
readable; revert optimistic state on failure and say it was reverted; **no empty `catch {}`** — use
`useToast` (ToastProvider wraps the dashboard layout, available everywhere) or an inline `text-down`
line.

Swept across 15 components 2026-06-09 (`21bc5e8`); new buttons follow the pattern. See
`memory/feedback_honest_button_feedback.md`.

### Dashboard pages are force-dynamic

All 10 DB-loading `app/dashboard/**/page.tsx` export `const dynamic = "force-dynamic"` — this prevents
`next build` from opening `data/vanguard.db` during static collection (critical for worktree builds
where the main dev server holds the WAL lock). Zero perf cost (pages query the DB per request
anyway).

### `useCallback` render-loop trap

If a callback reads state but shouldn't depend on it, mirror the state to a `useRef` and read
`.current` inside — a state dep recreates the callback → retriggers a polling `useEffect` → request
storm (`DataConfidenceIndicator` hit ~300k requests/session). Check any `useCallback` whose body
reads state it also sets.

### Privacy-aware formatters

Never inline `${value.toFixed(2)}` for a **portfolio-derived** dollar/percent/share (gain/loss,
allocation %, totals, today's move) — use `<Money>` / `<Pct>` / `<Shares>` / `<Count>`
(`@/lib/privacy/components`); for Recharts use `usePrivateFormatter`.

**Public market data** (benchmark returns, public prices, macro actuals, reaction snapshots) stays
visible — use the pure `formatUSD` / `formatPercent` (`lib/format.ts`).

**Rule: if the number reveals what the user owns/earns, mask it.** Split visual (faint `$` glyph +
amber number): `<Money precise bare>`.

**AI-generated prose is a privacy blind spot by construction** — narrative/interpretation text embeds
portfolio figures at generation time, so no formatter can catch them; wrap the WHOLE prose block in
`<PrivateText>` at the render boundary (`NarrativeBlock` + the interpretation sentences are the
precedent; a chart-bar's WIDTH encoding a portfolio ratio is the same class — see `CoverageBar`). See
`memory/feedback_privacy_market_data.md`.

### Outbound-email position formatting (single source, DIRECTION-ONLY since 2026-08-02)

`lib/digest/presence-only-position.ts` (`formatPositionPresence` + `formatCombinedExposurePresence`)
— outbound emails have cc recipients, so in-app `PrivateText` masking does NOT apply, and anything in
the prompt is echoed verbatim by the model.

Render ownership disclosure with **no counts and no return %**: `long AAPL (vanguard taxable)` /
`short META (ibkr)` / `long AAPL $145 calls exp 2026-06-19 (ibkr)`; combined exposure is presence
flags (`long shares + short options`).

**Rationale (user #8, supersedes the 2026-05-12 %-returns-OK direction)**: every price is public, so
share/contract count × price reconstructs exact $ exposure — a count was never presence-only. Option
strike + expiry stay visible (public market data).

Never route `cost_basis` / `latest_price` / `quantity` magnitudes into prompts; briefing §7 also bans
share-count × close → notional, and the briefing `NET SHORT` marker is likewise number-free.

**Worker mirror**: `workers/cron/src/presence-position.ts` is a byte-parity hand-copy below
`OptionMeta` (a Next.js path-alias boundary, like `issuerSiblings`; pinned by
`workers/cron/test/presence-position.test.ts`) — the cloud `fallback-earnings.ts::renderPositions`
MUST use it, not hand-rolled `cost_basis.toFixed()` (the 2026-06-08 `9757bc0` leak: the later-written
Worker fallback re-introduced exact `$` into the cc'd email).

### Colored chips use `<Chip>`, not inline classes

`app/dashboard/components/Chip.tsx` is the single source for pills/badges. Tones
`up`/`down`/`gold`/`info`/`neutral`/`warn`; sizes `xs` (11px) / `sm` (12px). Always `font-medium`+,
`/20` tint minimum.

**Never** inline `bg-{color}/10 text-{color}` or `-tint`/`-glow` tokens for chip text (a
low-contrast pattern). See `memory/feedback_design_readability.md`.

### Hover-reveal affordances are touch tap-traps

An `opacity-0 group-hover:opacity-100` overlay button still RECEIVES taps (opacity doesn't affect
hit-testing) — on coarse pointers remove it (`pointer-coarse:hidden`) and pair an always-visible
affordance (`hidden pointer-coarse:inline-flex`), extending tiny targets via an `after:`
pseudo-element.

Precedent: `EarningsRowChips.tsx` PhaseChip (`26b566f` 2026-07-06 — a stray phone tap could silently
skip an earnings email). Audit grep: `opacity-0` near `onClick`. See
`memory/feedback_hover_reveal_touch_trap.md`.

### iPad tablet tier (2026-07-12)

The md→xl band (768–1279 — iPad 11″ portrait/landscape) has designed rules; spec
`docs/superpowers/specs/2026-07-12-ipad-parity-tablet-tier-design.md`, audit + verification record
`docs/superpowers/plans/2026-07-12-ipad-audit-inventory.md`.

1. **Touch hit-extension idiom** (~41 sites):
   `relative pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-['']`
   — the horizontal inset MUST be the narrow asymmetric form when an interactive neighbor sits within
   ~12px (a symmetric `-inset-2` out-paints a static neighbor and wins taps in the seam: a positioned
   `::after` beats in-flow content regardless of DOM order); symmetric `-inset-2` only with ≥12px
   clearance on both sides. New small buttons/chips follow this idiom.
   Two variants were added by the 2026-07-12 HIG remediation (`15095f4`): **`-inset-y-1.5` for links
   inside dense table rows** (`SymbolLink` — row pitch can be ~35px, so ±8px lets each row's link
   steal taps from its neighbors) and **`-inset-y-2 inset-x-0` for pill groups with 2px gaps** (chart
   timeframe/MA toggles — any horizontal extension overlaps the adjacent pill).
2. **Band variants only** (`md:max-lg:` / `md:max-xl:` / `lg:max-xl:`) for tablet layout tweaks —
   never change ≥1280 or <768.
3. **Global T4 rule** in `globals.css` forces 16px inputs under `(pointer: coarse)` (Safari auto-zoom
   kill) — never add an input whose layout assumes a smaller font on touch; full-height overlays use
   `dvh`, not `vh`.
4. Phase 4 real-device pass COMPLETE 2026-07-12 (all 6 checks passed in both orientations). The one
   on-device gap — compact Watchlist chart panels lacking Txns/S/R/MA toggles — was fixed
   (`5b9cad7`): pill groups un-gated from `!compact`, `showMarkers` defaults to `!compact` so grid
   panels start markerless while Security Detail keeps markers on, and the init-effect marker paint
   reads `showMarkersRef`, not a hardcoded `true`.

### Small-text contrast tokens (2026-07-12 HIG remediation, `15095f4`)

Text ≤17px needs 4.5:1 (WCAG AA / HIG); 18px+ or ≥14px-bold needs 3:1.

- Gold TEXT at small sizes uses `text-gold-ink` (light `#8a6508` ≈4.9:1 on cream; dark == `--gold`) —
  `text-gold` stays for accents, borders, fills, and large/bold text (`--gold` measures ~3.0:1 on
  cream).
- Warn chips/badges use the theme-aware `--warn` token (`bg-warn/20 text-warn` — light amber-800,
  dark amber-300), **never** raw `text-amber-*` (the fixed amber-300 measured 1.5:1 in light; it bit
  Chip / MorningBriefing / EventCard / TrustStripDrawer).
- Light `--up` is `#0a7d49` (deepened from `#0d9456` so small-regular gain figures pass).
- **Dark-module dim text floor is `#8a8a8a`** (`#555`/`#666`/`#777` all fail on near-black;
  decorative faint-`$` hero glyphs are exempt). Chrome in `SecurityChart` that renders in BOTH app
  themes opts in via `.chart-chrome`, recolored by the unlayered `.dark-module-chart .chart-chrome`
  rule scoped by MarketDataPanel's root class (a sibling of the `--scroll-fade-color` pattern) — pill
  buttons on light `bg-raised` groups inside the dark module deliberately do NOT opt in.
- **Multi-color chrome (2026-07-20)**: when dark-module chrome mixes several semantic colors (the
  OHLC crosshair legend: ink values + ink-faint labels + up/down close), a single-color
  `.chart-chrome` override can't cover it — the `.dark-module-chart .chart-legend` scope instead
  re-maps the underlying VARIABLES (`--ink` / `--ink-faint` / `--up` / `--down`) to dark-theme
  values; Tailwind utilities resolve `var(--color-*)` at use time, so everything inside re-colors
  with no specificity games. **Use the var-remap pattern for any future mixed-color dark-module
  chrome.**
- **App-wide small-text sweep completed 2026-07-20** (`cd93b5a`, 152 swaps) — remaining bare
  `text-gold` is intentional (large text, hover states via the `text-gold-ink hover:text-gold` idiom,
  icons/glyphs, opacity variants, dark-module contexts).
- **LevelsPanel renders EMBEDDED inside MarketDataPanel** (it inherits the dark background) — its
  gold must stay `text-gold`; never "sweep" it.
- An inline `style={{color}}` beats any class — grep for inline colors when a token swap doesn't take
  (it bit ChatInterface scope pills, `5806f21`).
- `globals.css` also carries a global `prefers-reduced-motion` quiet rule — JS-driven animations
  added later need their own reduced-motion check.

### Native `<dialog>` elements need `m-auto`

Tailwind v4's universal preflight margin reset (`*, ::before, ::after { margin: 0 }`) zeroes the UA
stylesheet's `dialog { margin: auto }` — without an explicit `m-auto`, a `showModal()` top-layer
dialog pins to the viewport's TOP-LEFT corner (it bit the shared `ConfirmDialog` for weeks as a
"recurring" QA finding; fixed 2026-07-21 `8521a72`).

Same cascade-layer family as the heading `text-wrap: balance` gotcha below. Any new `<dialog>`-based
modal must carry `m-auto` (or explicit positioning).

### Heading `whitespace-nowrap` needs the `!` modifier

`globals.css` has an UNLAYERED `h1,h2,h3,h4 { text-wrap: balance }` rule — unlayered CSS beats ANY
Tailwind layered utility (cascade layers), and `text-wrap`'s `text-wrap-mode: wrap` silently defeats
`white-space: nowrap`. Use `whitespace-nowrap!` on headings (precedent: the header wordmark,
`e9a0530`). The comment above the rule in `globals.css` documents this.

### `ScrollFade` is the overflow-affordance component and it now works

Repaired 2026-07-12 — it had been inert app-wide since `fb543a7`: it toggled `is-scrollable` on the
inner scroller while `.scroll-fade.is-scrollable::after` needs it on the wrapper.

Wrap any horizontally-scrollable table/toolbar in `<ScrollFade>`; the fade appears on genuine
overflow and clears at scroll-end. Dark-background containers must set `--scroll-fade-color` to their
own bg (precedent: `MarketDataPanel.tsx` sets `#0a0a0a`) or the gradient renders as a light smudge;
the fade widens 32→48px in the tablet band.

### Sortable table headers use `<SortableHeader>` + `useSortParam`

`app/dashboard/components/SortableHeader.tsx` + `lib/hooks/useSortParam.ts`: sort state lives in the
URL with a per-table scope (`?holdingsSort=…&holdingsDir=…`), **never component state**; tri-state
cycle asc→desc→cleared.

Card lists (Alerts, LevelsPanel) use `<SortPicker>` — same hook. `compareValues()` handles null-last +
case-insensitive + numeric. Terminal containers pass `variant="terminal"`.

### Terminal-aesthetic sections use `<TerminalSection>` + primitives

`app/dashboard/components/TerminalSection.tsx`: `<TerminalSection>` / `<TerminalTH>` /
`<TerminalTD>` / `<TerminalTag>` — the Tag is a filled/outlined block, **NOT** a rounded pill.

Dark palette: `#0d0d0d` container, `#1f1f1f` border, `#0a0a0a` headers, `#888` dim, `#ddd` body,
uppercase mono 11px micro-labels. Don't hand-roll the section chrome. It's the foundation for the
future light-app/dark-module theme. Topic: `memory/project_market_data_panel.md`.

### `MarketDataPanel` is the self-contained dark data module

`app/dashboard/components/MarketDataPanel.tsx`: a scoped dark container with its own CSS vars (NOT
global Tailwind tokens) so it stays dark under a light app theme. The hero uses `clamp()` + `rem`
(not `fontSize:"Npx"`).

Chart: current price solid amber `#ffb84d` 2px (the only amber element), active S/R solid 2px,
suggested S/R dotted 1px @50%; axis pills via `axisLabelColor` / `axisLabelTextColor`; no
`createPriceLine` titles (LevelsPanel carries the semantics).

### LightweightCharts v5 re-apply formatters on state change

`localization.priceFormatter` + series `priceFormat.formatter` are read at creation and only re-read
on `applyOptions`. Reactive state (e.g. `isPrivate`) needs an explicit `useEffect([state])` calling
`chart.applyOptions(...)` + `volumeSeries.applyOptions(...)` + re-rendering markers. Precedent:
`SecurityChart.tsx`.

---

## M. Electron and packaging

### `SettingsModal` is Electron-only

`if (!isElectron) return null` — it's invisible in a plain browser / `npm run dev` on :3000. Settings
file: `~/Library/Application Support/Vanguard Dashboard/settings.json` (hand-editable fallback).

### Electron env-var threading for new settings

A new `FOO_API_KEY` read via `process.env` needs **four touches** to reach the DMG:

1. `AppSettings` in `electron/settings-store.ts`
2. `bootstrapFromEnvLocal()` — now via the `ENV_TO_SETTING` table; add a
   `["FOO_API_KEY","fooApiKey"]` row
3. redacted `getSanitizedSettings()`
4. `env.FOO_API_KEY = settings.fooApiKey` in `electron/main.ts::startServer()`

Optional UI field in `SettingsModal.tsx`. Precedent: `pushoverAppToken` / `pushoverUserKey`.

**The DMG does NOT bundle `.env.local` (fixed 2026-06-16 `2dcd264`)** — `next build` copies it into
`.next/standalone` and the packaged server (cwd = `Resources/standalone`) would auto-load it,
shipping every secret; `electron:copy-static` `rm -f`s it + a `!.env*` electron-builder filter blocks
it.

So **settings.json injection is the ONLY runtime env source for the packaged app** — if you skip
touch (4), the key is silently absent in the DMG (it works in `npm run dev` because Next loads
`.env.local` there).

`bootstrapFromEnvLocal` runs every launch: first-run imports all mapped keys; an idempotent backfill
pass seeds any *empty* setting from the dev `~/code/vanguard-skin/.env.local` (never overwrites user
edits), so existing installs self-heal when new keys are added.
