/**
 * Cash-Deploy solver.
 *
 * Answers the user's primary question: "I have $X to deploy in <scope> —
 * where does it go?" Computes current sector weights, looks up the
 * scope-aware benchmark composition (VTI/QQQ/SPY/DIA), identifies sector
 * gaps, then ranks watchlist candidates by gap-closure score.
 *
 * Greedy allocation: each pick covers as much of the largest remaining gap
 * as it can without breaching construction_caps. Falls back to a by-sector
 * heuristic when benchmark composition isn't seeded.
 *
 * Owner rulings of 2026-11-15 (docs/DECISIONS.md 2026-10-12, confirmed):
 *  - A pick STOPS at its sector's gap. No sector is filled past its
 *    benchmark weight; cash the gaps cannot take is reported as unallocated
 *    (`cashRemaining` + `unallocatedReason`), never poured into a name.
 *    This supersedes the 2026-10-07 "proposals add up to the cash asked
 *    for" top-up.
 *  - Sector weights are NET of short positions: signed market values, over
 *    the same signed denominator the What-if engine uses
 *    (`computeExposureDelta` keeps shorts in its book and total).
 *  - An OPTION enters its sector at its delta-adjusted exposure (review
 *    finding S-B1, 2026-11-15; `optionDeltaPerValueReader`, the reader the
 *    What-if uses), read through its underlying (a fund underlying with
 *    stored weights is spread by them). A long put therefore LOWERS its
 *    sector; at market value it raised it. An option whose Greeks cannot
 *    compute keeps its market value and is counted (`optionsAtMarketValue`).
 *    The denominator keeps every option at its MARKET VALUE (the dollars in
 *    the book), as the What-if does, so the two cards agree on every sector
 *    weight for a scope.
 *  - A multi-sector fund is credited by its look-through weights
 *    (`etf_sector_weights`) and sized so it pushes no sector past its
 *    benchmark weight.
 *
 * Owner rulings of 2026-11-16:
 *  - Ruling 24 = B, small-weight tolerance: a multi-sector fund's sectors
 *    that hold `FUND_SMALL_WEIGHT_TOLERANCE` (2%) or less of the fund may go
 *    past their benchmark weight; a sector holding more than that still may
 *    not. Single stocks and single-sector funds are unchanged. A pick that
 *    used the tolerance names the sectors in `toleranceSectors`.
 *  - Ruling 25 = A, short by choice: only the part of a sector's gap that
 *    exists on a LONG-ONLY basis is filled. Long-only dollars are the sum of
 *    every positive sector contribution (long stock and funds, and positive
 *    delta exposure such as a long call or a short put), before shorts, long
 *    puts and short calls are subtracted.
 *    Review fix FX3 A1 (2026-11-16, orchestrator decision, reversible): the
 *    long-only weight is measured on a LONG-ONLY BOOK, never over the net
 *    basis. Long-only basis = the cash being deployed + every positive sector
 *    contribution in the sectors the comparison keeps (so a cash equivalent
 *    is in it exactly when the net basis keeps it: in the "Cash Equivalent"
 *    bucket of a blended benchmark, out of an equity-only one). Over the net
 *    basis, puts shrank the denominator while staying out of the numerator
 *    and long calls entered at full delta, so long-only weights summed to
 *    1.3-1.6 of the basis and every sector looked fuller than it was. On the
 *    long-only book the weights sum to at most 1.
 *    Fillable room of a sector that carries a hedge or short = min(net room,
 *    long-only room): a pick never takes a sector past target on the net
 *    basis, and never buys back a hedge. A sector with no negative
 *    contribution has nothing held short, so its room is its net room.
 *    The cash that would have offset hedges and shorts is reported apart
 *    (`unallocatedShortDollars`, `shortHeldSectors`, each with its causes).
 */

import type Database from "better-sqlite3";
import { getBenchmarkSectorMap } from "@/lib/queries/benchmark-compositions";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { getDefaultBenchmark } from "@/lib/analysis/benchmarks";
import { computeExposureDelta, optionDeltaPerValueReader, type ExposureDelta } from "./exposure-delta";
import { explodeHoldingBySector } from "./explode-sector";
import { optionExposureFallback } from "@/lib/compute/exposure";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { marketValue } from "@/lib/valuation";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export type CashDeployMode = "benchmark" | "factor_balance" | "heuristic";

export interface SectorGap {
  sector: string;
  currentWeight: number;
  targetWeight: number;
  gapPp: number; // signed percentage-point gap: negative = underweight (deploy target)
  dollarGap: number; // signed dollar amount to fully close gap
  gapClosureScore: number; // |gapPp|, optionally boosted by theme-aware logic
  /**
   * Post-allocation residuals: what is still open after the suggested picks
   * land. `gapPp`/`dollarGap` stay the PRE-allocation figures the table and
   * the pick rationale show — only these residual fields move as the greedy
   * allocation loop spends cash against a sector.
   */
  residualGapPp: number;
  residualDollarGap: number;
}

export interface CashDeployPick {
  symbol: string;
  securityId: number | null;
  sectorTarget: string;
  allocationDollars: number;
  gapClosureScore: number;
  rationale: string;
  exposureDelta: ExposureDelta;
  /**
   * How the pick's dollars land across sectors (weights sum to about 1). A
   * single-sector name has one entry; a multi-sector fund has its
   * look-through weights.
   */
  sectorExposure: SectorExposure[];
  multiSectorFund: boolean;
  /**
   * Sectors this pick takes past their benchmark weight under the small-weight
   * tolerance (owner ruling 24 = B, 2026-11-16): each holds
   * `FUND_SMALL_WEIGHT_TOLERANCE` or less of the fund. Empty when the pick
   * stopped at every sector's gap.
   */
  toleranceSectors: string[];
}

/**
 * What makes a sector's exposure negative (review fix FX3 A2): short stock or
 * funds, long puts, short calls. A short put is LONG exposure (positive
 * delta) and is never a cause.
 */
export type ShortHeldCause = "short_stock" | "puts" | "short_calls";

/** Causes in the order the card's line names them. */
const SHORT_HELD_CAUSE_ORDER: ShortHeldCause[] = ["short_stock", "puts", "short_calls"];

/**
 * A sector whose gap is (partly) left unfilled because it comes from hedges
 * or short positions the owner holds (owner ruling 25 = A, 2026-11-16).
 * The kind is read from what was PLACED in the sector (review fix FX3 A6):
 * `not_filled` when no pick put a dollar there, `partly_filled` when one did
 * (only up to the long-only gap). `causes` names what holds the sector down.
 */
export interface ShortHeldSector {
  sector: string;
  kind: "not_filled" | "partly_filled";
  causes: ShortHeldCause[];
}

export interface SectorExposure {
  sector: string;
  weight: number;
}

/**
 * The non-equity sleeve that an equity benchmark comparison leaves out.
 * `weightPct` / `totalPct` are percentages OF THE PROJECTED PORTFOLIO
 * (holdings + cash to deploy) — i.e. the same weight the gap table used to
 * show for those buckets — so the caption quotes a number the user recognizes.
 */
