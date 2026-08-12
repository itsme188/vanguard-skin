# IBKR Corporate Actions (splits) — design

**Date:** 2026-08-11 · **Issue:** #37 ([P0][Ledger] Ingest IBKR Corporate Actions without corrupting lots or P&L)
**Decisions locked with user:** scope = splits + reverse splits only (everything else warns); existing manual Apply/Undo road untouched this round; live repair = authorized re-import of the July 2026 statement in the same session, after merge.
**Review:** two independent Codex design reviews 2026-08-11 (via `/codex-review-plan`), both REVISE. Round 1 (10 findings): manual-collision handling, manual-road guard, persisted delta cross-check, and test/privacy additions incorporated; duplicate-owner undo documented as inherited import-system semantics; same-day ordering resolved by the end-of-day rationale. Round 2 (12 findings): account-scoped cross-check, import-vs-import + opposite-type collision coverage, centralized ratio validation, synchronous CA-commit recompute with replay status, symbol normalization via the standard path, privacy components on delta rendering, and the added tests incorporated; re-raised timestamp-ordering and multi-batch-ownership findings stand as documented pushbacks (end-of-day rationale; inherited semantics). R2-10 (naming the ticker in this spec) escalated to the user — decision 2026-08-11: keep the ticker (public market fact, quantities omitted), consistent with existing committed-doc practice.

## Problem

The IBKR Activity Statement parser (`lib/import/parsers/ibkr-activity.ts`) ignores the statement's `Corporate Actions` section. Split rows are silently dropped, so the tax-lot ledger diverges from the broker's book after any split. Verified live case: CrowdStrike's public 4:1 split (2026-07-01) — the one remaining ledger-vs-broker gap from the 2026-08-03 rebuild audit. (Portfolio-specific quantities/basis intentionally omitted here per issue #37's sanitization rule; they live in the local statement.)

## Statement shape (observed, July 2026 CSV)

```
Corporate Actions,Header,Asset Category,Currency,Account,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code
Corporate Actions,Data,Stocks,USD,<acct>,<report-date>,"<effective-date>, 20:25:00","SYM(ISIN) Split 4 for 1 (SYM, NAME, ISIN)",<share-delta>,0,0,0,
Corporate Actions,Data,Total,,,,,,,0,0,0,
```

Key facts: the ratio lives only in the description text ("Split N for M"); the `Quantity` column is the **share delta**, not the ratio; the action's own `Date/Time` (effective date) differs from `Report Date`; the timestamp is after the close.

## Chosen semantics: split as a replayed event

Three approaches were considered:

- **A (chosen): replay-native event.** Store the split in `corporate_actions` (`source='import'`); `computeTaxLots` — already a full chronological replay of `transactions` — applies it as an event in the stream. No history rewrite; re-imports stay idempotent; statement rows keep their statement-date basis (the "never mix bases" integrity rule).
- **B (rejected): reuse the manual rewrite machinery** (`addCorporateAction` rewrites all pre-split transactions/prices/bars/holdings to post-split basis). Rejected because it would pull the known multi-minute recompute freeze into the import flow and, worse, break re-import idempotence: an older statement imported after the rewrite would insert pre-split-basis rows into an already-rewritten history with nothing to ever adjust them.
- **C (rejected): zero-cost share injection** (+delta shares at $0 basis). Corrupts per-share basis, holding periods, and realized P&L. Ruled out in the TODO before this design.

## 1. Data model (additive migration)

Existing schema (migration 018) already carries `UNIQUE(security_id, action_type, effective_date)` — the business key. The new migration is additive alongside it:

- `source_key TEXT` + unique partial index (`WHERE source_key IS NOT NULL`). Import key shape: `ibkr:ca:split:<effective-date>:<symbol>:<num>:<den>`. The business-key constraint stays; the commit path (not the constraint) handles manual-vs-import collisions — see §3.
- `import_batch_id INTEGER` (references `import_batches`) for undo.
- `reconcile_delta REAL` (nullable; `NULL` = clean) — persisted broker-delta mismatch from the replay cross-check, see §4.
- Ratio validity (finite, > 0) is enforced at the parser and commit layers, not by `CHECK` constraints — SQLite's `ALTER TABLE ADD COLUMN` can't retrofit table-level checks, and the app layer is where every other importer validates.

