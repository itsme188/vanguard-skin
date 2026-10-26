/**
 * scripts/repair-closed-day-tws-rows.ts (DECISIONS 2026-10-26 item 1):
 * removes IBKR live-sync rows (prices source 'tws', holdings `tws-` keys,
 * monthly_snapshots source 'tws') dated on a closed market day, and nothing
 * else. Synthetic figures only.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { planClosedDayTwsRepair, runClosedDayTwsRepair } from "@/scripts/repair-closed-day-tws-rows";

const FRIDAY = "2026-03-13";
const SATURDAY = "2026-03-14";
const SUNDAY = "2026-03-15";
const MONDAY = "2026-03-16";
const HOLIDAY = "2026-07-03";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
  const other = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Other')").run().lastInsertRowid as number;
  const sec = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZA', 'Stock')").run()
    .lastInsertRowid as number;
  const sec2 = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZB', 'Stock')").run()
    .lastInsertRowid as number;

  const price = (s: number, date: string, source: string) =>
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, ?)").run(s, date, source);
  const holding = (a: number, s: number, date: string, key: string, qty = 5) =>
    db
      .prepare(
        "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, 50, ?, ?)",
      )
      .run(a, s, qty, date, key);
  const snapshot = (a: number, date: string, source: string) =>
    db
      .prepare("INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source) VALUES (?, ?, 100, 10, ?)")
      .run(a, date, source);

  // Trading days: kept whatever the source.
  price(sec, FRIDAY, "tws");
  price(sec, MONDAY, "tws");
  holding(acct, sec, FRIDAY, `tws-${acct}-${sec}-${FRIDAY}`);
  holding(acct, sec, MONDAY, `tws-${acct}-${sec}-${MONDAY}`);
  snapshot(acct, FRIDAY, "tws");

  // Closed days, IBKR live sync: removed.
  price(sec, SATURDAY, "tws");
  price(sec, SUNDAY, "tws");
  price(sec, HOLIDAY, "tws");
  holding(acct, sec, SUNDAY, `tws-${acct}-${sec}-${SUNDAY}`);
  holding(acct, sec, HOLIDAY, `tws-${acct}-${sec}-${HOLIDAY}`);
  snapshot(acct, SUNDAY, "tws");

  // Closed days, other sources: kept.
  price(sec2, SATURDAY, "statement");
  holding(other, sec, SATURDAY, "plaid:zz:1");
  holding(acct, sec2, SUNDAY, `recon:closed-equity:${acct}:${sec2}:${SUNDAY}:live`, 0);
  holding(other, sec2, SUNDAY, "canonical:hold:zz:1");
  snapshot(other, SATURDAY, "plaid");
  snapshot(other, SUNDAY, "ibkr-activity");

  return { db, acct, sec, sec2 };
}

function count(db: Database.Database, sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...p) as { c: number }).c;
}

describe("repair-closed-day-tws-rows", () => {
  it("dry run plans only IBKR live-sync rows on closed days, per table and per date, and writes nothing", () => {
    const { db } = setup();
    const before = count(db, "SELECT COUNT(*) AS c FROM prices");

    const result = runClosedDayTwsRepair(db);
    expect(result.applied).toBe(false);
    expect(result.plan.totals).toEqual({ prices: 3, holdings: 2, snapshots: 1 });
    expect(result.plan.byDate).toEqual([
      { date: SATURDAY, prices: 1, holdings: 0, snapshots: 0 },
      { date: SUNDAY, prices: 1, holdings: 1, snapshots: 1 },
      { date: HOLIDAY, prices: 1, holdings: 1, snapshots: 0 },
    ]);
    expect(result.plan.kept).toEqual({ prices: 1, holdings: 3, snapshots: 2 });
    // The IBKR Sunday is left holding only ZZB's still-newest live tombstone:
    // planned to move to Monday, the next real snapshot.
    expect(result.plan.tombstones.superseded).toEqual([]);
    expect(result.plan.tombstones.blocked).toEqual([]);
    expect(result.plan.tombstones.redate.map((r) => [r.from, r.to])).toEqual([[SUNDAY, MONDAY]]);
    expect(count(db, "SELECT COUNT(*) AS c FROM prices")).toBe(before);
  });

  it("--apply removes exactly the planned rows, rebuilds valuations, and a second dry run finds nothing", () => {
    const { db, acct, sec2 } = setup();
    const result = runClosedDayTwsRepair(db, { apply: true });

    expect(result.applied).toBe(true);
    expect(result.deleted).toEqual({ prices: 3, holdings: 2, snapshots: 1 });
    expect(result.tombstonesRedated).toBe(1);
    expect(result.reconcilerMarked).toBe(0);
    expect(result.valuations).not.toBeNull();
    expect(result.taxGenerationBumped).toBe(false);

    // Trading-day rows intact.
    expect(count(db, "SELECT COUNT(*) AS c FROM prices WHERE date IN (?, ?)", FRIDAY, MONDAY)).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS c FROM holdings WHERE as_of_date IN (?, ?) AND source_key LIKE 'tws-%'", FRIDAY, MONDAY)).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS c FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?", acct, FRIDAY)).toBe(1);
    // Non-TWS closed-day rows intact.
    expect(count(db, "SELECT COUNT(*) AS c FROM prices WHERE source = 'statement'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS c FROM holdings WHERE source_key NOT LIKE 'tws-%'")).toBe(3);
    // The moved tombstone keeps its row and origin, now on Monday.
    expect(
      db.prepare("SELECT as_of_date, source_key, quantity FROM holdings WHERE account_id = ? AND source_key LIKE 'recon:%'").all(acct),
    ).toEqual([{ as_of_date: MONDAY, source_key: `recon:closed-equity:${acct}:${sec2}:${MONDAY}:live`, quantity: 0 }]);
    expect(count(db, "SELECT COUNT(*) AS c FROM monthly_snapshots WHERE source != 'tws'")).toBe(2);

    const again = planClosedDayTwsRepair(db);
    expect(again.totals).toEqual({ prices: 0, holdings: 0, snapshots: 0 });
    expect(again.byDate).toEqual([]);
  });

  it("bumps the tax input generation when a removed price can feed a synthetic close", () => {
    const { db, sec } = setup();
    // A statement-grade zero for ZZA dated after the closed-day prices: the
    // engine prices that close off the latest price at or before it.
    const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 0, 0, '2026-07-31', 'ibkr:pos:zz:flat')",
    ).run(acct, sec);
    const gen = getTaxInputGeneration(db);

    const result = runClosedDayTwsRepair(db, { apply: true });
    expect(result.taxGenerationBumped).toBe(true);
    expect(getTaxInputGeneration(db)).toBeGreaterThan(gen);
  });

  it("a closed date left with only superseded tombstones loses them, so valuations never read a zero-holdings snapshot", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
    const a = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZA', 'Stock')").run().lastInsertRowid as number;
    const b = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZB', 'Stock')").run().lastInsertRowid as number;
    const hold = (s: number, date: string, key: string, qty: number) =>
      db
        .prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, 10, ?, ?)")
        .run(acct, s, qty, date, key);
    for (const d of [FRIDAY, MONDAY]) {
      db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, 'tws')").run(a, d);
      hold(a, d, `tws-${acct}-${a}-${d}`, 5);
    }
    // Friday held ZZB too; Sunday's sync lacked it, so the live pass
    // tombstoned it on Sunday; Monday the owner bought it back.
    hold(b, FRIDAY, `tws-${acct}-${b}-${FRIDAY}`, 3);
    hold(a, SUNDAY, `tws-${acct}-${a}-${SUNDAY}`, 5);
    hold(b, SUNDAY, `recon:closed-equity:${acct}:${b}:${SUNDAY}:live`, 0);
    hold(b, MONDAY, `tws-${acct}-${b}-${MONDAY}`, 3);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, 'statement')").run(a, SUNDAY);

    const plan = planClosedDayTwsRepair(db);
    expect(plan.tombstones.superseded.map((t) => t.date)).toEqual([SUNDAY]);
    expect(plan.tombstones.redate).toEqual([]);

    const result = runClosedDayTwsRepair(db, { apply: true });
    expect(result.tombstonesDeleted).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS c FROM holdings WHERE as_of_date = ?", SUNDAY)).toBe(0);
    // The Sunday valuation (a kept statement price) reads Friday's holdings, not zeros.
    const sunday = db
      .prepare("SELECT holdings_count FROM daily_valuations WHERE account_id = ? AND valuation_date = ?")
      .get(acct, SUNDAY) as { holdings_count: number } | undefined;
    expect(sunday?.holdings_count).toBe(2);
  });

  it("refuses --apply when a tombstone-only closed date holds a statement-pass tombstone", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
    const a = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZA', 'Stock')").run().lastInsertRowid as number;
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 5, ?, ?)").run(
      acct, a, SUNDAY, `tws-${acct}-${a}-${SUNDAY}`,
    );
    const b = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZB', 'Stock')").run().lastInsertRowid as number;
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 0, ?, ?)").run(
      acct, b, SUNDAY, `recon:closed-equity:${acct}:${b}:${SUNDAY}:stmt`,
    );
    expect(planClosedDayTwsRepair(db).tombstones.blocked).toHaveLength(1);
    expect(() => runClosedDayTwsRepair(db, { apply: true })).toThrow(/refusing/);
    expect(count(db, "SELECT COUNT(*) AS c FROM holdings")).toBe(2);
  });

  it("an empty plan applies as a no-op without rebuilding valuations", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const result = runClosedDayTwsRepair(db, { apply: true });
    expect(result.deleted).toEqual({ prices: 0, holdings: 0, snapshots: 0 });
    expect(result.valuations).toBeNull();
  });

  it("prints its database path before opening it and takes REPAIR_DB_PATH or --db", () => {
    const src = readFileSync(path.join(process.cwd(), "scripts", "repair-closed-day-tws-rows.ts"), "utf8");
    expect(src).toContain("REPAIR_DB_PATH");
    expect(src).toContain('"--db"');
    const printed = src.indexOf("db: ${dbPath}`");
    const opened = src.indexOf("new BetterSqlite3(dbPath");
    expect(printed).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(printed);
  });
});
