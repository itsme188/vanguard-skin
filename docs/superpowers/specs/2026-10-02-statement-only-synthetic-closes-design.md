# Statement-only synthetic closes — design (2026-10-02)

**Ruling (user, 2026-10-02, option A):** only statement evidence may mint a saved synthetic close (`RECONCILE_CLOSE`). A position that goes flat only in a live snapshot (TWS / IBKR Web API / Plaid) keeps its open lots and renders as **pending statement**; it stays out of realized totals until a statement (or the real SELL) arrives.

Diagnosis: `docs/private/recompute-diagnosis-2026-10-02.md` (gitignored; real figures). Two presses on one DB are identical on source_key digests; the nightly "non-idempotent" finding is stored-vs-engine drift driven by live tombstones.

## 1. Problem (direction-only)

`computeTaxLots` (lib/compute/tax-lots.ts, broker-close pass ~990-1119) selects every open long stock/ETF lot whose pair's NEWEST holdings row (any source) has `quantity = 0` and mints a persisted `RECONCILE_CLOSE` priced at the newest price on or before that row's date. Newest-row zeros are tombstones minted by `reconcileClosedEquityHoldings` (lib/mutations/closed-equity.ts): pass 1 (statement book complete) suffixes `:stmt`; passes 2/3 (latest live snapshot) suffix `:live`. Consequences of using `:live` tombstones:

1. A live snapshot is a position, not a trade: several real fills collapse into one close at an arbitrary snapshot-day price.
2. A partial reduction mints nothing while a full exit mints a close: realized and open lots disagree with the same snapshot.
3. The close's date / price / source_key move every time a name round-trips flat→bought→flat.
4. Every live sync bumps `tax_input_generation`, so the stored ledger is "stale" by design and each press rewrites it.

## 2. Change

### 2.1 Engine gate (lib/compute/tax-lots.ts)

Replace the newest-row-of-any-source anchor with the **newest statement-grade row** of the pair:

- statement-grade = a row whose `source_key` is a statement class per `lib/db/holding-sources.ts` (`statementSourcedHoldingSql`) OR a closed-equity tombstone ending in `RECON_STMT_SUFFIX` OR a legacy unsuffixed closed-equity tombstone (already treated as statement-grade in closed-equity.ts). Add ONE exported predicate to holding-sources.ts (`statementGradeHoldingSql(col)`) — never inline the LIKEs in tax-lots.ts. It is deliberately DISTINCT from `statementSourcedHoldingSql` (which stays statement-prefix-only; recon tombstones remain outside the statement/live taxonomy for every existing caller): document the difference at both definitions and pin both with tests.
- A synthetic close is minted only when that newest statement-grade row has `quantity = 0`. Its `zero_date` is that row's `as_of_date`. All other guards stay (stock/etf only, long only, split guard, NOT EXISTS later fills after zero_date, price ≤ zero_date with breakeven fallback).
- A live row newer than the statement zero does not cancel the close if no imported fill follows it (the NOT EXISTS guard is about imported transactions; live re-buys produce lots only when their fills are imported).
- Everything else in the replay is unchanged.

### 2.2 Pending-statement read model (query layer, nothing persisted)

New read helper in `lib/queries/` (single source; every surface uses it): `getPendingStatementPairs(db, accountIds?)` → pairs where ALL of: (a) the newest holdings row of any source has `quantity = 0` AND is LIVE-origin (a `RECON_LIVE_SUFFIX` tombstone or a live-class source key); (b) the pair has NO statement-grade zero row at or after its newest statement-grade row (a statement-flat pair is the engine's job, never "pending"); (c) the same universe as the engine pass: long lots (`is_short = 0`), `security_type` stock/etf, `quantity_remaining > 0`; (d) not skipped by the split guard. Returns account, security, symbol, the live flat date, open quantity / basis. Every surface that reports open lots, unrealized totals or open-lot counts (Tax Lots page incl. its local filtered-summary reducers in `app/dashboard/tax-lots/page.tsx`, `getTaxLotSummary`/`ByAccount`, `getOpenTaxLots`, security detail, `getTaxLotsForChat` and its SQL, `portfolio-summary.ts`) must consume this helper or a flag derived from it — no local re-derivation.

Surfaces:

- **Tax Lots page** (`getOpenTaxLots`, `getTaxLotSummary` / `ByAccount`): open lots of pending pairs carry `pending_statement = true`; the row renders a `pending statement` chip (via `<Chip>`; numbers stay in `<Money>`/`<Shares>`). Unrealized totals EXCLUDE pending lots and the summary shows a separate disclosed line: "N positions closed per live data — awaiting statement" (counts through `<Count>`). Rationale: the position is no longer held, so its paper gain is not unrealized; its realized figure is unknown until the statement.
- **Security detail** open-lot / position-vs-lots area: same chip and exclusion.
- **Chat** (`getTaxLotsForChat`, `portfolio-summary.ts` realized/unrealized): pending lots are reported as pending, not as unrealized holdings; realized totals include only persisted closes (now statement-backed).
- **Data confidence**: the integrity scan already reports "open lots with no matching position" as a `warning`. `IntegrityHit` gains an optional typed `kind` (`"statement-lag"` for pending-statement pairs); severity stays `warning` (no new severity bucket), the score is never capped by it, and the UI renders it as informational ("awaiting statement"). Contract tests on the API shape and the rendered label.

**Contract for statement-backed synthetic closes (unchanged behavior, now explicit):** their price is the newest price on or before the statement zero date (breakeven fallback), never broker proceeds, so they are ESTIMATED and NON-FILING everywhere: engine-estimated disclosure on tiles and the closed-sales chip, excluded from the tax report / Form 8949 / TXF / broker reconciliation / trade reviews, and labeled as estimated in chat. A test enumerates every consumer of `RECONCILE_CLOSE` (repo source-scan guard, like the existing static guards) so a new consumer must declare include-with-disclosure or exclude.

### 2.3 Generation bumps (lib/compute/tax-convention.ts + writers)

The engine no longer reads live tombstones, and synthetic-close pricing only reads prices on or before statement-grade zero rows. So:

- `bumpIfPricesAffectSyntheticCloses`: compare price pairs against statement-grade newest zero rows only.
- `reconcileClosedEquityHoldings` bumps only when it minted / removed a statement-grade tombstone (`:stmt` or legacy), not for `:live` ones. The current helpers are origin-blind (`closed-equity.ts` ~349 and ~394): add origin-aware counting there rather than at call sites.
- Live position writers (TWS positions `lib/tws/positions.ts`, IBKR Web API `lib/ibkr/refresh.ts`, Plaid `lib/plaid/refresh.ts`) stop bumping for live-row supersession / ghost cleanup; they still bump through the closed-equity call if pass 1 wrote a `:stmt` tombstone. One test per writer (TWS, IBKR Web API, Plaid, import undo/restore, each price writer) asserting bump / no-bump for live-only vs statement-grade changes.
- Import / undo / recovery / repair-script bumps unchanged.

Result: engine output depends only on imported data, statement-grade tombstones and the prices they read; a press after nightly syncs is a no-op unless statement data changed.

### 2.4 QA

The deep sweep's Recompute check (a ledger finding's repro, `dashboard-tax-lots-recompute-recompute-silently-rewrites-…`) judges "non-idempotent" by stored-vs-pressed. Update that finding's repro/notes: idempotence = two presses on one copy are identical on source_key digests; stored-vs-engine is reported as "stale since generation N" and is expected only after statement-grade input changes. (Ledger is gitignored; edit at landing.)

