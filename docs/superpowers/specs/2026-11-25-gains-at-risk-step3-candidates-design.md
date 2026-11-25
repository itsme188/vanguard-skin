# Gains at risk, step 3: one stock as the driver, and a table of candidate options

Date: 2026-11-25. Status: draft for the owner's review. Every figure, ticker and position in this document is made up (ZZA, ZZB and ZZQ are invented names; SPY, QQQ and VTI are the index drivers already in the code). Builds on `docs/superpowers/specs/2026-11-24-gains-at-risk-design.md` (step 1) and `docs/superpowers/specs/2026-11-24-gains-at-risk-step2-trial-positions-design.md` (step 2). Every ruling in those two documents still binds unless this one says otherwise.

Words used here:

- **Driver:** the one thing whose move the page sweeps. In steps 1 and 2 it is an index fund (SPY, QQQ or VTI).
- **Single-name driver:** a driver that is one stock or fund the owner holds or is trying.
- **Chain:** the list of option contracts the broker offers on an underlying (which expiry dates and which strike prices exist).
- **Quote:** the broker's bid (best price a buyer offers) and ask (best price a seller asks). The **mid** is halfway between them.
- **Candidate:** one option contract from the chain, quoted, sized to a budget, and tried against the book.
- **Out of the money:** a put whose strike is below the underlying's price, or a call whose strike is above it. It costs less and pays only after a bigger move.

## Intent and why

Step 1 answers "what does a fall in an index cost the book?". Step 2 answers "what would one position I type in change about that?". Two questions are still open.

**Case 1: one name, either way.** Say the book holds a large position in ZZA and is also short ZZB. A fall in ZZA hurts; a rise in ZZB hurts. Neither is an index question. A link to an index, measured on ordinary days, hides the very thing being asked: what if this one stock jumps or drops on its own (on earnings, say)? The owner wants to set the driver to ZZA or ZZB, move it down and up, and hold everything else still.

**Case 2: which contract?** Once the owner knows a hedge is worth having, the work is choosing one. Today that means typing one contract at a time into the step 2 form, pressing Get quote, adding it, reading the table, removing it, and starting again. Comparing nine contracts takes nine round trips and a notepad. The owner wants one table: a few expiries, a few strikes, each row quoted by the broker, each sized to the same dollar budget, each showing what it does for the book.

The budget is the fair way to compare. A cheap contract on a lower-priced underlying buys more contracts for the same money, and several contracts can be sold down a few at a time as the move plays out. So the table shows how many whole contracts the budget buys and what one costs, not only a notional amount.

## Goals

- A second driver kind, "One stock or fund", that moves one name (and its share classes and its options) both down and up, with every other position held still.
- A candidate table: up to 15 broker contracts per pull on one underlying (up to 3 expiries, each with its own strikes), puts or calls, quoted by the broker, each row sized to one budget and evaluated on the same book.
- Every row says what it costs, how many contracts that is, what it does at the selected move, what it costs if nothing moves, and where it starts to pay.
- One click moves a row into the step 2 trial list, unchanged.
- Nothing is stored and nothing is traded.

## Non-goals

