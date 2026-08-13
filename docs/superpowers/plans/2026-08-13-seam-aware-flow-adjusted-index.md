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

### Task 0: capture the pre-change baseline (read-only, no commit)

**Files:**
- Create: `/Users/Yitzi/.claude/jobs/5470995b/tmp/risk-baseline.ts` (throwaway — job tmp dir, never committed)

Task 7 compares before/after; the "before" must be captured BEFORE any code
changes land, not reconstructed via stash gymnastics.

- [ ] **Step 1: Write and run the baseline snippet**

```ts
// risk-baseline.ts — throwaway; run from the repo root
import Database from "better-sqlite3";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { computeFactorAnalysis } from "@/lib/compute/factors";

const db = new Database("data/vanguard.db", { readonly: true });
for (const scope of [[1], [2], [3], undefined] as (number[] | undefined)[]) {
  const m = computeRiskMetrics(db, scope ? { accountIds: scope } : undefined);
  console.log(scope ?? "all", {
    vol: m.volatility, sharpe: m.sharpeRatio,
    maxDD: m.maxDrawdown?.percent, ddPeak: m.maxDrawdown?.peakDate,
    ddTrough: m.maxDrawdown?.troughDate, dataPoints: m.dataPoints,
  });
}
const fa = computeFactorAnalysis(db);
console.log("regression", fa.marketRegression);
```

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx /Users/Yitzi/.claude/jobs/5470995b/tmp/risk-baseline.ts`
(If `@/` aliases fail under tsx, rewrite the imports as relative paths.)
Save the output to `/Users/Yitzi/.claude/jobs/5470995b/tmp/risk-baseline-before.txt`. Adjust field names to the actual `PortfolioRiskMetrics`/`MarketRegression` interfaces if they differ — read them first.

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
- Modify: `tests/api/compute-risk.test.ts` (the typed `fakeMetrics(): PortfolioRiskMetrics` fixture at ~line 21 gains `seamDaysBridged: 0` — the interface addition breaks its type-completeness otherwise)
- Test: `tests/compute/flow-adjusted-seams.test.ts` (extend with an integration describe)

**Fixture DDL note:** `tests/compute/risk.test.ts`'s fixture has NO
`monthly_snapshots` table (that's why existing risk tests stay green — the
helper's missing-table guard returns `[]`). The new integration fixture must
therefore create its own supplemental table alongside the copied DDL:

```sql
CREATE TABLE monthly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  month_end_date TEXT NOT NULL,
  total_value REAL NOT NULL,
  source TEXT
);
```

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

  it("never places a drawdown peak or trough ON the seam day", () => {
    // Shape the series so the CONTAMINATED run's max drawdown peaks exactly
    // on the seam step (values rise into the +4% step then decline), then
    // assert the seam-aware run reports different peak/trough dates, neither
    // equal to the seam date.
    const db = makeRiskDb();
    const m = computeRiskMetrics(db);
    expect(m.maxDrawdown?.peakDate).not.toBe(SEAM_DATE);
    expect(m.maxDrawdown?.troughDate).not.toBe(SEAM_DATE);
  });

  it("returns null vol/Sharpe when bridging drops clean returns below 20", () => {
    // 31 valuation days (passes the seriesLength >= 30 gate) but with 11
    // seam days interleaved so clean returns = 30 - 11 = 19 < 20.
    const db = makeRiskDbManySeams();
    const m = computeRiskMetrics(db);
    expect(m.volatility).toBeNull();
    expect(m.sharpeRatio).toBeNull();
    expect(m.seamDaysBridged).toBe(11);
  });
});
```

