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

1. **Position set and values.** The same rows the custom scenario engine loads (`lib/compute/scenarios.ts`): latest holdings per account and security with shorts, live options only, FX to USD. The builder should share that query, not copy it. The shared loader returns every held position, a non-option with no price included, and this page reads it per account (rulings F10, F11).
2. **The position's own move.** `driver move x beta to the driver`.
   - Beta comes from a measured regression against the driver (`computeSecurityRegression`, cached in `security_regressions`, benchmarks SPY, QQQ, VTI) when it passes `regressionBetaVerdict`.
   - Otherwise the heuristic the Scenarios page already uses (`estimateBeta`), flagged "estimated". The page counts these and shows their share of the book.
   - An option takes its underlying's identity and beta (`equityIdentity`).
   - When no regression against the driver passes the gate, the fallback is a beta to the broad market converted to the driver: the name's measured SPY beta (or, failing that, the `estimateBeta` heuristic, which is a beta to the broad market, not to the driver) divided by the driver's own SPY beta, measured benchmark to benchmark from `benchmark_prices`. Either fallback is flagged "estimated". When the driver's SPY beta cannot be measured or is not usable as a divisor, there is no conversion: the name is not modelled and listed, never divided by 1 (ruling F6).
   - A leveraged or inverse fund, and any option on it, never uses its own regression: its measured beta already contains the leverage, and multiplying by the stored factor would count it twice. It moves at the tracked index's move times its signed factor (`resolveLeveragedExposure`), where the tracked index's move is that index's beta to the driver times the driver move (1 when the index is the driver). The tracked index comes from a hand-checked seed (ruling F5). A flagged fund with no factor, or with no known tracked index, or whose tracked index has no benchmark history to measure against the driver, is not modelled and listed.
   - Cash-equivalent funds, bonds and bond funds follow the custom scenario engine's existing rules.
   - Price dating (ruling F8/F9): a measured beta is built only from correctly dated price rows. Rows the Plaid sync wrote (`prices.source = 'plaid'`) are left out of the series; too few remaining pairs fails the gate and the name takes the flagged fallback. A series dated a session late pulls beta toward zero and shrinks the loss. A one-off read-only audit records the evidence for this rule; "insufficient evidence" is its own outcome, not a pass.
   - The driver itself, held as shares or through options, has beta 1 by definition, including an option whose underlying has no securities row (its stored underlying symbol decides, ruling F7).
