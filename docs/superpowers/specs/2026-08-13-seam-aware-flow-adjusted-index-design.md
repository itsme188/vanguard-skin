# Seam-Aware Flow-Adjusted Index — Design

**Date:** 2026-08-13
**Status:** Approved scope (user, 2026-08-13); Codex review round 1 folded in (findings 2,3,4,5,6,7,8,9 addressed; finding 1 escalated to user — see session log); pending user review
**Owner:** Interactive session (ledger vol/drawdown entries carry fixer-must-skip markers)
**Replaces:** the flow-synthesis idea for `analysis-risk-decomposition--vol-drawdown-sharpe-count-cash-flows-as-returns-regression-1` (the $83K 2026-07-11 synthesized deposit was disproven — statement shows no such flow)

## 1. Problem

`buildFlowAdjustedIndex` (`lib/compute/flow-adjusted.ts`) strips **recorded external
flows** from the daily return stream so vol/Sharpe/drawdown/beta measure market
movement only. But the daily valuation series is anchored to broker-reported
totals from **different sources over time** (`monthly_snapshots.source`:
`canonical` statements, `plaid` daily, `tws` daily, `ibkr-activity` statements),
and on any day where the governing anchor's source changes, the value step mixes
two measurement bases. No flow row exists — correctly, nothing moved — so the
flow adjustment cannot neutralize it and the step enters the return stream as a
fake market move.

Measured in the live DB (magnitudes approximate here by design — exact values
stay in local, gitignored session notes; committed docs carry no portfolio
specifics):

- **Go-live seam** (canonical → plaid, account 1, 2026-07-11): the day before
  carries the stale prior-month statement anchor; the first Plaid anchor snaps
  ~11 days of accumulated drift into one step — a **~+4% fake day** with a
  six-figure cash component. Account 3 has the analogous canonical → tws seam
  at its 2026-04-06 TWS go-live.
- **Recurring month-end seams** (daily source ↔ statement, every month in the
  live era): at 2026-07-31 the three accounts read fake steps of roughly
  ±1–3% — same defect, smaller magnitude, systematic (2 transitions per
  account per month).

Consequences today: single-account vol reads roughly double (24–29% vs
components' true levels), Sharpe derives from the contaminated vol, drawdown
windows can start or trough on a splice day, and the flow-repair script
(`scripts/repair-missing-external-flows.ts`) proposed synthesizing a deposit
for the 07-11 seam that the statement disproves.

The pure statement era (canonical → canonical anchors, all history before the
live connectors) has no source changes and is untouched by this design.

## 2. Approved scope

**Bridge ALL source-transition days** (user decision 2026-08-13): any day whose
governing anchor's `source` differs from the previous anchor's `source` is a
**zero-information day** — the flow-adjusted index carries flat across it and
it contributes no return observation. This covers both the go-live seams and
the ~2 month-end handoff days per account per month. Cost: ~2 of ~21 monthly
return observations in the live era; benefit: no basis-mixing step can ever
read as a market move.

Rejected alternatives:

- **Go-live seams only** — leaves the recurring ±0.6–2.9% month-end steps in
  the vol stream.
- **Magnitude-gated bridging** — tunable threshold, inconsistent semantics.
- **Persisted seam column on `daily_valuations`** (write-time stamping) —
  needs a schema migration + engine change + full recompute before anything
  works; only two consumers exist and both live next to the read-time helper.
  Can be layered later if a UI surface wants seam visibility.
- **Imputing the seam day's return from a benchmark** — synthetic data in a
  core metric stream; splice days are standard zero-information days in
  performance measurement.

## 3. Design

Three pieces, all read-time, no schema change, no recompute.

### 3.1 Seam detection — `fetchAnchorSourceSeamDates`

New export in `lib/compute/flow-adjusted.ts`:

```ts
export function fetchAnchorSourceSeamDates(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string
): string[]  // sorted ascending, deduped across accounts
```

Semantics:

- Per scoped account (undefined/empty `accountIds` = all accounts, matching
  `fetchNetFlowsByDate`), read `monthly_snapshots` rows with
  `month_end_date <= endDate` ordered by `month_end_date` — **the scan starts
  from the account's first anchor, not from `startDate`**, so the first
  in-window anchor is compared against its true predecessor.
- Walk each account's anchors in order; whenever `source` differs from the
  previous anchor's `source`, the newer anchor's `month_end_date` is a seam
  date.
- Return the union across accounts of seam dates in `(startDate, endDate]`,
  deduped and sorted — the same half-open bound convention as
  `fetchNetFlowsByDate` (a seam on/before the series' first date is already
  inside the starting value).
- Graceful `[]` when `monthly_snapshots` doesn't exist (minimal in-memory test
  DBs) — same `sqlite_master` guard precedent as `fetchNetFlowsByDate`.