export interface ExcludedSleeve {
  buckets: Array<{ sector: string; weightPct: number }>;
  totalPct: number;
}

export interface CashDeploySuggestion {
  scope: string;
  cashAmount: number;
  benchmarkSymbol: string;
  mode: CashDeployMode;
  gaps: SectorGap[];
  picks: CashDeployPick[];
  totalAllocated: number;
  /**
   * Cash the gaps could not take (owner ruling: stop at each sector's gap).
   * totalAllocated + cashRemaining = cashAmount, to the cent.
   */
  cashRemaining: number;
  /**
   * One sentence, no figure, saying why the unallocated cash OTHER than
   * `unallocatedShortDollars` is unallocated; null when there is none.
   */
  unallocatedReason: string | null;
  /**
   * Part of `cashRemaining` left out because it would only have offset
   * short positions (owner ruling 25 = A): the cash the same allocation
   * places when gaps are measured net, minus what it places on the long-only
   * gaps. Never above `cashRemaining`; 0 when no sector is short by choice.
   */
  unallocatedShortDollars: number;
  /** One sentence, no figure, for `unallocatedShortDollars`; null when it is 0. */
  unallocatedShortReason: string | null;
  /** Sectors whose gap comes (partly) from short positions, largest held-out first. */
  shortHeldSectors: ShortHeldSector[];
  /**
   * Option rows whose Greeks could not compute, so they entered the sector
   * weights at market value instead of delta-adjusted exposure.
   */
  optionsAtMarketValue: number;
  notes: string[];
  /**
   * Non-null only when the benchmark is equity-only AND the portfolio
   * actually holds one of the excluded buckets — the sleeve the gaps were
   * measured WITHOUT. Null means the table is a full-portfolio comparison.
   */
  excludedSleeve: ExcludedSleeve | null;
}

const GAP_THRESHOLD_PP = 2.0; // surface gaps of |2pp| or more

/**
 * Room under one dollar counts as filled, and no pick is smaller than one
 * dollar. Without this a sector a single name filled to the cent leaves a
 * sub-cent fragment that, divided by a fund's small weight in it, proposes a
 * pick of a few cents or dollars.
 */
const MIN_ROOM_DOLLARS = 1;
const MIN_PICK_CENTS = 100;

/**
 * Owner ruling 24 = B (2026-11-16): a multi-sector fund's sector weights of
 * this share of the fund or less may go past their benchmark weight. A
 * sector where the fund holds more still may not.
 */
export const FUND_SMALL_WEIGHT_TOLERANCE = 0.02;

/** True when a fund exposure is small enough to pass its target (ruling 24). */
function withinSmallWeightTolerance(weight: number): boolean {
  return weight <= FUND_SMALL_WEIGHT_TOLERANCE + 1e-12;
}

/** The card's plain line for a pick that used the small-weight tolerance. */
export function smallWeightToleranceLine(sectors: string[]): string {
  const pct = `${Math.round(FUND_SMALL_WEIGHT_TOLERANCE * 100)}%`;
  const one = sectors.length === 1;
  return `Allowed under the small-weight tolerance: the fund holds ${pct} or less in ${listWords(
    sectors,
  )}, so this buy may take ${one ? "that sector" : "those sectors"} a little past ${
    one ? "its" : "their"
  } benchmark weight.`;
}

const SHORT_HELD_CAUSE_WORDS: Record<ShortHeldCause, string> = {
  short_stock: "short positions",
  puts: "puts",
  short_calls: "short calls",
};

/**
 * The card's plain line for a sector short by choice (ruling 25), worded
 * from what holds the sector down (review fix FX3 A2): "short positions"
 * only when stock or funds are held short.
 */
export function shortHeldSectorLine(s: ShortHeldSector): string {
  const causes = SHORT_HELD_CAUSE_ORDER.filter((c) => s.causes.includes(c));
  const what = causes.length > 0 ? listWords(causes.map((c) => SHORT_HELD_CAUSE_WORDS[c])) : "hedges";
  return s.kind === "not_filled"
    ? `${s.sector}: you hold ${what} here; not filled.`
    : `${s.sector}: you hold ${what} here; filled only up to the gap your long positions leave.`;
}

/** The card's label for `unallocatedShortDollars` (review fix FX3 A2). */
export const SHORT_UNALLOCATED_LABEL = "Left out for sectors you have hedged or sold short:";

/** Reason for `unallocatedShortDollars`. */
export const SHORT_UNALLOCATED_REASON =
  "This part would only undo hedges or short sales you hold, so it is not placed and stays as cash.";

/** Security types a held-name fallback pick may be (no options, bonds, forex). */
const HELD_PICK_TYPES = new Set(["stock", "etf", "mutual fund"]);

/**
 * Sector buckets that are NOT part of the equity sleeve.
 *
 * These are bucket LABELS as they reach the gap table, not raw vendor
 * strings: `explodeHoldingBySector` buckets sectorless bonds as
 * "Fixed Income", `normalizeSector` passes "Fixed Income" through as a
 * canonical non-GICS label, and money-market sweep funds carry either that
 * sector or a Cash/Cash Equivalent/Money Market label from the
 * fund_category vocabulary (lib/mutations/securities.ts,
 * lib/compute/cash-equivalents.ts).
 *
 * Deliberately NOT here: "Unknown" (unclassified EQUITIES — excluding it
 * would silently shrink the sleeve) and "Diversified" (broad equity funds).
 */
const NON_EQUITY_SECTOR_BUCKETS = new Set([
  "fixed income",
  "cash",
  "cash equivalent",
  "money market",
]);

/** True when a gap-table sector bucket is fixed income or cash. */
export function isNonEquitySectorBucket(sector: string): boolean {
  return NON_EQUITY_SECTOR_BUCKETS.has(sector.trim().toLowerCase());
}

function isExcludedEquitySleeveBucket(sector: string): boolean {
  const bucket = sector.trim().toLowerCase();
  return isNonEquitySectorBucket(sector) || bucket === "diversified";
}

interface HoldingForSector {
  symbol: string;
  security_type: string | null;
  sector: string | null;
  fund_category: string | null;
  geography: string | null;
  market_cap_category: string | null;
  style: string | null;
}

const BROAD_US_INDEX_SYMBOLS = new Set([
  "SPY",
  "VOO",
  "IVV",
  "VTI",
  "ITOT",
  "VFIAX",
  "QQQ",
]);

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function isBenchmarkLikeBroadUsIndexFund(sec: HoldingForSector): boolean {
  const type = normalized(sec.security_type);
  if (type !== "etf" && type !== "mutual fund") return false;
  if (issuerSiblings(sec.symbol).some((symbol) => BROAD_US_INDEX_SYMBOLS.has(symbol.toUpperCase()))) {
    return true;
  }
  const category = normalized(sec.fund_category);
  const geography = normalized(sec.geography);
  const marketCap = normalized(sec.market_cap_category);
  const style = normalized(sec.style);
  const broadUsCategory = category === "us total market equity" || category === "us large cap equity";
  const broadCap = marketCap === "" || marketCap.includes("large") || marketCap.includes("multi");
  const blendStyle = style === "" || style === "blend";
  return broadUsCategory && geography === "us" && broadCap && blendStyle;
}

