# Pending lots for options and shorts: implementation plan (2026-10-26, revision 2)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Each task below is one subagent. Tasks in the same wave edit no common file and are dispatched together in one message. Verification is a barrier AFTER each wave (section 4), not inside it. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md`. Read sections 2, 4, 5 and 7 before any task. Section numbers and test names (T-GAP, T-FLATDATE, ...) refer to it. Where the rulings in section 1A below differ from the spec, the rulings win.

**Rulings this plan builds:** `docs/DECISIONS.md` 2026-10-26 item 2. All twelve recommendations of spec §11 are accepted: Option A (a statement zero alone never returns a lot to "open and valued"), two wordings plus the re-symbol label, no synthetic close for an option or a short, a short's figure reads as "short-sale proceeds", "closing entry missing" is a non-capping warning, an account-mismatch hit is CRITICAL, one position = one account + one security + one side, the three summary scalars are replaced by one list, and the re-symbol mapping moves (values unchanged) into one `lib/` module. PR #123's rule (a long lot under a LIVE-origin short row is pending, DECISIONS 2026-10-23) is confirmed as an instance of Option A and is kept. Question 6 (long stock skipped by the engine's guards) is a separate slice queued directly after this one (Part 2).

**Architecture in one paragraph.** Nothing is stored and the engine does not change. `lib/queries/pending-statement.ts` becomes a classifier over (account, security, side): it reads the pair's newest holdings row, the pair's newest statement-grade row, the side-matching ledger evidence and the re-symbol mapping, and returns one row per pending side with a reason (`awaiting_statement`, `closing_entry_missing`, `resymbol_repair_pending`), a flat date and a figure with its kind. Every surface reads it through one index object and one shared disclosure reducer. Every lot that is not ordinary-open (pending for any reason, or an expired option awaiting its closing entry) carries a NULL value and NULL unrealized gain in the read model itself, not only on screen.

**Revision history.** Revision 1 (`18a68c4d`) was reviewed by Codex on 2026-10-26: verdict "revise before implementation", nine findings (F1 to F9). Revision 2 folds all nine and the controller's rulings on them (section 1A). The per-finding change list is in section 8.

---

## 0. Financial logic, re-derived (read before briefing any coder)

Checked against `lib/compute/tax-lots.ts` on 2026-10-26.

1. **A short lot's stored figure is net proceeds, positive.** The engine opens a short lot with `cost_basis` = the opening sale's net leg (gross proceeds less fees, `netLegDollars(..., "short_open")`). On a cover it books `proceeds = stored lot dollars`, `cost_basis_allocated = what the cover paid`, so `gain = proceeds - cover cost`. The remaining share is `cost_basis * quantity_remaining / quantity_acquired` (`remainingLotBasisSql`): for a short, the remaining short-sale proceeds. Label: "short-sale proceeds" (spec Q4). `holdings.cost_basis` for a short is stored NEGATIVE by the live syncs; the read model reads lots only.
2. **A short's unrealized figure** is `sign * (current value - remaining figure)` with sign -1 (`lotSideSignSql`): proceeds minus cost to cover. A pending lot has none.
3. **Expiry.** `EXPIRED` closes an option lot at price 0: a long option realizes minus the premium paid, a short option plus the premium received (E1 when imported). Without the row, the date alone moves the lot (E2): from the Eastern day after expiration it is in `getExpiredOptionLotsAwaitingClose`, never pending, and (ruling R1) never valued.
4. **Exercise and assignment: rollover is CONDITIONAL, not guaranteed.** When it works, the option lot closes with zero result (`proceeds = cost_basis_allocated`) and the premium moves to the stock leg: long call +premium to stock basis, short put -premium from stock basis, long put -premium from sale proceeds, short call +premium to sale proceeds (pinned by the four linked cases in `tests/compute/tax-lots-options.test.ts`). It does NOT happen when:
   - the `EXERCISED`/`ASSIGNED` row has a null or zero price: `computeExerciseLinks` skips the link (`continue`, no warning) and the option close keeps its own realized result (the whole premium);
   - no underlying stock leg is found, or the linked leg opened no lot, or the linked sale cannot still be adjusted: the premium stays realized on the option close and the engine pushes a replay warning.
   In both cases the option lot still closes, so it leaves pending correctly, but a realized figure appears on the option that a complete ledger would have rolled into the stock. **How the owner learns of it today:** replay warnings are returned only by the import route (`app/api/import/route.ts`, shown in the import flow) and the donation recompute; the Tax Lots "Recompute" route drops them; the price-less skip warns nowhere. This build adds a ledger-only integrity warning for the price-less case (Task 8) and records the rest as OPEN-9. No engine change.
5. **Engine routing, verified (what can end pending).** Opening loader (`buys`, needs a non-null price and quantity): `BUY`, `REINVESTMENT`, `BUY_TO_OPEN`, `TRANSFER_IN` open LONG lots; `SELL_TO_OPEN`, `SHORT_SELL` open SHORT lots. Closing loader (`sells`): `SELL`, `SELL_TO_CLOSE`, `REDEMPTION` close long; `BUY_TO_COVER`, `BUY_TO_CLOSE` close short; `EXPIRED`, `EXERCISED`, `ASSIGNED` close either side (price may be null). For stock, ETF and option rows, IBKR direction evidence in `notes` (`readIbkrTradeDirection`) overrides the type: open-only evidence opens (a buy long, a sell short), close-only evidence closes (a buy covers a short, a sell closes a long), mixed evidence closes the existing side and opens only the residual, or warns and does nothing when it cannot split. A plain `BUY` with no evidence opens a NEW long lot and never covers a short. **`TRANSFER_OUT` is not replayed as a close by the trade loader**; outbound in-kind lots leave only through the donation consumption events (donation assignments). `TRANSFER_IN` opens a long lot only when it carries a price. Closes match within one account only, FIFO, chronologically, with import-sourced splits replayed end-of-day.
6. **Conservation.** The build moves no quantity and no stored dollar. On screen, a pending lot's foregone unrealized gain leaves the Unrealized tile; the pending line shows a different figure (basis or proceeds). What is conserved is the unrealized arithmetic over all open lots (T-MONEY states it exactly); the displayed pending figure is a disclosure, not a term of that sum.

---

## 1. Spec drift: what changed in the code since 2026-10-08

| # | Spec says | Code today (2026-10-26) | Effect on this plan |
|---|---|---|---|
| D1 | Condition (a) is "newest row is a live-origin ZERO". | PR #123 (`ee0ad38d`, 2026-10-23): `h.quantity <= 0`. A long lot under a live-origin SHORT row is pending. | Flat test is side-aware: for a long side a live row with quantity <= 0, for a short side a live row with quantity >= 0. A STATEMENT-grade row counts only at exactly zero (DECISIONS 2026-10-23). Task 3. |
| D2 | §10: three chat queries lack the short sign flip; file it separately. | Fixed 2026-10-08 (`d62bdefd`, `7a9f048b`; DECISIONS 2026-10-08 item 2). | No backlog item. T-NO-HARVEST-SHORT kept, with positive controls (F8). Task 6. |
| D3 | §4: the wide purge path uses the UTC date. | Both purge paths bind `todayET()` (2026-10-09); the no-options path takes no `today`. | Boundary is Eastern on both sides. T-PURGE-WIDE pins the day with `vi.setSystemTime`. Task 12. |
| D4 | §5 lists `chat-tools.ts` as "per lot row". | `getClosedPerLiveDataForChat` seeds from its own `zeroRows` query AND merges `getPendingStatementPairs`; builds a side-less key; reads `live_flat_date`. | Task 7 applies reason-aware, side-aware exclusions to BOTH sources (ruling R3). |
| D5 | §5: the integrity scan tests a hand-built key. | Still true, plus a 2026-10-19 wording branch (`d8320ff1`). | Task 8 keeps that branch for the non-pending case. |
| D6 | §5: `lot-coverage.ts` needs no change. | `computeLotSignMismatches` and `computeLotCoverageGaps` have no pending or side filter (F9). | Task 10 changes both (OPEN-1 recommendation and ruling R9). |
| D7 | Brief names `lib/queries/cost-basis-reconciliation.ts`. | The file is `lib/compute/cost-basis-reconciliation.ts`; it never reads the pending model. | Not touched (OPEN-6). |
| D8 | §5: `getPendingStatementPairs` takes `today`. | It does not; `decorateOpenLots` never passes `opts.today`. | Task 3 adds it; Task 5 threads it. |
| D9 | §9: the mapping module is open. | Ruled yes (Q10). The constant carries per-row fields; the apply step lives inside the script's CLI block; the planner targets one account and exact (date, type, quantity) rows. | Task 2 moves the array byte-identical and extracts an apply seam with unchanged behaviour (ruling R7). |
| D10 | Concurrent work. | Another agent has uncommitted edits in `lib/db/holding-sources.ts`. | No task edits that file. |
| D11 | §2 E4: "an imported position-changing fill after the flat date" ends pending; §5 the split guard also removes pending. | (Design, not code drift.) A side-blind fill list lets a plain `BUY` (which opens a separate long lot) or a later split revive an orphaned short; `TRANSFER_OUT` is in no engine close path. | Corrected by ruling R2: only side-matching evidence ends pending for the new classes; a split never does. |
| D12 | §2 class (b) and §7 T-EXERCISE assume rollover always lands. | Rollover is conditional (§0 item 4); the price-less refusal is silent; Recompute drops replay warnings. | T-EXERCISE gains incomplete-leg and refused-link cases (F5); Task 8 adds the price-less warning; OPEN-9. |

## 1A. Rulings (controller, 2026-10-26, on the Codex review). These supersede the spec where they differ.

- **R1 (F1). Not ordinary-open means unvalued, in the read model.** A lot that is pending (any reason) OR an expired option awaiting its closing entry carries `current_value = NULL` and `unrealized_gain = NULL` in the shared decorator (`lib/queries/tax-lots.ts`) and in `getTaxLotsForChat`, not merely unrendered. Test the same lot across the expiry boundary: the day before, pending and null; the day after, expired and null.
- **R2 (F2). Pending ends only on side-matching evidence** for options and shorts. Endings: the closing entry (E1; a partial close leaves the remainder pending); expiry (E2); a newer non-zero holdings row ON THE LOT'S SIDE (E3: long side, a positive row; short side, a negative row); a later imported OPENING on the lot's side (E4: long side, a `BUY` without close evidence, `REINVESTMENT`, `BUY_TO_OPEN`, a priced `TRANSFER_IN`, or a buy with open-only evidence; short side, `SELL_TO_OPEN`, `SHORT_SELL`, or a sell with open-only evidence), counted only when the engine would load it (price and quantity present). A split NEVER ends pending (the split guard stays for synthetic-close arithmetic and the long-stock path only). `TRANSFER_OUT` ends nothing (the engine does not replay it as a close). A plain `BUY` never ends a short's pending state; a plain `SELL` never ends a long's. The long stock/ETF path is unchanged in this slice (its broader guard list and split guard stay; Part 2).
- **R3 (F3). The holdings tool's "closed per live data" list** applies the same reason-aware exclusions to its `zeroRows` seed AND to the index merge: a pair is listed only when no side carries `closing_entry_missing` or `resymbol_repair_pending`, and only when the pair's newest row is exactly zero (a pair whose newest row is non-zero holds the opposite side and is never described as closed).
- **R4 (F4, replaces OPEN-3). Account-mismatch absorbability reads the engine's own matching result**, not a second whole-ledger catalogue: a closing row in account B is unabsorbed by the quantity the engine could not match, `|quantity| - Σ tax_lot_sales.quantity_sold for that sale transaction - Σ quantity_acquired of lots the engine opened from it`. This is chronological, split-adjusted and routing-exact by construction, and it is only read while the convention marker is current (the same gate as the lot-drift scan, so `tax_lot_sales` matches the ledger). A row the engine never loaded (missing quantity, or missing price on a type that needs one), or a mixed-evidence row, is UNDECIDABLE: no critical hit, at most a warning with its own label. The date floor applies to the unabsorbed row itself: its trade date must lie within [earliest acquisition date of A's pending lots on that side, A's flat date]. The hit key carries the side.
- **R5 (F5).** The rollover claim is qualified (§0 item 4). T-EXERCISE covers incomplete-leg and refused-link handovers. A ledger-only integrity warning names a price-less `EXERCISED`/`ASSIGNED` row. Surfacing Recompute's replay warnings is OPEN-9 (no engine change here).
- **R6 (F6).** T-ONE-STATE, T-QTY, T-MONEY and T-NOWRITE are restated in Task 12 with disjoint lot states, an "ordinary open" bucket that allows unknown valuation, hand-written expected states, and digests over `transactions` and `holdings` with stable identities.
- **R7 (F7).** The re-symbol script gets a minimal, behaviour-preserving apply seam. Two separate notions: the read model's reason means "a known replacement contract is held in this account" (it says nothing about which rows a script can move); "this repair supports these rows" is the script planner's answer, checked by the rehearsal. Owner-facing words say "renamed to a new contract; the ledger entries must be moved", never "run the script" unconditionally.
- **R8 (F8).** Every existing test that must change is listed with its reason (section 6). T-NO-HARVEST-SHORT has positive controls.
- **R9 (F9).** `computeLotCoverageGaps` compares a long position only with that account's long, non-pending lots; both flip directions are tested.
- **R10 (waves).** Verification is a barrier after each wave, with the expected transitional failures named (section 4). Task 6 no longer depends on Task 5: the three-way disclosure parity test moves to Task 12.
- **OPEN-2** is closed by R2; **OPEN-3** is closed by R4; **OPEN-4** keeps every reason in the hit's details; **OPEN-8** is stated as an unresolved limitation; the `capReason` test follows Codex's wording (Task 8).

---

## 2. Global constraints (every task)

- **Read-model only.** No migration, no change to `lib/compute/tax-lots.ts`, no convention-stamp revision, no Worker change, no write to `tax_lots`, `tax_lot_sales`, `transactions`, `holdings`, `settings` or `tax_input_generation`.
- **Single classifier for provenance.** Row evidence classes come from `statementGradeHoldingSql` / `liveOriginHoldingSql`, evaluated in SQL as a CASE. Never match a `source_key` prefix by hand.
- **Shared guards** in `lib/compute/synthetic-close-guards.ts` are used unchanged by the long stock/ETF path. That file is not edited.
- **One side-routing catalogue** (`lib/queries/ledger-side-routing.ts`, Task 3) answers "is this ledger row an engine-loadable opening/closing on side X". It is pinned to the engine by a parity test that runs `computeTaxLots` over a type × evidence × price-presence matrix. Task 8 reuses it; nothing else re-derives routing.
- **Latest-row lookups** are per-pair correlated or go through `latestHoldingsPredicate`. No global `MAX(as_of_date)`.
- **Option expiry** only through `lib/compute/option-expiry.ts`.
- **Account scope:** `undefined` = every account; a defined empty list = none.
- **Privacy:** `<Count>`, `<Money>`, `<Shares>`, `<QuantityUnit>`; a reason naming a symbol renders inside `<PrivateText>`.
- **Copy** lives in `app/dashboard/components/pending-statement-copy.ts` for components; lib files (chat, integrity) keep their own sentences and never import from `app/`.
- **Fixtures are synthetic.** No real symbol, account or figure in a committed file. The re-symbol constant is moved, not copied; no test restates its values.
- **Independent expected states (F6).** Every fixture that feeds a money or quantity invariant states each lot's expected state BY HAND in the test (never derived from the classifier), and the test first asserts the classifier agrees.
- **Test command prefix:** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH`. Tests use `:memory:` SQLite with the migrated schema.
- **Git:** pathspec commits only (`git add <paths> && git commit -F <msgfile> -- <paths>`), message in a temp file; never `git stash`, `git reset`, `git checkout`, `git add -A` or a bare commit.
- **Type-check:** builders do NOT run `tsc`. The controller runs it at each wave barrier.
- The protected chat route and `ChatInterface.tsx` are not touched. `lib/chat/tools.ts` (description text) and `lib/chat/system-prompt.ts` (one paragraph) are in scope.

## 3. Shared contract (fixed here so parallel tasks agree)

Written by Task 1 into `lib/queries/pending-statement-types.ts`. Pure module, types and pure functions only.

```ts
export type PendingReason = "awaiting_statement" | "closing_entry_missing" | "resymbol_repair_pending";
export type PendingSide = "long" | "short";
export type PendingFigureKind = "cost_basis" | "short_sale_proceeds";
export const PENDING_REASON_ORDER: readonly PendingReason[] = ["awaiting_statement", "closing_entry_missing", "resymbol_repair_pending"];
/** Per-lot precedence when several could apply: resymbol > closing_entry_missing > awaiting. */
export const PENDING_REASON_PRECEDENCE: readonly PendingReason[] = ["resymbol_repair_pending", "closing_entry_missing", "awaiting_statement"];

export function sideOf(isShort: number | boolean | null | undefined): PendingSide;
export function figureKindForSide(side: PendingSide): PendingFigureKind;

export interface PendingDisclosureRow { reason: PendingReason; side: PendingSide; positions: number; lots: number; figure: number; figureKind: PendingFigureKind }
export interface PendingDisclosureInput { account_id: number; security_id: number; is_short: number | boolean; reason: PendingReason; lotCount: number; figure: number }
export function reducePendingDisclosure(inputs: readonly PendingDisclosureInput[]): PendingDisclosureRow[];   // sorted by PENDING_REASON_ORDER, long before short
export function countPendingPositions(inputs: readonly Pick<PendingDisclosureInput, "account_id" | "security_id" | "is_short">[]): number;
```

Written by Task 3 into `lib/queries/pending-statement.ts` (final API; `pendingStatementKeySet` and the two-part key are removed):

```ts
export interface PendingStatementPair {
  account_id: number; security_id: number; symbol: string;
  side: PendingSide; reason: PendingReason;
  flat_date: string; open_quantity: number; open_figure: number; figure_kind: PendingFigureKind; lot_count: number;
}
export interface PendingStatementReadOptions { today?: string }
export function getPendingStatementPairs(db, accountIds?, opts?): PendingStatementPair[];
export function pendingStatementKey(row: { account_id: number; security_id: number; is_short: number | boolean | null | undefined }): string; // `${a}:${s}:${side}`, the only key builder
export interface PendingStatementIndex {
  pairs: readonly PendingStatementPair[];
  reasonFor(lot: { account_id: number; security_id: number; is_short: number | boolean | null | undefined }): PendingReason | null;
  pairReasons(accountId: number, securityId: number): PendingReason[];   // every reason on any side, PENDING_REASON_ORDER
  sidesFor(accountId: number, securityId: number): readonly PendingStatementPair[];
}
export function getPendingStatementIndex(db, accountIds?, opts?): PendingStatementIndex;
export function isPendingStatementLot(index: PendingStatementIndex, lot): boolean;
```

Written by Task 3 into `lib/queries/ledger-side-routing.ts` (pure; imports only `readIbkrTradeDirection`):

```ts
export type LedgerRole = "open" | "close" | "close_either" | "undecidable" | "none";
export interface LedgerRowInput { type: string; quantity: number | null; price_per_share: number | null; amount: number | null; notes: string | null; security_type: string }
/** How the engine would route this row, as seen from one side. "undecidable" = mixed direction evidence. */
export function routeLedgerRow(row: LedgerRowInput): { role: LedgerRole; side: PendingSide | null; engineLoads: boolean };
export function sideOpeningSql(side: PendingSide): string;   // SQL predicate for "engine-loadable opening on this side" over alias t (+ notes read in JS where evidence is present)
```

---

## 4. Waves and barriers

| Wave | Tasks (parallel) | Needs |
|---|---|---|
| 1 | Task 1 (contract types + reducer), Task 2 (re-symbol module + apply seam) | none |
| 2 | Task 3 (read model + side routing), Task 4 (copy module) | Task 3: 1, 2. Task 4: 1 |
| 3 | Task 5 (Tax Lots queries), Task 6 (chat summary), Task 7 (chat tools and prompt), Task 8 (integrity scan, account mismatch, price-less exercise warning) | 3 (each reads only Task 1 and Task 3 contracts; no Wave-3 task reads another Wave-3 task's output) |
| 4 | Task 9 (Tax Lots page + components), Task 10 (security page, security-detail, lot-coverage), Task 11 (data-confidence UI) | 9: 4, 5. 10: 4, 5. 11: 4, 8 |
| 5 | Task 12 (cross-cutting invariants, three-way parity, repo guard, parent-spec pointer) | 1 to 11 |
| 6 | Task 13 (rehearsal on a copy + browser pass) | 12 |

**Barriers (run by the controller after every task of the wave is reviewed; dispatch the next wave only after the barrier passes):**

- **After Wave 1:** each task's own tests; `npx tsc --noEmit` clean.
- **After Wave 2:** Task 3 and Task 4 own tests, plus the engine files listed in Task 3. EXPECTED transitional failures, not to be fixed here: `tsc` errors in `lib/queries/tax-lots.ts`, `portfolio-summary.ts`, `chat-tools.ts`, `integrity-checks.ts` (removed `pendingStatementKeySet`, renamed `live_flat_date` / `open_basis`); at runtime every test that calls `getOpenTaxLots`, `getExpiredOptionLotsAwaitingClose`, `getTaxLotSummary`, `getTaxLotsForChat`, `getClosedPerLiveDataForChat`, `getPortfolioSummaryForChat`, `runIntegrityChecks` or `getDataConfidence` throws ("pendingStatementKeySet is not a function"). Do not run the full suite here.
- **After Wave 3:** Wave-3 tasks' own tests green; full suite run and its failures compared with this list: EXPECTED `tsc` errors only in `app/dashboard/tax-lots/page.tsx`, `app/dashboard/components/TaxLotSummary.tsx` and the five dashboard fixture tests of Task 9 (old summary scalars); EXPECTED runtime failures: none (components read old fields that are now undefined and render nothing). Any other failure stops the run.
- **After Wave 4:** `npx tsc --noEmit` clean, `bash scripts/verify.sh changed --base main`, the full suite green, `npx next build` once.
- **After Wave 5:** `bash scripts/verify.sh full --base main`, `npx tsc --noEmit`.

---

## Task 1 — Contract types and the one disclosure reducer

**Goal.** One pure module every surface uses to shape the pending disclosure, so no surface can sum a cost with proceeds.

**Files (owner):** create `lib/queries/pending-statement-types.ts`, `tests/queries/pending-statement-types.test.ts`.

- [ ] Write the module to the §3 contract.
- [ ] Tests:
  - `reducer: one row per (reason, side) present, none for an absent one` (T-DISCLOSURE, pure part).
  - `reducer: figure kind is fixed by side`.
  - `reducer: Σ conservation per (reason, side)`: each row's `figure` = Σ input figures of that reason and side; `lots` = Σ `lotCount`; `positions` = distinct (account, security, side); Σ over rows of `lots` = Σ input `lotCount`.
  - `reducer: no field equals a cross-side dollar sum` (long 100 + short 40 never yields 140; there is no total field).
  - `reducer: a group input and the same lots as single rows give the same list`.
  - `countPendingPositions counts long and short of one symbol as two`.
  - `empty input gives []`.
- **Verify:** `PATH=... npx vitest run tests/queries/pending-statement-types.test.ts`
- **Figure protected:** every pending dollar figure; equal to the sum of the lots it names, per side, never across sides.

## Task 2 — Move the re-symbol mapping into `lib/` and add an apply seam (Q10, R7)

**Files (owner):** create `lib/securities/option-resymbol-targets.ts`; edit `scripts/repair-mistyped-option-legs.ts`; create `tests/securities/option-resymbol-targets.test.ts`, `tests/scripts/repair-mistyped-option-legs-apply-seam.test.ts`. `tests/scripts/repair-mistyped-option-legs.test.ts` stays green untouched.

- [ ] Record the SHA-256 of `JSON.stringify(OPTION_RESYMBOL_TARGETS)` at HEAD before editing (write only the hash into the test).
- [ ] Move the array with its doc comment byte-for-byte; add `resymbolTargetsFrom(fromSymbol)` (exact stored symbol, no trimming, as the planner matches it).
- [ ] Script: relative import plus `export { OPTION_RESYMBOL_TARGETS }`.
- [ ] Apply seam (behaviour unchanged): move the body of the CLI's `db.transaction(() => {...})` into `export function applyMistypedOptionLegPlans(db, plans: { dups, retypes, expFix, optSplits, resymbols })` that performs exactly the same statements in the same order (it does not take the backup and does not recompute; the CLI keeps both, in the same order as today: backup, transaction, `computeTaxLots`). The CLI calls the seam.
- [ ] Tests:
  - `the moved list is byte-identical` (hash), `the script re-exports the same object` (`toBe`), `resymbolTargetsFrom` against entries read from the constant.
  - `the apply seam reproduces the CLI's writes`: on a seeded in-memory DB built from synthetic symbols injected through `vi.mock` of the lib module, run the planners and the seam; assert the exact transactions table afterwards (ids, security_id, quantity, price, type, source_key) equals a hand-written expectation.
  - `the planner supports only its own rows`: a mapped old-symbol leg in an account other than the planner's account, or on a date/type the target does not name, is NOT planned (pins R7's distinction).
