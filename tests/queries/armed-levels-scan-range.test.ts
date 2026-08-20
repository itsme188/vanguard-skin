/**
 * Regression pin (qa:levels-suggestions--accept-arms-level-beyond-plausibility-
 * scan-range-regression-2): an armed level more than 50% from spot is never
 * evaluated by the scanner, yet the Armed view listed it as live coverage
 * ("171.2% away") with no disclosure. getArmedLevels now labels each row with
 * the scanner's own predicate so the UI can say "outside scan range" instead
 * of implying monitoring.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getArmedLevels } from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, securityType = "stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`, securityType).lastInsertRowid as number;
}

function seedPrice(securityId: number, price: number, date = "2026-06-15"): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')",
  ).run(securityId, date, price);
}

function armedFor(symbol: string) {
  const row = getArmedLevels(db).find((l) => l.symbol === symbol);
  if (!row) throw new Error(`no armed level for ${symbol}`);
  return row;
}

describe("getArmedLevels beyond_scan_range", () => {
  it("flags an armed level the scanner permanently skips", () => {
    const sec = seedSecurity("FARQA");
    seedPrice(sec, 100);
    upsertLevel(db, { security_id: sec, level_type: "resistance", price: 300 });

    const row = armedFor("FARQA");
    // |100 - 300| / 300 = 66.7% — the scanner logs "Skipping implausible level".
    expect(row.beyond_scan_range).toBe(true);
  });

  it("does not flag a level inside the band", () => {
    const sec = seedSecurity("NEARQA");
    seedPrice(sec, 100);
    upsertLevel(db, { security_id: sec, level_type: "support", price: 90 });

    expect(armedFor("NEARQA").beyond_scan_range).toBe(false);
  });

  it("never flags an option level — the scanner exempts them", () => {
    const sec = seedSecurity("OPTQA", "option");
    seedPrice(sec, 100);
    upsertLevel(db, { security_id: sec, level_type: "exit", price: 300 });

    expect(armedFor("OPTQA").beyond_scan_range).toBe(false);
  });

  it("does not flag when there is no current price to judge against", () => {
    const sec = seedSecurity("NOPRICEQA");
    upsertLevel(db, { security_id: sec, level_type: "entry", price: 300 });

    const row = armedFor("NOPRICEQA");
    expect(row.current_price).toBeNull();
    expect(row.beyond_scan_range).toBe(false);
  });
});