/**
 * An equity benchmark is one whose composition carries NO weight in any
 * fixed-income / cash bucket (VTI, SPY, QQQ, DIA all qualify). A blended
 * benchmark — one with a real bond sleeve — keeps the full-universe
 * comparison. An EMPTY map is heuristic mode: there is no benchmark to
 * classify, so nothing is excluded.
 */
function isEquityOnlyBenchmark(benchmarkMap: Map<string, number>): boolean {
  if (benchmarkMap.size === 0) return false;
  for (const [sector, weight] of benchmarkMap) {
    if (weight > 0 && isNonEquitySectorBucket(sector)) return false;
  }
  return true;
}

interface CurrentHoldingSummary {
  totalValue: number;
  sectorValue: Map<string, number>;
  /**
   * Long-only dollars by sector (ruling 25): every positive sector
   * contribution, before shorts, long puts and short calls are subtracted.
   */
  sectorLongValue: Map<string, number>;
  /** What makes each sector's exposure negative (FX3 A2); absent = nothing. */
  sectorNegativeCauses: Map<string, Set<ShortHeldCause>>;
  heldCandidates: WatchlistCandidate[];
  optionsAtMarketValue: number;
}

function loadCurrentHoldings(
  db: Database.Database,
  accountIds: number[] | undefined,
  benchmarkMap: Map<string, number>
): CurrentHoldingSummary {
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
        s.geography,
        s.market_cap_category,
        s.style,
        s.currency,
        s.option_type,
        COALESCE(s.multiplier, 1) AS multiplier,
        s_u.symbol AS u_symbol,
        s_u.security_type AS u_security_type,
        s_u.sector AS u_sector,
        s_u.fund_category AS u_fund_category,
        s_u.geography AS u_geography,
        s_u.market_cap_category AS u_market_cap_category,
        s_u.style AS u_style,
        SUM(lh.quantity) AS quantity,
        lp.close_price AS price
      FROM latest_holdings lh
      JOIN securities s ON s.id = lh.security_id
      -- An option's underlying: its sector identity (S-B1).
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN latest_prices lp ON lp.security_id = s.id
      WHERE lp.close_price IS NOT NULL AND lp.close_price > 0
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
      geography: string | null;
      market_cap_category: string | null;
      style: string | null;
      currency: string | null;
      option_type: string | null;
      multiplier: number;
      u_symbol: string | null;
      u_security_type: string | null;
      u_sector: string | null;
      u_fund_category: string | null;
      u_geography: string | null;
      u_market_cap_category: string | null;
      u_style: string | null;
      quantity: number;
      price: number;
    }>;

  const etfWeights = getEtfSectorWeights(db);
  const deltaPerValue = optionDeltaPerValueReader(
    db,
    accountIds,
    rows.map((r) => ({ securityType: r.security_type })),
  );
  const sectorValue = new Map<string, number>();
  const sectorLongValue = new Map<string, number>();
  const sectorNegativeCauses = new Map<string, Set<ShortHeldCause>>();
  const heldCandidatesBySymbol = new Map<string, WatchlistCandidate>();
  let totalValue = 0;
  let optionsAtMarketValue = 0;
  for (const r of rows) {
    const mv = marketValue(r.quantity, r.price, r.security_type, r.multiplier, getUsdPerUnit(db, r.currency));
    // Shorts are KEPT (owner ruling 2026-11-15): a short's negative market
    // value nets against its sector and the total, as in computeExposureDelta
    // — dropping it showed a nearly flat sector as a large long weight.
    if (!Number.isFinite(mv) || mv === 0) continue;
    // The denominator takes every row at market value, options included.
    totalValue += mv;
    // An option lands in its sector at its delta-adjusted exposure, read
    // through its underlying; with no Greeks, at market value (counted).
    const isOption = normalized(r.security_type) === "option";
    let sectorDollars = mv;
    // The row's economic direction: long exposure (+1) or a hedge / short
    // (-1). For an option with no Greeks the net weights keep its market
    // value (What-if parity), but its direction comes from
    // optionExposureFallback (a long put or a short call is negative, a
    // short put positive), so a long put never counts as long exposure (FX3
    // A6).
    let direction = Math.sign(mv);
    let identity: HoldingForSector = r;
    if (isOption) {
      const ratio = deltaPerValue(r.security_id);
      if (ratio === undefined) {
        optionsAtMarketValue++;
        direction = Math.sign(optionExposureFallback(r.option_type, mv));
      } else {
        sectorDollars = mv * ratio;
        direction = Math.sign(sectorDollars);
      }
      if (r.u_symbol !== null) {
        identity = {
          symbol: r.u_symbol,
          security_type: r.u_security_type,
          sector: r.u_sector?.trim() ? r.u_sector : r.sector,
          fund_category: r.u_fund_category,
          geography: r.u_geography,
          market_cap_category: r.u_market_cap_category,
          style: r.u_style,
        };
      }
    }
    const cashEquivalent = isCashEquivalentSecurity({
      security_type: identity.security_type,
      fund_category: identity.fund_category,
    });
    // An option on a broad index fund with no stored weights stays in the
    // fund's own bucket ("Diversified"), as the What-if puts it, rather than
    // being spread by the benchmark the way a HELD broad fund is here: the
    // two cards then print the same sector weights for the scope. (A held
    // unweighted broad fund is still spread here and not in the What-if; that
    // difference predates option look-through.)
    const parts = cashEquivalent
      ? [{ sector: "Cash Equivalent", value: sectorDollars }]
      : isOption
        ? explodeHoldingBySector(identity.symbol, identity.security_type, sectorDollars, etfWeights, identity.sector)
        : benchmarkSectorParts(identity, sectorDollars, etfWeights, benchmarkMap);
    const cause: ShortHeldCause | null =
      direction >= 0
        ? null
        : !isOption
          ? "short_stock"
          : normalized(r.option_type) === "put"
            ? "puts"
            : "short_calls";
    for (const part of parts) {
      sectorValue.set(part.sector, (sectorValue.get(part.sector) ?? 0) + part.value);
      if (part.value === 0) continue;
      if (cause === null) {
        // Long exposure: its own dollars (a no-Greeks short put's are signed
        // negative in the net weights, so take the size).
        sectorLongValue.set(part.sector, (sectorLongValue.get(part.sector) ?? 0) + Math.abs(part.value));
      } else {
        const set = sectorNegativeCauses.get(part.sector) ?? new Set<ShortHeldCause>();
        set.add(cause);
        sectorNegativeCauses.set(part.sector, set);
      }
    }
    // A held-name fallback is a stock or fund held LONG: "buying" a name held
    // short would be covering it, and an option's dollars do not land in its
    // sector one for one (a long put on a sector fund is a SHORT exposure).
    if (isOption || cashEquivalent || mv <= 0 || !HELD_PICK_TYPES.has(normalized(r.security_type))) continue;
    const exposure = exposureOfParts(parts, mv);
    if (exposure.length === 0) continue;
    if (exposure.length === 1 && isExcludedEquitySleeveBucket(exposure[0].sector)) continue;
    heldCandidatesBySymbol.set(r.symbol, {
      symbol: r.symbol,
      securityId: r.security_id,
      sector: exposure.length === 1 ? exposure[0].sector : r.sector,
      thesis: r.name ? `Held name: ${r.name}` : "Held name",
      exposure,
    });
  }

  return {
    totalValue,
    sectorValue,
    sectorLongValue,
    sectorNegativeCauses,
    heldCandidates: Array.from(heldCandidatesBySymbol.values()),
    optionsAtMarketValue,
  };
}