### 2.5 Fail closed at deploy

The stored ledger was computed by the old gate, so live-only synthetic closes stay in it until the next recompute while `tax_input_generation` may still match the stamp. The convention stamp gains an engine revision (e.g. `v3r2:<generation>`), and "recompute current" requires the current revision: after deploy every stored ledger reads stale (Tax Lots stale banner, integrity scan Unchecked) until a recompute. Existing broker-acceptance records must NOT be wiped by the revision change (only a pre-v3 stamp resets acceptance today); if preserving them is impossible, stop and report. Test: an old-revision stamp at the current generation reads stale; a recompute re-stamps current; acceptance survives.

## 3. Invariants / tests (test-first)

1. **Live-only flat → no saved close.** Seed open lots + a `:live` tombstone as the newest row → engine mints nothing; lots stay open; `getPendingStatementPairs` returns the pair.
2. **Statement flat → close.** `:stmt` tombstone (or legacy unsuffixed) newest-statement-grade zero → close minted at that date, as today.
3. **Statement zero older, live re-buy row newer, no imported fill after statement date** → close still minted at the statement date (guard is imported fills).
4. **Real SELL arrives** → synthetic close disappears (self-heal), pending flag clears.
5. **Determinism / drift:** run engine; then simulate a live sync that adds/removes `:live` tombstones and live prices → generation unchanged and a second engine run is identical (source_key digest).
6. **Unrealized excludes pending lots;** the pending line counts them; realized excludes nothing new.
7. **Existing tests** in `tests/compute/tax-lots-reconcile-close.test.ts` seed zero rows with a `test-hold-` source_key (classifies as live): convert their fixtures to statement-grade tombstones where the test means "broker statement shows flat", and add the live counterpart asserting no close. Same for any integration test that relied on a live tombstone minting a close (`tests/integration/reconciler-hardening.test.ts` "newer-date re-buy via a live writer").
8. **Conservation:** for every pair, Σ lots acquired = Σ open remaining + Σ sold (real + synthetic) — unchanged by the gate.
9. Filing exclusions, trade-review exclusions and engine-estimated disclosure tests stay green unchanged.
10. Pending-definition edges: a statement-grade zero newest-statement row is never pending; a short lot, an option, a bond/fund are never pending; a split-guard-skipped pair is not pending.
11. Browser pass on a sandbox copy (agent-browser): Tax Lots shows the pending chip and the separate "awaiting statement" line, unrealized excludes pending lots, privacy mode masks the new numbers, security detail shows the chip, the data-confidence popover shows "awaiting statement" as informational, chat describes pending positions as pending, and the stale banner shows before a recompute.

## 4. Out of scope

- Importing September statements (user-run, pending arrival).
- Live re-run of `recompute-tax-lots-v2.ts --apply --live` (user-run after the statements; this change makes it stick).
- Partial-reduction modelling from live data (deliberately never; statements own trades).
- Filing-readiness account list reading unfiltered `tax_lot_sales` (`tax-report.ts` ~403-432) — note as a follow-up.

## 5. Rollout

Code-only, no schema migration (the stamp revision is a code constant). After deploy the stored ledger reads stale (§2.5) until the next user-run recompute; on that recompute, live-only synthetic closes vanish (their positions show pending statement) and real statement data replaces them as statements are imported. Current-portfolio specifics live only in the private diagnosis report.
