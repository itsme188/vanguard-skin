import type Database from "better-sqlite3";
import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
import { setAlertSuggestion } from "@/lib/mutations/security-levels";
import { resolveLevelPrice } from "@/lib/alerts/resolve-level-price";
import type { LevelPriceSource } from "@/lib/types";

interface LevelRow {
  level_type: string;
  price: number;
  price_source: LevelPriceSource;
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
  threshold_price: number | null;
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
  /**
   * The threshold the alert fired AGAINST — the recorded `threshold_price`,
   * else the level's live resolved price. NOT `security_levels.price` for an
   * MA level: the sentence Claude writes outlives the card, so quoting the
   * creation snapshot there is the part of the 2026-09-14 finding that
   * actually misleads.
   */
  levelPrice: number;
  /** `static`, or the MA the level tracks — lets the prompt name the average
   *  instead of presenting a moving threshold as a fixed number. Optional so
   *  existing callers/tests that don't set it keep working. */
  levelPriceSource?: LevelPriceSource | null;
  /** Provenance of levelPrice; a fallback must never be described as historical. */
  levelPriceBasis?: "recorded" | "current" | "creation";
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

  // An MA level's threshold MOVES. Naming the average tells the model the
  // figure is a moving line it crossed, not a number the user typed — and
  // stops the sentence from being read back later as a fixed level.
  const maMatch = ctx.levelPriceSource
    ? /^(sma|ema)_(\d+)$/.exec(ctx.levelPriceSource)
    : null;
  const levelSourceNote = maMatch
    ? ctx.levelPriceBasis === "recorded"
      ? ` (the ${maMatch[2]}-day ${maMatch[1].toUpperCase()} at the time of the cross)`
      : ctx.levelPriceBasis === "current"
        ? ` (current ${maMatch[2]}-day ${maMatch[1].toUpperCase()}; fire-time threshold not recorded)`
        : ` (creation snapshot for ${maMatch[2]}-day ${maMatch[1].toUpperCase()}; fire-time threshold not recorded)`
    : "";

  return [
    `A price level you set was just crossed. Write a ONE-SENTENCE recommendation for what to consider doing (or why to wait). Be analytical like a colleague, not a coach. No hype language. No preamble. Just the recommendation.`,
    ``,
    `Security: ${ctx.symbol}${ctx.securityName ? ` (${ctx.securityName})` : ""}`,
    `Level: ${ctx.levelType.replace(/_/g, " ")} at $${ctx.levelPrice.toFixed(2)}${levelSourceNote}`,
    `Price when the alert fired: $${ctx.triggeredPrice.toFixed(2)}`,
    ctx.levelPriceBasis !== "recorded" && maMatch
      ? "Do not claim the fallback threshold was the value crossed when this alert fired."
      : "",
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
 * Normalize a stored position_context JSON string into the shape the prompt
 * builder needs. Alerts fired on the Mac store {held, onWatchlist,
 * watchlistGroup}, but cloud-reconciled alerts (reconcileCloudFiredLevels)
 * store the Worker's scan payload verbatim — a different schema. Pre-fix the
 * parse replaced the defaults wholesale, ctx.held came out undefined, and
 * every cloud-fired alert permanently failed suggestion generation with
 * "Cannot read properties of undefined (reading 'length')".
 */
export function normalizePositionContext(
  raw: string | null
): Pick<SuggestionContext, "held" | "onWatchlist" | "watchlistGroup"> {
  const defaults = { held: [], onWatchlist: false, watchlistGroup: null };
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    return {
      held: Array.isArray(parsed?.held) ? parsed.held : [],
      onWatchlist: parsed?.onWatchlist === true,
      watchlistGroup:
        typeof parsed?.watchlistGroup === "string" ? parsed.watchlistGroup : null,
    };
  } catch {
    return defaults;
  }
}

/**
 * Assemble everything the prompt needs for one alert, or null when the alert
 * (or its level/security) is gone. Split out of generateSuggestionForAlert so
 * the composition — especially WHICH price becomes `levelPrice` — is testable
 * against a real database without going anywhere near the model.
 *
 * The threshold is chosen in the same order the alerts inbox renders it:
 *
 *   1. `threshold_price` — the value recorded at the cross (migration 093).
 *   2. the level's live resolved price — for an alert fired before 093, the
 *      current MA is closer to the truth than the creation snapshot, and it is
 *      the same figure the card shows next to the sentence.
 *   3. `security_levels.price` — the last resort: correct for a static level,
 *      and all that exists for an MA with too little history.
 *
 * Step 2 is why this reaches for resolveLevelPrice rather than just reading
 * the row: a sentence generated today about a moving-average level must not
 * quote a number that has not been the threshold for weeks.
 */
export function buildSuggestionContext(
  db: Database.Database,
  alertId: number
): SuggestionContext | null {
  const row = db
    .prepare(
      `SELECT
         a.id, a.security_id, a.triggered_price, a.threshold_price, a.triggered_at,
         a.position_context, a.suggested_action,
         sl.security_id AS level_security_id,
         sl.level_type, sl.price AS level_price, sl.price_source, sl.direction,
         sl.source, sl.source_author, sl.thesis, sl.timeframe, sl.action_hint,
         s.symbol, s.name AS security_name, s.security_type
       FROM level_alerts a
       JOIN security_levels sl ON sl.id = a.level_id
       JOIN securities s ON s.id = a.security_id
       WHERE a.id = ?`
    )
    .get(alertId) as
    | (AlertRow &
        LevelRow &
        SecurityRow & { level_price: number; level_security_id: number })
    | undefined;

  if (!row) return null;

  const positionContext = normalizePositionContext(row.position_context);

  const livePrice = resolveLevelPrice(db, {
      security_id: row.level_security_id,
      price: row.level_price,
      price_source: row.price_source,
    });
  const thresholdPrice = row.threshold_price ?? livePrice ?? row.level_price;

  return {
    symbol: row.symbol,
    securityName: row.security_name,
    securityType: row.security_type,
    levelType: row.level_type,
    levelPrice: thresholdPrice,
    levelPriceSource: row.price_source,
    levelPriceBasis: row.threshold_price != null ? "recorded" : livePrice != null ? "current" : "creation",
    triggeredPrice: row.triggered_price,
    direction: row.direction,
    sourceAuthor: row.source_author,
    thesis: row.thesis,
    timeframe: row.timeframe,
    actionHint: row.action_hint,
    ...positionContext,
  };
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
  const ctx = buildSuggestionContext(db, alertId);
  if (!ctx) return null;

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