- **Verify:** `PATH=... npx vitest run tests/securities/option-resymbol-targets.test.ts tests/scripts/repair-mistyped-option-legs.test.ts tests/scripts/repair-mistyped-option-legs-apply-seam.test.ts`
- **Figure protected:** the repair moves the same rows as before. Note for closeout: the CLAUDE.md private-constants sentence must name the new path.

## Task 3 — The read model and the side-routing catalogue

**Goal.** Classify every open lot side into not pending, or pending with one reason and a flat date, per spec §5 as corrected by R2.

**Files (owner):** edit `lib/queries/pending-statement.ts`; create `lib/queries/ledger-side-routing.ts`; rewrite cases in `tests/queries/pending-statement.test.ts`; edit `tests/queries/pending-statement-negative-live-row.test.ts`; create `tests/queries/pending-statement-options-shorts.test.ts`, `tests/queries/pending-reason-decide.test.ts`, `tests/compute/ledger-side-routing-engine-parity.test.ts`.

The rule (pure `decidePendingReason`, exported for tests, fed by SQL loaders):

```
Per (account, security, side σ) with open lots (quantity_remaining > 0):
  cls  = "long_equity" (stock/ETF long) | "new" (option any side; stock/ETF short) | none
         Bonds, mutual funds, cash equivalents, currency conversions: none.
         Options NOT liveOptionExpirationSql(s, today): none      ← expired beats pending
  N    = newest holdings row of the pair {date, qty, evidence: statement|live|other}
  S    = newest statement-grade row {date, qty} or null
  rsym = cls "new", option, and resymbolTargetsFrom(symbol) names a security whose latest
         holdings row in the SAME account has quantity != 0   ("known replacement contract held")

long_equity (unchanged from today, guards included):
  N.evidence = live AND N.qty <= 0 AND NOT (S AND S.qty = 0)
  AND NOT fill(N.date) [positionChangingTxnTypesSql] AND NOT split(N.date)
                                                       → awaiting_statement, flat N.date

new (ruling R2):
  flatFor(row) = live → (σ long ? qty <= 0 : qty >= 0);  statement → qty = 0;  other → false
  reopen(d)    = an engine-loadable OPENING on side σ, imported, trade_date > d (strict)
  if NOT N or NOT flatFor(N)                           → none     (E3: newer non-zero same-side row;
                                                                    a statement opposite-sign row also lands here: OPEN-8)
  if rsym                                              → resymbol_repair_pending, flat N.date
  if S AND S.qty = 0 AND NOT reopen(S.date)            → closing_entry_missing, flat S.date
  if N.evidence = live AND NOT reopen(N.date)          → awaiting_statement, flat N.date
  else                                                 → none     (E4: a same-side reopening after the only flat evidence)
  Splits are not consulted. Closing entries need no rule: they shrink or close the lots (E1); a remainder stays pending.
```

