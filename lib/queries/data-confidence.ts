/**
 * Data confidence scoring — 5-dimension assessment of portfolio data reliability.
 *
 * Designed to be lightweight enough for header polling (every 60s).
 * Uses focused queries instead of the heavier data-health.ts functions.
 */

import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";
import { todayET } from "@/lib/calendar/date-utils";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { classifyHoldingSourceKey } from "@/lib/db/holding-sources";
import { runIntegrityChecks, sortWorstFirst, type IntegrityHit } from "@/lib/queries/integrity-checks";
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
    /** The STALEST held position's as_of_date — this is what the score is
     *  based on (weakest-link), NOT the account's most recent import. */
    date: string | null;
    source: string | null;
    daysOld: number | null;
    /** The stalest position's symbol, so the drawer/guidance can name
     *  exactly what to refresh instead of just an age. */
    stalestSymbol: string | null;
    /** The account's LATEST held-position as_of_date (via
     *  latestHoldingsPredicate, keyBy:"account") — shown alongside `date` so
     *  this drawer can never contradict Data Health's "Last holdings"
     *  figure (qa:header-dataconfidence--holdings-date-is-oldest-position-
     *  not-latest). Scoring is unchanged — still based on `date`/`daysOld`. */
    latestDate: string | null;
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
  /** Each currently-held account's latest daily_valuations date (null if
   *  that account has no daily_valuations row at all) — a later integrity
   *  check cross-references this against holdings as_of_date. */
  perAccountAsOf: Array<{ accountName: string; asOfDate: string | null }>;
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
  /** Cross-cutting number-trust scan (runIntegrityChecks) — independent of
   *  the 5 weighted dimensions above. A critical hit caps overallScore/Level
   *  (see capReason); warnings never cap, they're informational only. */
  integrity: { critical: IntegrityHit[]; warnings: IntegrityHit[] };
  /** Set to the first (module-order) critical integrity hit's reason when
   *  the cap applied; null when no critical hit exists. Never set from a
   *  warning. */
  capReason: string | null;
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

