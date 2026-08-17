# Donation Tracking (R4) + In-Kind Transfer FMV Fix — Design

**Date:** 2026-08-17
**Issues:** `docs/plans/TODO.md:16` ([R4] stock donation tracking) + `docs/plans/TODO.md:64` (in-kind TRANSFER legs book at amount=0 → fake return days)
**Approach chosen by user:** Full integration (Approach 2) — donations ledger + metrics fix + tax-lot consumption in one build.
**Privacy note:** all portfolio specifics (tickers, quantities, dollar values, exact dates) live in the gitignored companion `data/notes/2026-08-17-donation-reconciliation.md`. This committed spec uses anonymized shapes only.

## 1. Problem

Two coupled defects, one design:

1. **Metrics corruption (live today).** In-kind `TRANSFER_IN`/`TRANSFER_OUT` transaction legs are booked with `amount = 0` and `is_external_flow = 1`. `fetchNetFlowsByDate` (`lib/compute/flow-adjusted.ts:43-76`) sums amounts, so a $0 leg contributes nothing and its date is dropped by `HAVING SUM(...) != 0` — the flow-adjusted index reads each in-kind departure as a fake market LOSS (and each return as a fake GAIN) in vol / Sharpe / drawdown / beta / TWR. The June-2026 donation departures are live examples; a bounced donation's return leg will import at $0 too.
2. **No donation tracking (R4).** The user donates appreciated stock to a donor-advised fund (DAF). The app has no concept of a donation: outbound legs do nothing in the tax-lot engine (deliberately, `lib/compute/tax-lots.ts:88-89`), so donated shares sit in open lots forever (one donated name shows materially more shares open in lots than are actually held), and there is no surface for the tax-relevant numbers (FMV at transfer, basis, embedded gain avoided, YTD totals).

## 2. Ground truth discovered during design

The user's DAF provider exports authoritative per-year contribution CSVs
(`contributions-YYYY.csv`, header `type,frequency,amount,currency,USD amount,currency valuation,created at,received at,completed at`). Reconciling 2024–2026 against the app's transactions (full table: gitignored companion file):

- **Fifteen stock contributions across three years.** Three match unpaired net-outbound transfer legs; **eight exist only as same-day, same-account IN+OUT pairs that net to zero**; the 2026 donations match net-out residuals; four cash (bank-transfer) contributions never crossed the brokerage at all.
- One 2026 attempt (a long-dated call option) is **absent from the DAF file** — the bounced donation: the DAF could not custody options, the broker approved a return ~6 weeks later, and the return leg has **not yet been imported** (it arrives with the August statement).
- One donation the user initially recalled as a sale was confirmed donated by the DAF record (with the classic whole-shares-out + fractional-residual-sale pattern on the statement).
- Every historical leg carries a `canonical:txn` source key — hand-authored canonical CSV imports transcribing both statement lines per the guide's "one row per journal line" instruction. The broker's statement prints an outgoing AND an incoming transfer line for a DAF gift; the IN line is a **booking artifact of the DAF routing** — the DAF's receipt proves the shares left for good.

Consequences that shaped the design:

- **No statement-side classifier can be authoritative.** The dominant historical form is a zero-netting pair; the broker's transfer labels are identical for donations and broker moves. The DAF CSV is the source of truth.
- The DAF `USD amount` is the exact FMV at receipt — the number the IRS cares about — superior to any price-table lookup for donation rows.
- The eight pair-form donations currently contribute NOTHING to flows while their shares left the holdings — those statement months read the departures as fake market losses. The repair scope is the full history, and its main move is artifact demotion (§8), not row synthesis.

## 3. User decisions (recorded)

1. **DAF CSVs are the authoritative donation source**; statement transfer legs are corroboration.
2. Donation surface lives as an **Analysis sub-view ("Giving")**.
3. **Cash DAF contributions are included** in the ledger and YTD totals, but they are NOT portfolio events: they never touch `transactions`, flows, or valuations. Visually separated in the UI.
4. **Lot designation varies per donation** ("statements say"). Per-donation explicit lot assignment; NO fabricated default. The UI may suggest highest-gain long-term lots, but a suggestion only becomes an assignment when the user confirms it. Unassigned → basis/gain-avoided render "pending lot assignment".
5. **Approach 2 — full integration**: `computeTaxLots` consumes donated lots in this build.
6. The recalled-as-sale donation is confirmed donated (DAF record over recollection).