- [ ] `ledger-side-routing.ts`: `routeLedgerRow` mirrors §0 item 5 exactly (types, evidence override for stock/ETF/option rows only, `engineLoads` false when quantity is null, or price is null on any type other than `EXPIRED`/`EXERCISED`/`ASSIGNED` and a `REDEMPTION` with an amount). `sideOpeningSql(side)` preselects candidate rows in SQL; evidence is read in JS with `readIbkrTradeDirection`.
- [ ] Engine parity test (`ledger-side-routing-engine-parity.test.ts`): for every type in the two loaders plus `TRANSFER_OUT`, with no evidence, open-only, close-only and mixed evidence, with and without a price, on a stock and an option, seed one row in an account that holds one long and one short lot of that security, run `computeTaxLots`, and assert: a row routed "open σ" created a lot with `is_short` matching σ; a row routed "close σ" consumed only side-σ lots; "close_either" consumed any side; "none" (e.g. `TRANSFER_OUT`, unloadable rows) created and consumed nothing; "undecidable" is exactly the mixed-evidence set.
- [ ] Evidence class in SQL: `CASE WHEN ${statementGradeHoldingSql("h")} THEN 'statement' WHEN ${liveOriginHoldingSql("h")} THEN 'live' ELSE 'other' END`.
- [ ] Figures: `open_figure` = Σ `remainingLotBasisSql()` form, FX at read time; `figure_kind` from the side; never signed.
- [ ] Index, key, scope (`[]` = nothing), `today` threading, header comment as in §3.
- [ ] Tests (each with hand-written expected states):
  - pure matrix (`pending-reason-decide.test.ts`): T-ONE-STATE over class × evidence × reopen; T-FLATDATE `statement-zero-only`, `statement-zero-then-newer-live-zero`, `same-side-reopening-between-statement-and-live-zero` (awaiting, flat = live date), `a reopening dated ON the flat date is not later`.
  - `T-GAP`: statement zero, no closing entry → `closing_entry_missing` for long option, short option, short stock.
  - **Codex counterexamples (F2), each its own test:** `short stock, statement zero, then an import split → still closing_entry_missing`; `short stock, statement zero, then a plain BUY (no evidence) → short still closing_entry_missing` (and the new long lot is a separate long_equity lot, not pending); `short stock, statement zero, then TRANSFER_OUT → still pending`; `short stock 100, statement zero, cover of 40 imported → remaining 60 still closing_entry_missing`; `long option, statement zero, then SELL_TO_OPEN on the same contract → long side still pending`; and the positive endings `short: later SHORT_SELL ends it`, `short: a newer negative live row ends it`, `long option: later BUY_TO_OPEN ends it`, `long option: a newer positive row ends it`, `an unpriced reopening (engine does not load it) does not end it`.
  - `PR #123 kept` and its twin; `a statement-grade opposite-sign row is NOT pending` (OPEN-8 pinned as current behaviour).
  - `T-RESYMBOL` classifier part (synthetic mapping via `vi.mock`): live zero and statement zero both give `resymbol_repair_pending` when the replacement is held in the same account; replacement held only in another account → ordinary reason; not held → ordinary reason; unmapped → ordinary reason.
  - `T-NO-DOUBLE-FLAG` classifier part across the expiry boundary (pass `today`).
  - `T-SIDE`, `T-SCOPE`, `bonds, mutual funds and money market are never pending`, `the key carries the side`.
  - Long-stock cases keep their asserted values (T-STOCK-UNCHANGED); only the field and key names change (section 6).
