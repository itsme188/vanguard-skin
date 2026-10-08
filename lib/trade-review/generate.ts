import type Database from "better-sqlite3";
import { jsonSchema } from "ai";
import { generateObjectForFeature } from "@/lib/ai/generate";
import { resolveFeatureModel } from "@/lib/ai/models";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import {
  getRoundTrips,
  computeGroupedTrades,
  computeGroupedSummary,
  filterFullyCoveredTrades,
  partitionSyntheticCloses,
  type GroupedTrade,
} from "@/lib/compute/trade-roundtrips";
import { getPriorReviewSummaries } from "@/lib/queries/trade-reviews";
import {
  saveTradeReview,
  saveTradeRoundtrips,
} from "@/lib/mutations/trade-reviews";
import { buildTradeReviewPrompt } from "./prompt";
import {
  getMarketContext,
  formatMarketContext,
  countCachedPricePoints,
} from "./market-context";
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
import { PRICED_BAR_SQL } from "@/lib/queries/ohlcv";
import { todayET } from "@/lib/calendar/date-utils";

/** Use the "large" model slot for months with many trades — defaults to Sonnet to avoid Opus timeouts */
const SONNET_TRADE_THRESHOLD = 20;

interface TradeReviewStructured {
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
}

/**
 * Schema for structured output — forces Claude to return both markdown and
 * structured data. EVERY object node carries `additionalProperties: false`:
 * Anthropic's native structured output (`output_config.format.json_schema`,
 * which lib/ai/generate.ts now asks for) rejects a schema without it with a
 * 400. Pinned by tests/ai/structured-output-schemas.test.ts.
 *
 * Exported for that test only — the live caller is `callModel` below.
 */