function scorePriceFreshness(db: Database.Database, now: Date = new Date()): PriceFreshnessScore {
  const today = todayET(now);

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
    LEFT JOIN (
      SELECT security_id, MAX(date) AS latest_date
      FROM prices GROUP BY security_id
    ) p ON p.security_id = h.security_id
    WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
  `).get(today, today) as { totalHeld: number; pricedToday: number; pricedRecent: number };

  // Find stalest currently-held security. A LEFT JOIN onto a pre-aggregated
  // latest-price-per-security subquery (not a bare JOIN prices, which
  // row-multiplies and can silently pick an old price) so a held security
  // with NO price rows at all still surfaces — and wins "stalest" first,
  // since missing data is worse than old data. When there's no price row,
  // the fallback age is the holding's own as_of_date (how old our knowledge
  // of the position itself is), and the symbol is prefixed "no price rows"
  // so the caller can distinguish "stale price" from "never priced."
  const stalest = db.prepare(`
    SELECT s.symbol,
           p.latest_date,
           CAST(julianday(?) - julianday(COALESCE(p.latest_date, agg.latest_as_of)) AS INTEGER) AS days_stale
    FROM securities s
    JOIN (
      SELECT h.security_id, MAX(h.as_of_date) AS latest_as_of
      FROM holdings h
      WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
      GROUP BY h.security_id
    ) agg ON agg.security_id = s.id
    LEFT JOIN (
      SELECT security_id, MAX(date) AS latest_date
      FROM prices GROUP BY security_id
    ) p ON p.security_id = s.id
    ORDER BY (p.latest_date IS NULL) DESC, days_stale DESC
    LIMIT 1
  `).get(today) as { symbol: string; latest_date: string | null; days_stale: number } | undefined;

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
    stalestSymbol: stalest
      ? stalest.latest_date === null
        ? `no price rows: ${stalest.symbol}`
        : stalest.symbol
      : null,
    stalestDays: stalest?.days_stale ?? null,
  };
}

function scoreHoldingsRecency(db: Database.Database, now: Date = new Date()): HoldingsRecencyScore {
  const today = todayET(now);

  const accounts = db.prepare(`SELECT id, name FROM accounts ORDER BY name`).all() as {
    id: number;
    name: string;
  }[];

  // Per-(account, security) latest rows — NOT a single per-account
  // MAX(as_of_date). An account can be "read today" for one live TWS row
  // while a carried statement position is 60 days old; the account's
  // reported staleness must reflect the WORST (oldest) currently-held
  // position, not the freshest, or a single intraday sync would silently
  // mask a stale carried position. Ordered oldest-first per account so a
  // tie between two equally-stale positions deterministically keeps the
  // first row encountered.
  const holdingRows = db.prepare(`
    SELECT h.account_id, h.as_of_date, h.source_key, s.symbol
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
    ORDER BY h.account_id, h.as_of_date ASC
  `).all() as { account_id: number; as_of_date: string; source_key: string | null; symbol: string }[];

  const worstByAccount = new Map<
    number,
    { as_of_date: string; source_key: string | null; symbol: string }
  >();
  for (const r of holdingRows) {
    if (!worstByAccount.has(r.account_id)) {
      worstByAccount.set(r.account_id, {
        as_of_date: r.as_of_date,
        source_key: r.source_key,
        symbol: r.symbol,
      });
    }
  }

  // The account's LATEST (freshest) held-position as_of_date — via the same
  // shared predicate (keyBy:"account" = per-account max, never a hand-rolled
  // global MAX(as_of_date)) — so the drawer can quote a "latest" figure that
  // agrees with Data Health's "Last holdings <date>" instead of only ever
  // showing the stalest position's date under the account name.
  const latestRows = db.prepare(`
    SELECT h.account_id, MAX(h.as_of_date) AS latest_date
    FROM holdings h
    WHERE ${latestHoldingsPredicate({ keyBy: "account", includeShorts: true })}
    GROUP BY h.account_id
  `).all() as { account_id: number; latest_date: string }[];
  const latestByAccount = new Map(latestRows.map(r => [r.account_id, r.latest_date]));

  const perAccount = accounts.map(a => {
    const worst = worstByAccount.get(a.id);
    const daysOld = worst
      ? Math.round((Date.parse(today) - Date.parse(worst.as_of_date)) / 86_400_000)
      : null;
    return {
      name: a.name,
      date: worst?.as_of_date ?? null,
      source: worst ? classifyHoldingSourceKey(worst.source_key) : null,
      daysOld,
      stalestSymbol: worst?.symbol ?? null,
      latestDate: latestByAccount.get(a.id) ?? null,
    };
  });

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

  // "<account>: latest: <date> · stalest position: SYM <date>" — both dates
  // named and labeled so this line can never read as contradicting Data
  // Health's own "Last holdings <date>" (which quotes the LATEST date, not
  // the stalest position this dimension scores on).
  const parts = perAccount
    .filter(a => a.date)
    .map(a => {
      const stalestDateLabel = a.daysOld != null && a.daysOld <= 1 ? "today" : a.date;
      const stalestLabel = a.stalestSymbol ? `${a.stalestSymbol} ${stalestDateLabel}` : stalestDateLabel;
      return `${a.name}: latest: ${a.latestDate ?? "—"} · stalest position: ${stalestLabel}`;
    });
  const detail = parts.join(", ") || "No holdings imported";

  // Names the specific stalest position so the prescribed action is
  // actionable ("refresh X"), not just a generic "import a statement".
  const worstAccount = perAccount.reduce<(typeof perAccount)[number] | null>(
    (worst, a) => ((a.daysOld ?? -1) > (worst?.daysOld ?? -1) ? a : worst),
    null
  );
  const worstPositionLabel = worstAccount?.stalestSymbol
    ? `${worstAccount.stalestSymbol} in ${worstAccount.name}`
    : (worstAccount?.name ?? "the affected account");

  const guidance =
    score >= 80
      ? "Holdings are current across accounts."
      : score >= 50
        ? `Refresh ${worstPositionLabel} — import the latest monthly statement (Vanguard) or sync TWS (IBKR).`
        : `Holdings are weeks+ old — refresh ${worstPositionLabel} now (import latest statements or reconnect TWS).`;

  return { score, detail, whyMatters, guidance, perAccount };
}

// sortWorstFirst is imported from lib/queries/integrity-checks.ts (single
// source of truth, consolidated task 18 — this file and integrity-checks.ts
// each carried an identical copy of the comparator below).

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

function scoreCashAccuracy(db: Database.Database, now: Date = new Date()): CashAccuracyScore {
  const today = todayET(now);

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
    JOIN holdings h ON h.security_id = s.id
    WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
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
  // Per-account latest daily_valuations row, summed across every account
  // that currently holds something (latestHoldingsPredicate) — NOT a single
  // global "latest valuation_date across all accounts" row, which silently
  // ignores every account whose valuation happens to be older than the
  // account that last synced. An account with current holdings but NO
  // daily_valuations row at all counts as fully unpriced (held-count,0),
  // not simply omitted from the denominator.
  const rows = db.prepare(`
    WITH current_holdings AS (
      SELECT h.account_id, COUNT(DISTINCT h.security_id) AS held_count
      FROM holdings h
      WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
      GROUP BY h.account_id
    )
    SELECT a.name AS account_name,
           ch.held_count,
           dv.valuation_date,
           dv.holdings_count,
           dv.priced_count
    FROM accounts a
    JOIN current_holdings ch ON ch.account_id = a.id
    LEFT JOIN daily_valuations dv
      ON dv.account_id = a.id
      AND dv.valuation_date = (
        SELECT MAX(v2.valuation_date) FROM daily_valuations v2 WHERE v2.account_id = a.id
      )
    ORDER BY a.name
  `).all() as {
    account_name: string;
    held_count: number;
    valuation_date: string | null;
    holdings_count: number | null;
    priced_count: number | null;
  }[];

  const whyMatters =
    "Missing holdings in the latest daily valuation understate portfolio value and distort change calculations.";

  const perAccountAsOf = rows.map(r => ({
    accountName: r.account_name,
    asOfDate: r.valuation_date,
  }));

  let total = 0;
  let priced = 0;
  for (const r of rows) {
    if (r.valuation_date === null) {
      // No daily_valuations row for this account at all — every currently
      // held security counts as unpriced.
      total += r.held_count;
    } else {
      total += r.holdings_count ?? r.held_count;
      priced += r.priced_count ?? 0;
    }
  }

  if (total === 0) {
    return {
      score: 0,
      detail: "No daily valuations computed",
      whyMatters,
      guidance: "Run Quick Refresh to compute today's valuation.",
      pricedCount: 0,
      totalCount: 0,
      perAccountAsOf,
    };
  }

  const score = Math.round((priced / total) * 100);
  const detail = priced === total
    ? `All ${total} holdings in latest valuation`
    : `${priced}/${total} holdings priced in latest valuation`;

  const guidance =
    score >= 95
      ? "Full coverage in the latest valuation."
      : score >= 50
        ? "Run Quick Refresh to price the remaining holdings."
        : "Many holdings unpriced — Quick Refresh, then enrich any still missing.";

  return { score, detail, whyMatters, guidance, pricedCount: priced, totalCount: total, perAccountAsOf };
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

export function getDataConfidence(db: Database.Database, now: Date = new Date()): DataConfidence {
  const priceFreshness = scorePriceFreshness(db, now);
  const holdingsRecency = scoreHoldingsRecency(db, now);
  const cashAccuracy = scoreCashAccuracy(db, now);
  const enrichmentCompleteness = scoreEnrichment(db);
  const valuationCoverage = scoreValuationCoverage(db);

  let overallScore = Math.round(
    priceFreshness.score * WEIGHTS.priceFreshness +
    holdingsRecency.score * WEIGHTS.holdingsRecency +
    cashAccuracy.score * WEIGHTS.cashAccuracy +
    enrichmentCompleteness.score * WEIGHTS.enrichment +
    valuationCoverage.score * WEIGHTS.valuationCoverage,
  );

  let overallLevel: DataConfidence["overallLevel"] =
    overallScore >= 80 ? "high" :
    overallScore >= 50 ? "medium" :
    overallScore >= 20 ? "low" :
    "stale";

  // Integrity gate (spec WS3, task 18): cross-cutting number-trust checks
  // are independent of the 5 weighted dimensions above — a critical hit
  // caps the score/level AFTER the weighted mean, never blends into it.
  // Monotonic only: the cap can lower overallLevel but never promote it, so
  // a "stale" result (already below the cap) stays "stale", not bumped up
  // to "low". Warnings never cap — informational only.
  const integrity = runIntegrityChecks(db);
  let capReason: string | null = null;
  if (integrity.critical.length > 0) {
    capReason = integrity.critical[0].reason;
    overallScore = Math.min(overallScore, 45);
    if (overallLevel === "high" || overallLevel === "medium") overallLevel = "low";
  }

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
    integrity,
    capReason,
  };
}
