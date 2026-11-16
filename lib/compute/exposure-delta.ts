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
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { fundDefaultRefusal, isFixedIncomeFund } from "@/lib/compute/bond-duration";
import { explodeHoldingBySector } from "@/lib/compute/explode-sector";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { getOptionExposureMap } from "@/lib/compute/exposure";

/**
 * Equity beta assumed for a bond with no stored beta: the scenario engine's
 * own convention (`estimateBeta` in lib/compute/scenarios.ts, which is not
 * exported). Parity-pinned by tests/compute/exposure-delta-k2-rulings.test.ts;
 * change both together (owner ruling 2026-11-15, K2a).
 */
export const BOND_EQUITY_BETA_ESTIMATE = 0.1;

/**
 * A scope whose net value is under this share of its gross value (the sum of
 * every position's absolute market value) is close to market-neutral: its
 * net value is not a meaningful denominator, so shares of it (beta, sector,
 * factor and concentration weights) are not printed and raise no flag. A
 * book of 10,000 long and 9,900 short (net 100) otherwise read a beta of 21
 * and a top weight of 10,000%. Five percent keeps every ordinary long book,
 * and a hedged book down to 20 times gross over net, on the normal path.
 */
export const NEAR_NEUTRAL_NET_SHARE = 0.05;

/** The sector bucket a cash equivalent lands in, the Cash-deploy name. */
const CASH_EQUIVALENT_SECTOR = "Cash Equivalent";

type FundSectorWeights = Map<string, Array<{ sector: string; weight_pct: number }>>;

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
  /**
   * The share (0-1) of the book's beta-weighted exposure whose beta is a
   * type-based ESTIMATE rather than a stored measurement: a bond (the
   * scenario engine's bond figure), an option whose underlying has no stored
   * beta, or any other holding with no stored beta (1.0). A cash equivalent's
   * zero is definitional and not counted (owner ruling 2026-11-15, K2a).
   */
  betaEstimatedWeight: number;
  /**
   * How many option rows entered the sector weights at their MARKET VALUE
   * because their Greeks could not compute (no strike, expiry, underlying
   * price or option price on file). Every other option enters at its
   * delta-adjusted exposure (review finding S-B1, 2026-11-15).
   */
  optionsAtMarketValue: number;
  /**
   * True when the net value is not meaningfully positive: at or under
   * NEAR_NEUTRAL_NET_SHARE of the gross value. Every ratio in this snapshot
   * is then a share of a near-zero (or negative) number; the card does not
   * print them and no ratio flag is raised.
   */
  nearMarketNeutral: boolean;
}

export interface ExposureFlag {
  severity: "warn" | "error";
  message: string;
  metric: string;
  capValue?: number;
  /**
   * The portfolio weight (a fraction) the message prints, for the flags that
   * carry one (top1, top3, sector). The message prints it as
   * `(weightPct * 100).toFixed(1)%`; the UI masks that figure under Hide
   * amounts, since with a known leg amount it reveals the scope total.
   */
  weightPct?: number;
}

export interface DroppedLeg {
  symbol: string;
  /**
   * `no_price`: the security is known but has no positive close on file, so
   * no quantity can be derived (K2d, 2026-11-15). `unknown_symbol`: no
   * securities row at all.
   */
  reason: "unknown_symbol" | "no_price" | "not_held" | "invalid_amount" | "clamped_sell" | "leveraged_or_inverse_fund";
  requestedDollars?: number;
  appliedDollars?: number;
}

