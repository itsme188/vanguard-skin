# Number-Trust Durable Fixes — Design

**Date:** 2026-08-23
**Status:** Draft for review
**Predecessor:** containment plan `docs/superpowers/plans/2026-08-23-number-trust-containment.md` (shipped 2026-08-23, merge `6ae273b`). This spec covers the durable fixes that containment explicitly deferred.
**Evidence:** `docs/private/codex-number-trust-audit-2026-08-21.md` (LOCAL-ONLY, gitignored — real figures). This spec is direction-only; consult the audit doc for concrete amounts and live examples.

## Problem

The 2026-08-21 Codex number-trust audit confirmed three durable defect families that containment only labeled, bannered, or suppressed:

1. **The cost-basis/realized path ignores unit conventions.** The market-value path uniformly uses the existing helpers (`lib/valuation.ts::marketValue` / `adjustedMarketValueSQL` — bond ÷100, option ×multiplier), but the tax-lots engine, tax-report export, cost-basis reconciliation, portfolio-summary tax block, and giving basis reads are all hand-rolled. Consequences: bond sale proceeds/basis stored and exported 100× true dollars; option lot basis stored at 1/100; short covers store proceeds and basis economically swapped (gain is sign-patched, gross columns are not); cost-basis reconciliation flags nearly every position and is non-diagnostic. Tax exports carry a NOT-FOR-FILING banner as containment.
2. **TWR "reconciliation" is circular.** `twr-reconcile.ts` compares the statement TWR against `computeTwr`, which returns that same statement TWR via its passthrough — divergence is structurally ~0. Containment relabeled the surfaces "statement-reported, not independently verified"; no independent check exists.
3. **Data Confidence inspects the wrong universe.** Holdings reads use per-account `MAX(as_of_date)` semantics (carried positions vanish under fresher live rows; shorts excluded), the stalest-security scan has no recency predicate (reports long-sold positions), valuation coverage reads one arbitrary account row, three date sites use UTC `toISOString()`, and no dimension can detect identity corruption — a critical corruption can hide inside a "high" score because the aggregate is a flat weighted mean.

## Decisions (user, 2026-08-23 design session)

