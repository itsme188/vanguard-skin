# A live-closed option or short reads as pending a statement — design (2026-10-08)

Status: for the owner to rule on. No code is written. Direction-only: no figure from the real book appears here.

**Ruling being designed (owner, 2026-10-08, q15):** "A lot closed in a live feed (an option or a short) reads as pending a statement and is not valued; no saved close is written and tax inputs are not touched until a statement confirms."

**Parent design:** `docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md` (long stock and ETF only). This document extends its read model. It does not change the engine.

## Terms

- **Lot**: one purchase (or one short sale) still tracked in `tax_lots`. A lot is **open** while `quantity_remaining > 0`.
- **Side**: long (`is_short = 0`) or short (`is_short = 1`). A short lot is opened by a sale and closed by a purchase.
- **Pair**: one account plus one security. Holdings rows are kept per pair and carry the NET quantity (a short is a negative quantity).
- **Live feed**: TWS, the IBKR Web API or Plaid. It reports positions, not trades.
- **Flat**: the pair's quantity is zero.
- **Tombstone**: a zero-quantity holdings row the reconciler writes when a position is missing from a complete snapshot. Its `source_key` ends in `:live` (found by a live snapshot) or `:stmt` (found by a statement).
- **Statement-grade**: a statement row, a `:stmt` tombstone, or an old unsuffixed tombstone on a statement date (`statementGradeHoldingSql`). **Live-origin** is the other class (`liveOriginHoldingSql`).
- **Closing entry**: the ledger transaction that closes a lot. Long option: SELL_TO_CLOSE, EXPIRED or EXERCISED. Short option: BUY_TO_CLOSE, EXPIRED or ASSIGNED. Short stock: BUY_TO_COVER (or a BUY that carries IBKR "close" direction evidence).
- **Ledger gap**: the statement shows the pair flat, but the closing entry is not in the ledger.
- **Synthetic close**: the engine-owned `RECONCILE_CLOSE` transaction. Today it is minted only for long stock and ETF lots, only from a statement-grade zero.

## 1. The problem

Today `getPendingStatementPairs` (`lib/queries/pending-statement.ts`) covers long stock and ETF lots only. Its gates are `tl.is_short = 0` and `security_type IN ('stock','etf')`, and `isPendingStatementLot` returns false for any short lot.

For a long stock the life cycle is complete:

1. A live feed shows the pair flat. The lot reads "pending statement" and is not valued.
2. The statement arrives. Either it brings the real sale, or the engine's broker-close pass mints a synthetic close from the statement zero. Either way the lot is closed.

For an option or a short, step 2 has no second branch. The engine never mints a synthetic close for them (by design, see section 3). So if the model were simply widened:

- While only live data says flat, the lot would read pending. Good.
- When the statement arrives with the closing entry, normal lot matching closes the lot. Good.
- When the statement arrives WITHOUT the closing entry (a ledger gap), condition (b) of the model ("no statement-grade zero is the newest statement-grade row") drops the pair out. The lot reads **open and valued** again, at the moment the strongest evidence says it is closed.

That last case is the blocker. A paper gain would reappear on a position two sources agree is gone.

A sibling fact worth stating: portfolio value, the Today strip, Accounts, the daily valuation series, the options and hedge views all read **holdings**, not lots. A flat pair is already absent from all of them. This design only concerns surfaces that read **lots**: Tax Lots, the security page's lot section, the chat tax tools and summary, and the integrity scan.

## 2. What ends the pending state

### Options considered

**Option A — the ledger ends it (recommended).** A lot of the new classes stays unvalued for as long as the pair's newest holdings evidence, live OR statement, says flat. It leaves that state only when one of these happens:

- **E1. The closing entry is imported.** Normal lot matching closes the lot. This is the expected ending.
- **E2. An option's expiration date passes.** The lot moves to the existing "expired, awaiting a closing entry" bucket (`getExpiredOptionLotsAwaitingClose`). That bucket is driven by the date, not by holdings rows.
- **E3. A newer non-zero holdings row appears.** The flat reading was wrong, or the position was re-opened. The lot reads open and valued. (Same as long stock today.)
- **E4. An imported position-changing fill is dated after the flat date.** The ledger is fresher than the snapshot, so the ledger decides. (The existing later-fill guard, unchanged.)

A statement zero alone never ends it. It only changes the **reason** shown (see below).

**Option B — the evidence ends it.** Keep condition (b) as it is. The pair stops being pending as soon as a statement-grade zero is newest. Simple, and it is today's rule, but it produces the blocker in section 1.