export interface ExposureDelta {
  before: ExposureSnapshot;
  after: ExposureSnapshot;
  /**
   * The BEFORE weight of every symbol in `after.topConcentrations` (0 for a
   * name not held before). `before.topConcentrations` is cut to 10, so a name
   * a leg lifts into the after top list from outside the before top 10 has
   * no before weight there (A2, 2026-11-15).
   */
  beforeWeightBySymbol: Record<string, number>;
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

/**
 * The identity a row's SECTOR buckets are read from: the row itself, or, for
 * an option whose underlying is on file, that underlying (an option is a
 * claim on it; a call on a fund with stored weights is spread by them).
 */
interface SectorIdentity {
  symbol: string;
  securityType: string | null;
  sector: string | null;
  fundCategory: string | null;
}

interface HoldingRow {
  securityId: number;
  symbol: string;
  securityType: string | null;
  sector: string | null;
  fundCategory: string | null;
  /** Where the sector buckets come from (the underlying for an option). */
  sectorIdentity: SectorIdentity;
  currency: string | null;
  multiplier: number;
  quantity: number;
  price: number;
  marketValue: number;
  beta: number;
  /** True when `beta` is a type-based estimate, not a stored measurement. */
  betaEstimated: boolean;
  /**
   * Exposure per dollar of market value, read by the beta AND the sector
   * weights: 1 for every row but a held option whose Greeks compute, where
   * it is that contract's delta-adjusted exposure per dollar of its value
   * (lib/compute/exposure.ts `perValueDollar`). Set after loading; see
   * optionDeltaPerValueReader.
   */
  betaExposurePerValue: number;
  /** An option row that has no delta, so its sector weight is its market value. */
  optionAtMarketValue: boolean;
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
        s.underlying_symbol,
        s_u.symbol AS underlying_resolved_symbol,
        s_u.security_type AS underlying_security_type,
        s_u.fund_category AS underlying_fund_category,
        s_u.name AS underlying_name,
        s_u.sector AS underlying_sector,
        s.duration_years,
        s_u.duration_years AS underlying_duration_years,
        s.leverage_factor,
        s_u.leverage_factor AS underlying_leverage_factor,
        SUM(lh.quantity) AS quantity,
        lp.close_price AS price,
        ${FACTOR_COLUMNS.map((f) => `sf.${f} AS ${f}`).join(",\n        ")},
        sb.beta AS cached_beta,
        sb_u.beta AS underlying_cached_beta
      FROM latest_holdings lh
      JOIN securities s ON s.id = lh.security_id
      -- An option's underlying: its beta, sector, fund identity and leverage.
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN latest_prices lp ON lp.security_id = s.id
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN security_betas sb ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
      LEFT JOIN security_betas sb_u ON sb_u.security_id = s_u.id AND sb_u.lookback_days = ${BETA_LOOKBACK_DAYS}
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
      underlying_symbol: string | null;
      underlying_resolved_symbol: string | null;
      underlying_security_type: string | null;
      underlying_fund_category: string | null;
      underlying_name: string | null;
      underlying_sector: string | null;
      duration_years: number | null;
      underlying_duration_years: number | null;
      leverage_factor: number | null;
      underlying_leverage_factor: number | null;
      quantity: number;
      price: number | null;
      cached_beta: number | null;
      underlying_cached_beta: number | null;
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
        securityId: r.security_id,
        symbol: r.symbol,
        securityType: r.security_type,
        sector: r.sector,
        fundCategory: r.fund_category,
        currency: r.currency,
        multiplier: r.multiplier,
        quantity: r.quantity,
        price: r.price!,
        sectorIdentity: sectorIdentityOf(r),
        marketValue: marketValue(r.quantity, r.price!, r.security_type, r.multiplier, getUsdPerUnit(db, r.currency)),
        ...betaOf(r),
        betaExposurePerValue: 1,
        optionAtMarketValue: isOptionType(r.security_type),
        factors,
        ...leveragedExposureOf(r),
      };
    });
}

type BetaInputs = {
  security_type: string | null;
  name: string | null;
  sector: string | null;
  fund_category: string | null;
  duration_years: number | null;
  cached_beta: number | null;
  underlying_security_type: string | null;
  underlying_name: string | null;
  underlying_sector: string | null;
  underlying_fund_category: string | null;
  underlying_duration_years: number | null;
  underlying_cached_beta: number | null;
};

