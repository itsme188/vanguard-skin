import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurityQuote } from "@/lib/mutations/security-quotes";
import { getSecurityQuote } from "@/lib/queries/security-quotes";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, 'Stock', 'equity')",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

describe("upsertSecurityQuote / getSecurityQuote", () => {
  it("inserts a new quote and reads it back", () => {
    const id = seedSecurity("AAPL");
    upsertSecurityQuote(db, {
      securityId: id,
      asOfDate: "2026-06-08",
      ivUnderlying: 0.2441,
      hv30d: 0.2322,
      week52High: 316.94,
      week52Low: 194.47,
      dividendYield: null,
    });

    const q = getSecurityQuote(db, id);
    expect(q).not.toBeNull();
    expect(q!.iv_underlying).toBeCloseTo(0.2441, 4);
    expect(q!.hv_30d).toBeCloseTo(0.2322, 4);
    expect(q!.week52_high).toBe(316.94);
    expect(q!.week52_low).toBe(194.47);
    expect(q!.dividend_yield).toBeNull();
    expect(q!.as_of_date).toBe("2026-06-08");
  });

  it("upserts in place (latest snapshot wins, single row per security)", () => {
    const id = seedSecurity("AAPL");
    upsertSecurityQuote(db, {
      securityId: id,
      asOfDate: "2026-06-08",
      ivUnderlying: 0.24,
      hv30d: 0.23,
      week52High: 316.94,
      week52Low: 194.47,
      dividendYield: null,
    });
    upsertSecurityQuote(db, {
      securityId: id,
      asOfDate: "2026-06-09",
      ivUnderlying: 0.31, // vol popped
      hv30d: 0.25,
      week52High: 318.0,
      week52Low: 194.47,
      dividendYield: 0.34,
    });

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM security_quotes WHERE security_id = ?")
      .get(id) as { c: number };
    expect(count.c).toBe(1);

    const q = getSecurityQuote(db, id);
    expect(q!.as_of_date).toBe("2026-06-09");
    expect(q!.iv_underlying).toBeCloseTo(0.31, 4);
    expect(q!.dividend_yield).toBeCloseTo(0.34, 4);
  });

  it("returns null when no quote exists", () => {
    const id = seedSecurity("MSFT");
    expect(getSecurityQuote(db, id)).toBeNull();
  });

  it("tolerates partial data (null vol fields)", () => {
    const id = seedSecurity("VTI");
    upsertSecurityQuote(db, {
      securityId: id,
      asOfDate: "2026-06-08",
      ivUnderlying: null, // ETF with no listed-option IV
      hv30d: 0.12,
      week52High: 300,
      week52Low: 250,
      dividendYield: null,
    });
    const q = getSecurityQuote(db, id);
    expect(q!.iv_underlying).toBeNull();
    expect(q!.hv_30d).toBeCloseTo(0.12, 4);
  });
});
