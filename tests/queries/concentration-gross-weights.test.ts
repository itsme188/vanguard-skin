/**
 * User ruling, decision 2026-09-22: the Herfindahl is measured over GROSS
 * position weights.
 *
 * Before this ruling both concentration surfaces divided a SIGNED market
 * value by a SIGNED book total:
 *
 *   w_i = mv_i / Σ mv_j
 *
 * A short is negative on both sides of that fraction, so it adds w² to the
 * index AND shrinks the denominator every other weight is taken against. The
 * index is then unbounded above 1 and the derived readouts go nonsensical:
 * a long 100 / short −60 book produced weights 2.5 and −1.5, an HHI of 8.5,
 * a "behaves like ~0 equal positions" sentence and a ">5% of portfolio"
 * warning printing 250%.
 *
 * Gross weighting is the standard Herfindahl convention for a book that can
 * hold both directions:
 *
 *   w_i = |mv_i| / Σ |mv_j|      →   HHI ∈ (0, 1]
 *
 * The SIGN stays visible wherever the surface shows the market value itself
 * (a short is still worth negative dollars); only the WEIGHT is gross.
 *
 * All figures here are synthetic round numbers on synthetic tickers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getConcentrationMetrics } from "@/lib/queries/analysis";
import { computeConcentration } from "@/lib/compute/risk";
import { effectivePositionsFromHHI, interpretHHI } from "@/lib/analysis/interpret";
import {
  getConcentrationUniverse,
  concentrationGrossValue,
} from "@/lib/queries/concentration-universe";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }
  ).id;
}

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, 'Stock', 1)"
    )
    .run(symbol, `${symbol} Test Issuer`).lastInsertRowid as number;
}

/** Seed one whole position worth `quantity * price` (negative = short). */
function seedPosition(accountId: number, symbol: string, quantity: number, price: number) {
  const id = seedSecurity(symbol);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-03-02')"
  ).run(accountId, id, quantity, quantity * price);
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-03-02', 'test')"
  ).run(id, price);
  return id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

/**
 * Fixture A — hand-derived.
 *
 *   ALFA  +100 sh @ $50 = +$5,000
 *   BETA  +100 sh @ $30 = +$3,000
 *   EPSI  −100 sh @ $20 = −$2,000
 *
 *   gross total = 5,000 + 3,000 + 2,000 = 10,000
 *   weights     = 0.5, 0.3, 0.2
 *   HHI         = 0.25 + 0.09 + 0.04 = 0.38
 *   effective   = 1 / 0.38 = 2.6316  (card field rounds to 2.6)
 *
 * Under the old signed denominator the same book gave total 6,000, weights
 * 0.8333 / 0.5 / −0.3333 and an HHI of 1.0556 — above 1, i.e. "less than one
 * equal position".
 */
