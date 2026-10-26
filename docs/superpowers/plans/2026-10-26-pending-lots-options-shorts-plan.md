# Pending lots for options and shorts: implementation plan (2026-10-26)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Each task below is one subagent. Tasks in the same wave share no file and have no data dependency, so they are dispatched together in one message. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md`. Read sections 2, 4, 5 and 7 before any task. Section numbers and test names (T-GAP, T-FLATDATE, ...) below refer to it.

**Rulings this plan builds:** `docs/DECISIONS.md` 2026-10-26 item 2. All twelve recommendations of spec §11 are accepted as written: Option A (a statement zero alone never returns a lot to "open and valued"), two wordings plus the re-symbol label, no synthetic close for an option or a short, a short's figure reads as "short-sale proceeds", "closing entry missing" is a non-capping warning, an account-mismatch hit is CRITICAL (caps the score), one position = one account + one security + one side, the three summary scalars are replaced by one list, and the re-symbol mapping moves (values unchanged) into one `lib/` module. PR #123's rule (a long lot under a LIVE-origin short row is pending, DECISIONS 2026-10-23) is confirmed as an instance of Option A and is kept. Question 6 (long stock skipped by the engine's guards) is a separate slice queued directly after this one (Part 2 below).

**Architecture in one paragraph.** Nothing is stored and the engine does not change. `lib/queries/pending-statement.ts` becomes a classifier over (account, security, side): it reads the pair's newest holdings row, the pair's newest statement-grade row, the shared guards and the re-symbol mapping, and returns one row per pending side with a reason (`awaiting_statement`, `closing_entry_missing`, `resymbol_repair_pending`), a flat date and a figure with its kind. Every surface reads it through one index object and one shared disclosure reducer. The boolean `pending_statement` stays true for every reason, so every existing exclusion keeps working; only wording and the disclosure shape change.

---

## 0. Financial logic, re-derived (read before briefing any coder)

Checked against `lib/compute/tax-lots.ts` on 2026-10-26.

1. **A short lot's stored figure is net proceeds, positive.** The engine opens a short lot with `cost_basis` = the opening sale's net leg (gross proceeds less fees, `netLegDollars(..., "short_open")`, fee sign negative). On a cover it books `proceeds = stored lot dollars`, `cost_basis_allocated = what the cover paid`, so `gain = proceeds - cover cost`. The remaining share is `cost_basis * quantity_remaining / quantity_acquired` (`remainingLotBasisSql`), which for a short is the remaining short-sale proceeds. Labelling it "cost basis" is wrong; "short-sale proceeds" is right (spec Q4). `holdings.cost_basis` for a short is stored NEGATIVE by the live syncs; the read model reads lots only, never that column.
2. **A short's unrealized figure** is `sign * (current value - remaining figure)` with sign -1 (`lotSideSignSql`): proceeds minus cost to cover. A pending lot has no unrealized figure at all, so the sign only matters for the exclusion tests (T-MONEY, T-NO-HARVEST-SHORT).
3. **Expiry.** `EXPIRED` closes an option lot at price 0: a long option realizes minus the premium paid, a short option realizes plus the premium received. That is the E1 ending when the row is imported. Without the row, the date alone ends pending (E2): from the Eastern day after the expiration date the lot is in `getExpiredOptionLotsAwaitingClose` and never pending.
4. **Exercise and assignment** close the option lot with zero result (premium rollover, `proceeds = cost_basis_allocated`) and move the premium to the stock leg: long call +premium to stock basis, short put -premium from stock basis, long put -premium from sale proceeds, short call +premium to sale proceeds. The arithmetic is already pinned in `tests/compute/tax-lots-options.test.ts` ("long call exercised", "long put exercised", "short call assigned", "short put assigned"). T-EXERCISE cites those and asserts only the handover from pending.
5. **What ends pending, per class (engine routing in `processTrade`).** Long option: `SELL_TO_CLOSE`, `EXPIRED`, `EXERCISED` (or a `SELL` that the engine routes to the long side). Short option: `BUY_TO_CLOSE`, `EXPIRED`, `ASSIGNED`. Short stock: `BUY_TO_COVER`, or a `BUY` whose notes carry IBKR direction evidence with `close` set. A plain `BUY` with no evidence opens a NEW long lot and never covers a short (it is in the engine's buy list). Closes match within one account only.
6. **Conservation.** The build moves dollars between two display buckets only ("unrealized" and "pending, not valued"). Σ over buckets is constant; realized totals are untouched because nothing is written.

---

## 1. Spec drift: what changed in the code since 2026-10-08

Each item is folded into the task that owns the file. None changes a ruling.

| # | Spec says | Code today (2026-10-26) | Effect on this plan |
|---|---|---|---|
| D1 | Condition (a) is "newest row is a live-origin ZERO". | PR #123 (`ee0ad38d`, 2026-10-23) made it `h.quantity <= 0`: a long lot under a live-origin SHORT row is pending. | The flat test is side-aware: for a long side a live row with quantity <= 0, for a short side a live row with quantity >= 0. A STATEMENT-grade row counts only at exactly zero (DECISIONS 2026-10-23: a statement-grade opposite-sign row stays real drift). Task 3. |
| D2 | §10: three chat queries lack the short sign flip; file it as a separate backlog item. | Already fixed 2026-10-08 (`d62bdefd`, `7a9f048b`; DECISIONS 2026-10-08 item 2): the tax-lot tool, the harvesting query and the approaching-long-term query all use `lotSideSignSql`, and approaching-long-term is long-only. | No backlog item to file. T-NO-HARVEST-SHORT is still required: the exclusion must come from the pending filter. Task 6. |
| D3 | §4: the wide purge path uses the UTC date. | `purgeExpiredOptionHoldings` binds `todayET()` on both paths (2026-10-09). Its no-options path takes no `today` argument. | The boundary argument is now simpler (both Eastern; purge cutoff is expiration < today - 1, the expired bucket is expiration < today). T-PURGE-WIDE pins the day with `vi.setSystemTime`. Task 12. |
| D4 | §5 consumer table lists `chat-tools.ts` as "calls the helpers per lot row". | `getClosedPerLiveDataForChat` (holdings tool, "closed_per_live_data") also calls `getPendingStatementPairs`, builds a pair key with `pendingStatementKey` on rows that have no side, and reads `live_flat_date`. | Task 7 changes it: it lists `awaiting_statement` pairs only (its contract is "closed per LIVE data"; a statement-flat pair is excluded by its own doc), keeps a LOCAL pair key never tested against the pending index, and reads `flat_date`. |
| D5 | §5: integrity scan tests a hand-built key against the pending set. | Still true, plus a 2026-10-19 branch (`d8320ff1`) that words a live-tombstone `lots-no-position` as "closed per live data — awaiting statement" for any security type. | Task 8 keeps that branch for the non-pending case (e.g. a guard-skipped pair) and adds the reason branches in front of it. `tests/queries/integrity-checks-closed-option-wording.test.ts` must stay green. |
| D6 | §5 table: `lib/compute/lot-coverage.ts` needs no change. | `computeLotSignMismatches` (added with the shorts work) prints "the position is short, yet the ledger holds long lots ... cannot both be right" with no pending check. Under D1 those long lots are pending and show no gain, so the sentence is wrong for that case. | OPEN-1. Recommended: skip pending long lots in that function (they are explained by the pending note). Task 10. |
| D7 | The task brief names `lib/queries/cost-basis-reconciliation.ts`. | The file is `lib/compute/cost-basis-reconciliation.ts` (PR #123 era commits `9eb4295b`, `df08c6f9`, `290145fa`). It reads non-zero latest holdings only and never consults the pending model; a flat pair is not in it, and a live-flipped pair is a quantity mismatch there by the 2026-10-23 rule. | Not touched. OPEN-6 records the interplay. |
| D8 | §5: "`getPendingStatementPairs` takes the same optional `today`". | `decorateOpenLots` never passes `opts.today` into the pending key set; `getPendingStatementPairs` has no `today`. | Task 3 adds `opts.today`; Task 5 threads it through every lot reader. |
| D9 | §9: "one small module holding the re-symbol mapping" (open). | Ruled yes (Q10). The constant lives in `scripts/repair-mistyped-option-legs.ts` and carries per-row fields (trade date, type, pre-split quantity, ratio). | Task 2 moves the whole array byte-identical; the read model uses only `fromSymbol` and `toSymbol`. The script re-exports the name so its test and CLI do not change. |
| D10 | Concurrent work. | Another agent has uncommitted edits in `lib/db/holding-sources.ts` (closed-day repair). | No task in this plan edits `lib/db/holding-sources.ts`; it is read only. |

---

## 2. Global constraints (every task)

- **Read-model only.** No migration, no engine change in `lib/compute/tax-lots.ts`, no convention-stamp revision, no Worker change, no write to `tax_lots`, `tax_lot_sales`, `transactions`, `holdings`, `settings` or `tax_input_generation`.
- **Single classifier for provenance.** Row evidence classes come from `statementGradeHoldingSql` / `liveOriginHoldingSql` (`lib/db/holding-sources.ts`), evaluated in SQL as a CASE. Never match a `source_key` prefix by hand.
- **Shared guards.** The long stock/ETF path uses `positionChangingTxnTypesSql()`, `findLaterImportSplit` and `IMPORT_SPLIT_ACTION_TYPES_SQL` from `lib/compute/synthetic-close-guards.ts` exactly as today. That file is not edited.
- **Latest-row lookups** are per-pair correlated (the shape `tests/repo/no-handrolled-latest-holdings.test.ts` accepts) or go through `latestHoldingsPredicate`. No global `MAX(as_of_date)`.
- **Option expiry** only through `lib/compute/option-expiry.ts` (`liveOptionExpirationSql(alias, today)`).
- **Account scope:** `undefined` = every account; a defined empty list = none.
- **Privacy:** counts through `<Count>`, dollars through `<Money>`, quantities through `<Shares>`, unit nouns through `<QuantityUnit>`; a reason string that names a symbol renders inside `<PrivateText>`.
- **Copy** lives only in `app/dashboard/components/pending-statement-copy.ts`.
- **Fixtures are synthetic** (invented tickers such as `ZZOPT`, round amounts). No real symbol, account or figure in a committed file. The re-symbol constant is moved, not copied: no test restates its values.
- **Test command prefix:** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH`. Tests use `:memory:` SQLite with the migrated schema (no hand-built cut-down tables).
- **Git:** parallel workers share one worktree. Pathspec commits only (`git add <paths> && git commit -F <msgfile> -- <paths>`), message file in a temp dir, never `git stash`, `git reset`, `git checkout`, `git add -A` or a bare commit.
- **Type-check:** builders do NOT run `tsc`. The controller runs `npx tsc --noEmit` once at the end of each wave (Waves 3 and 4 are intentionally red in between, see the wave note).
- The protected chat route and `ChatInterface.tsx` are not touched. `lib/chat/tools.ts` (description text) and `lib/chat/system-prompt.ts` (one paragraph) are in scope per spec §5.

## 3. Shared contract (fixed here so parallel tasks agree)

Written by Task 1 into `lib/queries/pending-statement-types.ts`. Pure module: no database handle, no imports except types.

```ts
export type PendingReason = "awaiting_statement" | "closing_entry_missing" | "resymbol_repair_pending";
export type PendingSide = "long" | "short";
export type PendingFigureKind = "cost_basis" | "short_sale_proceeds";

/** Display order of reasons; also the per-lot precedence is resymbol > closing_entry_missing > awaiting (see Task 3). */
export const PENDING_REASON_ORDER: readonly PendingReason[] = ["awaiting_statement", "closing_entry_missing", "resymbol_repair_pending"];

export function sideOf(isShort: number | boolean | null | undefined): PendingSide;      // truthy -> "short"
export function figureKindForSide(side: PendingSide): PendingFigureKind;                 // long -> cost_basis, short -> short_sale_proceeds

/** One row of the disclosure list: one (reason, side) that has at least one lot. */
export interface PendingDisclosureRow {
  reason: PendingReason;
  side: PendingSide;
  positions: number;          // distinct (account, security, side)
  lots: number;
  figure: number;             // USD; cost basis for long, short-sale proceeds for short
  figureKind: PendingFigureKind;
}

/** Input to the reducer: a lot row, or a group of lots of ONE (account, security, side). */
export interface PendingDisclosureInput {
  account_id: number;
  security_id: number;
  is_short: number | boolean;
  reason: PendingReason;
  lotCount: number;            // 1 for a lot row; COUNT(*) for a group
  figure: number;              // remaining USD figure of those lots
}

/** The one reducer. Sorted by PENDING_REASON_ORDER, then long before short. Empty input -> []. */
export function reducePendingDisclosure(inputs: readonly PendingDisclosureInput[]): PendingDisclosureRow[];

/** Distinct (account, security, side) among the inputs. Never sums dollars. */
export function countPendingPositions(inputs: readonly Pick<PendingDisclosureInput, "account_id" | "security_id" | "is_short">[]): number;
```

Written by Task 3 into `lib/queries/pending-statement.ts` (final API; the old `pendingStatementKeySet` and two-part key are removed):

```ts
export interface PendingStatementPair {
  account_id: number; security_id: number; symbol: string;
  side: PendingSide; reason: PendingReason;
  flat_date: string;           // per-reason rule, spec §5 "The flat date, per reason"
  open_quantity: number;       // Σ quantity_remaining, always positive
  open_figure: number;         // remaining USD figure (remainingLotBasisSql form, FX at read time)
  figure_kind: PendingFigureKind;
  lot_count: number;
}
export interface PendingStatementReadOptions { today?: string }
export function getPendingStatementPairs(db, accountIds?: readonly number[], opts?: PendingStatementReadOptions): PendingStatementPair[];

/** The only key builder: `${account_id}:${security_id}:${side}`. */
export function pendingStatementKey(row: { account_id: number; security_id: number; is_short: number | boolean | null | undefined }): string;

export interface PendingStatementIndex {
  pairs: readonly PendingStatementPair[];
  /** Reason for this lot's side, or null. */
  reasonFor(lot: { account_id: number; security_id: number; is_short: number | boolean | null | undefined }): PendingReason | null;
  /** Reasons pending on any side of one (account, security), in PENDING_REASON_ORDER; [] when none. */
  pairReasons(accountId: number, securityId: number): PendingReason[];
}
export function getPendingStatementIndex(db, accountIds?: readonly number[], opts?: PendingStatementReadOptions): PendingStatementIndex;
export function isPendingStatementLot(index: PendingStatementIndex, lot: {...same shape}): boolean;  // reasonFor(lot) !== null
```

---

## 4. Waves

| Wave | Tasks (parallel inside a wave) | Depends on |
|---|---|---|
| 1 | Task 1 (contract types + reducer), Task 2 (re-symbol module move) | none |
| 2 | Task 3 (read model), Task 4 (copy module) | Task 3 needs 1 and 2; Task 4 needs 1 |
| 3 | Task 5 (Tax Lots queries), Task 6 (chat summary), Task 7 (chat tools and prompt), Task 8 (integrity scan + account mismatch) | 3 (chat and integrity wording live in their own lib files; a lib file never imports from `app/`) |
| 4 | Task 9 (Tax Lots page + components), Task 10 (security page + its lib), Task 11 (data-confidence popover + Data Health page) | 9 needs 4, 5; 10 needs 4, 5; 11 needs 4, 8 |
| 5 | Task 12 (cross-cutting invariants, repo guard, parent-spec pointer) | all of 1 to 11 |
| 6 | Task 13 (rehearsal on a copy + browser pass) | 12 |

**Wave note (red build between waves).** Task 3 removes `pendingStatementKeySet` and renames two fields, so `lib/queries/tax-lots.ts`, `portfolio-summary.ts`, `chat-tools.ts` and `integrity-checks.ts` do not type-check until Wave 3 lands, and the components until Wave 4 lands. Dispatch each wave in one message right after the previous wave's reviews. Each builder runs only its own named test files. The controller runs `npx tsc --noEmit`, `bash scripts/verify.sh changed --base main` and the full suite at the end of Wave 3 and again at the end of Wave 4, before Wave 5 starts. Do not land a partial wave.

---

## Task 1 — Contract types and the one disclosure reducer

**Goal.** One pure module that every surface uses to shape the pending disclosure, so the whole-book summary, the narrowed Tax Lots view and the chat summary cannot disagree and can never sum a cost with proceeds.

**Files (owner):** create `lib/queries/pending-statement-types.ts`; create `tests/queries/pending-statement-types.test.ts`.

- [ ] Write the module exactly to the contract in §3.
- [ ] Tests (named):
  - `reducer: one row per (reason, side) present, none for an absent one` (T-DISCLOSURE, pure part): inputs covering all three reasons on both sides give six rows; dropping every short input gives three.
  - `reducer: figure kind is fixed by side` — every long row is `cost_basis`, every short row `short_sale_proceeds`.
  - `reducer: Σ conservation per (reason, side)` — for each output row, `figure` = Σ input figures with that reason and side, `lots` = Σ `lotCount`, `positions` = distinct (account, security, side). And Σ over output rows of `lots` = Σ input `lotCount` (nothing dropped, nothing double-counted).
  - `reducer: no field equals a cross-side dollar sum` — build inputs where long figure 100 and short figure 40 share a reason; assert no output number equals 140 and there is no total field.
  - `reducer: a group input and the same lots as single rows give the same list` (protects narrowed-vs-whole parity).
  - `countPendingPositions counts a symbol held long and short as two positions` (spec Q9).
  - `empty input gives []`.
- **Verify:** `PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npx vitest run tests/queries/pending-statement-types.test.ts`
- **Figure protected:** the pending dollar figure on every surface; bound: equal to the sum of the lots it names, per side, never across sides.

## Task 2 — Move the re-symbol mapping into `lib/` (Q10)

**Goal.** The read model can read the option re-symbol list without importing from `scripts/`. Values unchanged.

**Files (owner):** create `lib/securities/option-resymbol-targets.ts`; edit `scripts/repair-mistyped-option-legs.ts`; create `tests/securities/option-resymbol-targets.test.ts`. `tests/scripts/repair-mistyped-option-legs.test.ts` must stay green untouched.

- [ ] Before editing, record a SHA-256 of `JSON.stringify(OPTION_RESYMBOL_TARGETS)` computed from the script at the current HEAD (run it once with tsx from the repo root; write only the hash into the new test).
- [ ] Move the array (with its doc comment) byte-for-byte into the new module as `export const OPTION_RESYMBOL_TARGETS = [...] as const`. Add `export function resymbolTargetsFrom(fromSymbol: string): string[]` returning the distinct `toSymbol` values for an exact stored symbol (no trimming: the repair script itself matches `securities.symbol = fromSymbol` untrimmed).
- [ ] In the script: `import { OPTION_RESYMBOL_TARGETS } from "../lib/securities/option-resymbol-targets";` and `export { OPTION_RESYMBOL_TARGETS };` so the name, the CLI and its test are unchanged. Use the relative import (the script has no `@/` import today and runs under tsx from the repo root).
- [ ] Tests:
  - `the moved list is byte-identical` — the hash of the lib constant equals the recorded hash.
  - `the script re-exports the same object` — `toBe` identity between the script's export and the lib's.
  - `resymbolTargetsFrom returns the mapped new symbols and [] for an unmapped symbol` — assert against entries read FROM the constant (never restate a symbol in the test).
- **Verify:** `PATH=... npx vitest run tests/securities/option-resymbol-targets.test.ts tests/scripts/repair-mistyped-option-legs.test.ts`
- **Figure protected:** none directly; protects that the repair script moves the same rows as before (Q10 "values unchanged").
- **Note:** the CLAUDE.md private-figures item lists "repair constants in two repair scripts". After this task one of those lists lives in `lib/securities/`. No new value is published; the closeout updates that sentence to name the new path.

## Task 3 — The read model (`pending-statement.ts`)

**Goal.** Classify every open lot side into exactly one of: not pending, or pending with one reason and a flat date, per spec §5, for long stock/ETF (unchanged), every live option (long or short) and short stock/ETF.

**Files (owner):** edit `lib/queries/pending-statement.ts`; rewrite `tests/queries/pending-statement.test.ts` (only the cases spec §8 lists as rewritten, plus the header comment); edit `tests/queries/pending-statement-negative-live-row.test.ts` (key shape only); create `tests/queries/pending-statement-options-shorts.test.ts`; create `tests/queries/pending-reason-decide.test.ts`.

The rule (build it as a pure function `decidePendingReason` inside `pending-statement.ts`, exported for tests, plus SQL loaders that feed it):

```
Inputs per (account, security, side σ) that has open lots (quantity_remaining > 0):
  cls      = "long_equity" (stock/ETF, long) | "new" (option any side, or stock/ETF short) | none
             Bonds, mutual funds, cash equivalents, currency conversions: none.
             Options past expiry (NOT liveOptionExpirationSql(s, today)): none   ← expired beats pending
  N        = pair's newest holdings row of any source {date, qty, evidence: statement|live|other}
  S        = pair's newest statement-grade row {date, qty} or null
  fill(d)  = an imported position-changing transaction on the pair with trade_date > d (strict)
  split(d) = an import-sourced split on the security with effective_date > d (strict; findLaterImportSplit)
  rsym     = cls "new" AND option AND resymbolTargetsFrom(symbol) names a security whose latest
             holdings row in the SAME account has quantity != 0

flatFor(row, σ) = row.evidence = live      → (σ = long ? row.qty <= 0 : row.qty >= 0)     [D1, PR #123]
                  row.evidence = statement → row.qty = 0                                      [2026-10-23]
                  otherwise                → false

long_equity (today's rule, unchanged):
  N.evidence = live AND N.qty <= 0 AND NOT (S AND S.qty = 0)
  AND NOT fill(N.date) AND NOT split(N.date)                → awaiting_statement, flat_date N.date
new:
  if NOT N or NOT flatFor(N, σ)                             → none           (E3)
  if rsym                                                   → resymbol_repair_pending, flat_date N.date (no guard removes it)
  if S AND S.qty = 0 AND NOT fill(S.date) AND NOT split(S.date)
                                                            → closing_entry_missing, flat_date S.date
  if N.evidence = live AND NOT fill(N.date) AND NOT split(N.date)
                                                            → awaiting_statement, flat_date N.date
  else                                                      → none           (E4)
```

- [ ] Evidence class in SQL: `CASE WHEN ${statementGradeHoldingSql("h")} THEN 'statement' WHEN ${liveOriginHoldingSql("h")} THEN 'live' ELSE 'other' END`.
- [ ] The fill list for `long_equity` is exactly `positionChangingTxnTypesSql()`. For `new` see OPEN-2 (recommended: the same list plus `short_sell`, `transfer_in`, `transfer_out`, as a constant local to this file; the shared guards file is not edited).
- [ ] Figures: `open_figure` = Σ `remainingLotBasisSql()` form (FX at read time), `figure_kind` = `figureKindForSide(side)`. Never sign it.
- [ ] `getPendingStatementPairs(db, accountIds?, opts?)` groups by (account, security, side); `today` defaults to `todayET()` inside `liveOptionExpirationSql`. Empty `accountIds` returns `[]`.
- [ ] `getPendingStatementIndex` builds one map keyed by `pendingStatementKey` and a pair map for `pairReasons`. Remove `pendingStatementKeySet`. Update the file header to the new rule and point to this plan and the spec.
- [ ] Tests (named; seed through real inserts on the migrated schema):
  - pure matrix in `pending-reason-decide.test.ts`: T-ONE-STATE (class × evidence × guard → exactly one outcome) and T-FLATDATE `statement-zero-only`, `statement-zero-then-newer-live-zero`, `imported-fill-between-statement-and-live-zero`, plus `a fill dated ON the flat date is not later`.
  - `T-GAP: a statement zero with no closing entry is closing_entry_missing` — long option, short option, short stock.
  - `PR #123 kept: a long lot under a live-origin short row is awaiting_statement`; twin `a short lot under a live-origin long row is awaiting_statement`; `a statement-grade opposite-sign row is NOT pending` (2026-10-23).
  - `E3: a newer non-zero same-side live row ends pending` per class.
  - `E4: an imported fill after the only flat row ends pending` per class.
  - `T-RESYMBOL` (classifier part): mapped old-symbol lot with the new symbol held → `resymbol_repair_pending` under a live zero AND under a statement zero; new symbol not held → ordinary reason; no mapping → ordinary reason. Use a synthetic mapping injected via `vi.mock` of `@/lib/securities/option-resymbol-targets` (never restate real symbols).
  - `T-NO-DOUBLE-FLAG` (classifier part): an option past expiry with a live zero, a statement zero, or both is never in `pairs`; on the expiration day itself it can be pending; on the next Eastern day it is not (pass `today`).
  - `T-SIDE` (classifier part): one pair with long and short lots and a live zero gives two rows with different keys; one security long in account A and short in account B is judged per account.
  - `T-SCOPE`: `accountIds` respected; `[]` selects nothing.
  - `bonds, mutual funds and money market are never pending` (Option removed from the old list).
  - `the key carries the side` (replaces "pendingStatementKey is the account:security key").
  - Every long-stock case in `pending-statement.test.ts` keeps its asserted values (T-STOCK-UNCHANGED); only `live_flat_date` → `flat_date` and the key shape may change.
- **Verify:** `PATH=... npx vitest run tests/queries/pending-statement.test.ts tests/queries/pending-statement-negative-live-row.test.ts tests/queries/pending-statement-options-shorts.test.ts tests/queries/pending-reason-decide.test.ts tests/compute/tax-lots-statement-only-closes.test.ts tests/compute/tax-lots-split-hardening.test.ts tests/integration/statement-only-closes-determinism.test.ts`
- **Figure protected:** which lots leave Unrealized. Bound: a lot two sources call flat is never valued (Option A), and a long stock pair's state is byte-for-byte today's.

## Task 4 — Copy module

**Goal.** Every label and sentence for the three reasons, both sides, in one file.

**Files (owner):** edit `app/dashboard/components/pending-statement-copy.ts`; create `tests/dashboard/pending-statement-copy.test.ts`.

- [ ] Keep every existing export and its text (long-stock wording unchanged).
- [ ] Add, per spec §6: chip labels `CLOSING_ENTRY_MISSING_CHIP_LABEL` ("closing entry missing") and `RESYMBOL_PENDING_CHIP_LABEL` ("re-symbolled — repair pending"); their hover texts (supplement only); `pendingChipLabel(reason)`, `pendingChipTitle(reason)`; the summary-line sentences for each reason (`pendingLineLead(reason)`, `pendingLineAction(reason)`); the bracket wording `pendingFigureWords(kind)` → "cost basis on long lots" / "short-sale proceeds on short lots"; the security-page note per reason (`lotsWithoutPositionNote(reason | "mixed")`); popover chip labels for the two new integrity kinds and the account-mismatch hit; the Data Health suffix per kind.
- [ ] Every chip label stands alone without hover. Use the Unicode em dash character, not an escape (Write turns `—` into raw bytes inconsistently; check with `file`).
- [ ] Tests: `every reason has a chip label, a title and a line`, `the long-stock strings are unchanged` (compare to the current constants' text), `the figure words never say "cost basis" for a short side`.
- **Verify:** `PATH=... npx vitest run tests/dashboard/pending-statement-copy.test.ts tests/dashboard/tax-lots-pending-statement.test.tsx`
- **Figure protected:** none; protects that "pending statement" is never shown after a statement has arrived, and "closing entry missing" never on a re-symbolled option.

## Task 5 — Tax Lots queries (`lib/queries/tax-lots.ts`)

**Goal.** Lot rows carry the reason and figure kind; the summary carries the disclosure list instead of the three scalars; expired beats pending in the decorator too.

**Files (owner):** edit `lib/queries/tax-lots.ts`; edit `tests/queries/tax-lots-pending-statement.test.ts`; create `tests/queries/tax-lots-pending-options-shorts.test.ts`.

- [ ] `TaxLotWithSecurity`: keep `pending_statement: boolean`; add `pending_statement_reason: PendingReason | null` and `pending_figure_kind: PendingFigureKind | null` (set only when pending).
- [ ] `decorateOpenLots(db, rows, expiredOption, opts)`: build `getPendingStatementIndex(db, undefined, { today: opts?.today })`; when `expiredOption` is true the row is never pending (second lock, spec §5). Thread `opts` from `getOpenTaxLots` and `getExpiredOptionLotsAwaitingClose`.
- [ ] `PendingStatementDisclosure` becomes `{ pendingStatement: PendingDisclosureRow[] }`; `getTaxLotSummary` feeds its existing per-(account, security, side) groups to `reducePendingDisclosure` (reason from `index.reasonFor`), passing `opts.today` to the index. Pending groups leave `totalUnrealizedGain`; `totalOpenLots` is unchanged.
- [ ] Tests:
  - `T-MONEY (summary)`: Unrealized with the model = Unrealized of the same book with every pending flag forced off (compute the "off" figure by summing `unrealized_gain` from a raw `openLotRows`-equivalent query in the test) minus Σ unrealized of exactly the pending lots; realized totals identical.
  - `T-DISCLOSURE (summary)`: a book with all reasons on both sides gives the expected rows; the same book read lot-by-lot through `getOpenTaxLots` and reduced with `reducePendingDisclosure` gives an identical list.
  - `T-NO-DOUBLE-FLAG (readers)`: no row of `getOpenTaxLots` or `getExpiredOptionLotsAwaitingClose` has both `pending_statement` and `expired_option`; every expired row has `pending_statement = false`; on the expiration day vs the next Eastern day via `today`.
  - `a short pending lot has pending_figure_kind short_sale_proceeds, null value and null gain`.
  - `T-STOCK-UNCHANGED`: existing long-stock assertions keep their values, read from the long `awaiting_statement` row of the list.
- **Verify:** `PATH=... npx vitest run tests/queries/tax-lots-pending-statement.test.ts tests/queries/tax-lots-pending-options-shorts.test.ts tests/pages/tax-lots-page-currency-expired-options.test.ts`
- **Figure protected:** the Unrealized tile. Bound: drops by exactly the pending lots' unrealized and by nothing else; the open-lot count does not move.

## Task 6 — Chat portfolio summary (`lib/queries/portfolio-summary.ts`)

**Goal.** The chat summary prints one pending line per (reason, side) from the shared reducer and never lists a pending lot (any reason, any side) as a harvesting candidate or as approaching long-term.

**Files (owner):** edit `lib/queries/portfolio-summary.ts`; create `tests/queries/portfolio-summary-pending-options-shorts.test.ts`. `tests/queries/portfolio-summary-short-lots.test.ts` and `tests/queries/chat-pending-statement.test.ts` stay green (the latter's long-stock values unchanged; if a line's text changes, Task 6 owns only the new file, so keep the existing long-stock line text byte-identical for the `awaiting_statement` long row).

- [ ] Replace the key set with `getPendingStatementIndex(db, scope, { today })`; delete the local `PairKeyed` key building (the row type may stay as the lookup input).
- [ ] Pending groups feed `reducePendingDisclosure`; print each row as its own line with plain text kept in this file (a lib file does not import from `app/`): it names the reason, the side's figure kind ("cost basis" or "short-sale proceeds") and never prints one combined figure. The long `awaiting_statement` line keeps today's text byte-identical.
- [ ] Harvesting and approaching-long-term filters use `isPendingStatementLot(index, row)`.
- [ ] Tests:
  - `T-NO-HARVEST-SHORT`: a pending short stock lot and a pending short option lot, each reason, seeded once so the price fell (would read as a gain) and once so it rose (would read as a loss beyond the -100 threshold): absent from harvesting candidates both times, and absent from approaching long-term. Same for a pending long lot near its anniversary.
  - `T-DISCLOSURE (chat)`: the summary's pending lines match the Tax Lots summary list for the same scope (same counts, same figures, one line per row).
  - `no line prints a long figure plus a short figure as one number`.
- **Verify:** `PATH=... npx vitest run tests/queries/portfolio-summary-pending-options-shorts.test.ts tests/queries/portfolio-summary-short-lots.test.ts tests/queries/chat-pending-statement.test.ts`
- **Figure protected:** the harvesting candidate list. Bound: never names a lot the read model calls pending.

## Task 7 — Chat tax-lot tool, holdings tool, tool text, system prompt

**Goal.** The tax-lot tool returns the reason and the figure kind and words each reason; the holdings tool's "closed per live data" list stays live-only; the model is told what the reason means.

**Files (owner):** edit `lib/queries/chat-tools.ts`, `lib/chat/tools.ts` (description strings only), `lib/chat/system-prompt.ts` (the pending paragraph only); edit `tests/chat/holdings-closed-per-live-data.test.ts` only if a field name it reads changes; create `tests/queries/chat-tools-pending-options-shorts.test.ts`.

- [ ] `TaxLotResult`: keep `pending_statement`; add `pending_statement_reason` and `figure_kind` (set only when pending). `status_note` branches on the reason (spec §6 wording; chat notes live in this file as today, alongside `PENDING_STATEMENT_CHAT_NOTE`, which stays byte-identical).
- [ ] Open-lot query: `getPendingStatementIndex(db, undefined, { today })`; expired options are never pending (the index excludes them) and keep `EXPIRED_OPTION_CHAT_NOTE`.
- [ ] `getClosedPerLiveDataForChat` (D4): merge only index pairs with reason `awaiting_statement`, deduped per (account, security) with a LOCAL key that is never tested against the index; read `flat_date`.
- [ ] `lib/chat/tools.ts`: the tax-lot tool description names `pending_statement_reason` and its three values, and says a short lot's figure is sale proceeds (`figure_kind`). `lib/chat/system-prompt.ts`: extend the one paragraph to options and shorts, the reasons, and "a re-symbolled option is still held under its new symbol; never call it closed".
- [ ] Tests:
  - `each reason's note`, `a short pending lot reports figure_kind short_sale_proceeds, no value, no gain`.
  - `T-NO-DOUBLE-FLAG (chat)`: an expired option with a live zero and a statement zero returns `pending_statement: false` and the expired note.
  - `the holdings tool does not list a closing_entry_missing pair as closed per live data`.
  - `does not leak internal join keys` (existing assertion extended to `is_short`, `account_id`, `security_id` on the new rows).
- **Verify:** `PATH=... npx vitest run tests/queries/chat-tools-pending-options-shorts.test.ts tests/queries/chat-pending-statement.test.ts tests/chat/holdings-closed-per-live-data.test.ts tests/queries/chat-tools-short-lots.test.ts`
- **Figure protected:** what chat says is held. Bound: a pending lot is never called held, valued or harvestable.

## Task 8 — Integrity scan: reason kinds and the account-mismatch hit

**Goal.** "Open lots with no matching position" splits by reason; a closing entry booked to another account is a critical hit naming both accounts (Q11).

**Files (owner):** edit `lib/queries/integrity-checks.ts`; create `lib/queries/closing-entry-account-mismatch.ts`; edit `tests/queries/integrity-checks-statement-lag.test.ts` (extend only); create `tests/queries/integrity-checks-closing-entry.test.ts` and `tests/queries/closing-entry-account-mismatch.test.ts`.

- [ ] `IntegrityHit.kind`: add `"closing-entry-missing" | "resymbol-repair-pending" | "closing-entry-account-mismatch"`.
- [ ] Lot-drift scan: replace `pendingKeys.has(key)` with `index.pairReasons(accountId, securityId)`. For `latestDrift.shape === "lots-no-position"` and a non-empty list, emit ONE warning per pair whose kind follows the first present reason in the order resymbol > closing_entry_missing > awaiting (`awaiting_statement` keeps today's `statement-lag` kind and text). Wording: "closing entry missing — the statement shows this position closed, the closing trade is not in the ledger" / "re-symbolled after a split — repair pending". Severity warning; never caps (Q5). The 2026-10-19 branch (D5) stays for the non-pending case. The local `${account}:${security}` maps stay local.
- [ ] Account mismatch (`closing-entry-account-mismatch.ts`, ledger-only, never reads `tax_lots`, `tax_lot_sales` or a stored engine warning). Definition pinned here (OPEN-3 if the reviewer finds a hole): for each pending side in account A of class "new", look at every OTHER account B's transactions on the same security. Classify each B row as the engine routes it (`processTrade`): opens long (`BUY` with no close evidence, `REINVESTMENT`, `BUY_TO_OPEN`, `TRANSFER_IN`), opens short (`SELL_TO_OPEN`, `SHORT_SELL`, a `SELL` whose IBKR direction evidence is open-only), closes long (`SELL` without evidence or with close-only evidence, `SELL_TO_CLOSE`, `REDEMPTION`), closes short (`BUY_TO_COVER`, `BUY_TO_CLOSE`, a `BUY` with close-only evidence), side-agnostic (`EXPIRED`, `EXERCISED`, `ASSIGNED`); a mixed-evidence row makes B undecidable (no hit). Evidence comes from `readIbkrTradeDirection` on `notes`. B cannot absorb when, over its whole ledger, closes on A's pending side exceed opens on that side, or side-agnostic closes exceed B's net open quantity across both sides; and at least one of those closing rows is dated on or after the earliest acquisition date of A's pending lots. Emit one CRITICAL hit per (A, B, security, side), key `closing-entry-account:<A>:<B>:<security>`, reason naming both account names and "the entry may be booked to the wrong account or a transfer may be missing". It is raised IN ADDITION to the pending reason and never ends it.
- [ ] Register the check: `IntegrityCheckId` gains `"closing-entry-account"` (label "Closing entry booked to another account"), placed after `lot-drift` in `INTEGRITY_CHECK_ORDER`; `integrityCheckIdOf` maps the prefix. Run it inside the `lotDriftChecked` block of `runIntegrityChecks` (the pending model reads lots, which are untrusted while the convention marker is stale). It does not use the `lot-drift:` prefix, so `lotDriftCriticalCount` is unchanged; the cap comes through `capReason` like any critical hit.
- [ ] Tests:
  - `closing_entry_missing pair: one closing-entry-missing warning, never caps the score`.
  - `resymbol pair: one resymbol-repair-pending warning, not counted as a ledger gap`.
  - `awaiting pair: unchanged statement-lag hit and text` (existing tests untouched).
  - `T-XACCT (scan part)`: short stock pending in A, `BUY_TO_COVER` in B where B has no short opens → one critical hit naming A and B, and A's pending reason hit still present; twin with a short option and `BUY_TO_CLOSE`. Negative: B has its own short open covering the quantity → no hit. Negative: B's cover dated before A's lot was opened → no hit.
  - `a mixed-evidence row in B gives no hit` (undecidable, never a guess).
  - `the mismatch hit caps the score` (`getDataConfidence` capReason names it).
- **Verify:** `PATH=... npx vitest run tests/queries/integrity-checks-statement-lag.test.ts tests/queries/integrity-checks-closing-entry.test.ts tests/queries/closing-entry-account-mismatch.test.ts tests/queries/integrity-checks-closed-option-wording.test.ts tests/queries/integrity-checks-statement-positions.test.ts tests/queries/integrity-checks-lot-rollback.test.ts`
- **Figure protected:** the data-confidence score. Bound: it is capped only by the account-mismatch hit, never by a pending reason.

## Task 9 — Tax Lots page and its two components

**Goal.** Chips per reason, one summary line per reason built from the list (each bracket names each side present), the "Show pending only" filter covers every reason, and the narrowed view uses the same reducer.

**Files (owner):** edit `app/dashboard/tax-lots/page.tsx`, `app/dashboard/components/TaxLotSummary.tsx`, `app/dashboard/components/TaxLotTables.tsx`; update fixtures in `tests/dashboard/tax-lots-pending-statement.test.tsx`, `tests/dashboard/tax-lot-summary-privacy-counts.test.tsx`, `tests/dashboard/tax-lots-c01-disclosures.test.tsx`, `tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx`, `tests/dashboard/tax-report-wash-sale-disclosure.test.ts` (the summary object shape only; no expected value changes).

- [ ] Page: delete the hand-built `${l.account_id}:${l.security_id}` set; the narrowed summary's `pendingStatement` = `reducePendingDisclosure` over `pendingStatementRows` (lotCount 1, figure `adjusted_cost_basis`, reason `pending_statement_reason`). `?pending=1` keeps working for every reason.
- [ ] `PendingStatementLine` → `PendingStatementLines({ rows, filter })`: one paragraph per reason present (awaiting, closing entry missing, re-symbolled), each "N positions" via `<Count>` summed from that reason's rows, and a bracket with one `<Money>` per side present plus `pendingFigureWords(kind)`. Never one combined figure. The filter link renders once.
- [ ] `TaxLotTables.tsx` Open Lots row: the chip label and title come from `pendingChipLabel/Title(lot.pending_statement_reason)`; the "Short sale" chip stays beside it. An expired row never carries a pending chip.
- [ ] Tests (render-to-static-markup for hook-free parts, source pins for the rest, per the file's existing pattern):
  - `two lines when awaiting and closing-entry-missing rows exist; the re-symbol line only when present`.
  - `a bracket with long and short rows prints two money figures with their words and no sum`.
  - `Hide amounts masks every figure and count in the new lines`.
  - `the page builds no pending key by hand` (source pin; complements T-KEY-HELPERS).
- **Verify:** `PATH=... npx vitest run tests/dashboard/tax-lots-pending-statement.test.tsx tests/dashboard/tax-lot-summary-privacy-counts.test.tsx tests/dashboard/tax-lots-c01-disclosures.test.tsx tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx tests/dashboard/tax-report-wash-sale-disclosure.test.ts tests/pages/tax-lots-page-currency-expired-options.test.ts`
- **Figure protected:** the Tax Lots disclosure lines. Bound: each equals the Task 5 list for the same scope.

## Task 10 — Security page and its lib helpers

**Goal.** The lot chip and the "no current position" note follow the reason; the sign-mismatch note stops calling pending lots contradictory (OPEN-1).

**Files (owner):** edit `lib/queries/security-detail.ts`, `lib/compute/lot-coverage.ts`, `app/dashboard/security/[id]/page.tsx`; create `tests/queries/security-detail-pending-reasons.test.ts` and `tests/compute/lot-sign-mismatch-pending.test.ts`. `tests/queries/security-detail-position-totals.test.ts` and `tests/queries/security-detail-shorts.test.ts` stay green untouched.

- [ ] `LotsWithoutPosition` keeps `allPendingStatement`; adds `pendingReason: PendingReason | "mixed" | null` (null when not all pending). `computeLotsWithoutPosition` input adds `pending_statement_reason`.
- [ ] Page: the note picks `lotsWithoutPositionNote(pendingReason)`; the lot-row chip (both the phone copy and the Unrealized cell) uses `pendingChipLabel/Title(reason)`.
- [ ] `computeLotSignMismatches` (OPEN-1, recommended): long lots with `pending_statement` true are not counted; an account whose long lots are all pending produces no mismatch row. Its input type gains `pending_statement?: boolean`.
- [ ] Tests: `reason per account, "mixed" when two reasons differ`, `a live-flipped short over pending long lots prints no sign-mismatch row`, `a short over non-pending long lots still does`.
- **Verify:** `PATH=... npx vitest run tests/queries/security-detail-pending-reasons.test.ts tests/compute/lot-sign-mismatch-pending.test.ts tests/queries/security-detail-position-totals.test.ts tests/queries/security-detail-shorts.test.ts tests/queries/security-detail-expired-option.test.ts`
- **Figure protected:** the security page's lot section; no figure changes, wording only.

## Task 11 — Data-confidence popover and Data Health page

**Goal.** The two new warning kinds and the mismatch hit read in words, without hover.

**Files (owner):** edit `app/dashboard/components/DataConfidenceIndicator.tsx`, `app/dashboard/data-health/page.tsx`; create `tests/dashboard/data-confidence-pending-kinds.test.ts`.

- [ ] Popover warning list: a chip per kind (`statement-lag` unchanged; `closing-entry-missing` → "closing entry missing"; `resymbol-repair-pending` → "re-symbolled — repair pending"), title from Task 4. The mismatch hit is critical and already shows through `capReason`; no new block.
- [ ] Data Health: the suffix per kind ("expected — clears with the next statement" stays for `statement-lag`; "import or enter the closing trade" for closing-entry-missing; "run the re-symbol repair" for resymbol).
- [ ] Chip tones from the checked tables only (`<Chip tone=...>`; no hand-written tint pairs). Data Health is a server page: import copy from the plain copy module only, never from a `"use client"` file (CLAUDE.md 2026-10-08 lesson).
- [ ] Tests: source pins that each kind has a chip and a suffix, and that the Data Health page imports nothing from a client file.
- **Verify:** `PATH=... npx vitest run tests/dashboard/data-confidence-pending-kinds.test.ts tests/dashboard/data-health-confidence-top.test.ts tests/repo/no-handrolled-failing-tint-pairs.test.ts`; then `npx next build` once (the controller, end of Wave 4).
- **Figure protected:** none; wording only.

## Task 12 — Cross-cutting invariants, the key-helper guard, the parent-spec pointer

**Goal.** The spec §7 conservation and no-write invariants, end to end, plus the repo guard.

**Files (owner):** create `tests/integration/pending-options-shorts-invariants.test.ts`, `tests/integration/pending-exercise-handover.test.ts`, `tests/integration/pending-expired-purge.test.ts`, `tests/repo/pending-statement-key-helpers.test.ts`, `tests/compute/tax-lots-no-mint-short.test.ts`; edit `docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md` (one pointer line at invariant 10: "superseded for options and shorts by 2026-10-08-live-closed-options-shorts-pending-design.md").

Named tests, each stated as a Σ check where it is one:

- **T-NOWRITE.** Seed long option, short option, short stock in every state. Digest (source_key-keyed) of `tax_lots`, `tax_lot_sales`, `RECONCILE_CLOSE` rows, `tax_input_generation` and the convention stamp; call `getPendingStatementPairs`, `getPendingStatementIndex`, `getOpenTaxLots`, `getExpiredOptionLotsAwaitingClose`, `getTaxLotSummary`, `getPortfolioSummaryForChat`, `getTaxLotsForChat` (open and closed), `getClosedPerLiveDataForChat`, `runIntegrityChecks`, `getDataConfidence`. Digest identical.
- **T-QTY.** For every (account, security, side): Σ `quantity_remaining` in `tax_lots` = Σ open-and-valued + Σ pending (`open_quantity`) + Σ expired-awaiting-close. Exact (no epsilon beyond float dust 1e-9).
- **T-ONE-STATE.** Over the seeded matrix every open lot is in exactly one of open-valued / pending (exactly one reason) / expired-awaiting; Σ of the four state counts (with closed sales counted per lot) = number of lots.
- **T-MONEY.** Unrealized(model off) - Unrealized(model on) = Σ unrealized of exactly the pending lots (computed from raw lot rows in the test); Realized(on) = Realized(off). "Model off" = the same reads with `getPendingStatementIndex` mocked to an empty index.
- **T-NO-DOUBLE-FLAG (all readers).** As spec §7, across every reader listed under T-NOWRITE, on the expiration day and the next Eastern day.
- **T-NO-MINT.** After `computeTaxLots`, a short stock pair whose newest statement-grade row is zero has no `RECONCILE_CLOSE` (the twin of the existing option test, which stays untouched).
- **T-IDEMPOTENT.** Two `computeTaxLots` runs with pending option and short pairs seeded: identical source_key digest; adding or removing `:live` tombstones for those pairs changes neither `tax_input_generation` nor the digest.
- **T-ENDS.** Per class: E1 (import the closing entry, recompute) closes the lot and removes it from the list; E2 (advance `today` past expiry) moves an option to the expired bucket; E3 (newer non-zero same-side row) and E4 (later imported fill) return it to open and valued.
- **T-EXERCISE (both legs).** Four cases (assigned short put, assigned short call, exercised long call, exercised long put), each starting pending under a live zero, then importing the statement rows and recomputing: the option lot is closed with zero result; Σ premium in = Σ premium landed on the stock leg (basis or proceeds by the sign table in §0 item 4); the pair is no longer pending and the disclosure list no longer carries it. Cite `tests/compute/tax-lots-options.test.ts` for the leg arithmetic; assert the handover only.
- **T-XACCT (end to end).** As Task 8, after a recompute: A's lot still open, pending, unvalued; Σ realized in A and B from that entry = 0; one mismatch hit.
- **T-RESYMBOL (end to end).** After running the repair planner's moves on the seed (call the script's exported plan/apply functions on the in-memory DB) and a recompute: no old-symbol open lot, no re-symbol label.
- **T-PURGE-PLAID.** Scoped, live-only, one-account purge the day after expiry plus the grace day: the lot's state before and after is "expired, awaiting close"; statement rows and other accounts' rows untouched.
- **T-PURGE-WIDE.** No-options purge with `vi.setSystemTime` pinned (D3): every holdings row of the expired option gone, and the lot still reads expired (not open, not valued, not pending). Boundary: on the first Eastern day the wide purge deletes, the expired bucket already holds the lot.
- **T-KEY-HELPERS.** Source scan of `lib/`, `app/`: no file other than `lib/queries/pending-statement.ts` writes a pending key template or imports `pendingStatementKey`; a file that imports from `@/lib/queries/pending-statement` must be on the allowed list (`lib/queries/tax-lots.ts`, `lib/queries/portfolio-summary.ts`, `lib/queries/chat-tools.ts`, `lib/queries/integrity-checks.ts`, `lib/queries/closing-entry-account-mismatch.ts`), and each entry carries a one-line reason. `lib/queries/pending-statement-types.ts` importers are unrestricted (pure). A stale entry fails too.
- **T-STOCK-UNCHANGED.** Re-run the long-stock pending fixtures from `tests/queries/pending-statement.test.ts` and `tests/queries/tax-lots-pending-statement.test.ts` through the new API in one table and assert the pre-change values (copied from those files' current expectations, all synthetic).
- **Verify:** `PATH=... npx vitest run tests/integration/pending-options-shorts-invariants.test.ts tests/integration/pending-exercise-handover.test.ts tests/integration/pending-expired-purge.test.ts tests/repo/pending-statement-key-helpers.test.ts tests/compute/tax-lots-no-mint-short.test.ts tests/repo/synthetic-close-consumers.test.ts tests/repo/no-handrolled-latest-holdings.test.ts tests/mutations/expired-options.test.ts`; then the controller runs `bash scripts/verify.sh full --base main` and `npx tsc --noEmit`.
- **Figure protected:** every tax figure on screen. Bound: the build creates and destroys nothing (T-NOWRITE, T-QTY, T-MONEY).

## Task 13 — Rehearsal on a copy and the browser pass

**Goal.** Prove on the real book (copy) that nothing stored changes and that the newly pending pairs are what the broker shows. Read-only on the copy; nothing on live.

**Files:** none committed except, optionally, nothing. Figures go to gitignored `docs/private/pending-lots-options-shorts-rehearsal-2026-10.md`.

- [ ] VACUUM copy of the live DB into the sandbox (`npm run sandbox`, own port, `browser` lock per `docs/reference/coordination.md`).
- [ ] Spec §9 steps 1 to 8 on the copy: digest before and after loading every changed page; newly pending pairs by class and reason, each checked against the broker; Unrealized change = Σ unrealized of newly excluded lots; open-lot count unchanged; no long stock/ETF pair changes state; four state counts add to the lot count and per-(reason, side) counts add to the pending count; every `closing_entry_missing`, `resymbol_repair_pending` and account-mismatch item listed for the owner (never fixed by the build); no row with both flags; two recomputes on the copy give an identical source_key digest, identical to a recompute on a copy without this build.
- [ ] Browser pass (Playwright on the sandbox, `npm run smoke` first), phone width and desktop, light and dark, Hide amounts on and off:
  - `/dashboard/tax-lots`: Open Lots chips for each reason present (seed the sandbox copy if the real book has none of a reason), the summary lines, the "Show pending only" link and its narrowed table, the expired line unchanged, a pending short row showing the "Short sale" chip beside the pending chip and an empty value/unrealized cell.
  - `/dashboard/tax-lots?account=<one>` and `?security=<id>`: the narrowed lines equal the whole-book lines for that scope.
  - `/dashboard/security/<id>` for one pending option and one pending short: lot chips, the "no current position" note per reason, no sign-mismatch sentence over pending long lots.
  - Header data-confidence popover: chips for each kind present; the cap line names an account-mismatch hit if one exists.
  - `/dashboard/data-health`: the integrity groups, the new check group, the suffixes.
  - Chat drawer: ask about one affected position; the answer calls it pending (or renamed), never held or harvestable.
- **Verify:** the rehearsal note lists each step with pass/fail; screenshots saved under `docs/private/`.
- **Figure protected:** the real book's Unrealized and every stored table (digest identical).

---

## 5. OPEN items (each with the recommended answer; the build follows the recommendation unless the owner reverses it)

- **OPEN-1. Sign-mismatch note over pending long lots (D6).** Recommended: skip pending long lots in `computeLotSignMismatches` (Task 10). The note exists to flag two contradicting sources; when the long lots are pending, the pending note already explains them and the "lots' gain below" it cites does not exist.
- **OPEN-2. Later-fill guard types for the new classes.** The shared list lacks `short_sell`, `transfer_in`, `transfer_out`; a re-short booked as `SHORT_SELL` after a statement zero would not end `closing_entry_missing`. Recommended: the read model's new-class guard uses the shared list plus those three, as a constant inside `pending-statement.ts`. The shared guards file and the long-stock path stay unchanged, so the engine and the long-stock read model still agree exactly.
- **OPEN-3. "Cannot absorb" for the account mismatch.** The spec leaves the exact test to the plan. Recommended: the whole-ledger, engine-routed, side-aware count in Task 8 with the date floor; undecidable rows (mixed direction evidence) raise nothing. If review finds a real book case it misreads, prefer no hit over a guessed hit (it is critical and caps the score).
- **OPEN-4. One integrity hit per pair when the two sides carry different reasons.** Recommended: one hit, kind from the first present reason in the order resymbol > closing entry missing > awaiting. Two sides of one option pair in different reasons is not expected on the real book.
- **OPEN-5. An option with no stored expiration date.** `liveOptionExpirationSql` treats NULL as live, so such a lot has no E2 ending and can stay pending until its closing entry arrives. Recommended: accept (no guessed date), and have Task 13 list any such lot for the owner.
- **OPEN-6. Cost-basis reconciliation and a live-flipped pair (D7).** `lib/compute/cost-basis-reconciliation.ts` flags a long lot under a live short row as a quantity mismatch while Tax Lots shows the lot pending. Recommended: leave it (it compares the broker's holdings with the lots and is right that they disagree); revisit in the Q6 slice if the owner finds it noisy.
- **OPEN-7. The chat summary's "Open lots: N (cost basis: X)" line** sums long cost and short proceeds for HELD lots today. Not caused by this build and not a pending figure. Recommended: file it with the optional "relabel the cost-basis column for short lots" follow-up (spec Q4 second half), not in this build.
- **OPEN-8. A statement-grade opposite-sign row over open lots** (statement says short, a long lot is open) stays "real drift", open and valued, per DECISIONS 2026-10-23. It is the same blocker as Q6 in another shape. Recommended: keep it out of this build (the critical integrity hit already caps the score) and take it into the Q6 slice.

## 6. Rollout

- **No migration, no engine change, no stamp revision, no Worker change.** The stored ledger does not go stale at deploy, and no recompute is needed for this build to be correct: it reads `tax_lots` as they stand.
- **Deploy:** Mac only, through `npm run deploy` after the full suite, `tsc` and `npx next build` pass. Worker untouched.
- **Live data steps: none required.** Two OPTIONAL owner-gated follow-ups may come out of Task 13, each needing the owner's one-word go before any write:
  1. If any pair lands on `resymbol_repair_pending`, the fix is running `scripts/repair-mistyped-option-legs.ts` (which takes `--db <path>` and otherwise opens the LIVE database). Order: backup; dry run then `--apply` with `--db` on a VACUUM copy; recompute the copy twice (identical source_key digest); compare; only then live, then a live recompute. A new mapping entry for a split not yet recorded is a code change with its own review, never an ad-hoc edit.
  2. Every `closing_entry_missing` pair is a real ledger gap: the owner imports the right file or transcribes the entry through the normal import pipeline. The build never fills it.
- **Reversible** by reverting the merge; nothing stored depends on it.
- **Closeout (controller, not a task):** a `docs/DECISIONS.md` entry recording the OPEN answers taken; one CLAUDE.md line under Data layer ("pending lots: one reader, `getPendingStatementIndex`; three reasons; the key carries the side; an account-mismatch hit caps the score"); the CLAUDE.md private-constants sentence updated to name `lib/securities/option-resymbol-targets.ts`; `docs/plans/TODO.md` gains the Part 2 slice at the top.

---

# Part 2 — The follow-on slice (Q6): long stock skipped by the engine's guards

**Ruling:** DECISIONS 2026-10-26 item 2, spec Q6: queued directly behind this build, as its own slice, reusing this build's reason, disclosure list and key helpers unchanged.

**The gap.** A long stock/ETF pair whose newest statement-grade row is zero normally gets a synthetic close from the engine. When the engine's split guard (an import split dated after the zero) or later-fill guard (an imported position-changing fill after the zero) skips it, the lots stay open and today read open and VALUED, although the statement says flat. Same blocker as spec §1, rarer.

**Outline (to be written as its own short plan after this build lands):**

1. **Scope.** Long stock/ETF lots only. The engine is not changed; it keeps skipping. Only the read model labels these lots `closing_entry_missing`.
2. **Which lots.** Per lot, not per pair: only lots acquired on or before the statement zero's date can be the missing sale's lots; a lot opened by the later fill is held and valued. This is the per-lot attribution the main slice deliberately did not need (its later-fill case simply ends pending). Needs one ruling: FIFO attribution when the later fill is a partial re-buy (recommended: lots with `acquisition_date <= S.date` are pending, later lots are not; the integrity scan's existing roll-back covers the quantity check).
3. **Split-guard case.** The zero predates a later import split, so lot quantities are post-split and the zero is pre-split. The label is still correct (the statement says flat); no quantity is compared. Flat date = the statement zero's date.
4. **Pinned tests that change** (why it needed its own ruling): in `tests/queries/pending-statement.test.ts`, "a split-guard-skipped pair (import split after the zero date) is not pending" and "an imported position-changing fill after the live zero means the snapshot is stale: not pending" (statement-zero variants), plus the long-stock rows of T-STOCK-UNCHANGED. Each changes from "not pending" to `closing_entry_missing` for the pre-zero lots only; every other long-stock value stays.
5. **Also in scope (OPEN-8 from Part 1).** A statement-grade opposite-sign row over open lots: decide whether those lots read `closing_entry_missing` (recommended: yes for the side the statement contradicts) while the critical integrity hit stays.
6. **Reused unchanged:** `PendingReason`, `reducePendingDisclosure`, `getPendingStatementIndex`, the copy module, the chips and lines. New code is confined to `decidePendingReason`'s `long_equity` branch plus a per-lot date filter in the loaders.
7. **Tests to add:** T-GAP long-stock twins (split-guard and later-fill), T-ONE-STATE rows for the new cases, T-MONEY on a seeded book, T-NO-MINT unchanged (the engine still mints nothing in the guarded cases), and a rehearsal on a copy listing every long-stock pair that changes state for the owner before deploy.
8. **Rollout:** read-model only, no recompute, no live step. The rehearsal's list of newly labelled pairs is shown to the owner because these are positions that change from valued to unvalued.