- **Verify:** `PATH=... npx vitest run tests/queries/pending-statement.test.ts tests/queries/pending-statement-negative-live-row.test.ts tests/queries/pending-statement-options-shorts.test.ts tests/queries/pending-reason-decide.test.ts tests/compute/ledger-side-routing-engine-parity.test.ts tests/compute/tax-lots-statement-only-closes.test.ts tests/compute/tax-lots-split-hardening.test.ts tests/integration/statement-only-closes-determinism.test.ts`
- **Figure protected:** which lots leave Unrealized. Bound: a lot two sources call flat is never valued unless side-matching evidence says it reopened; long stock is byte-for-byte today's.

## Task 4 — Copy module

**Files (owner):** edit `app/dashboard/components/pending-statement-copy.ts`; create `tests/dashboard/pending-statement-copy.test.ts`.

- [ ] Keep every existing export and text. Add per spec §6: chip labels "closing entry missing" and "re-symbolled — repair pending"; hover texts; `pendingChipLabel(reason)`, `pendingChipTitle(reason)`, `pendingLineLead(reason)`, `pendingLineAction(reason)`, `pendingFigureWords(kind)`, `lotsWithoutPositionNote(reason | "mixed")`, popover chip labels and Data Health suffixes for `closing-entry-missing`, `resymbol-repair-pending`, `closing-entry-account-undecidable`, `exercise-price-missing`.
- [ ] Re-symbol wording per R7: "renamed to a new contract after a split; still held under it. The ledger entries must be moved to the new symbol before these lots are valued." No sentence promises a particular script.
- [ ] Literal em dash characters (no `\u` escapes; check with `file`).
- [ ] Tests: `every reason has a chip label, a title and a line`; `long-stock strings unchanged`; `figure words never say cost basis for a short side`; `no re-symbol sentence names a script`.
- **Verify:** `PATH=... npx vitest run tests/dashboard/pending-statement-copy.test.ts tests/dashboard/tax-lots-pending-statement.test.tsx`

