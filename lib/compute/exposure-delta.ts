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
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { resolveLeveragedExposure } from "@/lib/compute/leveraged-fund";

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

export interface DroppedLeg {
  symbol: string;
  reason: "unknown_symbol" | "not_held" | "invalid_amount" | "clamped_sell" | "leveraged_or_inverse_fund";
  requestedDollars?: number;
  appliedDollars?: number;
}

export interface ExposureDelta {
  before: ExposureSnapshot;
  after: ExposureSnapshot;
  flags: ExposureFlag[];
  // Legs that could not be modeled (ticker with no securities row, or a sell
  // of a symbol not held in scope). Surfaced so the UI can explain the no-op
  // instead of rendering a misleading Δ $0 — "explain no-ops" convention.
  droppedLegs: DroppedLeg[];
  /**
   * Leveraged or inverse funds, and options on them, that carry NO signed
   * leverage factor (`resolveLeveragedExposure`; owner ruling 2026-11-01,
   * stopgap) held in scope or named by a leg: left out of every bucket in
   * both snapshots, so the weights are over the modelled book. Symbols,
   * sorted. A flagged fund WITH a factor is modelled and is not listed here
   * (theme T2, 2026-11-07).
   */
  leveragedFundsNotModelled: string[];
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
  currency: string | null;
  multiplier: number;
  quantity: number;
  price: number;
  marketValue: number;
  beta: number;
  factors: Partial<Record<FactorColumn, string>>;
  /**
   * A leveraged or inverse fund (or an option on one) with no signed factor:
   * kept out of every bucket in snapshot(), and refused as a leg.
   */
  leveragedOrInverse: boolean;
  /**
   * The signed multiple of its index a flagged fund delivers (+3 / -3 / +2 /
   * -2), or null for every ordinary row. snapshot() counts a factored row's
   * EXPOSURE — market value times this factor — in the beta, sector and
   * factor buckets, so a long inverse fund subtracts from the sector it
   * shorts instead of adding to it.
   */
  leverageFactor: number | null;
}

/**
 * Build the current holdings snapshot for the given scope.
 * Per-(account, security) latest-holdings CTE so IBKR intra-day rows don't
 * mask Vanguard statement positions. An expired option is left out (the one
 * reader, lib/compute/option-expiry.ts), as Scenario Modeling, Defense and
 * Concentration already do: a contract that expired at Friday's close is not
 * part of the baseline the What-if is measured against (2026-10-24 QA).
 */
function loadCurrentHoldings(
  db: Database.Database,
  accountIds: number[] | undefined
): HoldingRow[] {
  // `undefined` is every account; a defined empty list is NO accounts.
  const { sql: accountFilter, params } = accountScopeAndSql(accountIds);

  const rows = db
    .prepare(
      `
      WITH latest_holdings AS (
        SELECT h.* FROM holdings h
        WHERE ${latestHoldingsPredicate({ accountFilter })}
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
        s.name,
        s.security_type,
        s.sector,
        s.fund_category,
        s.currency,
        COALESCE(s.multiplier, 1) AS multiplier,
        s_u.security_type AS underlying_security_type,
        s_u.fund_category AS underlying_fund_category,
        s_u.name AS underlying_name,
        s.leverage_factor,
        s_u.leverage_factor AS underlying_leverage_factor,
        SUM(lh.quantity) AS quantity,
        lp.close_price AS price,
        ${FACTOR_COLUMNS.map((f) => `sf.${f} AS ${f}`).join(",\n        ")},
        sb.beta AS cached_beta
      FROM latest_holdings lh
      JOIN securities s ON s.id = lh.security_id
      -- An option's underlying, read only by the leveraged-fund rule.
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN latest_prices lp ON lp.security_id = s.id
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN security_betas sb ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
      WHERE ${liveOptionExpirationSql("s")}
      GROUP BY s.id
    `
    )
    .all(...params) as Array<{
      security_id: number;
      symbol: string;
      name: string | null;
      security_type: string | null;
      sector: string | null;
      fund_category: string | null;
      currency: string | null;
      multiplier: number;
      underlying_security_type: string | null;
      underlying_fund_category: string | null;
      underlying_name: string | null;
      leverage_factor: number | null;
      underlying_leverage_factor: number | null;
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
        currency: r.currency,
        multiplier: r.multiplier,
        quantity: r.quantity,
        price: r.price!,
        marketValue: marketValue(r.quantity, r.price!, r.security_type, r.multiplier, getUsdPerUnit(db, r.currency)),
        beta: r.cached_beta ?? 1.0,
        factors,
        ...leveragedExposureOf(r),
      };
    });
}