function isOptionType(securityType: string | null): boolean {
  return securityType?.trim().toLowerCase() === "option";
}

/**
 * The beta a What-if row is weighted at (owner ruling 2026-11-15, K2a).
 * A stored beta wins. With none, a type-based estimate replaces the old
 * blanket 1.0, which over-stated the beta of a book holding much cash, bonds
 * or options and raised a false beta flag:
 *   - a cash equivalent (isCashEquivalentSecurity) is 0, not an estimate;
 *   - a bond, and a bond FUND the scenario engine gives no market move
 *     (isBondFundWithoutMarketMove below; review finding S-2), take the
 *     scenario engine's bond figure;
 *   - an option takes its UNDERLYING's stored beta, else the underlying's own
 *     fallback by these same rules (1.0 when the underlying is not on file);
 *   - anything else keeps 1.0.
 */
function betaOf(r: BetaInputs): { beta: number; betaEstimated: boolean } {
  if (isOptionType(r.security_type)) {
    if (r.underlying_cached_beta !== null) return { beta: r.underlying_cached_beta, betaEstimated: false };
    if (r.underlying_security_type == null) return { beta: 1.0, betaEstimated: true };
    return typeBetaEstimate({
      security_type: r.underlying_security_type,
      security_name: r.underlying_name,
      sector: r.underlying_sector,
      fund_category: r.underlying_fund_category,
      duration_years: r.underlying_duration_years,
    });
  }
  if (r.cached_beta !== null) return { beta: r.cached_beta, betaEstimated: false };
  return typeBetaEstimate({
    security_type: r.security_type,
    security_name: r.name,
    sector: r.sector,
    fund_category: r.fund_category,
    duration_years: r.duration_years,
  });
}

type FundIdentity = {
  security_type: string | null;
  security_name: string | null;
  sector: string | null;
  fund_category: string | null;
  duration_years: number | null;
};

function typeBetaEstimate(sec: FundIdentity): { beta: number; betaEstimated: boolean } {
  if (isCashEquivalentSecurity({ security_type: sec.security_type, fund_category: sec.fund_category })) {
    return { beta: 0, betaEstimated: false };
  }
  if (sec.security_type?.trim().toLowerCase() === "bond") return { beta: BOND_EQUITY_BETA_ESTIMATE, betaEstimated: true };
  if (isBondFundWithoutMarketMove(sec)) return { beta: BOND_EQUITY_BETA_ESTIMATE, betaEstimated: true };
  return { beta: 1.0, betaEstimated: true };
}

/**
 * A fixed-income fund the scenario engine gives NO equity market move. The
 * same rule, built on the same house readers (`isFixedIncomeFund`,
 * `fundDefaultRefusal`, lib/compute/bond-duration.ts), as the unexported
 * `isBondFundWithoutMarketMove` in lib/compute/scenarios.ts; parity-pinned by
 * tests/compute/exposure-delta-review-s-wave.test.ts. Change both together.
 */
function isBondFundWithoutMarketMove(sec: FundIdentity): boolean {
  if (!isFixedIncomeFund(sec)) return false;
  const hasStoredDuration =
    typeof sec.duration_years === "number" && Number.isFinite(sec.duration_years) && sec.duration_years >= 0;
  return hasStoredDuration || fundDefaultRefusal(sec) !== "fund-equity-evidence";
}

/**
 * Where a row's sector buckets come from: an option whose underlying is on
 * file reads the UNDERLYING (its sector, or its stored fund weights when it is
 * a fund); the option's own sector is the fallback when the underlying has
 * none. Every other row reads itself.
 */
