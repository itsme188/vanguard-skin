import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { planZeroOhlcvBarRepair, runZeroOhlcvBarRepair } from "@/scripts/repair-zero-ohlcv-bars";

function seedSecurity(db: Database.Database, symbol: string): number {
  return db.prepare("INSERT INTO securities (symbol) VALUES (?)").run(symbol).lastInsertRowid as number;
}

function bar(db: Database.Database, securityId: number, date: string, o: number, h: number, l: number, c: number, v = 0) {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, ?)`,
  ).run(securityId, date, o, h, l, c, v);
}

describe("repair-zero-ohlcv-bars", () => {
  it("plans and deletes only bars the current write guard would reject", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const aaa = seedSecurity(db, "ZZAA");
    const bbb = seedSecurity(db, "ZZBB");
    bar(db, aaa, "2026-01-02", 10, 11, 9, 10, 0);
    bar(db, aaa, "2026-01-03", 10, 11, 0, 10, 100);
    bar(db, aaa, "2026-01-04", 10, 9, 11, 10, 100);
    bar(db, bbb, "2026-01-05", 0, 11, 9, 10, 100);

    const plan = planZeroOhlcvBarRepair(db);
    expect(plan.rejectedRows).toBe(3);
    expect(plan.bySecurity).toEqual([
      { securityId: aaa, symbol: "ZZAA", count: 2 },
      { securityId: bbb, symbol: "ZZBB", count: 1 },
    ]);

    expect(() => runZeroOhlcvBarRepair(db, { apply: true })).toThrow(/--acknowledge-repair/);

    const result = runZeroOhlcvBarRepair(db, { apply: true, acknowledgeRepair: true });
    expect(result.deleted).toBe(3);
    expect(planZeroOhlcvBarRepair(db).rejectedRows).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ohlcv_bars").get() as { n: number }).n).toBe(1);
    expect(runZeroOhlcvBarRepair(db, { apply: true, acknowledgeRepair: true }).deleted).toBe(0);
  });
});