describe("Herfindahl over gross weights: a long/long/short book", () => {
  let acct: number;

  beforeEach(() => {
    acct = seedAccount("Gross Weights Account");
    seedPosition(acct, "ALFA", 100, 50);
    seedPosition(acct, "BETA", 100, 30);
    seedPosition(acct, "EPSI", -100, 20);
  });

  it("the gross total is the sum of ABSOLUTE position values", () => {
    const universe = getConcentrationUniverse(db);
    expect(concentrationGrossValue(universe)).toBeCloseTo(10_000, 9);
    // The signed book is smaller — that is exactly why it cannot be the
    // weight denominator.
    expect(universe.reduce((s, p) => s + p.marketValue, 0)).toBeCloseTo(6_000, 9);
  });

  it("the Concentration Metrics card reports HHI 0.38 and ~2.63 effective positions", () => {
    const metrics = getConcentrationMetrics(db);

    expect(metrics.hhi).toBeCloseTo(0.38, 12);
    expect(effectivePositionsFromHHI(metrics.hhi)).toBeCloseTo(2.6316, 4);
    // The card's own field carries one decimal.
    expect(metrics.effective_positions).toBe(2.6);
    // Pre-ruling value, for the record: signed weights gave 1.0556.
    expect(metrics.hhi).not.toBeCloseTo(1.0556, 3);
  });

  it("the Risk Decomposition card reports the identical Herfindahl", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    expect(risk.herfindahl).toBe(metrics.hhi);
    expect(interpretHHI(metrics.hhi).text).toBe(interpretHHI(risk.herfindahl!).text);
  });

  it("every published weight is gross, while the market value keeps its sign", () => {
    const risk = computeConcentration(db);
    const bySymbol = new Map(risk.top5Positions.map((p) => [p.symbol, p]));

    expect(bySymbol.get("ALFA")!.weight).toBeCloseTo(0.5, 12);
    expect(bySymbol.get("BETA")!.weight).toBeCloseTo(0.3, 12);
    expect(bySymbol.get("EPSI")!.weight).toBeCloseTo(0.2, 12);

    // The short is still worth negative dollars — only the WEIGHT is gross.
    expect(bySymbol.get("EPSI")!.marketValue).toBeCloseTo(-2_000, 9);

    const card = getConcentrationMetrics(db);
    const epsi = card.top_positions.find((p) => p.symbol === "EPSI")!;
    expect(epsi.weight_pct).toBeCloseTo(20, 12);
    expect(epsi.market_value).toBeCloseTo(-2_000, 9);
  });

  it("the >5% warning quotes the position's gross weight, never a negative one", () => {
    const { warnings } = getConcentrationMetrics(db);

    expect(warnings).toContain("ALFA is 50.0% of portfolio");
    expect(warnings).toContain("BETA is 30.0% of portfolio");
    expect(warnings).toContain("EPSI is 20.0% of portfolio");
    // No warning may print a negative share, and none may exceed 100%.
    for (const w of warnings) {
      expect(w).not.toMatch(/-\d/);
      const pct = /is (\d+(?:\.\d+)?)% of portfolio/.exec(w);
      if (pct) expect(Number(pct[1])).toBeLessThanOrEqual(100);
    }
  });

  it("the two cards' top-5 shares still agree and stay inside 100%", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    const cardTop5 = metrics.top_positions
      .slice(0, 5)
      .reduce((s, p) => s + p.weight_pct / 100, 0);
    expect(risk.top5Concentration).toBeCloseTo(cardTop5, 12);
    expect(risk.top5Concentration).toBeCloseTo(1, 12);
  });
});

/**
 * Fixture B — the unbounded case the ruling exists to kill.
 *
 *   ALFA  +10 sh @ $10 = +$100
 *   EPSI   −6 sh @ $10 =  −$60
 *
 *   signed: total 40 → weights 2.5 / −1.5 → HHI 8.5  (nonsense)
 *   gross:  total 160 → (100² + 60²) / 160² = 13,600 / 25,600 = 0.53125
 */
describe("Herfindahl over gross weights: a short bigger than the net book", () => {
  beforeEach(() => {
    const acct = seedAccount("Dominant Short Account");
    seedPosition(acct, "ALFA", 10, 10);
    seedPosition(acct, "EPSI", -6, 10);
  });

  it("lands at 0.53125 instead of the old, unbounded 8.5", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    expect(metrics.hhi).toBeCloseTo(0.53125, 12);
    expect(risk.herfindahl).toBe(metrics.hhi);
    expect(metrics.hhi).not.toBeCloseTo(8.5, 6);
  });

  it("the Herfindahl is bounded in (0, 1], so the effective count is >= 1", () => {
    const metrics = getConcentrationMetrics(db);

    expect(metrics.hhi).toBeGreaterThan(0);
    expect(metrics.hhi).toBeLessThanOrEqual(1);
    // 1 / 0.53125 = 1.882 — between one and the two positions held, which is
    // the only range a concentration reading can honestly occupy. The old
    // 1/8.5 = 0.118 rendered as "behaves like ~0 equal positions".
    expect(effectivePositionsFromHHI(metrics.hhi)).toBeCloseTo(1.8824, 4);
    expect(metrics.effective_positions).toBe(1.9);
    expect(interpretHHI(metrics.hhi).text).toContain("~2 equal positions");
  });

  it("no warning claims a position is more than the whole portfolio", () => {
    const { warnings } = getConcentrationMetrics(db);
    expect(warnings).toContain("ALFA is 62.5% of portfolio");
    expect(warnings).toContain("EPSI is 37.5% of portfolio");
    expect(warnings.some((w) => /250\.0%/.test(w))).toBe(false);
  });
});

