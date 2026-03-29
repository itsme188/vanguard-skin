import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";

// ─── Types ──────────────────────────────────────────────────────

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  category: "crash" | "rate" | "sector" | "custom";
  marketMove: number; // e.g., -0.10 for -10%
  rateMove?: number; // basis points, e.g., 100 for +1%
}

export interface PositionImpact {
  securityId: number;
  symbol: string;
  securityName: string | null;
  securityType: string;
  sector: string | null;
  currentValue: number;
  estimatedChange: number;
  estimatedNewValue: number;
  changePercent: number;
  beta: number; // used beta (1.0 if unknown)
}

export interface ScenarioResult {
  scenario: ScenarioDefinition;
  currentPortfolioValue: number;
  estimatedPortfolioValue: number;
  estimatedChange: number;
  estimatedChangePercent: number;
  positionImpacts: PositionImpact[];
  biggestLosers: PositionImpact[];
  biggestWinners: PositionImpact[];
}

// ─── Predefined Scenarios ───────────────────────────────────────

export const PRESET_SCENARIOS: ScenarioDefinition[] = [
  {
    id: "correction",
    name: "Market Correction",
    description: "S&P 500 drops 10% — typical correction",
    category: "crash",
    marketMove: -0.10,
  },
  {
    id: "bear",
    name: "Bear Market",
    description: "S&P 500 drops 20% — official bear market",
    category: "crash",
    marketMove: -0.20,
  },
  {
    id: "crash",
    name: "Severe Crash",
    description: "S&P 500 drops 40% — 2008-level crash",
    category: "crash",
    marketMove: -0.40,
  },
  {
    id: "rate100",
    name: "Rate Shock +100bp",
    description: "Interest rates rise 1% — bonds fall, growth stocks impacted",
    category: "rate",
    marketMove: -0.05,
    rateMove: 100,
  },
  {
    id: "rate200",
    name: "Rate Shock +200bp",
    description: "Interest rates rise 2% — significant bond losses, growth rotation",
    category: "rate",
    marketMove: -0.10,
    rateMove: 200,
  },
  {
    id: "rally",
    name: "Bull Rally",
    description: "S&P 500 rises 15% — strong bull market",
    category: "crash",
    marketMove: 0.15,
  },
];

// ─── Computation ────────────────────────────────────────────────

/**
 * Estimate portfolio impact under a given scenario.
 *
 * For market crash scenarios, each position's impact is scaled by its
 * estimated beta. Bonds are treated differently (duration-based for
 * rate scenarios, lower beta for market scenarios).
 */
