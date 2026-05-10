/**
 * What-if Calculator engine.
 *
 * Pure compute over a synthetic HoldingsView. Splices hypothetical legs
 * (buy / sell) into the current per-(account, security) latest-holdings
 * snapshot, then recomputes portfolio exposure metrics: beta, factor tilts,
 * sector weights, top concentrations.
 *
 * Used directly by /api/analysis/what-if and indirectly by cash-deploy.ts.
 */

import type Database from "better-sqlite3";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { marketValue } from "@/lib/valuation";

export interface HypotheticalLeg {
  symbol: string;
  action: "buy" | "sell";
  dollarAmount: number;
}

export interface ExposureSnapshot {
  totalValue: number;
  beta: number;
  factorTilts: Record<FactorColumn, Record<string, number>>;
  sectorWeights: Record<string, number>;
  topConcentrations: Array<{ symbol: string; weightPct: number }>;
}

export interface ExposureFlag {
  severity: "warn" | "error";
  message: string;
  metric: string;
  capValue?: number;
}

export interface ExposureDelta {
  before: ExposureSnapshot;
  after: ExposureSnapshot;
  flags: ExposureFlag[];
}

export interface ConstructionCaps {
  top1_max: number;
  top3_max: number;
  sector_max: number;
  beta_range: [number, number];
}

const DEFAULT_CAPS: ConstructionCaps = {
  top1_max: 0.10,
  top3_max: 0.25,
  sector_max: 0.35,
  beta_range: [0.7, 1.2],
};

interface HoldingRow {
  symbol: string;
  securityType: string | null;
  sector: string | null;
  multiplier: number;
  quantity: number;
  price: number;
  marketValue: number;
  beta: number;
  factors: Partial<Record<FactorColumn, string>>;
}

/**
 * Build the current holdings snapshot for the given scope.
 * Per-(account, security) latest-holdings CTE so IBKR intra-day rows don't
 * mask Vanguard statement positions.
 */
function loadCurrentHoldings(
  db: Database.Database,
  accountIds: number[] | undefined
): HoldingRow[] {
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const params: number[] = accountIds?.length ? [...accountIds] : [];

  const rows = db
    .prepare(
      `
      WITH latest_holdings AS (
        SELECT h.*
        FROM holdings h
        WHERE h.as_of_date = (
          SELECT MAX(h2.as_of_date) FROM holdings h2
          WHERE h2.account_id = h.account_id
            AND h2.security_id = h.security_id
        )
        AND h.quantity != 0
        ${accountFilter}
      ),
      latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (
          SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id
        ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        s.id AS security_id,
        s.symbol,
        s.security_type,
        s.sector,
        COALESCE(s.multiplier, 1) AS multiplier,
        SUM(lh.quantity) AS quantity,
        lp.close_price AS price,
        ${FACTOR_COLUMNS.map((f) => `sf.${f} AS ${f}`).join(",\n        ")},
        sb.beta AS cached_beta
      FROM latest_holdings lh
      JOIN securities s ON s.id = lh.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = s.id
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN security_betas sb ON sb.security_id = s.id AND sb.lookback_days = 252
      GROUP BY s.id
    `
    )
    .all(...params) as Array<{
      security_id: number;
      symbol: string;
      security_type: string | null;
      sector: string | null;
      multiplier: number;
      quantity: number;
      price: number | null;
      cached_beta: number | null;
    } & Record<FactorColumn, string | null>>;

  return rows
    .filter((r) => r.price !== null && r.price > 0)
    .map((r) => {
      const factors: Partial<Record<FactorColumn, string>> = {};
      for (const col of FACTOR_COLUMNS) {
        const v = r[col];
        if (v) factors[col] = v;
      }
      return {
        symbol: r.symbol,
        securityType: r.security_type,
        sector: r.sector,
        multiplier: r.multiplier,
        quantity: r.quantity,
        price: r.price!,
        marketValue: marketValue(r.quantity, r.price!, r.security_type, r.multiplier),
        beta: r.cached_beta ?? 1.0,
        factors,
      };
    });
}

/**
 * Look up the latest price + classification for a hypothetical leg symbol.
 * Returns null if the security isn't in the DB (can't synthesize).
 */