3. **Stocks and funds.** Value change = market value x own move. No time effect.
4. **Options.** Reprice at the valuation date:
   - Solve the volatility today, from the option's own price, falling back to the broker's volatility for the underlying, exactly as `repriceOptionUnderShock` does now.
   - Value today `v0` at today's time to expiry. Value at the date `v1` with the underlying moved, the volatility changed by the input, and the time to expiry counted from the valuation date.
   - Timing (ruling F16): a valuation date of today means the current instant, so a 0% move with no volatility change is exactly zero. A later date means the close of that day.
   - If the contract expires before the valuation date, the page cannot know whether the move comes before or after it lapses. It takes, per position, the worse case for the owner of the two (intrinsic value at today's underlying price, or intrinsic value at the moved price), signed by quantity, so neither a long nor a written contract is flattered (ruling F4). The page lists it as "expires before the date" with its expiry, so the owner can set the date to that expiry. A contract that expires on a later valuation date is worth its intrinsic value at the moved price.
   - This needs new optional fields on `OptionRepriceShock` (a valuation date, and model pricing for an unpriced contract). With neither passed the function returns exactly the legacy result object; that is pinned by a test (ruling F17).
5. **An option with no price.** Today the scenario engines refuse it ("no-option-price") and its change is zero. That is wrong for this page: the unpriced options the daily Vanguard sync carries include the very hedges the owner is asking about. Proposal:
   - When the option has no price but the underlying has a price and the broker's volatility for the underlying is on file, compute both `v0` and `v1` from the model and use the difference as the change. The row is flagged "priced from model" and counted on the page.
   - With no broker volatility on file the option is not modelled and listed, with its value reported as unknown, never as a 0% share (ruling F12). The default volatility constant (`DEFAULT_FALLBACK_VOL`) is never used here.
   - Such a row has a stored market value of zero, so its dollar change cannot come from `changePercent x market value`. It is computed directly: per-share change x quantity x multiplier x FX. Its share of the book, and its side of the offsetting split, come from its model value and model delta, never from the zero.
   - The existing scenario engines are not changed by this.
6. **Totals per move.** Book P&L = the sum of the position changes. Conservation is a named test (below).

### "Offsetting positions"

The second line and the "Offsets give back" column need a split of the book into what loses and what offsets. Defense has no reusable "is a hedge" test; its classification depends on pairing rules. Proposal (my call): on this page a position is **offsetting** when its exposure to the driver is negative at today's prices (its P&L rises when the driver falls by a small step). Long puts, short shares, inverse funds, written calls and short positions in driver-linked names all qualify. The split is fixed once per run, so the two lines stay consistent across the sweep. The page words it as "offsetting positions", never "hedges", so it is not read as Defense's credited-hedge list.

The split follows the direction being looked at. For a fall in the driver, offsetting means negative exposure to it. For a rise (the short-stock case), it is the reverse: the positions that lose are those with negative exposure, and the offsets are those with positive exposure. The column headings read "Positions that lose" and "Offsets give back" in both directions.

Step 1 shows one direction, down (ruling F15): the split is the down split, the table shows the zero and negative rows plus a custom row that must be zero or negative, and the chart may extend to positive moves with its second line still on the down split. Step 3 adds the direction control that the rise case needs.

### The year's gain

The app has no function that returns a scope's year-to-date gain in dollars. New function, in `lib/compute/`:

`gain = value now - value at the base session - net external flows since the base session`

- Value now: `getPortfolioCurrentValues(...).totalValue` for the scope (net worth, the same base as the exposure badge). That reader picks an as-of date per account.
- Base value: each account's statement total for Dec 31 of the prior year (the statement is the authority; a computed daily row is not used). This needs a small new lookup; `baseSessionOnOrBefore` reads benchmark dates and is not it.
- Flows: net external flows per account, from Jan 1 to that account's own as-of date, with in-kind transfers at their stored fair value, read in dollars through the one currency rule (`lib/queries/transaction-amount-currency.ts`): a native in-kind leg is converted, a USD-stored row is not converted twice (ruling F1). `fetchNetFlowsByDate` stays as it is for its existing callers.
- If the Dec 31 statement total is missing for any account in the scope, or an account's current value is missing or dated before Jan 1, or a flow cannot be converted, no gain is printed and the page says which account (ruling F3).
- Reconciliation, shown as a small line: through the last statement month-end, the figure is compared with the sum of `computeMonthlyPerformance`'s `gainLoss` for the year's months. The two use different sources (that reader can use a statement's own deposit total and returns no figure for some months), so on real data they can differ for sound reasons. The line reads "agrees with the statements through <month>", or shows the difference, or "not checked" when any month has no figure. The page's dollar figure is the one shown either way; when the line reads a difference beyond the $1 tolerance, no "gain given back" ratio is printed (ruling F2). Exact equality is pinned only on a synthetic book where every month has a figure.

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
- Whether regressions are read from the cache only or computed on demand when the day's row is missing (computing on demand reads only). Settled in the plan: the cache is read only when it is at most 7 days old and the security has no Plaid-sourced price in the window; otherwise the regression is computed on demand and nothing is written.
- File layout for the view's components.

## Owner rulings (2026-11-24)

1. **The year's gain is measured on every account** (the three accounts together), whatever scope is being stressed. The headline figure and the "gain given back" ratio always use it. The stress scope stays selectable; this page's default scope is "all", stated here as a deliberate exception to the Analysis default.
2. **The page never names what the figure is for.** It says "year's gain so far" and nothing more.
3. **Money moved out of an account is a withdrawal, wherever it went.** A transfer from the brokerage account to another account the app does not hold is an external flow out: it is not a loss, and nothing that happens to it afterwards counts. The ledger already books such a transfer as an external withdrawal; the year's-gain function must keep reading it so, and a test pins it with a synthetic internal-transfer row.
4. **The brokerage account must be shown to be right before its figure is trusted.** Required pre-check before step 1 lands, read-only: the account's year's gain as the app computes it is compared with the broker's own figures for the same period (opening value, closing value, deposits and withdrawals), and every difference is explained. The positions-freshness line is shown beside the headline, because that account's positions can be days old.
5. **An unpriced option is priced by the model, flagged, and can be overwritten.** Each "priced from model" row shows its model price with an edit box (`<PrivateNumberInput>`). A typed price replaces the model price for that contract: it becomes the option's own price, its volatility is solved from it as for any priced option, and the row's flag changes to "your price". A price the model cannot accept (below intrinsic value) is refused with a sentence. The typed price lives in page state only and is not stored; storing a hand-entered price would be a separate change with its own design.
6. **Approved as proposed:** "offsetting positions" by direction of exposure; the flagged beta fallback for names with no measured beta.

## Rulings after the plan review (2026-11-24)

Made by the controller on the owner's delegation, after an independent review of the step 1 plan. Where these differ from the text above, these win.

- **F1 Flows in dollars.** The year's gain reads flows through the one currency rule (`lib/queries/transaction-amount-currency.ts`): a native in-kind leg is converted, a USD-stored row is not converted twice. `fetchNetFlowsByDate` is unchanged for its callers; a sibling reader is added and pinned by a foreign-currency in-kind test.
- **F2 Statement authority.** When the reconciliation reads "differs" beyond the $1 tolerance, the page shows the dollar gain with the difference beside it and prints no "gain given back" ratio, with a line saying why. "Not checked" keeps the ratio with a note.
- **F3 Current value.** An account whose current value is missing, or dated before Jan 1 of the year, makes the gain unavailable, with that account named.
- **F4 Expiry before the date.** Per position, the worse case for the owner of the two (intrinsic at today's underlying price, intrinsic at the moved price), signed by quantity. Still listed as "expires before the date".
- **F5 Tracked index.** A hand-checked seed of tracked index symbols, kept as a code constant beside the leverage-factor seeds (no migration). A flagged fund with a factor but no known tracked index is not modelled and listed; there is no heuristic stand-in. A tracked index other than the driver gets its beta to the driver from benchmark-to-benchmark history only when that index is in `benchmark_prices`; otherwise not modelled.
- **F6 Driver market beta.** Measured benchmark to benchmark from `benchmark_prices`, independent of holdings. If it cannot be measured, or is not usable as a divisor (not finite, or absolute value under 0.2), there is no conversion: the names needing it are not modelled and listed, never divided by 1.
- **F7 Option on an absent underlying row.** The loader keeps the contract's stored underlying symbol; an option whose stored underlying symbol is the driver has beta 1 even with no underlying securities row. Tested through the real loader.
- **F8/F9 Price dating.** No private exclusion list. A measured beta is built only from correctly dated rows: rows the Plaid sync wrote (`prices.source = 'plaid'`) are left out of the series, and too few remaining pairs falls to the flagged fallback. `computeSecurityRegression` gains an optional source filter that defaults to today's behaviour. The read-only audit stays, as evidence for the decision entry, with "insufficient evidence" as its own outcome.
- **F10 Complete loader.** The shared loader returns every held position, a non-option with no positive price included; the old price filter moves to the custom scenario engine's side so its output stays pinned. This page lists unpriced non-options as not modelled.
- **F11 Gross book.** Gross value and counts are taken per account before netting by security.
- **F12 Unknown value.** A position whose value is unknown is reported under its own count with "share not known", never as 0%.
- **F13 Override.** A typed price is accepted only when the volatility solves from it and round-trips under the repricer's own test; otherwise it is refused as not solvable and the model price stays. An upper-bound case is tested.
- **F14 Freshness.** The response and the page carry freshness for every account beside the year's gain, with each account's value date, and separately for the stress scope beside the line.
- **F15 Direction.** Step 1 shows one direction, down. The split is the down split. The table shows zero and negative rows plus a custom row that must be zero or negative; the chart may extend to positive moves with its second line on the down split. Step 3 adds the direction control.
- **F16 Timing.** A valuation date of today means the current instant (the identity at rest holds); a later date means the close of that day.
- **F17 Legacy shape.** With neither new repricing option passed, the result object is exactly the legacy shape, and the pin compares whole objects.
- **F18 Scope.** The route accepts only the four scope tokens (anything else is refused), and a token matching no account gives an empty result, never every account. `resolveScope` itself is unchanged.
- **F19 Tests.** Deterministic tests for stale-response rejection (a pure reducer with request sequence numbers), cache freshness boundaries with fixtures dated after the regression engine cutoff, missing FX, and "reads nothing" for an empty scope.
- **F20 Ownership.** Implementer agents never run git; the controller commits each task with pathspecs after reviewing it, and the full suite runs once all three parallel tasks are in, before the engine task starts. Every new file belongs to exactly one task.

## Rulings after the first run on real data (2026-11-24)

Made by the owner and the controller after a read-only run of the step 1 engine on the real book showed the measured betas were not usable. These win over every earlier section, the plan-review rulings included. Implementation: `docs/superpowers/plans/2026-11-24-gains-at-risk-step1-addendum-betas.md`.

What the run found: the `prices` rows a TWS sync writes are snapshots taken when the sync runs, stamped with that day's date (some are mid-session prices, some are the previous session's close stamped today, and some sessions are missing), so a regression of them against true closes understates beta and fit. The daily bars in `ohlcv_bars` are true closes but exist only for securities someone opened on the Charts page. The estimated fallback covered about half the book and disagreed with the measured data. One unrecorded split in a `prices` series produced a beta near 5 from a single pair.

- **B1 Measured from true daily closes.** A measured beta for this engine comes from the security's daily bars in `ohlcv_bars` (`bar_size = '1 day'`, priced bars only) against the driver's own daily bars in `ohlcv_bars` (C3; never `benchmark_prices`), over 730 calendar days, daily log returns, with the existing 7-day gap guard, and only on days before today. A `prices` row is never used for it. "Measured" needs at least 60 return pairs and r-squared of at least 0.10. The existing `computeSecurityRegression`, its callers and the `security_regressions` cache are unchanged; this engine neither reads nor writes that cache, and memoizes within one request only.
- **B2 Outlier guard.** A return pair is dropped when the security's daily log return differs from the driver's same-day log return by more than 0.35 in size. An unrecorded split (a 3:1 split is a log move of about 1.10) is dropped when nothing else moved the security that day, even on a day the market moves a lot; a crash day on which both fall together is kept. It is not a guarantee: a split on a day the security also moved a lot against the driver can partly cancel and pass (C14). The count of dropped pairs is reported. The shared split guard elsewhere in the app is not changed.
- **B3 No estimate.** The "market-converted" and "estimated" rungs are removed. The ladder is: the driver itself (1); fixed rows (cash-equivalent, bond, bond fund, as before); a leveraged or inverse fund (unchanged rule and refusals); measured from daily closes (B1); otherwise "no measured link", with the reason (no daily bars, short history, low fit). An index mutual fund with no bars has no measured link.
- **B4 Two cases.** Every result carries both:
  - **Measured:** each name at its measured beta; for a name with no measured link the underlying is held unchanged and listed with its share of the book. A stock or fund row then has no P&L; an option on it is still repriced for time to the date, the volatility change and expiry (C5).
  - **Selloff case (an assumption, never a measurement):** the owner's premise that in a selloff names fall together. Every equity-like position (stock, ETF, mutual fund, and options through their underlying; never cash-equivalents, bonds or bond funds) moves at least one-for-one with the driver: beta is the larger of its measured beta and 1. A negative measured beta is floored at 1 too (an inverse relationship in calm data is not evidence of protection in a selloff). A name with no measured link takes 1. A leveraged or inverse fund keeps its rule, with the tracked index's own beta to the driver floored at 1, so an inverse fund still offsets.
  - **The owner's figure:** the owner may type, per name, how much it moves per unit of driver move (between -5 and 5). That figure is used in both cases, shown as "your figure", and options on the name follow. It lives in page state only and is never stored. Reason given by the owner: a large stock can hold up when the driver's theme sells off, so a blanket floor of 1 can overstate its fall.
  - Conservation, the side split (losing or offsetting) and the disclosures are computed per case.
- **B5 Daily-bar capture.** The sync pipeline gains a capped, resumable step that fetches two years of regular-hours daily trade bars from TWS for every held security and every option underlying (not options, bonds or cash-equivalents) through the existing bar fetcher, writer and rate limiter. It takes the stalest first, at most 20 per batch and one batch per 25 minutes (C8), refetches a trailing overlap on every capture and treats a security as done only after this process captured it today (C1, C9), never stores a bar for today or for a closed market day, runs only while TWS is connected, and never fails or delays the sync. A one-shot backfill script, dry-run by default, does the first fill. No third-party price source and no schema change.
- **B6 The page.** A case switch ("Measured" / "Selloff case"), default Measured. The chart can show the book in both cases, plus the line without offsetting positions for the selected case. The table follows the selected case. The per-name table shows each name's measured beta, its source and number of pairs, and an edit box for the owner's figure. The "beta estimated" line becomes "no measured link", with count, share of book and reasons. A caption states which closes the betas come from, through what date, and how many names still wait for daily bars.
- **B7 Out of scope (follow-ups):** the sync writers that stamp the previous session's close with today's date (also read by Defense, Significant Moves and the security regression card); the missing split record for one sector ETF (a data repair with its own rehearsal and the owner's separate go-ahead; the bar-based betas do not depend on it); `security_betas` and the Defense beta reader.

### Review rulings on the addendum (C1-C14, 2026-11-24)

Made by the controller after an independent review of the addendum plan. They win over B1-B7 where the two differ.

- **C1 Partial bars.** The regression reads only bars dated before today. The capture never trusts a stored trailing bar: every capture refetches the last 14 calendar days before the stored latest bar (at least 5 sessions) and overwrites them. "Done for today" means this process captured the security successfully today, never a stored latest date. Latest and earliest dates are read through the priced-bar reader, so a corrupt row cannot count.
- **C2 Split splice.** Each capture compares the refetched overlap with the stored closes on the same dates (leaving out the stored latest bar, which may be a mid-session bar). Fewer than 5 compared sessions, or any close differing by more than 0.5%, is a change of adjustment basis: the full two years are refetched and the security's daily bars in that window are replaced in one transaction.
- **C3 Both legs from daily bars.** This engine does not read `benchmark_prices`. The driver's leg comes from the driver's own daily bars (SPY, QQQ or VTI resolved to its securities row), so both legs share one source and one split basis. The capture always includes the three drivers and every tracked index in the seed map, held or not, when a securities row with a contract id exists. With no usable driver bars every measured candidate reports `driver-bars-missing` and the page says the driver's closes are not on file yet. A tracked index's beta to the driver is a bar-to-bar regression bounded by the same dates and the same injected day.
- **C4 Foreign sessions.** A security whose stored currency is not USD is not measured (`foreign-session`) and is not captured: held unchanged in the measured case, 1 in the selloff case, the owner's figure allowed. The currency is the test because it is always present (`securities.currency`, NOT NULL, default USD); the stored `exchange` column holds whatever contract enrichment wrote and is not a reliable session marker.
- **C5 Options on a name with no measured link.** See B4: the underlying is held unchanged; the option is still repriced. Pinned for a long and a written option.
- **C6 Override key.** Each position carries `identitySecurityId` (the underlying's id for an option, its own otherwise; none when the underlying has no securities row). The owner's figure is keyed by it, so an underlying held only through options is set once and all its options follow. A figure for an id not present is ignored and counted.
- **C7** Settled by C3.
- **C8 Rate budget.** The capture uses the limiter the daily bar fetcher uses, at most one batch of 20 per 25 minutes per process; a manual sync inside that window starts no second batch. Intraday chart requests and the benchmark fetch are outside that limiter: the cap leaves headroom, it does not reserve a broker-wide budget.
- **C9 Fairness.** Per process and per Eastern day, a security whose capture succeeded and one whose available history is exhausted (a full fetch returned less than two years) are not retried that day.
- **C10 Backfill safety.** The script's dry run opens the database read-only with its own connection (never the app's database module, which migrates and checkpoints) and is tested to change nothing. `--apply` requires the app to be quit, takes a backup first, and runs under the coordination `tws` lock.
- **C11 Order.** The page task of the base plan is committed before the engine's result shape changes.
- **C12 Client boundary.** The override bounds live in an import-free constants module; the input validation never imports the engine; the client build verifies it.
- **C13 Evidence.** The bar regression returns its evidence for every outcome, with the reasons `no-daily-bars`, `driver-bars-missing`, `foreign-session`, `short-history` (fewer than 60 aligned pairs after the guards, none included), `flat-driver` and `low-fit`. "Waiting for daily bars" counts `no-daily-bars` only.
- **C14 Honest checks.** The split guard is qualified as above and its cancellation case is tested as a documented limit. The real-data check recomputes a handful of liquid names independently over the identical aligned observations (equal to 1e-9); plausibility ranges are recorded as observations, not gates.
