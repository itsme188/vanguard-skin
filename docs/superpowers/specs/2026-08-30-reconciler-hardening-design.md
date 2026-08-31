# Reconciler hardening — supersedable, batch-owned tombstones + fail-closed tax invalidation

**Date:** 2026-08-30 · **Source:** Codex F2+F7 (TODO line 80, filed from the holdings-latest sweep review) · **Rev 4** after three Codex review rounds (R1: 10, R2: 8, R3: 7 findings — each folded in or explicitly ruled below; R3 confirmed the tombstone model coherent, its findings refine tax-invalidation precision).

## Problem

`reconcileClosedEquityHoldings` (`lib/mutations/closed-equity.ts`) writes `quantity = 0` tombstone rows (`source_key` prefix `recon:closed-equity:`) to retire positions absent from an authoritative snapshot. Defects:

1. **Fail-open import.** `lib/import/engine.ts` (~:900-913) catches reconcile failures during post-commit hygiene and only logs them — the import reports clean success. The sibling purge sweeps share the shape.
2. **Same-date supersession impossible.** The import holdings upsert (~:485-495), the Plaid upsert (`lib/plaid/refresh.ts` ~:60-68), and the recovery restore guard (`lib/import/recovery.ts` ~:323-357, parity-pinned to the engine's clause) restrict overwrites to `tws-%`/`plaid:%`. A tombstone matches neither, so a corrected same-date statement re-import silently cannot restore a phantom-closed position.
3. **Undo can't remove tombstones.** They carry no `import_batch_id`; `undoImport` leaves them, so a bad import's phantom closes are permanent.
4. **Tax filing-readiness never invalidates on tombstone or synthetic-close-price changes.** `computeTaxLots`' broker-close pass synthesizes `RECONCILE_CLOSE` sales from latest-quantity-0 rows using the latest price at-or-before the zero date (`lib/compute/tax-lots.ts` ~:924-990), but `bumpTaxGenerationIfPresent` fires only for transactions / corporate actions / donations. Holdings, tombstone, and relevant price changes alter tax outputs without invalidating the generation-bound filing-ready markers.

## Tombstone model (decided, R1-F10 / R2-F1 / R2-F2)

A tombstone is a **derived row with recorded provenance**, never authority:

- **Validity invariant:** a tombstone is justified only while a real (non-recon) holdings row exists for the same (account, `as_of_date`) — true by construction at creation, since its date IS its reference snapshot's date. A tombstone that loses its same-date real snapshot is an **orphan** and is deleted (never rebuilt wholesale — a full delete-and-re-derive would re-land tombstones on *current* reference dates, silently moving historical close dates in valuations and `RECONCILE_CLOSE` tax realization dates; orphan cleanup is history-preserving).
- **Origin suffix (R2-F2):** new tombstone `source_key`s append the minting pass — `recon:closed-equity:{acct}:{sec}:{date}:stmt` (statement pass) or `…:live` (equity/option live passes). Suffix, not prefix change: every existing prefix match keeps working. Legacy unsuffixed rows are treated as statement-grade (conservative).
- **Supersession is directional (statement-wins preserved):** statement writers (import commit, recovery restore) may overwrite *any* tombstone; live writers (Plaid) may overwrite only `…:live` tombstones — a live row must not erase statement-derived closure evidence, which the statement pass could never re-derive (its `latest < stmtDate` test would be masked by the same-date live row).
- **Batch ownership is cleanup hygiene, not provenance (R1-F1):** an import stamps `import_batch_id` on tombstones minted during its post-commit reconcile, only for accounts whose holdings that batch imported (never cross-account). Sync-minted tombstones stay NULL-batch.
- **Re-derivation is the safety net (R1-F3):** undo and restore run *orphan cleanup + re-reconcile* after their row changes, so deleted-but-still-justified tombstones come back at their original reference dates (surviving snapshots), and unjustified ones (including legacy pre-deploy orphans) go away.

## Design

### 1. Supersession, single-sourced (`lib/db/holding-sources.ts`)

- Export `RECON_HOLDING_SOURCE_PREFIX = "recon:closed-equity:"` (used by the reconciler when stamping — writer/matcher cannot drift) and the two origin suffixes.
- Helpers (same compile-time-constant interpolation contract as `statementSourcedHoldingSql`, pinned by tests):
  - `statementOverwritableHoldingSql(col)` — live prefixes + ANY recon row. Used by the import upsert and the recovery restore guard (parity pin honored by construction: both call the same helper).
  - `liveOverwritableHoldingSql(col)` — live prefixes + recon rows with the `:live` suffix only. Used by the Plaid upsert.
- Cures three pre-existing inline-LIKE convention violations.

### 2. Reconciler changes (`lib/mutations/closed-equity.ts`)

- Options gain `importBatchId?: number` + `ownedAccountIds?: number[]`; tombstone INSERT stamps the batch id only when `importBatchId` is set AND the tombstone's account is in `ownedAccountIds`. Engine passes `result.batchId` (`batch` is out of scope post-transaction) + distinct account ids of `parsed.holdings`.
- Tombstone source_keys carry the origin suffix per pass.
- The whole run wraps in `db.transaction` (R1-F6) — mid-run failure rolls back every tombstone from that run (better-sqlite3 nests via savepoints, verified R2).
- If the run marked > 0, it calls `bumpTaxGenerationIfPresent(db)` inside the transaction — tombstone creation is a tax event regardless of caller.
- New export `removeOrphanedReconTombstones(db, { accountIds? })`: DELETE recon-prefixed rows whose same-(account, date) justifying evidence is gone — **origin-aware (R3-F3)**: `:stmt` and legacy unsuffixed tombstones require a surviving same-date *statement-sourced* row (a same-date Plaid row is not statement evidence); `:live` tombstones require any surviving same-date non-recon row. (The finer option-presence-evidence sub-rule is deliberately not modeled — the live passes re-derive option tombstones only against option-carrying snapshots, and a stale one self-corrects on the next sync.) Returns count; bumps generation when > 0.

### 3. Undo / restore (`engine.ts` undoImport, `lib/import/recovery.ts`)

- `undoImport`: `deleteImportBatch` + `removeOrphanedReconTombstones` + `reconcileClosedEquityHoldings` (unowned) run in **one outer transaction** — if the tombstone rebuild fails, the undo refuses rather than half-completing (R2-F5). The heavy recomputes (`computeTaxLots`, `computeDailyValuations`) stay best-effort AFTER it, per the pre-existing deliberate decision (engine.ts ~:934 comment: a recompute failure must not un-delete the batch); they are idempotently re-runnable and the already-bumped generation keeps tax fail-closed meanwhile.
- `restoreImportBatch`: skips recon-prefixed manifest holdings rows at INSERT time (checksum verification runs before filtering, payload untouched — checksum-safe per R2), then orphan cleanup + re-reconcile the same atomic way before its recomputes. **Generation rule (R3-F5, simplified):** restore bumps whenever its manifest carries holdings or prices rows — no `.changes`-based idempotence claim (SQL `.changes` counts equal-value `DO UPDATE`s, and `raw_imports` has no unique key, so true idempotence detection is false precision). Restore is a rare manual recovery operation; the over-bump is fail-closed and accepted. (`raw_imports` duplication on double-restore is pre-existing and out of scope.)

### 4. Tax-generation invalidation (R1-F2, R2-F3, R2-F4)

Fail-closed, scoped to mutations that can actually change tax outputs — NOT blanket per-sync bumps, which would permanently invalidate filing-readiness (Plaid/TWS write holdings and prices daily).

**Precision doctrine (R3-F4, ruled):** the generation is deliberately COARSE and conservative, matching the existing system (any new transaction bumps globally today — and every genuine monthly statement import carries transactions, so it already bumps). Over-bump costs one re-run of the acceptance script; under-bump risks a wrong filing. A "synthetic-close dependency signature" computed before/after every mutation is a subsystem this problem does not warrant. Bump rules below therefore accept documented over-bumps and hunt only fail-OPEN holes.

- **Import commit:** bump condition extends with `newHoldings > 0` (fully-deduped re-imports still don't bump; the monthly-import over-bump is moot — transactions already bump it).
- **Reconciler / orphan cleanup:** bump inside the run when rows were created/removed (§2).
- **`deleteImportBatch`:** bump condition adds `holdingsDeleted.changes > 0` and captured price-pair deletions per the price rule below.
- **Live writers — TWO tombstone-relevant transitions (R2-F3 + R3-F1), same treatment in Plaid, the TWS positions writer, AND the IBKR Web API fallback writer (`lib/ibkr/refresh.ts`, previously omitted):**
  1. *Same-date supersession* — recon rows at (account, sync date) decreased across the write.
  2. *Newer-date supersession* — the writer wrote a non-zero row for a security whose prior latest row was quantity 0 (a re-bought position: the synthetic close silently vanishes from `computeTaxLots`' latest-row test without any same-date touch).
  One post-write query per sync detects both; either bumps once. Routine syncs touching no tombstoned security never bump.
- **Prices (R2-F4 absorbed; shape per R3-F2):** helper `bumpIfPricesAffectSyntheticCloses(db, pairs: {securityId, date}[])` — every writer knows the (security, date) pairs it writes; undo/restore capture the batch's price pairs BEFORE deletion (one SELECT). Bumps once when any pair's security is in tombstone state (some account's latest holdings row is quantity 0) with pair date at-or-before that zero date. Call sites: import price commit, undo, restore, and every `prices`-table writer enumerated at implementation time (TWS snapshot/price paths, Plaid upsert; `benchmark_prices`/`ohlcv_bars` are out — the synthetic close reads `prices` only). Held-security price writes never bump (held ⇒ latest row non-zero), so daily syncs stay bump-free. Declined (R3-F2's fuller form): a centralized transactional price writer and selected-vs-irrelevant price discrimination — an older-than-selected price write for a *tombstoned* security over-bumps, accepted.
- **Atomicity (R3-F6):** each writer's mutation block + transition detection + bump share one `db.transaction` (TWS positions commit already is one; Plaid's per-account block gets one; price-writer bump rides the same transaction as its writes). A crash between write and bump then rolls back the write too — no fail-open gap.
- The existing `tests/api/import-undo-recovery.test.ts` premise ("holdings/prices-only restore is not a tax input") is updated deliberately.

### 5. Failure surfacing (`engine.ts`, route, UI)

- The three post-commit sweep catch blocks push **stable domain-language** lines into `result.warnings` (no raw exception text — R1-F9; raw error stays in the server log): e.g. "Post-import closed-position reconcile failed — recently sold positions may still show as open. It will retry on the next sync."
- On sweep failure, append a short marker to `import_batches.summary` (persists in history).
- `ImportHistory.tsx` renders the batch summary line (compact, muted) so the marker is actually visible (R2-F6) — today it renders filename/type/count/date only.
- `app/api/import/route.ts` stops inferring corporate-action replay evidence from `warnings.length` — it tests `newCorporateActions`/explicit CA warnings instead, so sweep warnings can't contaminate replay status (R2-F7).

### 6. Tests (TDD; in-memory SQLite; DI; synthetic fixtures only)

Core: same-date correction restores a phantom-closed position (import; counted as change, not duplicate); Plaid supersedes a `:live` tombstone but NOT a `:stmt` or legacy one (directional precedence, both directions asserted); restore overwrites any tombstone and never re-inserts recon manifest rows (a double restore corrupts no uniquely-keyed table; per §3 it MAY bump again — that over-bump is the specified behavior, asserted as such).

Undo/rebuild: owned tombstones deleted + prior non-zero row latest again; cross-account non-ownership; NULL-batch tombstone survives unrelated undo; legacy orphan removed when its justifying snapshot is undone; bad-A → corrected-B → undo-B re-derives A's tombstone at A's original date; rebuild failure rolls the undo back whole.

Tax generation: bumps on holdings-writing import, tombstone-creating reconcile, orphan cleanup, live-writer same-date AND newer-date tombstone supersession (Plaid, TWS, IBKR Web API parity — R3-F1/F7), tombstone-state price write at-or-before the zero date, undo deleting holdings/captured price pairs, holdings/prices-carrying restore; does NOT bump on deduped re-import or routine held-security price/holdings sync. Assert `RECONCILE_CLOSE` rows actually appear/disappear across a tombstone lifecycle (including the newer-date re-buy path with no tombstone deletion), and assert filing-readiness *state* (via `getTaxConventionState`), not just the counter. Mixed-source orphan evidence (`:stmt` tombstone + surviving same-date Plaid row ⇒ still orphaned once statement evidence is gone). Double restore: no data corruption on uniquely-keyed tables, bump behavior as specified. Fault injection: a throw inside a writer's transaction rolls back mutation AND bump together.

Guards: reconcile-run atomicity; warning surfacing (mocked throw → commit succeeds, `result.warnings` + summary marker present, replay status uncontaminated); prefix/suffix pinning in `tests/db/holding-sources.test.ts`.

E2E (browser, sandbox DB copy, secretless env): corrected re-import flow (phantom-closed position reappears on Accounts) AND undo flow (import → phantom close → undo → position restored). Then `npm run verify:changed` + full `npx vitest run`.

## Non-goals / ruled

- **No backfill of legacy NULL-batch tombstone ownership** (R1-F7): can't be guessed; the live DB's current tombstones were audited correct 2026-08-30 (TODO line 78). Orphan cleanup now handles the *unjustified-legacy* case structurally, which is the part that mattered.
- **No change to TWS `INSERT OR REPLACE` holdings semantics.** It already violates statement-wins for ALL row types at equal dates (clobbers same-date statement rows, not just tombstones) — a pre-existing, broader question deliberately out of scope; the exposure window is only a statement dated today + a same-day TWS sync. The TWS writer DOES gain the tombstone-supersession generation bump (§4), which bounds the tax consequence.
- No retry UI (self-healing next sync + persisted marker are proportionate; R2 concurred no retry control needed).
- No data-confidence scoring change. No schema migration (all columns exist).

## Files

`lib/db/holding-sources.ts`, `lib/mutations/closed-equity.ts`, `lib/import/engine.ts`, `lib/plaid/refresh.ts`, `lib/tws/positions.ts` + `lib/tws/snapshot.ts` (tombstone-supersession + price bumps only), `lib/ibkr/refresh.ts` (same, fallback-writer parity), `lib/import/recovery.ts`, `lib/mutations/import-batches.ts`, `lib/compute/tax-convention.ts` (price helper, if housed there), `app/api/import/route.ts`, `app/dashboard/components/ImportHistory.tsx`, `tests/**`, `docs/plans/TODO.md` (close line 80), doc-comment touch-ups (`closed-equity.ts` header, `holding-sources.ts` taxonomy, `recovery.ts` parity note).
