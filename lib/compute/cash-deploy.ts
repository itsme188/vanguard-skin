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
 *  - A multi-sector fund is credited by its look-through weights
 *    (`etf_sector_weights`) and sized so it pushes no sector past its
 *    benchmark weight.
 */

import type Database from "better-sqlite3";
import { getBenchmarkSectorMap } from "@/lib/queries/benchmark-compositions";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { getDefaultBenchmark } from "@/lib/analysis/benchmarks";
import { computeExposureDelta, type ExposureDelta } from "./exposure-delta";
import { explodeHoldingBySector } from "./explode-sector";
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
  /** One sentence, no figure, saying why cash is unallocated; null when none is. */
  unallocatedReason: string | null;
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
  heldCandidates: WatchlistCandidate[];
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
        COALESCE(s.multiplier, 1) AS multiplier,
        SUM(lh.quantity) AS quantity,
        lp.close_price AS price
      FROM latest_holdings lh
      JOIN securities s ON s.id = lh.security_id
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
      multiplier: number;
      quantity: number;
      price: number;
    }>;

  const etfWeights = getEtfSectorWeights(db);
  const sectorValue = new Map<string, number>();
  const heldCandidatesBySymbol = new Map<string, WatchlistCandidate>();
  let totalValue = 0;
  for (const r of rows) {
    const mv = marketValue(r.quantity, r.price, r.security_type, r.multiplier, getUsdPerUnit(db, r.currency));
    // Shorts are KEPT (owner ruling 2026-11-15): a short's negative market
    // value nets against its sector and the total, as in computeExposureDelta
    // — dropping it showed a nearly flat sector as a large long weight.
    if (!Number.isFinite(mv) || mv === 0) continue;
    totalValue += mv;
    const cashEquivalent = isCashEquivalentSecurity({
      security_type: r.security_type,
      fund_category: r.fund_category,
    });
    const parts = cashEquivalent
      ? [{ sector: "Cash Equivalent", value: mv }]
      : benchmarkSectorParts(r, mv, etfWeights, benchmarkMap);
    for (const part of parts) {
      sectorValue.set(part.sector, (sectorValue.get(part.sector) ?? 0) + part.value);
    }
    // A held-name fallback is a stock or fund held LONG: "buying" a name held
    // short would be covering it, and an option's dollars do not land in its
    // sector one for one (a long put on a sector fund is a SHORT exposure).
    if (cashEquivalent || mv <= 0 || !HELD_PICK_TYPES.has(normalized(r.security_type))) continue;
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

  return { totalValue, sectorValue, heldCandidates: Array.from(heldCandidatesBySymbol.values()) };
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
   * Dollars each sector can still take before it reaches its benchmark
   * weight (never negative), for EVERY sector — including gaps under the
   * 2pp display threshold and sectors already at or past target (0). A pick
   * may spend at most this in any sector it lands in.
   */
  roomBySector: Map<string, number>;
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

  // Denominator (owner ruling 2026-11-15): the scope's NET market value
  // (longs plus signed shorts, as computeExposureDelta totals its book) plus
  // the cash being deployed, minus the excluded sleeve when the benchmark is
  // equity-only. At zero or below there is no sector weight to measure, so
  // nothing is compared and nothing is allocated.
  if (!(gapBasisTotal > 0)) {
    return { gaps, excludedSleeve, gapBasisTotal, roomBySector };
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
    roomBySector.set(sector, Math.max(0, gapBasisTotal * targetWeight - currentDollars));
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
  return { gaps, excludedSleeve, gapBasisTotal, roomBySector };
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
  "Weights are net of short positions: a short counts against its sector and against the total.";

export interface SuggestAllocationOptions {
  activeThemes?: import("./macro-themes").MacroTheme[];
}

/**
 * Suggest how to deploy cash across watchlist candidates to close benchmark
 * gaps. Greedy: pick the highest-scoring candidate, allocate up to
 * min(remaining_cash, per_name_cap, the room left in EVERY sector the name
 * lands in). Repeat. Cash no gap can take stays unallocated (owner ruling,
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
  if (cashAmount <= 0) {
    return {
      scope,
      cashAmount,
      benchmarkSymbol,
      mode,
      gaps: [],
      picks: [],
      totalAllocated: 0,
      cashRemaining: cashAmount,
      unallocatedReason: null,
      notes: [...notes, "No cash to deploy."],
      excludedSleeve: null,
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
  } = computeSectorGaps(current, benchmarkMap, cashAmount);
  // Apply theme-aware boost to gapClosureScore before ranking candidates.
  const gaps = applyThemeAwareBoost(rawGaps, opts.activeThemes ?? []);

  const rankedWatchlist = watchlist
    .map((c) => rankCandidate(c, gaps, 1, false))
    .filter((x): x is RankedCandidate => x !== null)
    .sort((a, b) => b.score - a.score);
  const watchlistSymbols = new Set(watchlist.map((c) => c.symbol));
  const heldFallback = current.heldCandidates
    .filter((c) => !watchlistSymbols.has(c.symbol))
    .map((c) => rankCandidate(c, gaps, 0.9, true))
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

  const picks: CashDeployPick[] = [];
  const cashAskedCents = Math.round(cashAmount * 100);
  let cashRemainingCents = cashAskedCents;

  for (const candidate of ranked) {
    if (cashRemainingCents <= 0) break;
    // A pick stops at the tightest sector it lands in: a single-sector name
    // at its own sector's gap, a multi-sector fund where its first sector
    // reaches the benchmark weight. Floor to the cent so a pick can never
    // land a sector a fraction of a cent past its target.
    let limitCents = Math.min(cashRemainingCents, perNameCapCents);
    for (const e of candidate.exposure) {
      if (!(e.weight > 0)) continue;
      const room = roomBySector.get(e.sector) ?? 0;
      if (room < MIN_ROOM_DOLLARS) {
        limitCents = 0;
        break;
      }
      limitCents = Math.min(limitCents, Math.floor((room * 100) / e.weight + 1e-6));
    }
    if (limitCents < MIN_PICK_CENTS) continue;
    const allocation = limitCents / 100;

    const exposureDelta = computeExposureDelta(db, scope, accountIds, [
      { symbol: candidate.symbol, action: "buy", dollarAmount: allocation },
    ]);

    picks.push({
      symbol: candidate.symbol,
      securityId: candidate.securityId,
      sectorTarget: candidate.sectorTarget,
      allocationDollars: allocation,
      gapClosureScore: candidate.score,
      rationale: candidate.rationale,
      exposureDelta,
      sectorExposure: candidate.exposure,
      multiSectorFund: candidate.multiSectorFund,
    });

    cashRemainingCents -= limitCents;
    // Spend the pick across every sector it lands in. gapPp/dollarGap (what
    // the table and the rationale show) never change after computeSectorGaps
    // returns; only the residual fields (the "After picks" column) move.
    // residualDollarGap is POSITIVE for an underweight sector (dollars still
    // needed); residualGapPp is NEGATIVE — both move toward 0 as cash lands.
    for (const e of candidate.exposure) {
      if (!(e.weight > 0)) continue;
      const spent = allocation * e.weight;
      roomBySector.set(e.sector, Math.max(0, (roomBySector.get(e.sector) ?? 0) - spent));
      const gap = gaps.find((g) => g.sector === e.sector);
      if (!gap) continue;
      gap.residualDollarGap -= spent;
      // Same denominator the gap was measured against (the equity sleeve when
      // the benchmark is equity-only), otherwise the gap only partly unwinds.
      gap.residualGapPp += (spent / gapBasisTotal) * 100;
    }
  }

  const allocatedCents = cashAskedCents - cashRemainingCents;
  const totalAllocated = allocatedCents / 100;
  const cashRemaining = cashRemainingCents / 100;

  let unallocatedReason: string | null = null;
  if (cashRemainingCents > 0) {
    const openRoom = Array.from(roomBySector.values())
      .filter((v) => v >= MIN_ROOM_DOLLARS)
      .reduce((s, v) => s + v, 0);
    if (!(gapBasisTotal > 0)) {
      unallocatedReason =
        "The scope's net value after short positions is zero or negative, so there are no sector weights to close and nothing was placed.";
    } else if (openRoom < 0.01) {
      unallocatedReason =
        "Every underweight sector is filled to its benchmark weight; the rest stays as cash rather than pushing a sector past it.";
    } else if (picks.length === 0) {
      unallocatedReason =
        "No watchlist or held name sits in an underweight sector without pushing another sector past its benchmark weight, so nothing was placed.";
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
    notes,
    excludedSleeve,
  };
}

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
function rankCandidate(
  c: WatchlistCandidate,
  gaps: SectorGap[],
  scoreFactor: number,
  heldName: boolean
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
  // the SIZE of the gap: "underweight by -4.8pp" is a doubled negative.
  const size = `${Math.abs(best.gap.gapPp).toFixed(1)}pp`;
  let rationale: string;
  if (multiSectorFund) {
    // Name where most of the fund's money goes when that is not the gap
    // named (it can be a sector whose gap is under the 2pp display line).
    const dominant = c.exposure.reduce((a, b) => (b.weight > a.weight ? b : a)).sector;
    const mostly = dominant === sector ? "" : ` (mostly ${dominant})`;
    rationale = `${heldName ? "Held name pick: m" : "M"}ulti-sector fund${mostly}, credited by its look-through sector weights: underweight ${sector} by ${size} vs benchmark; sized so no sector passes its benchmark weight`;
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