describe("Herfindahl over gross weights: a long-only book is unchanged", () => {
  it("gross and signed denominators coincide when nothing is short", () => {
    const acct = seedAccount("Long Only Account");
    seedPosition(acct, "ALFA", 100, 60); // $6,000
    seedPosition(acct, "BETA", 100, 40); // $4,000

    const universe = getConcentrationUniverse(db);
    expect(concentrationGrossValue(universe)).toBeCloseTo(10_000, 9);

    const metrics = getConcentrationMetrics(db);
    expect(metrics.hhi).toBeCloseTo(0.6 ** 2 + 0.4 ** 2, 12);
    expect(metrics.top_positions.map((p) => p.weight_pct)).toEqual([60, 40]);
  });
});

/**
 * Follow-up to the same ruling (decision 2026-09-22): once the WEIGHT is
 * gross, the RANK has to be gross too, or the two disagree on the same card.
 *
 * The universe used to order by signed market value, so a dominant short sank
 * to the BOTTOM of a list headed "Top 10 Positions" while carrying the single
 * largest weight in the book. `top5Concentration` was then the sum of five
 * small longs, and the "rest" slice on the Risk Decomposition chart
 * (1 − top5Concentration) claimed the biggest position in the portfolio was
 * part of the remainder.
 *
 * Positions rank by |market value| descending, ties broken by symbol so the
 * order is deterministic. The market value itself still renders with its sign.
 */
describe("the concentration universe ranks by GROSS size", () => {
  /**
   * SHRT −$8,000 dominates a book of five smaller longs.
   *
   *   gross total = 8,000 + 3,000 + 2,500 + 2,000 + 1,500 + 1,000 = 18,000
   *   gross rank  = SHRT, ALFA, BETA, GAMA, DELT, EPSI
   *   top-5 share = 17,000 / 18,000 = 0.9444
   *
   * Under the old signed rank the short sorted last, the top 5 were the five
   * longs, and the top-5 share read 10,000 / 18,000 = 0.5556.
   */
  beforeEach(() => {
    const acct = seedAccount("Dominant Short Rank Account");
    seedPosition(acct, "SHRT", -80, 100); // −$8,000
    seedPosition(acct, "ALFA", 30, 100); //  +$3,000
    seedPosition(acct, "BETA", 25, 100); //  +$2,500
    seedPosition(acct, "GAMA", 20, 100); //  +$2,000
    seedPosition(acct, "DELT", 15, 100); //  +$1,500
    seedPosition(acct, "EPSI", 10, 100); //  +$1,000
  });

  it("orders the universe by absolute value, so the short leads", () => {
    const universe = getConcentrationUniverse(db);
    expect(universe.map((p) => p.symbol)).toEqual([
      "SHRT", "ALFA", "BETA", "GAMA", "DELT", "EPSI",
    ]);
    // Leading it does not make it positive — the value keeps its sign.
    expect(universe[0].marketValue).toBeCloseTo(-8_000, 9);
  });

  it("the Top 10 Positions chart leads with the short and shows it as negative", () => {
    const top = getConcentrationMetrics(db).top_positions;

    expect(top[0].symbol).toBe("SHRT");
    expect(top[0].market_value).toBeCloseTo(-8_000, 9);
    expect(top[0].weight_pct).toBeCloseTo((8_000 / 18_000) * 100, 9);
    // Every listed weight is non-negative and the chart is in descending
    // weight order.
    for (let i = 1; i < top.length; i++) {
      expect(top[i].weight_pct).toBeGreaterThanOrEqual(0);
      expect(top[i - 1].weight_pct).toBeGreaterThanOrEqual(top[i].weight_pct);
    }
  });

  it("the short sits INSIDE top5Positions, and the top-5 share reflects it", () => {
    const risk = computeConcentration(db);

    expect(risk.top5Positions.map((p) => p.symbol)).toEqual([
      "SHRT", "ALFA", "BETA", "GAMA", "DELT",
    ]);
    expect(risk.top5Concentration).toBeCloseTo(17_000 / 18_000, 12);
    // The pre-fix signed rank left the short out of the top 5 entirely.
    expect(risk.top5Concentration).not.toBeCloseTo(10_000 / 18_000, 6);
    // So the "rest" slice the Risk Decomposition chart draws stays small and
    // never claims the book's biggest position is part of the remainder.
    expect(1 - risk.top5Concentration).toBeCloseTo(1_000 / 18_000, 12);
  });

  it("both cards still agree on the ranked top-5 list", () => {
    const metrics = getConcentrationMetrics(db);
    const risk = computeConcentration(db);

    expect(risk.top5Positions.map((p) => p.symbol)).toEqual(
      metrics.top_positions.slice(0, 5).map((p) => p.symbol)
    );
    expect(risk.top5Concentration).toBeCloseTo(
      metrics.top_positions.slice(0, 5).reduce((s, p) => s + p.weight_pct / 100, 0),
      12
    );
  });
});

