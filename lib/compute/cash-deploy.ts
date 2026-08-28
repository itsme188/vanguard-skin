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
 */

import type Database from "better-sqlite3";
import { getBenchmarkSectorMap } from "@/lib/queries/benchmark-compositions";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getDefaultBenchmark } from "@/lib/analysis/benchmarks";
import { computeExposureDelta, type ExposureDelta } from "./exposure-delta";
import { explodeHoldingBySector } from "./explode-sector";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { marketValue } from "@/lib/valuation";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { formatLargeUSD } from "@/lib/format";

export type CashDeployMode = "benchmark" | "factor_balance" | "heuristic";

export interface SectorGap {
  sector: string;
  currentWeight: number;
  targetWeight: number;
  gapPp: number; // signed percentage-point gap: negative = underweight (deploy target)
  dollarGap: number; // signed dollar amount to fully close gap
  gapClosureScore: number; // |gapPp|, optionally boosted by theme-aware logic
}

export interface CashDeployPick {
  symbol: string;
  securityId: number | null;
  sectorTarget: string;
  allocationDollars: number;
  gapClosureScore: number;
  rationale: string;
  exposureDelta: ExposureDelta;
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
  cashRemaining: number;
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
}

function loadCurrentHoldings(
  db: Database.Database,
  accountIds: number[] | undefined
): CurrentHoldingSummary {
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const params: number[] = accountIds?.length ? [...accountIds] : [];

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
        s.symbol,
        s.security_type,
        s.sector,
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
      symbol: string;
      security_type: string | null;
      sector: string | null;
      currency: string | null;
      multiplier: number;
      quantity: number;
      price: number;
    }>;

  const etfWeights = getEtfSectorWeights(db);
  const sectorValue = new Map<string, number>();
  let totalValue = 0;
  for (const r of rows) {
    const mv = marketValue(r.quantity, r.price, r.security_type, r.multiplier, getUsdPerUnit(db, r.currency));
    if (mv <= 0) continue;
    totalValue += mv;
    for (const part of explodeHoldingBySector(r.symbol, r.security_type, mv, etfWeights, r.sector)) {
      sectorValue.set(part.sector, (sectorValue.get(part.sector) ?? 0) + part.value);
    }
  }

  return { totalValue, sectorValue };
}

interface WatchlistCandidate {
  symbol: string;
  securityId: number;
  sector: string | null;
  thesis: string | null;
}

function loadWatchlistCandidates(
  db: Database.Database,
  scope: string
): WatchlistCandidate[] {
  // Group names follow the convention "<scope>_buy" (e.g., "vanguard_buy",
  // "ibkr_buy_next", "roth_buy_next"). Match all groups that contain the
  // scope token so renames don't silently break the lookup.
  const groupPattern = `%${scope}%`;

  return db
    .prepare(
      `
      SELECT
        s.id AS securityId,
        s.symbol,
        s.sector,
        w.thesis
      FROM watchlist w
      JOIN securities s ON s.id = w.security_id
      WHERE w.is_active = 1
        AND (w.group_name LIKE ? OR w.group_name = 'default')
      ORDER BY w.added_date DESC
    `
    )
    .all(groupPattern) as WatchlistCandidate[];
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
  // equity sleeve on its own and renormalize to 100%.
  const equityOnly = isEquityOnlyBenchmark(benchmarkMap);
  const excludedBuckets: Array<{ sector: string; weightPct: number }> = [];
  let excludedDollars = 0;
  if (equityOnly) {
    for (const [sector, value] of current.sectorValue) {
      if (!isNonEquitySectorBucket(sector) || value <= 0) continue;
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

  const allSectors = new Set<string>([
    ...current.sectorValue.keys(),
    ...benchmarkMap.keys(),
  ]);

  for (const sector of allSectors) {
    // Excluded sleeve buckets leave the table entirely — a 0% target they
    // can never close is not an actionable gap. Buckets the index genuinely
    // holds at 0% (a GICS sector outside the index, e.g. QQQ's Financials)
    // stay, because cash CAN close those.
    if (equityOnly && isNonEquitySectorBucket(sector)) continue;

    const currentDollars = current.sectorValue.get(sector) ?? 0;
    const currentWeight = gapBasisTotal > 0 ? currentDollars / gapBasisTotal : 0;
    const targetWeight = benchmarkMap.get(sector) ?? 0;
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
      });
    }
  }

  // Sort by largest underweight first (most negative gapPp = best target)
  gaps.sort((a, b) => a.gapPp - b.gapPp);
  return { gaps, excludedSleeve, gapBasisTotal };
}

