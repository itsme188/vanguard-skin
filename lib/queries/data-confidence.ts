/**
 * Data confidence scoring — 5-dimension assessment of portfolio data reliability.
 *
 * Designed to be lightweight enough for header polling (every 60s).
 * Uses focused queries instead of the heavier data-health.ts functions.
 */

import type Database from "better-sqlite3";

// ── Types ────────────────────────────────────────────────────────────

export interface DimensionScore {
  score: number; // 0-100
  detail: string; // human-readable summary
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

export interface CashAccuracyScore extends DimensionScore {
  latestAnchorDate: string | null;
  daysSinceAnchor: number | null;
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

  if (totalHeld === 0) {
    return { score: 100, detail: "No holdings to price", pricedToday: 0, totalHeld: 0, stalestSymbol: null, stalestDays: null };
  }

  // Score: 100 if all priced today, scale down by how many are stale
  const freshPct = pricedRecent / totalHeld;
  const score = Math.round(freshPct * 100);

  const detail = pricedToday === totalHeld
    ? `All ${totalHeld} securities priced today`
    : pricedRecent === totalHeld
      ? `All ${totalHeld} securities priced within 3 days`
      : `${pricedRecent}/${totalHeld} securities have recent prices`;

  return {
    score,
    detail,
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

  if (perAccount.length === 0) {
    return { score: 100, detail: "No accounts", perAccount: [] };
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

  return { score, detail, perAccount };
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
    WHERE source != 'tws'
  `).get(today) as { latest_date: string | null; days_since: number | null };

  if (!row.latest_date) {
    return { score: 0, detail: "No statement snapshots for cash inference", latestAnchorDate: null, daysSinceAnchor: null };
  }

  const days = row.days_since ?? 999;
  let score: number;
  if (days <= 7) score = 100;
  else if (days <= 14) score = 85;
  else if (days <= 30) score = 70;
  else if (days <= 60) score = 40;
  else score = 10;

  const detail = days <= 7
    ? `Cash anchor from ${row.latest_date} (${days}d ago)`
    : `Cash inferred from ${row.latest_date} (${days}d old — may be inaccurate)`;

  return { score, detail, latestAnchorDate: row.latest_date, daysSinceAnchor: days };
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

  if (total === 0) {
    return { score: 100, detail: "No securities need enrichment", enriched: 0, total: 0, missing: [] };
  }

  const score = Math.round((count / total) * 100);
  const detail = count === total
    ? `All ${total} securities enriched`
    : `${count}/${total} enriched — ${missing.length} missing conId`;

  return { score, detail, enriched: count, total, missing };
}

function scoreValuationCoverage(db: Database.Database): ValuationCoverageScore {
  // Check the latest daily valuation — what % of holdings were priced?
  const row = db.prepare(`
    SELECT holdings_count, priced_count
    FROM daily_valuations
    ORDER BY valuation_date DESC
    LIMIT 1
  `).get() as { holdings_count: number | null; priced_count: number | null } | undefined;

  if (!row || !row.holdings_count) {
    return { score: 0, detail: "No daily valuations computed", pricedCount: 0, totalCount: 0 };
  }

  const total = row.holdings_count;
  const priced = row.priced_count ?? 0;
  const score = total > 0 ? Math.round((priced / total) * 100) : 100;
  const detail = priced === total
    ? `All ${total} holdings in latest valuation`
    : `${priced}/${total} holdings priced in latest valuation`;

  return { score, detail, pricedCount: priced, totalCount: total };
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
