# Gains at risk, step 2: try a position before trading it

Date: 2026-11-24. Status: approved by the owner 2026-11-24. Every figure in this document is made up. Builds on `docs/superpowers/specs/2026-11-24-gains-at-risk-design.md` (step 1, live), whose rulings all still bind.

## Why

Step 1 shows what a fall in an index costs the book as it stands. The owner's next question is "what would change that?" Today the only way to find out is to trade and look again. Step 2 lets the owner add a position that does not exist yet (an option to buy or write, shares to buy or sell) and see both lines move, net of what the position costs, before placing anything.

Two further uses the owner agreed to:

- **Trimming is a way to cut risk too.** Selling part of a holding is a trial position of shares; it sits on the same lines, so buying protection can be set against simply selling down.
- **A trade made today that the daily feed has not delivered yet** can be typed in as a trial position, so the page is not a day behind.

## Goals

- Add, edit and remove trial positions on the Gains at risk page; the lines and the table redraw with them in the book.
- Show the book as it is beside the book with the trial positions, in the selected case, and what the trial positions cost.
- One click fetches a live quote for a typed option contract from the broker and fills in the price; the owner can overwrite it.
- Nothing is stored and nothing is traded.

## Non-goals

- No order entry, no order ticket, no link to one.
- No recommendation and no "best" label. The page compares what the owner types.
- No candidate grid across strikes and expiries, no ranking rule, no single-stock driver and no rise in the index. Those are step 3.
- No stored scenarios or saved sets of trial positions.
- No change to any other page.

## Anti-goals

- A trial position priced from a made-up input (a default volatility, a model price presented as a quote).
- Protection shown that is not real: a trial option on an underlying with no measured link to the index credited as an offset without saying so.
- The trial positions' cost left out of the line, so protection looks free.
- A delayed or frozen quote shown as live.
- A result shown for trial positions the owner has since edited.

## Approaches