## 4. Data model

Next-numbered migration in `lib/db/migrations/` (number resolved at implementation, as always):

```sql
CREATE TABLE donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT UNIQUE NOT NULL,        -- see §5
  import_batch_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('stock','cash')),
  security_id INTEGER,                    -- nullable; resolved by symbol at import
  symbol_raw TEXT,                        -- as printed in the DAF file (stock rows)
  quantity REAL CHECK (quantity IS NULL OR quantity > 0),
  fmv_usd REAL NOT NULL CHECK (fmv_usd > 0),
  unit_valuation REAL CHECK (unit_valuation IS NULL OR unit_valuation > 0),
  created_date TEXT,                      -- ET dates derived from the UTC timestamps
  received_date TEXT NOT NULL,            -- the tax-relevant date
  completed_date TEXT,                    -- NULL = received/in-process (see §7 eligibility)
  notes TEXT,
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  FOREIGN KEY(security_id) REFERENCES securities(id)
);
CREATE INDEX idx_donations_received ON donations(received_date);
CREATE INDEX idx_donations_security ON donations(security_id);

-- Confirmed donation ↔ transfer-leg links. Reconciliation SUGGESTS matches (§7);
-- a row here exists only after user confirmation (Giving UI) or a reviewed
-- --apply of the repair script (§8). Roles:
--   'out'              — the donation's outbound leg (flow-carrying)
--   'routing_artifact' — a zero-netting IN leg demoted out of flow math
CREATE TABLE donation_leg_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL,
  transaction_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('out','routing_artifact')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(donation_id) REFERENCES donations(id) ON DELETE CASCADE,
  FOREIGN KEY(transaction_id) REFERENCES transactions(id)
);

CREATE TABLE donation_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL,
  acquisition_transaction_id INTEGER NOT NULL,  -- STABLE lot identity (transactions are never rebuilt; tax_lots are)
  quantity REAL NOT NULL CHECK (quantity > 0),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(donation_id, acquisition_transaction_id),
  FOREIGN KEY(donation_id) REFERENCES donations(id) ON DELETE CASCADE,
  FOREIGN KEY(acquisition_transaction_id) REFERENCES transactions(id)
);
```

Notes:

- **No status column.** Status is derived: `completed_date` present → completed; else received. Bounced attempts are NOT donation rows (they never appear in the DAF file); they surface from reconciliation (§7).
- **Stable lot identity** is `acquisition_transaction_id` (`tax_lots.acquisition_transaction_id` already exists). `tax_lots.id` values do not survive recomputes; transaction ids do. Opening-snapshot lots (`is_from_opening_snapshot=1`, NULL acquisition txn) are NOT assignable in v1; the UI says so and the donation stays pending (documented limitation).
- **`donation_lots` assignment invariants are enforced in the mutation, transactionally, reject-not-clamp** (Codex R1-3): the acquisition transaction must (a) be a lot-creating type for (b) the same security and (c) the same account as the donation's confirmed `out` leg, (d) predate the donation, (e) leave assigned-qty ≤ the lot's remaining quantity as of the donation date, and (f) total assigned across lots ≤ donation quantity. Any violation → 4xx with a domain-language explanation; nothing is written.
- **Split/unit basis** (Codex R1-4): assignments are expressed in donation-date units. `computeTaxLots` replays chronologically, so consumption applies at the donation date in the then-current share basis; earlier splits have already adjusted the lots the user assigned against, and later splits adjust the post-consumption remainder. No conversion table is needed — but the ordering is now an explicit, tested invariant (§11).
- `donations`, `donation_leg_links`, `donation_lots` rows delete via import-batch undo or explicit unlink mutations only (§10, §11-undo).

## 5. DAF import format (`daf-contributions`)

Standard pipeline: Detect → Parse → Preview → Confirm → Commit (`lib/import/`).