`source` now encodes the mode — this is the crux:

- `source='manual'` (existing rows): history was rewritten at apply time, `applied=1`. **Excluded from the replay** — replaying would double-apply.
- `source='import'` (new rows): history untouched, `applied=0` forever. **Only these** merge into the `computeTaxLots` replay.

No backfill; existing rows untouched.

## 2. Parser

New Corporate Actions pass in `parseIbkrActivity`, columns read **by header name** (Trades-section pattern — IBKR drops the Account column on single-account statements):

- `Data` rows only; `Total` row silent.
- Symbol from description prefix (`SYM(ISIN) …` — same regex family as Dividends).
- Ratio from description: `/\bSplit (\d+) for (\d+)\b/`. num > den → `SPLIT`; num < den → `REVERSE_SPLIT`. Ratio stored as written (numerator/denominator).
- Effective date = the `Date/Time` column's date part, **not** Report Date.
- `Quantity` captured as `quantityDelta` — reconciliation cross-check only, never the booking truth.
- Anything else — non-`Stocks` asset category (OCC option adjustments), mergers, spinoffs, CUSIP changes, unparseable descriptions, ratio/denominator of 0 — produces a named parser warning (`Corporate Actions: unsupported action skipped — "<description>"`). Nothing silently drops.

`ParsedImportResult` gains `corporateActions: ParsedCorporateAction[]` (new interface in `lib/import/types.ts`): `{ symbol, actionType: "SPLIT" | "REVERSE_SPLIT", effectiveDate, ratioNumerator, ratioDenominator, quantityDelta, sourceKey }`. Empty for all other parsers.

## 3. Import engine

- **Preview:** response includes corporate-actions count + sample rows (symbol, "4:1 split", effective date) — the split is visible before Confirm.
- **Commit:** `INSERT OR IGNORE` on `source_key`; rows tagged with `import_batch_id`, `source='import'`, `applied=0`. The existing post-commit auto-recompute (tax lots + valuations) makes the split take effect — no new machinery.
- **Collision handling (Codex findings R1-1, R2-5, R2-7):** before insert, the commit checks for ANY existing action on the same `(security_id, effective_date)` — deliberately ignoring `action_type`, so an opposite-type row can't slip past, and covering both `source='manual'` and previously imported rows. Same ratio + same type → silent skip (already covered; for a manual row the rewrite already happened and the replay's manual-exclusion keeps the end state correct). Anything else — differing ratio (e.g. a corrected statement), differing type — skips AND emits a result warning naming both rows ("existing manual 2:1 vs statement 4:1 — resolve manually"). The statement never silently overrides an existing decision, and a disagreement is never swallowed by `INSERT OR IGNORE`.
- **Symbol resolution (Codex finding R2-9):** the parsed symbol is everything before the first `(` in the description (trimmed — not `\w+`, so dotted/suffixed symbols survive), then resolved through the same symbol-normalization path trades use at commit (`resolveIbkrExchangeSuffixedSymbol` + standard security resolution). An unresolvable symbol → warning, never a guessed security.
- **Validation (Codex finding R2-6):** ratio/date validity (finite, > 0, valid `YYYY-MM-DD`) lives in ONE helper in `lib/compute/corporate-actions.ts`, called by both the import commit and the existing manual POST route — the manual road gains the guard for free without otherwise changing.
- **Synchronous recompute for CA-bearing commits (Codex finding R2-4):** the normal post-commit recompute is silent/non-blocking, which would strand replay warnings after the response is gone. When a commit contains corporate actions, `computeTaxLots` runs synchronously and the import result carries a replay status (`clean` / `mismatch` / `failed`) plus any reconcile warnings. `reconcile_delta IS NULL` means "clean" only after a successful replay — a `failed` status is reported as failed, never as clean.
- **Manual-road guard (Codex review finding 2):** `/api/corporate-actions` DELETE/undo refuses `source='import'` rows with 403 and a domain message ("imported from a statement — undo its import batch instead") — the sync-owned-rows convention. Imported actions leave only via batch undo. A manual POST for the same (security, type, date) hits the business-key constraint; the route maps that to a domain-language 409 ("already imported from the statement") instead of a raw constraint error. The manual apply path never touches import rows, so the rewrite/replay modes cannot double-apply.
- **Undo:** `deleteImportBatch` also deletes the batch's `source='import'` CA rows; its existing wholesale recompute restores pre-split lots. Fully reversible.
- **Duplicate-owner semantics (disclosed, unchanged):** if statement B re-imports an action already owned by batch A, the dedupe skips it and A keeps ownership; undoing A removes the action even though B also carried it. This is the import system's existing behavior for every record type (transactions included), not a new hazard — documented, not special-cased.
- Same-key-different-values re-imports skip silently — the known importer-wide limitation, tracked by the existing TODO conflict-warning item; not widened here.
- **Holdings-snapshot sweep gate (plan-review addition, Codex 2026-08-11):** the post-import sweeps (expired-option/matured-bond purges + closed-equity reconciliation) currently key on source TYPE alone; a CA-only statement import carries an empty holdings snapshot and must not run them (an empty-snapshot closed-equity reconcile is a mass-close hazard). The sweeps additionally require `parsed.holdings.length > 0` — snapshot evidence, not just source type.
- **Contract inventory** (everything the new record type touches): `lib/import/types.ts` (`ParsedCorporateAction`, result counts), `lib/import/validate.ts` (ratio/date/symbol validation), `lib/import/engine.ts` (commit + `deleteImportBatch`), the import API preview/commit response shapes, and the ImportFlow preview UI (corporate-actions sample rows + warnings rendering).

