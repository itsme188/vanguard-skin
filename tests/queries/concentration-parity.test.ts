import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getConcentrationMetrics } from "@/lib/queries/analysis";
import { computeConcentration } from "@/lib/compute/risk";
import { interpretHHI } from "@/lib/analysis/interpret";
import { getConcentrationUniverse } from "@/lib/queries/concentration-universe";

/**
 * qa: analysis-diagnostics--two-herfindahl-values-same-page-regression-3
 *
 * Analysis · Diagnostics prints the Herfindahl twice — once in the
 * "Concentration Metrics" card (getConcentrationMetrics) and once in the
 * Risk Decomposition "Position Concentration" block (computeConcentration,
 * served by GET /api/compute/risk). They used to be two independent
 * computations over two DIFFERENT position universes:
 *
 *   - Concentration Metrics: latest holdings incl. shorts, matured
 *     securities dropped, an unpriced position carried at its cost basis.
 *   - Risk Decomposition: priced positions only (COALESCE(close_price,0) > 0),
 *     longs only, no maturity filter.
 *
 * Different universes -> different HHI -> the two "Behaves like ~N equal
 * positions" sentences disagreed on the same page, and no amount of rounding
 * discipline could reconcile them. Both now read ONE universe
 * (getConcentrationUniverse), so the two figures are equal by construction.
 *
 * All figures below are synthetic round numbers.
 */

let db: Database.Database;
let acctA: number;
let acctB: number;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(
  symbol: string,
  opts: { security_type?: string; maturity_date?: string } = {}
): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier, maturity_date) VALUES (?, ?, ?, 1, ?)"
    )
    .run(symbol, `${symbol} Test Issuer`, opts.security_type ?? "Stock", opts.maturity_date ?? null)
    .lastInsertRowid as number;
}

function seedHolding(
  accountId: number,
  securityId: number,
  quantity: number,
  costBasis: number | null
) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-03-02')"
  ).run(accountId, securityId, quantity, costBasis);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-03-02', 'test')"
  ).run(securityId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  acctA = seedAccount("Parity Account A");
  acctB = seedAccount("Parity Account B");

  // ALFA — one security held across BOTH accounts: 100sh + 50sh @ $40 = $6,000.
  const alfa = seedSecurity("ALFA");
  seedHolding(acctA, alfa, 100, 3_600);
  seedHolding(acctB, alfa, 50, 1_800);
  seedPrice(alfa, 40);

  // BETA — plain single-account long: 200sh @ $15 = $3,000.
  const beta = seedSecurity("BETA");
  seedHolding(acctA, beta, 200, 2_800);
  seedPrice(beta, 15);

  // GAMA — UNPRICED (no prices row at all). We still hold it, so the
  // concentration universe carries it at cost basis: $2,500.
  const gama = seedSecurity("GAMA");
  seedHolding(acctA, gama, 100, 2_500);

  // DELT — a MATURED bond still sitting in the holdings table. Neither card
  // may count it: the position no longer exists.
  const delt = seedSecurity("DELT", { security_type: "Bond", maturity_date: "2020-06-30" });
  seedHolding(acctA, delt, 5_000, 4_900);
  seedPrice(delt, 99);

  // EPSI — a SHORT: -100sh @ $8 = -$800 (user ruling 2026-07-28: the
  // allocation/concentration universe includes shorts).
  const epsi = seedSecurity("EPSI");
  seedHolding(acctA, epsi, -100, -700);
  seedPrice(epsi, 8);
});

describe("Herfindahl parity: Concentration Metrics vs Risk Decomposition", () => {
  it("both cards report the SAME Herfindahl, to the last bit", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    expect(risk.herfindahl).not.toBeNull();
    expect(metrics.hhi).toBe(risk.herfindahl);
  });

  it("both cards render the SAME 'Behaves like ~N equal positions' sentence", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    // The Concentration card passes its one-decimal effective_positions
    // alongside the HHI (ClassificationCard.tsx); Risk Decomposition passes
    // the HHI alone (RiskMetrics.tsx). Both must land on the same integer.
    const cardText = interpretHHI(metrics.hhi, metrics.effective_positions).text;
    const riskText = interpretHHI(risk.herfindahl!).text;
    expect(cardText).toBe(riskText);
    expect(cardText).toContain("equal positions");
  });

  it("the shared universe carries the unpriced position and drops the matured one", () => {
    const universe = getConcentrationUniverse(db);
    const symbols = universe.map((p) => p.symbol);

    expect(symbols).toContain("GAMA"); // unpriced, carried at cost basis
    expect(symbols).toContain("EPSI"); // short
    expect(symbols).not.toContain("DELT"); // matured

    const gama = universe.find((p) => p.symbol === "GAMA")!;
    expect(gama.marketValue).toBe(2_500);
    expect(gama.priced).toBe(false);

    // ALFA is ONE position at its combined cross-account value.
    const alfa = universe.filter((p) => p.symbol === "ALFA");
    expect(alfa).toHaveLength(1);
    expect(alfa[0].marketValue).toBe(6_000);
    expect(alfa[0].priced).toBe(true);
  });

  it("position counts agree: the unpriced holding is a position on both cards", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    // ALFA + BETA + GAMA + EPSI = 4 (DELT matured out).
    expect(risk.positionCount).toBe(4);
    expect(metrics.top_positions.length).toBe(risk.positionCount);
  });

  it("top-5 share agrees between the two cards", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    const cardTop5 = metrics.top_positions
      .slice(0, 5)
      .reduce((s, p) => s + p.weight_pct / 100, 0);
    expect(risk.top5Concentration).toBeCloseTo(cardTop5, 12);
    expect(risk.top5Positions.map((p) => p.symbol)).toEqual(
      metrics.top_positions.slice(0, 5).map((p) => p.symbol)
    );
  });

  it("parity holds under an account scope, across the full account set", () => {
    for (const scope of [[acctA], [acctB], [acctA, acctB]]) {
      const metrics = getConcentrationMetrics(db, scope);
      const risk = computeConcentration(db, scope);
      expect(metrics.hhi).toBe(risk.herfindahl);
      expect(interpretHHI(metrics.hhi, metrics.effective_positions).text).toBe(
        interpretHHI(risk.herfindahl!).text
      );
    }
  });

  it("an empty scope degrades to 'no measurement' on both cards", () => {
    const empty = seedAccount("Parity Empty Account");
    const metrics = getConcentrationMetrics(db, [empty]);
    const risk = computeConcentration(db, [empty]);

    expect(metrics.hhi).toBe(0);
    expect(metrics.effective_positions).toBe(0);
    expect(risk.herfindahl).toBeNull();
    expect(risk.positionCount).toBe(0);
    // Neither surface prints an effective-position count.
    expect(interpretHHI(metrics.hhi).text).not.toContain("equal positions");
  });
});
