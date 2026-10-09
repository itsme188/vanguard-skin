# A live-closed option or short reads as pending a statement — design (2026-10-08)

Status: for the owner to rule on. Nothing in this document is approved. No code is written. Direction-only: no figure from the real book appears here.

Revised 2026-10-08 after an independent design review (section 12). The review's ten findings are folded into the sections they belong to. The revision changes no recommendation's direction; it adds precision, one more reason label and several named tests. It still awaits the owner.

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
- **Re-symbol**: after a split of the underlying, the broker replaces a listed option with a new contract under a new symbol (strike and contract count rescaled). The position lives on; only its name changes.
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

### Three reasons, one state

Under Option A a pending lot carries exactly one reason. All are unvalued. All write nothing. The first two are the design's core; the third is a narrow guard added by the review (section 4, gap 2).

- **`awaiting_statement`** — only live data says flat. The pair's newest statement-grade row is not a zero. Expected, and it resolves itself. Wording: "pending statement" (today's chip).
- **`closing_entry_missing`** — the pair's newest statement-grade row is a zero and the lot is still open. The statement has come; the trade has not. This needs the owner to act (import the right file, or transcribe the entry). Wording: "closing entry missing".

- **`resymbol_repair_pending`** — the lot is an option under an old symbol that a known re-symbol mapping names, and the new-symbol contract is held in the same account. The position is not closed at all. It was renamed, and the ledger has not been moved yet. Wording: "re-symbolled — repair pending". This reason wins over the other two when it applies.

Keeping these apart matters. "Pending statement" after the statement has been imported would be false, and it would hide a real ledger gap behind a label that says "wait". "Closing entry missing" on a re-symbolled option would send the owner looking for a trade that never happened.

### By class

**(a) Long option.**
- Ends by SELL_TO_CLOSE, EXPIRED or EXERCISED in the ledger (E1), or by its expiration date (E2).
- Ledger gap: reads "closing entry missing" until expiration, then "expired, awaiting a closing entry". Never valued in between.

**(b) Short option.**
- Ends by BUY_TO_CLOSE, EXPIRED or ASSIGNED in the ledger (E1), or by its expiration date (E2).
- Ledger gap: same as (a).
- Assignment note: in a live feed an assigned short put disappears and the stock appears. The option lot reads pending and unvalued. The stock is valued from holdings but has no lots until the statement brings the ASSIGNED row and the stock BUY. The premium rolls into the stock's basis only then. The integrity scan already reports a position with no lots; nothing new is needed in the read model.
- The ending is only correct if BOTH legs come out right: the option lot closes with no result of its own, and the premium lands on the stock leg. That is engine behaviour this design does not change, but the pending state hands over to it, so the tests must follow the money across the handover. See T-EXERCISE in section 7 (four cases: assigned short put, assigned short call, exercised long call, exercised long put).

**(c) Short stock.**
- Ends by BUY_TO_COVER, or a BUY with IBKR close-direction evidence, in the ledger (E1).
- No date ending exists. With a ledger gap the lot stays "closing entry missing" until the entry is supplied. This is the honest reading: the cover price is unknown, so the gain is unknown.
- **A cover booked to a different account does not end it.** The engine matches lots inside one account only. A BUY_TO_COVER in account B never closes a short lot in account A; the engine reports it as a closing quantity with nothing to close. So the short lot in A stays pending, and that is correct: its own account's ledger still has no cover. What must NOT happen is silence. The integrity scan raises a separate **account-mismatch** hit that names both accounts (section 5). It is an error to fix at the source (the entry is in the wrong account, or the transfer between the accounts is missing). It is never an ending of the pending state, and the read model never "borrows" the other account's entry. The same rule holds for an option's BUY_TO_CLOSE or SELL_TO_CLOSE booked to another account. Regression test: T-XACCT.

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
2. **An underlying split re-symbols its options.** The old-symbol contract vanishes from the live feed and a new-symbol one appears. Without a guard the old lots would read "pending statement", and after a statement that omits the old symbol they would read "closing entry missing", although the position lives on under the new symbol. That second label is worse than misleading: it asks the owner to find a trade that does not exist.

   **Decision: label it separately; do not suppress it.** When a known mapping exists (`OPTION_RESYMBOL_TARGETS` in `scripts/repair-mistyped-option-legs.ts`) whose old symbol is the lot's symbol, AND the mapped new symbol has a non-zero newest holdings row in the same account, the lot carries the reason `resymbol_repair_pending` instead of either other reason. It stays unvalued. The label goes away by itself once the repair has moved the entries and a recompute leaves no open lot under the old symbol.

   Why a label and not suppression: suppressing would return the lot to "open and valued", priced at the last quote of a symbol that no longer trades and at the pre-split contract count. That is a wrong number shown as fact. A label says the true thing (renamed, not closed) and names the right action (run the repair). The cost is that the lot's paper gain is missing from Unrealized while the position is really held; the separate disclosure line says so in words.

   Why the second condition (the new symbol is held): if the new-symbol contract is not held either, the position really is gone, and the ordinary reasons apply.

   What this does not fix: the mapping is a hand-kept list. A split nobody has recorded yet is still not knowable at live time, and for that window the old lots read under the ordinary reasons. That remainder stays an accepted gap. Where the list should live so the read model can read it is open question 10.