interface WatchlistCandidate {
  symbol: string;
  securityId: number;
  sector: string | null;
  thesis: string | null;
  /** Where a dollar of this name lands, by sector (look-through for a fund). */
  exposure: SectorExposure[];
}

/** Sector parts of one holding, turned into weights per dollar. */
function exposureOfParts(
  parts: Array<{ sector: string; value: number }>,
  fundValue: number
): SectorExposure[] {
  if (!(fundValue > 0)) return [];
  const bySector = new Map<string, number>();
  for (const p of parts) {
    if (!(p.value > 0)) continue;
    bySector.set(p.sector, (bySector.get(p.sector) ?? 0) + p.value);
  }
  // Look-through weights are per dollar of the FUND, so divide by the fund's
  // value (the explode helper's input), not by the parts' sum: a weight set
  // that sums under 100% leaves the remainder unassigned, never inflated.
  return Array.from(bySector.entries()).map(([sector, value]) => ({ sector, weight: value / fundValue }));
}

function benchmarkSectorParts(
  r: HoldingForSector,
  marketValue: number,
  etfWeights: Map<string, Array<{ sector: string; weight_pct: number }>>,
  benchmarkMap: Map<string, number>
): Array<{ sector: string; value: number }> {
  const parts = explodeHoldingBySector(r.symbol, r.security_type, marketValue, etfWeights, r.sector);
  const onlyDiversified = parts.length === 1 && normalized(parts[0].sector) === "diversified";
  if (!onlyDiversified || benchmarkMap.size === 0 || !isBenchmarkLikeBroadUsIndexFund(r)) return parts;
  return Array.from(benchmarkMap.entries())
    .filter(([, weight]) => weight > 0)
    .map(([sector, weight]) => ({ sector, value: marketValue * weight }));
}

function loadWatchlistCandidates(
  db: Database.Database,
  scope: string,
  benchmarkMap: Map<string, number>
): WatchlistCandidate[] {
  // Group names follow the convention "<scope>_buy" (e.g., "vanguard_buy",
  // "ibkr_buy_next", "roth_buy_next"). Match all groups that contain the
  // scope token so renames don't silently break the lookup.
  const groupPattern = `%${scope}%`;

  const rows = db
    .prepare(
      `
      SELECT
        s.id AS securityId,
        s.symbol,
        s.sector,
        s.security_type,
        s.fund_category,
        s.geography,
        s.market_cap_category,
        s.style,
        w.thesis
      FROM watchlist w
      JOIN securities s ON s.id = w.security_id
      WHERE w.is_active = 1
        AND (w.group_name LIKE ? OR w.group_name = 'default')
      ORDER BY w.added_date DESC
    `
    )
    .all(groupPattern) as Array<{
      securityId: number;
      symbol: string;
      sector: string | null;
      security_type: string | null;
      fund_category: string | null;
      geography: string | null;
      market_cap_category: string | null;
      style: string | null;
      thesis: string | null;
    }>;

  const etfWeights = getEtfSectorWeights(db);
  const seen = new Set<string>();
  const out: WatchlistCandidate[] = [];
  for (const r of rows) {
    // One row per symbol: a name in two matching groups must not be
    // proposed (and capped) twice.
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    const exposure = isCashEquivalentSecurity(r)
      ? []
      : exposureOfParts(benchmarkSectorParts(r, 1, etfWeights, benchmarkMap), 1);
    out.push({
      symbol: r.symbol,
      securityId: r.securityId,
      sector: exposure.length === 1 ? exposure[0].sector : r.sector,
      thesis: r.thesis,
      exposure,
    });
  }
  return out;
}

interface SectorGapResult {
  gaps: SectorGap[];
  excludedSleeve: ExcludedSleeve | null;
  /**
   * Denominator every gap weight and dollar figure is measured against —
   * the projected total, minus the excluded sleeve when the benchmark is
   * equity-only. Callers that move dollars into a gap must use THIS total,
   * not the portfolio total, or the post-allocation gapPp drifts.
   */
  gapBasisTotal: number;
  /**
   * Dollars each sector can still take before its LONG-ONLY dollars reach
   * its benchmark weight (never negative; ruling 25), for EVERY sector —
   * including gaps under the 2pp display threshold and sectors already at or
   * past target (0). A pick may spend at most this in any sector it lands in
   * (a fund's small weights excepted, ruling 24).
   */
  roomBySector: Map<string, number>;
  /** The same room measured on NET dollars (shorts subtracted): never less. */
  netRoomBySector: Map<string, number>;
  /**
   * The long-only book (FX3 A1): the cash being deployed plus every positive
   * sector contribution in the sectors compared. 0 when nothing is compared.
   */
  longBasisTotal: number;
}