An account's first anchor has no predecessor and is never a seam. Same-source
runs (plaid → plaid across a weekend gap) produce nothing.

**Source taxonomy and unknown values.** Observed `monthly_snapshots.source`
values today: `canonical`, `plaid`, `tws`, `ibkr-activity`. The rule is
deliberately writer-identity-based: ANY change in the source string between
adjacent anchors bridges one day. A `NULL` or unrecognized source is treated
as its own distinct value (so a transition to/from unknown provenance bridges
— conservative by construction). Statement-importer handoffs (canonical ↔
ibkr-activity) never occur adjacently in the live data (a daily source always
sits between them); if one ever did, the cost is a single bridged day, which
we accept for rule simplicity — no basis-class taxonomy is introduced until a
real case demands one.

**Why read-time detection is safe against snapshot mutation.**
`computeDailyValuations` rebuilds `daily_valuations` wholesale (DELETE + full
recompute) from the current `monthly_snapshots` on every sync, so read-time
seam detection reads the same anchor state the current valuation rows were
built from. A statement re-import that replaces plaid-era anchors changes
seams and valuations together at the next recompute — drift is bounded by one
sync cycle, the same staleness bound every valuation consumer already lives
with. Persisting anchor provenance (rejected Approach B) buys nothing under
this rebuild-wholesale architecture.

### 3.2 Bridging — `buildFlowAdjustedIndex` third parameter

```ts
export function buildFlowAdjustedIndex(
  series: SeriesPoint[],
  flows: { date: string; net: number }[],
  seamDates: string[] = []
): {
  index: SeriesPoint[];
  returns: { date: string; logReturn: number }[];
  bridgedDays: number;  // count of days bridged by a seam (0 when seamDates empty)
}
```

Seam dates are consumed with a monotonic pointer over the **same
`(series[t-1].date, series[t].date]` interval convention as flows**. If the
interval leading into day `t` contains one or more seam dates, day `t` is
bridged:

- `index[t].value = index[t-1].value` (flat — the splice contributes zero
  growth), and
- no entry is pushed to `returns` (the day contributes no observation).

This is exactly the existing skip shape used for the non-positive
prev/adjusted guard, so every consumer already tolerates it:

- **Vol/Sharpe** (`computeVolatility` in `lib/compute/risk.ts`): computes
  purely from the `returns` array (`seriesLength` only gates the ≥30 minimum),
  so a bridged day drops out of both the variance and the annualized-mean
  numerator. The fake observation disappears instead of being replaced by a
  fake zero.
- **Drawdown** (`computeMaxDrawdown`/`computeCurrentDrawdown` on `index`): the
  index no longer steps across a splice, so a seam can no longer mint a peak
  or trough. `netFlowsInWindow` (shipped 2026-08-13) is flow-only and
  unchanged; peak/trough dates may legitimately shift because the index shape
  changes.
