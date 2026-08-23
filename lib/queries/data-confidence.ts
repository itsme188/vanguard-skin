/**
 * Data confidence scoring — 5-dimension assessment of portfolio data reliability.
 *
 * Designed to be lightweight enough for header polling (every 60s).
 * Uses focused queries instead of the heavier data-health.ts functions.
 */

import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";
import {
  computeCashFlowResiduals,
  isUnexplainedCashFlow,
  isLikelyIbkrAccountName,
  collectSeamDatesByAccount,
  collectLiveAnchorDatesByAccount,
  CONFIDENCE_RESIDUAL_ABS_FLOOR,
  CONFIDENCE_RESIDUAL_REL_FLOOR,
  type CashFlowClassification,
} from "@/lib/compute/cash-flow-audit";

// ── Types ────────────────────────────────────────────────────────────

export interface DimensionScore {
  score: number; // 0-100
  detail: string; // human-readable summary
  whyMatters: string; // static per-dimension explanation
  guidance: string; // conditional on score — reassurance when high, action when low
}

export interface PriceFreshnessScore extends DimensionScore {
  pricedToday: number;
  totalHeld: number;
  stalestSymbol: string | null;
  stalestDays: number | null;
}

export interface HoldingsRecencyScore extends DimensionScore {
  perAccount: {
    name: string;
    date: string | null;
    source: string | null;
    daysOld: number | null;
  }[];
}

/** A suppressed `live-anchor-residual` point that would otherwise have
 *  crossed the confidence floors — reported as a label, never as a cap (see
 *  findWorstUnexplainedCashFlow and CashAccuracyScore.timingResidual). */
export interface TimingResidualNote {
  date: string;
  accountName: string;
  amount: number;
}

export interface CashAccuracyScore extends DimensionScore {
  latestAnchorDate: string | null;
  daysSinceAnchor: number | null;
  /** Set when computeCashFlowResiduals finds cash_balance jumping between
   *  two daily_valuations rows with no matching transaction to explain it
   *  (see lib/compute/cash-flow-audit.ts). `classification` distinguishes
   *  an `external-flow-candidate` (total_value itself moved — a real fake
   *  return day, until repaired via scripts/repair-missing-external-flows.ts)
   *  from an `internal-shift` (total_value moved smoothly; only the
   *  cash/holdings split jumped — a valuation-source misattribution, not a
   *  missing flow, and NOT something the repair script will insert a row
   *  for). `source-seam` and `live-anchor-residual` points are excluded
   *  from this field entirely (see `timingResidual` for the latter). Null
   *  when no qualifying point is found. */
  unexplainedFlow: {
    accountName: string;
    date: string;
    residual: number;
    classification: CashFlowClassification;
  } | null;
  /** The worst suppressed `live-anchor-residual` point that would otherwise
   *  have crossed the confidence floors — a live-snapshot (Plaid/TWS) day
   *  whose cash_balance is an intraday-total-minus-close-priced-holdings
   *  plug, not literal cash. Labeled, not capped: see the warning
   *  application in scoreCashAccuracy. Null when none qualifies (including
   *  when a `source-seam` point already claimed the same date — source-seam
   *  points are always fully silent). */
  timingResidual: TimingResidualNote | null;
}

export interface EnrichmentScore extends DimensionScore {
  enriched: number;
  total: number;
  missing: string[]; // symbols
}

export interface ValuationCoverageScore extends DimensionScore {
  pricedCount: number;
  totalCount: number;
}

export interface DataAction {
  severity: "critical" | "warning" | "info";
  message: string;
  fix: string;
  autoFixable: boolean;
  apiEndpoint?: string;
  apiBody?: Record<string, unknown>;
}

export interface DataConfidence {
  overallScore: number; // 0-100
  overallLevel: "high" | "medium" | "low" | "stale";
  priceFreshness: PriceFreshnessScore;
  holdingsRecency: HoldingsRecencyScore;
  cashAccuracy: CashAccuracyScore;
  enrichmentCompleteness: EnrichmentScore;
  valuationCoverage: ValuationCoverageScore;
  actions: DataAction[];
}

// ── Dimension weights ────────────────────────────────────────────────

const WEIGHTS = {
  priceFreshness: 0.4,
  holdingsRecency: 0.25,
  cashAccuracy: 0.15,
  enrichment: 0.1,
  valuationCoverage: 0.1,
} as const;