/**
 * The leveraged-fund rule for a What-if row: the row itself, or an option
 * whose underlying is such a fund (QA 2026-11-03; lib/compute/leveraged-fund.ts).
 * Returns both fields the snapshot reads — `leveragedOrInverse` is true only
 * for a flagged row with NO factor, which is the row the stopgap still leaves
 * out of every bucket.
 */
function leveragedExposureOf(r: {
  security_type: string | null;
  fund_category: string | null;
  name: string | null;
  leverage_factor: number | null;
  underlying_security_type: string | null;
  underlying_fund_category: string | null;
  underlying_name: string | null;
  underlying_leverage_factor: number | null;
}): { leveragedOrInverse: boolean; leverageFactor: number | null } {
  const resolved = resolveLeveragedExposure(
    {
      security_type: r.security_type,
      fund_category: r.fund_category,
      name: r.name,
      leverage_factor: r.leverage_factor,
    },
    r.underlying_security_type === null
      ? null
      : {
          security_type: r.underlying_security_type,
          fund_category: r.underlying_fund_category,
          name: r.underlying_name,
          leverage_factor: r.underlying_leverage_factor,
        },
  );
  return {
    leveragedOrInverse: resolved.flagged && resolved.factor === null,
    leverageFactor: resolved.factor,
  };
}

/**
 * OCC option symbols are stored with multi-space padding ("CRWD  270319C00117500")
 * but every render path collapses whitespace runs, so a user who copies the
 * displayed symbol types a single space and an exact match fails. Match
 * space-insensitively: no real symbol contains a space, and OCC padding is
 * deterministic, so stripping whitespace can never collide two securities.
 */
function symbolKey(symbol: string): string {
  return symbol.toUpperCase().replace(/\s+/g, "");
}

/**
 * Look up the latest price + classification for a hypothetical leg symbol.
 * Returns null if the security isn't in the DB (can't synthesize).
 */
function lookupSymbol(
  db: Database.Database,
  symbol: string
): Pick<
  HoldingRow,
  | "symbol"
  | "securityType"
  | "sector"
  | "currency"
  | "multiplier"
  | "price"
  | "beta"
  | "factors"
  | "leveragedOrInverse"
  | "leverageFactor"