**Option C — the statement ends it with a synthetic close.** Extend the engine's broker-close pass to options and shorts. Rejected in section 3.

**Option D — a time limit.** Drop the pending state after a set number of days. Rejected: it guesses. Options already have a true deadline (E2); a short stock has none.

### What each option does when the statement arrives without the closing entry

| | Option A (recommended) | Option B | Option C |
|---|---|---|---|
| Lot valued? | No | **Yes, again** | Closed |
| Saved close written? | No | No | **Yes, at an estimated price** |
| Tax inputs touched? | No | No | **Yes** |
| What the owner sees | "closing entry missing" | An open lot with a paper gain | An estimated realized figure |
| Matches the ruling? | Yes | No (valued) | No (close written from a position, not a trade) |

### Two reasons, one state

Under Option A a pending lot carries one of two reasons. Both are unvalued. Both write nothing.

- **`awaiting_statement`** — only live data says flat. The pair's newest statement-grade row is not a zero. Expected, and it resolves itself. Wording: "pending statement" (today's chip).
- **`closing_entry_missing`** — the pair's newest statement-grade row is a zero and the lot is still open. The statement has come; the trade has not. This needs the owner to act (import the right file, or transcribe the entry). Wording: "closing entry missing".

Keeping these apart matters. "Pending statement" after the statement has been imported would be false, and it would hide a real ledger gap behind a label that says "wait".

### By class

**(a) Long option.**
- Ends by SELL_TO_CLOSE, EXPIRED or EXERCISED in the ledger (E1), or by its expiration date (E2).
- Ledger gap: reads "closing entry missing" until expiration, then "expired, awaiting a closing entry". Never valued in between.

**(b) Short option.**
- Ends by BUY_TO_CLOSE, EXPIRED or ASSIGNED in the ledger (E1), or by its expiration date (E2).
- Ledger gap: same as (a).
- Assignment note: in a live feed an assigned short put disappears and the stock appears. The option lot reads pending and unvalued. The stock is valued from holdings but has no lots until the statement brings the ASSIGNED row and the stock BUY. The premium rolls into the stock's basis only then. The integrity scan already reports a position with no lots; nothing new is needed.

**(c) Short stock.**
- Ends by BUY_TO_COVER, or a BUY with IBKR close-direction evidence, in the ledger (E1).
- No date ending exists. With a ledger gap the lot stays "closing entry missing" until the entry is supplied. This is the honest reading: the cover price is unknown, so the gain is unknown.

**Long stock and ETF: unchanged.** The engine's synthetic close already ends their pending state. Their four conditions (a) to (d) stay exactly as written.

## 3. Should the engine ever mint a synthetic close for an option or a short?

**Recommendation: no. Keep today's behaviour and the test that pins it** (`tests/compute/tax-lots-statement-only-closes.test.ts`, "scope unchanged: options and bonds never mint from a statement zero"). Add the missing twin: a short stock lot never mints from a statement zero either.

Reasons:

1. **An option that goes flat has three possible outcomes with three tax treatments.** It was traded out (a gain or loss at the trade price), it expired (the whole premium is the result), or it was exercised or assigned (no result on the option; the premium moves into the stock's basis or proceeds). A zero in a snapshot cannot say which. A synthetic close would pick one and could book a gain that does not exist, and in the assignment case it would also leave the stock leg wrong.
2. **A short's direction evidence is the fragile part of this ledger.** The 2026-09-06 rule is "never infer a short from an unmatched legacy sale". A synthetic cover would turn a possibly mis-directed lot into a saved realized figure.
3. **The ruling says so.** "No saved close is written and tax inputs are not touched until a statement confirms." A statement confirms by bringing the trade. A statement zero is still a position, not a trade.
4. **The engine stays untouched.** No convention-stamp revision, no stale ledger after deploy, no new input to recompute idempotence.

The cost of saying no: a short stock with a ledger gap stays "closing entry missing" with no automatic exit. That is a visible, named gap, which is better than an estimated number. See open question 3.

## 4. Evidence

### Which holdings rows count

A pair is flat when its **newest holdings row has quantity 0** and that row is recognised evidence:

- **Live-origin zero:** a `:live` tombstone, or a zero row written by a live sync. This is today's condition (a).
- **Statement-grade zero (new, for the new classes only):** a `:stmt` tombstone, a statement row with quantity 0, or a justified legacy tombstone. This is what keeps the lot unvalued through a ledger gap.

A zero row with an unrecognised source prefix stays non-evidence, as today.

Where the zeros come from:

- **Options.** The reconciler's option pass (`reconcileClosedEquityHoldings`, pass 3) writes a `:live` tombstone for an option missing from the latest snapshot, but only when that snapshot carries at least one other option. The statement pass (pass 1) writes a `:stmt` tombstone for anything missing from a complete statement.
- **Shorts.** The equity pass (pass 2) selects candidates with `quantity != 0`, so a negative (short) row is tombstoned the same way as a long one. Short options go through pass 3 the same way.
- **TWS** writes no zero rows itself; it skips closed positions and relies on the tombstones.

### Known gaps in the evidence (accepted, not fixed here)

1. **The last option in an account.** Pass 3 needs proof that the snapshot reports options at all. When the last open option closes, the snapshot has none, so no tombstone is written. The lot keeps reading open and valued until the statement or the expiration date. Do not weaken the presence rule to fix this; guessing wrong would flatten a whole option book.
2. **An underlying split re-symbols its options.** The old-symbol contract vanishes from the live feed and a new-symbol one appears. The old lots would read "pending statement" although the position lives on under the new symbol. No money is written and holdings-based value stays right, but the chip is misleading until the statement import and the re-symbol repair (`OPTION_RESYMBOL_TARGETS`). The split is not knowable at live time, so no guard can catch it.
3. **A partial close** in live data changes nothing. Statements own trades. The integrity scan's quantity-drift check already covers a large mismatch.
4. **An undone import** can remove a `:live` tombstone whose same-date rows are gone. The lot reads open until the next sync writes the tombstone again. Self-healing.

### Interaction with the Plaid purge (built 2026-10-08)

The Plaid daily sync now deletes live-origin holdings rows, `:live` tombstones included, of an expired option in the synced account (`purgeExpiredOptionHoldings` with `liveOnly`). The TWS path's purge is wider (every row of an expired option).

This is safe under the design because of **precedence**: an option past its expiration date is always in the "expired, awaiting a closing entry" bucket and never pending. The timeline:

- Expiration day: the option still counts as live (`liveOptionExpirationSql`). A flat pair reads pending.
- The next Eastern day: the lot reads "expired, awaiting a closing entry", whatever its holdings rows say.
- One day later (the purge's grace day): the rows are deleted. The lot is already in the date-driven bucket, so nothing changes on screen.

There is no moment at which a purge turns a pending lot back into an open, valued one. A named test must hold that (T-PURGE below). Short stock is never purged by expiry, so its evidence stays.

## 5. The read model

Nothing is stored. Everything below is derived on each read, as today.

### The rule

A lot is **pending** when all of these hold:

1. It is open (`quantity_remaining > 0`).
2. Its class is one of: long stock or ETF (today's rule, unchanged); any option lot, long or short; a short stock or ETF lot. Bonds, mutual funds and cash equivalents are never pending.
3. It is not an expired option. (Expired lots belong to the expired bucket.)
4. The pair's newest holdings row is a zero of recognised evidence (section 4). For long stock, live-origin only, as today.
5. The existing guards do not skip it: the later-fill guard and the split guard, both still shared with the engine through `lib/compute/synthetic-close-guards.ts`.

Its **reason** is `closing_entry_missing` when the pair's newest statement-grade row is a zero, otherwise `awaiting_statement`. A long stock lot is only ever `awaiting_statement`.

### The key gains a side

`pendingStatementKey` is `account:security` today. It becomes `account:security:side`.

Why, given that holdings are net per pair and so the flat test itself is per pair:

- **Totals must not mix sides.** A long lot's stored dollars are a cost. A short lot's stored dollars are the proceeds of the opening sale. Adding them gives a number with no meaning.
- **The two sides can be in different states on one pair.** With a statement zero, the engine closes the long lots and leaves the short lots. One is closed, the other is "closing entry missing".
- **Counts follow the 2026-10-08 chat ruling:** a symbol held long and short is one row per side.
- **The conservation test is per side** (section 7).

Consequences for the helpers:

- `getPendingStatementPairs` returns one row per (account, security, side), with the side, the reason, the flat date and the open quantity (always positive).
- `isPendingStatementLot` loses its "a short lot never is" early return and builds the key from the lot's own `is_short`.
- The integrity scan compares NET quantity per pair, so it needs a pair-level lookup (does any side of this pair pend, and with which reason). Provide that as a second small helper next to the first; do not let the scan rebuild keys by hand.
- The Tax Lots page builds a key by hand today (the narrowed-view position count). It must call the helper.

### How a short lot's open figure reads

Stored today (unchanged): `tax_lots.cost_basis` on a short lot is the **net proceeds of the opening sale, as a positive number**. Note that `holdings.cost_basis` uses the opposite convention for a short (negative proceeds). The read model reads lots only.

Options:

1. **Report it as "short-sale proceeds", positive, in its own field, never added to a cost basis (recommended).** A pending row carries a cost figure for a long side or a proceeds figure for a short side, never both.
2. Report it as a negative basis so one sum nets long and short. Compact, but the net has no use and invites the mistake the security page's totals row was fixed for.
3. Report it as "cost basis", positive. Wrong label: it is money received, not paid.

The Open Lots table's own "cost basis" column already shows this proceeds figure for every short lot, pending or not. Relabelling that column is a separate question (open question 4).

### What excludes a pending lot

Excluded (both reasons):

- The lot's `current_value` and `unrealized_gain` (null, as today for long stock).
- The Unrealized tile on Tax Lots, in both the whole-book summary and the narrowed (account or security) reducer.
- Chat: the tax-lot tool's value and gain; the summary's open-lot count and cost basis; harvesting candidates; lots approaching long-term.
- The security page's basis-disagreement check (already skips an account with a pending lot).

Not changed:

- Realized totals. Nothing is added; only saved closes count.
- The open-lot count on the tile. A pending lot is still open in the ledger and still listed.
- Every holdings-based figure (portfolio value, Today, Accounts, valuations, option views). They already show the pair flat.
- `tax_lots`, `tax_lot_sales`, `transactions`, `tax_input_generation`, the convention stamp.

Integrity scan ("open lots with no matching position"):

- `awaiting_statement` → the existing `statement-lag` hit. Informational. Never caps the score.
- `closing_entry_missing` → a warning with its own typed kind and plain wording. Warnings never cap the score today, and that stays. It is a real ledger gap, so it must not read as "just wait".

## 6. Surfaces and wording

All copy lives in `app/dashboard/components/pending-statement-copy.ts` so the surfaces read as one thing. Counts render through `<Count>`, dollars through `<Money>`, quantities through `<Shares>`.

| Surface | Today | After |
|---|---|---|
| **Tax Lots, Open Lots row** | Chip "pending statement" on long stock lots | Same chip on options and shorts when `awaiting_statement`. New chip **"closing entry missing"** when `closing_entry_missing`. A short lot keeps its "Short sale" chip beside it. Value and unrealized cells stay empty. |
| **Chip hover text (supplement only)** | "Closed per live broker data — the closing trade is not imported yet. …" | Unchanged for `awaiting_statement`. For the new reason: "The broker statement shows this position closed, but the ledger has no closing trade (a sale, a purchase to close or cover, an expiry or an assignment). These lots are left out of Unrealized and add nothing to Realized until that entry is imported." |
| **Tax Lots summary line** | "Positions closed per live data: N — awaiting statement (X cost basis, excluded from Unrealized)." | Same sentence. The bracket names each side that is present: "X cost basis on long lots" and "Y short-sale proceeds on short lots". Never one combined figure. |
| **Tax Lots, new second line** | none | "Positions the statement shows closed with no closing entry: N (same bracket). Import or enter the closing trade. Nothing is realized until then." Shown only when N is above zero. |
| **"Show pending only" link** | Narrows the table to pending lots | Narrows to both reasons. |
| **Tax Lots, expired line** | "N expired contracts awaiting a closing entry: …" | Unchanged. An option that was pending moves here the day after it expires. |
| **Security page, "no current position" note** | "The broker's live data shows the position closed; the lots stay open until the statement with the closing trade is imported." | Unchanged for `awaiting_statement`. For the new reason: "The broker statement shows the position closed, but the ledger has no closing trade. The lots stay open and unvalued until it is imported." |
| **Security page, lot row** | Chip in place of the unrealized figure | Same, with the chip that matches the reason. |
| **Data confidence popover and Data Health page** | Chip "awaiting statement" + "closed per live data — awaiting statement" | Unchanged for `awaiting_statement`. New chip "closing entry missing" + "statement shows closed — closing trade not in the ledger". |
| **Chat, tax-lot tool note** | "Pending statement: this position was closed per live broker data, awaiting the broker statement for the closing trade. …" | Unchanged for `awaiting_statement` (it already fits an option or a short). New note: "Closing entry missing: the broker statement shows this position closed, but the closing trade is not in the ledger. It is not a holding, and its realized result is unknown until that entry is imported." A short lot's row names its figure as proceeds. |
| **Chat system prompt** | One sentence about `pending_statement = true` | Add: the flag covers options and short positions too, and a short lot's figure is sale proceeds, not cost. |
| **Chat portfolio summary** | A separate pending line with a cost basis | Same line, split by side like the Tax Lots line; a second line for the new reason. |

Implementation note for whoever builds it: keep the existing boolean `pending_statement` true for BOTH reasons, and add the reason beside it. Every exclusion that works today then keeps working untouched, and only the wording branches.

## 7. Conservation and invariants (named test requirements)

- **T-NOWRITE.** Seed each class (long option, short option, short stock) in each state. Take a digest of `tax_lots`, `tax_lot_sales`, the `RECONCILE_CLOSE` rows, `tax_input_generation` and the convention stamp. Call every read function this design touches. The digest is identical.
- **T-QTY.** For every (account, security, side), the sum of `quantity_remaining` in the table equals the sum reported as open-and-valued, plus pending, plus expired-awaiting-close. The read model moves no quantity.
- **T-ONE-STATE.** Every lot is in exactly one of: open and valued; pending statement (either reason); expired, awaiting close; closed. Driven as a matrix of class by evidence. Precedence when two could apply: closed, then expired, then pending, then open.
- **T-MONEY.** The Unrealized total with the model off, minus the Unrealized total with it on, equals the summed unrealized of exactly the pending lots. Realized totals are equal with the model on or off.
- **T-NO-MINT.** After `computeTaxLots`, an option pair and a short stock pair whose newest statement-grade row is zero have no `RECONCILE_CLOSE`. (The existing option test, plus the short twin.)
- **T-IDEMPOTENT.** Two engine runs on one database with pending option and short pairs seeded give an identical `source_key` digest. Adding or removing `:live` tombstones for those pairs changes neither the generation nor the engine output.
- **T-GAP (the blocker's regression test).** A statement-grade zero as the newest row, no closing entry: the lot is pending with reason `closing_entry_missing`, not valued, for each of the three classes.
- **T-ENDS.** One test per ending per class: E1 closes the lot; E2 moves an option to the expired bucket; E3 and E4 return the lot to open and valued.
- **T-PURGE.** Run the scoped Plaid purge on a pending option the day after expiry plus the grace day. The lot's state before and after is the same (expired, awaiting close). Statement rows are untouched.
- **T-SIDE.** One security long in one account and short in another: each account's lots are judged alone. One pair with long and short lots and a statement zero: after a recompute the long side is closed and the short side is `closing_entry_missing`.
- **T-SCOPE.** `accountIds` is respected; an empty scope selects nothing (existing tests, extended to the new classes).
- **T-STOCK-UNCHANGED.** Every existing long-stock test in the files listed in section 8 passes without an edit.

Money-direction statement for the spec, in words: the design creates and destroys nothing. Dollars only move between two display buckets ("unrealized" and "pending, not valued"), and T-MONEY pins that the two always add back to the whole.

## 8. Tests

**Rewritten on purpose** (each pins the old long-only rule the ruling changes):

- `tests/queries/pending-statement.test.ts`
  - "short lots are never pending" → a short stock lot under a live zero IS pending, side short.
  - "a %s is never pending" → remove Option from the list. Bond, Mutual Fund and Money Market stay.
  - "statement-grade zero as the newest statement-grade row: never pending, even under a newer live zero" → stays true for long stock; add the option and short twins that read `closing_entry_missing`.
  - "pendingStatementKey is the account:security key surfaces join on" → the key now carries the side.
  - The file's header comment ("it holds long stock/ETF lots").
- `tests/queries/tax-lots-pending-statement.test.ts`, `tests/queries/chat-pending-statement.test.ts`, `tests/queries/integrity-checks-statement-lag.test.ts`, `tests/dashboard/tax-lots-pending-statement.test.tsx`: extend with option and short cases and the second reason. Their long-stock assertions must not change.
- The parent spec's invariant 10 ("a short lot, an option … are never pending") is superseded by this document for options and shorts. Add a pointer line there when this is built.

**Must stay green untouched:**

- `tests/compute/tax-lots-statement-only-closes.test.ts` (whole file; the engine does not change).
- `tests/integration/statement-only-closes-determinism.test.ts`.
- `tests/repo/synthetic-close-consumers.test.ts` (no new `RECONCILE_CLOSE` consumer).
- `tests/repo/no-handrolled-latest-holdings.test.ts`. The read model's "newest row of the pair" lookup is per pair and already lives in the single helper; no new call site may hand-roll one.
- `tests/pages/tax-lots-page-currency-expired-options.test.ts` (the expired line is unchanged).
- `tests/queries/security-detail-position-totals.test.ts` (short totals and the "all pending" marker).
- `tests/db/holding-sources.test.ts`, the reconciler tests, the Plaid purge tests.

Fixtures are synthetic only (invented tickers, round amounts), per the public-repo rule.

## 9. Rollout

- **Read-model only.** Files expected to change: `lib/queries/pending-statement.ts`, its consumers (`lib/queries/tax-lots.ts`, `portfolio-summary.ts`, `chat-tools.ts`, `integrity-checks.ts`, `security-detail.ts`), the copy module, the Tax Lots page and its two components, the security page, the data-confidence popover, the Data Health page, and one sentence in the chat system prompt (query and prompt text only; the protected chat route and component are not touched).
- **No migration. No flag. No engine change. No stamp revision.** The stored ledger does not go stale at deploy.
- **No Worker change.** The Worker reads none of this.
- **Reversible** by reverting the commit; nothing stored depends on it.

**Rehearsal on a VACUUM copy of the live database** (figures go to gitignored `docs/private/`, never to a committed file):

1. Digest `tax_lots`, `tax_lot_sales`, the synthetic-close rows and the generation before and after loading every changed page. Identical.
2. List the pairs that are newly pending, by class and reason. Check each against what the broker shows today.
3. The Unrealized tile's change equals the summed unrealized of the newly excluded lots (T-MONEY on real data).
4. The open-lot count on the tile is unchanged.
5. No long stock or ETF pair changes state.
6. Count lots by state. The four counts add up to the number of lots.
7. Look hard at any pair that lands on `closing_entry_missing`. Each one is a real ledger gap to list for the owner; none should be "fixed" by the build.
8. Recompute twice on the copy. The `source_key` digest is identical, and identical to a recompute on a copy without this change.
9. Browser pass on the sandbox: Tax Lots (both chips, both lines, the filter link, hide-amounts mode), a security page for one option and one short, the data-confidence popover, and a chat question about an affected position.

## 10. Out of scope

- Any engine change, any synthetic close for an option or a short, any repair of stored lots.
- Partial closes seen only in live data.
- Relabelling the "cost basis" column for short lots in general.
- Fixing the "last option in the account" and option re-symbol evidence gaps.
- Long stock pairs that the engine's split guard skips (they read open and valued today; see open question 6).

Noticed while reading, not part of this design: the chat summary's harvesting and approaching-long-term queries compute a lot's gain as value minus cost with no sign flip for a short lot, so a winning short can appear as a loss candidate. Worth its own finding.

## 11. Open questions for the owner

1. **What ends the pending state?** Recommendation: Option A. Only the closing entry, an option's expiration date, a newer non-zero holdings row or a later imported fill ends it. A statement zero alone never returns a lot to "open and valued".
2. **Two wordings or one?** Recommendation: two. "Pending statement" while only live data says flat; "closing entry missing" once a statement also says flat and the trade is still absent. Same exclusion from every total.
3. **Should a short stock ever get a synthetic cover from a statement zero, as a long stock gets a synthetic sale?** Recommendation: no, for now. Keep the engine unchanged and pin it with a test. Look again if short stocks are found sitting on "closing entry missing" often.
4. **How does a pending short's dollar figure read?** Recommendation: as "short-sale proceeds", positive, in its own figure, never added to a long cost basis. (Relabelling the Open Lots column for all short lots is a separate, optional follow-up.)
5. **How loud is "closing entry missing" in data confidence?** Recommendation: a warning with its own label. It does not cap the score, like every warning today.
6. **Should long stock pairs that the engine's guards skip also read "closing entry missing"?** Today they read open and valued, which is the same blocker in a rarer form. Recommendation: yes, but as a separate small ruling and build, because it changes a pinned long-stock test.
7. **An option traded out before expiry moves to "expired, awaiting a closing entry" after its expiration date.** The wording is slightly loose for a contract that was sold, not expired. Recommendation: accept it. One date-driven bucket is simpler and the purge makes any other choice fragile.
8. **The "last option in the account" gap** (no tombstone, so the lot stays valued until the statement or expiry). Recommendation: accept and document. Do not weaken the presence rule.
9. **What is one "position" in the counts?** Recommendation: one account, one security, one side.
