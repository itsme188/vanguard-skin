# Seam-Aware Flow-Adjusted Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop anchor-source transition days (Plaid/TWS go-lives, monthly statement handoffs) from entering the flow-adjusted return stream as fake market moves.

**Architecture:** Read-time seam detection in `lib/compute/flow-adjusted.ts` (walk `monthly_snapshots.source` changes per account), consumed by `buildFlowAdjustedIndex` with the same `(prev, curr]` interval convention as flows. Risk metrics and market regression pass seams through; the cash-flow-audit classifier gains a third `source-seam` class the repair script inherits per-account. No schema change, no recompute.

**Tech Stack:** TypeScript, better-sqlite3 (DI: every DB fn takes `db`), Vitest with in-memory SQLite.

**Spec:** `docs/superpowers/specs/2026-08-13-seam-aware-flow-adjusted-index-design.md`

## Global Constraints

- Test command prefix (repo pin): `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <path>`
- All dates `YYYY-MM-DD`; every DB function takes `db: Database.Database` as first parameter.
- With `seamDates` empty/omitted, every changed function must be **byte-identical** in behavior to today (existing tests are the proof — none may need edits except where a return type gains a field).
- Committed files carry NO real portfolio values — tests use synthetic figures.
- Commit messages via temp file + `git commit -F` (macOS bash 3.2 quoting rule).
- Do not touch: `lib/compute/daily-valuation.ts`, `lib/queries/data-confidence.ts`, any UI component, anything under `workers/`.

---

### Task 1: `fetchAnchorSourceSeamDates` helper

**Files:**
- Modify: `lib/compute/flow-adjusted.ts` (append after `fetchNetFlowsByDate`)
- Test: `tests/compute/flow-adjusted-seams.test.ts` (create)

**Interfaces:**
- Consumes: `monthly_snapshots` table (`account_id`, `month_end_date`, `source` columns).
- Produces: `fetchAnchorSourceSeamDates(db, accountIds: number[] | undefined, startDate: string, endDate: string): string[]` — sorted ascending, deduped across accounts, bounded to `(startDate, endDate]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/compute/flow-adjusted-seams.test.ts`:

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE monthly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      month_end_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      source TEXT
    );
  `);
  return db;
}

function insertAnchor(
  db: Database.Database,
  accountId: number,
  date: string,
  source: string | null
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, 100000, ?)`
  ).run(accountId, date, source);
}

