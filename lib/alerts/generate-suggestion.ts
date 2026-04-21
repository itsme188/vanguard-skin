import type Database from "better-sqlite3";
import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
import { setAlertSuggestion } from "@/lib/mutations/security-levels";

interface LevelRow {
  level_type: string;
  price: number;
  direction: string | null;
  source: string;
  source_author: string | null;
  thesis: string | null;
  timeframe: string | null;
  action_hint: string | null;
}

interface AlertRow {
  id: number;
  security_id: number;
  triggered_price: number;
  triggered_at: string;
  position_context: string | null;
  suggested_action: string | null;
}

interface SecurityRow {
  symbol: string;
  security_name: string | null;  // SELECT aliases s.name AS security_name
  security_type: string | null;
}

export interface SuggestionContext {
  symbol: string;
  securityName: string | null;
  securityType: string | null;
  levelType: string;
  levelPrice: number;
  triggeredPrice: number;
  direction: string | null;
  sourceAuthor: string | null;
  thesis: string | null;
  timeframe: string | null;
  actionHint: string | null;
  held: Array<{ account: string; quantity: number }>;
  onWatchlist: boolean;
  watchlistGroup: string | null;
}

/**
 * Pure prompt builder — no SDK dependency so it's unit-testable.
 * Returns the user message passed to Claude.
 */
export function buildSuggestionPrompt(ctx: SuggestionContext): string {
  const positionLines: string[] = [];
  if (ctx.held.length > 0) {
    positionLines.push(
      `Current holdings: ${ctx.held
        .map((h) => `${h.quantity.toFixed(0)} shares in ${h.account}`)
        .join(", ")}`
    );
  } else {
    positionLines.push("Not currently held.");
  }
  if (ctx.onWatchlist) {
    const group = ctx.watchlistGroup && ctx.watchlistGroup !== "default"
      ? ` (${ctx.watchlistGroup.replace(/_/g, " ")} group)`
      : "";
    positionLines.push(`On watchlist${group}.`);
  }

  const sourceLine = ctx.sourceAuthor
    ? `Level source: ${ctx.sourceAuthor}${ctx.thesis ? ` — "${ctx.thesis}"` : ""}`
    : ctx.thesis
      ? `Thesis: "${ctx.thesis}"`
      : "No source or thesis noted.";

  const directionLine = ctx.direction
    ? `Direction: ${ctx.direction}`
    : "";

  const timeframeLine = ctx.timeframe
    ? `Timeframe: ${ctx.timeframe}`
    : "";

  const actionHintLine = ctx.actionHint
    ? `Originally flagged as: ${ctx.actionHint.replace(/_/g, " ")}`
    : "";

  return [
    `A price level you set was just crossed. Write a ONE-SENTENCE recommendation for what to consider doing (or why to wait). Be analytical like a colleague, not a coach. No hype language. No preamble. Just the recommendation.`,
    ``,
    `Security: ${ctx.symbol}${ctx.securityName ? ` (${ctx.securityName})` : ""}`,
    `Level: ${ctx.levelType.replace(/_/g, " ")} at $${ctx.levelPrice.toFixed(2)}`,
    `Current price: $${ctx.triggeredPrice.toFixed(2)}`,
    directionLine,
    timeframeLine,
    actionHintLine,
    ``,
    sourceLine,
    ``,
    ...positionLines,
    ``,
    `Guidance on tone:`,
    `- If the user already holds it and the level is a target/exit, suggest trimming proportionally.`,
    `- If the user doesn't hold it but it's on the watchlist, remember the watchlist is a deliberate holding pen — patience is usually right unless the setup is clean.`,
    `- If it's an entry level and nothing says "buy now," the right answer is often "add a starter or wait for confirmation."`,
    `- Reference the source author by name if relevant.`,
    `- Output EXACTLY one sentence. No bullet points, no headers, no disclaimers.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Generate a suggestion for a single alert and persist it.
 * Returns the generated suggestion text, or null on any failure (Claude error, missing data).
 * Non-throwing — callers can run this against many alerts and ignore individual failures.
 */
export async function generateSuggestionForAlert(
  db: Database.Database,
  alertId: number
): Promise<string | null> {
  const row = db
    .prepare(
      `SELECT
         a.id, a.security_id, a.triggered_price, a.triggered_at,
         a.position_context, a.suggested_action,
         sl.level_type, sl.price AS level_price, sl.direction,
         sl.source, sl.source_author, sl.thesis, sl.timeframe, sl.action_hint,
         s.symbol, s.name AS security_name, s.security_type
       FROM level_alerts a
       JOIN security_levels sl ON sl.id = a.level_id
       JOIN securities s ON s.id = a.security_id
       WHERE a.id = ?`
    )
    .get(alertId) as
    | (AlertRow & LevelRow & SecurityRow & { level_price: number })
    | undefined;

  if (!row) return null;

  let positionContext: Pick<
    SuggestionContext,
    "held" | "onWatchlist" | "watchlistGroup"
  > = { held: [], onWatchlist: false, watchlistGroup: null };
  if (row.position_context) {
    try {
      positionContext = JSON.parse(row.position_context);
    } catch {
      // malformed — use empty defaults
    }
  }

  const ctx: SuggestionContext = {
    symbol: row.symbol,
    securityName: row.security_name,
    securityType: row.security_type,
    levelType: row.level_type,
    levelPrice: row.level_price,
    triggeredPrice: row.triggered_price,
    direction: row.direction,
    sourceAuthor: row.source_author,
    thesis: row.thesis,
    timeframe: row.timeframe,
    actionHint: row.action_hint,
    ...positionContext,
  };

  try {
    const { text } = await generateText({
      model: getModelForFeature("alertSuggestion"),
      maxOutputTokens: 256,
      prompt: buildSuggestionPrompt(ctx),
    });

    const suggestion = text.trim();
    if (!suggestion) return null;

    setAlertSuggestion(db, alertId, suggestion);
    return suggestion;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[alerts/suggest] Failed for alert ${alertId}: ${msg}`);
    return null;
  }
}

/**
 * Fill in suggestions for every pending alert that doesn't have one yet.
 * Runs in parallel with a modest cap so a handful of alerts complete in ~5s.
 * Returns { generated, failed } counts.
 */
export async function generateSuggestionsForPendingAlerts(
  db: Database.Database,
  opts: { limit?: number } = {}
): Promise<{ generated: number; failed: number }> {
  const limit = opts.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT id FROM level_alerts
       WHERE user_response = 'pending' AND suggested_action IS NULL
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as { id: number }[];

  if (rows.length === 0) return { generated: 0, failed: 0 };

  const results = await Promise.all(
    rows.map((r) => generateSuggestionForAlert(db, r.id))
  );
  return {
    generated: results.filter((r) => r !== null).length,
    failed: results.filter((r) => r === null).length,
  };
}