## Task 5 — Tax Lots queries (`lib/queries/tax-lots.ts`)

**Files (owner):** edit `lib/queries/tax-lots.ts`, `tests/queries/tax-lots-pending-statement.test.ts`; create `tests/queries/tax-lots-pending-options-shorts.test.ts`, `tests/queries/tax-lots-not-ordinary-open-unvalued.test.ts`.

- [ ] `TaxLotWithSecurity`: keep `pending_statement`; add `pending_statement_reason` and `pending_figure_kind` (null unless pending).
- [ ] `decorateOpenLots(db, rows, expiredOption, opts)`: index built with `opts.today`; an expired row is never pending (second lock) AND gets `current_value = NULL`, `unrealized_gain = NULL` (R1). Thread `opts` from both readers.
- [ ] `PendingStatementDisclosure` → `{ pendingStatement: PendingDisclosureRow[] }`; `getTaxLotSummary` feeds its per-(account, security, side) groups to the reducer; pending groups leave `totalUnrealizedGain`; `totalOpenLots` unchanged.
- [ ] Tests:
  - `R1 across the expiry boundary`: one live-flat long option and one live-flat short option; with `today` = expiration day: pending, value null, gain null; with `today` = the next Eastern day: in the expired reader, not pending, value null, gain null; never both flags.
  - `an expired option with a price and no flat evidence is unvalued` (not only pending ones).
  - `a short pending lot has pending_figure_kind short_sale_proceeds`.
  - `T-NO-DOUBLE-FLAG (readers)`.
  - `summary list equals the reducer over the same lots read one by one` (same-file parity; the cross-surface parity is Task 12).
  - Long-stock assertions keep their values (section 6).
- **Verify:** `PATH=... npx vitest run tests/queries/tax-lots-pending-statement.test.ts tests/queries/tax-lots-pending-options-shorts.test.ts tests/queries/tax-lots-not-ordinary-open-unvalued.test.ts tests/queries/tax-lots.test.ts tests/pages/tax-lots-page-currency-expired-options.test.ts`
- **Figure protected:** the Unrealized tile and every lot row's value. Bound: no not-ordinary-open lot carries a value anywhere in the read model.

## Task 6 — Chat portfolio summary (`lib/queries/portfolio-summary.ts`)

**Files (owner):** edit `lib/queries/portfolio-summary.ts`; create `tests/queries/portfolio-summary-pending-options-shorts.test.ts`.

- [ ] Use `getPendingStatementIndex(db, scope, { today })`; pending groups feed `reducePendingDisclosure`; one line per row, sentence kept in this file, naming the reason and the figure kind; the long `awaiting_statement` line keeps today's text byte-identical.
- [ ] Harvesting and approaching-long-term filters use `isPendingStatementLot(index, row)`.
- [ ] Tests:
  - **T-NO-HARVEST-SHORT with positive controls (R8).** For each of: a short stock lot, a short option lot, a long lot near its anniversary — seed it so that it IS eligible (a short whose price ROSE past the -100 loss threshold; a long lot within 60 days of long-term), then run the summary twice: with the pending index mocked empty the lot appears (control proves the fixture is eligible), with its real pending reason (each of the three) it is absent. A winning short and every short in the approaching list are not used as evidence (they already fail the SQL predicates).
  - `no line prints a long figure plus a short figure as one number`.
- **Verify:** `PATH=... npx vitest run tests/queries/portfolio-summary-pending-options-shorts.test.ts tests/queries/portfolio-summary-short-lots.test.ts tests/queries/chat-pending-statement.test.ts`
- **Figure protected:** the harvesting list never names a pending lot, proven against an eligible control.

## Task 7 — Chat tax-lot tool, holdings tool, tool text, system prompt

**Files (owner):** edit `lib/queries/chat-tools.ts`, `lib/chat/tools.ts` (description strings), `lib/chat/system-prompt.ts` (the pending paragraph); create `tests/queries/chat-tools-pending-options-shorts.test.ts`, `tests/chat/holdings-closed-per-live-data-reasons.test.ts`. `tests/chat/holdings-closed-per-live-data.test.ts` stays green untouched.

- [ ] `TaxLotResult`: add `pending_statement_reason` and `figure_kind`; `status_note` branches on the reason (existing `PENDING_STATEMENT_CHAT_NOTE` unchanged).
- [ ] Open-lot rows (R1): a pending row AND an expired-option row both return `current_value: null`, `unrealized_gain: null` (decide "expired" with `isOptionLive`, the function the note already uses).
- [ ] `getClosedPerLiveDataForChat` (R3): keep the `zeroRows` seed but drop any pair for which `index.pairReasons` contains `closing_entry_missing` or `resymbol_repair_pending`; from the index merge take only `awaiting_statement` sides, then apply the same drop; list a pair only when its newest row is exactly zero (a flipped pair holds the opposite side); local pair key, never tested against the index; read `flat_date`.
- [ ] Tool text and system prompt as in revision 1, plus: "a re-symbolled option is still held under its new contract; never call it closed".
- [ ] Tests:
  - `each reason's note`; `a short pending lot reports figure_kind short_sale_proceeds, no value, no gain`.
  - `R1 across the expiry boundary in chat`: same option the day before (pending, null, null) and the day after (expired note, not pending, null, null).
  - `R3: re-symbol case` — old symbol with a live zero, replacement held in the same account → not listed as closed (the seed path would have listed it).
  - `R3: statement zero then a newer live zero` → `closing_entry_missing` → not listed (the seed path would have listed it).
  - `R3: live-flipped pair (long lot under a live short row)` → not listed; the held short appears in the holdings rows.
  - `plain live zero is still listed` (control).
  - `no internal join keys leak`.
- **Verify:** `PATH=... npx vitest run tests/queries/chat-tools-pending-options-shorts.test.ts tests/chat/holdings-closed-per-live-data-reasons.test.ts tests/chat/holdings-closed-per-live-data.test.ts tests/queries/chat-pending-statement.test.ts tests/queries/chat-tools-short-lots.test.ts tests/queries/chat-tools-expired-options-and-leap-day.test.ts`
- **Figure protected:** what chat calls held or closed, and every lot value it returns.

## Task 8 — Integrity scan: reason kinds, account mismatch, price-less exercise

**Files (owner):** edit `lib/queries/integrity-checks.ts`, `tests/queries/integrity-checks-statement-lag.test.ts` (extend only); create `lib/queries/closing-entry-account-mismatch.ts`, `tests/queries/integrity-checks-closing-entry.test.ts`, `tests/queries/closing-entry-account-mismatch.test.ts`, `tests/queries/integrity-checks-exercise-price-missing.test.ts`.