function lookupSymbol(
  db: Database.Database,
  symbol: string
): Pick<HoldingRow, "symbol" | "securityType" | "sector" | "multiplier" | "price" | "beta" | "factors"> | null {
  const row = db
    .prepare(
      `
      SELECT
        s.id AS security_id,
        s.symbol,
        s.security_type,
        s.sector,
        COALESCE(s.multiplier, 1) AS multiplier,
        (SELECT p.close_price FROM prices p
          WHERE p.security_id = s.id ORDER BY p.date DESC LIMIT 1) AS price,
        ${FACTOR_COLUMNS.map((f) => `sf.${f} AS ${f}`).join(",\n        ")},
        sb.beta AS cached_beta
      FROM securities s
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN security_betas sb ON sb.security_id = s.id AND sb.lookback_days = 252
      WHERE UPPER(s.symbol) = UPPER(?)
      LIMIT 1
    `
    )
    .get(symbol) as ({
      security_id: number;
      symbol: string;
      security_type: string | null;
      sector: string | null;
      multiplier: number;
      price: number | null;
      cached_beta: number | null;
    } & Record<FactorColumn, string | null>) | undefined;

  if (!row || !row.price || row.price <= 0) return null;

  const factors: Partial<Record<FactorColumn, string>> = {};
  for (const col of FACTOR_COLUMNS) {
    const v = row[col];
    if (v) factors[col] = v;
  }
  return {
    symbol: row.symbol,
    securityType: row.security_type,
    sector: row.sector,
    multiplier: row.multiplier,
    price: row.price,
    beta: row.cached_beta ?? 1.0,
    factors,
  };
}

function snapshot(holdings: HoldingRow[]): ExposureSnapshot {
  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const sectorWeights: Record<string, number> = {};
  const factorTilts: Record<FactorColumn, Record<string, number>> = Object.fromEntries(
    FACTOR_COLUMNS.map((f) => [f, {} as Record<string, number>])
  ) as Record<FactorColumn, Record<string, number>>;

  let betaWeighted = 0;
  for (const h of holdings) {
    const w = totalValue > 0 ? h.marketValue / totalValue : 0;
    betaWeighted += w * h.beta;
    const sector = h.sector ?? "Unknown";
    sectorWeights[sector] = (sectorWeights[sector] ?? 0) + h.marketValue;
    for (const col of FACTOR_COLUMNS) {
      const bucket = h.factors[col] ?? "Unknown";
      factorTilts[col][bucket] = (factorTilts[col][bucket] ?? 0) + h.marketValue;
    }
  }

  // Convert sector + factor totals to weights
  if (totalValue > 0) {
    for (const k of Object.keys(sectorWeights)) sectorWeights[k] /= totalValue;
    for (const col of FACTOR_COLUMNS) {
      for (const b of Object.keys(factorTilts[col])) {
        factorTilts[col][b] /= totalValue;
      }
    }
  }

  // Aggregate holdings by symbol for concentrations (collapse duplicates)
  const bySymbol = new Map<string, number>();
  for (const h of holdings) {
    bySymbol.set(h.symbol, (bySymbol.get(h.symbol) ?? 0) + h.marketValue);
  }
  const topConcentrations = Array.from(bySymbol.entries())
    .map(([symbol, value]) => ({
      symbol,
      weightPct: totalValue > 0 ? value / totalValue : 0,
    }))
    .sort((a, b) => b.weightPct - a.weightPct)
    .slice(0, 10);

  return {
    totalValue,
    beta: betaWeighted,
    factorTilts,
    sectorWeights,
    topConcentrations,
  };
}

function applyLegs(
  current: HoldingRow[],
  legs: HypotheticalLeg[],
  resolve: (symbol: string) => HoldingRow | null
): HoldingRow[] {
  const next: HoldingRow[] = current.map((h) => ({ ...h }));
  const indexBy = new Map<string, number>();
  next.forEach((h, i) => indexBy.set(h.symbol.toUpperCase(), i));

  for (const leg of legs) {
    if (!leg.dollarAmount || leg.dollarAmount <= 0) continue;
    const upper = leg.symbol.toUpperCase();
    const idx = indexBy.get(upper);

    if (idx !== undefined) {
      const h = next[idx];
      const shares = leg.dollarAmount / (h.price * h.multiplier);
      const delta = leg.action === "buy" ? shares : -shares;
      h.quantity += delta;
      if (h.quantity < 0) h.quantity = 0; // clamp short via synthetic sell
      h.marketValue = marketValue(h.quantity, h.price, h.securityType, h.multiplier);
    } else {
      if (leg.action === "sell") continue; // can't sell what we don't hold
      const synth = resolve(leg.symbol);
      if (!synth) continue; // unknown symbol — skip silently
      const shares = leg.dollarAmount / (synth.price * synth.multiplier);
      const row: HoldingRow = {
        ...synth,
        quantity: shares,
        marketValue: marketValue(shares, synth.price, synth.securityType, synth.multiplier),
      };
      next.push(row);
      indexBy.set(upper, next.length - 1);
    }
  }

  return next.filter((h) => h.marketValue > 0);
}