function sectorIdentityOf(r: {
  symbol: string;
  security_type: string | null;
  sector: string | null;
  fund_category: string | null;
  underlying_resolved_symbol: string | null;
  underlying_security_type: string | null;
  underlying_sector: string | null;
  underlying_fund_category: string | null;
}): SectorIdentity {
  if (isOptionType(r.security_type) && r.underlying_resolved_symbol !== null) {
    const ownSector = r.sector?.trim() ? r.sector : null;
    return {
      symbol: r.underlying_resolved_symbol,
      securityType: r.underlying_security_type,
      sector: r.underlying_sector?.trim() ? r.underlying_sector : ownSector,
      fundCategory: r.underlying_fund_category,
    };
  }
  return { symbol: r.symbol, securityType: r.security_type, sector: r.sector, fundCategory: r.fund_category };
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
  | "securityId"
  | "symbol"
  | "securityType"
  | "sector"
  | "fundCategory"
  | "sectorIdentity"
  | "currency"
  | "multiplier"
  | "price"
  | "beta"
  | "betaEstimated"
  | "factors"
  | "leveragedOrInverse"
  | "leverageFactor"
> | "no_price" | null {
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
        s.underlying_symbol,
        s_u.symbol AS underlying_resolved_symbol,
        s_u.security_type AS underlying_security_type,
        s_u.fund_category AS underlying_fund_category,
        s_u.name AS underlying_name,
        s_u.sector AS underlying_sector,
        s.duration_years,
        s_u.duration_years AS underlying_duration_years,
        s.leverage_factor,
        s_u.leverage_factor AS underlying_leverage_factor,
        (SELECT p.close_price FROM prices p
          WHERE p.security_id = s.id ORDER BY p.date DESC LIMIT 1) AS price,
        ${FACTOR_COLUMNS.map((f) => `sf.${f} AS ${f}`).join(",\n        ")},
        sb.beta AS cached_beta,
        sb_u.beta AS underlying_cached_beta
      FROM securities s
      -- An option's underlying: its beta, sector, fund identity and leverage.
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN security_betas sb ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
      LEFT JOIN security_betas sb_u ON sb_u.security_id = s_u.id AND sb_u.lookback_days = ${BETA_LOOKBACK_DAYS}
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
      underlying_symbol: string | null;
      underlying_resolved_symbol: string | null;
      underlying_security_type: string | null;
      underlying_fund_category: string | null;
      underlying_name: string | null;
      underlying_sector: string | null;
      duration_years: number | null;
      underlying_duration_years: number | null;
      leverage_factor: number | null;
      underlying_leverage_factor: number | null;
      price: number | null;
      cached_beta: number | null;
      underlying_cached_beta: number | null;
    } & Record<FactorColumn, string | null>) | undefined;

  if (!row) return null;
  if (!row.price || row.price <= 0) return "no_price";

  const factors: Partial<Record<FactorColumn, string>> = {};
  for (const col of FACTOR_COLUMNS) {
    const v = row[col];
    if (v) factors[col] = v;
  }
  return {
    securityId: row.security_id,
    symbol: row.symbol,
    securityType: row.security_type,
    sector: row.sector,
    fundCategory: row.fund_category,
    sectorIdentity: sectorIdentityOf(row),
    currency: row.currency,
    multiplier: row.multiplier,
    price: row.price,
    ...betaOf(row),
    factors,
    ...leveragedExposureOf(row),
  };
}

/**
 * Every modelled symbol's weight of the modelled book, largest first
 * (duplicate rows collapsed). snapshot() keeps the top 10 of it; the caller
 * reads the full list for the before weight of each after-top name (A2).
 * A cash equivalent stays in the total but is never a ranked position (owner
 * ruling 2026-11-15, as on the Concentration card; review finding S-4).
 */
function symbolWeights(allHoldings: HoldingRow[]): Array<{ symbol: string; weightPct: number }> {
  const holdings = allHoldings.filter((h) => !h.leveragedOrInverse);
  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const bySymbol = new Map<string, number>();
  for (const h of holdings) {
    if (isCashEquivalentSecurity({ security_type: h.securityType, fund_category: h.fundCategory })) continue;
    bySymbol.set(h.symbol, (bySymbol.get(h.symbol) ?? 0) + h.marketValue);
  }
  return Array.from(bySymbol.entries())
    .map(([symbol, value]) => ({
      symbol,
      weightPct: totalValue > 0 ? value / totalValue : 0,
    }))
    .sort((a, b) => b.weightPct - a.weightPct);
}