describe("fetchAnchorSourceSeamDates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("emits the newer anchor date when source changes between adjacent anchors", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("emits nothing for same-source runs", () => {
    insertAnchor(db, 1, "2026-07-11", "plaid");
    insertAnchor(db, 1, "2026-07-13", "plaid");
    insertAnchor(db, 1, "2026-07-14", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });

  it("never treats an account's first anchor as a seam", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });

  it("detects a transition whose predecessor anchor is before startDate", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    // startDate sits between the two anchors — predecessor is out of window
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-07-05", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("bounds results to (startDate, endDate]", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    insertAnchor(db, 1, "2026-07-31", "canonical");
    // seam ON startDate is excluded (already inside starting value)
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-07-11", "2026-07-31")
    ).toEqual(["2026-07-31"]);
    // seam after endDate is excluded
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-07-15")
    ).toEqual(["2026-07-11"]);
  });

  it("unions, dedupes, and sorts across accounts", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-31", "plaid");
    insertAnchor(db, 2, "2026-06-30", "canonical");
    insertAnchor(db, 2, "2026-07-11", "plaid");
    insertAnchor(db, 2, "2026-07-31", "plaid");
    // account 1 seams: 07-31; account 2 seams: 07-11
    expect(
      fetchAnchorSourceSeamDates(db, [1, 2], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11", "2026-07-31"]);
  });

  it("treats undefined/empty accountIds as all accounts", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, undefined, "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
    expect(
      fetchAnchorSourceSeamDates(db, [], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("treats NULL source as a distinct value (transition to/from it bridges)", () => {
    insertAnchor(db, 1, "2026-05-31", "canonical");
    insertAnchor(db, 1, "2026-06-30", null);
    insertAnchor(db, 1, "2026-07-31", "canonical");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-06-30", "2026-07-31"]);
  });

  it("returns [] when monthly_snapshots does not exist", () => {
    const bare = new Database(":memory:");
    expect(
      fetchAnchorSourceSeamDates(bare, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts`
Expected: FAIL — `fetchAnchorSourceSeamDates` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `lib/compute/flow-adjusted.ts`:

```ts
/**
 * Anchor-source seam dates for the scoped accounts, bounded to
 * (startDate, endDate] — the same half-open convention as
 * fetchNetFlowsByDate (a seam on/before the series' first date is already
 * inside the starting value).
 *
 * A "seam" is the month_end_date of any monthly_snapshots anchor whose
 * `source` differs from the SAME account's previous anchor. Phase 2 of
 * computeDailyValuations snaps total_value to each anchor's total on the
 * anchor date, so a source change between adjacent anchors injects the two
 * sources' measurement-basis difference into the daily series as if it were
 * a market move (the 2026-07-11 Plaid go-live read as a fake ~+4% day; every
 * daily-source ↔ statement month-end handoff repeats this at ~±1-3%).
 * buildFlowAdjustedIndex bridges these days: zero information, not a return.
 *
 * The scan starts from each account's FIRST anchor (not startDate) so the
 * first in-window anchor is compared against its true predecessor. NULL and
 * unrecognized sources are distinct values — a transition to/from unknown
 * provenance bridges (conservative by construction). An account's first
 * anchor has no predecessor and is never a seam.
 *
 * Gracefully returns [] when monthly_snapshots doesn't exist (minimal
 * in-memory test DBs) — same precedent as fetchNetFlowsByDate.
 */
export function fetchAnchorSourceSeamDates(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string
): string[] {
  const hasTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monthly_snapshots'"
    )
    .get();
  if (!hasTable) return [];

  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND account_id IN (${accountIds.map(() => "?").join(",")})`
      : "";

  const rows = db
    .prepare(
      `SELECT account_id, month_end_date, source
       FROM monthly_snapshots
       WHERE month_end_date <= ?
         ${accountFilter}
       ORDER BY account_id ASC, month_end_date ASC`
    )
    .all(endDate, ...(accountIds ?? [])) as {
    account_id: number;
    month_end_date: string;
    source: string | null;
  }[];

  const seams = new Set<string>();
  let prevAccount: number | null = null;
  let prevSource: string | null | undefined;
  for (const row of rows) {
    const isNewAccount = row.account_id !== prevAccount;
    if (!isNewAccount && row.source !== prevSource && row.month_end_date > startDate) {
      seams.add(row.month_end_date);
    }
    prevAccount = row.account_id;
    prevSource = row.source;
  }

  return [...seams].sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
printf 'feat(risk): fetchAnchorSourceSeamDates detects anchor-source transitions\n' > /tmp/cmsg.txt
git add lib/compute/flow-adjusted.ts tests/compute/flow-adjusted-seams.test.ts
git commit -F /tmp/cmsg.txt
```

---

### Task 2: seam bridging in `buildFlowAdjustedIndex`

**Files:**
- Modify: `lib/compute/flow-adjusted.ts` (`buildFlowAdjustedIndex`, currently ~lines 86–115)
- Test: `tests/compute/flow-adjusted-seams.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchAnchorSourceSeamDates` output shape (sorted `string[]`), Task 1.
- Produces: `buildFlowAdjustedIndex(series, flows, seamDates: string[] = [])` returning `{ index: SeriesPoint[]; returns: { date: string; logReturn: number }[]; bridgedDays: number }`. Existing 2-arg callers keep compiling and behaving identically (`bridgedDays: 0`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/compute/flow-adjusted-seams.test.ts`:

```ts
import { buildFlowAdjustedIndex } from "@/lib/compute/flow-adjusted";

describe("buildFlowAdjustedIndex seam bridging", () => {
  const series = [
    { date: "2026-07-09", value: 100_000 },
    { date: "2026-07-10", value: 101_000 },
    { date: "2026-07-11", value: 105_000 }, // fake +4% seam step
    { date: "2026-07-13", value: 104_000 },
  ];

  it("carries the index flat across a seam day and emits no return for it", () => {
    const { index, returns, bridgedDays } = buildFlowAdjustedIndex(
      series,
      [],
      ["2026-07-11"]
    );
    expect(bridgedDays).toBe(1);
    // 07-10 return computed normally
    expect(returns.map((r) => r.date)).toEqual(["2026-07-10", "2026-07-13"]);
    // index flat across the bridge
    const i10 = index.find((p) => p.date === "2026-07-10")!.value;
    const i11 = index.find((p) => p.date === "2026-07-11")!.value;
    expect(i11).toBe(i10);
    // next day's return divides by the RAW 07-11 value (104000/105000), so
    // the index resumes from the bridged level with a real market move
    const i13 = index.find((p) => p.date === "2026-07-13")!.value;
    expect(i13).toBeCloseTo(i10 * (104_000 / 105_000), 10);
  });

  it("is byte-identical to the 2-arg call when seamDates is empty", () => {
    const withFlows = [{ date: "2026-07-10", net: 500 }];
    const a = buildFlowAdjustedIndex(series, withFlows);
    const b = buildFlowAdjustedIndex(series, withFlows, []);
    expect(b.index).toEqual(a.index);
    expect(b.returns).toEqual(a.returns);
    expect(a.bridgedDays).toBe(0);
    expect(b.bridgedDays).toBe(0);
  });

  it("consumes a flow inside a bridged interval without leaking it forward", () => {
    const flows = [{ date: "2026-07-11", net: 2_000 }];
    const { index, returns } = buildFlowAdjustedIndex(series, flows, ["2026-07-11"]);
    // 07-11 bridged: no return; 07-13 growth is 104000/105000 — the 07-11
    // flow must NOT be re-subtracted from 07-13's numerator
    expect(returns.map((r) => r.date)).toEqual(["2026-07-10", "2026-07-13"]);
    const i10 = index.find((p) => p.date === "2026-07-10")!.value;
    const i13 = index.find((p) => p.date === "2026-07-13")!.value;
    expect(i13).toBeCloseTo(i10 * (104_000 / 105_000), 10);
  });

  it("bridges once when multiple seams fall in one interval", () => {
    // weekend: valuation rows only on 07-10 and 07-13; seams 07-11 + 07-12
    const gappy = [
      { date: "2026-07-10", value: 100_000 },
      { date: "2026-07-13", value: 108_000 },
      { date: "2026-07-14", value: 109_000 },
    ];
    const { returns, bridgedDays } = buildFlowAdjustedIndex(
      gappy,
      [],
      ["2026-07-11", "2026-07-12"]
    );
    expect(bridgedDays).toBe(1);
    expect(returns.map((r) => r.date)).toEqual(["2026-07-14"]);
  });

  it("ignores a seam on the series' first date", () => {
    const { returns, bridgedDays } = buildFlowAdjustedIndex(
      series,
      [],
      ["2026-07-09"]
    );
    expect(bridgedDays).toBe(0);
    expect(returns).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts`
Expected: FAIL — third parameter ignored / `bridgedDays` undefined.

- [ ] **Step 3: Implement bridging**

Replace `buildFlowAdjustedIndex` in `lib/compute/flow-adjusted.ts` with:

```ts
/**
 * Build a growth-of-$1 index from daily valuations with external flows
 * stripped out: r_t = (V_t − F_t) / V_{t−1}, where F_t is the net flow that
 * landed in (date_{t−1}, date_t] (end-of-day convention — a flow dated on a
 * valuation date adjusts that date's return, matching statement EOD values).
 * Drawdowns computed on this index reflect market movement only; the raw
 * series would read every withdrawal as a crash and every deposit as a rally.
 *
 * `seamDates` (sorted ascending — fetchAnchorSourceSeamDates output) marks
 * anchor-source transition days: a day whose interval (date_{t−1}, date_t]
 * contains a seam is a BRIDGED day — the value step mixes two measurement
 * bases (statement vs Plaid vs TWS), so it is zero information, not a
 * return. The index carries flat and no return observation is emitted (the
 * same skip shape as the non-positive guard, so every consumer already
 * tolerates it). Flows inside a bridged interval are consumed — the whole
 * step is discarded, flow component included — and never leak into the next
 * day's return, which divides by the raw series[t].value as always.
 *
 * `returns` carries each log return with the date it lands on (series[t]) so
 * consumers that pair returns with another series (the market regression's
 * benchmark alignment) can match by date; a skipped pair (non-positive prev
 * or adjusted value, or a bridged day) simply has no entry. `bridgedDays`
 * counts seam-bridged days for observability (PortfolioRiskMetrics.
 * seamDaysBridged; 0 when seamDates is empty).
 */
export function buildFlowAdjustedIndex(
  series: SeriesPoint[],
  flows: { date: string; net: number }[],
  seamDates: string[] = []
): {
  index: SeriesPoint[];
  returns: { date: string; logReturn: number }[];
  bridgedDays: number;
} {
  if (series.length === 0) return { index: [], returns: [], bridgedDays: 0 };

  const index: SeriesPoint[] = [{ date: series[0].date, value: 1 }];
  const returns: { date: string; logReturn: number }[] = [];
  let bridgedDays = 0;
  let fi = 0;
  while (fi < flows.length && flows[fi].date <= series[0].date) fi++;
  let si = 0;
  while (si < seamDates.length && seamDates[si] <= series[0].date) si++;

  for (let t = 1; t < series.length; t++) {
    let net = 0;
    while (fi < flows.length && flows[fi].date <= series[t].date) {
      net += flows[fi].net;
      fi++;
    }
    let bridged = false;
    while (si < seamDates.length && seamDates[si] <= series[t].date) {
      bridged = true;
      si++;
    }
    const prev = series[t - 1].value;
    const adjusted = series[t].value - net;
    let indexValue = index[t - 1].value;
    if (bridged) {
      bridgedDays++;
    } else if (prev > 0 && adjusted > 0) {
      const growth = adjusted / prev;
      returns.push({ date: series[t].date, logReturn: Math.log(growth) });
      indexValue = index[t - 1].value * growth;
    }
    index.push({ date: series[t].date, value: indexValue });
  }

  return { index, returns, bridgedDays };
}
```

- [ ] **Step 4: Run the new tests AND the existing flow-adjusted consumers**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts tests/compute/risk.test.ts tests/compute/`
Expected: PASS everywhere — existing tests prove the empty-seam path unchanged.

- [ ] **Step 5: Commit**

```bash
printf 'feat(risk): buildFlowAdjustedIndex bridges anchor-source seam days\n' > /tmp/cmsg.txt
git add lib/compute/flow-adjusted.ts tests/compute/flow-adjusted-seams.test.ts
git commit -F /tmp/cmsg.txt
```

---

### Task 3: thread seams through `computeRiskMetrics` + expose `seamDaysBridged`

**Files:**
- Modify: `lib/compute/risk.ts` (import at ~line 7; interface `PortfolioRiskMetrics` at ~line 74; step-2 block at ~lines 176–216; return at ~lines 222–235)
- Test: `tests/compute/flow-adjusted-seams.test.ts` (extend with an integration describe)

**Interfaces:**
- Consumes: `fetchAnchorSourceSeamDates` (Task 1), 3-arg `buildFlowAdjustedIndex` (Task 2).
- Produces: `PortfolioRiskMetrics` gains `seamDaysBridged: number` (0 on seam-free series). Consumed by the vol-contamination caption (separate ledger item — no UI change here).

- [ ] **Step 1: Write the failing integration test**

Append to `tests/compute/flow-adjusted-seams.test.ts`. Build the in-memory schema the existing risk tests use — copy the exact `CREATE TABLE` set from the top of `tests/compute/risk.test.ts` (accounts, securities, holdings, prices, daily_valuations, monthly_snapshots, transactions — read that file first and reuse its helper if it exports one; otherwise inline the DDL). Then:

```ts
import { computeRiskMetrics } from "@/lib/compute/risk";

describe("computeRiskMetrics seam awareness (07-11 shape)", () => {
  it("excludes the seam day from vol and reports seamDaysBridged", () => {
    const db = makeRiskDb(); // in-memory schema per tests/compute/risk.test.ts
    // 40 valuation days of ±0.1% noise around 100k for account 1, then a
    // +4% single-day step at day 30 with NO flow row — the seam shape.
    // Anchor rows: canonical up to the step date's predecessor era, plaid from
    // the step date, e.g.:
    //   insertAnchor(db, 1, dayBeforeStep(29th date), "canonical")  // era 1
    //   insertAnchor(db, 1, stepDate(30th date), "plaid")           // era 2
    const withSeam = computeRiskMetrics(db);
    expect(withSeam.seamDaysBridged).toBe(1);

    const control = makeRiskDbWithoutSourceChange(); // identical values, both anchors 'canonical'
    const contaminated = computeRiskMetrics(control);
    expect(contaminated.seamDaysBridged).toBe(0);
    // the fake +4% observation inflates vol in the control only
    expect(withSeam.volatility!).toBeLessThan(contaminated.volatility!);
  });

  it("keeps seam-free series byte-identical (seamDaysBridged 0)", () => {
    const db = makeRiskDbWithoutSourceChange();
    const result = computeRiskMetrics(db);
    expect(result.seamDaysBridged).toBe(0);
  });
});
```

(Write `makeRiskDb`/`makeRiskDbWithoutSourceChange` as concrete local helpers generating the same synthetic series with only the anchor `source` values differing.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts`
Expected: FAIL — `seamDaysBridged` undefined on the result.

- [ ] **Step 3: Implement threading**

In `lib/compute/risk.ts`:

1. Extend the import: `import { buildFlowAdjustedIndex, fetchNetFlowsByDate, fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";`
2. Add to `PortfolioRiskMetrics` (after `dataPoints: number;`):

```ts
  /** Anchor-source seam days bridged out of the return stream (see
   *  fetchAnchorSourceSeamDates) — 0 on seam-free series. Quantifies
   *  observations discarded as zero-information source-transition days. */
  seamDaysBridged: number;
```

3. In step 2 of `computeRiskMetrics`, next to the flows fetch:

```ts
  const seamDates =
    points.length >= 2
      ? fetchAnchorSourceSeamDates(db, accountIds, points[0].date, points[points.length - 1].date)
      : [];
  const { index, returns, bridgedDays } = buildFlowAdjustedIndex(points, flows, seamDates);
```

4. Add `seamDaysBridged: bridgedDays,` to the returned object.

- [ ] **Step 4: Run tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts tests/compute/risk.test.ts`
Expected: PASS (existing risk tests unaffected — their fixtures have no source changes, or no monthly_snapshots table at all, so `seamDates` is `[]`).

- [ ] **Step 5: Commit**

```bash
printf 'feat(risk): computeRiskMetrics bridges seam days, exposes seamDaysBridged\n' > /tmp/cmsg.txt
git add lib/compute/risk.ts tests/compute/flow-adjusted-seams.test.ts
git commit -F /tmp/cmsg.txt
```

---

### Task 4: thread seams through `computeMarketRegression`

**Files:**
- Modify: `lib/compute/factors.ts` (import at ~line 7; step-3 block at ~lines 147–156)
- Test: `tests/compute/flow-adjusted-seams.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchAnchorSourceSeamDates` (Task 1), 3-arg `buildFlowAdjustedIndex` (Task 2).
- Produces: no signature change — `computeMarketRegression` internally excludes bridged days from the regression pairs.

- [ ] **Step 1: Write the failing test**

Append to `tests/compute/flow-adjusted-seams.test.ts` (reuse the Task 3 fixture helpers; the regression fixture additionally needs `benchmark_prices` rows — copy the DDL/inserts pattern from the existing regression tests in `tests/compute/factors*.test.ts`, reading that file first):

```ts
import { computeMarketRegression } from "@/lib/compute/factors";

describe("computeMarketRegression seam awareness", () => {
  it("drops the seam day's pair instead of biasing beta", () => {
    const db = makeRegressionDbWithSeam();      // seam step day, source change
    const control = makeRegressionDbNoSeam();   // identical values, no source change
    const seamAware = computeMarketRegression(db)!;
    const contaminated = computeMarketRegression(control)!;
    // one fewer observation, and the fake-return pair no longer drags beta
    expect(seamAware.dataPoints).toBe(contaminated.dataPoints - 1);
    expect(seamAware.beta).not.toBeCloseTo(contaminated.beta, 5);
  });
});
```

(Adjust the result-field names — `dataPoints`/`beta` — to the actual `MarketRegressionResult` interface in `lib/compute/factors.ts`; read it before writing the test. If the count field has a different name, assert on that name.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts`
Expected: FAIL — both scenarios produce identical observation counts.

- [ ] **Step 3: Implement threading**

In `lib/compute/factors.ts`, extend the import and mirror the risk.ts pattern in step 3:

```ts
  const seamDates =
    alignedSeries.length >= 2
      ? fetchAnchorSourceSeamDates(
          db,
          accountIds,
          alignedSeries[0].date,
          alignedSeries[alignedSeries.length - 1].date
        )
      : [];
  const { returns: adjustedReturns } = buildFlowAdjustedIndex(alignedSeries, flows, seamDates);
```

- [ ] **Step 4: Run tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts tests/compute/factors.test.ts tests/compute/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
printf 'feat(risk): computeMarketRegression excludes seam days from beta pairs\n' > /tmp/cmsg.txt
git add lib/compute/factors.ts tests/compute/flow-adjusted-seams.test.ts
git commit -F /tmp/cmsg.txt
```

---

### Task 5: `source-seam` classification in the cash-flow audit

**Files:**
- Modify: `lib/compute/cash-flow-audit.ts` (`CashFlowClassification` at ~line 133; `computeCashFlowResiduals` at ~lines 208–293)
- Test: `tests/compute/cash-flow-audit.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new — seams arrive as data via the new option.
- Produces: `CashFlowClassification = "external-flow-candidate" | "internal-shift" | "source-seam"`; `computeCashFlowResiduals(db, opts?: { accountIds?: number[]; seamDatesByAccount?: Map<number, string[]> })`. When `seamDatesByAccount` is omitted, output is byte-identical to today (`lib/queries/data-confidence.ts` stays untouched and unchanged in behavior). `classifyCashFlowResidual` stays pure and 2-arg.

- [ ] **Step 1: Write the failing tests**

Append to `tests/compute/cash-flow-audit.test.ts` (reuse that file's existing fixture helpers — read it first; it already builds `daily_valuations` + `transactions` in-memory):

```ts
describe("source-seam classification", () => {
  it("classifies a residual point on a seam interval as source-seam", () => {
    const db = makeAuditDb(); // existing helper in this file
    // fixture: account 1 cash jumps between 07-10 and 07-11 with no txn
    const seams = new Map([[1, ["2026-07-11"]]]);
    const points = computeCashFlowResiduals(db, {
      accountIds: [1],
      seamDatesByAccount: seams,
    });
    const seamPoint = points.find((p) => p.toDate === "2026-07-11")!;
    expect(seamPoint.classification).toBe("source-seam");
  });

  it("does not let account A's seam reclassify account B's same-date point", () => {
    const db = makeAuditDbTwoAccounts(); // both accounts jump on 07-11
    const seams = new Map([[1, ["2026-07-11"]]]); // seam only in account 1
    const points = computeCashFlowResiduals(db, { seamDatesByAccount: seams });
    expect(points.find((p) => p.accountId === 1 && p.toDate === "2026-07-11")!
      .classification).toBe("source-seam");
    expect(points.find((p) => p.accountId === 2 && p.toDate === "2026-07-11")!
      .classification).not.toBe("source-seam");
  });

  it("is byte-identical when seamDatesByAccount is omitted", () => {
    const db = makeAuditDb();
    const a = computeCashFlowResiduals(db, { accountIds: [1] });
    const b = computeCashFlowResiduals(db, { accountIds: [1], seamDatesByAccount: new Map() });
    expect(b).toEqual(a);
    expect(a.every((p) => p.classification !== "source-seam")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/cash-flow-audit.test.ts`
Expected: FAIL — `"source-seam"` never produced / option unknown.

- [ ] **Step 3: Implement**

In `lib/compute/cash-flow-audit.ts`:

1. `export type CashFlowClassification = "external-flow-candidate" | "internal-shift" | "source-seam";`
2. Extend the options type of `computeCashFlowResiduals` to `opts?: { accountIds?: number[]; seamDatesByAccount?: Map<number, string[]> }` and inside the per-account loop pull `const accountSeams = opts?.seamDatesByAccount?.get(account.id) ?? [];` with its own monotonic pointer (same convention as the `ti` transaction pointer, advanced per interval `(prev.valuation_date, curr.valuation_date]`).
3. In the point construction, override the classification:

```ts
        classification: seamInInterval
          ? "source-seam"
          : classifyCashFlowResidual(residual, totalDelta),
```

where `seamInInterval` is true when the pointer consumed at least one seam date for this interval. Document on the type: a `source-seam` point's residual is a measurement-basis artifact of an anchor-source transition (see `fetchAnchorSourceSeamDates` in `lib/compute/flow-adjusted.ts`), not a candidate for flow synthesis.

4. Check `partitionCandidates` (~line 373): it must route `source-seam` points into neither the external-flow-candidate bucket nor the internal-shift bucket silently — read its shape and either add a third partition field or exclude-and-count; the repair script (Task 6) needs the seam points listed. Prefer adding `seamPoints: CashFlowResidualPoint[]` to its return object.

- [ ] **Step 4: Run tests (audit + data-confidence twins)**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/cash-flow-audit.test.ts tests/queries/data-confidence-cash-flow.test.ts`
Expected: PASS — data-confidence tests prove the omitted-option path unchanged.

- [ ] **Step 5: Commit**

```bash
printf 'feat(audit): source-seam classification for anchor-transition residuals\n' > /tmp/cmsg.txt
git add lib/compute/cash-flow-audit.ts tests/compute/cash-flow-audit.test.ts
git commit -F /tmp/cmsg.txt
```

---

### Task 6: seam-aware repair script (per-account) + legacy-row audit

**Files:**
- Modify: `scripts/repair-missing-external-flows.ts` (imports ~lines 89–99; candidate assembly ~line 159; report printing ~lines 290–326; `main()` ~line 328)
- Test: `tests/scripts/repair-missing-external-flows.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchAnchorSourceSeamDates` (Task 1), `seamDatesByAccount` option + `source-seam` class + `partitionCandidates.seamPoints` (Task 5).
- Produces: dry-run report prints `source-seam` points under their own heading with an explanation; `--apply` and `--amount` can only ever target `external-flow-candidate` points (already structurally true — selection validates against that class; add a covering test). New report section lists legacy `repair-missing-flow:%` transactions dated on a seam interval.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scripts/repair-missing-external-flows.test.ts` (this file already unit-tests the script's pure exported helpers — read it first and follow its import pattern):

```ts
describe("seam awareness", () => {
  it("collectSeamDatesByAccount fetches per-account seams (no cross-account union)", () => {
    const db = makeDbWithAnchors(); // account 1: canonical→plaid at 07-11; account 2: plaid throughout
    const seams = collectSeamDatesByAccount(db, [1, 2]);
    expect(seams.get(1)).toEqual(["2026-07-11"]);
    expect(seams.get(2) ?? []).toEqual([]);
  });

  it("findLegacyRepairRowsOnSeams flags an applied synthetic flow on a seam interval", () => {
    const db = makeDbWithAnchors();
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
       VALUES (1, '2026-07-11', 'DEPOSIT', 88000, 1, 'repair-missing-flow:1:2026-07-11')`
    ).run();
    const flagged = findLegacyRepairRowsOnSeams(db, new Map([[1, ["2026-07-11"]]]));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].source_key).toBe("repair-missing-flow:1:2026-07-11");
  });

  it("stays silent when no legacy repair rows sit on seams", () => {
    const db = makeDbWithAnchors();
    expect(findLegacyRepairRowsOnSeams(db, new Map([[1, ["2026-07-11"]]]))).toEqual([]);
  });
});
```

(Match the actual `transactions` DDL used elsewhere in this test file; adjust column lists accordingly. `collectSeamDatesByAccount` and `findLegacyRepairRowsOnSeams` are new pure exports from the script.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/scripts/repair-missing-external-flows.test.ts`
Expected: FAIL — new helpers not exported.

- [ ] **Step 3: Implement**

In `scripts/repair-missing-external-flows.ts`:

1. Import `fetchAnchorSourceSeamDates` from `../lib/compute/flow-adjusted`.
2. Add pure exports:

```ts
/** Per-account seam dates over each account's full anchor span — one call
 *  per account, NEVER a cross-account union: account A's seam must not
 *  suppress a genuine candidate in account B on the same date. */
export function collectSeamDatesByAccount(
  db: Database.Database,
  accountIds: number[]
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const id of accountIds) {
    map.set(id, fetchAnchorSourceSeamDates(db, [id], "0000-00-00", "9999-12-31"));
  }
  return map;
}

/** Read-only audit: previously applied synthetic flows whose date lands on
 *  a seam — a past run may have misread a source transition as a flow.
 *  (Zero such rows exist in the live ledger as of 2026-08-13 — preventive.) */
export function findLegacyRepairRowsOnSeams(
  db: Database.Database,
  seamsByAccount: Map<number, string[]>
): { id: number; account_id: number; trade_date: string; amount: number; source_key: string }[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, trade_date, amount, source_key FROM transactions
       WHERE source_key LIKE 'repair-missing-flow:%' ORDER BY trade_date`
    )
    .all() as { id: number; account_id: number; trade_date: string; amount: number; source_key: string }[];
  return rows.filter((r) => (seamsByAccount.get(r.account_id) ?? []).includes(r.trade_date));
}
```

3. In `main()` / the candidate-assembly path: build `seamsByAccount` for the audited accounts, pass `seamDatesByAccount` into `computeCashFlowResiduals`, print `source-seam` points under a distinct heading (mirror `printInternalShift`'s shape) with a one-line explanation ("anchor source changed — measurement-basis step, not a flow; never synthesized"), and print the legacy-row audit section (or "no legacy repair rows on seams" line). The `--apply` insert list continues to come exclusively from `external-flow-candidate` points via the existing selection helpers — no change needed there beyond the classification upstream.

- [ ] **Step 4: Run the script's tests + a live dry-run smoke check**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/scripts/repair-missing-external-flows.test.ts`
Expected: PASS.

Then (read-only, live DB): `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-missing-external-flows.ts`
Expected: the former 2026-07-11 proposal now prints under `source-seam` with zero proposed inserts for it; legacy audit prints the "none" line.

- [ ] **Step 5: Commit**

```bash
printf 'feat(repair): flow-repair script is seam-aware (per-account, legacy audit)\n' > /tmp/cmsg.txt
git add scripts/repair-missing-external-flows.ts tests/scripts/repair-missing-external-flows.test.ts
git commit -F /tmp/cmsg.txt
```

---

### Task 7: full-suite gate + build + live verification

**Files:**
- No new files; read-only verification.

- [ ] **Step 1: Full test suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run`
Expected: ALL PASS (baseline 4,920 + new tests). Report the exact count.

- [ ] **Step 2: Build gate**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build`
Expected: compiles clean (catches type breaks in UI consumers of `PortfolioRiskMetrics`).

- [ ] **Step 3: Live before/after (read-only)**

Write a THROWAWAY tsx snippet (do not commit) that opens `data/vanguard.db` read-only and prints `computeRiskMetrics(db, { accountId: N })` vol/Sharpe/`seamDaysBridged` for accounts 1, 2, 3 and the all-scope, plus `computeMarketRegression(db)` beta. Compare against the same snippet run on stashed-clean `main` (or record the pre-change numbers first). Expected: single-account vol drops materially (the fake seam observations leave the stream); `seamDaysBridged` > 0 for windows spanning 2026-07-11 / month-end handoffs; beta observation count drops by the bridged-day count. **Known caveat (spec §6):** in-kind $0-amount TRANSFER legs (June donation departures, early-August option return) still contaminate — distinct filed defect; do not misattribute or chase here.

- [ ] **Step 4: Report**

Report suite count, build result, and the before/after table to the user. Do NOT commit anything in this task; do NOT deploy — deploy decisions stay with the user/session-end.

## Self-review notes

- Spec coverage: §3.1→Task 1, §3.2→Task 2, §3.3→Tasks 3–4, §3.4→Tasks 5–6, §6 verification→Task 7. `seamDaysBridged` (§3.3 observability) → Task 3. Legacy audit (§3.4) → Task 6.
- Existing-test compatibility is asserted at every task via the byte-identical default path.
- Type consistency: `fetchAnchorSourceSeamDates` returns `string[]`; `seamDatesByAccount` is `Map<number, string[]>`; `bridgedDays` (function) vs `seamDaysBridged` (metrics field) — intentional rename at the API boundary, defined in Tasks 2 and 3 respectively.
