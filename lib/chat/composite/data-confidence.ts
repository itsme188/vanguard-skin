/**
 * query_data_confidence: the header's data-confidence score from
 * `getDataConfidence(db)` (as `app/api/data-confidence/route.ts` and the
 * Data Health page call it), summarised.
 *
 * The engine has no account scope (plan P3): its reasons name symbols and
 * accounts across the whole portfolio. Any account scope (a single-account
 * chat, whose clamp always sets account_name, or a model-chosen account) is
 * therefore refused, so nothing crosses an account boundary.
 *
 * No dollar figure leaves this tool: amounts inside the engine's text (a cash
 * residual, for example) are replaced with "(amount omitted)".
 *
 * Named items (which security is stale, which account is old, which finding)
 * come only from what the engine and the Data Health page's own readers
 * already return: `getPriceFreshness` and `getDataGaps`
 * (lib/queries/data-health.ts, behind /api/data-health), and the engine's
 * per-account, enrichment, cash and integrity fields. No new scan.
 */
import type Database from "better-sqlite3";
import { getDataConfidence, PRICE_FRESHNESS_DAYS, type DimensionScore } from "@/lib/queries/data-confidence";
import { getDataGaps, getPriceFreshness } from "@/lib/queries/data-health";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  scopeBlock,
  takeList,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_DATA_CONFIDENCE_NAME = "query_data_confidence";

const ACTIONS_SHOWN = 5;
/** Named items listed per kind (stale prices, findings, ...); list_info when cut. */
const ITEMS_SHOWN = 10;

export const DATA_CONFIDENCE_SCOPE_ERROR =
  "Data confidence covers the whole portfolio and cannot be limited to one account. Ask in the All Accounts scope, without account_name.";

const definition: CompositeTool["definition"] = {
  name: QUERY_DATA_CONFIDENCE_NAME,
  description:
    "How far today's figures can be trusted, as the header's data-confidence indicator and the Data Health page show it: the overall score (0-100) and level, the score and one-line reason for each of the five dimensions (price freshness, holdings recency, cash accuracy, enrichment, valuation coverage), the reason the score was capped if it was, the first suggested actions, and the integrity scan's counts by severity (and whether the tax-lot comparison ran at all). items names what each problem is about: the held securities with a stale or missing price and their last price dates (oldest first), each account's latest and stalest holdings dates, held securities with no transactions, holdings rows over 90 days old, securities missing contract data, the cash anchor, and the integrity findings. Whole portfolio only: leave account_name out; in a single-account chat this tool returns an error. Use for 'can I trust these numbers', 'is my data stale', 'what needs fixing'. Do NOT use for one result's own freshness (every tool result already carries data_freshness) or for figures (no dollar amount is returned).",
  input_schema: {
    type: "object" as const,
    properties: {
      account_name: {
        ...ACCOUNT_NAME_FIELD,
        description: "Leave out. This tool covers the whole portfolio; any account name returns an error.",
      },
    },
  },
};

/** Dollar amounts inside engine text, e.g. "$1,234.56", "-$12k", "$ 3.4M". */
const DOLLAR_AMOUNT = /[-−]?\$\s?[-−]?\d[\d,]*(?:\.\d+)?(?:[kKmMbB]\b)?/g;

export function omitAmounts(text: string): string {
  return text.replace(DOLLAR_AMOUNT, "(amount omitted)");
}

function dimension(d: DimensionScore) {
  return { score: d.score, reason: omitAmounts(d.detail), action_needed: d.guidanceActionable };
}

type Confidence = ReturnType<typeof getDataConfidence>;

function list<T>(rows: T[]) {
  const t = takeList(rows, ITEMS_SHOWN, ITEMS_SHOWN);
  return t.info.truncated ? { shown: t.rows, list_info: t.info } : { shown: t.rows };
}

