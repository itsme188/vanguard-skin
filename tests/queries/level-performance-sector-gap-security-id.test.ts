/**
 * getSectorEtfGaps returned no security id, so the Data Health page could
 * not link the symbol. The id is looked up case-insensitively and must never
 * repeat a row or inflate its count.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSectorEtfGaps } from "@/lib/queries/level-performance";

let db: Database.Database;

function seedSecurity(id: number, symbol: string) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, asset_class, multiplier)
     VALUES (?, ?, ?, 'stock', 'equity', 1)`,
  ).run(id, symbol, `${symbol} Corp`);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getSectorEtfGaps securityId", () => {
  it("is the matching security's id, compared case-insensitively, else null", () => {
    seedSecurity(11, "aaa");
    db.prepare(`INSERT INTO sector_etf_gaps (symbol, sector, count) VALUES ('AAA', 'X', 2)`).run();
    db.prepare(`INSERT INTO sector_etf_gaps (symbol, sector, count) VALUES ('ZZZ', 'Y', 1)`).run();

    const rows = getSectorEtfGaps(db);
    expect(rows.find((r) => r.symbol === "AAA")?.securityId).toBe(11);
    expect(rows.find((r) => r.symbol === "ZZZ")?.securityId).toBeNull();
  });

  it("returns one row with the true count when two securities differ only by case", () => {
    seedSecurity(21, "aaa");
    seedSecurity(22, "AAA");
    seedSecurity(23, "Aaa");
    const ins = db.prepare(
      `INSERT INTO sector_etf_gaps (symbol, sector, count, first_seen_at, last_seen_at)
       VALUES ('AAA', null, 1, ?, ?)`,
    );
    ins.run("2026-04-20 10:00:00", "2026-04-20 10:00:00");
    ins.run("2026-04-21 10:00:00", "2026-04-21 10:00:00");

    const rows = getSectorEtfGaps(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    // the exact-case security wins
    expect(rows[0].securityId).toBe(22);
  });
});