- **Beta/alpha** (`computeMarketRegression` in `lib/compute/factors.ts`):
  pairs benchmark returns by `returns[].date` — a bridged day simply has no
  entry, so the pair is excluded from the regression rather than biasing beta
  with a zero. The benchmark-aligned series' skipped dates are already handled
  by the interval convention.

Weekend/holiday anchors (e.g. a canonical statement dated Sunday 2025-08-31
with no valuation row that day): the seam date falls inside the interval
leading into the next valuation row, which is precisely the row that carries
the basis step — the interval convention bridges the right day with no special
case.

With `seamDates` empty (default), the function is **byte-identical** to
today's behavior — every existing caller and test is unaffected until a caller
opts in.

### 3.3 Callers

- `computeRiskMetrics` (`lib/compute/risk.ts` step 2): alongside the existing
  `fetchNetFlowsByDate` call (same `points.length >= 2` guard, same date
  range), fetch seams and pass them as the third argument.
- `computeMarketRegression` (`lib/compute/factors.ts` step 3): same, over the
  aligned series' range.

Both callers already receive `accountIds` from `normalizeAccountIds`, so
multi-account scopes get the union of each member account's seams applied to
the summed series — a seam in any member is a basis change in the sum.
`fullCoverageOnly` interplay: the series may start mid-history; the helper's
predecessor-aware scan handles a window whose first anchor follows an
out-of-window source change.

**Whole-portfolio bridging is a deliberate decision** (Codex finding 9): on an
all-account scope, one member's seam bridges the whole summed day, discarding
the other members' genuine market movement for that day. The alternative —
per-account flow-adjusted indexes aggregated into a portfolio index — changes
the aggregation semantics of every scoped metric and is out of scope. In
practice member seams cluster on the same month-end dates (statements land
together), so the union rarely exceeds any single account's seam set. For
observability, `PortfolioRiskMetrics` gains one field:
`seamDaysBridged: number` — the count of bridged days inside the computed
window (0 on seam-free series). It quantifies the discarded observations and
gives the already-decided vol-contamination caption (ledger item) a number to
cite; no other API shape changes.

### 3.4 Sibling: seam-aware cash-flow classifier + repair script

`scripts/repair-missing-external-flows.ts` proposed the disproven 07-11
deposit — its "total corroborates cash" heuristic is structurally defeated by
seams (2026-08-13 session finding). Revised shape after Codex review (finding
6): seam awareness lives in the **classifier**, not the script, so every
consumer inherits it consistently.

- `lib/compute/cash-flow-audit.ts`'s residual classification gains an
  optional `seamDates` input (per the existing optional-parameter precedent).
  A residual point whose interval `(prev valuation date, point date]`
  contains a seam date classifies as a new third class, **`source-seam`** —
  distinct from `external-flow-candidate` and `internal-shift`. When the
  parameter is omitted, classification is byte-identical to today (the
  data-confidence caller changes nothing this round; fold seams into
  cashAccuracy only if the confidence surface proves misleading — observe
  first).
- The repair script computes seams **per account** (one
  `fetchAnchorSourceSeamDates` call per audited account — Codex finding 2: a
  cross-account union would let account A's seam suppress a genuine candidate
  in account B on the same date) and passes them to the classifier.
  `source-seam` points print in the dry-run report with the seam explanation,
  are **never proposed as an INSERT, and are excluded from `--apply`** (and
  from `--amount` targeting).
- **Legacy-row audit** (Codex finding 5): the dry-run report also lists any
  existing `repair-missing-flow:%` transactions whose date falls on a seam
  interval — a read-only warning that a previously applied synthetic flow may
  have been a seam misread. Verified 2026-08-13: zero such rows exist in the
  live ledger, so this is preventive, not remedial.

## 4. What does NOT change

- `daily_valuations` rows, the valuation engine, and its Phase-2 cash
  stepping (`lib/compute/daily-valuation.ts`) — seams are a read-side concern.