function buildItems(db: Database.Database, c: Confidence) {
  // Held securities whose newest price is older than the engine's freshness
  // window, or that have none: the same window and held universe the price
  // freshness score counts (totalHeld - pricedRecent). The reader sorts
  // never-priced first, then oldest first.
  const stale = getPriceFreshness(db)
    .filter((p) => p.hasHoldings && (p.daysStalePrices === null || p.daysStalePrices > PRICE_FRESHNESS_DAYS))
    .map((p) => ({ symbol: p.symbol, last_price_date: p.latestPriceDate, days_since: p.daysStalePrices }));
  const gaps = getDataGaps(db);
  const cash = c.cashAccuracy;
  const findings = [
    ...c.integrity.critical.map((h) => ({ severity: "critical", reason: omitAmounts(h.reason) })),
    ...c.integrity.warnings.map((h) => ({ severity: "warning", reason: omitAmounts(h.reason) })),
  ];
  return {
    stale_prices: { window_days: PRICE_FRESHNESS_DAYS, count: stale.length, ...list(stale) },
    holdings_by_account: c.holdingsRecency.perAccount.map((a) => ({
      account: a.name,
      latest_date: a.latestDate,
      stalest_position_date: a.date,
      stalest_symbol: a.stalestSymbol,
      days_old: a.daysOld,
      positions: a.heldCount,
    })),
    held_without_transactions: {
      note: "Held, but no transaction on file, so no tax lots can be built for them.",
      count: gaps.securitiesNoTransactions.length,
      ...list(gaps.securitiesNoTransactions.map((g) => g.symbol)),
    },
    holdings_over_90_days_old: {
      count: gaps.staleHoldings.length,
      ...list(gaps.staleHoldings.map((h) => ({ symbol: h.symbol, account: h.accountName, as_of: h.asOfDate, days_since: h.daysSince }))),
    },
    missing_contract_data: { count: c.enrichmentCompleteness.missing.length, ...list(c.enrichmentCompleteness.missing) },
    cash: {
      latest_anchor_date: cash.latestAnchorDate,
      days_since_anchor: cash.daysSinceAnchor,
      unexplained_flow: cash.unexplainedFlow
        ? { account: cash.unexplainedFlow.accountName, date: cash.unexplainedFlow.date, classification: cash.unexplainedFlow.classification }
        : null,
      timing_residual: cash.timingResidual ? { account: cash.timingResidual.accountName, date: cash.timingResidual.date } : null,
    },
    integrity_findings: { count: findings.length, ...list(findings) },
  };
}

function run(db: Database.Database, _input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  if (accountIds !== undefined) return { error: DATA_CONFIDENCE_SCOPE_ERROR };

  const c = ctx.now ? getDataConfidence(db, ctx.now) : getDataConfidence(db);

  return {
    as_of: ctx.today,
    scope: scopeBlock(db, undefined),
    overall: { score: c.overallScore, level: c.overallLevel },
    cap_reason: c.capReason === null ? null : omitAmounts(c.capReason),
    dimensions: {
      price_freshness: dimension(c.priceFreshness),
      holdings_recency: dimension(c.holdingsRecency),
      cash_accuracy: dimension(c.cashAccuracy),
      enrichment: dimension(c.enrichmentCompleteness),
      valuation_coverage: dimension(c.valuationCoverage),
    },
    actions: c.actions.slice(0, ACTIONS_SHOWN).map((a) => ({ severity: a.severity, action: omitAmounts(a.message) })),
    actions_total: c.actions.length,
    integrity: {
      critical: c.integrity.critical.length,
      warnings: c.integrity.warnings.length,
      lot_drift_critical: c.lotDriftCriticalCount,
      lot_drift_checked: c.integrity.lotDriftChecked,
      ...(c.integrity.lotDriftChecked
        ? {}
        : { note: "The position-to-tax-lot comparison did not run (tax lots await a recompute): unchecked, not clean." }),
    },
    items: buildItems(db, c),
    units: {
      last_price_date: "the security's newest stored price; null = never priced",
      days_since: "calendar days to today (Eastern)",
      score:
        "0-100; level high >= 80, medium >= 50, low >= 20, below that stale. A critical integrity hit caps the score at 45 and the level at low; 'unverified' replaces 'high' while the tax-lot comparison has not run.",
      integrity: "counts of findings",
    },
  };
}

export const queryDataConfidenceTool: CompositeTool = { definition, run, acceptsScopeList: false };
