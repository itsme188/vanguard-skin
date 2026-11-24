# Gains at risk: design

Date: 2026-11-24. Status: approved by the owner 2026-11-24, with the rulings in "Owner rulings" below. Every figure in this document is made up.

## Why

Late in a year, with a volatile market, the question at the desk is:

> If the market falls another 5% by year-end, how much of this year's gain do I give back? And what would change that?

The app answers pieces of this in three places with three bases. Defense prints a hedge ratio at today's delta. Diagnostics prints net and gross exposure. Scenarios prints a dollar loss for one shock with no date. None shows what the hedges do as the market keeps falling, none is measured against the year's gain, and none lets the owner try a hedge before trading it.

Three hypothetical cases the page must serve:

1. A book is short one stock with no cover. What does buying a call do, and how do strike and expiry change that?
2. A book is long several large index constituents and holds one index put. How much does the put protect, and what would protect more?
3. An index falls X% by a date. How much does the book lose?

All three are one question: move a driver, on a date, reprice the book, and compare the result with and without a hedge.

## Goals

- One page that shows, for a chosen driver and date, the book's profit or loss across a range of driver moves, with the offsetting positions and without them.
- The headline unit is the share of the year's dollar gain given back.
- Let the owner add a trial hedge and see the line move, with its cost, before trading.
- Lay candidate hedges side by side so the owner can compare strike and expiry.
- Say plainly what the page could not model.

## Non-goals

- No recommendation of what to buy. The page compares; the owner decides. A ranking by a rule the owner sets (for example lowest cost for a given loss cap) is allowed in step 3; a "best hedge" label is not.
- No order entry.
- No change to Defense, Diagnostics, Scenarios or What-if. They keep their figures.
- No email, push, Worker mirror or cloud snapshot field. The page is Mac-only.
- No AI call.
- A chat tool over the same engine is a later add-on, not part of this design.

## Anti-goals

These make the page a failure even if it works:

- A figure built on a made-up input: a default volatility, an assumed option price, a fixed beta presented as measured.
- A position silently left out. Anything not modelled is listed and counted, with its share of the book.
- A loss that reads smaller than it is because a hedge was credited on thin evidence.
- A "gain given back" ratio printed when the year's gain is zero or negative.

## Approaches considered

**A. One new Analysis view, "Gains at risk" (chosen by the owner, 2026-11-24).** One engine, one screen, three build steps.

**B. Extend the three existing pages.** A date and an index on Scenarios, a loss figure on What-if, a line on Defense. Less new screen work, but the answer stays split over three pages, which is the problem.

**C. A chat tool only.** Quick, and good for one-off questions. No line, nothing to glance at each morning. It can be added later over A's engine.

## The screen

```
Gains at risk                         Stress scope: All   Positions as of Nov 24
Year's gain so far   $400,000         If [QQQ v] moves, by [Dec 31]   Vol change [0] pts

 gain kept
 100% |                          o======  book
  75% |                  o=======
  50% |          o=======        - - - -  without the offsetting positions
  25% |   o======    - - - - - - -
      +---+------+-------+-------+----
        -15%   -10%     -5%      0%     QQQ

 QQQ move   Longs lose   Offsets give back   Book      Gain given back
   0%         -$2,000         -$3,000        -$5,000         1%
  -5%        -$70,000         +$9,000       -$61,000        15%
 -10%       -$140,000        +$31,000      -$109,000        27%
 -15%       -$210,000        +$62,000      -$148,000        37%
 Custom [ -7 ]%

 What moves the result: per-name table (move assumed, beta and its source, P&L at the selected row)
 Not modelled: 2 options (no volatility source), 1 leveraged fund. 3% of the book.
 Beta estimated, not measured: 4 names, 18% of the book.
                                                             [ Try a hedge ]
```

Notes:

- The 0% row is not zero when the date is in the future: long options lose time value. That row is the cost of waiting.
- The y axis is profit or loss in dollars; the right-hand reading is the share of the year's gain kept. When the year's gain is zero or negative the share column and axis are not shown and a line says why.
- Dollar and percent figures render through `lib/privacy/components.tsx` (`<Money>`, `<Pct>`, `<Count>`; chart axes through `usePrivateFormatter`).
- The freshness line reads `getPositionsFreshness` with the words in `lib/ui/positions-freshness-label.ts`.

## The engine

New pure module `lib/compute/gains-at-risk.ts`, called by a thin route `POST /api/compute/gains-at-risk` (scope resolved with `resolveScope`; envelope `{success, data}`), and by the server view for its first paint.