// ── Scoring functions ────────────────────────────────────────────────

function scorePriceFreshness(db: Database.Database): PriceFreshnessScore {
  const today = new Date().toISOString().split("T")[0];

  // Count held securities with prices from today (or last trading day = within 3 days)
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT h.security_id) AS totalHeld,
      COUNT(DISTINCT CASE
        WHEN p.latest_date IS NOT NULL
          AND CAST(julianday(?) - julianday(p.latest_date) AS INTEGER) <= 1
        THEN h.security_id
      END) AS pricedToday,
      COUNT(DISTINCT CASE
        WHEN p.latest_date IS NOT NULL
          AND CAST(julianday(?) - julianday(p.latest_date) AS INTEGER) <= 3
        THEN h.security_id
      END) AS pricedRecent
    FROM holdings h
    JOIN (
      SELECT account_id, MAX(as_of_date) AS max_date
      FROM holdings GROUP BY account_id
    ) latest ON latest.account_id = h.account_id AND h.as_of_date = latest.max_date
    LEFT JOIN (
      SELECT security_id, MAX(date) AS latest_date
      FROM prices GROUP BY security_id
    ) p ON p.security_id = h.security_id
    WHERE h.quantity > 0
  `).get(today, today) as { totalHeld: number; pricedToday: number; pricedRecent: number };

  // Find stalest held security
  const stalest = db.prepare(`
    SELECT s.symbol,
           CAST(julianday(?) - julianday(MAX(p.date)) AS INTEGER) AS days_stale
    FROM securities s
    JOIN holdings h ON h.security_id = s.id AND h.quantity > 0
    JOIN prices p ON p.security_id = s.id
    GROUP BY s.id
    ORDER BY days_stale DESC
    LIMIT 1
  `).get(today) as { symbol: string; days_stale: number } | undefined;

  const { totalHeld, pricedToday, pricedRecent } = row;
  const whyMatters =
    "Stale prices mean today's valuations, P&L, and change numbers are based on yesterday's market.";

  if (totalHeld === 0) {
    return {
      score: 100,
      detail: "No holdings to price",
      whyMatters,
      guidance: "Import holdings to get started.",
      pricedToday: 0,
      totalHeld: 0,
      stalestSymbol: null,
      stalestDays: null,
    };
  }

  // Score: 100 if all priced today, scale down by how many are stale
  const freshPct = pricedRecent / totalHeld;
  const score = Math.round(freshPct * 100);

  const detail = pricedToday === totalHeld
    ? `All ${totalHeld} securities priced today`
    : pricedRecent === totalHeld
      ? `All ${totalHeld} securities priced within 3 days`
      : `${pricedRecent}/${totalHeld} securities have recent prices`;

  const guidance =
    score >= 90
      ? "Prices are fresh — nothing to do."
      : score >= 50
        ? "Run Quick Refresh to update prices, or connect TWS for live quotes."
        : "Open TWS and run Quick Refresh — many holdings have stale prices.";

  return {
    score,
    detail,
    whyMatters,
    guidance,
    pricedToday,
    totalHeld,
    stalestSymbol: stalest?.symbol ?? null,
    stalestDays: stalest?.days_stale ?? null,
  };
}

function scoreHoldingsRecency(db: Database.Database): HoldingsRecencyScore {
  const today = new Date().toISOString().split("T")[0];

  const rows = db.prepare(`
    SELECT
      a.name,
      MAX(h.as_of_date) AS latest_date,
      CAST(julianday(?) - julianday(MAX(h.as_of_date)) AS INTEGER) AS days_old
    FROM accounts a
    LEFT JOIN holdings h ON h.account_id = a.id AND h.quantity > 0
    GROUP BY a.id
    ORDER BY a.name
  `).all(today) as { name: string; latest_date: string | null; days_old: number | null }[];

  // Determine source for each account (heuristic based on account name)
  const perAccount = rows.map(r => ({
    name: r.name,
    date: r.latest_date,
    source: r.name.toLowerCase().includes("ibkr") ? "TWS" : "statement",
    daysOld: r.days_old,
  }));

  const whyMatters =
    "Old holdings mean positions may not reflect recent trades, corporate actions, or dividends.";

  if (perAccount.length === 0) {
    return {
      score: 100,
      detail: "No accounts",
      whyMatters,
      guidance: "Add an account to get started.",
      perAccount: [],
    };
  }

  // Score based on worst account (weakest link)
  const worstDays = Math.max(...perAccount.map(a => a.daysOld ?? 999));
  let score: number;
  if (worstDays <= 1) score = 100;
  else if (worstDays <= 7) score = 80;
  else if (worstDays <= 30) score = 50;
  else if (worstDays <= 90) score = 20;
  else score = 0;

  const parts = perAccount
    .filter(a => a.date)
    .map(a => `${a.name}: ${a.daysOld != null && a.daysOld <= 1 ? "today" : a.date}`);
  const detail = parts.join(", ") || "No holdings imported";

  const guidance =
    score >= 80
      ? "Holdings are current across accounts."
      : score >= 50
        ? "Import the latest monthly statement (Vanguard) or sync TWS (IBKR)."
        : "Holdings are weeks+ old — import latest statements or reconnect TWS now.";

  return { score, detail, whyMatters, guidance, perAccount };
}

/** Sorts flagged residual points worst-first: most recent toDate, then
 *  largest |residual| as a tiebreak. Shared by both the unexplainedFlow and
 *  timingResidual selections in findWorstUnexplainedCashFlow so their "worst"
 *  definitions can never silently drift apart. */
function sortWorstFirst(points: CashFlowResidualPointForSort[]): void {
  points.sort((a, b) =>
    a.toDate !== b.toDate
      ? (a.toDate < b.toDate ? 1 : -1) // most recent date first
      : Math.abs(b.residual) - Math.abs(a.residual)
  );
}

type CashFlowResidualPointForSort = { toDate: string; residual: number };

/**
 * Worst (most recent, tie-broken by largest |residual|) unexplained
 * cash-flow candidate across non-IBKR accounts, using the SAME residual
 * computation scripts/repair-missing-external-flows.ts uses — so the
 * confidence score and the repair script's candidate list can never
 * disagree about what counts as "unexplained." Deliberately more sensitive
 * than the repair script's own bar (CONFIDENCE_RESIDUAL_REL_FLOOR=2% vs the
 * script's 5%) — this is an early warning, not a "propose a fix" bar.
 *
 * `source-seam` and `live-anchor-residual` points are excluded from
 * `unexplainedFlow` explicitly at this call site — `isUnexplainedCashFlow`
 * itself stays classification-blind by design (matching
 * partitionCandidates' division of labor). A suppressed `live-anchor-
 * residual` point that would otherwise have crossed the floors is instead
 * surfaced as `timingResidual` (labeled, not capped — see scoreCashAccuracy).
 * `source-seam` points are fully silent in both fields — they're
 * already-understood measurement-basis splices, not data-quality problems.
 */
function findWorstUnexplainedCashFlow(
  db: Database.Database
): {
  unexplainedFlow: { accountName: string; date: string; residual: number; classification: CashFlowClassification } | null;
  timingResidual: TimingResidualNote | null;
} {
  const accounts = db.prepare(`SELECT id, name FROM accounts`).all() as {
    id: number;
    name: string;
  }[];
  const accountIds = accounts.filter(a => !isLikelyIbkrAccountName(a.name)).map(a => a.id);
  if (accountIds.length === 0) return { unexplainedFlow: null, timingResidual: null };

  const seamDatesByAccount = collectSeamDatesByAccount(db, accountIds);
  const liveAnchorDatesByAccount = collectLiveAnchorDatesByAccount(db, accountIds);

  const allPoints = computeCashFlowResiduals(db, {
    accountIds,
    seamDatesByAccount,
    liveAnchorDatesByAccount,
  });

  const floors = {
    absFloor: CONFIDENCE_RESIDUAL_ABS_FLOOR,
    relFloor: CONFIDENCE_RESIDUAL_REL_FLOOR,
  };

  // Both classifications count here — an internal cash/holdings
  // misattribution is still a real data-quality problem, just not one the
  // repair script writes a row for (see cash-flow-audit.ts's
  // classifyCashFlowResidual doc). scoreCashAccuracy names which kind in
  // the detail string.
  const flagged = allPoints.filter(
    p =>
      isUnexplainedCashFlow(p, floors) &&
      p.classification !== "source-seam" &&
      p.classification !== "live-anchor-residual"
  );

  let unexplainedFlow: {
    accountName: string;
    date: string;
    residual: number;
    classification: CashFlowClassification;
  } | null = null;
  if (flagged.length > 0) {
    sortWorstFirst(flagged);
    const worst = flagged[0];
    unexplainedFlow = {
      accountName: worst.accountName,
      date: worst.toDate,
      residual: worst.residual,
      classification: worst.classification,
    };
  }

  const suppressedTimingResiduals = allPoints.filter(
    p => p.classification === "live-anchor-residual" && isUnexplainedCashFlow(p, floors)
  );

  let timingResidual: TimingResidualNote | null = null;
  if (suppressedTimingResiduals.length > 0) {
    sortWorstFirst(suppressedTimingResiduals);
    const worst = suppressedTimingResiduals[0];
    timingResidual = {
      date: worst.toDate,
      accountName: worst.accountName,
      amount: worst.residual,
    };
  }

  return { unexplainedFlow, timingResidual };
}

function scoreCashAccuracy(db: Database.Database): CashAccuracyScore {
  const today = new Date().toISOString().split("T")[0];

  // Find the most recent monthly snapshot anchor (non-TWS, since TWS snapshots
  // are live NLV and don't contain the breakdown needed for reliable cash inference)
  const row = db.prepare(`
    SELECT
      MAX(month_end_date) AS latest_date,
      CAST(julianday(?) - julianday(MAX(month_end_date)) AS INTEGER) AS days_since
    FROM monthly_snapshots
    WHERE ${excludeLiveSnapshotsSql("source")}
  `).get(today) as { latest_date: string | null; days_since: number | null };

  const whyMatters =
    "Cash is inferred from the latest statement — the older the anchor, the more it can drift from reality.";

  const { unexplainedFlow, timingResidual } = findWorstUnexplainedCashFlow(db);

  if (!row.latest_date) {
    return {
      score: 0,
      detail: "No statement snapshots for cash inference",
      whyMatters,
      guidance: "Import a monthly statement to establish a cash anchor.",
      latestAnchorDate: null,
      daysSinceAnchor: null,
      unexplainedFlow,
      timingResidual,
    };
  }

  const days = row.days_since ?? 999;
  let score: number;
  if (days <= 7) score = 100;
  else if (days <= 14) score = 85;
  else if (days <= 30) score = 70;
  else if (days <= 60) score = 40;
  else score = 10;

  let detail = days <= 7
    ? `Cash anchor from ${row.latest_date} (${days}d ago)`
    : `Cash inferred from ${row.latest_date} (${days}d old — may be inaccurate)`;

  let guidance =
    score >= 85
      ? "Cash anchor is recent."
      : score >= 50
        ? "Consider importing this month's statement to refresh the cash anchor."
        : "Cash may be significantly wrong — import the latest monthly statement.";

  // An unexplained cash residual means SOMETHING is off with this account's
  // numbers — cap the score regardless of how fresh the statement anchor
  // otherwise looks, since anchor freshness doesn't fix either kind of
  // problem. The two classifications get different wording (and different
  // guidance) because they're different bugs with different fixes: an
  // external-flow-candidate is a fake return day fixable by
  // scripts/repair-missing-external-flows.ts; an internal-shift is a
  // valuation-source misattribution that script deliberately WON'T touch
  // (see cash-flow-audit.ts's classifyCashFlowResidual doc).
  if (unexplainedFlow) {
    score = Math.min(score, 40);
    const sign = unexplainedFlow.residual > 0 ? "+" : "-";
    const amountStr = `${sign}$${Math.abs(unexplainedFlow.residual).toFixed(0)}`;

    if (unexplainedFlow.classification === "external-flow-candidate") {
      detail += `; unexplained external-flow-shaped cash delta of ${amountStr} on ${unexplainedFlow.date} in ${unexplainedFlow.accountName} — not matched to any transaction`;
      guidance =
        `${unexplainedFlow.accountName}'s ${unexplainedFlow.date} cash movement isn't explained by any recorded ` +
        `transaction and total_value moved with it — it's likely inflating volatility/drawdown/Sharpe. Review ` +
        `scripts/repair-missing-external-flows.ts (dry-run) to see the proposed fix.`;
    } else {
      detail += `; internal cash/holdings shift (valuation-source misattribution) of ${amountStr} on ${unexplainedFlow.date} in ${unexplainedFlow.accountName}`;
      guidance =
        `${unexplainedFlow.accountName}'s ${unexplainedFlow.date} cash figure jumped but total_value moved smoothly — ` +
        `the cash/holdings split looks misattributed by the valuation source (not a missing external flow, so the ` +
        `repair script won't propose a row for it). Worth checking that day's live source data.`;
    }
  } else if (timingResidual) {
    // Live-snapshot (Plaid/TWS) timing residual: labeled, never capped —
    // it's ambiguous until a statement covers the window, not a confirmed
    // data-quality problem the way unexplainedFlow is.
    const sign = timingResidual.amount > 0 ? "+" : "-";
    const amountStr = `${sign}$${Math.abs(timingResidual.amount).toFixed(0)}`;
    detail += `; cash delta of ${amountStr} on ${timingResidual.date} in ${timingResidual.accountName} is a live-snapshot timing residual (intraday broker total vs close-priced holdings) — not treated as an external flow`;
    guidance =
      `Live-snapshot (Plaid/TWS) days infer cash as snapshot-total minus holdings value; the residual usually moves ` +
      `with measurement timing, not money. A genuine flow in this window would confirm on the next statement import ` +
      `— verify there if the amount looks like a real deposit or withdrawal.`;
  }

  return {
    score,
    detail,
    whyMatters,
    guidance,
    latestAnchorDate: row.latest_date,
    daysSinceAnchor: days,
    unexplainedFlow,
    timingResidual,
  };
}

