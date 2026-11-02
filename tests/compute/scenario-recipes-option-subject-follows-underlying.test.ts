/**
 * Subject membership of an OPTION follows its underlying. The position query
 * read COALESCE(s.fund_category, s_u.fund_category), so once Auto-Classify
 * stamped an option row with its own 'Options' category the underlying's
 * semiconductor category was hidden and every put on the semis ETF took the
 * non-subject floor instead of the subject shock; two puts on one underlying
 * could take two different underlying moves in one scenario (QA
 * dashboard-analysis-view-diagnostics-...-semi-15-preset-...).
 * Synthetic symbols; prices are round numbers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeRecipeScenario, findRecipe } from "@/lib/compute/scenario-recipes";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const d = todayET();
  // The semis ETF itself: fund category names semiconductors.
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, fund_category, geography, currency)
     VALUES (300, 'ZSMH', 'ETF', 'Technology', 'US Sector Equity (Semiconductors)', 'US', 'USD')`
  ).run();
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (300, ?, 100, 'tws')`).run(d);
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 300, '2026-04-30', 10, 'h-zsmh')`).run();
  const expiry = new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Two puts on it: one stamped 'Options' by Auto-Classify, one unstamped.
  for (const [id, sym, cat] of [
    [301, "ZSMH  270115P00090000", "Options"],
    [302, "ZSMH  270115P00085000", null],
  ] as const) {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier, fund_category, currency)
       VALUES (?, ?, 'Option', 'ZSMH', ?, ?, 'PUT', 100, ?, 'USD')`
    ).run(id, sym, id === 301 ? 90 : 85, expiry, cat);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'tws')`).run(id, d);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, '2026-04-30', 1, ?)`).run(id, `h-${id}`);
  }
});

describe("semi_cycle_minus_15pct — a put on the semis ETF is a subject whatever its own category says", () => {
  it("both puts take the ETF's own move as their underlying move, with full subject share", () => {
    const result = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    const etf = result.positionImpacts.find((p) => p.symbol === "ZSMH")!;
    const stamped = result.positionImpacts.find((p) => p.symbol === "ZSMH  270115P00090000")!;
    const plain = result.positionImpacts.find((p) => p.symbol === "ZSMH  270115P00085000")!;
    expect(etf.changePercent).toBeCloseTo(-0.15, 4);
    expect(etf.subjectShare ?? 0).toBe(1);
    for (const put of [stamped, plain]) {
      expect(put.underlyingMove).toBeCloseTo(etf.changePercent, 6);
      expect(put.subjectShare ?? 0).toBe(1);
      expect(put.changePercent).toBeGreaterThan(0);
    }
    expect(stamped.underlyingMove).toBeCloseTo(plain.underlyingMove!, 10);
  });
});
