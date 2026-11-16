/**
 * Review finding S-1 (2026-11-15): the scenario fund cap (a fund that is the
 * subject moves exactly the headline) read `security_type` alone, and the
 * broker labels many exchange-traded funds "Stock" (weak evidence,
 * CLAUDE.md). A 3x long semis fund typed Stock was scaled by its factor
 * buckets first (2.24x the headline) and then by 3, floored at -100%, while
 * its inverse twin typed ETF was capped. A row is a fund when it is typed
 * one, OR the leveraged-fund rule flags it, OR its fund category is a
 * fund-family label (leveraged/inverse or bond).
 *
 * Synthetic symbols; round prices.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeRecipeScenario, findRecipe } from "@/lib/compute/scenario-recipes";
import type { ScenarioResult } from "@/lib/compute/scenarios";
import { todayET } from "@/lib/calendar/date-utils";
import { FACTOR_COLUMNS } from "@/lib/factors";

let db: Database.Database;
let nextId = 1;

function seed(o: {
  symbol: string;
  name: string;
  type: string;
  industry?: string | null;
  fundCategory?: string | null;
  leverage?: number | null;
}): void {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, industry, fund_category, geography, currency, leverage_factor)
     VALUES (?, ?, ?, ?, 'Technology', ?, ?, 'US', 'USD', ?)`,
  ).run(id, o.symbol, o.name, o.type, o.industry ?? null, o.fundCategory ?? null, o.leverage ?? null);
  // Hot buckets: a single name would be scaled well past the headline.
  db.prepare(
    `INSERT INTO security_factors (security_id, ${FACTOR_COLUMNS.join(", ")}) VALUES (?, ${FACTOR_COLUMNS.map(() => "?").join(", ")})`,
  ).run(id, ...FACTOR_COLUMNS.map(() => "Very High"));
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'tws')`).run(id, todayET());
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, ?, 10, ?)`,
  ).run(id, todayET(), `fc-${o.symbol}`);
}

const impact = (r: ScenarioResult, symbol: string) => r.positionImpacts.find((p) => p.symbol === symbol)!;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 1;
});

describe("S-1: a leveraged fund typed Stock is still a fund under the subject cap", () => {
  it("a Stock-typed 3x semis fund moves exactly 3x the headline, like its ETF-typed inverse twin", () => {
    const semis = findRecipe("semi_cycle_minus_15pct")!;
    seed({ symbol: "ZBUL", name: "ZZ DAILY SEMI BULL 3X", type: "Stock", industry: "Semiconductors (3x Leveraged ETF)", leverage: 3 });
    seed({ symbol: "ZBER", name: "ZZ DAILY SEMI BEAR 3X", type: "ETF", industry: "Semiconductors (3x Inverse ETF)", leverage: -3 });
    seed({ symbol: "ZSTK", name: "ZZ Semiconductor Corp", type: "Stock", industry: "Semiconductors" });
    const r = computeRecipeScenario(db, semis);
    expect(impact(r, "ZBUL").changePercent).toBeCloseTo(3 * semis.shockMagnitude, 10);
    expect(impact(r, "ZBER").changePercent).toBeCloseTo(-3 * semis.shockMagnitude, 10);
    // A single semis stock is still scaled past the headline by its buckets.
    expect(impact(r, "ZSTK").changePercent).toBeLessThan(semis.shockMagnitude);
  });

  it("a Stock-typed fund with a leveraged/inverse category is a fund too", () => {
    const semis = findRecipe("semi_cycle_minus_15pct")!;
    seed({ symbol: "ZCAT", name: "ZZ Semis Plus", type: "Stock", industry: "Semiconductors", fundCategory: "Leveraged/Inverse", leverage: 2 });
    const r = computeRecipeScenario(db, semis);
    expect(impact(r, "ZCAT").changePercent).toBeCloseTo(2 * semis.shockMagnitude, 10);
  });
});