function scoreEnrichment(db: Database.Database): EnrichmentScore {
  const rows = db.prepare(`
    SELECT
      s.id, s.symbol, s.ib_con_id,
      LOWER(COALESCE(s.security_type, '')) AS sec_type
    FROM securities s
    JOIN holdings h ON h.security_id = s.id AND h.quantity > 0
    JOIN (
      SELECT account_id, MAX(as_of_date) AS max_date
      FROM holdings GROUP BY account_id
    ) latest ON latest.account_id = h.account_id AND h.as_of_date = latest.max_date
    GROUP BY s.id
  `).all() as { id: number; symbol: string; ib_con_id: number | null; sec_type: string }[];

  // Bonds and money market don't need enrichment
  const enrichable = rows.filter(r => !["bond", "money_market", "money market"].includes(r.sec_type));
  const enriched = enrichable.filter(r => r.ib_con_id !== null);
  const missing = enrichable.filter(r => r.ib_con_id === null).map(r => r.symbol);

  const total = enrichable.length;
  const count = enriched.length;
  const whyMatters =
    "Securities without TWS contract IDs can't fetch live prices, option chains, or historical bars.";

  if (total === 0) {
    return {
      score: 100,
      detail: "No securities need enrichment",
      whyMatters,
      guidance: "Nothing to enrich.",
      enriched: 0,
      total: 0,
      missing: [],
    };
  }

  const score = Math.round((count / total) * 100);
  const detail = count === total
    ? `All ${total} securities enriched`
    : `${count}/${total} enriched — ${missing.length} missing conId`;

  const guidance =
    score >= 95
      ? "All enrichable securities have contract IDs."
      : "Click Enrich (requires TWS running) to fetch the missing contract IDs.";

  return { score, detail, whyMatters, guidance, enriched: count, total, missing };
}

