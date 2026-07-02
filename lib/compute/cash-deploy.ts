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
}

const GAP_THRESHOLD_PP = 2.0; // surface gaps of |2pp| or more

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

function computeSectorGaps(
  current: CurrentHoldingSummary,
  benchmarkMap: Map<string, number>,
  cashAmount: number
): SectorGap[] {
  // Project current weights AFTER adding cash to the denominator —
  // otherwise gaps are measured against the pre-deploy total, which
  // overweights the cash-receiving sector after the fact.
  const projectedTotal = current.totalValue + cashAmount;
  const gaps: SectorGap[] = [];

  const allSectors = new Set<string>([
    ...current.sectorValue.keys(),
    ...benchmarkMap.keys(),
  ]);

  for (const sector of allSectors) {
    const currentDollars = current.sectorValue.get(sector) ?? 0;
    const currentWeight = projectedTotal > 0 ? currentDollars / projectedTotal : 0;
    const targetWeight = benchmarkMap.get(sector) ?? 0;
    const gapPp = (currentWeight - targetWeight) * 100;
    const dollarGap = projectedTotal * (targetWeight - currentWeight);

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
  return gaps;
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
    };
  }
  if (watchlist.length === 0) {
    notes.push(
      `No active watchlist candidates for scope ${scope}. Add tickers to your ${scope}_buy watchlist group.`
    );
  }

  const rawGaps = computeSectorGaps(current, benchmarkMap, cashAmount);
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
    // Reduce the gap so subsequent candidates targeting the same sector don't double-fill
    matchingGap.dollarGap += allocation; // dollarGap was negative for underweight; pushing toward 0
    matchingGap.gapPp = -Math.abs(matchingGap.dollarGap) / projectedTotal * 100;
  }

  const totalAllocated = picks.reduce((s, p) => s + p.allocationDollars, 0);
  if (cashRemaining > 0.01 && picks.length === 0) {
    notes.push(
      "Couldn't match watchlist names to any benchmark gaps. Consider adding tickers in underweight sectors."
    );
  } else if (cashRemaining > 0.01) {
    notes.push(`${formatCash(cashRemaining)} unallocated — no remaining underweight matches.`);
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
  };
}

function formatCash(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
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