- A rise in an index. Step 1's ruling F15 (index drivers fall only) stands. The selloff case means "names fall together"; there is no agreed meaning for "names rise together", so an index rise would need its own design.
- Writing options in the table. A budget sizes a purchase; it does not size an obligation (a written option's risk is not its premium). The step 2 form still handles written options one at a time.
- A whole-chain scan, spreads, rolls, or several legs per row.
- A ranking rule, a score, or a "best" label.
- Stored candidate sets or stored quotes.
- Any change to another page, or to `GET /api/tws/option-chain` and its other callers.

## Anti-goals

- A candidate priced from a model and shown as a quote.
- Rows measured against different books, or against the same book at different times, sitting in one table as if comparable.
- A row's figures shown after the budget, move, date or trial list has changed under it.
- A delayed or closed-session quote shown as live.
- A single-name result that quietly moves other names through an index link.
- More broker requests than the table needs, or a request sent for a body that should have been refused.

## What the owner sees

### The single-name driver

```
Gains at risk                            Stress scope: All   Positions as of Nov 25
Year's gain so far   $400,000

Driver: ( ) Index [QQQ v]   (o) One stock or fund [ZZA v]      by [Mar 20]
Vol change [ 10 ] pts  (options on ZZA only)
Other positions held unchanged. Their options still lose time value to the date.

  P&L
  +$60k |                                   o====  book
        |                         o========
     0  +-------------o==========---------------
        |      o======
 -$90k  | o====
        +----+------+------+------+------+------
           -40%   -20%     0%    +20%   +40%     ZZA

 ZZA move   Positions that lose   Offsets give back       Book    Gain given back
   -40%           -$96,000             +$8,000         -$88,000        22%
   -20%           -$48,000             +$3,000         -$45,000        11%
     0%                                                  -$1,200
   +20%            -$9,000            +$47,000         +$38,000
   +40%           -$18,000            +$94,000         +$76,000
 Custom [ -25 ]%

 At -25%: the book changes by -$56,000 (14% of the year's gain).
```

Notes on the sketch:

- No case switch (Measured / Selloff) and no per-name figure boxes in this mode; one set of figures.
- The zero row shows only the book's total: with no move there is no "lose" or "offset" side.
- The share of the year's gain shows only on a loss and only when the year's gain is positive and reconciled (step 1's rule).
- In an up row, "Positions that lose" are those that fall when ZZA rises (a short in ZZA, a bought put on it); "Offsets" are those that gain.

### The candidate table

```
 Compare options                                                     [ hide ]
 Underlying [ZZA v]   ( ) Calls (o) Puts    Expiries [Feb 20] [Mar 20] [Jun 18]
 Strikes  Feb 20: [ 95 ] [ 90 ] [ 85 ] [ 80 ] [ 75 ]   (each expiry's own strikes;
          Mar 20: [ 95 ] [ 90 ] [ 85 ] [ 80 ] [ 75 ]    by default the five nearest
          Jun 18: [ 95 ] [ 90 ] [ 85 ] [ 80 ] [ 75 ]    below 101.40; 15 at most)
 [ Get quotes ]  15 contracts. Quotes fetched 14:32, market open.

 Budget [ $10,000 ]          At the selected move: ZZA -25%          Sort: [none v]

 Contract          Bid / Ask      Mid   Per contract  Contracts      Cost  At -25%   At 0%  Pays once ZZA falls past  Cost/gain
 Mar 20  95 put   3.10 / 3.30    3.20       $320          31      $9,920  +$41,500  -$6,400   ZZA -6.1%      2.5%
 Mar 20  90 put   1.85 / 2.05    1.95       $195          51      $9,945  +$53,200  -$7,900   ZZA -10.4%     2.5%
 Mar 20  80 put   0.40 / 0.55    0.475      $47.50       210      $9,975  +$37,000  -$9,100   ZZA -18.9%     2.5%
 Jun 18  95 put   6.90 / 7.30    7.10       $710          14      $9,940  +$15,800  -$3,000   ZZA -9.0%      2.5%
 Feb 20  75 put   no quote
 Jun 18  75 put   2.40 / 2.60    2.50       $250          40     $10,000  +$29,000  -$5,200   ZZA -16.2%     2.5%
                  delayed
 Mar 20  85 put   ...  one contract costs more than the budget  (if the budget is small)

 Row actions: [ Add to trial positions ]  [ remove ]        [ Refresh quotes ] [ Clear ]
 Quotes come from the broker. Nothing is stored. Nothing is traded from this page.
```

- "At -25%" is the change in the book's result at the selected move caused by that row alone, net of its cost, on top of the book and the trial positions already on the page.
- "At 0%" is the same with no move: what time does to it by the valuation date (the cost of waiting).
- "Pays once ZZA falls past" is the driver move past which the row's own figure is positive. Its direction is the driver's, chosen by the selected move (D5): a negative selected move reads falls, a positive one reads rises, and the heading names which. It never depends on whether the row is a put or a call.
- Each row also keeps, in an expandable line under it (never a hover), the time of the option quote and of the underlying price it was solved against (D6).
- Every row is one broker contract, identified by the broker's contract id (D1); the expiry and strike shown are that contract's.
- Rows from two underlyings can sit in one table (ZZA puts and ZZQ puts, say), all on one book; each underlying's rows come from their own quotes call (D4).
- With an index driver the table looks the same; in that mode the figures follow the case switch.

## Approaches considered

**A. One server pull for the whole table (picked, owner 2026-11-25).** The page fetches quotes once, then sends every candidate in one compute request. The server loads the book once, prices the book and the current trial positions once, and prices every candidate against that one result.

- Every row is measured on the same positions, prices, clock and betas, so rows are comparable by construction.
- A change of budget, move, date or trial list is one request, with no broker call.
- Cost: an engine change (the candidate pass) and two new routes.

**B. The page loops the existing routes.** For each contract: a quote request, an entry request, then a full compute with that contract as a trial position.

- No engine change.
- About three requests per row, so a 15-row table is 45 requests and a budget change is 15 more full computes.
- Each compute reloads the book. A sync that lands halfway through gives rows measured against different books, and the table cannot tell.
- Fifteen quote requests in a row run into the 30-per-minute quote limit with nothing else on the page.

**C. A separate view for candidates.** Its own page with its own scope, driver and date controls.

- Clean separation of code.
- The table loses the chart and the trial list it feeds. The owner would set the same controls twice and copy a contract across by hand, which is the step 2 round trip this step exists to remove.

## Owner rulings

- **R1.** Step 3 is two things: a single-stock driver (the stock can rise as well as fall), and a comparison of candidate options from the broker's chain.
- **R2.** Candidates are compared on a same-budget basis: the owner types a dollar amount; each row shows how many whole contracts it buys, the price per contract, and what that many do for the book (owner, 2026-11-25). Contract count and price per contract are always visible, not just a notional amount.
- **R3.** The whole table is computed in one server call, on one book (approach A, owner 2026-11-25). The page never computes a row by looping the existing routes.
- **R4.** Carried from earlier designs: no "best" label and no recommendation; an optional sort by a column the owner picks. A candidate with no two-sided quote is "no quote", never a model price. Delayed quotes are labelled. The broker (TWS) is the only quote source. Nothing is stored; no migration; no new dependency.

## My calls

Each is my call, reversible, with why and the cost if wrong.

### Single-name driver

- **P1. The driver list.** The driver control gains a second kind, "One stock or fund". Its list is built on the server: every non-option security held in any account, the underlying of every held option, and the underlying of every current trial position. No free text. The index drivers stay as they are.
  - Why: the question is about names the owner has exposure to; a free-text driver invites a name the book has nothing on, which would show a flat line.
  - Cost if wrong: a name the owner wants to stress but holds only in a way the list misses (for example a leveraged fund on it, with no position in the name itself) cannot be picked; the fix is to add that source to the list.
  - Left out of the list (controller ruling, 2026-11-25): cash-equivalent funds (`isCashEquivalentSecurity`) and bonds. Why: a 20% move in a money-market fund or a bond held to a price near par is not a question this mode can answer sensibly. Cost if wrong: a bond fund the owner wants to stress alone is missing; add its type back.
  - Detail: an entry carries a symbol and, when one exists, a security id. An option whose underlying has no securities row (step 1 ruling F7) still lists its stored underlying symbol, with no id; the engine already matches the driver by symbol and by an option's stored underlying symbol (`lib/compute/driver-beta.ts:195`). Such a name can be a driver but cannot have candidates (the broker needs a contract on file).
- **P2. What moves.** In this mode the driver name, its share-class siblings (`issuerSiblings`, `lib/securities/issuer-family.ts`) and every option on them move by exactly the driver move (no regression). Every other position is held unchanged in price; its options still reprice for the time to the valuation date, as "no measured link" rows do today (step 1 ruling C5). The page says "Other positions held unchanged." There is one case in this mode, not two: no Measured / Selloff switch and no per-name figure boxes. `betaOverrides` sent in this mode are ignored, and the response counts them.
  - Why: a one-name jump is the question; a market link would hide it, and the two cases describe how names move together, which this mode deliberately turns off.
  - Cost if wrong: names that really do move with the driver (a supplier, a close competitor) show no change. The owner can still read the index modes for that.
- **P3. Leveraged funds on the driver.** A leveraged or inverse fund on the driver stock is held unchanged and listed, unless an owner-confirmed tracked-index seed names the driver (or a share-class sibling) as what it tracks; then it moves at the driver move times its signed factor, the existing rule (`resolveDriverBeta`, rule 1).
  - Why: the fund's own history already holds the leverage; guessing which stock a fund tracks from its name is the heuristic step 1 refused (F5).
  - Cost if wrong: a single-stock leveraged fund the owner holds is shown flat until its seed entry is confirmed. Today `LEVERAGED_TRACKED_INDEX_SEEDS` is empty (`lib/securities/leveraged-tracked-index.ts`), so every such fund is listed.
- **P4. The volatility change applies only to options on the driver** (and its siblings) in this mode.
  - Why: every other position is "held unchanged"; changing its volatility would move it.
  - Cost if wrong: a market-wide volatility jump that would come with a big single-name move is left out for other names' options. Small next to the driver's own move in nearly every book.
- **P5. Direction and range.** In single-name mode a move can be negative or positive. Bounds: -0.8 to +1.0, a new constant in the import-free `lib/analysis/gains-at-risk-constants.ts`. Default sweep -40% to +40% in 5% steps, still at most `maxMoves` (41) moves per request. Index drivers stay down-only (F15) with their current bound (`GAINS_AT_RISK_BOUNDS.moveAbsMax`, 0.6).
  - Why: one stock can halve or double; the risk of a short is a rise, and a rise has no natural cap, so the upper bound is wider.
  - Cost if wrong: a deeper or higher move than the bounds is not shown. Changing the constant is one line.
- **P6. The split follows the direction of each row.** A down row uses the down split (positive exposure to the driver loses); an up row uses the up split (negative exposure loses). The zero row has no split. Per row: loses + offsets + flat = total, to the cent, in both directions. The chart in this mode shows the book line (and the book with trial positions when there are any) and drops the "positions that lose only" line, because one line cannot follow two splits. The headline is the dollar change at the selected move; the share of the year's gain shows only for a loss, and only when the year's gain is positive and reconciled.
  - Why: a long put is an offset in a fall and a cost in a rise; one fixed side per row would put half the table in the wrong column.
  - Cost if wrong: the columns are relabelled; no total changes.
- **P7. Trial positions work unchanged in this mode.** A trial on the driver or a sibling moves with it; a trial on any other name is held unchanged (time only). The trial list's crossing sentence is read in the direction of the selected move and names it ("pays for itself once ZZA falls more than 6%" for a negative or zero selected move, "once ZZA rises more than 9%" for a positive one), as D5 rules for candidate rows too.
  - Why: a trial is just a row; the mode decides how rows move.
  - Cost if wrong: a trial on a related name looks inert in this mode, which the page already says of every other name.
- **P8. Back-compatibility.** An index-mode request and result with no step 3 input are byte-identical to today's. Pinned against `tests/fixtures/gains-at-risk-no-trial-pin.json` and a with-trial pin.
  - Why: steps 1 and 2 are live and reviewed; nothing in them should move.
  - Cost if wrong: none; the pin only prevents drift.

### Candidates

- **P9. Buying only:** long puts or long calls. Writing is out of the table (a budget does not size an obligation). The step 2 form still handles written options.
  - Cost if wrong: comparing covered-call strikes needs its own sizing rule (by shares held, not dollars), a later step.
- **P10. Two server calls, each one request for the whole table.**
  1. **Quotes** (reaches the broker). Body (D1, D4): the underlying security id and up to 15 explicit contracts for that ONE underlying, each named by the broker contract id the chain reader returned, with the right, expiry, strike, multiplier and trading class the chain reported for it. The body is checked, then the security on the server (`checkTrialSecurity` with a contract id required), then whether a sync is running (D2), then the free limiter slots (D7); only then is the broker asked. A refusal at any of these steps sends zero broker requests. **Controller ruling, 2026-11-25 (replaces the earlier concurrency wording):** quotes are fetched by ONE batch function in `lib/tws/`. It sets the broker's market-data type once for the whole batch and restores it once, through the one setter helper (D2), under a lock shared with `fetchOptionQuote`, so a single quote and a batch can never interleave. It takes ONE snapshot of the underlying, and a fresh one before any contract whose quote would be more than the allowed gap after it (D6). It requests contracts one after another, or in whatever bounded way the plan proves safe against the broker's documented pacing. `fetchOptionQuote`'s single-contract behaviour and its rules (never a model price, never a closed session called live, a one-sided or crossed quote fills nothing) are shared with the batch, not copied. Each contract is quoted by its contract id, and the broker's own description of that contract (underlying, right, expiry, strike, multiplier 100, trading class) must match what the chain reader returned; a mismatch or more than one match is refused "not a standard contract", with no price (D1). Each contract takes one limiter slot (`takeOptionQuoteSlot`, 30 in a rolling minute, shared with step 2's Get quote); the free slots are counted before the first broker request (D7). The batch runs inside an overall deadline; on the deadline, a disconnect or any throw it cancels every open market-data request, restores the type and releases the lock, and each contract not reached reads "not quoted: timed out" or "broker disconnected" (D7). Why one batch: the market-data type belongs to the whole broker connection (`lib/tws/option-quote.ts:236` sets it, `:249` restores it), so two quotes at once can undo each other's setting and return an empty quote for a contract that has one. Cost if wrong: a slower pull (up to 15 contracts in series) inside the deadline. Per contract it returns bid, ask, mid, live or delayed, the session label, the time the option quote arrived and the time the underlying price arrived, the underlying's price, or a refusal reason; and, for a two-sided quote, the solved entry (P13).
  2. **Compute** (no broker, pure). Body: the normal gains-at-risk body (scope, driver, date, moves, volatility change, overrides, current trial positions) plus the budget, the selected move and up to 30 candidates as returned by call 1 (possibly from several underlyings and several earlier pulls). The server loads the book once and evaluates every candidate against that one book. One row per candidate comes back.
  - Why two: a change of budget, move, date or trial list must recompute every row without asking the broker again, and rows from two underlyings must sit in one table on one book. The candidates the page sends back are client-supplied, and the response labels their quotes and prices as such, the way step 2's entry route labels a client quote (`underlyingPriceSource: "client-quote"`).
  - Cost if wrong: one more request than a single combined call when the owner only ever pulls once. Small.
- **P11. The chain.** The chain structure (which expiries and strikes exist) is read on the server for a security that passed `checkTrialSecurity`. `GET /api/tws/option-chain` is left as it is; it looks the symbol up with `LIMIT 1`, falls back to an unguarded broker lookup and merges strikes across expiries, so the plan adds a guarded reader. **Controller ruling, 2026-11-25 (replaces "listed strikes"):** the merged list from `getSecDefOptParams` is used only to list expiries. The strikes offered for a chosen expiry and right come from one contract-details request per chosen expiry and right, keeping only standard contracts: multiplier 100 and the standard trading class (the underlying's own symbol). This is a stricter filter than `fetchOptionQuote` applies today: it keeps every multiplier-100 match, accepts a sole match whatever its trading class, and uses the trading class only to choose among several matches (`lib/tws/option-quote.ts:207-214`). Per offered strike the reader returns the broker's contract id, trading class and multiplier (D1), and those identify the contract from then on. The form offers the expiries and, for each chosen expiry, its own strikes, by default the five nearest the valuation price on the out-of-the-money side for the chosen right, with at most 15 contracts in all (five each with three expiries, D4); the owner can change them. The chain reader has its own small request bound (D7). Why: the merged list offers strikes that do not exist for that expiry (`app/api/tws/option-chain/route.ts:81-103`). Cost if wrong: up to three more broker requests per pull; the defaults are a starting point only.
- **P12. Sizing.** contracts = floor(budget / (mid x 100)). Cost = contracts x mid x 100. All of it in exact scaled whole numbers, never a floating-point floor (D9): the budget is taken to whole cents, bid and ask are read to the broker's tick precision as whole numbers, the per-contract price is exact, contracts is whole-number division, and cost + unspent = budget exactly. The mid that sizes the row is the one canonical price, and the same price is the entry's price paid that drives the row's P&L (D3). Zero contracts: the row shows the per-contract price and "one contract costs more than the budget", with no book figures. Contracts are capped at `TRIAL_POSITION_BOUNDS.maxContracts` (500); a capped row says so. The mid is used, as step 2's Get quote uses it; bid and ask are shown beside it. Standard multiplier 100 only (`fetchOptionQuote` already pins it).
  - Why the mid: one price rule across steps 2 and 3. Paying the ask is common; the bid and ask beside the mid let the owner see how far apart they are.
  - Cost if wrong: every row's cost is understated by half the spread. A wide spread is visible on the row.
- **P13. Each priced row is a step 2 trial.** The entry is solved once from the quote, in call 1, through the step 2 entry rules. **Controller ruling, 2026-11-25 (replaces the by-symbol entry):** a candidate's entry is solved by security id, through a by-id form of the entry that shares `buildTrialEntry`'s body (no second copy of its rules). The symbol route the step 2 form uses is unchanged. Why: the quote is for a security id, and looking a symbol up again could attach the quote to another security with the same symbol. In the entry: the price paid is the mid, the underlying's price is the batch's underlying snapshot when there is one, and the volatility is recorded with it. An entry is never solved from an underlying price that arrived more than the allowed gap before the option quote (D6). The candidate's identity, in the entry, the row key and Add, is the broker contract id (D1). It is marked relative to the app's own price series (step 2 fix round 2). Call 2 only sets the size; it never solves again (step 2 rulings R1 and P1: a size-only change keeps the entry). Each row is evaluated on top of the book plus the current trial positions. Row figures, per case: the change in the book's result at the selected move (dollars), the result at 0% (cost of waiting, evaluated whether or not 0 is in the sweep, D10), the crossing in the driver's direction (D5), plus cost, contracts, per-contract price, and cost as a share of the year's gain. A row whose entry cannot be solved (mid below exercise value, no volatility explains it, expired) is listed with the step 2 refusal sentence and no figures.
  - Why solve in call 1: solving at every recompute would re-solve against a later clock and a later stored price, which step 2's R1 forbids for a trial.
  - Cost if wrong: none to the figures; only where the solve happens.
- **P13a. A candidate the run does not move says so (controller ruling, 2026-11-25).** In single-name mode a candidate on any name other than the driver or a sibling is held unchanged, so its row is its cost and time decay only. In index mode the same is true of a candidate whose underlying has no measured link in the measured case. Such a row carries a plain note ("ZZQ is held unchanged in this run, so this row shows cost only"), built from the row's beta source, never from a guess.
  - Why: a table of pure-cost rows with no explanation reads as "these hedges are useless", when the truth is the run does not move that name.
  - Cost if wrong: one extra line of text on some rows.
- **P14. "Add to trial positions"** puts the row into the trial list with its already-solved entry and its current size, not re-solved and not re-quoted. It respects `maxPositions` (12); at the limit the button says so.
- **P15. Freshness.** Every row shows its fetch time and its label (live, delayed, market closed: the last quote). Any change to scope, driver, date, moves, volatility, overrides, the trial list, the budget or the selected move clears the rows' book figures until the recompute returns; a reply for an older set of inputs is never shown (step 2's revision rule, as the trial list applies it: figures only from an answer to the inputs on screen). A quote older than `CANDIDATE_QUOTE_OLD_AFTER_MINUTES` (15, a constant) is flagged "old quote". "Refresh quotes" splits the table's rows by underlying into calls of at most 15 contracts, sent one after another; each reply replaces only its own rows; a contract the limiter refuses keeps its old quote, flagged by age (D4). Chain and quote replies carry their own revision and identity and are dropped when no longer wanted (D8). Rows can be removed one at a time or cleared.
  - Cost if wrong: 15 minutes is a guess at "too old to act on"; one constant.
- **P16. Broker disconnected.** The section says so, keeps rows already quoted (flagged by age, and still recomputable, since call 2 needs no broker), and points to the typed-price form.
- **P17. Privacy.** Quote prices, strikes and expiries are public market data and shown plainly. The budget (`<PrivateNumberInput>`), contracts (`<Count>`), cost and every book figure (`<Money>` / `<Pct>`) are the owner's.
- **P18. Client boundary.** Step 1's rule stands: no client file and no file under `lib/analysis/` value-imports compute, query, database or broker code. New bounds and sentences go in import-free or type-only modules.
- **P19. Testing without the broker.** The real chain, real quotes and real pacing are tested with fakes and added to the owner's live checklist.

### Further calls made in this document (accepted by the controller, 2026-11-25)

- **P20. The single-name result keeps the two-case shape.** The engine computes one case in single-name mode and returns the same figures under both `measured` and `selloff`, with a new top-level `driverKind: "single-name"`. Every existing reader keeps working; the page reads `measured` and hides the switch. A test pins the two keys equal.
  - Cost if wrong: a little duplicated data in the response; a later clean-up can drop the second key.
- **P21. The driver list is its own read-only route** (and comes with the first paint), not a field of the compute response, so P8's byte-identical pin stays simple.
- **P22. No default sort.** Rows stay in request order (expiry, then strike) until the owner picks a column. Rows with no figures (no quote, zero contracts, refused) sort last whatever the column.
- **P23. Superseded by D5.** (It read a row's crossing by put or call. The crossing is now read by the driver's direction; see D5.)

## Rulings after the design review (2026-11-25)

Made by the controller after an independent review of this design; all accepted. They win over every earlier section, and the text above has been corrected to match them.

- **D1. Contract identity.** The chain reader returns, for every strike it offers, the broker's contract id, trading class and multiplier. The quotes body names contracts by broker contract id (plus the underlying security id), not by strike and expiry. The batch quotes by contract id and checks the broker's description of the contract (underlying, right, expiry, strike, multiplier 100, trading class) against what the chain reader returned; a mismatch or an ambiguous match is refused "not a standard contract", with no price. A candidate's identity everywhere (row key, entry, Add) is the broker contract id.
  - Code today: `fetchOptionQuote` looks a contract up by its terms, keeps every match with multiplier 100, accepts a sole match whatever its trading class, and uses the trading class only to pick among several matches (`lib/tws/option-quote.ts:207-214`). The batch's check is stricter than that.
  - Why: two contracts can share terms (an adjusted contract after a corporate action); naming the contract by id means the row priced is the row quoted.
  - Cost if wrong: a standard contract with an unexpected trading class is refused and must be typed in the step 2 form.
- **D2. One setter for the market-data type.** The type is set for the whole broker connection, and four modules set it today: `lib/tws/snapshot.ts` (the sync's price step, and the manual price refresh at `app/api/tws/prices/route.ts`, sets delayed-frozen for the whole run of snapshots and restores real-time at the end), `lib/tws/atm-straddle.ts` (the earnings implied-move read, around two option snapshots), `lib/tws/streaming.ts` (the live-quotes stream, which sets delayed-frozen when streaming starts and restores real-time only when it stops, so for as long as the stream runs) and `lib/tws/option-quote.ts` (step 2's single quote). Every setter goes through ONE small helper in `lib/tws/` that sets the type and bumps a counter; in each existing caller it is a one-line swap with no change of behaviour, pinned by tests. The single quote and the batch hold a lock between themselves. A quote whose counter changed while it was in flight is retried once, then refused "not quoted: broker busy". A batch does not start while a sync is running (`isSyncing()`, `lib/tws/sync-state.ts:104`); it answers "a sync is running, try again in a moment" with zero broker requests. The manual price refresh does not mark a sync, so the counter is what catches it.
  - Why: a lock around the sync pipeline would change working code; detection plus one retry does not.
  - Cost if wrong: a pull that collides with a sync or a refresh is refused or slower.
  - Known limit, unchanged by this ruling: the quote and the batch restore real-time at their end, as `fetchOptionQuote` does today, so while the live-quotes stream runs, a quote can leave the connection on real-time behind it. Restoring the previous type instead would be a behaviour change and is not in this step.
- **D3. A validator of its own for call 2's candidates** (not the `trialPositions` check): a bought option only; right put or call; bid and ask finite and positive, bid at or below ask (a locked market, bid equal to ask, is a market, as the shared quote rule in `lib/tws/option-quote.ts` holds; a crossed one is refused); the mid equal to (bid + ask) / 2 exactly in scaled whole numbers; the entry's price paid equal to the mid; the entry's contract fields equal to the candidate's; multiplier 100. One canonical price sizes the row and drives its P&L. Anything else is a 400 naming the field.
  - Why: call 2 trusts client-supplied quotes; a page bug or a hand-edited body must not size a row on one price and value it on another.
  - Cost if wrong: a stricter check refuses a body the page should have built correctly; the 400 names the field.
- **D4. Request shape.** A quotes body holds up to 15 explicit contracts (D1) for ONE underlying. The form picks strikes per expiry: each expiry has its own offered strikes and its own default five, with the total capped at 15 (five each with three expiries). "Refresh quotes" splits the table's rows by underlying into calls of at most 15, sent one after another; each reply replaces only its own rows; the limiter bounds it, and a refused contract keeps its old quote, flagged by age.
  - Why: each expiry lists its own strikes (P11), and a refresh across two underlyings must not mix their batches.
  - Cost if wrong: a refresh of a large table takes several calls; the limiter already bounds the rate.
- **D5. The crossing follows the driver's direction, never put or call.** A call on an inverse fund, a negative measured beta or an owner's figure can each flip which way a contract helps. Index mode: falls only, as today. Single-name mode: the crossing is read in the direction of the selected move (falls when the selected move is negative or zero, rises when it is positive), for candidate rows and for the trial list's sentence alike; the sentence and the column heading name the direction. Replaces P23.
  - Why: "put pays in a fall" is a habit, not a rule the engine can rely on.
  - Cost if wrong: a row that pays only in the other direction shows "does not pay within the moves shown" until the owner flips the selected move.
- **D6. The underlying and the option are observed close together.** Each row keeps two times: when the underlying price arrived and when the option quote arrived (the broker puts no time on a snapshot's bid and ask, so arrival time is what can honestly be kept). A constant, `CANDIDATE_MAX_OBSERVATION_GAP_SECONDS` (proposed 30; the plan confirms it against the broker's documented snapshot timing), sets the largest gap allowed; before a contract whose quote would exceed it, the batch takes a fresh underlying snapshot. An entry is never solved from an underlying price older than that gap.
  - Why: a serial pull can take minutes, and a stale underlying price gives a false "below exercise value" refusal or a distorted volatility.
  - Cost if wrong: extra underlying snapshots (one market-data request each) in a slow pull.
- **D7. Workload and deadline.** The chain reader has its own small bound (a constant, requests per minute) and is refused the same way when over it. The quotes batch counts free limiter slots before any broker request: none free refuses the whole pull with the retry time and sends nothing; fewer than asked quotes the first N and returns the rest "not quoted: rate limit". At the overall deadline, on a disconnect and on any throw: every open market-data request is cancelled, the type is restored and the lock released (in a `finally`), and contracts not reached read "not quoted: timed out" or "broker disconnected".
  - Code fact the plan must handle: `getMarketDataSnapshot` in `@stoqey/ib` wraps the streaming call in a promise (`node_modules/@stoqey/ib/dist/api-next/api-next.js:1633-1636`) and cannot be cancelled from outside, and `fetchOptionQuote`'s timeout only stops waiting for it. To cancel, the shared single-contract path uses the subscription form (`getMarketData` with snapshot on, then unsubscribe, which sends the broker's cancel). Contract-details requests have no cancel in the broker's interface; the batch stops sending new ones and ignores late replies.
  - Why: a pull must never leave market-data lines open, the type changed, or the lock held.
  - Cost if wrong: a little more code in the shared path; no figure changes.
- **D8. Stale chain and quote replies.** Chain and quote operations carry their own revision and identity (underlying, right, the contract ids asked). A reply is dropped when the section was cleared, the row was removed, the underlying or right changed, a newer pull for the same contract was sent, or the page was left. A dropped reply never recreates a row. Tested apart from the compute-reply test.
  - Why: a late reply would otherwise bring back a row the owner removed, or overwrite a newer quote.
  - Cost if wrong: none to the figures.
- **D9. Money precision.** The budget is accepted to whole cents. Sizing, cost and unspent are computed in exact scaled whole numbers, never a floating-point floor: bid and ask are read to the broker's tick precision as whole numbers, the per-contract price is exact, contracts is whole-number division, and cost + unspent = budget exactly.
  - Why: a floating floor can buy one contract too few at an exact budget, and money figures must add up to the cent.
  - Cost if wrong: none; the plan picks one common whole-number unit fine enough for a cent and for half a tick x 100.
- **D10. "At 0%" does not depend on the sweep.** The candidate pass evaluates the zero move on the same run context whether or not 0 is among the requested moves. The book's own sweep is unchanged.
  - Why: the cost of waiting is a column on every row; it must not vanish when the owner picks a sweep without 0.
  - Cost if wrong: one more repricing per candidate.
- **D11. More tests.** Independent payoff fixtures that do not come from a second engine run (a candidate valued at its own expiry date equals intrinsic value minus price paid, worked by hand, for a put and a call, in and out of the money; T9 stays as well); refusal before sending for an unauthenticated or CSRF-failing request on every new route that reaches the broker (zero broker requests); a deterministic browser pass covering single-name results in both directions, two underlyings in one table, a refresh race, privacy mode, and a scope change with rows present. Real screenshots, responses and logs go only to gitignored locations.
  - Why: a second engine run shares the engine's mistakes; a hand-worked payoff does not.
  - Cost if wrong: test time only.

## Engine changes

All in `lib/compute/gains-at-risk.ts` and `lib/compute/gains-at-risk-trial.ts`. Read-only over the database, as today.

1. **A driver kind on the input.** `GainsAtRiskInput` gains an optional `driver: { kind: "index" } | { kind: "single-name"; symbol: string; securityId: number | null }`. Absent means index, with today's behaviour (P8). The route resolves a single-name driver from the server-built list (P1); the engine never accepts a name outside it from a route.
2. **A single-name ladder.** In single-name mode `ladderFor` does not call `resolveDriverBeta`'s regression rung and reads no driver bars. The rule, first match wins:
   - the identity (or an option's stored underlying symbol) is the driver or one of its `issuerSiblings`: 1;
   - a leveraged or inverse fund whose seed names the driver or a sibling: signed factor; any other flagged fund: held unchanged and listed under its own disclosure ("leveraged fund, not linked to the driver");
   - everything else: 0, beta source `held-unchanged` (a new source; never shown as "no measured link", which means a measurement failed).
   `betaEvidence` is not computed in this mode and is reported as not applicable. `betaOverrides` are counted as ignored (P2).
3. **Volatility change per row.** `priceAt` takes the volatility change only for rows whose identity is the driver or a sibling (P4); 0 for every other option.
4. **Two sides per row.** In single-name mode each row's case carries `sideDown` and `sideUp`: `sideOf` with the exposure as is for the down side, and with the exposure's sign reversed for the up side; for a row that expires before the date, the down side reads the most negative move and the up side the most positive. `caseFor` totals each move row with the side for that move's sign; the zero row reports only `bookPnlUsd`. In index mode the existing single `side` is unchanged (P8).
5. **Bounds.** `checkInput` already refuses a move below -1; the single-name bounds (P5) are checked by the route from the constants module, and the engine refuses a move above the single-name maximum in that mode as an input error.
6. **The candidate pass.** `computeGainsAtRisk` gains an optional `candidates` input (each a trial option draft with its entry, an id and a size). After the book and the trial positions are priced, in the same run (same clock, risk-free rate, beta memo, `caseBetas`, `sideOf`, exposure and rounding), each candidate is priced by the same per-trial function the trial pass uses. Candidate rows never enter `positions`, the trial totals, net cash, the shortfall check, any disclosure or `betaOverridesIgnored`. Per candidate and case: its own P&L by move, its value at the selected move, its value at a 0% move (always evaluated on the same run context, whether or not 0 is in the sweep, D10; the book's own sweep is unchanged), and its crossing in the driver's direction (D5). Sizing is done before pricing, in exact whole numbers (D9), and the candidate is priced at that size. Absent or empty: no `candidates` key, byte-identical result.
   - This is less work than it sounds: the trial pass is already a map over independent rows inside the same run (lines 1149 to 1302). The builder pulls its body out into one function over a run context (loaded rows, rate, memo, `ladderFor`, clock) and calls it for trials and for candidates. The book is loaded once (`loadScenarioPositionsByAccount`, line 747), whatever the number of candidates.
7. **Entry by security id.** `buildTrialEntry` looks the symbol up again (`lookupTrialSecurity`, `gains-at-risk-trial.ts:375-378`), while a quote is for a security id. A by-id form of the entry shares `buildTrialEntry`'s body and skips only the symbol lookup; call 1 uses it, so the entry and the quote can never name two different rows that share a symbol (P13).
8. **Crossing with a direction.** `trialCrossing` gains a direction argument ("fall", the default and today's behaviour, or "rise"); the rise version reads moves at or above 0 by growing size, with the same patterns and sentences mirrored (P5 of step 2, P7 here). The direction comes from the driver (D5): index mode always "fall"; single-name mode "fall" when the selected move is negative or zero and "rise" when it is positive. It is never chosen from a row's right. The selected move therefore becomes an engine input in single-name mode (it already is on the candidates route).

## Routes

Every route is a thin wrapper over a `lib/` function, answers `{ success, data }` or `{ success: false, error }`, is classified as a human route in `lib/auth/route-policy.ts` (the plan confirms the default covers it), and checks its body before any broker request or database read beyond the security check. A request that fails the session or CSRF check is refused by `proxy.ts` before the route runs, so it sends zero broker requests (tested per D11).

Broker-side modules (`lib/tws/`):

- **The setter helper** (D2): the one place that sets the market-data type and bumps the counter. `snapshot.ts`, `atm-straddle.ts`, `streaming.ts` and `option-quote.ts` each swap their `api.setMarketDataType(...)` calls for it, one line each, with no change of behaviour.
- **The shared single-contract path:** `fetchOptionQuote`'s tick reading and two-sided rule pulled out once, now on the cancellable subscription form (D7), used by the single quote and the batch.
- **The batch** (P10): lock, sync check, slot count, one type setting, underlying snapshots per D6, contracts by id with the D1 check, deadline and cleanup per D7.
- **The chain reader** (P11, D1, D7).


- **`POST /api/compute/gains-at-risk`** (extended). The body gains an optional `driver` (`{ kind: "single-name", securityId }` or `{ kind: "single-name", symbol }` for an underlying with no row). The route checks it against the server-built list and answers 400 when it is not on it. Moves are bounded per mode (P5). With no `driver` the body and the reply are today's (P8).
- **`POST /api/compute/gains-at-risk/single-name-drivers`** (new, read-only). Body: the security ids of the current trial positions' underlyings (positive whole numbers, at most `maxPositions`). Returns the list of P1: symbol, name, security id or null, and why it is listed (held, option underlying, trial). Also read by the server view for the first paint.
- **`POST /api/tws/option-candidates/chain`** (new, reaches the broker). Body: one underlying security id, a right, and optionally 1 to 3 chosen expiries. Checks `checkTrialSecurity` (contract id required) and the chain reader's own request bound (D7; over it, 429 with the retry time) before any broker request; 503 when the broker is not connected. Without expiries it returns the expiries (today or later) from the merged structure list. With expiries it makes one contract-details request per expiry and right and returns, per expiry, the standard contracts only (multiplier 100, standard trading class): for each, strike, broker contract id, trading class and multiplier (D1), plus the default five per P11. Not on the historical-data limiter.
- **`POST /api/tws/option-candidates/quotes`** (new, call 1). Body: the underlying security id and 1 to 15 contracts for that one underlying, each with its broker contract id and the right, expiry, strike, multiplier and trading class the chain reader returned (D1, D4). Order: body (400), security (422), connection (503), a running sync (409 "a sync is running, try again in a moment", D2), free limiter slots (429 with Retry-After when none, D7), then the batch function of P10 (one market-data type setting through the setter helper under the shared lock, an underlying snapshot refreshed per D6, then per contract a limiter slot, the identity check of D1 and the shared single-contract rules). Per contract: the quote fields, the two arrival times (D6), the session label, or a refusal (`not-standard-contract`, `not-quoted-rate-limit` with `retryAfterSeconds`, `not-quoted-timed-out`, `broker-disconnected`, `not-quoted-broker-busy`, or `fetchOptionQuote`'s own reasons), and for a two-sided quote the entry solved by id (P13). A refused contract is a 200 row, never a model price. One content-free log line per failure stage, as `fetchOptionQuote` does.
- **`POST /api/compute/gains-at-risk/candidates`** (new, call 2, no broker). Body: the gains-at-risk body plus `budgetUsd` (whole cents, above 0, at most a stated bound, D9), `selectedMove` (one of the request's moves) and 1 to 30 candidates in call 1's shape. The candidates are checked by their own validator (D3), not by the `trialPositions` check; a failure is a 400 naming the field. Each candidate's underlying is checked with `checkTrialSecurity` (no contract id needed: no broker). Returns the book's figures at the selected move, then one row per candidate: id, contract, quote fields as sent (labelled client-supplied), contracts, capped flag, cost, per-contract price, cost share of the year's gain, and per case the change at the selected move, at 0%, and the crossing; or a refusal with its sentence.

## Page changes

All under `app/dashboard/components/gains-at-risk/`, with words and pure helpers in `lib/analysis/gains-at-risk-view.ts`, `-trial-view.ts` and a new `lib/analysis/gains-at-risk-candidates-view.ts` (type-only imports from the engine and broker modules).

- **Driver control.** Two kinds: Index (the three drivers, as now) and One stock or fund (a native select of the server list). Switching kind resets the sweep to that kind's default and keeps the date, the volatility change and the trial list. The beta-override figures are kept in page state but not sent in single-name mode, and the per-name boxes are hidden.
- **Single-name chart and table.** One line for the book, one for the book with trial positions when there are any; no "without the offsetting positions" line; the custom move accepts -80% to +100%. The table shows falls and rises with the split per P6; the zero row shows the total only. "Other positions held unchanged." sits under the controls.
- **Candidate section.** Below the trial list, collapsed by default. Underlying (the list of names the app knows with a contract on file, starting from the driver), right, expiries, then each chosen expiry's own strikes from the chain route (15 contracts at most in all, D4), Get quotes, the budget, then the table. The crossing column's heading names the direction (D5). Sort is a native select of the columns, with "none" first (no carets, per the house rule). Each row has Add and Remove; the section has Refresh quotes and Clear.
- **State.** Candidate rows live in page state only, keyed by broker contract id (D1; a pull of an existing contract replaces its quote). Chain and quote operations carry their own revision and identity (underlying, right, the contract ids asked); a reply is dropped when the section was cleared, its row removed, the underlying or right changed, a newer pull for the same contract sent, or the page left, and a dropped reply never recreates a row (D8). "Refresh quotes" sends one call per underlying, at most 15 contracts each, one after another (D4). Every compute request carries a sequence number; a reply for an older sequence is dropped (the existing reducer pattern, `seqRef`, `GainsAtRiskView.tsx:192`). Candidate figures show only from an answer to the inputs on screen; while a recompute runs, the rows keep their quotes and lose their book figures (P15). Leaving the page or reloading drops everything.
- **Handlers** read replies through `readMutationResult` / `networkFailureMessage`.
- **Disconnected broker.** Get quotes and Refresh quotes are disabled with the step 2 sentence; existing rows stay and recompute.

## Invariants as named test requirements

Tests use synthetic positions, a fake broker and in-memory SQLite. No real figure in any committed file.

- **T1 Index mode unchanged.** With no `driver` and no `candidates`, the engine result and the route reply equal today's, byte for byte, with and without trial positions (the existing pins).
- **T2 Single-name conservation, both directions.** For every move in a sweep from -40% to +40%: book = sum of position rows = loses + offsets (+ flat, which is zero), to the cent; the zero row's total equals the sum of its rows.
- **T3 What moves.** The driver's shares and a sibling class's shares change by exactly market value x move; an option on either is repriced at that move; a stock on any other name changes by exactly 0; an option on another name equals its time-only figure (its value at the date at a 0% move and no volatility change, less its value now).
- **T4 Volatility only on the driver.** With a volatility change of +20 points, options on other names are unchanged from the 0-point run; options on the driver change.
- **T5 Figures ignored.** A single-name run with `betaOverrides` equals the run without them, and the ignored count equals the number of keys.
- **T6 Direction split.** In an up row a short in the driver and a bought put on it are on the losing side and a bought call is an offset; in a down row the reverse; a row that expires before the date takes each side from its own sign at the extreme move of that direction.
- **T7 Leveraged on the driver.** With a seed naming the driver, a 2x fund moves twice the driver and an inverse fund against it; with no seed it is held unchanged and listed.
- **T8 Bounds.** A single-name move below -80% or above +100% is refused; an index move above 0 in the table row and beyond 60% anywhere is refused as today.
- **T9 Candidate conservation.** For each candidate, per case and per move: (book + current trials + this candidate) minus (book + current trials) equals the candidate's own rows, to the cent. The left side is computed independently, by a second engine run with the candidate added to the trial list.
- **T10 The book does not move.** A candidates request returns book figures identical to the plain compute with the same body.
- **T11 Load once.** The position loader is called once per candidates request, for 1 and for 30 candidates (spy).
- **T12 Money in equals money out (sizing, D9).** In exact whole-number arithmetic, for every priced row: cost = contracts x mid x 100; cost + unspent = budget exactly; 0 <= unspent < one contract's price unless the row is capped; a capped row has contracts = 500. Named cases: a budget that buys exactly N contracts (unspent 0, never N - 1), a half-cent mid, the cap, and a budget one cent under one contract's price (zero contracts). A row with zero contracts has no book figures and is out of every total.
- **T13 No model price.** A one-sided, crossed or empty quote yields "no quote" and no figures; no candidate row has a price that did not come from a quote.
- **T14 Refusals send nothing.** A bad quotes body, an unknown, option, non-dollar or contract-less security, a disconnected broker, a running sync (D2), or a request that fails the session or CSRF check (D11) sends zero broker requests (spy on the fake API), and the chain route likewise (with its own bound, D7).
- **T15 Rate limit (D7).** With no free slot the whole pull is refused with the retry time and the fake broker sees nothing; with N free of M asked, the first N are quoted and the rest come back "not quoted: rate limit", with no request sent for them.
- **T16 Solved once.** The entry returned by call 1 is used unchanged by call 2 for any budget; a budget change changes only the contracts and the dollar figures.
- **T17 Add keeps the entry.** A row added to the trial list produces a trial whose figures in the next compute equal the row's figures, to the cent, with the same inputs.
- **T18 Stale replies.** A pure reducer test: a reply for an older sequence, or for inputs since changed, is never shown.
- **T19 Old quote.** A quote fetched 14:59 minutes ago is not flagged; 15:00 is.
- **T20 Driver list.** The list holds held non-options, option underlyings (with and without a row) and trial underlyings; a compute body naming a name not on it is 400.
- **T21 Crossing by the driver's direction (D5).** Each pattern of step 2's P5, mirrored for rises; in single-name mode the direction follows the sign of the selected move, for candidate rows and the trial sentence alike; a call on an inverse fund and a name with a negative owner's figure are read in the driver's direction, never by their right; index mode reads falls only.
- **T22 Client boundary.** The import-graph source test covers the new client and `lib/analysis/` files.
- **T23 Privacy.** Source-pin tests: budget through `<PrivateNumberInput>`, contracts through `<Count>`, cost and figures through `<Money>` / `<Pct>`; strikes, bids and asks plain.
- **T24 Contract identity (D1).** The chain reader returns contract id, trading class and multiplier per strike; a broker description that differs in underlying, right, expiry, strike, multiplier or trading class, or that matches twice, is refused "not a standard contract" with no price; the row key, the entry and Add all carry the contract id.
- **T25 One setter (D2).** Each of the four existing callers sets the type through the helper and behaves as before (their existing tests stay green, plus a pin that no other `setMarketDataType` call exists under `lib/` and `app/`). A counter change during a quote retries it once, then refuses "not quoted: broker busy". A single quote and a batch never overlap (lock).
- **T26 Candidate validator (D3).** Each rule refused with a 400 naming the field: a written option, an unknown right, a non-positive or crossed quote, a mid not equal to (bid + ask) / 2 in scaled whole numbers, a price paid not equal to the mid, contract fields that differ from the entry's, a multiplier other than 100.
- **T27 Observation gap (D6).** With a fake clock, a contract whose quote would arrive more than the gap after the underlying snapshot gets a fresh snapshot first; no entry is solved from an older underlying price.
- **T28 Cleanup (D7).** On the deadline, a disconnect and a throw: every open market-data subscription is cancelled, the type is restored, the lock is released, and unreached contracts read "not quoted: timed out" or "broker disconnected".
- **T29 Stale chain and quote replies (D8).** A pure reducer test, apart from T18: a reply after a clear, a row removal, a change of underlying or right, a newer pull for the same contract, or leaving the page is dropped and never recreates a row.
- **T30 Zero move without 0 in the sweep (D10).** A candidate's "At 0%" is the same whether or not 0 is among the requested moves, and the book's sweep is unchanged.
- **T31 Hand-worked payoffs (D11).** With the valuation date on the candidate's own expiry, its figure equals intrinsic value minus price paid, times contracts x 100, worked by hand (not by a second engine run), for a put and a call, each in and out of the money. T9 stays as well.
- **Browser pass** on a sandbox copy, deterministic (D11): single-name results in both directions, two underlyings in one table, a refresh race, privacy mode, and a scope change with rows present; broker disconnected (typed prices, rows recompute), and with the owner, broker connected (a real chain and real quotes). Real screenshots, responses and logs go only to gitignored locations.

## Constraints from the repo

- No migration, no new dependency, no AI call. Mac-only; no Worker mirror and no snapshot field.
- No third-party price source: chain and quotes come from the broker.
- Read-only over the database. Nothing about a candidate or a quote is stored.
- Scope rules: `undefined` is every account, an empty list is none; the page resolves the scope once.
- Option expiry only through `lib/compute/option-expiry.ts`; "today" through `todayET()`; the session label through `lib/calendar/market-session.ts`.
- Risk-free rate through `getRiskFreeRate(db)`.
- A server page never imports a function from a `"use client"` file.
- Every question goes through the app dialog; no native `confirm()`.
- Market-data snapshots are not on the historical-data limiter (55 per 10 minutes); they are bounded by the quote limiter and the broker's own market-data line limit.
- The repo is public: synthetic tickers and figures only in tests and docs. Real screenshots, responses and logs from a browser pass go only to gitignored locations (D11).
- Every setter of the market-data type goes through the one helper (D2).

## What is left to the builder

- The exact shape of the candidate result fields and the per-direction side fields.
- How the per-trial pricing body is pulled out into a function (P13, engine change 6).
- Whether the quote batch requests contracts one after another or in a bounded way the plan proves safe against the broker's documented pacing, and the overall deadline (P10).
- Pulling the trial pass's per-row body out into one function over a run context (loaded rows, rate, memo, `ladderFor`, clock), so the book loads once and trials and candidates share it (engine change 6).
- Two sides per row (down and up) and a crossing that also reads rises (engine changes 4 and 8): today `sideOf` gives a row one side for the whole sweep and `trialCrossing` reads falls only.
- A single-name ladder with a new "held unchanged" beta source (engine change 2), separate from "no measured link".
- A per-mode move bound in the body check: `gainsAtRiskBodyProblem` today refuses any move beyond `moveAbsMax` (0.6) whatever the driver (P5).
- P15 clears candidate figures rather than dimming them: the step 2 page dims the old book figures while a request runs (`GainsAtRiskView.tsx:124-134`) and clears only the trial list's; the candidate rows follow the trial list.
- The chain reader's request bound (D7) and the observation gap (D6, proposed 30 seconds), both constants, confirmed against the broker's documented pacing and snapshot timing.
- The common whole-number unit for money (D9), and reading the broker's minimum tick for a contract.
- A count-then-take form of the quote limiter, so the batch can count free slots before any request (D7) without one slot changing hands between the count and the take.
- The budget's upper bound (suggest the same as `TRIAL_POSITION_BOUNDS.maxPrice` x 100 x `maxContracts`, or a round figure).
- The section's layout on a phone (the table likely becomes one card per row).
- Whether the single-name drivers route is folded into the server view's first paint only, with the route used after a trial change.

## Open items for the owner

1. **Cash-equivalent funds and bonds** are left out of the driver list (P1). Say if you want them in.
2. **Paying the mid.** Rows are costed at the mid (P12). If you usually pay nearer the ask, a "cost at the ask" column is a small add.
3. **The old-quote age.** 15 minutes (P15). Say if another figure suits you better.
4. **A rise in an index** stays out (non-goal). Confirm that the short-stock question is fully covered by the single-name driver.
5. **Live checklist** (P19): a real chain pull, a 15-contract quote pull during the session and outside it, a delayed-data label, a rate-limit refusal, a pull during a sync (refused), a pull while the live-quotes stream runs, and Add on a row.

## OPEN: rulings the code contradicts

None open. Four were found and resolved by controller rulings on 2026-11-25: quote concurrency, strikes per expiry and entry by security id (folded into P10, P11 and P13), and the locked-market case (D3 accepts bid equal to ask, so calls 1 and 2 agree).
