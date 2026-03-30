import Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import {
  getRoundTrips,
  computeRoundTripSummary,
  type RoundTrip,
} from "@/lib/compute/trade-roundtrips";
import { getPriorReviewSummaries } from "@/lib/queries/trade-reviews";
import {
  saveTradeReview,
  saveTradeRoundtrips,
} from "@/lib/mutations/trade-reviews";
import { buildTradeReviewPrompt } from "./prompt";
import { fetchVitalKnowledge } from "@/lib/vital-knowledge";
import type { TradeReview } from "@/lib/types";

const REVIEW_MODEL = "claude-opus-4-6";

/** Tool schema for structured output — forces Claude to return both markdown and structured data */
const REVIEW_TOOL: Anthropic.Tool = {
  name: "submit_trade_review",
  description:
    "Submit the completed trade review with structured analysis. Call this tool once with all analysis results.",
  input_schema: {
    type: "object" as const,
    properties: {
      review_markdown: {
        type: "string",
        description:
          "Full monthly trade review in markdown format. Include: overview, per-trade analysis, patterns, and recommendations.",
      },
      trade_grades: {
        type: "array",
        description:
          "Grade for each trade. Must have one entry per trade in the table.",
        items: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            entry_date: { type: "string", description: "YYYY-MM-DD" },
            exit_date: { type: "string", description: "YYYY-MM-DD" },
            grade: {
              type: "string",
              enum: ["A", "B", "C", "D", "F"],
            },
            entry_thesis: {
              type: "string",
              description: "Inferred reason for entering",
            },
            exit_assessment: {
              type: "string",
              description: "Assessment of exit timing and discipline",
            },
            what_went_well: { type: "string" },
            what_went_wrong: { type: "string" },
          },
          required: [
            "symbol",
            "entry_date",
            "exit_date",
            "grade",
            "entry_thesis",
            "exit_assessment",
          ],
        },
      },
      patterns_identified: {
        type: "array",
        items: { type: "string" },
        description: "Behavioral patterns observed this month",
      },
      strengths: {
        type: "array",
        items: { type: "string" },
        description: "What the trader did well this month",
      },
      weaknesses: {
        type: "array",
        items: { type: "string" },
        description: "Areas needing improvement",
      },
      cumulative_patterns: {
        type: "array",
        items: { type: "string" },
        description:
          "Patterns across all months analyzed (only if 3+ months of history available)",
      },
    },
    required: [
      "review_markdown",
      "trade_grades",
      "patterns_identified",
      "strengths",
      "weaknesses",
    ],
  },
};

export interface TradeReviewResult {
  review: TradeReview;
  roundTrips: RoundTrip[];
  tradeCount: number;
}

/**
 * Generate a monthly trade review using Claude Opus.
 * Extracts round-trips, builds context, calls the API, and saves results.
 */
export async function generateTradeReview(
  db: Database.Database,
  params: {
    accountId: number;
    periodStart: string;
    periodEnd: string;
    importBatchId?: number | null;
  },
  options?: {
    onProgress?: (msg: string, current?: number, total?: number) => void;
  }
): Promise<TradeReviewResult> {
  const totalSteps = 5;

  // Step 1: Extract round-trips
  options?.onProgress?.(
    "Computing round-trip trades from tax lots...",
    1,
    totalSteps
  );
  const roundTrips = getRoundTrips(
    db,
    params.accountId,
    params.periodStart,
    params.periodEnd
  );

  if (roundTrips.length === 0) {
    throw new Error(
      `No closed trades found for this account in ${params.periodStart} to ${params.periodEnd}`
    );
  }

  const summary = computeRoundTripSummary(roundTrips);

  // Step 2: Get prior reviews for cumulative context
  options?.onProgress?.("Loading prior review context...", 2, totalSteps);
  const priorReviews = getPriorReviewSummaries(
    db,
    params.accountId,
    params.periodStart,
    6
  );

  // Step 3: Build market context (optional)
  let marketContext: string | undefined;
  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (gmailAddress && gmailAppPassword) {
    options?.onProgress?.(
      "Fetching market context from Vital Knowledge...",
      3,
      totalSteps
    );
    try {
      const vk = await fetchVitalKnowledge(gmailAddress, gmailAppPassword, 30);
      if (vk) marketContext = vk;
    } catch {
      // Non-critical — continue without market context
    }
  }

  // Step 4: Call Claude API
  options?.onProgress?.(
    `Analyzing ${roundTrips.length} trades with Claude Opus...`,
    4,
    totalSteps
  );

  const periodLabel = formatPeriodLabel(params.periodStart, params.periodEnd);
  const { system, user } = buildTradeReviewPrompt(
    roundTrips,
    summary,
    priorReviews,
    periodLabel,
    marketContext
  );

  const client = new Anthropic();
  const response = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    tools: [REVIEW_TOOL],
    tool_choice: { type: "tool", name: "submit_trade_review" },
  });

  // Extract the tool_use block
  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Claude did not return structured trade review data");
  }

  const result = toolBlock.input as {
    review_markdown: string;
    trade_grades: Array<{
      symbol: string;
      entry_date: string;
      exit_date: string;
      grade: string;
      entry_thesis?: string;
      exit_assessment?: string;
      what_went_well?: string;
      what_went_wrong?: string;
    }>;
    patterns_identified: string[];
    strengths: string[];
    weaknesses: string[];
    cumulative_patterns?: string[];
  };

  // Step 5: Save to database
  options?.onProgress?.("Saving review to database...", 5, totalSteps);

  const review = saveTradeReview(db, {
    accountId: params.accountId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    importBatchId: params.importBatchId ?? null,
    totalTrades: summary.totalTrades,
    winningTrades: summary.winningTrades,
    losingTrades: summary.losingTrades,
    winRate: summary.winRate,
    totalRealizedPnl: summary.totalRealizedPnl,
    avgHoldingDays: summary.avgHoldingDays,
    bestTradePnl: summary.bestTradePnl,
    bestTradeSymbol: summary.bestTradeSymbol,
    worstTradePnl: summary.worstTradePnl,
    worstTradeSymbol: summary.worstTradeSymbol,
    avgWin: summary.avgWin,
    avgLoss: summary.avgLoss,
    profitFactor: summary.profitFactor,
    reviewMarkdown: result.review_markdown,
    tradeGrades: JSON.stringify(result.trade_grades),
    patternsIdentified: JSON.stringify(result.patterns_identified),
    strengths: JSON.stringify(result.strengths),
    weaknesses: JSON.stringify(result.weaknesses),
    cumulativePatterns: result.cumulative_patterns
      ? JSON.stringify(result.cumulative_patterns)
      : null,
    model: REVIEW_MODEL,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
  });

  // Save round-trips with AI grades matched by symbol + exit_date
  saveTradeRoundtrips(db, review.id, roundTrips, result.trade_grades);

  return {
    review,
    roundTrips,
    tradeCount: roundTrips.length,
  };
}

function formatPeriodLabel(periodStart: string, periodEnd: string): string {
  const d = new Date(periodStart + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
