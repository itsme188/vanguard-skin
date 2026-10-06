import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS } from "@/lib/compute/scenarios";
import { repriceOptionUnderShock } from "@/lib/compute/option-reprice";
import { putPrice } from "@/lib/compute/options-greeks";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { todayET, addDays } from "@/lib/calendar/date-utils";

/**
 * Spec test 5 (engine parity). The preset engine and the custom engine derive
 * the UNDERLYING's move differently (factor buckets vs beta), so parity is
 * stated per engine: each option row equals the shared repricing function
 * applied to that engine's own move for the underlying. One function, two
 * callers — the defect class of 2026-09-11 (two option rules on one page)
 * cannot return. Synthetic figures only.
 */
let db: Database.Database;
const STOCK = 1;
const PUT = 2;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const today = todayET();
  const expiry = addDays(today, 90);
  db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (?, 'ZZUL', 'Zulu Systems', 'Stock', 'Technology')`).run(STOCK);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'test')`).run(STOCK, today);
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 100, 'h-stock')`).run(STOCK, today);
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, 'ZZUL P95', 'ZZUL put', 'Option', 'ZZUL', 95, ?, 'PUT', 100)`,
  ).run(PUT, expiry);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`).run(
    PUT, today, Number(putPrice(100, 95, 90 / 365, 0.04, 0.35).toFixed(4)),
  );
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, -2, 'h-put')`).run(PUT, today);
});

function optionInputs() {
  return db
    .prepare(
      `SELECT s.strike_price, s.expiration_date, s.option_type,
              (SELECT close_price FROM prices WHERE security_id = s.id) AS own_price,
              100 AS underlying_price, NULL AS underlying_iv
         FROM securities s WHERE s.id = ?`,
    )
    .get(PUT) as Parameters<typeof repriceOptionUnderShock>[0];
}

describe("both scenario engines price an option through the one shared function", () => {
  it("custom engine", () => {
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.3 });
    const stock = res.positionImpacts.find((p) => p.securityId === STOCK)!;
    const put = res.positionImpacts.find((p) => p.securityId === PUT)!;
    // The custom engine gives an option its underlying's beta, so the move
    // it reports for the underlying must equal the stock row's own move.
    expect(put.underlyingMove).toBeCloseTo(stock.changePercent, 12);
    const expected = repriceOptionUnderShock(optionInputs(), { underlyingMove: put.underlyingMove!, riskFreeRate: getRiskFreeRate(db) });
    if (!expected.modelled) throw new Error("fixture must be modelled");
    expect(put.changePercent).toBeCloseTo(expected.changePercent, 10);
    expect(put.estimatedChange).toBeLessThan(0); // short put loses on a drop
  });

  it("every preset", () => {
    for (const preset of PRESET_SCENARIOS) {
      const res = computeScenario(db, preset);
      const put = res.positionImpacts.find((p) => p.securityId === PUT)!;
      // The move the engine itself computed for this contract's underlying
      // (a preset's subject rule can treat the option row and the stock row
      // differently, so the stock row is not a safe stand-in).
      expect(typeof put.underlyingMove, preset.id).toBe("number");
      const expected = repriceOptionUnderShock(optionInputs(), { underlyingMove: put.underlyingMove!, riskFreeRate: getRiskFreeRate(db) });
      if (!expected.modelled) throw new Error("fixture must be modelled");
      expect(put.changePercent, preset.id).toBeCloseTo(expected.changePercent, 10);
      expect(res.estimatedChange, preset.id).toBeCloseTo(res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0), 8);
      expect(res.optionsUnmodelled, preset.id).toEqual({ count: 0, valueShare: 0, unpricedCount: 0 });
    }
  });

  it("a preset and a custom run that reproduce its underlying move price the option identically", () => {
    const optionRow = (r: ReturnType<typeof computeScenario>) => r.positionImpacts.find((p) => p.securityId === PUT)!;
    const custom = (marketMove: number) =>
      computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove });
    // The custom engine's underlying move is marketMove x beta, and its option
    // row reports that move, so the beta falls out of a first run.
    const probe = custom(-0.1);
    const beta = optionRow(probe).underlyingMove! / -0.1;
    const preset = PRESET_SCENARIOS.find((p) => Math.abs(optionRow(computeScenario(db, p)).underlyingMove ?? 0) > 0);
    if (!preset) throw new Error("no preset moves the fixture's underlying");
    const presetRow = optionRow(computeScenario(db, preset));
    const m = presetRow.underlyingMove!;
    const customRow = optionRow(custom(m / beta));
    expect(customRow.underlyingMove!).toBeCloseTo(m, 10);
    expect(customRow.changePercent).toBeCloseTo(presetRow.changePercent, 8);
    expect(customRow.estimatedChange).toBeCloseTo(presetRow.estimatedChange, 8);
  });
});