- One spec covering all three workstreams; each has its own acceptance standard; implementation may parallelize.
- **WS1 storage convention:** stored true economic dollars (Approach A) — `tax_lots.cost_basis`, `tax_lot_sales.proceeds`, `tax_lot_sales.cost_basis_allocated` become real dollars; full recompute regenerates rows (no SQL migration).
- **WS1 acceptance evidence:** statement realized-gain sections + IBKR activity-report realized P&L (both available locally). Synthetic fixtures alone are insufficient.
- **NOT-FOR-FILING banner** comes off automatically with the engine fix — implemented as a fail-closed convention marker (Codex review #4): the merged code keeps the banner until the v2 recompute has run and the acceptance gate has passed, then it clears without further action. Codex recommended keeping the banner pending full §1233 short-sale term rules + 1099-B reconciliation; the accepted middle ground is: short-row export **dates** fixed, blanket short-term kept as a documented disclosed limitation (acceptable for this portfolio per the private audit evidence), acceptance evidence per the user's decision (statements + IBKR activity), banner lifts on the marker.
- **WS2 method:** monthly Modified Dietz (Approach A), not daily-chained TWR (daily history too short and carries live-anchor artifacts).
- **WS2 verdict policy:** banded verdict — never a green "reconciled ✓"; bands are "consistent (method differences expected)" / "investigate" / "not comparable" / "insufficient data".
- **WS3 scope:** query repairs (audit defects 1–5, 7) **plus** a new integrity-checks dimension; keep the "Data Freshness" name.
- **WS3 integrity semantics:** integrity acts as a **gate/cap** (any critical hit caps the overall level at "low" with a named reason), not a sixth weighted dimension — criticals must be un-averageable.

## Workstream 1 — true-dollar basis path

### Convention

`tax_lots.cost_basis`, `tax_lot_sales.proceeds`, `tax_lot_sales.cost_basis_allocated` store true economic dollars in the security's **native currency** (FX remains a read-time concern, per existing repo conventions). Per-unit fields (`tax_lots.acquisition_price`, `tax_lot_sales.sale_price`) stay per-unit — they are prices, and the REDEMPTION derived-price logic (`|amount|/qty×100` on the per-100-face basis) is unchanged.

No SQL migration: `computeTaxLots` fully rebuilds `tax_lots` + `tax_lot_sales`, so a recompute regenerates every row under the new convention.

### Engine changes (`lib/compute/tax-lots.ts`)

- The `buys` query joins `securities` to bring `LOWER(security_type)` and `COALESCE(multiplier, 1)` into scope (today it does not join, which is why lot basis is convention-less).
- Lot write: `cost_basis = marketValue(quantity, effectivePrice, security_type, multiplier)` — the existing `lib/valuation.ts` helper. No new module.
- Sale write: `cost_basis_allocated` and `proceeds` both computed via `marketValue()`. For a bond bill redemption this makes proceeds equal `|amount|` exactly, preserving the discount-is-interest invariant ($0 gain at-cost) by construction.
- **Short covers (IRS column orientation):** for `is_short` lots —
  - `proceeds = lot.cost_basis × (qty / quantity_acquired)` — the net short-open proceeds, dollar-proportional from the stored leg (see fee matrix below);
  - `cost_basis_allocated = marketValue(qty, coverPrice, …) + allocated cover fees` — what the cover paid;
  - `realized_gain_loss = proceeds − cost_basis_allocated` — the existing sign-flip negation is deleted (correct columns make it unnecessary);
  - `is_long_term = 0` always for short lots (§1233 general rule; the substantially-identical-property long-term-loss exception is a **documented disclosed limitation**, acceptable for this portfolio per the private audit evidence, and the export footnotes it);
  - **Export dates (Codex R1 #1, R2 #18):** Form 8949 short rows report the cover **trade date** as both date-acquired and date-sold (trade dates, consistent with the engine's `trade_date` basis everywhere; settlement dates are not modeled) — never the short-open date as "acquired". `tax-report.ts` derives these from the sale row for `is_short` lots. The existing signed `holding_period_days` display convention (negative identifies shorts) is **kept** — existing consumers rely on it; `is_short` remains the engine-level flag.
- **Fees and commissions — full matrix (Codex R1 #2, R2 #3, R3 #3):** `fees` are in the same native currency as the row's price; FX applies at read time. Where a source's `amount` is authoritative net-of-fees, derivation from `amount` takes precedence over `qty×price±fees` (never double-count). Reversal rows carry fees with the sign of their `amount`. Per-type treatment of the **stored lot dollar column** and the **sale allocation**:

  | Transaction | Stored lot `cost_basis` holds | Sale-side allocation |
  |---|---|---|
  | BUY / BUY_TO_OPEN / REINVESTMENT | economic cost **+ fees** | — |
  | SELL / SELL_TO_CLOSE / REDEMPTION | — | `proceeds = marketValue(qty, salePrice, …) − fees × (qty / sell.quantity)`; `cost_basis_allocated = lot.cost_basis × (qty / quantity_acquired)` — **dollar-proportional from stored basis**, not re-derived from `acquisition_price` (which stays per-unit for display) |
  | SELL_TO_OPEN (short open) | **net short-open proceeds** = economic amount **− fees** (the column stores the lot's opening dollar leg; for shorts that leg is proceeds) | — |
  | BUY_TO_CLOSE / BUY_TO_COVER (short cover) | — | short orientation: `proceeds = lot.cost_basis × (qty / quantity_acquired)` (net short-open proceeds, dollar-proportional); `cost_basis_allocated = marketValue(qty, coverPrice, …) + fees × (qty / sell.quantity)` |

  This resolves the stored-basis-vs-short-orientation interaction explicitly: for short lots the stored dollar column is the open-side **proceeds** leg, and each side of the IRS columns draws from the correct leg. Partial closes allocate both fees and stored dollars proportionally by quantity.
- **Exercised/assigned option premium flows through the underlying only (Codex R3 #1):** today the engine both closes the option lot (realizing the premium as a standalone option gain/loss) and premium-adjusts the linked stock leg — a double count relative to IRS treatment (Pub 550: exercised option premium adjusts the underlying's basis/proceeds; it is not a separate disposition). The fix: option lots consumed by EXERCISED/ASSIGNED events write **no filing-eligible realized gain/loss** (engine rows flagged so exports and realized totals exclude them; the premium adjustment on the underlying stock leg remains the single tax effect). Tests assert the **combined** option-plus-underlying outcome and the exported rows. The plan starts with a verification task pinning the current combined behavior before changing it.
- **Long-term boundary is the calendar anniversary (Codex R3 #2):** `isLongTermHolding` compares the disposition date against the acquisition date **plus one calendar year** ("more than 1 year" — strictly after the anniversary), replacing the fixed `> 365` day count that misclassifies anniversary sales across a leap day. Leap-year boundary tests included.
- **Synthetic closes are not filing rows (Codex #3):** `tax_lot_sales` rows originating from engine-owned `RECONCILE_CLOSE` transactions are **excluded** from tax exports and the broker-acceptance comparison, and labeled "estimated" on operational P&L surfaces. Its synthetic `amount` still routes through `marketValue()` for unit consistency.
- **Convention state: one shared helper, generation-bound markers (Codex R1 #4, R2 #1–2, R3 #4/#6/#7):**
  - A monotonic **`tax_input_generation`** counter in `settings`, bumped **inside the same transaction** as any material tax-input mutation: an import commit that inserts/deletes transactions or corporate actions, an import undo, a donation lot link/unlink/confirm, a repair-script apply, or a `securities.multiplier`/`security_type` change on a security with lots. A no-op re-import (zero business rows changed) does **not** bump it — duplicate re-imports can't invalidate acceptance, and non-import mutations can't dodge it (this replaces the flawed `MAX(import_batch_id)` idea).
  - `tax_lots_convention = 'v2:<generation>'` — stamped by every successful `computeTaxLots` run under the new engine (recompute already follows every material mutation by existing invariant).
  - `tax_report_broker_accepted` — stamped by a passing acceptance run as `<generation>:<covered (account, tax-year) set>`. **Coverage is per account + tax year (R3 #4):** a requested tax-report year unlocks only for account-years inside the stamped coverage; rows outside it keep the banner even when other years are accepted.
  - One shared **`getTaxConventionState(db)`** helper is the only reader of these markers (single syntax, no drift). Every consumer that crosses the storage-convention boundary gates through it: the export path (banner + filenames, fail-closed), cost-basis reconciliation, portfolio-summary tax block, giving basis, trade-roundtrips, and options closed-P&L — each renders its prior disclaimed/pending state until the recompute marker is current (export additionally requires acceptance coverage).
- **Wash-sale scope (Codex R2 #5):** the existing 30-day same-security `W`-adjustment detection is heuristic and is NOT covered by this workstream's acceptance evidence. Wash-sale output becomes **advisory-only**: the export keeps a narrow, wash-sale-specific disclaimer note (columns are correct; `W` adjustments are estimates pending 1099-B reconciliation) even after the general NOT-FOR-FILING banner lifts. Full wash-sale certification (substantially-identical scope, 1099-B tie-out) is out of scope.

### Reader simplification

- `lib/compute/cost-basis-reconciliation.ts` — replace the hand-rolled `SUM(quantity_remaining × acquisition_price)` with `SUM(cost_basis × remaining_fraction)`; concretely, compute remaining basis as `SUM(cost_basis × quantity_remaining / quantity_acquired)` (guarding `quantity_acquired != 0`) × FX. The broker side already carries real dollars; the comparison becomes diagnostic.
- `lib/queries/portfolio-summary.ts` tax block — same replacement; deletes the file's only value expression that bypasses the shared conventions.
- `lib/queries/giving-view.ts` — `cost_basis / quantity_acquired` per-share math becomes correct automatically once `cost_basis` is dollars; verify, no rewrite expected.
- Targeted cleanup: `lib/compute/scenarios.ts` inline copy of the adjusted-value CASE expression becomes a call to `adjustedMarketValueSQL()`.
- **Reader audit task (explicit in the plan):** enumerate every consumer of the three columns (`trade-roundtrips.ts`, `lib/queries/options.ts` closed-P&L, `lib/queries/tax-lots.ts`, UI display paths, `scaledCostBasisFallbackSQL` call sites) and remove any compensation (re-applied multiplier or ÷100) in the same change. Any reader found to depend on the old per-unit convention is fixed, not shimmed.

### Export and banner

`lib/compute/tax-report.ts` keeps exporting stored fields verbatim — now correct, including short rows in IRS orientation. The NOT-FOR-FILING banner (`TaxReportCard.tsx`) and `-NOT-FOR-FILING` filenames (`app/api/tax-report/route.ts`) are removed in the same PR. Non-USD rows keep their existing treatment (excluded from USD totals, present in raw export with disclosure) — out of scope here.

### Acceptance harness

New `scripts/reconcile-tax-report-vs-broker.ts`:

- Reads a gitignored transcription config (`data/repair-configs/broker-realized-*.json`) of statement realized-gain sections and the IBKR annual activity CSV. Real figures never enter the repo. Each transcription block carries the **statement's printed section total** — the script verifies transcribed rows sum to it before comparing anything (tie-out against transcription error, Codex #6).
- **Bidirectional row-level reconciliation (Codex R1 #6, R2 #4):** broker-row identity = (account, symbol, disposal trade date, quantity, currency). A broker disposal may map **one-to-many** onto the FIFO `tax_lot_sales` rows sharing its (account, security, sale transaction): engine rows are summed per disposal deterministically (sorted by lot acquisition date, id) before comparing quantity, proceeds, basis, and gain. **Fails on**: any unmatched broker row, any unmatched engine disposal in a covered period (excluding `RECONCILE_CLOSE` synthetics and exercise/assignment non-filing option rows), ambiguous matches, zero coverage, or an unreadable input. Per-symbol aggregation alone is not acceptance — offsetting row errors must not cancel.
- **Tolerances and normalization (Codex R3 #5):** named constants — quantity exact to 4 decimal places; each dollar field (proceeds, basis, gain) within `ACCEPT_TOL_USD = 0.01` per disposal (printed statement precision); symbols normalized only through the existing option-OCC and symbol-mapping conventions — any other transformation needed to make a match is a **failure**, not a fuzzy pass.
- **Output containment (Codex R2 #15):** stdout is direction-only by default (counts, pass/fail, bp-free); the per-row detail diff writes only to a path the script verifies is gitignored (`git check-ignore`) and refuses otherwise.
- The known short-cover cases reconcile against the IBKR side; the bond redemptions against the Vanguard statement sections.
- Committed tests use synthetic fixtures only (see Testing).
- Supports `REPAIR_DB_PATH`-style env overrides so the acceptance run can execute **pre-merge against a recomputed DB copy** (rehearsal pattern) — this is what gates the banner removal inside the PR; the post-merge run against the live DB (see Rollout) re-confirms before the v2 marker unlocks the export path.
- The banner-removal PR's evidence includes the script's passing summary (direction-only in committed text; the full per-row diff stays in gitignored `docs/private/` or `data/`).

## Workstream 2 — independent Modified Dietz lane

### New module `lib/compute/dietz.ts`

`computeMonthlyDietz(db, accountId, monthEndDate)` → `{ dietzReturn, vStart, vEnd, netFlow, flowCount, seamStraddled }` or `null` when inputs are missing. Nothing in the computation reads `monthly_snapshots.twr` — independence is structural.

- **Equation (Codex #8):** `r = (V_end − V_start − F) / (V_start + Σ w_i·F_i)` where `F = Σ F_i` (signed dated flows), `w_i = (D − d_i) / D`, `D` = actual calendar days in the month (end-of-day convention: a flow on day `d_i` earns from the following day; a month-end flow gets weight 0). No intermediate rounding; bp rounding happens once at display.
- **V_start** = prior month's `total_value` (never `starting_value` — the December annual-summary trap). **V_end** = the month's `total_value`. Both filtered through `excludeLiveSnapshotsSql()`.
- **Flows** = `fetchNetFlowsByDate()` from `lib/compute/flow-adjusted.ts` (exact-date, signed, per-account), day-weighted as above. In-kind TRANSFER legs are included; the in-kind union logic currently local to `twr.ts` (`appendInKindFlows`) is lifted to a shared location and reused, not duplicated.
- **Flow-authority cross-check (Codex R1 #7, R2 #8):** the statement's `deposits_withdrawals` is authoritative for the month's cash-flow total. Before adjudicating, the module compares `Σ dated cash flows` against `deposits_withdrawals` (in-kind legs compared separately since statements never report them). Tolerance: named constant `DIETZ_FLOW_TOL_USD = 1.00` absolute (statement figures are exact cents; anything beyond a dollar is a ledger gap, not rounding). A **null** `deposits_withdrawals` → the cross-check is unavailable → `insufficient` (rule `flow-total-unavailable`) — completeness is never assumed. Zero-vs-zero passes trivially. No flow is ever synthesized to close a gap.
- **December annual-summary rows (Codex R2 #6):** a December row identified by the existing annual-summary detector (its TWR/deposits are annual cumulatives, not monthly) cannot be compared to a monthly Dietz — the month's verdict is **`not_comparable`** (rule `annual-summary-row`). No December-specific flow arithmetic is attempted in this lane.
- **Seam awareness:** if `fetchAnchorSourceSeamDates()` finds an anchor-source transition inside the month, mark `seamStraddled` — a measurement-basis splice cannot be adjudicated in bp.
- **Edge precedence (deterministic, Codex R1 #8, R3 #10):** (1) annual-summary December → `not_comparable` (rule `annual-summary-row`, checked FIRST — its monthly flow arithmetic is undefined, so flow rules must not run); (2) missing V_start / missing statement TWR / nonpositive Dietz denominator / flow-total mismatch or unavailable → `insufficient`; (3) seam inside month → `not_comparable`; (4) band by bp threshold. First matching rule wins; each result names its rule; the precedence order is pinned by a regression test.

### Rewritten `lib/compute/twr-reconcile.ts`

Statement TWR (same source-preference query as today: ibkr-activity > canonical/vanguard-pdf, source-aware ÷100) is compared against the Dietz figure. `computeTwr` is no longer called from reconciliation — the circularity is severed. The display-TWR lane (`computeTwr` passthrough) is untouched.

### Banded verdict

Named constant `DIETZ_CONSISTENT_BP = 125` (seeded from the method-only divergence spread recorded in the private audit doc; tunable as live data accumulates):

| Condition | Band | Surface language |
|---|---|---|
| `abs(divergenceBp) <= 125` | `consistent` | "Consistent — method differences expected" |
| `> 125` | `investigate` | bp figure + month named |
| seam inside month | `not_comparable` | measurement-basis change disclosed |
| missing V_start / no statement TWR | `insufficient` | never silently green |

### Renames and surfaces

- `withinTolerance` → `band: 'consistent' | 'investigate' | 'not_comparable' | 'insufficient'`.
- `performanceReconciledThru` → `crossCheckedThru`, defined **contiguously (Codex R1 #9, R2 #7)**: per account, the chain **starts at the first month having an exact adjacent prior snapshot** (the account's second statement month — the first month is structurally uncheckable and does not break anything). The module walks an explicit calendar-month sequence from there; `crossCheckedThru` = the latest month such that every month in the sequence through it is `consistent` or `not_comparable` (seams and annual rows don't break the chain; `investigate`, `insufficient`, and a **missing calendar month** do). Roll-up = earliest across in-scope accounts; null if any account has no chain. The drawer shows the per-month band history so an intervening `investigate` is visible, not papered over.
- Updated together: `TrustStrip.tsx` ("Cross-checked (Modified Dietz) through …"), `TrustStripDrawer.tsx` (per-account rows: statement TWR, Dietz, bp gap, band), `PerformanceView.tsx`, `lib/queries/analysis-trust-state.ts`, `scripts/audit-twr-vs-statements.ts`. The containment-era "statement-reported, not independently verified" language is replaced by the genuine cross-check description. No green "reconciled ✓" anywhere.

## Workstream 3 — Data Confidence repair + integrity gate

### Query repairs (`lib/queries/data-confidence.ts`)

All hand-rolled holdings reads adopt `latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })` from `lib/queries/latest-holdings.ts`:

1. Price-freshness and enrichment denominators — carried positions stop vanishing under a fresher live row; shorts enter the universe.
2. Stalest-security scan — gains the latest-holdings predicate so sold positions can never report as "stalest", and switches its `prices` join to a **LEFT JOIN with missing-price rows sorted first (Codex #14)** — a held security with no price at all is the stalest thing there is, and the current inner join silently drops it.
3. Holdings recency — per-(account, security) ages, worst-first, instead of one optimistic per-account maximum.
4. Valuation coverage — per-account latest `daily_valuations` rows, `SUM(holdings_count)` / `SUM(priced_count)` across accounts, replacing the unstable single-row `LIMIT 1`. Universe = accounts with current holdings (Codex R2 #11): an in-universe account with **no** valuation row counts its holdings as unpriced (coverage denominator, zero numerator) rather than disappearing; per-account as-of dates are reported so mixed-date coverage is visible.
5. All three `new Date().toISOString()` sites → `todayET()` (no phantom +1 day staleness in the ET evening).
6. The name-string `source` inference ("ibkr" in account name → "TWS") is replaced with the `lib/db/holding-sources.ts` source-class rules.

### Integrity dimension — a gate, not a weight

New `lib/queries/integrity-checks.ts` returning `{ critical: IntegrityHit[], warnings: IntegrityHit[] }`, each hit with a machine key and a human reason. Severity/materiality matrix (Codex #11):

| Check | Severity | Materiality threshold | Freshness |
|---|---|---|---|
| 1. Type-vs-fills contradiction (Bond/Mutual-Fund-typed security with equity fills — the identity-corruption class) | **critical** | any currently-held hit; historical-only hits are warnings | computed live per poll |
| 2. Unclassified negative inferred cash — precisely (Codex R2 #10): a `computeCashFlowResiduals` **point** whose residual is negative, exceeds the existing `CONFIDENCE_RESIDUAL_*` floors, and whose classification is neither `source-seam` nor `live-anchor-residual` (the exact predicate `isUnexplainedCashFlow` already encodes) | **critical** | existing floors | latest valuation window |
| 3. Lot-vs-position drift — universe-restricted (Codex R2 #9); quantities compared **is_short-signed**, drift ratio = `abs(positionQty − signedLotQty) / max(abs(positionQty), abs(signedLotQty))` with epsilon `1e-4` shares (R3 #11); zero-lot positions with **zero transactions** are the known Data-Health class and stay warnings; lots-without-position is a warning (stale-lot class) | warning; **critical** when lots exist and drift > 5%, or a position has fills yet zero lots | per-position | computed per poll |
| 4. Non-null `reconcile_delta` | warning | any non-null | fresh by construction — refreshed every recompute |

- Check 1's predicate is shared, **explicitly tiered (Codex #11)**: the existing import guard (refuses new writes at one equity fill) and the repair-script detector (flags existing state at a higher fill count + metadata corroboration) serve different purposes and keep different thresholds — both call one extracted detector module with a tier parameter, so the thresholds are co-located and documented rather than conflicting by accident.
- Check 3 does **not** reuse `lot-coverage.ts` as-is (Codex #10 — it skips shorts and one-sided orphans): the check signs `is_short` lots correctly and detects **both** directions — position-without-lots and lots-without-position.

Aggregation (Codex #12): the five existing weights are untouched. After the weighted mean, any **critical** hit applies a **monotonic-only cap**: `overallLevel = min(overallLevel, "low")` on the severity order high > medium > low > stale (never promotes a `stale`), **and** `overallScore = min(overallScore, 45)` so the number can't contradict the level; `capReason` names the triggering check. Warnings are listed uncapped. `DataConfidenceIndicator.tsx` renders `capReason`; the badge keeps the "Data Freshness" name, caption extended to "with integrity checks".

Performance (Codex #13): the header polls every 60s — the constraint is a **measured latency budget** (integrity checks add ≤ 100 ms on a live-size DB copy, verified in the plan with `EXPLAIN QUERY PLAN` sanity on the new queries; note existing type-comparison SQL uses case-folding that can defeat type-leading indexes). Checks that can't meet the budget are cached with a short TTL rather than run per poll.

Rider: the `timingResidual` field (added at containment, currently dropped by the client) gets a proper display line in the indicator.

## Privacy (Codex #15)

- Every new user-facing portfolio-derived value renders through `lib/privacy/components.tsx`: statement TWR, Dietz return, bp gaps → `<Pct>`; `capReason`, integrity-hit reasons, timing-residual text → `<PrivateText>`; counts → `<Count>`. This is an acceptance criterion for every UI task, not a follow-up.
- Real-data outputs of the acceptance harness, rehearsals, and E2E evidence (per-row diffs, screenshots with real figures) go only to gitignored locations (`data/`, `docs/private/`, `qa/verify-evidence/`). **Prerequisite task (Codex R3 #8): `/qa/verify-evidence/` is not currently in `.gitignore` — add the anchored rule before any real-data run**; harness and scripts refuse destinations that `git check-ignore` does not confirm. Committed docs and PR text stay direction-only (PASS/FAIL + counts of synthetic cases only).

## Testing

TDD per workstream; in-memory SQLite with DI throughout.

- **WS1:** synthetic fixtures for every convention cell — bond redemption at cost (proceeds = |amount|, gain 0), bond sold at premium, short cover at gain and at loss (IRS column orientation, `is_long_term = 0`), option round-trip, plain stock (values unchanged). Regression tests assert the **stored gross columns**, not just gain — the cancelling-error blind spot (both columns inflated 100×, gain correct) must be structurally untestable-around. Live acceptance = the broker-reconciliation script.
- **WS2:** hand-computed Dietz months (known flows and weights), seam-straddle month, missing prior month, and a **circularity guard**: reconciliation must produce nonzero divergence when fed a statement TWR that disagrees with the balances — the case the old code structurally could not fail.
- **WS3:** carried-position-under-fresher-live-row stays in universe; sold position cannot be stalest; per-account coverage sums; ET-date boundary at an evening timestamp; integrity gate (critical → capped "low" with reason; warning → uncapped).

Additional WS1 matrix cases (Codex R2 #16, R3 #12): fee-bearing partial and multi-lot sales; short-open and short-cover fee cases; a split after fee-adjusted basis; **combined exercise/assignment outcome** (option leg excluded from filing rows, premium present exactly once via the underlying — asserted on export rows); leap-year long-term anniversary boundary; an in-kind donation leg (consumes lots, no sale row); a December annual-summary month; null and mismatched Dietz flow totals; a missing intervening month breaking the chain; marker/generation behavior after a no-op re-import (no bump) and after a non-import mutation (bump); held-security-with-no-price stalest ordering; a direct fixture per integrity check and per exclusion; multiple simultaneous integrity criticals (first-named wins deterministic `capReason`). Browser E2E covers the pre-marker pending state of every gated reader, not only the export download.

Cross-cutting (Codex R1 #16, R2 #12–13, #17):

- **Recompute idempotence — semantic:** running `computeTaxLots` twice yields identical `tax_lots`/`tax_lot_sales` over **business columns** (quantities, prices, dollar fields, dates, flags) — surrogate ids and timestamps excluded by definition.
- **Re-import no-op:** re-importing an already-imported statement file over v2 rows changes nothing (deterministic `source_key` dedupe); the twin-audit assertion is pinned to the documented `(account, symbol, date, type, quantity, cents)` business tuple and fails on any new unintended twin in the imported batch.
- **Export contract tests:** Form 8949 CSV / TXF golden-file tests on synthetic fixtures — filenames, banner presence/absence keyed to both markers, short-row dates, synthetic-close exclusion, wash-sale advisory note.
- **API contract tests** for every changed envelope: `/api/analysis/trust-state` (band/`crossCheckedThru` shape), `/api/data-confidence` (capped score + `capReason` + `timingResidual`), `/api/tax-report` (marker-gated banner state), and `/api/summary` propagation of the **capped** score (the Electron consumer must see the cap, not the raw mean).
- **Browser E2E** (per the repo's verification contract): tax-report download in both marker states, all four Dietz bands rendered in the drawer, an integrity-capped badge with visible `capReason`, and privacy-mode rendering of every new surface. `verify:smoke` for UI-visible changes.

Suite-wide: `npm run verify:changed` per task, full `npx vitest run` + `npx next build` before merge.

## Rollout and sequencing

- The three workstreams are code-independent (no shared files beyond `lib/valuation.ts`, WS1-only) → parallel SDD tracks.
- **WS1 ordering constraint:** merge → user-run live recompute (stamps `tax_lots_convention = 'v2:<generation>'`) → broker-reconciliation script against the live DB (stamps acceptance coverage) → the export path unlocks per covered account/tax-year. Code alone never exposes un-recomputed rows (fail-closed markers, Codex R1 #4).
- **Live recompute procedure (Codex #5):** app quit; **WAL-safe backup** via SQLite backup API (`better-sqlite3 .backup()`) or a checkpointed copy (`PRAGMA wal_checkpoint(TRUNCATE)` then file copy) into `data/backups/` — never a bare `cp` of a hot WAL DB; rehearsed end-to-end on a DB copy via `REPAIR_DB_PATH` from the repo root (tsx-alias convention) including a second-run idempotence check; **rollback is a code+DB pair (Codex R2 #14)** — restore the backup file AND revert to the pre-merge code in one operation (v2-dollar rows under old readers would be reinterpreted 100×-wrong in the other direction); the markers travel with the DB, so a DB-only restore under new code automatically re-engages the banner (fail-closed), and the new code treats an unrecognized marker value as "not v2".
- **WS3 after WS1's recompute** (or with the lot-drift check dark until then) — otherwise the drift check would briefly flag the convention change itself.
- No Worker parity impact: tax path, trust strip, and confidence are Mac-only surfaces; no parity-pinned mirror is touched. No schema migration; `reconcile_delta` refreshes on recompute as designed.
- **Reference-doc updates in the same PRs (Codex #17):** `docs/reference/conventions-detail.md` (TWR-reconciliation contract, tax-lot dollar convention), `docs/reference/data-integrity.md` (NOT-FOR-FILING state → marker-gated; TWR relabel → Dietz cross-check), `docs/reference/auto-refresh.md` + `docs/reference/api-patterns.md` (confidence dimensions + integrity gate), and the `CLAUDE.md` containment bullets that become stale.
- Process: Codex spec review (big spec: up to 3 rounds, stop early on nits) → user review → writing-plans → parallel SDD.

## Out of scope

- Daily-chained independent TWR (possible later refinement on top of `daily_valuations` once history lengthens).
- Non-USD tax-export FX conversion (existing deferred item; unchanged treatment).
- The noise-betas QA decision (separate DECISIONS-PENDING item).
- Full badge redesign / per-surface trust matrix productization (audit's long-term "provenance for every displayed number" direction).
- Cash-equivalent normalization propagation (existing TODO batch).