function scoreValuationCoverage(db: Database.Database): ValuationCoverageScore {
  // Check the latest daily valuation — what % of holdings were priced?
  const row = db.prepare(`
    SELECT holdings_count, priced_count
    FROM daily_valuations
    ORDER BY valuation_date DESC
    LIMIT 1
  `).get() as { holdings_count: number | null; priced_count: number | null } | undefined;

  const whyMatters =
    "Missing holdings in the latest daily valuation understate portfolio value and distort change calculations.";

  if (!row || !row.holdings_count) {
    return {
      score: 0,
      detail: "No daily valuations computed",
      whyMatters,
      guidance: "Run Quick Refresh to compute today's valuation.",
      pricedCount: 0,
      totalCount: 0,
    };
  }

  const total = row.holdings_count;
  const priced = row.priced_count ?? 0;
  const score = total > 0 ? Math.round((priced / total) * 100) : 100;
  const detail = priced === total
    ? `All ${total} holdings in latest valuation`
    : `${priced}/${total} holdings priced in latest valuation`;

  const guidance =
    score >= 95
      ? "Full coverage in the latest valuation."
      : score >= 50
        ? "Run Quick Refresh to price the remaining holdings."
        : "Many holdings unpriced — Quick Refresh, then enrich any still missing.";

  return { score, detail, whyMatters, guidance, pricedCount: priced, totalCount: total };
}

