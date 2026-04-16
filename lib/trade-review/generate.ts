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
import { getRecentArticles } from "@/lib/queries/research";
import { getIbApi } from "@/lib/tws/client";
import { fetchHistoricalPrices } from "@/lib/tws/historical";
import { fetchBenchmarkPrices } from "@/lib/tws/benchmark";
import type { TradeReview } from "@/lib/types";

const REVIEW_MODEL_OPUS = "claude-opus-4-7";
const REVIEW_MODEL_SONNET = "claude-sonnet-4-7";
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
                "2-3 sentence overall assessment of this trade, grounded in the data provided. Must reflect trim vs full exit status and any capital rotation shown in market context.",
            },
            what_worked: { type: "string" },
            what_didnt: {
              type: "string",
              description:
                "What could have been better. Must be consistent with the review_markdown — do not contradict trim/rotation facts stated there.",
            },
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
  const totalSteps = 5;
  const { groupedTrades, summary, accountName } = preparedData;

  // Step 1: Get prior reviews for cumulative context
  options?.onProgress?.("Loading prior review context...", 1, totalSteps);
  const priorReviews = getPriorReviewSummaries(
    db,
    params.accountId,
    params.periodStart,
    6
  );

  // Step 2: Backfill price history from TWS if available and needed
  await backfillPriceData(db, groupedTrades, (msg) => {
    options?.onProgress?.(msg, 2, totalSteps);
  });

  // Step 3: Build market context string + optional Vital Knowledge
  options?.onProgress?.("Building analysis context...", 3, totalSteps);

  const marketContexts = getMarketContext(db, groupedTrades, params.accountId);
  let marketContextStr = formatMarketContext(marketContexts, groupedTrades);

  // Append Vital Knowledge newsletter context — anchored to trade period, not today
  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  const periodEndDate = new Date(params.periodEnd + "T23:59:59");
  if (gmailAddress && gmailAppPassword) {
    try {
      const vk = await fetchVitalKnowledge(
        gmailAddress,
        gmailAppPassword,
        30,
        periodEndDate
      );
      if (vk) {
        marketContextStr += `\n\n## Market Newsletter Context\n${vk}`;
      }
    } catch {
      // Non-critical — continue without newsletter context
    }
  }

  // Also pull research articles from the trade period (local DB — works for historical reviews)
  try {
    const periodArticles = getRecentArticles(db, {
      startDate: params.periodStart,
      endDate: params.periodEnd,
      processedOnly: true,
      limit: 15,
    });
    if (periodArticles.length > 0) {
      const articleSummaries = periodArticles
        .map((a) => {
          const dateStr = a.received_at?.split("T")[0] ?? "";
          return `[${dateStr}] ${a.source_name}: ${a.subject}\n${a.summary ?? "(no summary)"}`;
        })
        .join("\n\n");
      marketContextStr += `\n\n## Research Feed Context (${params.periodStart} to ${params.periodEnd})\n${articleSummaries}`;
    }
  } catch {
    // Non-critical — continue without research feed context
  }

  // Step 4: Call Claude API
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
    4,
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

// ─── Price backfill ──────────────────────────────────────────────

/** Minimum data points for the quality gate in market-context.ts */
const MIN_PRICE_POINTS = 5;

/**
 * Check price coverage for trade securities and SPY benchmark.
 * If TWS is connected and data is insufficient, fetch from TWS.
 * Silently skips if TWS is not available — review proceeds with whatever data exists.
 */