## 4. `computeTaxLots` replay integration

Load `corporate_actions WHERE source='import'` ordered by `effective_date`; merge into the chronological sell loop:

- Before each sell, apply pending events with `effective_date < sell.trade_date`; apply leftovers after the loop. **End-of-day rule:** a sell dated the effective date processes *before* that date's split, and same-day buys (`acquisition_date <= effective_date`) are adjusted. Rationale (Codex review finding 3): US equity extended-hours trading ends 20:00 ET and IBKR stamps split actions after that (observed 20:25), so every same-date trade executed in pre-split units — the date-only ledger can't observe a post-stamp same-day trade, and none can exist within the trading session. Test-pinned — if the split applied first, same-day sells would mismatch lots by exactly the ratio and the error would compound into every later sale.
- Applying: for every lot of that security (any account) with `acquisition_date <= effective_date` AND `quantity_remaining > 0`:
  `quantity_acquired ×= ratio`, `quantity_remaining ×= ratio`, `acquisition_price ÷= ratio`; `cost_basis` and `acquisition_date` untouched (total cost preserved; holding period survives — tax-correct).
- Fully-closed lots untouched. A partially-sold-then-split lot keeps its earlier `tax_lot_sales` rows in pre-split units (1099-B convention: each row honest in its own date's basis) while the remaining side is post-split. Disclosed, deliberate.
- **Delta cross-check (persisted — Codex findings R1-4, R2-1):** after applying, compare implied new shares to the statement's `quantityDelta` — computed over the **importing account's lots only** (the statement is single-account evidence; the split itself still applies to every account's lots, since a split is a market event, but comparing an all-accounts sum against one account's delta would manufacture false mismatches). Tolerance: 1e-6 shares (split ratios are exact). A mismatch is not just logged — it is written to the CA row (new nullable `reconcile_delta REAL` column in the same migration; `NULL` = clean), included in the `computeTaxLots` result warnings, surfaced in the import result, and rendered in the security-detail Corporate Actions section — **through `<Shares>`/`<PrivateText>` privacy components** (Codex finding R2-11): the delta is a portfolio-derived share count and must mask in privacy mode like every other portfolio number. The lots still adjust (the ratio is authoritative); the persisted delta is the "ledger was already missing shares" tripwire (the 2024 ACATS class) awaiting user review. Each recompute refreshes it.
- Later passes (RECONCILE_CLOSE synthesis, premium adjustments) run unchanged and now see broker-consistent quantities.

## 5. Edge cases

- No open lots at effective date → applies to nothing; delta cross-check warns.
- Reverse splits: same math, ratio < 1. Fractional results stay fractional; cash-in-lieu arrives as its own statement row and is out of scope this round (disclosed). The delta cross-check is the tripwire (Codex finding R2-3): when the broker cashed out fractions, the statement delta won't match the pure-ratio result, so `reconcile_delta` persists the divergence for user review rather than the ledger silently drifting. Rejecting such splits outright would be worse — the ledger would miss the split entirely.
- Multiple splits on one security compose in date order.
- Foreign-currency stocks: ratio math is currency-free.
- Options on a split underlying: OCC adjustments are not stock splits; those rows warn and never touch option lots.
- `daily_valuations` unaffected: holdings and prices rows are each internally consistent at their own dates; the CA row changes neither.

## 6. Testing

1. **Sanitized parser fixture** (`tests/fixtures/`, fake tickers): 4-for-1 split + reverse split + unsupported merger + Total row + a malformed row (non-numeric quantity / zero-denominator description). Assert: both splits parse (type, ratio, effective-date-not-report-date, delta); merger and malformed rows warn by name; Total silent.
2. **Pure compute tests** (in-memory SQLite): pre-split buy → post-split sell invariants (post qty ×ratio, per-unit basis ÷ratio, total basis unchanged, realized P&L of pre-split closed sales unchanged); same-day sell-before-split ordering pin; partially-sold lot; sequential splits; reverse split (incl. fractional-result delta tripwire); no-open-lots warning; `source='manual'` exclusion (double-apply guard); delta-mismatch persisted to `reconcile_delta`; multi-account holders both adjust while the cross-check scopes to the importing account; corrected-statement ratio-conflict warning; opposite-type collision warning.
3. **Disposable-DB integration:** preview → commit → recompute on the fixture; assert lot invariants AND daily-valuation continuity across the split (no discontinuity at the boundary — Codex review finding 8); manual-collision cases (same ratio silent skip; ratio mismatch warns); manual-API undo of an import row → 403; undo the batch → full restoration; re-import → idempotent no-op. Migration coverage rides the existing migration-runner test pattern (fresh DB migrates clean; pre-existing manual rows keep working with NULL new columns).
4. **Browser E2E** (per the always-test-as-a-real-user rule): import the sanitized fixture through the UI — preview shows the split sample and the unsupported-action warning before Confirm; commit; verify the security-detail Corporate Actions section shows the imported row, and that a reconcile-delta warning masks correctly in privacy mode.
5. **Broker reconciliation acceptance** (manual, live-DB copy, not committed): the verified split case reconciles ledger-vs-broker through the split. **Privacy check (Codex review finding 9):** committed fixtures use fake tickers only; issue-close evidence and any screenshots/logs are sanitized (no portfolio tickers, quantities, basis) and live evidence stays out of the repo.

## 7. Mac/Worker parity

**Mac-only, by architecture.** The Worker never ingests statements; its fallback reads the R2 snapshot produced from the Mac's already-computed DB. No mirror exists for the import pipeline; nothing to parity-pin. This rationale accompanies the issue close.

## 8. Live repair (separate, explicitly authorized)

After merge + green suite and the user's go: back up `data/vanguard.db`; re-import the July 2026 statement CSV through the normal road (dedupe skips existing rows; the one new CA row lands); post-commit recompute runs; verify the split case's lot quantities/basis invariants and the broker trajectory; verify a second re-import is a no-op. Issue #37 closes only after this evidence exists (sanitized).

## Non-goals

- Mergers, spinoffs, CUSIP changes, stock dividends, cash-in-lieu rows (warn-only).
- The manual Apply/Undo road and its freeze finding (separate QA item).
- The audit tool's same-day interleaving rule.
- Import-wide same-key-different-values conflict warnings (existing TODO item).