**Price source for a trial option.** Typed only (as step 1's design said) or a "Get quote" button. The owner chose the button (2026-11-24): typing every price is slow enough that the tool would not be reached for, and step 3 builds on the same call.

**Where the trial positions enter.** (a) The engine takes them as extra rows and returns the book with and without them from one run; (b) the page calls the engine twice and subtracts. Chosen: (a). One run prices both on the same clock, betas and prices, conservation can be tested in one place, and the page cannot mis-subtract. (b) is less engine work but doubles the requests and lets the two answers drift.

**What the chart draws once trial positions exist.** (a) Four lines (two cases, each as-is and with trial positions); (b) the selected case only: the book as it is and the book with the trial positions, with the case switch flipping both. Chosen: (b). Four lines are unreadable on a phone, and the comparison the owner is making is as-is against with-trial. With no trial positions the chart is step 1's.

## The screen

```
 [ Try a position ]

 Trial positions                                             cost     share of year's gain
  Buy 10  ZZQ Mar 20 500 put   at 6.40  (quote: mid, live)   $6,400        1.6%      [edit] [remove]
  Sell 200 ZZA shares          at 310.00                     raises $62,000           [edit] [remove]
                                                 Net cash:   raises $55,600
  Not stored. Nothing is traded from this page.

 Case: [Measured] [Selloff case]

  gain kept
  100% |                         o=====  the book with your trial positions
   75% |                o========
   50% |        o=======         - - -   the book as it is
   25% | o======   - - - - - - -
       +----+-------+-------+-------+
          -15%    -10%     -5%     0%

 ZZQ move   Book as it is   With trial positions   Difference   Gain given back (as is -> with)
    0%          -$5,000           -$9,100             -$4,100         1% -> 2%
   -5%         -$61,000          -$44,000            +$17,000        15% -> 11%
  -10%        -$109,000          -$63,000            +$46,000        27% -> 16%

  With no move, the trial positions cost $4,100 more by that date (the time value the option loses).
  They pay for themselves once ZZQ falls more than 1.4%.
```

The form ("Try a position"):

- **Kind:** option or shares.
- **Option:** underlying symbol; put or call; buy or write; expiry; strike; contracts; price per share. A **Get quote** button beside the price.
- **Shares:** symbol; buy or sell; quantity; price per share (filled with the last stored price, editable).
- When the broker is connected, expiry and strike are native selects filled from the contract chain for that underlying; when it is not, they are typed.

## Behaviour

### What a trial position is

A trial position is a row the engine adds to the stress scope's book for one run. It has no account. It follows every step 1 rule for a real row of its kind:

- **Shares:** value = quantity x price; moves by the name's beta to the driver, per case, with the owner's own figure for that name applied if one is set.
- **Option:** repriced at the valuation date from the volatility solved from its typed price; its underlying moves by the underlying's beta, per case; the worse-of-two rule applies if it expires before the date.
- The contract multiplier is 100. (An adjusted contract with another multiplier is out of scope; the form says so.)

Its profit or loss at each move is what it is worth at the date minus what was paid (a bought position), or what was received minus what it costs to close (a written or sold one). So the cost is inside the line.

### What it needs, and what happens without it

- **The underlying must be a security the app knows, with a price.** If not: the position is refused with a sentence ("ZZX is not a security the app holds a price for."). No price is guessed.
- **An option price that cannot be solved** (below exercise value, or so high no volatility explains it) is refused with a sentence, as for a typed price in step 1.
- **Beta.** The underlying's measured link is used when one exists. When it has no daily bars yet and the broker is connected, adding the position fetches two years of daily bars for that one underlying (the same guarded capture as the sync, one request) and then measures. When there is still no measured link, the page says so on the row, in plain words, and the measured case holds that underlying unchanged, which means a trial option on it shows only its time decay there: the row carries a warning that its protection is not being counted in the measured case, and points to the selloff case and to the owner's own figure.
- **Selling shares not held, or more than held,** is allowed and flagged ("this leaves you short 150 ZZA").
- **A trial position on the driver itself** has beta 1.
- **Limits:** at most 12 trial positions; quantity and contracts positive whole numbers within stated bounds; strike and price positive; expiry a real date not before today.

### The quote

`Get quote` asks the broker for one contract's bid, ask and last, and the underlying's last price.

- A two-sided quote fills the price with the mid and says "mid of <bid> / <ask>".
- The kind of quote is always shown: live, delayed, or frozen (the broker's last quote from a closed session). A delayed or frozen quote is labelled as such beside the price, never shown as live.
- No two-sided quote: "No quote. Type the price." Nothing is filled. A model price is never offered as a quote.
- The broker not connected: the button is disabled with "Connect the broker to fetch quotes." Typing still works.
- A contract the broker does not list (a strike or expiry that does not exist): a plain sentence, nothing filled.
- The quote is public market data and is shown plainly. Contracts, cost and results are the owner's and are masked in privacy mode.
- One request per click, through the existing market-data snapshot path; never the historical-data budget. No polling: the price is the price at the click, with its time shown ("quoted 14:32").

### What the page shows with trial positions

- **The list** of trial positions with each one's cost (or cash raised), the cost as a share of the year's gain when the gain is positive and reconciled (the same rule as the given-back ratio), the quote's kind and time, and edit and remove controls. A net cash line.
- **The chart**, selected case: the book as it is, and the book with the trial positions. Step 1's "without the offsetting positions" line is hidden while trial positions exist (three lines of two different comparisons would confuse); a sentence says so.
- **The table:** book as it is, with trial positions, the difference, and the share of gain given back before and after.
- **Two sentences**, each only when true and computable: what the trial positions cost with no move by the date; and the fall at which the book with them first does better than the book without (found on the sweep by interpolation; "they do not pay for themselves within a 20% fall" when they never cross).
- **The per-name table** lists trial positions as rows marked "trial", sortable with the rest.
- Removing every trial position returns the page exactly to step 1.

### State

Trial positions live in page state only. They survive a refresh of the page's data (as step 1's controls do) and are lost when the page is reloaded or left. A changed or removed position clears the shown result before the new one arrives, and a reply for an older set is never shown.

## The engine and routes

- `computeGainsAtRisk` gains an optional `trialPositions` input. With it absent the result is byte-identical to step 1's (pinned). With it present, each case also returns the per-move totals of the book with the trial positions, the trial rows themselves, and the cost figures. Conservation, per case: the book with trial positions = the book as it is + the sum of the trial rows, to the cent.
- The route accepts and validates `trialPositions` (bounds above) and passes the result through.
- A new route for the quote (`POST /api/tws/option-quote`): thin wrapper over a function in `lib/tws/`; answers 503 when the broker is not connected; classified as a human route.
- A new route to make sure one underlying has daily bars (`POST /api/tws/daily-bars/ensure`, one symbol): runs the existing guarded capture for that one security, under the same limiter and rules (never today's bar, the short-reply guard, the eligibility rule). It writes only `ohlcv_bars`. It is the second caller of the capture; the capture's rules are not copied.
- The expiry and strike selects read the existing chain route. Its strikes are merged across expiries, so a picked pair can be one the broker does not list; the quote then says so.

## Constraints from the repo

- No migration. No new dependency. No AI call. Mac-only.
- The only new write is the one-symbol daily-bar fetch, into `ohlcv_bars` through the existing capture.
- No third-party price source: quotes and bars come from the broker.
- Mutating handlers read responses through `readMutationResult` / `networkFailureMessage`.
- The client boundary rule from step 1 holds: no client file and no file under `lib/analysis/` value-imports compute, query, database or broker code.
- Tests use synthetic positions and a fake broker; never a real database or a live broker connection.

## Tests that must exist

- **Unchanged without trial positions:** whole-result pin against step 1.
- **Conservation with trial positions,** per case, to the cent.
- **Cost is inside the line:** a bought put at a 0% move today shows exactly zero change (it is worth what was paid); at a later date it shows its time decay; a written call shows the reverse.
- **A bought put on the driver** improves the book in a fall by the amount an independent Black-Scholes gives, less its cost.
- **Selling held shares** removes exactly that share of the holding's loss; selling more than held is flagged and still conserves.
- **No measured link:** the trial option shows only decay in the measured case, carries the warning, and moves in the selloff case.
- **Refusals:** unknown underlying, unpriced underlying, unsolvable price, a 13th position, bad dates and numbers.
- **The quote:** two-sided fills the mid; one-sided or empty fills nothing; delayed and frozen are labelled; not connected is 503; an unlisted contract is a plain sentence. Never a model price.
- **Ensure bars:** one request, same guards as the capture, no write outside `ohlcv_bars`, refused for an ineligible security.
- **Stale replies** for an older set of trial positions are never shown.
- **The crossing sentence:** a case that crosses, one that never crosses, one that is better at every move.
- A browser pass on a sandbox copy, with the broker disconnected (typed prices) and, with the owner's help, connected (a real quote).

## Known limits

- One price per trial position, taken at the click. It does not update.
- The cost is the mid or the typed price, with no commission and no slippage.
- A US-listed option with a multiplier of 100 only.
- Buying or selling shares is shown at the typed price; the cash it uses or raises is shown but earns nothing and is not counted as protection.
- Step 1's limits still apply: betas are measured on ordinary days, the selloff case is an assumption, and Vanguard arrives once a day.

## Left to the builder

- The shape of the engine's added result fields, and whether trial rows reuse the position type with a marker or get their own.
- The form's layout and how edit works (inline or reopening the form).
- How the crossing point is interpolated.
- The bounds' exact numbers for quantity and contracts.

## Rulings after the builder check (2026-11-24)

These win over the text above.

- **R1. A trial option is fixed at the click.** Adding it (or changing its price) records the price paid, the underlying's price used, and the volatility solved from the two. Every later run values the option at the underlying's current price with that recorded volatility, less the price paid. The volatility is never solved again against a newer underlying price, so a trial keeps the gain or loss the market has given it since the click and is never refused later as "below exercise value". The solve uses the same own-price probe step 1 uses for a typed price: a price no volatility explains is refused, never quietly replaced by the broker's volatility.
- **R2. The underlying's price.** At the click: the quote's last price for the underlying when a quote was fetched; else the newest of the stored price and the latest daily closing bar, shown with its date. When that price is more than one trading day old and no quote was fetched, the row carries "priced against the <date> close". For valuation, a name the book already holds uses the book's own current price for that name, so the trial and the holding start from one price; a name the book does not hold uses the latest daily closing bar.
- **R3. Shares are marked against the typed price.** Result = quantity x (current price x (1 + the name's move) - the typed price), with the sign for a sale. A typed price that differs from the current price is an immediate gain or loss inside the line, which is what makes "a trade I made today" come out right.
- **R4. When the real trade arrives.** Each trial position records how many of that security (shares, or contracts of that exact option) every account held when it was added. If a later refresh shows a different number, the row is flagged: "Your holdings of <name> changed since you added this. Remove it if this trade is now in your book." It is never removed automatically.
- **R5. Scope.** Trial positions belong to the page, not to an account. They stay when the stress scope is switched. "Leaves you short" is counted against every account's holdings, and says so.
- **R6. The book's own figures do not move.** Gross book and every "share of the book" line (not modelled, no measured link, and the rest) describe the book as it is. Trial rows are listed apart with their own counts.
- **R7. "Cost as a share of the year's gain"** is shown only for premium paid on a bought option. Bought shares read "uses <amount> of cash"; sold shares "raises <amount>"; a written option "premium received <amount> (an obligation, not a gain)".
- **R8. What the quote can honestly say.** The existing snapshot path can tell a live tick from a delayed one by which tick arrived; it cannot see "frozen". So: "live" or "delayed" from the tick; outside the regular session the label is "market closed: the last quote", from the Eastern clock. The time shown is "fetched 14:32", the time of the click, never presented as the quote's own time. The contract is requested with a multiplier of 100, so an adjusted contract cannot answer.
- **R9. Fetching daily bars for one underlying.** The capture's per-security body is pulled out into one function used by the sync, the backfill script and this new call (three callers, one rule). The one-symbol call goes through the limiter but is not subject to the 25-minute batch window; it is refused while a sync batch is running ("try again in a moment"); a success is recorded in the capture's daily ledger. The engine's "never captured" count leaves out a name fetched this way. A security with no broker contract on file cannot be fetched and says so.
- **R10. Only names the app already knows.** A trial position needs a security the app already has, with a broker contract on file for a quote or a bar fetch. Adding a brand-new security is a write to the securities table and is out of this step. The form says: "The app does not know <symbol> yet. Add it to the watchlist first."

## Calls made here for the owner to check

1. The chart shows the selected case only once trial positions exist (as-is against with-trial), and hides step 1's "without the offsetting positions" line while they do.
2. Adding a trial option on an underlying with no daily prices fetches that underlying's daily bars from the broker (a write to the price-bar table, as the Charts page already does).
3. A trial option whose underlying has no measured link is shown, with a warning, rather than refused.
4. Selling more shares than held is allowed and flagged, not refused.
5. Trial positions are lost on a page reload. Saving them is not in this step.
6. The single-stock driver and a rise in the index (the short-stock case) stay in step 3.
7. Only names the app already knows can be tried (R10); a new symbol is added to the watchlist first.

## Rulings after the plan review (2026-11-24)

Made by the controller on the owner's delegation, after an independent review of the step 2 plan. These win over every earlier section, R1-R10 included.

- **P1. Editing keeps the click.** An edit that changes only the size (contracts or quantity) keeps the entry record (price paid, the underlying's price at the click, the solved volatility, the fetch time and the quote's kind) and the original holdings snapshot, with no new solve. A change to the contract's terms (underlying, put or call, strike, expiry), to the side (buy or write, buy or sell), or to the price is a new entry: a new click, a new solve, a new snapshot.
- **P2. One valuation price per name, the book's.** A name the stress scope's book has any row for (its shares, or an option on it) is valued at the same underlying price the book's rows use for it: the latest stored price the position loader reads (`own_price` on the name's own row, `underlying_price` on an option row; the same `prices` row). Only a name with no row of any kind in the stress scope's book is valued at its latest priced daily close.
- **P3. The holdings snapshot is per account.** Each trial records, for every account, how many of that exact security or contract it held at the click. The R4 flag shows when any account's figure differs, even when the total is the same.
- **P4. "Leaves you short" counts the whole trial list.** For each name, every account's holding plus all trial buys of it, less its trial sales taken in list order; the shortfall is attributed to the sale rows in that order, and the list shows one line per name the trial positions leave short.
- **P5. The crossing sentence covers every pattern** of the difference (book with trial positions minus book as it is) across the falls shown, a difference of exactly zero counting as not better: better at every fall ("They do better at every move shown."); worse at every fall ("They cost more than they return at every fall shown."); worse, then better ("They pay for themselves once <driver> falls more than X%."); better, then worse ("They help in a small fall and cost more beyond X%."); more than one change ("They help between X% and Y%. The picture changes more than once; read the table.", the first interval that helps).
- **P6. Form replies are tied to the draft.** Every form request (lookup, chain, quote, bar fetch, entry) carries the draft's revision and contract; a reply for an older revision or another contract is dropped; changing a term that defines the contract clears the fetched quote and where it came from; closing the form drops replies still on the way.
- **P7. A view that opens with trial positions waits for them.** On first paint and after a scope switch, when trial positions exist, the page shows the request as running and asks with them at once; the trial-free first paint is never shown as the answer.
- **P8. The name lookup says whether daily bars exist** (and through what date), so the form knows when to fetch them.
- **P9. Every new route checks its body before any broker request or write:** ids are positive whole numbers, the choices are from their lists, the expiry is a real day, every number is finite and within the stated bounds, and the security is looked up on the server and must be a non-option, US-dollar row (with a broker contract for a quote or a bar fetch). The calculation route checks security ids too.
- **P10. The session label uses the real close.** Early-close days are kept beside the full-day holidays in the market calendar, with their close time, from the same source (the NYSE trading calendar). On a day next to a full-day holiday that the calendar does not list, the label after 13:00 Eastern is "market closed: the last quote", never "live".
- **P11. An expired trial does not stop the page.** A new entry needs an expiry not before today. A trial kept on the page whose contract has since expired is still accepted; it is shown as expired, adds nothing ("This contract has expired. Remove it."), and every other trial position still counts.
- Settled: the owner's two pending changes are committed before the page work starts, as their own commits.