// ── Actions ──────────────────────────────────────────────────────────

function deriveActions(
  price: PriceFreshnessScore,
  holdings: HoldingsRecencyScore,
  cash: CashAccuracyScore,
  enrichment: EnrichmentScore,
  valuation: ValuationCoverageScore,
): DataAction[] {
  const actions: DataAction[] = [];

  // Price freshness
  if (price.score < 80 && price.totalHeld > 0) {
    actions.push({
      severity: price.score < 30 ? "critical" : "warning",
      message: `${price.totalHeld - price.pricedToday} securities have stale prices`,
      fix: "Run Quick Refresh to update all prices (~2 min)",
      autoFixable: true,
      apiEndpoint: "/api/tws/auto-refresh",
      apiBody: { level: "quick" },
    });
  }

  // Enrichment
  if (enrichment.missing.length > 0) {
    actions.push({
      severity: enrichment.missing.length > 5 ? "warning" : "info",
      message: `${enrichment.missing.length} securities missing TWS contract data`,
      fix: `Enrich to enable price fetching: ${enrichment.missing.slice(0, 3).join(", ")}${enrichment.missing.length > 3 ? "..." : ""}`,
      autoFixable: true,
      apiEndpoint: "/api/tws/enrich",
    });
  }

  // Cash accuracy
  if (cash.score < 50) {
    actions.push({
      severity: "warning",
      message: `Cash inferred from ${cash.daysSinceAnchor ?? "?"}d-old snapshot`,
      fix: "Import latest monthly statement to update cash anchor",
      autoFixable: false,
    });
  }

  // Holdings recency
  const staleAccounts = holdings.perAccount.filter(a => (a.daysOld ?? 999) > 30);
  if (staleAccounts.length > 0) {
    actions.push({
      severity: "warning",
      message: `${staleAccounts.map(a => a.name).join(", ")} holdings are ${Math.max(...staleAccounts.map(a => a.daysOld ?? 0))}+ days old`,
      fix: "Import latest statement or sync IBKR positions",
      autoFixable: false,
    });
  }

  // Valuation coverage
  if (valuation.score < 80 && valuation.totalCount > 0) {
    actions.push({
      severity: "warning",
      message: `Only ${valuation.pricedCount}/${valuation.totalCount} holdings in latest valuation`,
      fix: "Refresh prices to improve valuation coverage",
      autoFixable: true,
      apiEndpoint: "/api/tws/auto-refresh",
      apiBody: { level: "quick" },
    });
  }

  // No data at all
  if (price.totalHeld === 0) {
    actions.push({
      severity: "critical",
      message: "No holdings data found",
      fix: "Import files to get started",
      autoFixable: false,
    });
  }

  return actions.sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });
}