function computeSectorGaps(
  current: CurrentHoldingSummary,
  benchmarkMap: Map<string, number>,
  cashAmount: number
): SectorGapResult {
  // Project current weights AFTER adding cash to the denominator —
  // otherwise gaps are measured against the pre-deploy total, which
  // overweights the cash-receiving sector after the fact.
  const projectedTotal = current.totalValue + cashAmount;

  // Against an all-equity index, fixed income and cash can never be closed
  // by deploying cash (target is structurally 0%), and leaving those dollars
  // in the denominator understates every equity sector's weight. Measure the
  // equity sleeve on its own (the cash being deployed stays in the basis, so
  // sector weights are shares of equity sleeve + deploy cash — see
  // equitySleeveCaptionLead, which must say the same thing).
  const equityOnly = isEquityOnlyBenchmark(benchmarkMap);
  const excludedBuckets: Array<{ sector: string; weightPct: number }> = [];
  let excludedDollars = 0;
  if (equityOnly) {
    for (const [sector, value] of current.sectorValue) {
      // Net figures: a net-short excluded bucket is excluded at its signed value.
      if (!isExcludedEquitySleeveBucket(sector) || value === 0) continue;
      excludedDollars += value;
      excludedBuckets.push({
        sector,
        weightPct: projectedTotal > 0 ? (value / projectedTotal) * 100 : 0,
      });
    }
    excludedBuckets.sort((a, b) => b.weightPct - a.weightPct);
  }
  const gapBasisTotal = projectedTotal - excludedDollars;
  const excludedSleeve: ExcludedSleeve | null =
    excludedBuckets.length > 0
      ? {
          buckets: excludedBuckets,
          totalPct: excludedBuckets.reduce((s, b) => s + b.weightPct, 0),
        }
      : null;

  const gaps: SectorGap[] = [];
  const roomBySector = new Map<string, number>();
  const netRoomBySector = new Map<string, number>();
  // Ruling 25 on a LONG-ONLY BOOK (FX3 A1): long-only dollars over the
  // gross long exposure of the compared sectors plus the cash being
  // deployed. A cash equivalent is a positive contribution in its own
  // bucket, so it is in this book exactly when the net basis keeps it.
  let longBasisTotal = cashAmount;
  for (const [sector, v] of current.sectorLongValue) {
    if (equityOnly && isExcludedEquitySleeveBucket(sector)) continue;
    longBasisTotal += v;
  }

  // Denominator (owner ruling 2026-11-15): the scope's NET market value
  // (longs plus signed shorts, as computeExposureDelta totals its book) plus
  // the cash being deployed, minus the excluded sleeve when the benchmark is
  // equity-only. At zero or below there is no sector weight to measure, so
  // nothing is compared and nothing is allocated.
  if (!(gapBasisTotal > 0)) {
    return { gaps, excludedSleeve, gapBasisTotal, roomBySector, netRoomBySector, longBasisTotal: 0 };
  }

  const allSectors = new Set<string>([
    ...current.sectorValue.keys(),
    ...benchmarkMap.keys(),
  ]);

  for (const sector of allSectors) {
    // Excluded sleeve buckets leave the table entirely — a 0% target they
    // can never close is not an actionable gap. Buckets the index genuinely
    // holds at 0% (a GICS sector outside the index, e.g. QQQ's Financials)
    // stay, because cash CAN close those.
    if (equityOnly && isExcludedEquitySleeveBucket(sector)) continue;

    const currentDollars = current.sectorValue.get(sector) ?? 0;
    const currentWeight = currentDollars / gapBasisTotal;
    const targetWeight = benchmarkMap.get(sector) ?? 0;
    const longDollars = current.sectorLongValue.get(sector) ?? 0;
    const netRoom = Math.max(0, gapBasisTotal * targetWeight - currentDollars);
    netRoomBySector.set(sector, netRoom);
    // Ruling 25: only the gap that exists on the long-only book is fillable,
    // and never more than the net room, so no pick takes a sector past target
    // on the net basis. A sector with no hedge or short keeps its net room.
    const hedged = (current.sectorNegativeCauses.get(sector)?.size ?? 0) > 0;
    const longRoom = Math.max(0, longBasisTotal * targetWeight - longDollars);
    roomBySector.set(sector, hedged ? Math.min(netRoom, longRoom) : netRoom);
    const gapPp = (currentWeight - targetWeight) * 100;
    const dollarGap = gapBasisTotal * (targetWeight - currentWeight);

    if (Math.abs(gapPp) >= GAP_THRESHOLD_PP) {
      gaps.push({
        sector,
        currentWeight,
        targetWeight,
        gapPp,
        dollarGap,
        gapClosureScore: Math.abs(gapPp),
        residualGapPp: gapPp,
        residualDollarGap: dollarGap,
      });
    }
  }

  // Sort by largest underweight first (most negative gapPp = best target)
  gaps.sort((a, b) => a.gapPp - b.gapPp);
  return { gaps, excludedSleeve, gapBasisTotal, roomBySector, netRoomBySector, longBasisTotal };
}

/** One sector of the long-only book (FX3 A1), for tests and diagnostics. */
export interface LongOnlySector {
  sector: string;
  /** Long-only dollars: positive contributions only. */
  longDollars: number;
  /** longDollars over the long-only basis. Sums to at most 1 over sectors. */
  longWeight: number;
  /** Net dollars: longs plus signed shorts and hedges. */
  netDollars: number;
  targetWeight: number;
  /** Dollars a pick may put here (min of net and long-only room). */
  fillableDollars: number;
  causes: ShortHeldCause[];
}

/**
 * The long-only book Cash deploy sizes picks on (ruling 25, FX3 A1). Read
 * only; the suggestion itself does not carry it.
 */
export function measureLongOnlyBook(
  db: Database.Database,
  scope: string,
  accountIds: number[] | undefined,
  cashAmount: number,
): { longBasisTotal: number; gapBasisTotal: number; sectors: LongOnlySector[] } {
  const benchmarkMap = getBenchmarkSectorMap(db, getDefaultBenchmark(scope));
  const current = loadCurrentHoldings(db, accountIds, benchmarkMap);
  const g = computeSectorGaps(current, benchmarkMap, cashAmount);
  const sectors: LongOnlySector[] = Array.from(g.roomBySector.entries())
    .map(([sector, room]) => {
      const longDollars = current.sectorLongValue.get(sector) ?? 0;
      return {
        sector,
        longDollars,
        longWeight: g.longBasisTotal > 0 ? longDollars / g.longBasisTotal : 0,
        netDollars: current.sectorValue.get(sector) ?? 0,
        targetWeight: benchmarkMap.get(sector) ?? 0,
        fillableDollars: room,
        causes: SHORT_HELD_CAUSE_ORDER.filter((c) => current.sectorNegativeCauses.get(sector)?.has(c)),
      };
    })
    .sort((a, b) => a.sector.localeCompare(b.sector));
  return { longBasisTotal: g.longBasisTotal, gapBasisTotal: g.gapBasisTotal, sectors };
}

/**
 * Caption lead-in for the gap table when the comparison ran on the equity
 * sleeve. The bucket weights themselves are portfolio-derived, so the
 * component renders them through `<Pct>` rather than baking them in here.
 */
export function equitySleeveCaptionLead(benchmarkSymbol: string): string {
  return `Sector gaps vs ${benchmarkSymbol} are measured on the equity sleeve — ${benchmarkSymbol} holds no fixed income, cash, or non-comparable diversified funds, so those are excluded from current weights, which are shares of the equity sleeve plus the cash being deployed:`;
}


/**
 * Caption for the gap table (owner ruling 2026-11-15): every weight is a
 * NET weight, longs plus signed shorts, over the scope's net value.
 */
export const NET_OF_SHORTS_CAPTION =
  "Weights are net of short positions, with options counted at their delta-adjusted exposure: a short or a long put counts against its sector, and every position counts at its market value in the total. Picks are sized on the long-only book (long positions plus the cash being deployed), so a hedge or short you hold is not bought back.";

export interface SuggestAllocationOptions {
  activeThemes?: import("./macro-themes").MacroTheme[];
}

/**
 * Suggest how to deploy cash across watchlist candidates to close benchmark
 * gaps. Greedy: pick the highest-scoring candidate, allocate up to
 * min(remaining_cash, per_name_cap, the room left in every sector that binds
 * the name — all of them, except a fund's small weights, ruling 24). Repeat. Cash no gap can take stays unallocated (owner ruling,
 * docs/DECISIONS.md 2026-10-12, confirmed 2026-11-15).
 */
