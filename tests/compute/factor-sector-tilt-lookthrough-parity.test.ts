import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
});

function seed(
  symbol: string,
  type: string,
  sector: string | null,
  fundCategory: string | null,
  price: number,
  extra: { style?: string; size?: string; geography?: string } = {}
): number {
  const sid = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, multiplier, sector, fund_category, style, market_cap_category, geography, classification_source)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'test')`
    )
    .run(symbol, symbol, type, sector, fundCategory, extra.style ?? null, extra.size ?? null, extra.geography ?? null)
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (1, ?, 10, '2026-06-01', 'test:' || ?)"
  ).run(sid, sid);
  db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')").run(sid, price);
  return sid;
}

function seedFixture(): void {
  seed("AAA", "ETF", null, null, 100, { style: "Growth", size: "Large Cap", geography: "US" });
  db.prepare("INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('AAA','Information Technology',60,'2026-06-01','test')").run();
  db.prepare("INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('AAA','Financials',40,'2026-06-01','test')").run();
  seed("BBB", "Bond", null, "US Treasury", 10000, { geography: "US" });
  seed("CCC", "Stock", null, "Something", 40, { style: "Value", size: "Small Cap", geography: "US" });
  seed("DDD", "Stock", "Health Care", null, 30, { style: "Growth", size: "Mid Cap", geography: "Europe" });
}

describe("Portfolio Tilts sector bar reads the Breakdown's look-through buckets", () => {
  it("bucket labels and weights match the Breakdown exactly", () => {
    seedFixture();
    const breakdown = getAllocationByDimension(db, "sector");
    const tilt = computeFactorAnalysis(db).sectorTilt;
    expect(tilt).not.toBeNull();
    const tiltMap = new Map(tilt!.buckets.map((b) => [b.label, b.weight]));
    const breakdownMap = new Map(breakdown.map((b) => [b.group_name, b.percentage / 100]));
    expect([...tiltMap.keys()].sort()).toEqual([...breakdownMap.keys()].sort());
    for (const [label, w] of breakdownMap) {
      expect(Math.abs((tiltMap.get(label) ?? NaN) - w)).toBeLessThan(1e-9);
    }
    expect(tiltMap.has("Unclassified")).toBe(false);
    expect(tiltMap.has("Technology")).toBe(true);
    // Same own-sector decision as the Breakdown (sector ?? fund_category):
    // the bond lands where the Breakdown puts it, whatever that label is.
    expect(tiltMap.has(breakdown.find((b) => b.group_name === "US Treasury") ? "US Treasury" : "Fixed Income")).toBe(true);
    expect(tiltMap.has("Information Technology")).toBe(false);
    expect(tiltMap.has("Healthcare") || tiltMap.has("Health Care")).toBe(true);
  });

  it("Size, Style and Geography tilts stay own-security", () => {
    seedFixture();
    const r = computeFactorAnalysis(db);
    // totals: AAA 1000, BBB 1000 (bond price is per 100), CCC 400, DDD 300 => 2700
    const geo = new Map(r.geographyTilt!.buckets.map((b) => [b.label, b.weight]));
    expect(geo.get("US")).toBeCloseTo(2400 / 2700, 9);
    expect(geo.get("Europe")).toBeCloseTo(300 / 2700, 9);
    const style = new Map(r.styleTilt!.buckets.map((b) => [b.label, b.weight]));
    expect(style.get("Growth")).toBeCloseTo(1300 / 2700, 9);
    expect(style.get("Value")).toBeCloseTo(400 / 2700, 9);
    expect(style.get("Unclassified")).toBeCloseTo(1000 / 2700, 9);
    const size = new Map(r.sizeTilt!.buckets.map((b) => [b.label, b.weight]));
    expect(size.get("Unclassified")).toBeCloseTo(1000 / 2700, 9);
  });
});