- **Detect:** header match on `type,frequency,amount,currency,USD amount,currency valuation` (distinctive; no other format shares it). Blank second line tolerated (present in real files).
- **Parse** (`lib/import/parsers/daf-contributions.ts`): rows have leading whitespace — trim. `Stock` rows → `kind='stock'`, `symbol_raw = currency` col, `quantity = amount` col, `fmv_usd = USD amount`, `unit_valuation = currency valuation` (may be blank). `Bank transfer` rows → `kind='cash'`, `fmv_usd = USD amount`. Dates: take the ET date (`America/New_York`) of each UTC timestamp; `received at` is the tax date. Unknown `type` values → parse warning, row skipped (never guessed).
- **Security resolution:** case-insensitive symbol match against `securities`; unresolved symbols keep `security_id NULL` + `symbol_raw`. The row imports and displays, but matching and lot assignment are DISABLED until the user resolves the symbol through the existing security search (never auto-create a security; Codex R1-13).
- **source_key:** `daf:contribution:{received_date}:{symbol|USD}:{qty|amount}:{created-at-timestamp}` — the provider's `created at` is a stable per-contribution identity that disambiguates genuine same-day duplicates without file-order-dependent ordinals (Codex R1-7). Missing `created at` → fall back to the `:#N` ordinal with a parse warning.
- **Re-import is a metadata upsert, not a pure no-op** (Codex R1-8): an existing source_key row updates its non-identity fields (`completed_date`, `unit_valuation`, `notes`) from the newer authoritative export — this is how an in-process contribution's completion date arrives. Identity fields (`kind`, `security/symbol`, `quantity`, `fmv_usd`, `received_date`) never change silently: a mismatch on those is a preview-surfaced conflict, skipped at commit.
- **Cash rows write ONLY to `donations`.** No transactions, no flows, no valuations (user decision 3).
- Every commit writes an `import_batches` row; undo removes the batch's donations and cascades links + assignments, restoring any demoted legs (§11-undo). Commit does NOT trigger holdings-snapshot sweeps (same gate class as CA-only imports).

## 6. In-kind transfer FMV convention + metrics fix

**Convention (restated, now enforced):** in-kind `TRANSFER_IN`/`TRANSFER_OUT` legs store the transfer-date FMV as a **positive magnitude** in `amount`; type carries direction (`SIGNED_EXTERNAL_FLOW_SQL` signs OUT as `-ABS(amount)` — sign-idempotent, safe across all five readers: `flow-adjusted.ts`, `twr.ts` ×2, `xirr.ts`, `period-attribution.ts`). Same-day journal pairs also carry FMV — they still net to zero in every reader.

Changes:

