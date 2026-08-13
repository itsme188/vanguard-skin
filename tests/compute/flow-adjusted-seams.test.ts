import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchAnchorSourceSeamDates, buildFlowAdjustedIndex } from "@/lib/compute/flow-adjusted";

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