- The drawdown card's raw-dollar overlay and `netFlowsInWindow` semantics.
- TWR (statement-computed, never touches this engine), XIRR, attribution.
- No schema migration, no data repair, no recompute run needed.
- No Worker parity surface (the risk engine is Mac-only; grep confirms no
  `flow-adjusted` consumers under `workers/`).
- The interim vol-contamination caption (decided ledger item) stays as-is;
  this design is the underlying fix it points at.

## 5. Edge cases

- **Seam on the series' first date:** consumed by the initial pointer advance
  (same as flows) — already inside the starting value, nothing bridged.
- **Multiple seams in one interval** (e.g. plaid → canonical → plaid across a
  long weekend where only the far side has a valuation row): still one bridged
  day.
- **Short windows:** bridging removes observations; a ~30-day window (~21
  points) can dip below `computeVolatility`'s ≥20-returns guard and return
  null vol — correct degradation (insufficient clean data), noted here so the
  behavior isn't read as a regression.
- **`dataPoints`** in `PortfolioRiskMetrics` keeps reporting
  `valuations.length` (series coverage, not observation count).

## 6. Testing (TDD)

Unit — `tests/compute/flow-adjusted-seams.test.ts` (new):

- Seam detection: source change → newer anchor date emitted; same-source runs
  → nothing; first anchor never a seam; predecessor-aware scan (source change
  straddling `startDate` still detected); `(startDate, endDate]` bounds;
  multi-account union + dedupe + sort; missing `monthly_snapshots` table → `[]`;
  `NULL`/unrecognized source treated as a distinct value (transition to/from
  it bridges).
- Bridging: seam inside interval → index flat + no return entry; seam and flow
  in the same interval → the flow is consumed (pointer advances past it) and
  does not leak into the NEXT day's return, whose growth divides by the raw
  `series[t].value` as today; seam on first series date → no-op;
  multiple seams in one interval → one bridge; `seamDates` omitted →
  byte-identical output vs current fixture expectations.

Integration — extend `tests/compute/risk*.test.ts` / regression tests:

- Reproduce the 07-11 shape in memory (canonical anchor, stale carry, plaid
  anchor with a +4% step, no flow row): vol excludes the fake day;
  max-drawdown no longer peaks/troughs on the seam.
- `computeMarketRegression`: seam day excluded from pairing (observation count
  drops by exactly one; beta unbiased vs a control without the seam).
- Seam-free series through `computeRiskMetrics`: results byte-identical to
  pre-change values.

Classifier + repair script: `source-seam` classification path (point on a
seam interval → labeled, excluded from apply set; point off-seam → unchanged;
`seamDates` omitted → byte-identical to today); per-account isolation (a seam
in account A does not reclassify account B's same-date candidate); the
legacy-row audit lists a planted `repair-missing-flow:%` row on a seam
interval and stays silent otherwise.

Also asserted at unit level: `seamDaysBridged` is 0 on seam-free series and
counts bridged days otherwise, and the sub-20-clean-returns state returns
null vol/Sharpe (correct insufficient-data degradation, distinct from
series-coverage `dataPoints`).

Verification (live, read-only): before/after vol/Sharpe/beta on accounts 1, 2,
3 and `all` via the API on :3000 — expected direction: single-account vol drops
toward component-consistent levels; the 07-11 candidate disappears from the
repair script's dry-run proposals (re-labeled `source-seam`).

Known residual contamination the verifier must NOT misattribute to this
change: in-kind TRANSFER_IN/OUT legs booked at amount=0 (June donation
departures; a bounced option donation returning in early August) still read
as fake return days — a distinct defect, filed on `docs/plans/TODO.md`
2026-08-13, out of scope here (source doesn't change on those days, so seam
bridging correctly ignores them).

## 7. Rollout

Pure library change + script change; ships with the normal suite gate
(`npx vitest run`, 4,920+ tests) and `npx next build`. No migration, no
data companion, no Worker deploy. UI risk surfaces pick the corrected numbers
up on next render.