export function suggestAllocation(
  db: Database.Database,
  scope: string,
  accountIds: number[] | undefined,
  cashAmount: number,
  opts: SuggestAllocationOptions = {}
): CashDeploySuggestion {
  const benchmarkSymbol = getDefaultBenchmark(scope);
  const benchmarkMap = getBenchmarkSectorMap(db, benchmarkSymbol);
  const current = loadCurrentHoldings(db, accountIds, benchmarkMap);
  const watchlist = loadWatchlistCandidates(db, scope, benchmarkMap);
  const notes: string[] = [];

  const mode: CashDeployMode = benchmarkMap.size === 0 ? "heuristic" : "benchmark";
  if (mode === "heuristic") {
    notes.push(
      `No composition data for benchmark ${benchmarkSymbol}. Falling back to gap detection on current sectors only.`
    );
  }
  // A zero, negative or non-finite amount places nothing and leaves nothing
  // "unallocated": there is no cash to deploy (review finding S-6; the route
  // answers 400 before reaching here). A negative remainder used to be
  // returned with no reason.
  if (!Number.isFinite(cashAmount) || cashAmount <= 0) {
    return {
      scope,
      cashAmount: Number.isFinite(cashAmount) ? cashAmount : 0,
      benchmarkSymbol,
      mode,
      gaps: [],
      picks: [],
      totalAllocated: 0,
      cashRemaining: 0,
      unallocatedReason: NO_CASH_REASON,
      unallocatedShortDollars: 0,
      unallocatedShortReason: null,
      shortHeldSectors: [],
      notes: [...notes, NO_CASH_REASON],
      excludedSleeve: null,
      optionsAtMarketValue: current.optionsAtMarketValue,
    };
  }
  if (watchlist.length === 0) {
    notes.push(
      `No active watchlist candidates for scope ${scope}. Add tickers to your ${scope}_buy watchlist group.`
    );
  }

  const {
    gaps: rawGaps,
    excludedSleeve,
    gapBasisTotal,
    roomBySector,
    netRoomBySector,
  } = computeSectorGaps(current, benchmarkMap, cashAmount);
  // Apply theme-aware boost to gapClosureScore before ranking candidates.
  const gaps = applyThemeAwareBoost(rawGaps, opts.activeThemes ?? []);

  // The rationale quotes the gap a pick may FILL (FX3 A3): the fillable room
  // in pp of the same basis the table uses. Equal to the table's gap for a
  // sector with no hedge or short; smaller where ruling 25 holds part back.
  const fillable: FillableGaps = { room: roomBySector, netRoom: netRoomBySector, basis: gapBasisTotal };
  const rankedWatchlist = watchlist
    .map((c) => rankCandidate(c, gaps, 1, false, fillable))
    .filter((x): x is RankedCandidate => x !== null)
    .sort((a, b) => b.score - a.score);
  const watchlistSymbols = new Set(watchlist.map((c) => c.symbol));
  const heldFallback = current.heldCandidates
    .filter((c) => !watchlistSymbols.has(c.symbol))
    .map((c) => rankCandidate(c, gaps, 0.9, true, fillable))
    .filter((x): x is RankedCandidate => x !== null)
    .sort((a, b) => b.score - a.score);
  const ranked = [...rankedWatchlist, ...heldFallback];

  // Per-name cap: don't allocate more than top1_max × projected total to any
  // single position. Reads construction_caps_<scope> from settings.
  const capsRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`construction_caps_${scope}`) as { value: string } | undefined;
  let top1Cap = 0.10;
  if (capsRow) {
    try {
      const parsed = JSON.parse(capsRow.value) as { top1_max?: number };
      if (typeof parsed.top1_max === "number") top1Cap = parsed.top1_max;
    } catch {
      // keep default
    }
  }
  // The per-name cap is a PORTFOLIO construction rule ("no single position
  // above top1_max of the book"), so it keeps the full projected total even
  // when the gaps themselves are measured on the equity sleeve.
  const projectedTotal = current.totalValue + cashAmount;
  const perNameCapCents = Math.max(0, Math.round(projectedTotal * top1Cap * 100));

  const cashAskedCents = Math.round(cashAmount * 100);
  const plan = planPicks(ranked, roomBySector, cashAskedCents, perNameCapCents);

  // Ruling 25: sectors whose net gap is wider than their fillable gap are
  // (partly) held by a hedge or short. Their held-out part is never filled.
  // The kind comes from what was actually PLACED there (FX3 A6): a sector no
  // pick reached is "not filled", whatever room it had.
  const placedBySector = new Map<string, number>();
  for (const { candidate, cents } of plan.plans) {
    for (const e of candidate.exposure) {
      if (!(e.weight > 0)) continue;
      placedBySector.set(e.sector, (placedBySector.get(e.sector) ?? 0) + (cents / 100) * e.weight);
    }
  }
  const shortHeldSectors: ShortHeldSector[] = Array.from(netRoomBySector.entries())
    .map(([sector, net]) => ({ sector, heldOut: net - (roomBySector.get(sector) ?? 0) }))
    .filter((x) => x.heldOut >= MIN_ROOM_DOLLARS)
    .sort((a, b) => b.heldOut - a.heldOut || a.sector.localeCompare(b.sector))
    .map((x): ShortHeldSector => ({
      sector: x.sector,
      kind: (placedBySector.get(x.sector) ?? 0) >= MIN_ROOM_DOLLARS ? "partly_filled" : "not_filled",
      causes: SHORT_HELD_CAUSE_ORDER.filter((c) => current.sectorNegativeCauses.get(x.sector)?.has(c)),
    }));
  // The cash left out for them: what the same allocation would place on the
  // NET gaps, minus what it places on the long-only gaps.
  let shortCents = 0;
  if (shortHeldSectors.length > 0 && plan.remainingCents > 0) {
    const netPlan = planPicks(ranked, netRoomBySector, cashAskedCents, perNameCapCents);
    const placedNet = cashAskedCents - netPlan.remainingCents;
    const placedLong = cashAskedCents - plan.remainingCents;
    shortCents = Math.min(plan.remainingCents, Math.max(0, placedNet - placedLong));
  }

  const picks: CashDeployPick[] = [];
  for (const { candidate, cents, toleranceSectors } of plan.plans) {
    const allocation = cents / 100;
    const exposureDelta = computeExposureDelta(db, scope, accountIds, [
      { symbol: candidate.symbol, action: "buy", dollarAmount: allocation },
    ]);
    picks.push({
      symbol: candidate.symbol,
      securityId: candidate.securityId,
      sectorTarget: candidate.sectorTarget,
      allocationDollars: allocation,
      gapClosureScore: candidate.score,
      rationale:
        toleranceSectors.length > 0
          ? candidate.rationale.replace(FUND_SIZING_PHRASE, FUND_SIZING_PHRASE_TOLERANCE)
          : candidate.rationale,
      exposureDelta,
      sectorExposure: candidate.exposure,
      multiSectorFund: candidate.multiSectorFund,
      toleranceSectors,
    });
    // gapPp/dollarGap (what the table and the rationale show) never change
    // after computeSectorGaps returns; only the residual fields (the "After
    // picks" column) move. residualDollarGap is POSITIVE for an underweight
    // sector (dollars still needed); residualGapPp is NEGATIVE — both move
    // toward 0 as cash lands (a fund's small weight may carry it past 0,
    // ruling 24).
    for (const e of candidate.exposure) {
      if (!(e.weight > 0)) continue;
      const spent = allocation * e.weight;
      const gap = gaps.find((g) => g.sector === e.sector);
      if (!gap) continue;
      gap.residualDollarGap -= spent;
      // Same denominator the gap was measured against (the equity sleeve when
      // the benchmark is equity-only), otherwise the gap only partly unwinds.
      gap.residualGapPp += (spent / gapBasisTotal) * 100;
    }
  }

  const cashRemainingCents = plan.remainingCents;
  const allocatedCents = cashAskedCents - cashRemainingCents;
  const totalAllocated = allocatedCents / 100;
  const cashRemaining = cashRemainingCents / 100;
  const restCents = cashRemainingCents - shortCents;
  const roomLeft = plan.room;

  let unallocatedReason: string | null = null;
  if (restCents > 0) {
    const openRoom = Array.from(roomLeft.values())
      .filter((v) => v >= MIN_ROOM_DOLLARS)
      .reduce((s, v) => s + v, 0);
    if (!(gapBasisTotal > 0)) {
      unallocatedReason =
        "The scope's net value after short positions is zero or negative, so there are no sector weights to close and nothing was placed.";
    } else if (openRoom < 0.01) {
      unallocatedReason =
        shortHeldSectors.length > 0
          ? "Every underweight sector is filled as far as your long positions leave room; the rest stays as cash rather than pushing a sector past its benchmark weight."
          : "Every underweight sector is filled to its benchmark weight; the rest stays as cash rather than pushing a sector past it.";
    } else if (picks.length === 0) {
      unallocatedReason = nothingPlacedReason(gaps, ranked, roomLeft, perNameCapCents);
    } else {
      unallocatedReason =
        "Each pick stops at its sector's gap to the benchmark or at the per-name cap, and no other watchlist or held name can fill the sectors still underweight; the rest stays as cash.";
    }
  }

  return {
    scope,
    cashAmount,
    benchmarkSymbol,
    mode,
    gaps,
    picks,
    totalAllocated,
    cashRemaining,
    unallocatedReason,
    unallocatedShortDollars: shortCents / 100,
    unallocatedShortReason: shortCents > 0 ? SHORT_UNALLOCATED_REASON : null,
    shortHeldSectors,
    notes,
    excludedSleeve,
    optionsAtMarketValue: current.optionsAtMarketValue,
  };
}