async function backfillPriceData(
  db: Database.Database,
  groupedTrades: GroupedTrade[],
  onProgress?: (msg: string) => void
): Promise<void> {
  // Quick check: is TWS connected?
  const api = getIbApi();
  if (!api) {
    onProgress?.("TWS not connected — using cached price data");
    return;
  }

  // Determine the overall date range across all trades
  let overallStart = "9999-12-31";
  let overallEnd = "0000-01-01";

  // Identify securities that need price data
  const securitiesToFetch: number[] = [];
  const seen = new Set<number>();

  for (const trade of groupedTrades) {
    if (trade.earliestEntryDate < overallStart) overallStart = trade.earliestEntryDate;
    if (trade.exitDate > overallEnd) overallEnd = trade.exitDate;

    if (seen.has(trade.securityId)) continue;
    seen.add(trade.securityId);

    // Check existing coverage for this security
    const priceCount = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM (
           SELECT date as d FROM prices WHERE security_id = ? AND date >= ? AND date <= ?
           UNION ALL
           SELECT bar_date as d FROM ohlcv_bars WHERE security_id = ? AND bar_date >= ? AND bar_date <= ? AND bar_size = '1 day'
         )`
      )
      .get(
        trade.securityId, trade.earliestEntryDate, trade.exitDate,
        trade.securityId, trade.earliestEntryDate, trade.exitDate
      ) as { cnt: number };

    if (priceCount.cnt < MIN_PRICE_POINTS) {
      securitiesToFetch.push(trade.securityId);
    }
  }

  // Check SPY benchmark coverage
  let needBenchmark = false;
  {
    const spyCount = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM benchmark_prices
         WHERE symbol = 'SPY' AND date >= ? AND date <= ?`
      )
      .get(overallStart, overallEnd) as { cnt: number };

    if (spyCount.cnt < MIN_PRICE_POINTS) {
      // Also check SPY in prices/ohlcv as fallback source
      const spySec = db
        .prepare(`SELECT id FROM securities WHERE UPPER(symbol) = 'SPY' LIMIT 1`)
        .get() as { id: number } | undefined;

      if (spySec) {
        const spyPriceCount = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM (
               SELECT date as d FROM prices WHERE security_id = ? AND date >= ? AND date <= ?
               UNION ALL
               SELECT bar_date as d FROM ohlcv_bars WHERE security_id = ? AND bar_date >= ? AND bar_date <= ? AND bar_size = '1 day'
             )`
          )
          .get(
            spySec.id, overallStart, overallEnd,
            spySec.id, overallStart, overallEnd
          ) as { cnt: number };

        if (spyPriceCount.cnt < MIN_PRICE_POINTS) {
          needBenchmark = true;
        }
      } else {
        needBenchmark = true;
      }
    }
  }

  if (securitiesToFetch.length === 0 && !needBenchmark) {
    onProgress?.("Price data sufficient — skipping TWS fetch");
    return;
  }

  // Compute duration string from date range (cap at 2Y — IB's max for daily bars)
  const daysNeeded = Math.ceil(
    (new Date(overallEnd).getTime() - new Date(overallStart).getTime()) /
      (24 * 3600 * 1000)
  );
  const durationStr = daysNeeded > 365 ? "2 Y" : `${Math.max(30, daysNeeded + 10)} D`;

  // Fetch security prices
  if (securitiesToFetch.length > 0) {
    const symbols = securitiesToFetch
      .map((id) => {
        const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(id) as { symbol: string } | undefined;
        return row?.symbol ?? `#${id}`;
      })
      .join(", ");
    onProgress?.(`Fetching price history for ${symbols} from TWS...`);

    try {
      await fetchHistoricalPrices(db, {
        securityIds: securitiesToFetch,
        durationStr,
      });
    } catch {
      // Non-critical — continue with whatever data exists
    }
  }

  // Fetch SPY benchmark
  if (needBenchmark) {
    onProgress?.("Fetching SPY benchmark prices from TWS...");
    try {
      await fetchBenchmarkPrices(db, {
        symbols: ["SPY"],
        durationStr,
        incremental: false,
      });
    } catch {
      // Non-critical — continue without benchmark
    }
  }

  const fetched = [
    ...(securitiesToFetch.length > 0 ? [`${securitiesToFetch.length} security prices`] : []),
    ...(needBenchmark ? ["SPY benchmark"] : []),
  ].join(" + ");
  onProgress?.(`Price backfill complete (${fetched})`);
}