3. **A partial close** in live data changes nothing. Statements own trades. The integrity scan's quantity-drift check already covers a large mismatch.
4. **An undone import** can remove a `:live` tombstone whose same-date rows are gone. The lot reads open until the next sync writes the tombstone again. Self-healing.

### Interaction with the Plaid purge (built 2026-10-08)

There are two purge paths in one function (`purgeExpiredOptionHoldings`, `lib/mutations/expired-options.ts`), and they must not be confused:

- **The scoped path (Plaid only).** The Plaid daily sync passes an account and `liveOnly`. It deletes live-origin holdings rows, `:live` tombstones included, of an expired option in the synced account. Statement rows survive.
- **The wide path.** Called with no options by the TWS sync, by the import engine after a commit, and by a one-off script. It deletes EVERY holdings row of an expired option, in every account, statement rows and `:stmt` tombstones included. After it runs, an expired option's pair has no holdings evidence at all.

This is safe under the design because of **precedence**: an option past its expiration date is always in the "expired, awaiting a closing entry" bucket and never pending. The timeline:

- Expiration day: the option still counts as live (`liveOptionExpirationSql`). A flat pair reads pending.
- The next Eastern day: the lot reads "expired, awaiting a closing entry", whatever its holdings rows say.
- One day later (the purge's grace day): the rows are deleted. The lot is already in the date-driven bucket, so nothing changes on screen.

There is no moment at which a purge turns a pending lot back into an open, valued one. This holds for the wide path too, and for a stronger reason than it first looks: the wide path removes ALL evidence, so only the date-driven bucket keeps the lot from reading open. The wide path's cutoff uses the UTC date while the expired bucket uses the Eastern date. UTC is never behind Eastern, and the purge waits a full grace day, so the purge can never run before the lot is already expired in Eastern terms. Two named tests hold this, one per path (T-PURGE-PLAID and T-PURGE-WIDE below). Short stock is never purged by expiry, so its evidence stays.

## 5. The read model

Nothing is stored. Everything below is derived on each read, as today.

### The rule

A lot is **pending** when all of these hold:

1. It is open (`quantity_remaining > 0`).
2. Its class is one of: long stock or ETF (today's rule, unchanged); any option lot, long or short; a short stock or ETF lot. Bonds, mutual funds and cash equivalents are never pending.
3. It is not an expired option. (Expired lots belong to the expired bucket. This is a hard precedence rule, spelled out below.)
4. The pair's newest holdings row is a zero of recognised evidence (section 4). For long stock, live-origin only, as today.
5. The existing guards do not skip it: the later-fill guard and the split guard, both still shared with the engine through `lib/compute/synthetic-close-guards.ts`. Both are measured from the lot's **flat date**, defined per reason below.

Its **reason** is decided in this order, first match wins:

1. `resymbol_repair_pending` — the option re-symbol guard of section 4 applies.
2. `closing_entry_missing` — the pair's newest statement-grade row is a zero, and no guard fires from that row's date.
3. `awaiting_statement` — the pair's newest holdings row is a live-origin zero, and no guard fires from that row's date.

If none matches, the lot is not pending. A long stock lot is only ever `awaiting_statement`.

### Precedence: expired beats pending

An option lot past its expiration date is in the expired bucket and is **never** pending, whatever its holdings rows say. No row may carry both `pending_statement = true` and `expired_option = true`.

This has to be built, not assumed. Today the shared decorator in `lib/queries/tax-lots.ts` applies the pending flag to every row it is given, including the rows of `getExpiredOptionLotsAwaitingClose`. That is harmless only because no option can be pending today. Once options can be, an expired option with a zero row would come out with both flags.

Where the rule lives:

- **In the classifier itself.** `getPendingStatementPairs` excludes expired options with the shared `liveOptionExpirationSql` (it takes the same optional `today` the lot readers take, so a test can pin the day). An expired option is then never in the key set, for any consumer.
- **In the decorator, as a second lock.** A row decorated as expired is never also marked pending.
- **In the chat tax-lot tool.** Its open-lot query lists expired options too and attaches the expired note. It reads the same key set, so the classifier rule covers it; the test covers it by name.

Full order when two states could apply: closed, then expired, then pending, then open. Test: T-NO-DOUBLE-FLAG.

### The flat date, per reason

Today there is one date: the date of the pair's newest holdings row, which is always the live zero. The new classes can have a statement zero AND a newer live zero on one pair, so the date must be named per reason. Both guards (later imported fill, later imported split) use this date, and the comparison stays strict: a fill dated ON the flat date is not later.

| Reason | Flat date | Why |
|---|---|---|
| `awaiting_statement` | The date of the pair's newest holdings row (the live zero). | Today's rule, unchanged. |
| `closing_entry_missing` | The date of the pair's newest statement-grade row (the statement zero), even when a newer live zero exists. | The reason rests on the statement. The guard must test that evidence, not a later, weaker row. |
| `resymbol_repair_pending` | The date of the pair's newest holdings row. | Shown for information only. No guard removes this reason; only the repair does. |

The three cases the tests must name (T-FLATDATE):

1. **Statement zero only.** Newest row is a statement zero, no later fill. Reason `closing_entry_missing`, flat date = the statement date.
2. **Statement zero, then a newer live zero.** No fill after either. Reason `closing_entry_missing`, flat date = the STATEMENT date, not the live date.
3. **An imported fill between the two.** Statement zero, then an imported position-changing fill, then a live zero. The fill is later than the statement zero, so the statement zero is stale and `closing_entry_missing` does not apply. The live zero is newer than the fill, so the lot is pending with reason `awaiting_statement` and flat date = the live date. (The position was re-opened after the statement and went flat again in live data.) Without the live zero, the same fill returns the lot to open and valued: that is ending E4.

One softness is accepted in case 3: the reason is decided per pair and side, so an older lot that was a true ledger gap before the fill also reads `awaiting_statement` afterwards. It stays unvalued, which is the part that matters.

### The key gains a side

`pendingStatementKey` is `account:security` today. It becomes `account:security:side`.

Why, given that holdings are net per pair and so the flat test itself is per pair:

- **Totals must not mix sides.** A long lot's stored dollars are a cost. A short lot's stored dollars are the proceeds of the opening sale. Adding them gives a number with no meaning.
- **The two sides can be in different states on one pair.** With a statement zero, the engine closes the long lots and leaves the short lots. One is closed, the other is "closing entry missing".
- **Counts follow the 2026-10-08 chat ruling:** a symbol held long and short is one row per side.
- **The conservation test is per side** (section 7).

**The helpers (all in `lib/queries/pending-statement.ts`; no other file builds a key):**

- **Side key.** `pendingStatementKey` takes account, security and the lot's `is_short` and returns the three-part key. It is the only place the key string is written.
- **Lot lookup.** `isPendingStatementLot` loses its "a short lot never is" early return and uses the side key. A sibling returns the lot's reason (or nothing).
- **Pair-level integrity lookup.** A second helper answers, for one (account, security): does any side pend, and with which reason or reasons. The integrity scan compares NET quantity per pair, so it needs this form. It must not rebuild keys.
- **Position count.** A small helper counts distinct side keys over a list of lot rows, for the narrowed views.
- `getPendingStatementPairs` returns one row per (account, security, side), with the side, the reason, the flat date, the open quantity (always positive) and the figure with its kind.

**Every consumer that touches a key today** (checked against the code on 2026-10-08):

| File | What it does today | What changes |
|---|---|---|
| `lib/queries/pending-statement.ts` | Defines the two-part key; groups by account and security; `isPendingStatementLot` returns false for any short lot. | Three-part key; groups by side as well; the early return goes. |
| `lib/queries/tax-lots.ts` | The decorator and `getTaxLotSummary` call the helpers; the summary counts positions in a set of pair keys. | The set holds side keys (one position per side). The decorator also applies the expired precedence. |
| `lib/queries/portfolio-summary.ts` | Calls the helpers for the summary line and for the harvesting and approaching-long-term filters; counts positions in a set of pair keys; has a local `PairKeyed` row type. | Side keys throughout. The row type already carries `is_short`. |
| `lib/queries/chat-tools.ts` | Calls the helpers per lot row. | Side key; adds the reason and the figure kind to the row. |
| `lib/queries/integrity-checks.ts` | **Builds `account:security` by hand** for its own maps, then tests that same string against the pending key set. It works only because the two formats happen to match. | Calls the pair-level lookup. Its own position and lot maps may keep their local key; they must never be tested against the pending set. |
| `app/dashboard/tax-lots/page.tsx` | **Builds `account:security` by hand** to count pending positions in the narrowed view. | Calls the position-count helper. |
| `lib/queries/security-detail.ts`, `lib/compute/lot-coverage.ts` | Read the boolean already on the lot row. No key. | No key change. (Type changes: see below.) |

**Repo test (T-KEY-HELPERS):** a source-scan test, in the style of `tests/repo/no-handrolled-latest-holdings.test.ts`, fails when any file other than `lib/queries/pending-statement.ts` calls `.has(` on a pending key set directly, or imports the key set without also importing one of the lookup helpers. It lists the allowed consumers above and fails on an unlisted one, so a new surface must be classified before it ships.

### How a short lot's open figure reads

Stored today (unchanged): `tax_lots.cost_basis` on a short lot is the **net proceeds of the opening sale, as a positive number**. Note that `holdings.cost_basis` uses the opposite convention for a short (negative proceeds). The read model reads lots only.

Options:

1. **Report it as "short-sale proceeds", positive, in its own field, never added to a cost basis (recommended).** A pending row carries a cost figure for a long side or a proceeds figure for a short side, never both.
2. Report it as a negative basis so one sum nets long and short. Compact, but the net has no use and invites the mistake the security page's totals row was fixed for.
3. Report it as "cost basis", positive. Wrong label: it is money received, not paid.

The Open Lots table's own "cost basis" column already shows this proceeds figure for every short lot, pending or not. Relabelling that column is a separate question (open question 4).

### One disclosure shape, keyed by reason and side

Today the summary carries three loose numbers: pending positions, pending lots, pending basis. The design needs up to three reasons times two sides, and a short side's dollars are proceeds, not cost. Adding more loose totals for each combination would repeat the mistake section "How a short lot's open figure reads" exists to prevent: sooner or later one sum mixes a cost with proceeds.

So there is **one typed list, and no new scalar totals**. Each row is one (reason, side) and carries:

- the reason (`awaiting_statement`, `closing_entry_missing` or `resymbol_repair_pending`);
- the side (`long` or `short`);
- the number of positions (distinct account, security, side);
- the number of lots;
- one dollar figure and its **figure kind**: `cost_basis` for a long side, `short_sale_proceeds` for a short side. The kind is fixed by the side; it is stated on the row so that no reader has to infer it.

Rules:

- A (reason, side) with no lots has no row. An empty list means nothing is pending.
- No field anywhere holds a figure summed across sides. A surface that wants "how many positions pend in total" adds the rows' position counts; it never adds their dollars.
- The three existing scalars (`pendingStatementPositions`, `pendingStatementLots`, `pendingStatementBasis`) are **replaced** by the list, not kept beside it. Kept, the basis scalar would either mix sides or silently mean "long only".
- The whole-book summary, the narrowed (account or security) reducer on the Tax Lots page, and the chat portfolio summary all produce this same shape through one shared reducer over lot rows, so the three cannot disagree.

### Types and contracts that change

"Read-model only" is true of the stored data. It is not true of the interfaces: one boolean cannot carry a reason, a side or a figure kind. Each type below changes; the plan must list them the same way.

| Where | Type or contract | Change |
|---|---|---|
| `lib/queries/pending-statement.ts` | `PendingStatementPair` | Adds side, reason, figure kind. `live_flat_date` becomes `flat_date` (it can now be a statement date). `open_basis` becomes the neutral open figure. |
| `lib/queries/tax-lots.ts` | `TaxLotWithSecurity` | Keeps `pending_statement: boolean` (true for every reason). Adds `pending_statement_reason` (a reason or null) and `pending_figure_kind` (a kind or null; set only on a pending row). |
| `lib/queries/tax-lots.ts` | `PendingStatementDisclosure`, and so `TaxLotSummary` | The three scalars are replaced by the disclosure list. |
| `lib/queries/chat-tools.ts` | `TaxLotResult` (the chat tax-lot tool's row) | Keeps `pending_statement`. Adds `pending_statement_reason` and `figure_kind`. `status_note` wording branches on the reason. |
| `lib/chat/tools.ts` | The tax-lot tool's description text (the output contract the model reads) | Names the reason field and its values, and says a short lot's figure is sale proceeds. |
| `lib/chat/system-prompt.ts` | The one sentence about `pending_statement = true` | Covers options and shorts, the reasons, and the proceeds reading. |
| `lib/queries/portfolio-summary.ts` | The Tax Summary lines (plain text the model reads) and the local `PairKeyed` row type | One line per (reason, side) from the shared list. |
| `lib/queries/integrity-checks.ts` | `IntegrityHit.kind` (today only `statement-lag`) | Adds `closing-entry-missing`, `closing-entry-account-mismatch`, `resymbol-repair-pending`. |
| `lib/queries/security-detail.ts` | `LotsWithoutPosition` and the lot input of `computeLotsWithoutPosition` | `allPendingStatement` stays. Adds the reason shared by the account's lots, or a "mixed" marker when they differ, so the note can pick its wording. |
| `lib/compute/lot-coverage.ts` | `BasisDisagreementLotInput` | No change. The boolean is enough: any reason skips the account. |
| `app/dashboard/components/` | `TaxLotSummary` card props, `TaxLotTables` row, `pending-statement-copy.ts` functions | Take the list and the reason. |

The protected chat route and chat component are not in this list and are not touched.

### What excludes a pending lot

Excluded (every reason):

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
- `closing_entry_missing` → a warning with its own typed kind (`closing-entry-missing`) and plain wording. Warnings never cap the score today, and that stays. It is a real ledger gap, so it must not read as "just wait".
- `resymbol_repair_pending` → a warning with its own typed kind (`resymbol-repair-pending`): "re-symbolled after a split — repair pending". It is not a ledger gap and must not be counted as one.
- **Account mismatch (new, separate from the three reasons).** Raised when a lot of the new classes is pending in account A, and another account B holds a closing-type entry for the same security that B's own lots of the matching side cannot absorb. Kind `closing-entry-account-mismatch`. The wording names both accounts and says the entry may be booked to the wrong account or a transfer may be missing. The hit is raised IN ADDITION to the lot's pending reason; it does not replace it and does not end the pending state. How loud it is: open question 11. The exact read-only test for "cannot absorb" is for the plan to pin; it must read the ledger only, never a stored engine warning that a recompute could change.

## 6. Surfaces and wording

All copy lives in `app/dashboard/components/pending-statement-copy.ts` so the surfaces read as one thing. Counts render through `<Count>`, dollars through `<Money>`, quantities through `<Shares>`.

| Surface | Today | After |
|---|---|---|
| **Tax Lots, Open Lots row** | Chip "pending statement" on long stock lots | Same chip on options and shorts when `awaiting_statement`. New chip **"closing entry missing"** when `closing_entry_missing`. New chip **"re-symbolled — repair pending"** when `resymbol_repair_pending`. A short lot keeps its "Short sale" chip beside it. Value and unrealized cells stay empty. An expired option row never shows any of these chips. |
| **Chip hover text (supplement only)** | "Closed per live broker data — the closing trade is not imported yet. …" | Unchanged for `awaiting_statement`. For the new reason: "The broker statement shows this position closed, but the ledger has no closing trade (a sale, a purchase to close or cover, an expiry or an assignment). These lots are left out of Unrealized and add nothing to Realized until that entry is imported." |
| **Tax Lots summary line** | "Positions closed per live data: N — awaiting statement (X cost basis, excluded from Unrealized)." | Same sentence, built from the disclosure list's `awaiting_statement` rows. The bracket names each side that is present: "X cost basis on long lots" and "Y short-sale proceeds on short lots". Never one combined figure. |
| **Tax Lots, new second line** | none | "Positions the statement shows closed with no closing entry: N (same bracket). Import or enter the closing trade. Nothing is realized until then." Shown only when N is above zero. |
| **Tax Lots, new third line** | none | "Options renamed after a split, ledger not yet moved: N (same bracket). Still held under the new symbol; run the re-symbol repair." Built from the `resymbol_repair_pending` rows. Shown only when N is above zero. |
| **"Show pending only" link** | Narrows the table to pending lots | Narrows to every reason. |
| **Tax Lots, expired line** | "N expired contracts awaiting a closing entry: …" | Unchanged. An option that was pending moves here the day after it expires. |
| **Security page, "no current position" note** | "The broker's live data shows the position closed; the lots stay open until the statement with the closing trade is imported." | Unchanged for `awaiting_statement`. For the new reason: "The broker statement shows the position closed, but the ledger has no closing trade. The lots stay open and unvalued until it is imported." |
| **Security page, lot row** | Chip in place of the unrealized figure | Same, with the chip that matches the reason. |
| **Data confidence popover and Data Health page** | Chip "awaiting statement" + "closed per live data — awaiting statement" | Unchanged for `awaiting_statement`. New chip "closing entry missing" + "statement shows closed — closing trade not in the ledger". |
| **Chat, tax-lot tool note** | "Pending statement: this position was closed per live broker data, awaiting the broker statement for the closing trade. …" | Unchanged for `awaiting_statement` (it already fits an option or a short). New note: "Closing entry missing: the broker statement shows this position closed, but the closing trade is not in the ledger. It is not a holding, and its realized result is unknown until that entry is imported." A short lot's row names its figure as proceeds. |
| **Chat, re-symbol note** | none | "Re-symbolled: this option was renamed after a split of the underlying. The position is still held under the new symbol; these old-symbol lots are not valued until the ledger repair runs. Do not describe it as closed." |
| **Chat system prompt** | One sentence about `pending_statement = true` | Add: the flag covers options and short positions too, the reason field says why, and a short lot's figure is sale proceeds, not cost. |
| **Data confidence, account mismatch** | none | Its own hit: "a closing entry for this position sits in another account", naming both accounts. |
| **Chat portfolio summary** | A separate pending line with a cost basis | Same line, split by side like the Tax Lots line; a second line for the new reason. |

Implementation note for whoever builds it: keep the existing boolean `pending_statement` true for EVERY reason, and add the reason and the figure kind beside it (the full list of types is in section 5, "Types and contracts that change"). Every exclusion that works today then keeps working untouched, and only the wording branches. The boolean alone is no longer enough for any surface that prints a label or a dollar figure.

## 7. Conservation and invariants (named test requirements)

- **T-NOWRITE.** Seed each class (long option, short option, short stock) in each state. Take a digest of `tax_lots`, `tax_lot_sales`, the `RECONCILE_CLOSE` rows, `tax_input_generation` and the convention stamp. Call every read function this design touches. The digest is identical.
- **T-QTY.** For every (account, security, side), the sum of `quantity_remaining` in the table equals the sum reported as open-and-valued, plus pending, plus expired-awaiting-close. The read model moves no quantity.
- **T-ONE-STATE.** Every lot is in exactly one of: open and valued; pending statement (exactly one reason); expired, awaiting close; closed. Driven as a matrix of class by evidence. Precedence when two could apply: closed, then expired, then pending, then open.
- **T-NO-DOUBLE-FLAG (expired beats pending).** Seed a long option and a short option, each past expiration, each with a live zero, a statement zero, or both as the newest rows. Read through every lot reader: the open-lots reader, the expired-lots reader, the chat tax-lot tool and the summary reducers. No row anywhere has both `pending_statement = true` and `expired_option = true`; the expired reader's rows all have `pending_statement = false`; the pending key set contains no expired option. Run it on the expiration day too (still live, may be pending) and on the next Eastern day (expired, never pending).
- **T-MONEY.** The Unrealized total with the model off, minus the Unrealized total with it on, equals the summed unrealized of exactly the pending lots. Realized totals are equal with the model on or off.
- **T-NO-MINT.** After `computeTaxLots`, an option pair and a short stock pair whose newest statement-grade row is zero have no `RECONCILE_CLOSE`. (The existing option test, plus the short twin.)
- **T-IDEMPOTENT.** Two engine runs on one database with pending option and short pairs seeded give an identical `source_key` digest. Adding or removing `:live` tombstones for those pairs changes neither the generation nor the engine output.
- **T-GAP (the blocker's regression test).** A statement-grade zero as the newest row, no closing entry: the lot is pending with reason `closing_entry_missing`, not valued, for each of the three classes.
- **T-ENDS.** One test per ending per class: E1 closes the lot; E2 moves an option to the expired bucket; E3 and E4 return the lot to open and valued.
- **T-EXERCISE (both legs).** T-ENDS proves the option lot closes. These four prove the money lands. Each starts with the option lot pending under a live zero, imports the statement entries, recomputes, and then checks the option AND the underlying:
  - *Assigned short put.* Option lot closed with no result of its own. A stock lot exists whose basis is the strike cost LESS the premium received.
  - *Assigned short call.* Option lot closed with no result of its own. The stock sale's proceeds are the strike proceeds PLUS the premium received.
  - *Exercised long call.* Option lot closed with no result of its own. A stock lot exists whose basis is the strike cost PLUS the premium paid.
  - *Exercised long put.* Option lot closed with no result of its own. The stock sale's proceeds are the strike proceeds LESS the premium paid.
  - In all four: premium in equals premium landed (nothing realized twice, nothing lost), the pair is no longer pending, and the pending disclosure list no longer carries it. Where an existing engine test already pins a leg's arithmetic, cite it and assert the handover only; do not write a second copy of the arithmetic.
- **T-FLATDATE.** The three cases of section 5, by name: `statement-zero-only`, `statement-zero-then-newer-live-zero`, `imported-fill-between-statement-and-live-zero`. Each asserts the reason AND the flat date. Add the boundary: a fill dated on the flat date itself is not "later".
- **T-XACCT (cover in another account).** A short stock lot in account A, flat by statement. A BUY_TO_COVER for the same security in account B, where B has no short lot. After a recompute: A's lot is still open in the ledger, still pending, still unvalued; nothing is realized in either account from that entry; the integrity scan carries one `closing-entry-account-mismatch` hit naming A and B. Twin case for a short option closed by a BUY_TO_CLOSE in the other account.
- **T-RESYMBOL.** An old-symbol option lot with a known mapping, the new symbol held in the same account: reason `resymbol_repair_pending` under a live zero AND under a statement zero (never `closing_entry_missing`). Same lot, new symbol NOT held: the ordinary reason applies. Same lot, no mapping: the ordinary reason applies. After the repair and a recompute: no old-symbol lot, no label.
- **T-DISCLOSURE.** One book with all reasons on both sides. The disclosure list has one row per (reason, side) present and none for an absent one. Every row's figure kind matches its side. The whole-book summary, the narrowed reducer and the chat summary give the same list for the same scope. No field in any of the three results equals the sum of a long row's and a short row's dollars.
- **T-KEY-HELPERS.** The repo test of section 5: no file outside `lib/queries/pending-statement.ts` builds a pending key or tests a hand-built string against the pending key set; every consumer is on the allowed list.
- **T-PURGE-PLAID (scoped path only).** Run the scoped, live-only, one-account purge on a pending option the day after expiry plus the grace day. The lot's state before and after is the same (expired, awaiting close). Statement rows and other accounts' rows are untouched.
- **T-PURGE-WIDE (the TWS, import and script path).** Run the purge with no options on the same seed. EVERY holdings row of the expired option is gone, statement rows included, and the lot still reads expired, awaiting close: not open, not valued, not pending. Also assert the boundary: on the earliest clock time at which the wide purge would delete, the lot is already expired by the Eastern date.
- **T-NO-HARVEST-SHORT.** A pending short lot (stock and option, each reason) never appears among harvesting candidates or lots approaching long-term, and the chat tax-lot tool returns it with no value and no gain. Seed it both ways: once so the unsigned arithmetic would call it a loss, once a gain. It is absent both times. This holds whether or not the sign defect tracked in section 10 has been fixed.
- **T-SIDE.** One security long in one account and short in another: each account's lots are judged alone. One pair with long and short lots and a statement zero: after a recompute the long side is closed and the short side is `closing_entry_missing`.
- **T-SCOPE.** `accountIds` is respected; an empty scope selects nothing (existing tests, extended to the new classes).
- **T-STOCK-UNCHANGED.** Every existing long-stock test in the files listed in section 8 keeps its asserted VALUES. The only permitted edit is where a test reads one of the three replaced scalars or the two-part key: it reads the same number from the long, `awaiting_statement` row of the disclosure list instead. No expected figure changes.

Money-direction statement for the spec, in words: the design creates and destroys nothing. Dollars only move between two display buckets ("unrealized" and "pending, not valued"), and T-MONEY pins that the two always add back to the whole.

## 8. Tests

**Rewritten on purpose** (each pins the old long-only rule the ruling changes):

- `tests/queries/pending-statement.test.ts`
  - "short lots are never pending" → a short stock lot under a live zero IS pending, side short.
  - "a %s is never pending" → remove Option from the list. Bond, Mutual Fund and Money Market stay.
  - "statement-grade zero as the newest statement-grade row: never pending, even under a newer live zero" → stays true for long stock; add the option and short twins that read `closing_entry_missing`.
  - "pendingStatementKey is the account:security key surfaces join on" → the key now carries the side.
  - Any assertion on `live_flat_date` → the field is `flat_date`, with the per-reason rule.
  - The file's header comment ("it holds long stock/ETF lots").
- `tests/queries/tax-lots-pending-statement.test.ts`, `tests/queries/chat-pending-statement.test.ts`, `tests/queries/integrity-checks-statement-lag.test.ts`, `tests/dashboard/tax-lots-pending-statement.test.tsx`: extend with option and short cases and the second reason. Their long-stock assertions keep their values (see T-STOCK-UNCHANGED for the one permitted kind of edit).
- New files: the repo test for key helpers (T-KEY-HELPERS), and the both-legs assignment and exercise cases (T-EXERCISE), which sit with the engine tests because they recompute.
- The parent spec's invariant 10 ("a short lot, an option … are never pending") is superseded by this document for options and shorts. Add a pointer line there when this is built.

**Must stay green untouched:**

- `tests/compute/tax-lots-statement-only-closes.test.ts` (whole file; the engine does not change).
- `tests/integration/statement-only-closes-determinism.test.ts`.
- `tests/repo/synthetic-close-consumers.test.ts` (no new `RECONCILE_CLOSE` consumer).
- `tests/repo/no-handrolled-latest-holdings.test.ts`. The read model's "newest row of the pair" lookup is per pair and already lives in the single helper; no new call site may hand-roll one.
- `tests/pages/tax-lots-page-currency-expired-options.test.ts` (the expired line is unchanged).
- `tests/queries/security-detail-position-totals.test.ts` (short totals and the "all pending" marker).
- `tests/db/holding-sources.test.ts`, the reconciler tests, the existing purge tests for both paths (the two new purge assertions are added beside them, not in place of them).
- `tests/scripts/repair-mistyped-option-legs.test.ts` (the repair itself does not change; if the mapping list moves under open question 10, its values must be byte-identical).

Fixtures are synthetic only (invented tickers, round amounts), per the public-repo rule.

## 9. Rollout

- **Read-model only.** Files expected to change: `lib/queries/pending-statement.ts`, its consumers (`lib/queries/tax-lots.ts`, `portfolio-summary.ts`, `chat-tools.ts`, `integrity-checks.ts`, `security-detail.ts`), the copy module, the Tax Lots page and its two components, the security page, the data-confidence popover, the Data Health page, the chat tool's description text, and one sentence in the chat system prompt (query and prompt text only; the protected chat route and component are not touched). The interface changes are listed type by type in section 5. Depending on open question 10, one small module holding the re-symbol mapping.
- **No migration. No flag. No engine change. No stamp revision.** The stored ledger does not go stale at deploy.
- **No Worker change.** The Worker reads none of this.
- **Reversible** by reverting the commit; nothing stored depends on it.

**Rehearsal on a VACUUM copy of the live database** (figures go to gitignored `docs/private/`, never to a committed file):

1. Digest `tax_lots`, `tax_lot_sales`, the synthetic-close rows and the generation before and after loading every changed page. Identical.
2. List the pairs that are newly pending, by class and reason. Check each against what the broker shows today.
3. The Unrealized tile's change equals the summed unrealized of the newly excluded lots (T-MONEY on real data).
4. The open-lot count on the tile is unchanged.
5. No long stock or ETF pair changes state.
6. Count lots by state. The four counts add up to the number of lots. Within pending, the per-reason, per-side counts add up to the pending count.
7. Look hard at any pair that lands on `closing_entry_missing`. Each one is a real ledger gap to list for the owner; none should be "fixed" by the build. List separately any pair on `resymbol_repair_pending` and any account-mismatch hit; check each by hand against the broker.
7a. Confirm no row on any page carries both the pending and the expired flag.
8. Recompute twice on the copy. The `source_key` digest is identical, and identical to a recompute on a copy without this change.
9. Browser pass on the sandbox: Tax Lots (both chips, both lines, the filter link, hide-amounts mode), a security page for one option and one short, the data-confidence popover, and a chat question about an affected position.

## 10. Out of scope

- Any engine change, any synthetic close for an option or a short, any repair of stored lots.
- Partial closes seen only in live data.
- Relabelling the "cost basis" column for short lots in general.
- Fixing the "last option in the account" gap, and catching a re-symbol that nobody has recorded in the mapping yet. (A recorded re-symbol IS handled: section 4, gap 2.)
- Repairing an entry booked to the wrong account. The design only reports it.
- Long stock pairs that the engine's guards skip (they read open and valued today). Not in this slice, but scheduled as the slice immediately after it; see open question 6.

### Tracked separately: short lots have no sign flip in three chat queries

This is its own item, not part of this build, and it must be filed in the backlog under its own name when this design is ruled on.

- **What.** Three queries compute a lot's gain as value minus cost with no sign flip for a short lot: the chat summary's harvesting-candidates query and its approaching-long-term query (`lib/queries/portfolio-summary.ts`), and the open-lots query of the chat tax-lot tool (`lib/queries/chat-tools.ts`). The review named the first two; the third was found while checking them. The Tax Lots page's own readers do flip the sign.
- **Effect.** A short that is winning (price fell) shows as a loss, and can be offered as a harvesting candidate. A short that is losing shows as a gain. Held shorts are affected today, with or without this design.
- **Why it is tracked here.** This design makes short lots pending for the first time. A pending short must never reach those lists at all, so the gap must not leak through the new state.
- **Coverage requirement on THIS build (T-NO-HARVEST-SHORT, section 7).** A pending short lot never appears as a harvesting candidate or as approaching long-term, and the tax-lot tool reports it with no value and no gain, for every reason, whichever way the unsigned arithmetic points. The exclusion must come from the pending filter, not from the luck of the sign.
- **What the separate fix owes.** The sign flip in all three queries, a test that a winning held short is not a loss candidate, and a decision on whether a short can be a harvesting candidate at all.

## 11. Open questions for the owner

1. **What ends the pending state?** Recommendation: Option A. Only the closing entry, an option's expiration date, a newer non-zero holdings row or a later imported fill ends it. A statement zero alone never returns a lot to "open and valued".
2. **Two wordings or one?** Recommendation: two. "Pending statement" while only live data says flat; "closing entry missing" once a statement also says flat and the trade is still absent. Same exclusion from every total. (The review added a narrow third label for a re-symbolled option; see question 10.)
3. **Should a short stock ever get a synthetic cover from a statement zero, as a long stock gets a synthetic sale?** Recommendation: no, for now. Keep the engine unchanged and pin it with a test. Look again if short stocks are found sitting on "closing entry missing" often.
4. **How does a pending short's dollar figure read?** Recommendation: as "short-sale proceeds", positive, in its own figure, never added to a long cost basis. (Relabelling the Open Lots column for all short lots is a separate, optional follow-up.)
5. **How loud is "closing entry missing" in data confidence?** Recommendation: a warning with its own label. It does not cap the score, like every warning today.
6. **Should long stock pairs that the engine's guards skip also read "closing entry missing"?** Today they read open and valued, which is the same blocker in a rarer form: stronger evidence says flat, and the lot still shows a paper gain. Recommendation: yes, **scheduled as the slice immediately after this one**. It is kept out of this slice only because it changes a pinned long-stock test and so needs its own ruling; it is not left as a loose follow-up. If the owner rules yes, it enters the plan queue directly behind this build and reuses this build's reason, disclosure list and key helpers unchanged.
7. **An option traded out before expiry moves to "expired, awaiting a closing entry" after its expiration date.** The wording is slightly loose for a contract that was sold, not expired. Recommendation: accept it. One date-driven bucket is simpler and the purge makes any other choice fragile.
8. **The "last option in the account" gap** (no tombstone, so the lot stays valued until the statement or expiry). Recommendation: accept and document. Do not weaken the presence rule.
9. **What is one "position" in the counts?** Recommendation: one account, one security, one side.

Questions the review's findings exposed (new on 2026-10-08):

10. **A re-symbolled option: label it, or hide the state?** And where does the mapping live? Recommendation: label it "re-symbolled — repair pending", unvalued, in its own line (reasons in section 4, gap 2). The mapping is a constant inside a repair script today, and nothing under `lib/` reads from `scripts/`. Recommendation: move the list, values unchanged, into one small module under `lib/` that both the repair script and the read model import. That is a small edit to a repair script, which this design otherwise does not touch, so it needs a yes.
11. **How loud is a closing entry booked to another account?** It is an error, not a wait: one account shows a short that is covered, another shows a cover with nothing to close. Recommendation: critical, so it caps the data-confidence score until fixed, unlike "closing entry missing". The alternative is a warning with its own label.
12. **The three existing summary numbers are replaced by one list.** The review asked for one typed shape and no new loose totals. Replacing (not keeping) the old three means a few existing long-stock tests change the field they read, though not the value they expect. Recommendation: replace. Keeping them would leave a "basis" number that either mixes sides or silently means long only.

## 12. Review log

**2026-10-08 — reviewer: Codex (independent, read-only). Verdict: REVISE.**

The reviewer agreed with the main recommendation (Option A) and with the recommendations on owner questions 1 to 5 and 7 to 9. On question 6 it agreed in substance and asked that it be scheduled, not left loose; the recommendation now says so. All ten findings were accepted. Each was checked against the code it cites before folding; all ten are correct about the code.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | High | An expired option could carry both the pending and the expired flag, because the shared decorator flags every row it is given. | Folded in section 5 ("Precedence: expired beats pending"); test T-NO-DOUBLE-FLAG in section 7. |
| 2 | High | The disclosure shape could not carry a reason and a side. | Folded in section 5 ("One disclosure shape, keyed by reason and side"); section 6 lines; test T-DISCLOSURE. |
| 3 | High | The side-aware key must replace every pair key, not only the helper. | Folded in section 5 ("The key gains a side": helpers, consumer table, repo test T-KEY-HELPERS). |
| 4 | High | A short covered in a different account was not defined. | Folded in section 2 (class c) and section 5 (integrity scan: account mismatch); test T-XACCT. |
| 5 | Medium | The option re-symbol risk was only acknowledged. | Folded in section 4 (gap 2: labelled separately, with the reason for not suppressing), sections 2, 5 and 6; test T-RESYMBOL. |
| 6 | Medium | Assignment and exercise tests covered the option leg only. | Folded in section 2 (class b) and section 7 (T-EXERCISE, four cases, both legs). |
| 7 | Medium | The later-fill guard had no precise flat date once a statement zero and a live zero can coexist. | Folded in section 5 ("The flat date, per reason"); test T-FLATDATE with the three named cases. |
| 8 | Medium | "Read-model only" still needs interface changes. | Folded in section 5 ("Types and contracts that change"); section 6 implementation note; section 9. |
| 9 | Low | The purge test's wording covered only the scoped path. | Folded in section 4 (two purge paths) and section 7 (T-PURGE-PLAID and T-PURGE-WIDE). |
| 10 | Low | The short-sign gap in the chat queries should be tracked with this rollout's tests. | Folded in section 10 (tracked item) and section 7 (T-NO-HARVEST-SHORT). |

Not folded: none.

Notes from checking the findings against the code:

- Finding 1 is harmless today (no option can be pending yet). It becomes a real defect the moment options are admitted, which is why the rule is placed in the classifier and not only in the decorator.
- Finding 4: the engine reports a cover with no lot to close as an unmatched closing quantity. The reviewer's other suggested outcome, an unrelated long lot being opened, was not confirmed in the code and the design does not rely on it.
- Finding 9: the wide purge path is used by the TWS sync, the import engine and a one-off script, not by TWS alone.
- Finding 10: a third query with the same missing sign flip (the chat tax-lot tool) was found while checking and added to the tracked item.