interface PlannedPick {
  candidate: RankedCandidate;
  cents: number;
  toleranceSectors: string[];
}

/**
 * The exposures that bound a candidate's size. Every positive weight binds,
 * except (ruling 24) a multi-sector fund's weights of
 * `FUND_SMALL_WEIGHT_TOLERANCE` or less, as long as at least one of its
 * sectors is above that line (a fund made only of slivers stays strict).
 *
 * Overshoot bound (review note FX3 A5, deliberately no cumulative cap): a
 * non-binding weight is at most FUND_SMALL_WEIGHT_TOLERANCE of its fund, so
 * the dollars any one sector receives past its room are at most 2% of the
 * cash placed through tolerance picks, however many funds stack there
 * (synthetic worst case about 1.5pp of the book with 20 funds; real data
 * 0.14pp). Pinned in tests/compute/cash-deploy-fx3-review.test.ts.
 */
function bindingExposures(c: WatchlistCandidate): SectorExposure[] {
  const positive = c.exposure.filter((e) => e.weight > 0);
  const tolerant =
    c.exposure.length > 1 && positive.some((e) => !withinSmallWeightTolerance(e.weight));
  return tolerant ? positive.filter((e) => !withinSmallWeightTolerance(e.weight)) : positive;
}

/**
 * Greedy allocation over ranked candidates: each takes min(remaining cash,
 * per-name cap, the room left in every sector that binds it), floored to the
 * cent so a binding sector never lands a fraction of a cent past its room.
 * Pure: works on a copy of the room map, which it returns spent.
 */
function planPicks(
  ranked: RankedCandidate[],
  roomInit: Map<string, number>,
  cashCents: number,
  perNameCapCents: number,
): { plans: PlannedPick[]; remainingCents: number; room: Map<string, number> } {
  const room = new Map(roomInit);
  const plans: PlannedPick[] = [];
  let remaining = cashCents;
  for (const candidate of ranked) {
    if (remaining <= 0) break;
    let limitCents = Math.min(remaining, perNameCapCents);
    for (const e of bindingExposures(candidate)) {
      const r = room.get(e.sector) ?? 0;
      if (r < MIN_ROOM_DOLLARS) {
        limitCents = 0;
        break;
      }
      limitCents = Math.min(limitCents, Math.floor((r * 100) / e.weight + 1e-6));
    }
    if (limitCents < MIN_PICK_CENTS) continue;
    const allocation = limitCents / 100;
    const toleranceSectors: string[] = [];
    for (const e of candidate.exposure) {
      if (!(e.weight > 0)) continue;
      const before = room.get(e.sector) ?? 0;
      const spent = allocation * e.weight;
      // Only a non-binding (small) weight can pass its room.
      if (spent > before + 0.005) toleranceSectors.push(e.sector);
      room.set(e.sector, Math.max(0, before - spent));
    }
    plans.push({ candidate, cents: limitCents, toleranceSectors });
    remaining -= limitCents;
  }
  return { plans, remainingCents: remaining, room };
}

/** The reason for an amount that is zero, negative or not a number. */
export const NO_CASH_REASON = "There is no cash to deploy: enter an amount above zero.";

/** Sectors named before "among others". */
const REASON_SECTOR_LIMIT = 3;

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Why nothing was placed although a shown sector is underweight with room
 * (review finding S-5). Names the largest underweight sectors with room and,
 * for each kind of candidate, what stopped it: no single name on the
 * watchlist or held sits in them (or the per-name cap leaves no room), and
 * the broad funds considered also add to sectors already at or past their
 * benchmark weight (named), or no fund covers them. No figure. The sector
 * names are the ones the gap table already shows.
 */