export const REVIEW_SCHEMA = jsonSchema<TradeReviewStructured>({
  type: "object",
  additionalProperties: false,
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
          additionalProperties: false,
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
});

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

  // Engine-owned RECONCILE_CLOSE rows are not the user's exits — drop them
  // before coverage filtering, the summary, questions and the prompt.
  const { userTrades: allGrouped, syntheticCount } = partitionSyntheticCloses(
    computeGroupedTrades(roundTrips)
  );
  if (syntheticCount > 0) {
    if (allGrouped.length === 0) {
      throw new Error(
        `No user trades in this period — the ${syntheticCount} closes recorded are engine reconciliations, not your exits`
      );
    }
    options?.onProgress?.(
      `Note: ${syntheticCount} engine-reconciled close(s) excluded — not user trades`,
      1,
      totalSteps
    );
  }
  // Filter out trades with incomplete lot coverage (e.g., positions held before import history)
  const groupedTrades = filterFullyCoveredTrades(allGrouped);

  if (groupedTrades.length === 0) {
    throw new Error(
      `No fully-tracked trades found for this period. ${allGrouped.length} trade(s) were excluded due to incomplete cost basis data (positions may pre-date imported transaction history).`
    );
  }

  // Surface partial exclusions so the user knows when the dropdown's count
  // doesn't match the number of trades actually reviewed.
  const excludedCount = allGrouped.length - groupedTrades.length;
  if (excludedCount > 0) {
    options?.onProgress?.(
      `Note: ${excludedCount} of ${allGrouped.length} trade(s) excluded — positions pre-date imported transaction history`,
      1,
      totalSteps
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

  // A price range read from a history that stops short of the exit is not the
  // period's range. Such a trade is graded without one (the prompt then says
  // price history is unavailable) rather than on a high the stock later beat.
  const marketContexts = getMarketContext(db, groupedTrades, params.accountId).map(
    (ctx, i) =>
      ctx.stockContext &&
      !priceCoverageReachesExit(
        db,
        groupedTrades[i].securityId,
        groupedTrades[i].earliestEntryDate,
        groupedTrades[i].exitDate
      )
        ? { ...ctx, stockContext: null }
        : ctx
  );
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
      relevantOnly: true,
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

  // Pick Opus for small months, Sonnet for large (via separate feature keys so
  // either can be independently swapped in FEATURE_MODELS without touching code).
  const tradeCount = groupedTrades.length;
  const featureKey: FeatureKey =
    tradeCount > SONNET_TRADE_THRESHOLD ? "tradeReviewMainLarge" : "tradeReviewMain";
  const modelSpec = resolveFeatureModel(featureKey).modelId;
  // Scale max_tokens with trade count.
  // Each trade_grade entry (with assessment + what_worked + what_didnt) is
  // realistically 300-500 output tokens. review_markdown alone is typically
  // 2000-5000 tokens. Patterns/strengths/weaknesses add ~1500.
  // The previous formula (4000 + tradeCount * 200, capped at 32k) was too
  // tight for big months — Vanguard with 30+ trades hit the cap mid-output,
  // truncating review_markdown to empty and triggering the NOT NULL
  // constraint on save. Bump baseline + per-trade scale, raise cap to Sonnet's
  // 64k output limit.
  const maxTokens = Math.min(
    Math.max(12000, 5000 + tradeCount * 400),
    64000
  );

  options?.onProgress?.(
    `Analyzing ${tradeCount} trade(s) with ${modelSpec}...`,
    4,
    totalSteps
  );

  // Empirically, Opus 4.7 in structured-output mode sometimes returns an empty
  // `review_markdown` even with token budget to spare — the failure is not
  // strictly a truncation, but a model-side decision that produced no content
  // for the most important field. We try three strategies in order:
  //   1. Primary model with the standard prompt.
  //   2. Same model + emphatic system-prompt addendum reminding it the field
  //      is required and trade_grades may be skipped first.
  //   3. Fall back to the *other* model (Opus → Sonnet, or vice versa). This
  //      handles cases where one model has a content-specific quirk on this
  //      particular input — the alternative usually succeeds.
  const isReviewMarkdownEmpty = (md: unknown): boolean =>
    !md || typeof md !== "string" || md.trim().length < 100;

  // Always dump the prompt + model output to a debug file so we can inspect
  // what's actually going to the model. Lives outside git.
  const debugLog = async (
    label: string,
    payload: Record<string, unknown>
  ) => {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const dir = path.join(process.cwd(), "data", "trade-review-debug");
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(
        dir,
        `${stamp}-${params.accountId}-${params.periodStart}-${label}.json`
      );
      await fs.writeFile(
        file,
        JSON.stringify(
          { ...payload, periodStart: params.periodStart, accountId: params.accountId },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      // Non-fatal — diagnostics shouldn't block the user
    }
  };

  let result: TradeReviewStructured;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let modelUsedSpec = modelSpec;

  const callModel = async (
    key: FeatureKey,
    extraSystem = ""
  ): Promise<{
    object: TradeReviewStructured;
    usage: { inputTokens?: number; outputTokens?: number } | undefined;
  }> => {
    const response = await generateObjectForFeature(key, {
      maxOutputTokens: maxTokens,
      schema: REVIEW_SCHEMA,
      system: extraSystem ? `${system}\n\n${extraSystem}` : system,
      prompt: user,
    }) as unknown as { object: TradeReviewStructured; usage: { inputTokens?: number; outputTokens?: number } | undefined };
    return { object: response.object, usage: response.usage };
  };

  // Attempt 1: primary model with standard prompt
  const firstAttempt = await callModel(featureKey);
  result = firstAttempt.object;
  usage = firstAttempt.usage;

  // Attempt 2: same model with emphatic addendum
  if (isReviewMarkdownEmpty(result.review_markdown)) {
    await debugLog("attempt1-empty", {
      modelSpec,
      maxTokens,
      systemPreview: system.slice(0, 500),
      userPreview: user.slice(0, 1000),
      result: firstAttempt.object,
      usage: firstAttempt.usage,
    });
    options?.onProgress?.(
      "Initial response had an empty review summary — retrying with stronger prompt...",
      4,
      totalSteps
    );
    const retry = await callModel(
      featureKey,
      "RETRY NOTICE: Your previous attempt returned an EMPTY review_markdown. " +
      "This is a hard failure. You MUST produce a complete markdown review " +
      "(at least 1500 characters) covering the monthly overview, per-trade " +
      "analysis, observed patterns, and three concrete recommendations. " +
      "If trade_grades takes too long, write fewer of them — but review_markdown " +
      "MUST be substantive."
    );
    if (!isReviewMarkdownEmpty(retry.object.review_markdown)) {
      result = retry.object;
      usage = retry.usage;
    } else {
      await debugLog("attempt2-empty", {
        modelSpec,
        maxTokens,
        result: retry.object,
        usage: retry.usage,
      });
    }
  }

  // Attempt 3: fall back to the other model. Models exhibit different
  // structured-output behaviors; when one consistently refuses on a specific
  // input, the alternative usually succeeds.
  if (isReviewMarkdownEmpty(result.review_markdown)) {
    const fallbackKey: FeatureKey =
      featureKey === "tradeReviewMain"
        ? "tradeReviewMainLarge"
        : "tradeReviewMain";
    const fallbackSpec = resolveFeatureModel(fallbackKey).modelId;
    options?.onProgress?.(
      `Primary model (${modelSpec}) returned empty markdown twice — falling back to ${fallbackSpec}...`,
      4,
      totalSteps
    );
    try {
      const fallback = await callModel(fallbackKey);
      if (!isReviewMarkdownEmpty(fallback.object.review_markdown)) {
        result = fallback.object;
        usage = fallback.usage;
        modelUsedSpec = fallbackSpec;
      } else {
        await debugLog("attempt3-fallback-empty", {
          modelSpec: fallbackSpec,
          maxTokens,
          result: fallback.object,
          usage: fallback.usage,
        });
      }
    } catch (err) {
      await debugLog("attempt3-fallback-threw", {
        modelSpec: fallbackSpec,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Final guard. If all three attempts failed, surface a clear error.
  if (isReviewMarkdownEmpty(result.review_markdown)) {
    throw new Error(
      `AI returned an empty review summary across 3 attempts (Opus retry + ` +
      `Sonnet fallback). The model is misbehaving on this specific input — ` +
      `${tradeCount} trades, ${maxTokens} token budget. Debug dumps written ` +
      `to data/trade-review-debug/ — share with the dev team. Try (a) splitting ` +
      `the period if many trades, (b) removing trader-note Q&A answers if any, ` +
      `or (c) checking that no trade has unusual characters in symbol/notes.`
    );
  }

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
    model: modelUsedSpec,
    promptTokens: usage?.inputTokens ?? null,
    completionTokens: usage?.outputTokens ?? null,
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
 * How close to a trade's exit date its cached prices must reach, in calendar
 * days. A weekend plus a market holiday is 4.
 */
export const MAX_EXIT_PRICE_GAP_DAYS = 5;

/**
 * Do the cached daily prices for this trade window reach its exit? The count
 * alone (MIN_PRICE_POINTS) is not enough: a history that stalled mid-period
 * has plenty of points and still ends before the move that followed, so its
 * "period high" is only the high of the part that was cached. Reads the same
 * two tables as the price context (`prices` and priced daily `ohlcv_bars`).
 */
export function priceCoverageReachesExit(
  db: Database.Database,
  securityId: number,
  entryDate: string,
  exitDate: string
): boolean {
  const row = db
    .prepare(
      `SELECT MAX(d) AS latest FROM (
         SELECT date AS d FROM prices WHERE security_id = ? AND date >= ? AND date <= ?
         UNION ALL
         SELECT bar_date AS d FROM ohlcv_bars
           WHERE security_id = ? AND bar_date >= ? AND bar_date <= ? AND bar_size = '1 day'
             AND ${PRICED_BAR_SQL}
       )`
    )
    .get(securityId, entryDate, exitDate, securityId, entryDate, exitDate) as {
    latest: string | null;
  };
  if (!row.latest) return false;
  const gapDays =
    (new Date(`${exitDate}T00:00:00Z`).getTime() - new Date(`${row.latest}T00:00:00Z`).getTime()) /
    (24 * 3600 * 1000);
  return gapDays <= MAX_EXIT_PRICE_GAP_DAYS;
}

/**
 * How far back the longest daily-bar request this path makes ("2 Y") is sure
 * to reach, in calendar days. Two calendar years are never shorter than this.
 */
export const MAX_BACKFILL_LOOKBACK_DAYS = 730;

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      (24 * 3600 * 1000)
  );
}

/**
 * Can a request reach this trade window at all? The historical-data call is
 * made with an empty end date-time, so every request ends today
 * (`fetchHistoricalPrices` / `fetchBenchmarkPrices` in lib/tws) and reaches
 * back two years at most. A window that ended before that can never be
 * covered: asking again on every generation is a wasted broker request.
 */
export function isBackfillWindowFetchable(exitDate: string, today: string): boolean {
  return daysBetween(exitDate, today) <= MAX_BACKFILL_LOOKBACK_DAYS;
}

/**
 * The smallest request, ending today, that reaches back to `startDate`. IB
 * takes a day count up to 365; a longer duration must be asked in years, and
 * 2 years is the longest this path asks for.
 */
export function backfillDurationStr(startDate: string, today: string): string {
  const days = Math.max(30, daysBetween(startDate, today) + 10);
  return days > 365 ? "2 Y" : `${days} D`;
}

/**
 * Check price coverage for trade securities and SPY benchmark.
 * If TWS is connected and data is insufficient, fetch from TWS.
 * Silently skips if TWS is not available — review proceeds with whatever data exists.
 *
 * Bound: in one call a security is asked for at most once, and a security
 * whose trade window no request can reach (`isBackfillWindowFetchable`) is
 * never asked for — on this run or any later one. Such a trade is graded
 * without a price range.
 */
export async function backfillPriceData(
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

  const today = todayET();

  // Determine the overall date range across all trades
  let overallStart = "9999-12-31";
  let overallEnd = "0000-01-01";

  // Securities that need price data, each with the earliest entry among its
  // trades that need it (the request reaches back to that date).
  const fetchStartBySecurity = new Map<number, string>();
  const unfetchableSymbols = new Set<string>();
  const seen = new Set<number>();

  // Decide fetchability first: an unreachable window is never enqueued.
  const enqueue = (trade: GroupedTrade): void => {
    if (!isBackfillWindowFetchable(trade.exitDate, today)) {
      unfetchableSymbols.add(trade.symbol);
      return;
    }
    const start = fetchStartBySecurity.get(trade.securityId);
    if (!start || trade.earliestEntryDate < start) {
      fetchStartBySecurity.set(trade.securityId, trade.earliestEntryDate);
    }
  };

  for (const trade of groupedTrades) {
    if (trade.earliestEntryDate < overallStart) overallStart = trade.earliestEntryDate;
    if (trade.exitDate > overallEnd) overallEnd = trade.exitDate;

    if (seen.has(trade.securityId)) continue;
    seen.add(trade.securityId);

    // Check existing coverage for this security
    // countCachedPricePoints counts PRICED bars only — a legacy zero bar is
    // not coverage (see its doc in market-context.ts).
    const priceCount = countCachedPricePoints(
      db,
      trade.securityId,
      trade.earliestEntryDate,
      trade.exitDate
    );

    if (priceCount < MIN_PRICE_POINTS) {
      enqueue(trade);
    }
  }
  // Enough points is not enough: a security is also fetched when any of its
  // trades has a history that stops short of the exit.
  for (const trade of groupedTrades) {
    if (!priceCoverageReachesExit(db, trade.securityId, trade.earliestEntryDate, trade.exitDate)) {
      enqueue(trade);
    }
  }
  const securitiesToFetch = [...fetchStartBySecurity.keys()];

  if (unfetchableSymbols.size > 0) {
    onProgress?.(
      `Price history for ${[...unfetchableSymbols].join(", ")} is older than TWS can supply — graded without a price range`
    );
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
        const spyPriceCount = countCachedPricePoints(
          db,
          spySec.id,
          overallStart,
          overallEnd
        );

        if (spyPriceCount < MIN_PRICE_POINTS) {
          needBenchmark = true;
        }
      } else {
        needBenchmark = true;
      }
    }
  }
  // Same rule as the securities: a period no request can reach is not asked for.
  if (needBenchmark && !isBackfillWindowFetchable(overallEnd, today)) {
    needBenchmark = false;
  }

  if (securitiesToFetch.length === 0 && !needBenchmark) {
    onProgress?.("Price data sufficient — skipping TWS fetch");
    return;
  }

  // Compute duration string from date range (cap at 2Y — IB's max for daily bars).
  // The fetch ends today, so the window is measured back from today to the
  // earliest entry — the length of the trade period alone would stop short of
  // an older period's start. This one is the SPY benchmark's window (the whole
  // period); each security gets its own, below.
  // backfillDurationStr asks in years once the padded day count passes 365
  // (IB refuses a longer duration in days).
  const durationStr = backfillDurationStr(overallStart, todayET());

  // Fetch security prices
  if (securitiesToFetch.length > 0) {
    const symbols = securitiesToFetch
      .map((id) => {
        const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(id) as { symbol: string } | undefined;
        return row?.symbol ?? `#${id}`;
      })
      .join(", ");
    onProgress?.(`Fetching price history for ${symbols} from TWS...`);

    // One request per security, each no longer than its own window needs.
    // Securities that share a duration go in one call.
    const idsByDuration = new Map<string, number[]>();
    for (const [securityId, start] of fetchStartBySecurity) {
      const duration = backfillDurationStr(start, today);
      idsByDuration.set(duration, [...(idsByDuration.get(duration) ?? []), securityId]);
    }
    for (const [duration, securityIds] of idsByDuration) {
      try {
        await fetchHistoricalPrices(db, {
          securityIds,
          durationStr: duration,
        });
      } catch {
        // Non-critical — continue with whatever data exists
      }
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