Inputs: scope accounts, driver symbol, valuation date, the list of driver moves, volatility change in points, optional trial legs (step 2).

For each position and each driver move:

1. **Position set and values.** The same rows the custom scenario engine loads (`lib/compute/scenarios.ts`): latest holdings per account and security with shorts, live options only, FX to USD. The builder should share that query, not copy it.
2. **The position's own move.** `driver move x beta to the driver`.
   - Beta comes from a measured regression against the driver (`computeSecurityRegression`, cached in `security_regressions`, benchmarks SPY, QQQ, VTI) when it passes `regressionBetaVerdict`.
   - Otherwise the heuristic the Scenarios page already uses (`estimateBeta`), flagged "estimated". The page counts these and shows their share of the book.
   - An option takes its underlying's identity and beta (`equityIdentity`).
   - When no regression against the driver passes the gate, the fallback is a beta to the broad market converted to the driver: the name's measured SPY beta (or, failing that, the `estimateBeta` heuristic, which is a beta to the broad market, not to the driver) divided by the driver's own measured SPY beta. Either fallback is flagged "estimated".
   - A leveraged or inverse fund, and any option on it, never uses its own regression: its measured beta already contains the leverage, and multiplying by the stored factor would count it twice. It moves at the tracked index's move times its signed factor (`resolveLeveragedExposure`), where the tracked index's move is that index's beta to the driver times the driver move (1 when the index is the driver). A flagged fund with no factor is not modelled and listed.
   - Cash-equivalent funds, bonds and bond funds follow the custom scenario engine's existing rules.
   - Pre-check before step 1 lands (required): confirm, read-only, that the price series the regressions read are dated on the right session for Plaid-fed securities. A series dated a session late pulls beta toward zero and shrinks the loss. If any is misdated, that security's regression is not used and it takes the flagged fallback.
   - The driver itself, held as shares or through options, has beta 1 by definition.
3. **Stocks and funds.** Value change = market value x own move. No time effect.
4. **Options.** Reprice at the valuation date:
   - Solve the volatility today, from the option's own price, falling back to the broker's volatility for the underlying, exactly as `repriceOptionUnderShock` does now.
   - Value today `v0` at today's time to expiry. Value at the date `v1` with the underlying moved, the volatility changed by the input, and the time to expiry counted from the valuation date.
   - If the contract expires before the valuation date, the page cannot know whether the move comes before or after it lapses. It takes the cautious case: the contract is valued at its intrinsic value at today's underlying price (the move is assumed to come after it has gone), and the page lists it as "expires before the date" with its expiry, so the owner can set the date to that expiry and see the other case. A contract that expires on the valuation date is worth its intrinsic value at the moved price.
   - This needs one new optional field on `OptionRepriceShock` (a valuation date). With the field absent the function returns byte-identical results; that is pinned by a test.
5. **An option with no price.** Today the scenario engines refuse it ("no-option-price") and its change is zero. That is wrong for this page: the unpriced options the daily Vanguard sync carries include the very hedges the owner is asking about. Proposal:
   - When the option has no price but the underlying has a price and the broker's volatility for the underlying is on file, compute both `v0` and `v1` from the model and use the difference as the change. The row is flagged "priced from model" and counted on the page.
   - With no broker volatility on file the option is not modelled and listed. The default volatility constant (`DEFAULT_FALLBACK_VOL`) is never used here.
   - Such a row has a stored market value of zero, so its dollar change cannot come from `changePercent x market value`. It is computed directly: per-share change x quantity x multiplier x FX. Its share of the book, and its side of the offsetting split, come from its model value and model delta, never from the zero.
   - The existing scenario engines are not changed by this.
6. **Totals per move.** Book P&L = the sum of the position changes. Conservation is a named test (below).

### "Offsetting positions"

The second line and the "Offsets give back" column need a split of the book into what loses and what offsets. Defense has no reusable "is a hedge" test; its classification depends on pairing rules. Proposal (my call): on this page a position is **offsetting** when its exposure to the driver is negative at today's prices (its P&L rises when the driver falls by a small step). Long puts, short shares, inverse funds, written calls and short positions in driver-linked names all qualify. The split is fixed once per run, so the two lines stay consistent across the sweep. The page words it as "offsetting positions", never "hedges", so it is not read as Defense's credited-hedge list.