function getCaps(db: Database.Database, scope: string): ConstructionCaps {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`construction_caps_${scope}`) as { value: string } | undefined;
  if (!row) return DEFAULT_CAPS;
  try {
    const parsed = JSON.parse(row.value) as Partial<ConstructionCaps>;
    return {
      top1_max: parsed.top1_max ?? DEFAULT_CAPS.top1_max,
      top3_max: parsed.top3_max ?? DEFAULT_CAPS.top3_max,
      sector_max: parsed.sector_max ?? DEFAULT_CAPS.sector_max,
      beta_range: parsed.beta_range ?? DEFAULT_CAPS.beta_range,
    };
  } catch {
    return DEFAULT_CAPS;
  }
}

function computeFlags(after: ExposureSnapshot, caps: ConstructionCaps): ExposureFlag[] {
  const flags: ExposureFlag[] = [];
  const top1 = after.topConcentrations[0];
  if (top1 && top1.weightPct > caps.top1_max) {
    flags.push({
      severity: "warn",
      metric: "top1",
      message: `Top position ${top1.symbol} would be ${(top1.weightPct * 100).toFixed(1)}% (cap ${(caps.top1_max * 100).toFixed(0)}%)`,
      capValue: caps.top1_max,
    });
  }
  const top3Sum = after.topConcentrations.slice(0, 3).reduce((s, c) => s + c.weightPct, 0);
  if (top3Sum > caps.top3_max) {
    flags.push({
      severity: "warn",
      metric: "top3",
      message: `Top 3 positions would be ${(top3Sum * 100).toFixed(1)}% (cap ${(caps.top3_max * 100).toFixed(0)}%)`,
      capValue: caps.top3_max,
    });
  }
  for (const [sector, weight] of Object.entries(after.sectorWeights)) {
    if (weight > caps.sector_max) {
      flags.push({
        severity: "warn",
        metric: `sector:${sector}`,
        message: `Sector ${sector} would be ${(weight * 100).toFixed(1)}% (cap ${(caps.sector_max * 100).toFixed(0)}%)`,
        capValue: caps.sector_max,
      });
    }
  }
  const [betaLo, betaHi] = caps.beta_range;
  if (after.beta < betaLo) {
    flags.push({
      severity: "warn",
      metric: "beta",
      message: `Portfolio beta would be ${after.beta.toFixed(2)} (target range ${betaLo}-${betaHi})`,
      capValue: betaLo,
    });
  } else if (after.beta > betaHi) {
    flags.push({
      severity: "warn",
      metric: "beta",
      message: `Portfolio beta would be ${after.beta.toFixed(2)} (target range ${betaLo}-${betaHi})`,
      capValue: betaHi,
    });
  }
  return flags;
}

/**
 * Compute the exposure delta produced by hypothetical legs against the
 * current per-scope portfolio.
 */
export function computeExposureDelta(
  db: Database.Database,
  scope: string,
  accountIds: number[] | undefined,
  legs: HypotheticalLeg[]
): ExposureDelta {
  const current = loadCurrentHoldings(db, accountIds);
  const before = snapshot(current);
  const resolved = applyLegs(current, legs, (symbol) => {
    const sym = lookupSymbol(db, symbol);
    if (!sym) return null;
    return {
      symbol: sym.symbol,
      securityType: sym.securityType,
      sector: sym.sector,
      multiplier: sym.multiplier,
      quantity: 0,
      price: sym.price,
      marketValue: 0,
      beta: sym.beta,
      factors: sym.factors,
    };
  });
  const after = snapshot(resolved);
  const caps = getCaps(db, scope);
  const flags = computeFlags(after, caps);

  return { before, after, flags };
}
