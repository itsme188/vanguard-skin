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
 */
import type Database from "better-sqlite3";
import { getDataConfidence, type DimensionScore } from "@/lib/queries/data-confidence";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  scopeBlock,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_DATA_CONFIDENCE_NAME = "query_data_confidence";

const ACTIONS_SHOWN = 5;

export const DATA_CONFIDENCE_SCOPE_ERROR =
  "Data confidence covers the whole portfolio and cannot be limited to one account. Ask in the All Accounts scope, without account_name.";

const definition: CompositeTool["definition"] = {
  name: QUERY_DATA_CONFIDENCE_NAME,
  description:
    "How far today's figures can be trusted, as the header's data-confidence indicator and the Data Health page show it: the overall score (0-100) and level, the score and one-line reason for each of the five dimensions (price freshness, holdings recency, cash accuracy, enrichment, valuation coverage), the reason the score was capped if it was, the first suggested actions, and the integrity scan's counts by severity (and whether the tax-lot comparison ran at all). Whole portfolio only: leave account_name out; in a single-account chat this tool returns an error. Use for 'can I trust these numbers', 'is my data stale', 'what needs fixing'. Do NOT use for one result's own freshness (every tool result already carries data_freshness) or for figures (no dollar amount is returned).",
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
    units: {
      score:
        "0-100; level high >= 80, medium >= 50, low >= 20, below that stale. A critical integrity hit caps the score at 45 and the level at low; 'unverified' replaces 'high' while the tax-lot comparison has not run.",
      integrity: "counts of findings",
    },
  };
}

export const queryDataConfidenceTool: CompositeTool = { definition, run, acceptsScopeList: false };