// ── Main function ────────────────────────────────────────────────────

export function getDataConfidence(db: Database.Database): DataConfidence {
  const priceFreshness = scorePriceFreshness(db);
  const holdingsRecency = scoreHoldingsRecency(db);
  const cashAccuracy = scoreCashAccuracy(db);
  const enrichmentCompleteness = scoreEnrichment(db);
  const valuationCoverage = scoreValuationCoverage(db);

  const overallScore = Math.round(
    priceFreshness.score * WEIGHTS.priceFreshness +
    holdingsRecency.score * WEIGHTS.holdingsRecency +
    cashAccuracy.score * WEIGHTS.cashAccuracy +
    enrichmentCompleteness.score * WEIGHTS.enrichment +
    valuationCoverage.score * WEIGHTS.valuationCoverage,
  );

  const overallLevel: DataConfidence["overallLevel"] =
    overallScore >= 80 ? "high" :
    overallScore >= 50 ? "medium" :
    overallScore >= 20 ? "low" :
    "stale";

  const actions = deriveActions(
    priceFreshness,
    holdingsRecency,
    cashAccuracy,
    enrichmentCompleteness,
    valuationCoverage,
  );

  return {
    overallScore,
    overallLevel,
    priceFreshness,
    holdingsRecency,
    cashAccuracy,
    enrichmentCompleteness,
    valuationCoverage,
    actions,
  };
}