describe("gross ranking breaks ties on symbol, not on sign", () => {
  it("a short and a long of equal size order alphabetically", () => {
    const acct = seedAccount("Tie Break Account");
    // ALFA is the SHORT here: if the tie broke on sign the long would lead.
    seedPosition(acct, "ALFA", -50, 100); // −$5,000
    seedPosition(acct, "ZETA", 50, 100); // +$5,000

    const universe = getConcentrationUniverse(db);
    expect(universe.map((p) => p.symbol)).toEqual(["ALFA", "ZETA"]);
    expect(universe[0].marketValue).toBeCloseTo(-5_000, 9);
    expect(universe[1].marketValue).toBeCloseTo(5_000, 9);
  });
});

describe("gross ranking is taken on the WHOLE position, not one account's leg", () => {
  it("a security split across two accounts ranks on its combined value", () => {
    // ALFA: $4,000 + $4,000 = $8,000 combined — bigger than BETA's $6,000,
    // while EACH LEG is smaller than it. Ranking on a leg puts BETA first.
    //
    // This is a real SQL hazard, not a hypothetical: inside an ORDER BY
    // expression SQLite resolves `market_value` against the FROM clause
    // (the per-leg CTE column) before the SELECT's `SUM(...) AS market_value`
    // alias, so the ordering silently ran on one arbitrary leg.
    const acctA = seedAccount("Split Position Account A");
    const acctB = seedAccount("Split Position Account B");

    const alfa = seedSecurity("ALFA");
    for (const acct of [acctA, acctB]) {
      db.prepare(
        "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 40, 4000, '2026-03-02')"
      ).run(acct, alfa);
    }
    db.prepare(
      "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-03-02', 'test')"
    ).run(alfa);

    seedPosition(acctA, "BETA", 60, 100); // +$6,000, one account

    const universe = getConcentrationUniverse(db);
    expect(universe.map((p) => p.symbol)).toEqual(["ALFA", "BETA"]);
    expect(universe[0].marketValue).toBeCloseTo(8_000, 9);
    expect(getConcentrationMetrics(db).top_positions[0].symbol).toBe("ALFA");
  });
});