- [ ] `IntegrityHit.kind` adds `closing-entry-missing`, `resymbol-repair-pending`, `closing-entry-account-mismatch`, `closing-entry-account-undecidable`, `exercise-price-missing`. `IntegrityHit` gains optional `pendingReasons?: PendingReason[]` (OPEN-4: every reason of the pair is kept in the hit's details; the reason text names each).
- [ ] Lot-drift scan: `index.pairReasons(...)` replaces the key-set test. For `lots-no-position` with a non-empty list: ONE warning per pair, kind from the first present reason in `PENDING_REASON_PRECEDENCE`, `pendingReasons` = all of them. `awaiting_statement` alone keeps today's `statement-lag` kind and text. The 2026-10-19 branch stays for non-pending pairs.
- [ ] Account mismatch (R4), in `closing-entry-account-mismatch.ts`, using `routeLedgerRow` from Task 3 and the engine's own results:
  - Candidates: for each pending side (A, X, σ) of class "new", the closing rows of X in every other account B routed `close σ` or `close_either`, dated within [earliest acquisition of A's pending σ lots, A's flat date].
  - `unabsorbed(row) = |quantity| - Σ tax_lot_sales.quantity_sold WHERE sale_transaction_id = row.id - Σ tax_lots.quantity_acquired WHERE acquisition_transaction_id = row.id` (the second term covers a mixed trade's opened residual; it is zero otherwise).
  - `unabsorbed > 1e-9` on an engine-loaded, decidable row → CRITICAL hit, key `closing-entry-account:<A>:<B>:<X>:<side>`, reason naming both account names and "the entry may be booked to the wrong account or a transfer may be missing". Raised in addition to A's pending reason; never ends it.
  - A candidate row that is `undecidable` or not engine-loaded → WARNING, kind `closing-entry-account-undecidable`, own label ("a closing entry in another account cannot be checked"), key with side; never critical.
  - Runs inside `runIntegrityChecks`'s `lotDriftChecked` block (tax_lot_sales is trusted only while the convention marker is current). New check id `closing-entry-account` with its label, after `lot-drift`; `lotDriftCriticalCount` is unchanged.
- [ ] Price-less exercise warning (R5, ledger only): any `EXERCISED` or `ASSIGNED` row on an option with a null or zero price → WARNING `exercise-price-missing`, key `exercise-price-missing:<transaction id>`, reason "exercise or assignment with no price: its premium stays on the option and is not moved to the stock". Runs outside the convention gate (ledger only), like the duplicate-ledger scan. New check id `exercise-price` with its label.
- [ ] Tests:
  - `closing_entry_missing pair: one warning, never caps`; `resymbol pair: one warning, not a ledger gap`; `awaiting pair unchanged`; `two reasons on one pair: one hit, both in pendingReasons`.
  - **Codex scenarios (R4), each its own test, run through `computeTaxLots` first:** `false negative: B covers on day 10 with nothing open, opens an equal short on day 20 → hit` (whole-ledger arithmetic would balance); `false positive: B has an old unmatched cover BEFORE A's acquisition plus a fully matched round trip after it → no hit`; `split units: B opens before an import split and covers after it, fully matched by the engine → no hit`; `routing: B's cover is a BUY with close-only evidence and nothing to close → hit`; `routing: B's row is a plain BUY → not a candidate, no hit`; `mixed evidence in B → undecidable warning, no critical`; `B's cover has no price → undecidable warning, no critical`.
  - `T-XACCT (scan part)`: short stock and short option twins; one critical hit naming A and B, keyed with the side; A's pending hit still present.
  - **capReason (Codex):** the mismatch hit is in `getDataConfidence(...).integrity.critical`; `capReason` names it when it is the first critical hit; with an earlier critical hit seeded (a type contradiction), `capReason` names that one and the mismatch is still in the list.
  - `exercise-price-missing`: a price-less `ASSIGNED` row gives one warning; a priced one gives none; the warning never caps.
- **Verify:** `PATH=... npx vitest run tests/queries/integrity-checks-statement-lag.test.ts tests/queries/integrity-checks-closing-entry.test.ts tests/queries/closing-entry-account-mismatch.test.ts tests/queries/integrity-checks-exercise-price-missing.test.ts tests/queries/integrity-checks-closed-option-wording.test.ts tests/queries/integrity-checks-statement-positions.test.ts tests/queries/integrity-checks-lot-rollback.test.ts`
- **Figure protected:** the data-confidence score. Bound: capped only by a decidable account-mismatch hit (or existing criticals), never by a pending reason or an undecidable row.

## Task 9 — Tax Lots page and its two components

**Files (owner):** edit `app/dashboard/tax-lots/page.tsx`, `app/dashboard/components/TaxLotSummary.tsx`, `app/dashboard/components/TaxLotTables.tsx`; update the summary fixtures in the five dashboard tests listed in section 6.

- [ ] Page: delete the hand-built pair-key set; the narrowed summary's `pendingStatement` = `reducePendingDisclosure` over `pendingStatementRows`; `?pending=1` covers every reason.
- [ ] `PendingStatementLines({ rows, filter })`: one paragraph per reason present; positions via `<Count>`; one `<Money>` per side present with `pendingFigureWords(kind)`; never one combined figure; one filter link.
- [ ] Open Lots row chip from `pendingChipLabel/Title(reason)`; "Short sale" chip kept; an expired row never carries a pending chip.
- [ ] Tests: `two lines when two reasons exist; re-symbol line only when present`; `a two-sided bracket prints two figures and no sum`; `Hide amounts masks every new figure and count`; `the page builds no pending key by hand` (source pin).
- **Verify:** `PATH=... npx vitest run tests/dashboard/tax-lots-pending-statement.test.tsx tests/dashboard/tax-lot-summary-privacy-counts.test.tsx tests/dashboard/tax-lots-c01-disclosures.test.tsx tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx tests/dashboard/tax-report-wash-sale-disclosure.test.ts tests/pages/tax-lots-page-currency-expired-options.test.ts`

## Task 10 — Security page, `security-detail.ts`, `lot-coverage.ts`

**Files (owner):** edit `lib/queries/security-detail.ts`, `lib/compute/lot-coverage.ts`, `app/dashboard/security/[id]/page.tsx`, `tests/queries/security-detail-position-totals.test.ts` (shape only, section 6); create `tests/queries/security-detail-pending-reasons.test.ts`, `tests/compute/lot-coverage-pending-flips.test.ts`.

- [ ] `LotsWithoutPosition` adds `pendingReason: PendingReason | "mixed" | null`; `computeLotsWithoutPosition` input gains an OPTIONAL `pending_statement_reason` (absent = null), so callers that do not pass it still compile.
- [ ] Page: note via `lotsWithoutPositionNote(reason)`; lot chips via `pendingChipLabel/Title`.
- [ ] `computeLotSignMismatches` (OPEN-1): long lots with `pending_statement` true are not counted.
- [ ] `computeLotCoverageGaps` (R9): a long position is compared with the account's LONG (`!is_short`), NON-pending lots only. Its lot input gains optional `is_short` and `pending_statement`. Short positions stay skipped (unchanged).
- [ ] Tests (both flip directions):
  - `long position 10 over only a pending short lot of 10 → a coverage gap of 10 (no long lots), not a match`;
  - `long position over long lots plus a pending short lot → the short lot does not count`;
  - `short position over pending long lots (PR #123 flip) → no sign-mismatch row`; `short position over NON-pending long lots → sign-mismatch row (control)`;
  - `reason per account, "mixed" when two reasons differ`.
- **Verify:** `PATH=... npx vitest run tests/queries/security-detail-pending-reasons.test.ts tests/compute/lot-coverage-pending-flips.test.ts tests/compute/lot-coverage.test.ts tests/compute/lot-coverage-sign-mismatch.test.ts tests/queries/security-detail-c29.test.ts tests/queries/security-detail-position-totals.test.ts tests/queries/security-detail-shorts.test.ts tests/queries/security-detail-expired-option.test.ts`
- **Figure protected:** the security page's coverage and mismatch notes never treat a pending opposite-side lot as covering a position.

## Task 11 — Data-confidence popover and Data Health page

**Files (owner):** edit `app/dashboard/components/DataConfidenceIndicator.tsx`, `app/dashboard/data-health/page.tsx`; create `tests/dashboard/data-confidence-pending-kinds.test.ts`.

- [ ] A chip per new warning kind (labels from Task 4); the critical mismatch shows through the existing critical list and `capReason`.
- [ ] Data Health suffix per kind; the new check groups render under their labels.
- [ ] Chip tones from the checked tables; the server page imports copy only from the plain copy module.
- [ ] Tests: source pins per kind; no client-file import in the server page.
- **Verify:** `PATH=... npx vitest run tests/dashboard/data-confidence-pending-kinds.test.ts tests/dashboard/data-health-confidence-top.test.ts tests/repo/no-handrolled-failing-tint-pairs.test.ts`; `npx next build` at the Wave 4 barrier.

## Task 12 — Cross-cutting invariants, three-way parity, the key-helper guard, the parent-spec pointer

**Files (owner):** create `tests/integration/pending-options-shorts-invariants.test.ts`, `tests/integration/pending-exercise-handover.test.ts`, `tests/integration/pending-expired-purge.test.ts`, `tests/integration/pending-disclosure-parity.test.ts`, `tests/repo/pending-statement-key-helpers.test.ts`, `tests/compute/tax-lots-no-mint-short.test.ts`; edit `docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md` (one pointer line at invariant 10).

One shared seed: every class (long option, short option, short stock, long stock) in every state, with each lot's EXPECTED state written by hand in a table in the test file (ordinary open priced, ordinary open unpriced, pending with its reason, expired awaiting close, closed). Every test first asserts the read model agrees with the table, then uses the TABLE (not the classifier) as its population.

- **T-ONE-STATE.** Disjoint lot states by lot: closed (`quantity_remaining = 0`), expired awaiting close, pending (exactly one reason), ordinary open (everything else, priced or not). A partly sold lot is NOT closed. Σ of the four counts = number of lots in `tax_lots`.
- **T-QTY.** Per (account, security, side): Σ `quantity_remaining` = Σ ordinary open + Σ pending + Σ expired awaiting close (closed lots contribute 0). Exact to 1e-9.
- **T-MONEY.** What it conserves: the raw unrealized arithmetic over open lots. Let U(lot) = side-signed (value - remaining figure) from raw lot rows and prices, for priced lots. Then Σ U over the table's ordinary-open priced lots = the Unrealized tile, and Σ U over (ordinary open ∪ pending ∪ expired, priced) = the tile + Σ U over the table's pending and expired lots. Realized totals equal a direct `tax_lot_sales` sum. The pending disclosure figure is checked separately (Σ remaining basis or proceeds per side) and is NOT a term of the unrealized identity. Because the population comes from the hand table, a classifier that wrongly leaves a lot valued fails this test.
- **T-NOWRITE.** Digest before and after calling every read function (`getPendingStatementPairs`, `getPendingStatementIndex`, `getOpenTaxLots`, `getExpiredOptionLotsAwaitingClose`, `getTaxLotSummary`, `getPortfolioSummaryForChat`, `getTaxLotsForChat` open and closed, `getClosedPerLiveDataForChat`, `runIntegrityChecks`, `getDataConfidence`) over: every column of `transactions` (keyed by `source_key`, else id), every column of `holdings` (keyed by account, security, as_of_date), `tax_lots` keyed by the acquisition transaction's `source_key` plus acquisition date, `tax_lot_sales` keyed by (lot's acquisition `source_key`, sale transaction `source_key`), `RECONCILE_CLOSE` rows, and the `settings` rows for the generation and the convention stamp. Identical.
- **T-IDEMPOTENT.** Two `computeTaxLots` runs with pending option and short pairs seeded: the same source_key-keyed digest (identities as in T-NOWRITE); adding or removing `:live` tombstones changes neither `tax_input_generation` nor the digest.
- **T-NO-DOUBLE-FLAG (all readers)**, on the expiration day and the next Eastern day; every expired row also has null value and gain (R1).
- **T-NO-MINT.** A short stock pair with a statement zero gets no `RECONCILE_CLOSE`.
- **T-ENDS.** Per class, with R2's endings: E1 (closing entry imported, recompute; a partial close leaves the remainder pending), E2 (advance `today`), E3 (newer same-side non-zero row), E4 (same-side reopening); and the non-endings (split, opposite-side fill, `TRANSFER_OUT`).
- **T-EXERCISE (R5).** Linked cases (assigned short put, assigned short call, exercised long call, exercised long put): start pending under a live zero; import the statement rows; recompute; the option lot closes with zero result; Σ premium in = Σ premium landed on the stock leg; the pair leaves the list. Cite `tests/compute/tax-lots-options.test.ts` for the arithmetic. Unlinked cases, documenting the conditional behaviour: `ASSIGNED with no stock leg` → option lot closed, pair leaves pending, the premium is realized on the option close (equal to the premium), and the import route's response carries the replay warning; `ASSIGNED with a zero price` → same realized result, no replay warning, and the Task 8 `exercise-price-missing` warning is present; `linked stock leg opened no lot` → premium stays realized, warning present.
- **T-XACCT (end to end).** After recompute: A's lot open, pending, unvalued; Σ realized in A and B from that entry = 0; one critical mismatch hit with the side in its key.
- **T-RESYMBOL (end to end).** Seed with a synthetic mapping (`vi.mock`); run the script's planners and `applyMistypedOptionLegPlans` (Task 2 seam), then `computeTaxLots`: no old-symbol open lot, no label. Second case: the old-symbol leg sits outside what the planner supports (another account): the label stays after the seam runs (R7: "known replacement held" is not "this repair supports these rows").
- **T-PURGE-PLAID / T-PURGE-WIDE** as in revision 1, the wide one with `vi.setSystemTime`; the lot reads expired and unvalued after both.
- **T-DISCLOSURE (three-way parity, moved here from Task 6).** For the whole book and for one account: `getTaxLotSummary(...).pendingStatement`, the reducer over the page's narrowed lot rows, and the chat summary's pending lines give the same rows, counts and figures; no result carries a cross-side dollar sum.
- **T-KEY-HELPERS.** Source scan of `lib/` and `app/`: no file other than `pending-statement.ts` writes a pending key or imports `pendingStatementKey`; importers of `@/lib/queries/pending-statement` are on an allowed list with reasons (`tax-lots.ts`, `portfolio-summary.ts`, `chat-tools.ts`, `integrity-checks.ts`, `closing-entry-account-mismatch.ts`); a stale entry fails. `pending-statement-types.ts` and `ledger-side-routing.ts` importers are unrestricted.
- **T-STOCK-UNCHANGED.** The long-stock fixtures of the old pending tests, re-run in one table through the new API, keep their pre-change values (synthetic).
- **Verify:** `PATH=... npx vitest run tests/integration/pending-options-shorts-invariants.test.ts tests/integration/pending-exercise-handover.test.ts tests/integration/pending-expired-purge.test.ts tests/integration/pending-disclosure-parity.test.ts tests/repo/pending-statement-key-helpers.test.ts tests/compute/tax-lots-no-mint-short.test.ts tests/repo/synthetic-close-consumers.test.ts tests/repo/no-handrolled-latest-holdings.test.ts tests/mutations/expired-options.test.ts`; then the Wave 5 barrier.
- **Figure protected:** every tax figure on screen; the build creates and destroys nothing.

## Task 13 — Rehearsal on a copy and the browser pass

As revision 1 (VACUUM copy in the sandbox, spec §9 steps 1 to 8, figures to gitignored `docs/private/pending-lots-options-shorts-rehearsal-2026-10.md`, browser pass on Tax Lots whole and narrowed, a security page for a pending option and a pending short, the header popover, Data Health, a chat question), plus:

- [ ] For every `resymbol_repair_pending` pair, run the repair script's planners (dry run, `--db` on the copy) and list separately which pairs the repair supports and which it does not (R7).
- [ ] List every `closing-entry-account-mismatch`, `closing-entry-account-undecidable` and `exercise-price-missing` hit for the owner.
- [ ] Confirm no expired option row anywhere shows a value (R1) and no option with a NULL expiry is pending without being listed (OPEN-5).
- [ ] Count lots whose state changed between the old and the new build, by class and reason; long stock/ETF must be zero.

---

## 5. OPEN items (the build follows each recommendation unless the owner reverses it)

- **OPEN-1. Sign-mismatch note over pending long lots.** Recommended and built (Task 10): skip pending long lots.
- **OPEN-2.** Closed by ruling R2.
- **OPEN-3.** Closed by ruling R4.
- **OPEN-4. One integrity hit per pair when the sides carry different reasons.** Built: one hit, kind by precedence, every reason kept in `pendingReasons` and named in the text.
- **OPEN-5. An option with no stored expiration date** has no date ending. Do not invent one; Task 13 lists such lots so the missing metadata is disclosed.
- **OPEN-6. Cost-basis reconciliation and a live-flipped pair.** Leave it; it reports a real holdings/lots disagreement.
- **OPEN-7. The chat summary's held-lot "Open lots … cost basis" line** mixes long cost and short proceeds today. Not caused by this build; keep it explicit as a follow-up with the short-lot column relabel (spec Q4 second half).
- **OPEN-8. UNRESOLVED LIMITATION, stated plainly.** A statement-grade row of the OPPOSITE sign over open lots (the statement says short, a long lot is open, or the reverse) stays "real drift": the lot reads open AND VALUED with its paper gain. The critical integrity hit caps the score, but the valued orphan and its gain stay on Tax Lots, the security page and chat. This slice does NOT remove every such display; Part 2 takes it up.
- **OPEN-9 (new). How the owner learns of an incomplete exercise/assignment rollover.** Today: only the import flow shows replay warnings; the Tax Lots Recompute route drops them; the price-less skip is silent. This build adds the ledger-only `exercise-price-missing` warning. Recommended follow-on (its own small task after this build, no engine change): the Recompute route returns `replayWarnings` and the Tax Lots page lists them.
- **OPEN-10 (new). A same-side reopening ends pending for every lot of that side (R2 E4),** so an OLDER orphan lot on that side (a missed sale before the statement zero) reads valued again once the position is reopened. Accepted for this slice; the per-lot attribution in Part 2 (lots acquired on or before the flat date stay pending) resolves it for both long stock and the new classes.
- **OPEN-11 (new). A side-agnostic unabsorbed close in B (`EXPIRED`/`EXERCISED`/`ASSIGNED`) when A has BOTH sides pending.** Recommended: one hit per pending side (keys differ by side), each naming the same B row.

## 6. Existing tests that must change, and why (R8)

No expected FIGURE changes in any of them; only shapes, names, or rules the rulings change.

| Test file | Task | Why it changes |
|---|---|---|
| `tests/queries/pending-statement.test.ts` | 3 | `live_flat_date` → `flat_date`; `open_basis` → `open_figure` (and whole-pair `toEqual` shapes gain `side`, `reason`, `figure_kind`, `lot_count`); "short lots are never pending" rewritten (now pending, side short); Option removed from "a %s is never pending"; "pendingStatementKey is the account:security key" → carries the side; option/short twins added to the statement-zero case; header comment. |
| `tests/queries/pending-statement-negative-live-row.test.ts` | 3 | `live_flat_date` → `flat_date`. |
| `tests/queries/tax-lots-pending-statement.test.ts` | 5 | the three summary scalars → the long `awaiting_statement` row of `pendingStatement`; key shape. |
| `tests/queries/tax-lots.test.ts` | 5 | only if an assertion reads a value on an expired-option row (R1 nulls it); none found at revision time (its expired assertions read symbols and counts). |
| `tests/dashboard/tax-lots-pending-statement.test.tsx`, `tests/dashboard/tax-lot-summary-privacy-counts.test.tsx`, `tests/dashboard/tax-lots-c01-disclosures.test.tsx`, `tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx`, `tests/dashboard/tax-report-wash-sale-disclosure.test.ts` | 9 | their `TaxLotSummary` fixtures carry the three scalars; they gain `pendingStatement: [...]` instead; `PendingStatementLine` → `PendingStatementLines`. |
| `tests/queries/security-detail-position-totals.test.ts` | 10 | exact `toEqual` objects for `LotsWithoutPosition` gain `pendingReason`. |
| `tests/compute/lot-coverage.test.ts`, `tests/compute/lot-coverage-sign-mismatch.test.ts` | 10 | expected to stay green (their lots have no `is_short`/`pending_statement`, read as long and not pending); listed because their functions change. |

Must stay green untouched (a failure means a ruling was broken; stop and report): `tests/compute/tax-lots-statement-only-closes.test.ts`, `tests/integration/statement-only-closes-determinism.test.ts`, `tests/compute/tax-lots-split-hardening.test.ts` (their fixtures are long stock), `tests/repo/synthetic-close-consumers.test.ts`, `tests/repo/no-handrolled-latest-holdings.test.ts`, `tests/pages/tax-lots-page-currency-expired-options.test.ts`, `tests/queries/security-detail-shorts.test.ts`, `tests/queries/chat-pending-statement.test.ts`, `tests/chat/holdings-closed-per-live-data.test.ts`, `tests/queries/chat-tools-expired-options-and-leap-day.test.ts`, `tests/queries/integrity-checks-closed-option-wording.test.ts`, `tests/db/holding-sources.test.ts`, the reconciler tests, `tests/mutations/expired-options.test.ts`, `tests/scripts/repair-mistyped-option-legs.test.ts`, `tests/compute/tax-lots-options.test.ts`.

## 7. Rollout

- **No migration, no engine change, no stamp revision, no Worker change, no recompute needed.** Mac deploy through `npm run deploy` after the Wave 5 barrier and `npx next build`.
- **Live data steps: none required.** Optional, owner-gated, each needing the owner's go before any write:
  1. Re-symbol repair for pairs the planner supports: backup; dry run then `--apply` with `--db` on a VACUUM copy; recompute the copy twice (identical source_key digest); compare; then live and a live recompute. Pairs the planner does not support need a code change to the target list with its own review.
  2. Every `closing_entry_missing` pair and every account-mismatch hit is a real ledger issue for the owner to fix through the normal import; the build fills nothing.
- **Reversible** by reverting the merge.
- **Closeout (controller):** a `docs/DECISIONS.md` entry recording R1 to R10 and the OPEN answers; one CLAUDE.md line under Data layer; the private-constants sentence updated to name `lib/securities/option-resymbol-targets.ts`; `docs/plans/TODO.md` gains Part 2 and OPEN-9 at the top.

## 8. Changes from revision 1, per Codex finding

- **F1** → ruling R1; Task 5 nulls value and gain on expired rows in the decorator; Task 7 does the same in `getTaxLotsForChat`; boundary tests in both; T-NO-DOUBLE-FLAG checks nulls.
- **F2** → ruling R2 (side-matching endings only, splits never end pending, `TRANSFER_OUT` ends nothing, partial covers keep the remainder); new `ledger-side-routing.ts` with an engine-parity test; nine counterexample tests in Task 3; OPEN-2 closed; OPEN-10 records the remaining pair-wide reopen limitation.
- **F3** → ruling R3; Task 7 filters both sources, side-aware; re-symbol, statement-then-live-zero and flipped-pair tests.
- **F4** → ruling R4; absorbability read from the engine's own `tax_lot_sales` and lots (chronological, split-adjusted, routing-exact); undecidable rows warn under their own label, never critical; side in the key; date window on the unabsorbed row; Codex's false-negative, false-positive, split and routing scenarios as tests; OPEN-3 closed; OPEN-11 new.
- **F5** → §0 item 4 qualified; T-EXERCISE gains three unlinked cases; Task 8 adds `exercise-price-missing`; OPEN-9 for surfacing Recompute warnings.
- **F6** → Task 12 restates T-ONE-STATE (lot-level disjoint states), T-QTY (ordinary open allows unknown valuation), T-MONEY (hand-written populations; says what is conserved), T-NOWRITE (transactions and holdings, stable identities).
- **F7** → Task 2 extracts `applyMistypedOptionLegPlans` (behaviour unchanged, pinned by a test); R7 separates "known replacement held" from "this repair supports these rows"; T-RESYMBOL has a supported and an unsupported case; Task 13 lists both.
- **F8** → section 6 lists every test that changes and why; T-NO-HARVEST-SHORT has positive controls; Task 10's input field is optional so untouched callers compile.
- **F9** → ruling R9; Task 10 changes `computeLotCoverageGaps`; both flip directions tested.
- **Waves** → section 4 barriers with named transitional failures; the three-way parity test moved from Task 6 to Task 12, so Wave 3 tasks read only Task 1 and Task 3 outputs.

---

# Part 2 — The follow-on slice (Q6): long stock skipped by the engine's guards, and per-lot attribution

**Ruling:** DECISIONS 2026-10-26 item 2, spec Q6: queued directly behind this build, reusing its reason, list and key helpers unchanged.

1. **Scope.** Long stock/ETF pairs whose newest statement-grade row is zero but whose synthetic close the engine skipped (split guard or later-fill guard): today open and VALUED. The engine stays unchanged; the read model labels them `closing_entry_missing`.
2. **Per-lot attribution (also resolves OPEN-10 for the new classes).** Only lots acquired on or before the flat date can be the missing sale's lots; a lot opened later is held and valued. Needs one ruling on a partial re-buy (recommended: `acquisition_date <= flat_date` pending, later lots not).
3. **Split-guard case.** The label stays correct (the statement says flat); no quantity is compared; flat date = the statement zero's date. Aligns long stock with R2 (a split never ends pending).
4. **Pinned tests that change:** "a split-guard-skipped pair (import split after the zero date) is not pending" and the statement-zero variant of "an imported position-changing fill after the live zero ... not pending" in `tests/queries/pending-statement.test.ts`, plus the long-stock rows of T-STOCK-UNCHANGED; each changes only for pre-flat lots.
5. **OPEN-8 in scope:** decide whether lots under a statement-grade opposite-sign row read `closing_entry_missing` (recommended: yes, for the side the statement contradicts) while the critical hit stays.
6. **Reused unchanged:** the contract types, reducer, index, copy, chips and lines; new code is the `long_equity` branch of `decidePendingReason` and a per-lot date filter in the loaders.
7. **Tests:** T-GAP long-stock twins, T-ONE-STATE rows, T-MONEY on a hand-tabled seed, T-NO-MINT unchanged, and a rehearsal listing every long-stock pair that changes from valued to unvalued, shown to the owner before deploy.
8. **Rollout:** read-model only, no recompute, no live step.
