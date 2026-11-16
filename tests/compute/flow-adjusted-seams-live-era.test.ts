/**
 * Seam rule for the live era (2026-11-15 fix).
 *
 * monthly_snapshots now holds near-daily LIVE rows (plaid, tws) with a
 * statement row at every month-end in between. The old writer-identity rule
 * flagged every month-end AND the day after as a seam, and bridging those
 * days erased real market returns (the daily index stopped agreeing with the
 * statement month). A live row that sits between two statement rows is on the
 * statement basis by construction (the statement on each side pins the
 * series), so it is never a seam. Only an UNBRACKETED hand-off is: the first
 * live row after the account's last statement (go-live tail), the first
 * statement after leading live rows (head), or a change of statement source
 * whose opening value does not join the previous statement's closing value.
 *
 * Migrated schema; synthetic values.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  buildFlowAdjustedIndex,
  fetchAnchorSourceSeamDates,
  fetchAnchorSourceTransitionDates,
} from "@/lib/compute/flow-adjusted";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.exec(`INSERT OR IGNORE INTO accounts (id, name)
           VALUES (1, 'Acct A'), (2, 'Acct B')`);
  return db;
}

function anchor(
  db: Database.Database,
  accountId: number,
  date: string,
  source: string | null,
  total = 100_000,
  startingValue: number | null = null
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, starting_value)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, date, total, source, startingValue);
}

const ALL = ["0000-00-00", "9999-12-31"] as const;

describe("fetchAnchorSourceSeamDates — live era", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("a statement row sitting between live rows on both sides is NOT a seam", () => {
    anchor(db, 1, "2026-06-30", "canonical");
    anchor(db, 1, "2026-07-29", "plaid");
    anchor(db, 1, "2026-07-30", "plaid");
    anchor(db, 1, "2026-07-31", "canonical");
    anchor(db, 1, "2026-08-03", "plaid");
    anchor(db, 1, "2026-08-31", "canonical");
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual([]);
  });

  it("monthly live/statement round trips produce no seams; only the tail after the last statement is one", () => {
    anchor(db, 1, "2026-03-31", "canonical");
    for (const [d, s] of [
      ["2026-04-06", "tws"],
      ["2026-04-30", "ibkr-activity"],
      ["2026-05-01", "tws"],
      ["2026-05-31", "ibkr-activity"],
      ["2026-06-01", "tws"],
      ["2026-06-30", "ibkr-activity"],
      ["2026-07-01", "tws"],
      ["2026-07-02", "tws"],
    ] as const) {
      anchor(db, 1, d, s, 100_000, s === "ibkr-activity" ? 100_000 : null);
    }
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual(["2026-07-01"]);
  });

  it("a real one-off go-live hand-off (statement to live, no later statement) is still a seam", () => {
    anchor(db, 1, "2026-06-30", "canonical");
    anchor(db, 1, "2026-07-11", "plaid");
    anchor(db, 1, "2026-07-13", "plaid");
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual(["2026-07-11"]);
  });

  it("the go-live stops being a seam once a later statement brackets it", () => {
    anchor(db, 1, "2026-06-30", "canonical");
    anchor(db, 1, "2026-07-11", "plaid");
    anchor(db, 1, "2026-07-31", "canonical");
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual([]);
  });

  it("the tail is judged on the whole history, not the query window", () => {
    anchor(db, 1, "2026-06-30", "canonical");
    anchor(db, 1, "2026-07-11", "plaid");
    anchor(db, 1, "2026-07-31", "canonical");
    // A window ending before the bracketing statement still sees no seam:
    // the answer for a past date does not depend on where the window ends.
    expect(fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-07-15")).toEqual([]);
  });

  it("leading live rows hand off to the first statement with a seam (head)", () => {
    anchor(db, 1, "2026-06-10", "tws");
    anchor(db, 1, "2026-06-11", "tws");
    anchor(db, 1, "2026-06-30", "ibkr-activity");
    anchor(db, 1, "2026-07-31", "ibkr-activity");
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual(["2026-06-30"]);
  });

  it("a live-only account has no seams", () => {
    anchor(db, 1, "2026-07-11", "plaid");
    anchor(db, 1, "2026-07-13", "plaid");
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual([]);
  });

  it("a statement source change whose opening value joins the prior close is NOT a seam", () => {
    anchor(db, 1, "2026-03-31", "canonical", 100_000);
    anchor(db, 1, "2026-04-30", "ibkr-activity", 103_000, 100_000);
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual([]);
  });

  it("a statement source change that does not join the prior close IS a seam", () => {
    anchor(db, 1, "2026-03-31", "canonical", 100_000);
    anchor(db, 1, "2026-04-30", "ibkr-activity", 103_000, 101_500);
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual(["2026-04-30"]);
  });

  it("a statement source change with no reported opening value is a seam (conservative)", () => {
    anchor(db, 1, "2026-03-31", "canonical", 100_000);
    anchor(db, 1, "2026-04-30", "ibkr-activity", 103_000, null);
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual(["2026-04-30"]);
  });

  it("a statement source change across live rows is compared statement to statement", () => {
    anchor(db, 1, "2026-03-31", "canonical", 100_000);
    anchor(db, 1, "2026-04-06", "tws", 101_000);
    anchor(db, 1, "2026-04-30", "ibkr-activity", 103_000, 99_000);
    anchor(db, 1, "2026-05-01", "tws", 103_100);
    anchor(db, 1, "2026-05-31", "ibkr-activity", 104_000, 103_000);
    expect(fetchAnchorSourceSeamDates(db, [1], ...ALL)).toEqual(["2026-04-30"]);
  });

  it("an empty account list reads nothing; undefined reads every account", () => {
    anchor(db, 1, "2026-06-30", "canonical");
    anchor(db, 1, "2026-07-11", "plaid");
    anchor(db, 2, "2026-06-30", "canonical");
    anchor(db, 2, "2026-07-13", "tws");
    expect(fetchAnchorSourceSeamDates(db, [], ...ALL)).toEqual([]);
    expect(fetchAnchorSourceSeamDates(db, undefined, ...ALL)).toEqual(["2026-07-11", "2026-07-13"]);
    expect(fetchAnchorSourceSeamDates(db, [2], ...ALL)).toEqual(["2026-07-13"]);
  });

  it("returns [] when monthly_snapshots does not exist", () => {
    const bare = new Database(":memory:");
    expect(fetchAnchorSourceSeamDates(bare, [1], ...ALL)).toEqual([]);
  });

  it("keeps the daily index in step with the statement month (no bridged market move)", () => {
    // Statement month 100_000 -> 103_000 with live rows between. Live Friday
    // 102_000 -> statement month-end 103_000 is a real market day. With no
    // seam, the index over the month equals the statement ratio exactly.
    anchor(db, 1, "2026-06-30", "canonical", 100_000);
    anchor(db, 1, "2026-07-30", "plaid", 102_000);
    anchor(db, 1, "2026-07-31", "canonical", 103_000, 100_000);
    anchor(db, 1, "2026-08-03", "plaid", 103_500);
    const series = [
      { date: "2026-06-30", value: 100_000 },
      { date: "2026-07-30", value: 102_000 },
      { date: "2026-07-31", value: 103_000 },
    ];
    const seams = fetchAnchorSourceSeamDates(db, [1], "2026-06-30", "2026-07-31");
    const { index, bridgedDays } = buildFlowAdjustedIndex(series, [], seams);
    expect(bridgedDays).toBe(0);
    expect(index[index.length - 1].value).toBeCloseTo(1.03, 12);
  });
});

describe("fetchAnchorSourceTransitionDates — the old writer-identity rule, kept for cash audits", () => {
  it("still reports every live/statement round trip", () => {
    const db = makeDb();
    anchor(db, 1, "2026-06-30", "canonical");
    anchor(db, 1, "2026-07-30", "plaid");
    anchor(db, 1, "2026-07-31", "canonical");
    anchor(db, 1, "2026-08-03", "plaid");
    anchor(db, 2, "2026-06-30", null);
    anchor(db, 2, "2026-07-31", "canonical");
    expect(fetchAnchorSourceTransitionDates(db, undefined, ...ALL)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-03",
    ]);
    expect(fetchAnchorSourceTransitionDates(db, [1], "2026-07-30", "2026-07-31")).toEqual(["2026-07-31"]);
    expect(fetchAnchorSourceTransitionDates(db, [], ...ALL)).toEqual([]);
    expect(fetchAnchorSourceTransitionDates(new Database(":memory:"), [1], ...ALL)).toEqual([]);
  });
});