> | null {
  const row = db
    .prepare(
      `
      SELECT
        s.id AS security_id,
        s.symbol,
        s.name,
        s.security_type,
        s.sector,
        s.fund_category,
        s.currency,
        COALESCE(s.multiplier, 1) AS multiplier,
        s_u.security_type AS underlying_security_type,
        s_u.fund_category AS underlying_fund_category,
        s_u.name AS underlying_name,
        s.leverage_factor,
        s_u.leverage_factor AS underlying_leverage_factor,
        (SELECT p.close_price FROM prices p
          WHERE p.security_id = s.id ORDER BY p.date DESC LIMIT 1) AS price,
        ${FACTOR_COLUMNS.map((f) => `sf.${f} AS ${f}`).join(",\n        ")},
        sb.beta AS cached_beta
      FROM securities s
      -- An option's underlying, read only by the leveraged-fund rule.
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN security_betas sb ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
      WHERE REPLACE(UPPER(s.symbol), ' ', '') = ?
      LIMIT 1
    `
    )
    .get(symbolKey(symbol)) as ({
      security_id: number;
      symbol: string;
      name: string | null;
      security_type: string | null;
      sector: string | null;
      fund_category: string | null;
      currency: string | null;
      multiplier: number;
      underlying_security_type: string | null;
      underlying_fund_category: string | null;
      underlying_name: string | null;
      leverage_factor: number | null;
      underlying_leverage_factor: number | null;
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
    currency: row.currency,
    multiplier: row.multiplier,
    price: row.price,
    beta: row.cached_beta ?? 1.0,
    factors,
    ...leveragedExposureOf(row),
  };
}

function snapshot(allHoldings: HoldingRow[]): ExposureSnapshot {
  // A leveraged or inverse fund with NO signed factor has no beta, sector or
  // factor exposure anyone can state (owner ruling 2026-11-01, stopgap): it
  // is left out of every bucket AND of the total, so the weights are over the
  // modelled book. One WITH a factor is modelled at its exposure — market
  // value times the factor (theme T2, 2026-11-07) — so a long 3x inverse
  // semiconductor fund subtracts three times its money from Technology
  // instead of adding one times it. Its own money still counts once in
  // `totalValue` and in the concentration list: leverage changes the exposure
  // a position carries, not how many dollars sit in it.
  const holdings = allHoldings.filter((h) => !h.leveragedOrInverse);
  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const sectorWeights: Record<string, number> = {};
  const factorTilts: Record<FactorColumn, Record<string, number>> = Object.fromEntries(
    FACTOR_COLUMNS.map((f) => [f, {} as Record<string, number>])
  ) as Record<FactorColumn, Record<string, number>>;

  let betaWeighted = 0;
  for (const h of holdings) {
    // The exposure a position carries: its money, times its signed leverage
    // factor where it has one.
    const exposureValue = h.marketValue * (h.leverageFactor ?? 1);
    const w = totalValue > 0 ? exposureValue / totalValue : 0;
    betaWeighted += w * h.beta;
    const sector = h.sector ?? "Unknown";
    sectorWeights[sector] = (sectorWeights[sector] ?? 0) + exposureValue;
    for (const col of FACTOR_COLUMNS) {
      const bucket = h.factors[col] ?? "Unknown";
      factorTilts[col][bucket] = (factorTilts[col][bucket] ?? 0) + exposureValue;
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
  db: Database.Database,
  current: HoldingRow[],
  legs: HypotheticalLeg[],
  resolve: (symbol: string) => HoldingRow | null
): { rows: HoldingRow[]; dropped: DroppedLeg[] } {
  const dropped: DroppedLeg[] = [];
  const next: HoldingRow[] = current.map((h) => ({ ...h }));
  const indexBy = new Map<string, number>();
  next.forEach((h, i) => indexBy.set(symbolKey(h.symbol), i));

  for (const leg of legs) {
    const upper = leg.symbol.toUpperCase();
    // A non-positive (or non-finite) amount used to be a bare `continue`, so
    // the caller got a confident all-zero before/after table with nothing to
    // explain it (QA analysis-whatif--negative-amount-silent-zero-table).
    // Report it like any other unmodelable leg — direction lives in `action`,
    // so a negative dollar figure is never a "sell", just a bad number.
    if (!Number.isFinite(leg.dollarAmount) || leg.dollarAmount <= 0) {
      dropped.push({ symbol: upper, reason: "invalid_amount" });
      continue;
    }
    const idx = indexBy.get(symbolKey(leg.symbol));

    if (idx !== undefined) {
      const h = next[idx];
      if (h.leveragedOrInverse) {
        dropped.push({ symbol: upper, reason: "leveraged_or_inverse_fund" });
        continue;
      }
      // leg.dollarAmount is a USD figure — convert to native-currency
      // notional BEFORE dividing by the native price so the resulting
      // marketValue() delta (which multiplies back by usdPerUnit) equals
      // exactly leg.dollarAmount USD, not leg.dollarAmount * usdPerUnit.
      const usdPerUnit = getUsdPerUnit(db, h.currency) || 1;
      const shares = leg.dollarAmount / (h.price * h.multiplier * usdPerUnit);
      const delta = leg.action === "buy" ? shares : -shares;
      const prevQuantity = h.quantity;
      h.quantity += delta;
      // A sell on a LONG clamps at zero (no synthetic short). Shorts are
      // untouched: a buy covers (and may cross into long), a sell adds to
      // the short — never zero an existing short via the clamp.
      if (leg.action === "sell" && prevQuantity > 0 && h.quantity < 0) {
        dropped.push({
          symbol: upper,
          reason: "clamped_sell",
          requestedDollars: leg.dollarAmount,
          appliedDollars: h.marketValue,
        });
        h.quantity = 0;
      }
      h.marketValue = marketValue(h.quantity, h.price, h.securityType, h.multiplier, usdPerUnit);
    } else {
      if (leg.action === "sell") {
        // Can't sell what we don't hold in scope.
        dropped.push({ symbol: upper, reason: "not_held" });
        continue;
      }
      const synth = resolve(leg.symbol);
      if (!synth) {
        dropped.push({ symbol: upper, reason: "unknown_symbol" });
        continue;
      }
      if (synth.leveragedOrInverse) {
        dropped.push({ symbol: upper, reason: "leveraged_or_inverse_fund" });
        continue;
      }
      // Same USD-notional conversion as above — see comment there. Options
      // are USD-denominated in this app (securities.currency defaults to
      // 'USD' at ingestion unless a real non-USD currency was captured) —
      // synth.currency already reflects that, so no special option-vs-non-
      // option branch is needed here.
      const usdPerUnit = getUsdPerUnit(db, synth.currency) || 1;
      const shares = leg.dollarAmount / (synth.price * synth.multiplier * usdPerUnit);
      const row: HoldingRow = {
        ...synth,
        quantity: shares,
        marketValue: marketValue(shares, synth.price, synth.securityType, synth.multiplier, usdPerUnit),
      };
      next.push(row);
      indexBy.set(symbolKey(leg.symbol), next.length - 1);
    }
  }

  // Keep shorts (negative marketValue) — dropping them gave the AFTER
  // snapshot a higher baseline than BEFORE by |sum of short MVs| (constant
  // ~$57.8k inflation of every what-if Total Value Δ). Only fully-zeroed
  // positions leave the book.
  return { rows: next.filter((h) => h.quantity !== 0), dropped };
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
    if (sector === "Unknown") continue; // skip — concentration in unclassified positions is a data-quality issue, not a portfolio-construction risk
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
  const resolved = applyLegs(db, current, legs, (symbol) => {
    const sym = lookupSymbol(db, symbol);
    if (!sym) return null;
    return {
      symbol: sym.symbol,
      securityType: sym.securityType,
      sector: sym.sector,
      currency: sym.currency,
      multiplier: sym.multiplier,
      quantity: 0,
      price: sym.price,
      marketValue: 0,
      beta: sym.beta,
      factors: sym.factors,
      leveragedOrInverse: sym.leveragedOrInverse,
      leverageFactor: sym.leverageFactor,
    };
  });
  const after = snapshot(resolved.rows);
  const caps = getCaps(db, scope);
  const flags = computeFlags(after, caps);

  const leveragedFundsNotModelled = [
    ...new Set([
      ...current.filter((h) => h.leveragedOrInverse).map((h) => h.symbol),
      ...resolved.dropped.filter((d) => d.reason === "leveraged_or_inverse_fund").map((d) => d.symbol),
    ]),
  ].sort();

  return { before, after, flags, droppedLegs: resolved.dropped, leveragedFundsNotModelled };
}