export function computeScenario(
  db: Database.Database,
  scenario: ScenarioDefinition,
  options?: { accountId?: number }
): ScenarioResult {
  const accountFilter = options?.accountId ? "AND h.account_id = ?" : "";
  const accountParams: number[] = options?.accountId ? [options.accountId] : [];

  // 1. Get current positions with latest prices and classification
  const positions = db
    .prepare(
      `WITH latest_holdings AS (
         SELECT h.security_id, SUM(h.quantity) AS total_qty
         FROM holdings h
         WHERE h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id
         )
         ${accountFilter}
         GROUP BY h.security_id
       ),
       latest_prices AS (
         SELECT security_id, close_price
         FROM prices
         WHERE (security_id, date) IN (
           SELECT security_id, MAX(date) FROM prices GROUP BY security_id
         )
       )
       SELECT
         lh.security_id,
         s.symbol,
         s.name AS security_name,
         s.security_type,
         s.sector,
         s.style,
         s.market_cap_category,
         CASE
           WHEN s.security_type = 'bond'
             THEN lh.total_qty * COALESCE(lp.close_price, 0) / 100.0
           ELSE lh.total_qty * COALESCE(lp.close_price, 0) * COALESCE(s.multiplier, 1)
         END AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       WHERE COALESCE(lp.close_price, 0) > 0
       ORDER BY market_value DESC`
    )
    .all(...accountParams) as {
    security_id: number;
    symbol: string;
    security_name: string | null;
    security_type: string;
    sector: string | null;
    style: string | null;
    market_cap_category: string | null;
    market_value: number;
  }[];

  const currentPortfolioValue = positions.reduce((s, p) => s + p.market_value, 0);

  // 2. Estimate beta for each position
  const positionImpacts: PositionImpact[] = positions.map((pos) => {
    const beta = estimateBeta(pos.security_type, pos.sector, pos.style, pos.market_cap_category);

    let changePercent: number;

    if (scenario.category === "rate" && scenario.rateMove) {
      // Rate scenario: bonds hit harder, growth stocks hit moderately
      changePercent = estimateRateImpact(
        pos.security_type,
        pos.style,
        scenario.rateMove,
        scenario.marketMove
      );
    } else {
      // Market scenario: scale by beta
      changePercent = scenario.marketMove * beta;
    }

    const estimatedChange = pos.market_value * changePercent;

    return {
      securityId: pos.security_id,
      symbol: pos.symbol,
      securityName: pos.security_name,
      securityType: pos.security_type,
      sector: pos.sector,
      currentValue: pos.market_value,
      estimatedChange,
      estimatedNewValue: pos.market_value + estimatedChange,
      changePercent,
      beta,
    };
  });

  const estimatedChange = positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
  const estimatedPortfolioValue = currentPortfolioValue + estimatedChange;
  const estimatedChangePercent =
    currentPortfolioValue > 0 ? estimatedChange / currentPortfolioValue : 0;

  // Sort by absolute change for winners/losers
  const sorted = [...positionImpacts].sort(
    (a, b) => a.estimatedChange - b.estimatedChange
  );
  const biggestLosers = sorted.filter((p) => p.estimatedChange < 0).slice(0, 5);
  const biggestWinners = sorted
    .filter((p) => p.estimatedChange > 0)
    .reverse()
    .slice(0, 5);

  return {
    scenario,
    currentPortfolioValue,
    estimatedPortfolioValue,
    estimatedChange,
    estimatedChangePercent,
    positionImpacts,
    biggestLosers,
    biggestWinners,
  };
}

/**
 * Run all preset scenarios and return results.
 */
export function computeAllScenarios(
  db: Database.Database,
  options?: { accountId?: number }
): ScenarioResult[] {
  return PRESET_SCENARIOS.map((scenario) => computeScenario(db, scenario, options));
}

// ─── Beta estimation heuristics ──────────────────────────────────

function estimateBeta(
  securityType: string,
  sector: string | null,
  style: string | null,
  marketCap: string | null
): number {
  // Bonds have near-zero equity beta
  if (securityType === "bond" || securityType === "money_market") return 0.1;

  // Options are higher beta (leverage)
  if (securityType === "option" || securityType === "call" || securityType === "put") return 2.0;

  let beta = 1.0;

  // Sector adjustments
  const highBetaSectors = ["Technology", "Consumer Discretionary", "Communication Services"];
  const lowBetaSectors = ["Utilities", "Consumer Staples", "Healthcare", "Real Estate"];
  if (sector && highBetaSectors.includes(sector)) beta *= 1.15;
  if (sector && lowBetaSectors.includes(sector)) beta *= 0.85;

  // Style adjustments
  if (style === "Growth") beta *= 1.1;
  if (style === "Value") beta *= 0.9;

  // Size adjustments
  if (marketCap === "Small Cap") beta *= 1.15;
  if (marketCap === "Mid Cap") beta *= 1.05;

  return beta;
}

function estimateRateImpact(
  securityType: string,
  style: string | null,
  rateBps: number,
  marketMove: number
): number {
  const rateChange = rateBps / 100; // convert bps to %

  // Bonds: rough duration-based estimate (assume ~5yr average duration)
  if (securityType === "bond") {
    return -5 * rateChange / 100; // duration × rate change
  }

  // Money market benefits slightly from higher rates
  if (securityType === "money_market") {
    return rateChange * 0.002; // tiny positive
  }

  // Equities: growth stocks hurt more by rate rises
  let impact = marketMove;
  if (style === "Growth") impact *= 1.3;
  if (style === "Value") impact *= 0.7;

  return impact;
}