1. **Doc/guide lockstep (root cause).** Three copies currently instruct `amount = 0` and must change together: `app/dashboard/components/CanonicalCsvGuide.tsx:45` (+ example rows), `docs/canonical-csv-guide.md:68` (+ example), `.claude/skills/import-monthly-statements/SKILL.md:67`. New instruction: transfer-date market value, positive, per leg; `price` stays empty for journal/donation legs; statement lines are still transcribed VERBATIM (both legs of a printed pair) — deciding whether an IN leg is a DAF routing artifact is reconciliation's job (§7), never the transcriber's.
2. **`price_per_share` stays NULL on journal/donation legs.** The tax-lot buy-side query (`tax-lots.ts:85-95`) requires `price_per_share IS NOT NULL` for `TRANSFER_IN` to create a lot — keeping it NULL prevents phantom FMV-basis lots (including on a bounced donation's return leg). The ACATS road (`ibkr-activity.ts:324-381`), which sets both price and amount, keeps its lot-creating behavior — correct for real basis-carrying transfers.
3. **Daily-valuation cash-stepper guard (sharpest edge).** `lib/compute/daily-valuation.ts:327-400` reuses `fetchNetFlowsByDate` to step the cash residual; with FMV on an unpaired in-kind leg it would step CASH for a move that never touched cash. `fetchNetFlowsByDate` gains an optional `opts.excludeInKind` (default `false`, preserving every existing call site byte-for-byte — the seam-dates integration precedent); the daily-valuation stepper passes `true`, which adds `NOT (type IN ('TRANSFER_IN','TRANSFER_OUT') AND security_id IS NOT NULL)` to the WHERE clause. The risk/TWR readers keep seeing in-kind flows.
4. **Cash-flow audit:** already excludes transfer types from `CASH_AFFECTING_SIGNED_SQL` (`cash-flow-audit.ts:95-98`) — no change. A new `"in-kind"` classification class is deliberately NOT added: in-kind days show flat cash and moving total_value, so the cash-residual hunter never flags them.

## 7. Reconciliation: matching legs to donations, attempts, bounces

Pure function in `lib/compute/` (DI'd db, unit-testable). **Reconciliation only SUGGESTS; nothing consumes lots or is demoted from flows without a persisted `donation_leg_links` row, created by user confirmation or a reviewed repair `--apply`** (Codex R1-2).

- **Net residuals:** per (account, trade_date, security), net TRANSFER_OUT minus TRANSFER_IN quantities, EXCLUDING legs linked as `routing_artifact`; residual > 0 = outbound candidate.
- **Suggested match:** candidate ↔ `donations` row by security + quantity within ±5 business days of `received_date`. Ambiguity (two candidates for one donation or vice versa) is surfaced, never auto-resolved.
- **Pair-donation:** a zero-netting same-day IN+OUT pair whose security + quantity match a DAF donation on that date → suggested as (OUT = `out` link, IN = `routing_artifact`). Confirmed via the repair script (history) or the Giving view's one-click confirm (future imports); after confirmation the day resolves to a matched net residual.
- **Eligibility** (Codex R1-10): a donation row present in the authoritative export with a `received_date` is sufficient evidence — `completed_date` NULL does NOT block linking, flows, or lot consumption (the provider's export is the authority; receipt is the tax event). A contribution the provider later reverses would vanish from or change in a future export → surfaced as an identity conflict at re-import (§5), for the user to resolve by unlinking; and a bounced attempt never has a DAF row in the first place.
- **Attempt states** (derived, not stored): outbound residual with no DAF match → `in-transit`; followed by a matching later `TRANSFER_IN` of same security+quantity → `bounced`. The current option attempt renders `in-transit` today and flips to `bounced` when its return leg imports.
- **Inverse checks:** DAF stock donation with no matching legs at all → `legs-missing` (feeds §8 synthesis; currently an empty class — kept for robustness); zero-netting pairs matching NO donation (rebooking noise, true sub-account journals) → informational only.
- **Duplicate-suspect flag** (narrow scope from Codex R1-8b): legs sharing (account, date, security, quantity, type) with differing amounts are flagged in the strip as possible re-authored duplicates. The general same-key-different-values import conflict detector stays a separate TODO (`docs/plans/TODO.md:76`).
- Bounced attempts never consumed lots (§9), so no restoration logic is needed; the return leg carries FMV for flows (§6) but creates no lot (§6.2) and is never counted as a donation.

## 8. Backfill / repair script

`scripts/repair-inkind-transfer-fmv.ts`, following the `repair-missing-external-flows.ts` precedent exactly: dry-run by default, `--apply` gated, `VACUUM INTO` backup with refuse-on-empty, one transaction, deterministic source keys, pure candidate-builder functions exported for tests, header doc that is itself the runbook. The dry-run printout IS the review; `--apply` persists `donation_leg_links` rows alongside its data changes so every change carries reversible provenance (Codex R1-9).

Four candidate classes, printed in separate sections:

1. **Pair-donation confirmation (the main move):** for each DAF-matched zero-netting pair (the eight historical pair-form donations): link OUT as `out` + stamp its `amount` with the donation FMV; link IN as `routing_artifact` + set its `is_external_flow = 0` + append an explanatory note — gated on the containing statement month's holdings delta confirming the shares left. Delta unconfirmed → listed for manual review, no change.
2. **FMV stamp (UPDATE in place):** every other in-kind leg with `amount = 0` gets FMV. Precedence: leg is the sole match of a donation with equal quantity → `fmv_usd`; partial/multi-leg match → `unit_valuation × qty` (blank `unit_valuation` → pro-rata `fmv_usd`); no donation match (journal pairs, ACATS-era legs) → price-table fallback with **strict basis guards** (Codex R1-5): an exact-same-date `prices` row only (no as-of staleness walk), USD-denominated securities only (no historical FX exists in this repo — non-USD legs are reported and skipped), and a split-basis check (any corporate action on the security between the leg date and the price row's era → skip and report). Unpriceable → listed, skipped, never guessed. **`source_key` untouched** — it embeds the amount (`canonical:txn:…:{cents}`), so re-keying would duplicate on re-import; re-importing an old CSV authored with amount=0 stays a no-op (same key).
3. **Missing-leg synthesis (INSERT):** for a `legs-missing` donation (none exist today; class kept for robustness), synthesize one `TRANSFER_OUT` (`source_key = daf-repair:{received_date}:{symbol}:{qty}`, `is_external_flow=1`, `amount = fmv_usd`, `price_per_share NULL`, notes referencing the DAF row) — only after the holdings-delta check passes.
4. **Unmatched anomalies (REPORT only):** zero-netting pairs matching no donation, unpriceable legs, ambiguous matches, and any day where DAF and legs disagree on quantity — printed with full context, never auto-changed.

After `--apply`, the script triggers a valuation + risk recompute (post-repair convention) and prints the count of flow-dates gained.

## 9. Tax-lot engine: donated-lot consumption

`computeTaxLots` (`lib/compute/tax-lots.ts`) changes:

- A `TRANSFER_OUT` leg with a confirmed `out` link to a donation that has `donation_lots` assignments **consumes** the assigned lots: `quantity_remaining` decreases by the assigned quantity, chronologically at the leg's trade_date (replay-order consistent with the corporate-actions replay; consumption happens at end-of-day like sells — the explicit ordering invariant from §4).
- **No `tax_lot_sales` row is written.** Donations never enter realized gains, trade round-trips, or Form 8949 (all three read `tax_lot_sales` exclusively — unchanged). A donated disposition is recorded on the lot side only.
- Implementation shape: the engine receives the confirmed-assignment map (donation ↔ acquisition_transaction_id ↔ quantity) via a query at recompute start; `TRANSFER_OUT` remains excluded from the sell-side query; a separate donation-consumption pass applies assignments. The mutation-side invariants (§4) make over-assignment unreachable; the engine still guards defensively (recompute warning, clamped consumption, surfaced in the Giving view) because historical data can drift after an assignment is made.
- Unassigned or unlinked donations consume nothing (never guess lots) and surface a "needs lot assignment" flag; the open-lot overstatement on donated names resolves per-donation as the user assigns.
- Bounced/in-transit attempts have no donation row, hence no links, hence no consumption — the bounce case is inert in the engine by construction.
- `RECONCILE_CLOSE` orphan logic untouched (verified live: no such rows exist on donated names today); `reconcile_delta` math includes donated consumption so the cross-check stays NULL-clean.

## 10. Giving surface (Analysis sub-view)

`/dashboard/analysis?view=giving` (nav entry beside the existing Analysis views; `force-dynamic`). **Account-agnostic**: donations are a household tax concern, not a scope-selector surface — the view always shows all giving, with each donation's source account labeled (Codex R1-13).

- **Per-year sections** (mirroring the DAF files): totals — total given, stock vs cash split, embedded gain avoided (sum over assigned lots; "pending" chip when any donation in the year is unassigned).
- **Per-donation rows:** received date, security (SymbolLink; raw symbol + "resolve" affordance when unresolved), shares, FMV, basis (assigned), gain avoided, LT/ST composition, source account, status chip: `completed` / `received` / `pending lots`. Cash rows in a visually separated block labeled as non-portfolio activity.
- **Reconciliation strip:** suggested matches awaiting confirmation (one-click confirm persists the links — mutation mirroring the repair's demotion), attempts `in-transit` / `bounced`, `legs-missing`, duplicate-suspects, unmatched anomalies. This is where the bounced option lives.
- **Lot assignment UI:** per-donation drawer listing the security's open lots as of the donation date (acquisition date, remaining qty, basis, unrealized gain, LT/ST); one-click "suggest highest-gain long-term" pre-selects, user confirms; POST validates the §4 invariants and triggers tax-lot recompute. If the recompute fails after a successful write, the UI says so explicitly (assignment saved, recompute failed, retry affordance) — no silent divergence (Codex R1-12). Mutations follow the honest-feedback rules.
- **Unlink/undo affordances:** confirmed links and assignments can be removed (unlink restores `is_external_flow = 1` on a demoted artifact leg); every removal triggers recompute.
- **Privacy:** every figure through `<Money>`/`<Shares>`/`<Pct>`; donation values are portfolio-derived → masked in privacy mode.
- API routes: thin wrappers per the route pattern (`{success,data}` envelope, human-classified, CSRF via the standard client fetch).

## 11. Undo, recovery, and testing

**Import undo & recovery** (Codex R1-6):

- Undoing a `daf-contributions` batch deletes its donations; `donation_leg_links` and `donation_lots` cascade; any `routing_artifact` leg demoted under a cascading link is restored to `is_external_flow = 1` (the undo handler does this explicitly before the cascade); tax lots recompute.
- Undoing a TRANSACTIONS batch whose rows are referenced by `donation_leg_links.transaction_id` or `donation_lots.acquisition_transaction_id` is **refused with a domain-language explanation** (unlink/unassign first) — never silently orphaned or cascaded.
- The import-undo recovery manifest's table enumeration is extended to cover the three new tables.

**Testing** (TDD throughout; failing test first per unit):

- **Parser:** fixture from anonymized synthetic rows shaped like the real CSVs (`tests/fixtures/daf-contributions-sample.csv`; real files stay local); header detect, trim, ET dates, cash vs stock, created-at identity, metadata upsert vs identity conflict, unresolved symbol, undo incl. artifact-leg restoration.
- **Flows:** extend `tests/compute/transfer-flow-sign.test.ts` — FMV legs enter the index; pairs still cancel; demoted artifact legs excluded; $0 legacy legs unchanged until repaired.
- **Daily valuation:** in-kind legs with FMV do NOT step cash (the §6.3 guard) while deposits still do.
- **Reconciliation:** table-driven — matched, ambiguous (surfaced not auto-resolved), pair-donation, in-transit, bounced, legs-missing, duplicate-suspect; the real bounce sequence as an anonymized fixture.
- **Engine:** donation consumption (full, partial), defensive over-assignment warning, no `tax_lot_sales` rows, LT/ST snapshot at donation date, replay-order with a split before AND after the donation date, bounce inertness, `reconcile_delta` cleanliness.
- **Mutations:** every §4 invariant rejection path; unlink restores the artifact flag; refused transaction-batch undo.
- **Migration:** upgrade on a copy of a real-shape DB; `PRAGMA foreign_key_check` clean; indexes present.
- **Repair script:** pure candidate-builders — pair-donation gating on holdings delta, FMV precedence, strict fallback guards (exact-date only, USD only, split-check), synthesis gating, anomalies report-only.
- **Verification loop:** `npm run verify:changed` per task, full `npx vitest run` + `npx next build` before merge, and an authenticated browser E2E on the Giving view (dev server; the QA session-mint road from 2026-08-17 makes this scriptable): preview warnings, confirm-match, lot assignment, privacy mode on/off, undo, recompute-failure feedback.

## 12. Out of scope / deferred

- General same-key-different-values import conflict detection (`docs/plans/TODO.md:76`) — only the narrow duplicate-suspect flag (§7) ships here. *(Codex R1-8b wanted the general detector in-build; deferred with rationale — user to ratify.)*
- Historical FX for non-USD in-kind legs (none exist; repair skips-and-reports).
- Opening-snapshot lots as assignable donation lots (documented limitation, §4).
- Auto-ingesting DAF CSVs from email; import stays manual via the Import tab.
- Charitable deduction limits / carryforward math.
- The `TRANSFER` (cash sweep) type is untouched — this design concerns in-kind legs only.
- Form 8949/tax-report changes: none (donations correctly absent).

## 13. Cross-cutting risks (addressed in-design)

1. `daily-valuation.ts` cash stepping — §6.3 guard (the one consumer actively harmed by the fix).
2. Phantom lots from priced `TRANSFER_IN` — §6.2 (price stays NULL on journal legs; ACATS unaffected).
3. Three amount=0 doc copies — §6.1 lockstep change, or next month's import reintroduces the bug.
4. `source_key` embeds amount — §8.2 in-place UPDATE, never re-key.
5. Sign-idempotent flow SQL — positive magnitudes safe across all five readers; contract pinned by existing test, extended.
6. `is_external_flow` demotion durability — `lib/import/engine.ts:348-355` forces the flag to 1 at import, but re-importing an existing row is a source_key no-op, so a demoted artifact leg survives re-import untouched. A genuinely re-authored row (new key) arrives as a fresh flow leg and re-surfaces in reconciliation — honest failure mode, no silent loss.

## 14. Codex review round 1 — resolutions

13 findings (9 high / 4 medium), verdict REVISE. Accepted and folded in: 1 (spec anonymized; evidence moved to gitignored `data/notes/`), 2 (`donation_leg_links` + confirm-before-consume), 3 (reject-not-clamp mutation invariants), 4 (explicit chronological-basis invariant + split tests), 5 (strict fallback-pricing guards), 6 (undo/recovery coverage + refused-undo rule), 7 (created-at in source_key), 8a (metadata upsert on re-import), 9 (links as reversible provenance), 10 (explicit eligibility semantics), 11 (CHECK constraints + indexes; migration number stays implementation-time per repo convention), 12 (expanded tests + authenticated E2E), 13 (account-agnostic scope + never-create-securities resolution flow). Partially deferred: 8b (general conflict detector stays `TODO.md:76`; narrow duplicate-suspect flag ships) — flagged in §12 for user ratification.
