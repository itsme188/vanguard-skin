import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataHealthSummary, getAccountCoverage } from "@/lib/queries/data-health";
import { getDataConfidence, PRICE_FRESHNESS_DAYS } from "@/lib/queries/data-confidence";

// 2026-08-21 is a Friday; 2026-08-24 is the following Monday.
const FRI = new Date("2026-08-21T16:00:00Z");
const MON = new Date("2026-08-24T16:00:00Z");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seed(symbol: string, priceDate: string | null): void {
  const sec = Number(
    db
      .prepare("INSERT INTO securities (symbol, security_type, source_key) VALUES (?, 'Stock', ?)")
      .run(symbol, `t:${symbol}`).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, '2026-08-20', 10, ?)",
  ).run(sec, `canonical:hold:TAX:${symbol}:2026-08-20`);
  if (priceDate) {
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 100)").run(sec, priceDate);
  }
}

describe("one price-freshness window (D1)", () => {
  it("the window is 3 days", () => {
    expect(PRICE_FRESHNESS_DAYS).toBe(3);
  });

  it("Data Health and the confidence chip count the same priced securities", () => {
    seed("ZZA", "2026-08-21"); // 0 days
    seed("ZZB", "2026-08-19"); // 2 days
    seed("ZZC", "2026-08-18"); // 3 days: the edge, fresh
    seed("ZZD", "2026-08-17"); // 4 days: stale
    seed("ZZE", "2026-08-12"); // 9 days: stale under both (was fresh at <= 7? no, 9) 
    seed("ZZF", "2026-08-15"); // 6 days: fresh under the old 7-day rule only
    seed("ZZG", null);

    const health = getDataHealthSummary(db, FRI);
    const conf = getDataConfidence(db, FRI).priceFreshness;
    expect(health.totalSecurities).toBe(7);
    expect(health.securitiesWithPrices).toBe(3);
    expect(conf.pricedRecent).toBe(health.securitiesWithPrices);
  });

  it("boundary: exactly 3 days is priced, 4 days is not, on both surfaces", () => {
    seed("ZZA", "2026-08-18");
    seed("ZZB", "2026-08-17");
    expect(getDataHealthSummary(db, FRI).securitiesWithPrices).toBe(1);
    expect(getDataConfidence(db, FRI).priceFreshness.pricedRecent).toBe(1);
  });

  it("Friday prices stay fresh on Monday on both surfaces (weekend is not stale)", () => {
    seed("ZZA", "2026-08-21");
    seed("ZZB", "2026-08-21");
    expect(getDataHealthSummary(db, MON).securitiesWithPrices).toBe(2);
    expect(getDataConfidence(db, MON).priceFreshness.pricedRecent).toBe(2);
  });

  it("account coverage uses the same window", () => {
    seed("ZZA", "2026-08-18"); // 3 days
    seed("ZZB", "2026-08-15"); // 6 days
    const row = getAccountCoverage(db, FRI).find((r) => r.totalHoldings > 0);
    expect(row?.pricedHoldings).toBe(1);
  });

  it("the Data Health card names the window", () => {
    const health = getDataHealthSummary(db, FRI);
    expect(health.priceWindowDays).toBe(3);
  });
});
