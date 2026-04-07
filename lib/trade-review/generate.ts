import Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import {
  getRoundTrips,
  computeGroupedTrades,
  computeGroupedSummary,
  filterFullyCoveredTrades,
  type GroupedTrade,
} from "@/lib/compute/trade-roundtrips";
import { getPriorReviewSummaries } from "@/lib/queries/trade-reviews";
import {
  saveTradeReview,
  saveTradeRoundtrips,
} from "@/lib/mutations/trade-reviews";
import { buildTradeReviewPrompt } from "./prompt";
import { getMarketContext, formatMarketContext } from "./market-context";
import {
  generateQuestions,
  getAccountProfile,
  type TradeQuestion,
  type TradeAnswer,
} from "./questions";
import { fetchVitalKnowledge } from "@/lib/vital-knowledge";
import type { TradeReview } from "@/lib/types";

const REVIEW_MODEL_OPUS = "claude-opus-4-6";
const REVIEW_MODEL_SONNET = "claude-sonnet-4-20250514";
/** Use Sonnet for months with many trades to avoid timeouts */
const SONNET_TRADE_THRESHOLD = 20;

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
          "Grade for each trade. Must have one entry per trade in the table (one per grouped sale, not per lot).",
        items: {
          type: "object",
          properties: {
            trade_number: {
              type: "number",
              description: "Matches the # column in the trade table",
            },
            symbol: { type: "string" },
            exit_date: { type: "string", description: "YYYY-MM-DD" },
            grade: {
              type: "string",
              enum: ["A", "B", "C", "D", "F"],
            },
            assessment: {
              type: "string",
              description:
                "2-3 sentence overall assessment of this trade, grounded in the data provided.",
            },
            what_worked: { type: "string" },
            what_didnt: { type: "string" },
          },
          required: [
            "trade_number",
            "symbol",
            "exit_date",
            "grade",
            "assessment",
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
  groupedTrades: GroupedTrade[];
  tradeCount: number;
}

export interface TradeReviewPreparedData {
  groupedTrades: GroupedTrade[];
  summary: ReturnType<typeof computeGroupedSummary>;
  questions: TradeQuestion[];
  accountName: string;
}

/**
 * Phase 1: Prepare data and generate clarifying questions.
 * Returns the prepared data + any questions for the UI.
 */
export async function prepareTradeReview(
  db: Database.Database,
  params: {
    accountId: number;
    periodStart: string;
    periodEnd: string;
  },
  options?: {
    onProgress?: (msg: string, current?: number, total?: number) => void;
  }
): Promise<TradeReviewPreparedData> {
  const totalSteps = 4;

  // Step 1: Extract round-trips and group
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

  const allGrouped = computeGroupedTrades(roundTrips);
  // Filter out trades with incomplete lot coverage (e.g., positions held before import history)
  const groupedTrades = filterFullyCoveredTrades(allGrouped);

  if (groupedTrades.length === 0) {
    throw new Error(
      `No fully-tracked trades found for this period. ${allGrouped.length} trade(s) were excluded due to incomplete cost basis data (positions may pre-date imported transaction history).`
    );
  }

  const summary = computeGroupedSummary(groupedTrades);

  // Get account name for profile lookup
  const accountRow = db
    .prepare("SELECT name FROM accounts WHERE id = ?")
    .get(params.accountId) as { name: string } | undefined;
  const accountName = accountRow?.name ?? "Unknown";

  // Step 2: Fetch market context
  options?.onProgress?.(
    `Fetching price history for ${groupedTrades.length} trade(s)...`,
    2,
    totalSteps
  );
  const marketContexts = getMarketContext(db, groupedTrades, params.accountId);

  // Step 3: Generate clarifying questions
  options?.onProgress?.(
    "Checking if any trades need clarification...",
    3,
    totalSteps
  );
  const accountProfile = getAccountProfile(accountName);

  let questions: TradeQuestion[] = [];
  try {
    questions = await generateQuestions(
      groupedTrades,
      summary,
      marketContexts,
      accountProfile
    );
  } catch {
    // Non-critical — continue without questions
  }

  options?.onProgress?.(
    questions.length > 0
      ? `${questions.length} question(s) about your trades`
      : "All trades have sufficient context",
    4,
    totalSteps
  );

  return { groupedTrades, summary, questions, accountName };
}

/**
 * Phase 2: Generate the full trade review with Claude Opus.
 * Called after the user answers questions (or skips them).
 */
export async function generateTradeReview(
  db: Database.Database,
  params: {
    accountId: number;
    periodStart: string;
    periodEnd: string;
    importBatchId?: number | null;
  },
  preparedData: TradeReviewPreparedData,
  answers?: TradeAnswer[],
  options?: {
    onProgress?: (msg: string, current?: number, total?: number) => void;
  }
): Promise<TradeReviewResult> {
  const totalSteps = 4;
  const { groupedTrades, summary, accountName } = preparedData;

  // Step 1: Get prior reviews for cumulative context
  options?.onProgress?.("Loading prior review context...", 1, totalSteps);
  const priorReviews = getPriorReviewSummaries(
    db,
    params.accountId,
    params.periodStart,
    6
  );

  // Step 2: Build market context string + optional Vital Knowledge
  options?.onProgress?.("Building analysis context...", 2, totalSteps);

  const marketContexts = getMarketContext(db, groupedTrades, params.accountId);
  let marketContextStr = formatMarketContext(marketContexts, groupedTrades);

  // Append Vital Knowledge newsletter context if available
  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (gmailAddress && gmailAppPassword) {
    try {
      const vk = await fetchVitalKnowledge(gmailAddress, gmailAppPassword, 30);
      if (vk) {
        marketContextStr += `\n\n## Market Newsletter Context\n${vk}`;
      }
    } catch {
      // Non-critical — continue without newsletter context
    }
  }

  // Step 3: Call Claude API
  const periodLabel = formatPeriodLabel(params.periodStart, params.periodEnd);
  const accountProfile = getAccountProfile(accountName);
  const { system, user } = buildTradeReviewPrompt(
    groupedTrades,
    summary,
    priorReviews,
    periodLabel,
    accountProfile,
    marketContextStr || undefined,
    answers
  );

  // Use Sonnet for large months (faster, avoids timeouts), Opus for smaller ones
  const tradeCount = groupedTrades.length;
  const model =
    tradeCount > SONNET_TRADE_THRESHOLD
      ? REVIEW_MODEL_SONNET
      : REVIEW_MODEL_OPUS;
  // Scale max_tokens with trade count — each grade needs ~150 tokens
  const maxTokens = Math.min(
    Math.max(8000, 4000 + tradeCount * 200),
    32000
  );

  options?.onProgress?.(
    `Analyzing ${tradeCount} trade(s) with ${model === REVIEW_MODEL_OPUS ? "Claude Opus" : "Claude Sonnet"}...`,
    3,
    totalSteps
  );

  const client = new Anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
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
      trade_number: number;
      symbol: string;
      exit_date: string;
      grade: string;
      assessment?: string;
      what_worked?: string;
      what_didnt?: string;
    }>;
    patterns_identified: string[];
    strengths: string[];
    weaknesses: string[];
    cumulative_patterns?: string[];
  };

  // Step 4: Save to database
  options?.onProgress?.("Saving review to database...", 4, totalSteps);

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
    model,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
  });

  // Save round-trips with AI grades matched by trade_number
  const allRoundTrips = groupedTrades.flatMap((g) => g.lots);
  saveTradeRoundtrips(
    db,
    review.id,
    allRoundTrips,
    groupedTrades,
    result.trade_grades
  );

  return {
    review,
    groupedTrades,
    tradeCount: groupedTrades.length,
  };
}

function formatPeriodLabel(periodStart: string, periodEnd: string): string {
  const d = new Date(periodStart + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