/**
 * Caption lead-in for the gap table when the comparison ran on the equity
 * sleeve. The bucket weights themselves are portfolio-derived, so the
 * component renders them through `<Pct>` rather than baking them in here.
 */
export function equitySleeveCaptionLead(benchmarkSymbol: string): string {
  return `Sector gaps vs ${benchmarkSymbol} are measured on the equity sleeve — ${benchmarkSymbol} holds no fixed income or cash, so these are excluded from current weights and the rest renormalized to 100%:`;
}


export interface SuggestAllocationOptions {
  activeThemes?: import("./macro-themes").MacroTheme[];
}

/**
 * Suggest how to deploy cash across watchlist candidates to close benchmark
 * gaps. Greedy: pick the highest-scoring candidate, allocate up to
 * min(remaining_cash, dollar_gap, per_name_cap). Repeat.
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
  const current = loadCurrentHoldings(db, accountIds);
  const watchlist = loadWatchlistCandidates(db, scope);
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
  } = computeSectorGaps(current, benchmarkMap, cashAmount);
  // Apply theme-aware boost to gapClosureScore before ranking candidates.
  const gaps = applyThemeAwareBoost(rawGaps, opts.activeThemes ?? []);

  // Rank watchlist candidates by boosted gap closure score
  const ranked = watchlist
    .map((c) => {
      const sector = c.sector ?? "Unknown";
      const matchingGap = gaps.find((g) => g.sector === sector && g.gapPp < 0);
      if (!matchingGap) return null;
      const score = matchingGap.gapClosureScore;
      const rationale = `Underweight ${sector} by ${matchingGap.gapPp.toFixed(1)}pp vs benchmark`;
      return { ...c, score, sectorTarget: sector, rationale };
    })
    .filter((x): x is WatchlistCandidate & { score: number; sectorTarget: string; rationale: string } => x !== null)
    .sort((a, b) => b.score - a.score);

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
  const perNameCap = projectedTotal * top1Cap;

  const picks: CashDeployPick[] = [];
  let cashRemaining = cashAmount;

  for (const candidate of ranked) {
    if (cashRemaining <= 0) break;
    const matchingGap = gaps.find((g) => g.sector === candidate.sectorTarget && g.gapPp < 0);
    if (!matchingGap) continue;
    const dollarGap = Math.abs(matchingGap.dollarGap);
    const allocation = Math.min(cashRemaining, dollarGap, perNameCap);
    if (allocation <= 0) continue;

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
    });

    cashRemaining -= allocation;
    // Reduce the gap so subsequent candidates targeting the same sector don't double-fill.
    // dollarGap is POSITIVE for an underweight sector (dollars needed to close);
    // gapPp is NEGATIVE — both move toward 0 as cash lands in the sector.
    matchingGap.dollarGap -= allocation;
    // Same denominator the gap was measured against (the equity sleeve when
    // the benchmark is equity-only), otherwise the gap only partly unwinds.
    if (gapBasisTotal > 0) matchingGap.gapPp += (allocation / gapBasisTotal) * 100;
  }

  const totalAllocated = picks.reduce((s, p) => s + p.allocationDollars, 0);
  if (cashRemaining > 0.01 && picks.length === 0) {
    notes.push(
      "Couldn't match watchlist names to any benchmark gaps. Consider adding tickers in underweight sectors."
    );
  } else if (cashRemaining > 0.01) {
    notes.push(`${formatLargeUSD(cashRemaining)} unallocated — no remaining underweight matches.`);
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
    notes,
    excludedSleeve,
  };
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