/**
 * A row's sector buckets, the same way Cash deploy reads its book (owner
 * rulings 2026-11-15, K2b/K2c): a cash equivalent is "Cash Equivalent"; a
 * fund with stored sector weights is looked through (explodeHoldingBySector
 * with getEtfSectorWeights); a sectorless bond is "Fixed Income"; anything
 * else is its own sector or "Unknown". A fund whose weights fall short of
 * 100 puts the rest in its own sector (or "Unknown"); weights over 100 are
 * scaled down; either way the parts sum to the row's value exactly.
 * `lookedThrough` is false for a single-bucket row, so the sector-cap flag
 * can still skip a broad fund with NO weights. An option is read through its
 * underlying's identity (`sectorIdentity`), so a call on a fund with weights
 * is spread by them.
 */
function sectorParts(
  h: SectorIdentity,
  value: number,
  fundWeights: FundSectorWeights,
): Array<{ sector: string; value: number; lookedThrough: boolean }> {
  if (isCashEquivalentSecurity({ security_type: h.securityType, fund_category: h.fundCategory })) {
    return [{ sector: CASH_EQUIVALENT_SECTOR, value, lookedThrough: false }];
  }
  // A blank or whitespace-only sector is unclassified, not its own
  // unlabelled bucket (A3).
  const ownSector = h.sector?.trim() ? h.sector : null;
  const parts = explodeHoldingBySector(h.symbol, h.securityType, value, fundWeights, ownSector);
  const type = (h.securityType ?? "").trim().toLowerCase();
  const weighted =
    (type === "etf" || type === "mutual fund") && (fundWeights.get(h.symbol)?.length ?? 0) > 0;
  if (!weighted) return parts.map((p) => ({ ...p, lookedThrough: false }));
  const covered = parts.reduce((s, p) => s + p.value, 0);
  if (value === 0 || covered === 0) {
    return [{ sector: ownSector ?? "Unknown", value, lookedThrough: true }];
  }
  const ratio = covered / value;
  if (ratio > 1) {
    return parts.map((p) => ({ sector: p.sector, value: p.value / ratio, lookedThrough: true }));
  }
  const out = parts.map((p) => ({ ...p, lookedThrough: true }));
  const rest = value - covered;
  if (rest !== 0) out.push({ sector: ownSector ?? "Unknown", value: rest, lookedThrough: true });
  return out;
}

interface SnapshotDetail {
  snapshot: ExposureSnapshot;
  /**
   * Weight of the "Diversified" bucket that came from single-bucket rows (a
   * broad fund with NO stored weights). The sector-cap flag skips only this
   * part (A3, narrowed by K2b).
   */
  unweightedDiversifiedWeight: number;
}