The split follows the direction being looked at. For a fall in the driver, offsetting means negative exposure to it. For a rise (the short-stock case), it is the reverse: the positions that lose are those with negative exposure, and the offsets are those with positive exposure. The column headings read "Positions that lose" and "Offsets give back" in both directions.

### The year's gain

The app has no function that returns a scope's year-to-date gain in dollars. New function, in `lib/compute/`:

`gain = value now - value at the base session - net external flows since the base session`

- Value now: `getPortfolioCurrentValues(...).totalValue` for the scope (net worth, the same base as the exposure badge). That reader picks an as-of date per account.
- Base value: each account's statement total for Dec 31 of the prior year (the statement is the authority; a computed daily row is not used). This needs a small new lookup; `baseSessionOnOrBefore` reads benchmark dates and is not it.
- Flows: `fetchNetFlowsByDate` per account, from Jan 1 to that account's own as-of date, with in-kind transfers at their stored fair value.
- If the Dec 31 statement total is missing for any account in the scope, no gain is printed and the page says which account.
- Reconciliation, shown as a small line: through the last statement month-end, the figure is compared with the sum of `computeMonthlyPerformance`'s `gainLoss` for the year's months. The two use different sources (that reader can use a statement's own deposit total and returns no figure for some months), so on real data they can differ for sound reasons. The line reads "agrees with the statements through <month>", or shows the difference, or "not checked" when any month has no figure. The page's figure is the one used either way. Exact equality is pinned only on a synthetic book where every month has a figure.

The page only says "Year's gain so far" and never says what the figure is used for.

### Single-name driver (step 3)

When the driver is a stock (case 1): the stock and every option on it move by the driver move. Every other position is held flat (my call: a one-stock jump is the owner's question; a market link would hide it). The page says "other positions held unchanged".

A single name can jump far more than an index, and for a short the risk is a rise. In this mode the sweep is symmetric and wide (suggested -40% to +40%, owner-adjustable), the split follows the direction as described above, and the headline is the dollar loss at the selected move; the share-of-gain column still shows when the year's gain is positive.

## Trial hedges (step 2)

"Try a hedge" opens a small form: underlying, put or call, buy or sell, strike, expiry, contracts, and the price per share. Shares of a stock or fund are also allowed (symbol, buy or sell, quantity).

- The typed price is the cost. The leg's volatility is solved from that price; if it cannot be solved (price below intrinsic), the form says so and the leg is not added.
- The leg's P&L at each move is its value at the date minus the price paid, times the multiplier and contracts. The premium is therefore inside the line: the chart shows the book with the trial hedge, net of its cost, against the book as it is.
- The page shows the cost as its own figure and as a share of the year's gain.
- Trial legs live in page state only. Nothing is stored; no schema change.
- Editing or removing a leg clears the old result before the new one arrives, and a result for an older set of legs is never shown (the What-if stale-result lesson, 2026-11-24).

## Candidate comparison (step 3)

For a chosen underlying, fetch the chain from TWS (`GET /api/tws/option-chain`, structure only) and then quotes for a small, capped set of contracts with the snapshot pattern in `lib/tws/atm-straddle.ts`.

- The owner picks the expiries (up to three) and how far from the money (a handful of strikes); the page never requests the whole chain.
- Each candidate is a row: strike, expiry, mid price, cost for the number of contracts, the book's loss at the selected move with it, the 0% row with it (cost of waiting), and the move at which it starts to pay for itself.
- Needs TWS connected. When it is not, the section says so and the owner can still type a price by hand in the step 2 form.
- A candidate with no two-sided quote is listed as "no quote" and never priced from a model. The snapshot pattern accepts delayed and frozen ticks; a candidate priced from one is shown with a "delayed" or "frozen" label beside its price, never as a live mid.
- Optional sort by a rule the owner sets. No "best" label.
- The quote is public market data and is formatted plainly; the cost in the owner's size is portfolio-derived and goes through `<Money>`.

## Build steps

1. **The line and the table.** Engine, year's gain, time-aware repricing, the view (`view=gains` registered in `lib/analysis/view-param.ts`, the Analysis page, the view toggle and the nav dropdown), index drivers SPY, QQQ, VTI. Answers case 3 and most of case 2.
2. **Try a hedge.** Trial legs, cost, the stale-result guard. Answers the rest of case 2.
3. **Candidates and the single-name driver.** TWS chain and quotes, comparison table. Answers case 1.

Each step is deployable alone.

## Constraints from the repo

- Read-only over the database. No migration in any step.
- Scope rules: `undefined` is every account, an empty list is none; the page resolves the scope once (`resolveAnalysisScope`, default Vanguard) and every request carries it.
- Option expiry only through `lib/compute/option-expiry.ts`; "today" through `todayET()`.
- Risk-free rate through `getRiskFreeRate(db)`.
- No third-party price source for a held security. Step 3 quotes come from the broker (TWS) only.
- A mutating handler is not involved; the route is a pure compute POST.
- The server page must not import a function from a `"use client"` file.
- Tests use synthetic positions only. No real figure in any committed file.

## Tests that must exist (named requirements)

- **Conservation:** for every move, book P&L equals the sum of the position rows, and equals "longs lose" plus "offsets give back", to the cent.
- **Identity at rest:** a 0% move with the valuation date today and no volatility change gives zero for every position.
- **Time decay:** a 0% move at a later date gives a loss on a long option and a gain on a written one, and nothing on a stock.
- **Expiry before the date:** the option is worth its intrinsic value at today's underlying price and is listed; on the date itself, intrinsic at the moved price.
- **Leveraged fund:** a 3x fund on the driver moves three times the driver, not nine; an inverse fund moves against it.
- **Direction:** for an upward sweep a short stock is on the losing side and a bought call on the offsetting side.
- **Back-compatibility:** `repriceOptionUnderShock` without the new field is unchanged (existing scenario tests stay green, plus one pin).
- **Unpriced option:** modelled from the broker volatility and flagged; with no volatility it is listed and contributes zero; the default volatility is never read.
- **Beta source:** a measured regression is used when it passes the gate; otherwise the estimate, flagged and counted.
- **Year's gain:** equals the sum of the monthly gain figures through the last statement month-end; prints nothing when the base value is missing; no ratio when the gain is not positive.
- **Trial leg:** premium is inside the P&L; an unsolvable price is refused; a stale result is never shown.
- **Empty scope** reads nothing.
- A browser pass on a sandbox copy for each step, as the repo requires.

## Known limits, stated on the page or in the decision entry

- A stock's move is its beta times the driver's move. In a real selloff names can fall more than that, or alone. The per-name table shows the assumed move so the owner can see it.
- Volatility usually rises in a selloff. The default volatility change is zero, which understates what long puts give back; the control lets the owner set it.
- Vanguard daily values lag by one session until the Plaid session-dating fix lands, so "value now" and the year's gain can be a session old. The freshness line shows the positions date.
- The model is Black-Scholes with one volatility per contract, floored at intrinsic value as the existing repricer does, and no dividends.

## Left to the builder

- How the scenario engine's position query is shared with the new engine.
- The sweep's range and step (suggested -20% to +10% in 2.5% steps), and the fixed table rows.
- Chart details (Recharts, as the other Analysis views).
- Whether regressions are read from the cache only or computed on demand when the day's row is missing (computing on demand reads only).
- File layout for the view's components.

## Owner rulings (2026-11-24)

1. **The year's gain is measured on every account** (the three accounts together), whatever scope is being stressed. The headline figure and the "gain given back" ratio always use it. The stress scope stays selectable; this page's default scope is "all", stated here as a deliberate exception to the Analysis default.
2. **The page never names what the figure is for.** It says "year's gain so far" and nothing more.
3. **Money moved out of an account is a withdrawal, wherever it went.** A transfer from the brokerage account to another account the app does not hold is an external flow out: it is not a loss, and nothing that happens to it afterwards counts. The ledger already books such a transfer as an external withdrawal; the year's-gain function must keep reading it so, and a test pins it with a synthetic internal-transfer row.
4. **The brokerage account must be shown to be right before its figure is trusted.** Required pre-check before step 1 lands, read-only: the account's year's gain as the app computes it is compared with the broker's own figures for the same period (opening value, closing value, deposits and withdrawals), and every difference is explained. The positions-freshness line is shown beside the headline, because that account's positions can be days old.
5. **An unpriced option is priced by the model, flagged, and can be overwritten.** Each "priced from model" row shows its model price with an edit box (`<PrivateNumberInput>`). A typed price replaces the model price for that contract: it becomes the option's own price, its volatility is solved from it as for any priced option, and the row's flag changes to "your price". A price the model cannot accept (below intrinsic value) is refused with a sentence. The typed price lives in page state only and is not stored; storing a hand-entered price would be a separate change with its own design.
6. **Approved as proposed:** "offsetting positions" by direction of exposure; the flagged beta fallback for names with no measured beta.