function nothingPlacedReason(
  gaps: SectorGap[],
  ranked: RankedCandidate[],
  roomBySector: Map<string, number>,
  perNameCapCents: number,
): string {
  const open = gaps
    .filter((g) => g.gapPp < 0 && (roomBySector.get(g.sector) ?? 0) >= MIN_ROOM_DOLLARS)
    .sort((a, b) => a.gapPp - b.gapPp);
  if (open.length === 0) {
    return "No watchlist or held name sits in an underweight sector without pushing another sector past its benchmark weight, so nothing was placed.";
  }
  const openSet = new Set(open.map((g) => g.sector));
  const named = open.slice(0, REASON_SECTOR_LIMIT).map((g) => g.sector);
  const subject = `${listWords(named)}${open.length > named.length ? ", among others," : ""} ${
    open.length === 1 ? "is" : "are"
  } underweight`;
  const them = open.length === 1 ? "it" : "them";

  const singles = ranked.filter((c) => c.exposure.length === 1 && openSet.has(c.exposure[0].sector));
  const singleClause =
    singles.length === 0
      ? `no single name on the watchlist or held sits in ${them}`
      : perNameCapCents < MIN_PICK_CENTS
        ? `the per-name cap leaves no room for the single names there`
        : `no single name there could be sized without passing a sector's benchmark weight`;

  const funds = ranked.filter((c) => c.exposure.length > 1 && c.exposure.some((e) => openSet.has(e.sector)));
  const blocked = new Set<string>();
  for (const f of funds) {
    for (const e of bindingExposures(f)) {
      if ((roomBySector.get(e.sector) ?? 0) < MIN_ROOM_DOLLARS) blocked.add(e.sector);
    }
  }
  // Most overweight first (the table's own gaps), then any under the 2pp line.
  const overBy = new Map(gaps.map((g) => [g.sector, g.gapPp]));
  const blockedSorted = Array.from(blocked).sort(
    (x, y) => (overBy.get(y) ?? 0) - (overBy.get(x) ?? 0) || x.localeCompare(y),
  );
  const blockedNamed = blockedSorted.slice(0, REASON_SECTOR_LIMIT);
  const blockedWords =
    blockedSorted.length > blockedNamed.length
      ? `${blockedNamed.join(", ")} and other sectors`
      : listWords(blockedNamed);
  const fundClause =
    funds.length === 0
      ? "no fund on the watchlist or held covers them either"
      : blockedSorted.length > 0
        ? `the funds considered also add to ${blockedWords}, already at or past ${
            blockedSorted.length === 1 ? "its" : "their"
          } benchmark weight`
        : "the per-name cap leaves no room for the funds considered";
  return `${subject}, but ${singleClause}, and ${fundClause}; nothing was placed.`;
}

const FUND_SIZING_PHRASE = "sized so no sector passes its benchmark weight";
/** Ruling 24: the sizing phrase when the small-weight tolerance was used. */
const FUND_SIZING_PHRASE_TOLERANCE = `sized so no sector where the fund holds more than ${Math.round(
  FUND_SMALL_WEIGHT_TOLERANCE * 100,
)}% passes its benchmark weight`;

type RankedCandidate = WatchlistCandidate & {
  score: number;
  sectorTarget: string;
  rationale: string;
  multiSectorFund: boolean;
};

/**
 * Score a candidate against the underweight gaps its dollars land in. A
 * single-sector name scores its sector's gap; a multi-sector fund scores the
 * weight-averaged gaps it touches and targets the one it closes most.
 */
interface FillableGaps {
  room: Map<string, number>;
  netRoom: Map<string, number>;
  basis: number;
}

function rankCandidate(
  c: WatchlistCandidate,
  gaps: SectorGap[],
  scoreFactor: number,
  heldName: boolean,
  fillable: FillableGaps,
): RankedCandidate | null {
  const hits = c.exposure
    .filter((e) => e.weight > 0)
    .map((e) => ({ e, gap: gaps.find((g) => g.sector === e.sector && g.gapPp < 0) }))
    .filter((h): h is { e: SectorExposure; gap: SectorGap } => h.gap !== undefined);
  if (hits.length === 0) return null;
  const multiSectorFund = c.exposure.length > 1;
  // The gap named is the shown underweight gap that takes the largest share
  // of the name's dollars.
  const best = hits.reduce((a, b) => (b.e.weight > a.e.weight ? b : a));
  const baseScore = multiSectorFund
    ? hits.reduce((s, h) => s + h.e.weight * h.gap.gapClosureScore, 0)
    : best.gap.gapClosureScore;
  const sector = best.gap.sector;
  // "Underweight" already carries the direction, so the sentence states
  // the SIZE of the gap: "underweight by -4.8pp" is a doubled negative. It is
  // the gap the pick may fill (FX3 A3): smaller than the table's net gap
  // where a hedge or short holds part of it back, and then said so.
  const room = fillable.room.get(sector) ?? 0;
  const heldBack = (fillable.netRoom.get(sector) ?? 0) - room >= MIN_ROOM_DOLLARS;
  const fillPp = fillable.basis > 0 ? (room / fillable.basis) * 100 : Math.abs(best.gap.gapPp);
  const size = `${(heldBack ? fillPp : Math.abs(best.gap.gapPp)).toFixed(1)}pp${
    heldBack ? " on your long positions" : ""
  }`;
  let rationale: string;
  if (multiSectorFund) {
    // Name where most of the fund's money goes when that is not the gap
    // named (it can be a sector whose gap is under the 2pp display line).
    const dominant = c.exposure.reduce((a, b) => (b.weight > a.weight ? b : a)).sector;
    const mostly = dominant === sector ? "" : ` (mostly ${dominant})`;
    rationale = `${heldName ? "Held name pick: m" : "M"}ulti-sector fund${mostly}, credited by its look-through sector weights: underweight ${sector} by ${size} vs benchmark; ${FUND_SIZING_PHRASE}`;
  } else if (heldName) {
    rationale = `Held name pick: underweight ${sector} by ${size} vs benchmark`;
  } else {
    rationale = `Underweight ${sector} by ${size} vs benchmark`;
  }
  return { ...c, score: baseScore * scoreFactor, sectorTarget: sector, rationale, multiSectorFund };
}

// ---------------------------------------------------------------------------
// Theme-aware gap boost
// ---------------------------------------------------------------------------

import type { MacroTheme } from "./macro-themes";

const DEFENSIVE_SECTORS = new Set([
  "Utilities", "Consumer Staples", "Healthcare", "Real Estate",
]);
const AGGRESSIVE_SECTORS = new Set([
  "Technology", "Consumer Discretionary", "Communication Services",
]);
const BOOST_MULTIPLIER = 1.15;

/**
 * Recomputes `gapClosureScore` on each SectorGap based on the net direction of
 * active macro themes:
 *   - risk-off net → defensive sectors boosted 1.15×
 *   - risk-on  net → aggressive sectors boosted 1.15×
 *   - neutral / empty → |gapPp| unchanged
 */
export function applyThemeAwareBoost(
  gaps: SectorGap[],
  themes: MacroTheme[]
): SectorGap[] {
  if (themes.length === 0) {
    return gaps.map((g) => ({ ...g, gapClosureScore: Math.abs(g.gapPp) }));
  }
  const netDirection = themes.reduce((d, t) => {
    if (t.direction === "risk-off") return d - 1;
    if (t.direction === "risk-on") return d + 1;
    return d;
  }, 0);
  if (netDirection === 0) {
    return gaps.map((g) => ({ ...g, gapClosureScore: Math.abs(g.gapPp) }));
  }
  return gaps.map((g) => {
    const base = Math.abs(g.gapPp);
    let boost = 1;
    if (netDirection < 0 && DEFENSIVE_SECTORS.has(g.sector)) boost = BOOST_MULTIPLIER;
    if (netDirection > 0 && AGGRESSIVE_SECTORS.has(g.sector)) boost = BOOST_MULTIPLIER;
    return { ...g, gapClosureScore: base * boost };
  });
}