function snapshot(allHoldings: HoldingRow[], fundWeights: FundSectorWeights): SnapshotDetail {
  // A leveraged or inverse fund with NO signed factor has no beta, sector or
  // factor exposure anyone can state (owner ruling 2026-11-01, stopgap): it
  // is left out of every bucket AND of the total, so the weights are over the
  // modelled book. One WITH a factor is modelled at its exposure — market
  // value times the factor (theme T2, 2026-11-07) — so a long 3x inverse
  // semiconductor fund subtracts three times its money from Technology
  // instead of adding one times it. Its own money still counts once in
  // `totalValue` and in the concentration list: leverage changes the exposure
  // a position carries, not how many dollars sit in it.
  //
  // Options (review finding S-B1, 2026-11-15): an option enters its sector
  // at its DELTA-ADJUSTED exposure (betaExposurePerValue, the per-dollar
  // ratio the beta reads), so a long put SUBTRACTS from its sector; at its
  // market value it added. An option whose Greeks cannot compute keeps its
  // market value and is counted in optionsAtMarketValue.
  //
  // Denominator: the book's NET MARKET VALUE, each option at its market
  // value. It is the dollars in the book, the same total Cash deploy uses
  // (so both cards print the same sector weight for a scope); a delta in
  // the denominator would make the book's size move with an option's Greeks
  // and shrink when a hedge is added. As with leverage, the weights are then
  // shares of net value and need not sum to 100%.
  const holdings = allHoldings.filter((h) => !h.leveragedOrInverse);
  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const grossValue = holdings.reduce((s, h) => s + Math.abs(h.marketValue), 0);
  const sectorWeights: Record<string, number> = {};
  const factorTilts: Record<FactorColumn, Record<string, number>> = Object.fromEntries(
    FACTOR_COLUMNS.map((f) => [f, {} as Record<string, number>])
  ) as Record<FactorColumn, Record<string, number>>;

  let betaWeighted = 0;
  let betaGross = 0;
  let betaEstimatedGross = 0;
  let unweightedDiversified = 0;
  let optionsAtMarketValue = 0;
  for (const h of holdings) {
    // The exposure a position carries: its money, times its signed leverage
    // factor where it has one.
    const exposureValue = h.marketValue * (h.leverageFactor ?? 1);
    // A held option at its delta-adjusted exposure where the Greeks compute
    // (betaExposurePerValue); every other row at exposureValue.
    const deltaExposure = exposureValue * h.betaExposurePerValue;
    if (h.optionAtMarketValue) optionsAtMarketValue++;
    // A STORED beta of a leveraged fund (or of the fund an option is on) is a
    // regression of the fund itself, so it already carries the leverage:
    // applying the factor again counted it twice (a book all in a 3x fund
    // with a stored beta of 3.0 read 9.0; review finding S-3). The factor is
    // kept for an ESTIMATED beta (1.0 times 3) and for the sector weights.
    const betaExposure =
      h.leverageFactor !== null && !h.betaEstimated ? h.marketValue * h.betaExposurePerValue : deltaExposure;
    const w = totalValue > 0 ? betaExposure / totalValue : 0;
    betaWeighted += w * h.beta;
    betaGross += Math.abs(betaExposure);
    if (h.betaEstimated) betaEstimatedGross += Math.abs(betaExposure);
    for (const part of sectorParts(h.sectorIdentity, deltaExposure, fundWeights)) {
      sectorWeights[part.sector] = (sectorWeights[part.sector] ?? 0) + part.value;
      if (part.sector === "Diversified" && !part.lookedThrough) unweightedDiversified += part.value;
    }
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

  const topConcentrations = symbolWeights(allHoldings).slice(0, 10);

  return {
    snapshot: {
      totalValue,
      beta: betaWeighted,
      factorTilts,
      sectorWeights,
      topConcentrations,
      betaEstimatedWeight: betaGross > 0 ? betaEstimatedGross / betaGross : 0,
      optionsAtMarketValue,
      nearMarketNeutral: isNearMarketNeutral(totalValue, grossValue),
    },
    unweightedDiversifiedWeight: totalValue > 0 ? unweightedDiversified / totalValue : 0,
  };
}

/**
 * True when a net value is not meaningfully positive relative to the gross
 * value (NEAR_NEUTRAL_NET_SHARE). An empty book (gross 0) is not flagged:
 * there is nothing to measure, and every weight is already 0.
 */
function isNearMarketNeutral(netValue: number, grossValue: number): boolean {
  if (!(grossValue > 0)) return false;
  return netValue <= NEAR_NEUTRAL_NET_SHARE * grossValue;
}

/**
 * The delta-adjusted exposure per dollar of a held option's value, by
 * security id (lib/compute/exposure.ts, `perValueDollar`: delta x spot /
 * (option close x FX), the same for every account holding the contract), or
 * undefined when the Greeks cannot compute; such a row is then read at its
 * market value and counted. A hypothetical leg on an option not held reads
 * market value too. Greeks are only computed when the rows hold an option.
 * One reader for the What-if and Cash deploy, so the two cards weigh an
 * option the same way (review finding S-B1, 2026-11-15).
 */
export function optionDeltaPerValueReader(
  db: Database.Database,
  accountIds: number[] | undefined,
  rows: Array<{ securityType: string | null }>,
): (securityId: number) => number | undefined {
  const hasOption = rows.some((r) => isOptionType(r.securityType));
  if (!hasOption) return () => undefined;
  const perValue = getOptionExposureMap(db, accountIds).perValueDollar;
  return (securityId) => {
    const ratio = perValue.get(securityId);
    return ratio !== undefined && Number.isFinite(ratio) ? ratio : undefined;
  };
}

/**
 * The quantity whose marketValue() is exactly `usd` dollars, for every
 * security type. marketValue() is linear in quantity, so the inverse is the
 * leg amount over the value of ONE unit: a bond's per-100-face quote, an
 * option's multiplier and the FX factor all come from the one valuation rule
 * instead of a hand-rolled price x multiplier divisor (which applied a bond
 * leg at 1/100 of its amount; Analysis fix wave 2026-11-15, A1).
 */
function quantityForUsd(
  usd: number,
  price: number,
  securityType: string | null,
  multiplier: number,
  usdPerUnit: number,
): number {
  return usd / marketValue(1, price, securityType, multiplier, usdPerUnit);
}

/**
 * A sell that leaves a long within this fraction of its starting quantity
 * (either side of zero) closed it: selling exactly a position's value can
 * land a hair under zero through float rounding, which is not a cap.
 */
const SELL_CLOSE_RELATIVE_TOLERANCE = 1e-9;

function applyLegs(
  db: Database.Database,
  current: HoldingRow[],
  legs: HypotheticalLeg[],
  resolve: (symbol: string) => HoldingRow | "no_price" | null
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
      const shares = quantityForUsd(leg.dollarAmount, h.price, h.securityType, h.multiplier, usdPerUnit);
      // A unit worth nothing (multiplier 0) makes the quantity infinite.
      if (!Number.isFinite(shares)) {
        dropped.push({ symbol: upper, reason: "invalid_amount" });
        continue;
      }
      const delta = leg.action === "buy" ? shares : -shares;
      const prevQuantity = h.quantity;
      h.quantity += delta;
      if (
        leg.action === "sell" &&
        prevQuantity > 0 &&
        Math.abs(h.quantity) <= SELL_CLOSE_RELATIVE_TOLERANCE * prevQuantity
      ) {
        h.quantity = 0;
      }
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
      if (synth === "no_price") {
        // Known, but no positive close on file: no quantity can be derived.
        dropped.push({ symbol: upper, reason: "no_price" });
        continue;
      }
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
      const shares = quantityForUsd(leg.dollarAmount, synth.price, synth.securityType, synth.multiplier, usdPerUnit);
      if (!Number.isFinite(shares)) {
        dropped.push({ symbol: upper, reason: "invalid_amount" });
        continue;
      }
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

function computeFlags(
  after: ExposureSnapshot,
  caps: ConstructionCaps,
  unweightedDiversifiedWeight: number,
): ExposureFlag[] {
  const flags: ExposureFlag[] = [];
  // Every flag below is a share of the net value; on a near market-neutral
  // scope those shares are not meaningful, so none is raised.
  if (after.nearMarketNeutral) return flags;
  const top1 = after.topConcentrations[0];
  if (top1 && top1.weightPct > caps.top1_max) {
    flags.push({
      severity: "warn",
      metric: "top1",
      message: `Top position ${top1.symbol} would be ${(top1.weightPct * 100).toFixed(1)}% (cap ${(caps.top1_max * 100).toFixed(0)}%)`,
      capValue: caps.top1_max,
      weightPct: top1.weightPct,
    });
  }
  const top3Sum = after.topConcentrations.slice(0, 3).reduce((s, c) => s + c.weightPct, 0);
  if (top3Sum > caps.top3_max) {
    flags.push({
      severity: "warn",
      metric: "top3",
      message: `Top 3 positions would be ${(top3Sum * 100).toFixed(1)}% (cap ${(caps.top3_max * 100).toFixed(0)}%)`,
      capValue: caps.top3_max,
      weightPct: top3Sum,
    });
  }
  for (const [sector, sectorWeight] of Object.entries(after.sectorWeights)) {
    if (sector === "Unknown") continue; // skip — concentration in unclassified positions is a data-quality issue, not a portfolio-construction risk
    // Skip the part of "Diversified" that is broad funds with NO stored
    // sector weights: such a fund spreads across every sector, so its weight
    // is not a sector bet (A3). A looked-through fund's remainder in its own
    // "Diversified" sector is read like any other bucket (K2b, 2026-11-15).
    const weight = sector === "Diversified" ? sectorWeight - unweightedDiversifiedWeight : sectorWeight;
    if (weight > caps.sector_max) {
      flags.push({
        severity: "warn",
        metric: `sector:${sector}`,
        message: `Sector ${sector} would be ${(weight * 100).toFixed(1)}% (cap ${(caps.sector_max * 100).toFixed(0)}%)`,
        capValue: caps.sector_max,
        weightPct: weight,
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
  const loaded = loadCurrentHoldings(db, accountIds);
  const deltaExposurePerValue = optionDeltaPerValueReader(db, accountIds, loaded);
  const current = loaded.map((h) => {
    if (!isOptionType(h.securityType)) return h;
    const ratio = deltaExposurePerValue(h.securityId);
    return { ...h, betaExposurePerValue: ratio ?? 1, optionAtMarketValue: ratio === undefined };
  });
  const fundWeights = getEtfSectorWeights(db);
  const before = snapshot(current, fundWeights).snapshot;
  const resolved = applyLegs(db, current, legs, (symbol) => {
    const sym = lookupSymbol(db, symbol);
    if (sym === null || sym === "no_price") return sym;
    return {
      securityId: sym.securityId,
      symbol: sym.symbol,
      securityType: sym.securityType,
      sector: sym.sector,
      fundCategory: sym.fundCategory,
      sectorIdentity: sym.sectorIdentity,
      currency: sym.currency,
      multiplier: sym.multiplier,
      quantity: 0,
      price: sym.price,
      marketValue: 0,
      beta: sym.beta,
      betaEstimated: sym.betaEstimated,
      // An option leg on a contract not held: no Greeks were computed for
      // it, so its beta and sector weight are at market value (counted).
      betaExposurePerValue: 1,
      optionAtMarketValue: isOptionType(sym.securityType),
      factors: sym.factors,
      leveragedOrInverse: sym.leveragedOrInverse,
      leverageFactor: sym.leverageFactor,
    };
  });
  const afterDetail = snapshot(resolved.rows, fundWeights);
  const after = afterDetail.snapshot;
  const caps = getCaps(db, scope);
  const flags = computeFlags(after, caps, afterDetail.unweightedDiversifiedWeight);

  const leveragedFundsNotModelled = [
    ...new Set([
      ...current.filter((h) => h.leveragedOrInverse).map((h) => h.symbol),
      ...resolved.dropped.filter((d) => d.reason === "leveraged_or_inverse_fund").map((d) => d.symbol),
    ]),
  ].sort();

  const beforeWeights = new Map(symbolWeights(current).map((c) => [c.symbol, c.weightPct]));
  const beforeWeightBySymbol: Record<string, number> = {};
  for (const c of after.topConcentrations) {
    beforeWeightBySymbol[c.symbol] = beforeWeights.get(c.symbol) ?? 0;
  }

  return {
    before,
    after,
    beforeWeightBySymbol,
    flags,
    droppedLegs: resolved.dropped,
    leveragedFundsNotModelled,
  };
}