(Write `makeRiskDb`/`makeRiskDbWithoutSourceChange`/`makeRiskDbManySeams` as concrete local helpers generating the same synthetic series with only the anchor rows differing; `SEAM_DATE` is the fixture's step-date constant. Many-seams fixture: alternate anchor sources on 11 of the dates.)

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
5. In `tests/api/compute-risk.test.ts`, add `seamDaysBridged: 0,` to the object literal inside `fakeMetrics()` (~line 21) so the typed fixture stays complete.

- [ ] **Step 4: Run tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts tests/compute/risk.test.ts tests/api/compute-risk.test.ts`
Expected: PASS (existing risk tests unaffected — their fixtures have no `monthly_snapshots` table at all, so `seamDates` is `[]`; the api fixture now carries the new field).

- [ ] **Step 5: Commit**

```bash
printf 'feat(risk): computeRiskMetrics bridges seam days, exposes seamDaysBridged\n' > /tmp/cmsg.txt
git add lib/compute/risk.ts tests/compute/flow-adjusted-seams.test.ts
git commit -F /tmp/cmsg.txt
```

---

### Task 4: thread seams through `computeMarketRegression`

**Files:**
- Modify: `lib/compute/factors.ts` (import at ~line 7; step-3 block of the PRIVATE `computeMarketRegression` at ~lines 147–156 — it is NOT exported; the public path is `computeFactorAnalysis(db, options).marketRegression` at ~line 498)
- Test: `tests/compute/factors-flow-adjusted.test.ts` (extend — this existing file already fixtures the flow-adjusted regression path; read it first and reuse its DDL/seed helpers, adding a `monthly_snapshots` table with the same supplemental DDL as Task 3 if its fixture lacks one)

**Interfaces:**
- Consumes: `fetchAnchorSourceSeamDates` (Task 1), 3-arg `buildFlowAdjustedIndex` (Task 2).
- Produces: no signature change — the private `computeMarketRegression` internally excludes bridged days; tests observe it through `computeFactorAnalysis(db).marketRegression`.

- [ ] **Step 1: Write the failing test**

Append to `tests/compute/factors-flow-adjusted.test.ts` (reuse its existing fixture helpers; check the actual `MarketRegression` interface at `lib/compute/factors.ts` ~line 44 for field names — adjust `beta`/observation-count names to what it declares):

```ts
describe("market regression seam awareness", () => {
  it("drops the seam day's pair; beta recovers the true relationship", () => {
    // Construct portfolio returns as EXACTLY 1.0 x benchmark for 40 aligned
    // days, EXCEPT one +4% portfolio-only step day with no flow row. Anchors:
    // 'canonical' era before the step, 'plaid' from the step date (seam DB);
    // control DB has identical values but both anchors 'canonical'.
    const db = makeRegressionDbWithSeam();
    const control = makeRegressionDbNoSeam();
    const seamAware = computeFactorAnalysis(db).marketRegression!;
    const contaminated = computeFactorAnalysis(control).marketRegression!;
    // The fake-return pair is excluded, so beta comes back ~1.0 exactly;
    // the contaminated control deviates from 1.0.
    expect(seamAware.beta).toBeCloseTo(1.0, 2);
    expect(Math.abs(contaminated.beta - 1.0)).toBeGreaterThan(0.05);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/factors-flow-adjusted.test.ts`
Expected: FAIL — both scenarios produce the same contaminated beta.

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

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/factors-flow-adjusted.test.ts tests/compute/factors.test.ts tests/compute/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
printf 'feat(risk): market regression excludes seam days from beta pairs\n' > /tmp/cmsg.txt
git add lib/compute/factors.ts tests/compute/factors-flow-adjusted.test.ts
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

4. Extend `partitionCandidates` (~line 373) with a third bucket:
   `seamPoints: CashFlowResidualPoint[]` in its return object, filled with
   `classification === "source-seam"` points. **Update the existing
   partition tests in `tests/compute/cash-flow-audit.test.ts`** — any exact
   `toEqual({ externalFlowCandidates: [], internalShifts: [] })` assertion now
   needs `seamPoints: []`, and add one assertion that a `source-seam` point
   lands in `seamPoints` and in NEITHER other bucket.

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

  it("findLegacyRepairRowsOnSeams matches by valuation INTERVAL, not exact date", () => {
    // Weekend anchor: seam dated Sunday 2026-08-31; the account's valuation
    // rows skip the weekend (Fri 08-29 → Mon 09-01), so a legacy repair row
    // dated Mon 09-01 sits in the interval (08-29, 09-01] containing the seam.
    const db = makeDbWithAnchorsAndValuations(); // valuations: ...08-28, 08-29, 09-01, 09-02...
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
       VALUES (1, '2026-09-01', 'DEPOSIT', 88000, 1, 'repair-missing-flow:1:2026-09-01')`
    ).run();
    const flagged = findLegacyRepairRowsOnSeams(db, new Map([[1, ["2026-08-31"]]]));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].source_key).toBe("repair-missing-flow:1:2026-09-01");
  });

  it("flags an exact-date legacy row too (seam date IS a valuation date)", () => {
    const db = makeDbWithAnchorsAndValuations();
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
       VALUES (1, '2026-07-11', 'DEPOSIT', 88000, 1, 'repair-missing-flow:1:2026-07-11')`
    ).run();
    const flagged = findLegacyRepairRowsOnSeams(db, new Map([[1, ["2026-07-11"]]]));
    expect(flagged).toHaveLength(1);
  });

  it("stays silent when no legacy repair rows sit on seams", () => {
    const db = makeDbWithAnchorsAndValuations();
    expect(findLegacyRepairRowsOnSeams(db, new Map([[1, ["2026-07-11"]]]))).toEqual([]);
  });

  it("a seam-shaped point reaches the CLI selection but yields no proposal, even with --amount", () => {
    // Thread a source-seam point through findCandidates/selectRun: the run's
    // insert list must be empty and --amount targeting it must error the same
    // way it errors for any non-candidate date.
    const db = makeDbWithSeamResidual(); // cash jump on the seam day, no txn
    const run = findCandidates(db); // now seam-aware internally
    expect(run.seamPoints.map((p) => p.toDate)).toContain("2026-07-11");
    expect(run.proposals.map((p) => p.trade_date)).not.toContain("2026-07-11");
    expect(() =>
      applyOnlyAndAmountSelection(run, ["2026-07-11"], 88000)
    ).toThrow(/external-flow-candidate/);
  });
});
```

(Match the actual `transactions`/`daily_valuations` DDL and the real helper
names used elsewhere in this test file — the selection helper around
`scripts/repair-missing-external-flows.ts:190` and the candidate-list builder
around line 159 may differ from the names sketched here; read the script and
its existing tests FIRST and use the real exported names. `collectSeamDatesByAccount`
and `findLegacyRepairRowsOnSeams` are new pure exports from the script.)

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

/** Read-only audit: previously applied synthetic flows whose valuation
 *  INTERVAL contains a seam — a past run may have misread a source
 *  transition as a flow. Interval matching, not exact-date: a weekend
 *  anchor's seam date (e.g. a Sunday month-end) has no valuation row of its
 *  own, but the repair row was inserted on the following valuation date
 *  whose interval (prev valuation date, repair date] contains the seam.
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
  const prevValuationStmt = db.prepare(
    `SELECT MAX(valuation_date) AS prev FROM daily_valuations
     WHERE account_id = ? AND valuation_date < ?`
  );
  return rows.filter((r) => {
    const seams = seamsByAccount.get(r.account_id) ?? [];
    if (seams.length === 0) return false;
    const { prev } = prevValuationStmt.get(r.account_id, r.trade_date) as { prev: string | null };
    // Interval (prev, trade_date]; with no prior valuation row, fall back to
    // exact-date membership.
    return seams.some((s) =>
      prev !== null ? s > prev && s <= r.trade_date : s === r.trade_date
    );
  });
}
```

3. Thread seams through the REAL script paths (read them first — names below
   from `scripts/repair-missing-external-flows.ts` ~lines 159–246): the
   candidate-list builder (~line 159) that today calls
   `computeCashFlowResiduals(db, { accountIds })` gains the
   `collectSeamDatesByAccount` call and passes `seamDatesByAccount`; its
   result type (and the selection-run type at ~line 177, whatever it is
   actually named) carries the new `seamPoints` bucket from
   `partitionCandidates` so seam points REACH the CLI layer instead of being
   silently dropped. The `--only`/`--amount` selection helper (~line 190)
   already validates against external-flow-candidates only — verify the new
   class errors there and cover it with the Step-1 test.
4. In `main()`: print `source-seam` points under a distinct heading (mirror
   `printInternalShift`'s shape) with a one-line explanation ("anchor source
   changed — measurement-basis step, not a flow; never synthesized"), and
   print the legacy-row audit section (or a "no legacy repair rows on seams"
   line).

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

Re-run the Task 0 baseline snippet unchanged (it now exercises the new code) and diff against `/Users/Yitzi/.claude/jobs/5470995b/tmp/risk-baseline-before.txt`. Expected: single-account vol drops materially (the fake seam observations leave the stream); `seamDaysBridged` > 0 for windows spanning 2026-07-11 / month-end handoffs; drawdown dates no longer land on seam days where they previously did. **Known caveat (spec §6):** in-kind $0-amount TRANSFER legs (June donation departures, early-August option return) still contaminate — distinct filed defect; do not misattribute or chase here.

- [ ] **Step 4: Browser E2E on the risk UI (repo rule: test as a real user)**

Restart the dev server on :3000 first (server-side code changed — Next caches
aggressively; kill the existing `next dev` by specific PID only, then
`npm run dev`). Then drive a browser (agent-browser subagent / Playwright MCP)
to `/dashboard/analysis?view=diagnostics`: confirm Risk Decomposition renders
(vol/Sharpe/drawdown cards populated, no error state) and note the displayed
vol values match the Step-3 after numbers. Screenshot for the report.

- [ ] **Step 5: Report**

Report suite count, build result, the before/after table, and the E2E
screenshot to the user. Do NOT deploy — Electron rebuild/deploy stays a
user/session-end decision.

## Self-review notes

- Spec coverage: §3.1→Task 1, §3.2→Task 2, §3.3→Tasks 3–4, §3.4→Tasks 5–6, §6 verification→Tasks 0+7. `seamDaysBridged` (§3.3 observability) → Task 3. Legacy audit (§3.4) → Task 6.
- Existing-test compatibility is asserted at every task via the byte-identical default path.
- Type consistency: `fetchAnchorSourceSeamDates` returns `string[]`; `seamDatesByAccount` is `Map<number, string[]>`; `bridgedDays` (function) vs `seamDaysBridged` (metrics field) — intentional rename at the API boundary, defined in Tasks 2 and 3 respectively.
- Codex plan-review round 1 (2026-08-13) folded in: private `computeMarketRegression` → test via `computeFactorAnalysis` in `tests/compute/factors-flow-adjusted.test.ts`; `fakeMetrics` fixture update added to Task 3; fixture DDL for `monthly_snapshots` specified; `partitionCandidates` third bucket + existing-assertion updates; concrete `findCandidates`/selection-run threading + `--amount` coverage; legacy-row audit is interval-based (weekend-anchor test); drawdown-not-on-seam + sub-20-null tests added; Task 0 pre-change baseline replaces stash comparison; Task 7 gains the browser E2E step.
