import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { SONNET_MODEL } from "@/lib/claude-models";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { listPressReleases } from "@/lib/queries/press-releases";
import {
  getRecommendationHistory,
  getPriceTarget,
  getRatingChanges,
} from "@/lib/queries/analyst-estimates";
import { getCachedTranscript } from "@/lib/queries/transcripts";
import type { CalendarEvent, EarningsTranscript } from "@/lib/types";

// Preferred newsletter sources for pre-earnings color. Same list as
// lib/calendar/briefing.ts deep-read with TMT Breakout (id=8) added —
// TMT Breakout's Morning Wrap routinely carries sell-side bogies on
// names it covers (AAPL, AMD, META, TSM, semis broadly).
const PREFERRED_SOURCE_IDS = [
  1,  // Vital Knowledge
  8,  // TMT Breakout
  18, // Eliant Capital
  19, // Purple Drink's Market Musings
  28, // Helene Meisler
];

const ARTICLE_BODY_CAP = 8_000;
const TOTAL_CONTEXT_CAP = 80_000;

export class EarningsEmailError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "EarningsEmailError";
  }
}

export interface SendEarningsEmailOpts {
  recipient?: string;
  footerNote?: string;
}

export interface SendEarningsEmailResult {
  success: true;
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  sentTo: string;
  title: string;
  modelOutputChars: number;
}

// ── Public entry points ────────────────────────────────────────────

export async function sendEarningsPreview(
  db: Database.Database,
  eventId: number,
  opts: SendEarningsEmailOpts = {},
): Promise<SendEarningsEmailResult> {
  return sendEarningsEmail(db, eventId, "preview", opts);
}

export async function sendEarningsRecap(
  db: Database.Database,
  eventId: number,
  opts: SendEarningsEmailOpts = {},
): Promise<SendEarningsEmailResult> {
  return sendEarningsEmail(db, eventId, "recap", opts);
}

async function sendEarningsEmail(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  opts: SendEarningsEmailOpts,
): Promise<SendEarningsEmailResult> {
  const recipient = opts.recipient || process.env.BRIEFING_EMAIL_TO;
  if (!recipient) {
    throw new EarningsEmailError(
      "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      400,
    );
  }
  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailAddress || !gmailAppPassword) {
    throw new EarningsEmailError(
      "Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD env vars.",
      500,
    );
  }

  const event = getEventByIdRow(db, eventId);
  if (!event) {
    throw new EarningsEmailError(`Event ${eventId} not found.`, 404);
  }
  if (event.event_type !== "earnings") {
    throw new EarningsEmailError(
      `Event ${eventId} is not an earnings event (event_type=${event.event_type}).`,
      400,
    );
  }
  if (!event.symbol) {
    throw new EarningsEmailError(
      `Event ${eventId} has no symbol.`,
      400,
    );
  }

  const symbol = event.symbol.toUpperCase();
  const prompt = phase === "preview"
    ? renderPreviewPrompt(buildPreviewContext(db, event))
    : renderRecapPrompt(buildRecapContext(db, event));

  const markdown = await callClaude(prompt, phase);

  const dateStr = formatDateLong(event.event_date);
  const releaseTimeStr = event.release_time
    ? ` ${event.release_time} ET`
    : "";
  const phaseEmoji = phase === "preview" ? "\u{1F50D}" : "\u{1F4CA}";
  const phaseLabel = phase === "preview" ? "Earnings Preview" : "Earnings Recap";
  const title = `${symbol} ${phaseLabel} — ${dateStr}${releaseTimeStr}`;
  const html = briefingToHtml(markdown, title, opts.footerNote);

  await sendEmail(
    { gmailAddress, gmailAppPassword },
    recipient,
    `${phaseEmoji} ${title}`,
    html,
  );

  return {
    success: true,
    eventId,
    symbol,
    phase,
    sentTo: recipient,
    title,
    modelOutputChars: markdown.length,
  };
}

// ── Calendar event helper ──────────────────────────────────────────

function getEventByIdRow(
  db: Database.Database,
  id: number,
): CalendarEvent | null {
  return (
    (db
      .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
      .get(id) as CalendarEvent | undefined) ?? null
  );
}

// ── Context builders ───────────────────────────────────────────────

interface PositionEntry {
  account_name: string;
  symbol: string;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
  latest_price: number | null;
  // Option-specific (null for stock/ETF/MF)
  security_type: string;
  underlying_symbol: string | null;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  multiplier: number | null;
}

interface NewsletterEntry {
  source_name: string;
  subject: string;
  received_at: string;
  body: string;
  sentiment: string | null;
  sentiment_score: number | null;
  source_id: number;
}

interface PreviewContext {
  symbol: string;
  family: readonly string[];
  event: CalendarEvent;
  positions: PositionEntry[];
  combinedShares: number;
  combinedContracts: number;
  recentArticles: NewsletterEntry[];
  recommendationTrend: string | null;
  priceTarget: string | null;
  ratingChanges: string | null;
  recentPressReleases: string | null;
  priorTranscript: EarningsTranscript | null;
}

interface RecapContext extends PreviewContext {
  reactionSnapshotMarkdown: string | null;
  freshPressReleases: string | null;
}

function buildPreviewContext(
  db: Database.Database,
  event: CalendarEvent,
): PreviewContext {
  const symbol = event.symbol!.toUpperCase();
  const family = issuerSiblings(symbol);

  const positions = getCrossAccountPositions(db, family);
  let combinedShares = 0;
  let combinedContracts = 0;
  for (const p of positions) {
    if (p.security_type.toLowerCase() === "option") {
      combinedContracts += p.quantity;
    } else {
      combinedShares += p.quantity;
    }
  }

  const recentArticles = getNewsletterContext(db, family);
  const recommendationTrend = formatRecommendationTrend(db, symbol);
  const priceTarget = formatPriceTarget(db, symbol);
  const ratingChanges = formatRatingChanges(db, symbol);
  const recentPressReleases = formatPressReleases(db, family, 30, 8);
  const priorTranscript = findPriorTranscript(db, symbol, event.event_date);

  return {
    symbol,
    family,
    event,
    positions,
    combinedShares,
    combinedContracts,
    recentArticles,
    recommendationTrend,
    priceTarget,
    ratingChanges,
    recentPressReleases,
    priorTranscript,
  };
}

function buildRecapContext(
  db: Database.Database,
  event: CalendarEvent,
): RecapContext {
  const base = buildPreviewContext(db, event);

  const reactionSnapshotMarkdown = formatReactionSnapshot(event.reaction_snapshot);
  // For the recap we want every PR since the release time, not just last 30d.
  // 2 days back from now is plenty for both BMO + AMC.
  const freshPressReleases = formatPressReleases(db, base.family, 2, 12);

  return {
    ...base,
    reactionSnapshotMarkdown,
    freshPressReleases,
  };
}

// ── Cross-account positions ────────────────────────────────────────

function getCrossAccountPositions(
  db: Database.Database,
  family: readonly string[],
): PositionEntry[] {
  if (family.length === 0) return [];
  const upperFamily = family.map((s) => s.toUpperCase());
  const placeholders = upperFamily.map(() => "?").join(",");
  // Match BOTH the security's own symbol AND its underlying_symbol — the
  // latter catches option holdings whose s.symbol is OCC format
  // (e.g., "TER   280121C00180000") but underlying_symbol is "TER".
  // Without this branch, every option leg on an event symbol gets dropped.
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name AS account_name, s.symbol,
              s.security_type, s.underlying_symbol, s.option_type,
              s.strike_price, s.expiration_date, s.multiplier,
              h.quantity, h.cost_basis, h.as_of_date,
              (SELECT close_price FROM prices p
                 WHERE p.security_id = s.id
                 ORDER BY p.date DESC LIMIT 1) AS latest_price
         FROM holdings h
         JOIN accounts a ON a.id = h.account_id
         JOIN securities s ON s.id = h.security_id
         WHERE (UPPER(s.symbol) IN (${placeholders})
                OR UPPER(COALESCE(s.underlying_symbol, '')) IN (${placeholders}))
           AND h.quantity > 0
           AND h.as_of_date = (
             SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id
               AND h2.security_id = h.security_id
           )
         ORDER BY a.id, LOWER(s.security_type), s.expiration_date NULLS LAST, s.symbol`,
    )
    .all(...upperFamily, ...upperFamily) as PositionEntry[];
  return rows;
}

// ── Newsletter context ─────────────────────────────────────────────

function getNewsletterContext(
  db: Database.Database,
  family: readonly string[],
): NewsletterEntry[] {
  if (family.length === 0) return [];
  const placeholders = family.map(() => "?").join(",");
  const sourcePlaceholders = PREFERRED_SOURCE_IDS.map(() => "?").join(",");

  // Tier 1: preferred sources, last 7 days
  const tier1 = db
    .prepare(
      `SELECT a.id, a.source_id, rs.name AS source_name, a.subject,
              a.received_at, a.raw_text, a.summary, a.sentiment, a.sentiment_score
         FROM research_articles a
         JOIN research_article_securities ras ON ras.article_id = a.id
         JOIN securities s ON s.id = ras.security_id
         JOIN research_sources rs ON rs.id = a.source_id
         WHERE UPPER(s.symbol) IN (${placeholders})
           AND a.source_id IN (${sourcePlaceholders})
           AND datetime(a.received_at) >= datetime('now', '-7 days')
           AND a.processed_at IS NOT NULL
         GROUP BY a.id
         ORDER BY a.received_at DESC
         LIMIT 6`,
    )
    .all(
      ...family.map((s) => s.toUpperCase()),
      ...PREFERRED_SOURCE_IDS,
    ) as NewsletterRow[];

  // Tier 2 fallback: any source, last 30 days
  let tier2: NewsletterRow[] = [];
  if (tier1.length === 0) {
    tier2 = db
      .prepare(
        `SELECT a.id, a.source_id, rs.name AS source_name, a.subject,
                a.received_at, a.raw_text, a.summary, a.sentiment, a.sentiment_score
           FROM research_articles a
           JOIN research_article_securities ras ON ras.article_id = a.id
           JOIN securities s ON s.id = ras.security_id
           JOIN research_sources rs ON rs.id = a.source_id
           WHERE UPPER(s.symbol) IN (${placeholders})
             AND datetime(a.received_at) >= datetime('now', '-30 days')
             AND a.processed_at IS NOT NULL
           GROUP BY a.id
           ORDER BY a.received_at DESC
           LIMIT 6`,
      )
      .all(...family.map((s) => s.toUpperCase())) as NewsletterRow[];
  }

  const rows = tier1.length > 0 ? tier1 : tier2;
  let totalChars = 0;
  const result: NewsletterEntry[] = [];
  for (const r of rows) {
    const fullText = r.raw_text || r.summary || "";
    const body = fullText.length > ARTICLE_BODY_CAP
      ? fullText.slice(0, ARTICLE_BODY_CAP) + "\n[...truncated...]"
      : fullText;
    if (totalChars + body.length > TOTAL_CONTEXT_CAP) break;
    totalChars += body.length;
    result.push({
      source_name: r.source_name,
      subject: r.subject,
      received_at: r.received_at,
      body,
      sentiment: r.sentiment,
      sentiment_score: r.sentiment_score,
      source_id: r.source_id,
    });
  }
  return result;
}

interface NewsletterRow {
  id: number;
  source_id: number;
  source_name: string;
  subject: string;
  received_at: string;
  raw_text: string | null;
  summary: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
}

// ── Analyst formatters ─────────────────────────────────────────────

function formatRecommendationTrend(
  db: Database.Database,
  symbol: string,
): string | null {
  const history = getRecommendationHistory(db, symbol, 6);
  if (history.length === 0) return null;
  const lines = history.map((r) => {
    const total = r.strong_buy + r.buy + r.hold + r.sell + r.strong_sell;
    return `- ${r.period}: ${r.strong_buy} SB / ${r.buy} B / ${r.hold} H / ${r.sell} S / ${r.strong_sell} SS (n=${total})`;
  });
  return lines.join("\n");
}

function formatPriceTarget(
  db: Database.Database,
  symbol: string,
): string | null {
  const target = getPriceTarget(db, symbol);
  if (!target) return null;
  if (
    target.target_mean == null &&
    target.target_high == null &&
    target.target_low == null
  ) {
    return null;
  }
  const parts: string[] = [];
  if (target.target_mean != null) parts.push(`mean $${target.target_mean.toFixed(2)}`);
  if (target.target_median != null) parts.push(`median $${target.target_median.toFixed(2)}`);
  if (target.target_high != null) parts.push(`high $${target.target_high.toFixed(2)}`);
  if (target.target_low != null) parts.push(`low $${target.target_low.toFixed(2)}`);
  if (target.number_of_analysts != null) parts.push(`n=${target.number_of_analysts}`);
  return parts.join(" · ");
}

function formatRatingChanges(
  db: Database.Database,
  symbol: string,
): string | null {
  const changes = getRatingChanges(db, symbol, 8);
  if (changes.length === 0) return null;
  const lines = changes.map((c) => {
    const firm = c.firm || "unnamed firm";
    const fromTo = c.from_grade ? `${c.from_grade} → ${c.to_grade}` : c.to_grade;
    const action = c.action ? ` [${c.action}]` : "";
    return `- ${c.rating_date.slice(0, 10)}: ${firm}: ${fromTo}${action}`;
  });
  return lines.join("\n");
}

// ── Press release formatter ────────────────────────────────────────

function formatPressReleases(
  db: Database.Database,
  family: readonly string[],
  daysBack: number,
  limit: number,
): string | null {
  const out: string[] = [];
  for (const sym of family) {
    const prs = listPressReleases(db, {
      symbol: sym,
      days_back: daysBack,
      limit,
    });
    for (const pr of prs) {
      const summary = pr.summary && pr.summary.length > 800
        ? pr.summary.slice(0, 800) + "…"
        : pr.summary || "";
      out.push(
        `- [${pr.published_at.slice(0, 16).replace("T", " ")}] (${pr.source || "?"}) ${pr.headline}${summary ? `\n  ${summary}` : ""}`,
      );
    }
  }
  if (out.length === 0) return null;
  return out.slice(0, limit).join("\n");
}

// ── Prior-quarter transcript ───────────────────────────────────────

function findPriorTranscript(
  db: Database.Database,
  symbol: string,
  eventDate: string,
): EarningsTranscript | null {
  // Try the obvious prior quarter first, then walk back two.
  const date = new Date(eventDate + "T00:00:00Z");
  const month = date.getUTCMonth() + 1; // 1..12
  const year = date.getUTCFullYear();
  // Map current event-month to prior-quarter (year, quarter).
  let priorQ: number;
  let priorY: number;
  if (month <= 3) {
    priorQ = 4;
    priorY = year - 1;
  } else if (month <= 6) {
    priorQ = 1;
    priorY = year;
  } else if (month <= 9) {
    priorQ = 2;
    priorY = year;
  } else {
    priorQ = 3;
    priorY = year;
  }
  return (
    getCachedTranscript(db, symbol, priorY, priorQ) ||
    getCachedTranscript(db, symbol, priorY - (priorQ === 1 ? 1 : 0), ((priorQ + 2) % 4) + 1)
  );
}

// ── Reaction snapshot formatter ────────────────────────────────────

function formatReactionSnapshot(json: string | null): string | null {
  if (!json) return null;
  try {
    const snap = JSON.parse(json) as {
      t0_utc?: string;
      window_min?: number;
      source?: string;
      spy?: { delta_pct?: number };
      qqq?: { delta_pct?: number };
      tlt?: { delta_pct?: number };
      sector?: { symbol?: string; delta_pct?: number };
      symbol?: { symbol?: string; delta_pct?: number };
    };
    const lines: string[] = [];
    const win = snap.window_min ?? 120;
    lines.push(`- Window: T+${win} minutes from release (source: ${snap.source ?? "?"})`);
    if (snap.symbol && snap.symbol.delta_pct != null) {
      lines.push(`- ${snap.symbol.symbol ?? "stock"}: ${pctSign(snap.symbol.delta_pct)}`);
    }
    if (snap.spy?.delta_pct != null) lines.push(`- SPY: ${pctSign(snap.spy.delta_pct)}`);
    if (snap.qqq?.delta_pct != null) lines.push(`- QQQ: ${pctSign(snap.qqq.delta_pct)}`);
    if (snap.tlt?.delta_pct != null) lines.push(`- TLT: ${pctSign(snap.tlt.delta_pct)}`);
    if (snap.sector && snap.sector.delta_pct != null) {
      lines.push(`- ${snap.sector.symbol ?? "sector ETF"}: ${pctSign(snap.sector.delta_pct)}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function pctSign(v: number): string {
  const n = (v * 100).toFixed(2);
  return v >= 0 ? `+${n}%` : `${n}%`;
}

// ── Prompt rendering (pure for testability) ────────────────────────

export function renderPreviewPrompt(ctx: PreviewContext): string {
  const consensusBlock = ctx.event.consensus_estimate
    ? `\n## Street Consensus (from Finnhub at sync time)\n${ctx.event.consensus_estimate}\n`
    : `\n## Street Consensus\nNot in our database. Use web_search to find consensus EPS, revenue, and any other key metrics analysts are watching for this print. Cite source URLs.\n`;

  const positionsBlock = renderPositionsBlock(ctx);
  const newslettersBlock = renderNewslettersBlock(ctx, "preview");
  const analystBlock = renderAnalystBlock(ctx);
  const pressBlock = ctx.recentPressReleases
    ? `\n## Recent Press Releases (last 30 days)\n${ctx.recentPressReleases}\n`
    : "";
  const priorCallBlock = renderPriorTranscriptBlock(ctx);

  return `You are a financial analyst writing a focused pre-earnings briefing for a single portfolio manager who holds ${ctx.symbol}. The release is in approximately 2 hours. Goal: prepare him as if he were sitting next to a sell-side analyst he trusts — concise, candid, no cheerleading.

## Event
- Symbol: **${ctx.symbol}**
- Family (siblings rolled up): ${ctx.family.join(", ")}
- Date: ${ctx.event.event_date}
- Release time: ${ctx.event.release_time ?? "(not specified — assume BMO or AMC based on context)"}
- Source: ${ctx.event.source}
- Expected impact: ${ctx.event.expected_impact ?? "n/a"}
${consensusBlock}
${positionsBlock}
${newslettersBlock}
${analystBlock}
${pressBlock}
${priorCallBlock}

## Your task

Use the structured context above as the source of truth for positions, consensus, and newsletter quotes. **For anything missing or thin, use web_search** — bogies for the print, sell-side notes published in the last 24-48 hours, recent buy-side commentary, expectations on segment-level metrics, prior-quarter takeaways. Cite source URLs inline as [Source Name](url).

Write the briefing as markdown, structured as follows:

1. **The Setup** — 2-3 sentences. Where does ${ctx.symbol} go into the print? Stock action over the past 30 days. Posture into the call.

2. **Bogies** — what the Street is looking for line by line. Consensus EPS, revenue, segment splits, margin, key KPIs specific to ${ctx.symbol}'s business. Where the buy-side sits vs. sell-side (whisper / bogie). If you only have official consensus, say so.

3. **Bull case / bear case** — concise. What sets up a beat-and-raise; what triggers a sell-off. Reference newsletter views by author when applicable.

4. **What to watch on the call** — guidance change, segment commentary, capex, any specific issue current sell-side notes are pushing for.

5. **Position implications** — given the user's combined position (use the §Positions block verbatim), what's the asymmetry? Hedged or naked? If there are option positions in the data, mention assignment / IV-crush risk explicitly.

6. **Sources** — a footer listing the newsletter article subjects + dates we cited, plus any web URLs.

Tone: analytical colleague, not coach. No "you should" prescriptions; offer scenarios and let the reader decide. Aim for 600-1100 words — dense, no filler.`;
}

export function renderRecapPrompt(ctx: RecapContext): string {
  const consensusBlock = ctx.event.consensus_value || ctx.event.consensus_estimate
    ? `\n## Consensus going in\n${ctx.event.consensus_value ?? ctx.event.consensus_estimate}\n`
    : "";

  const actualBlock = ctx.event.actual_value
    ? `\n## Reported actual (from enrichment runner)\n${ctx.event.actual_value}\n`
    : `\n## Reported actual\nEnrichment hasn't captured the actual yet. Use web_search to find the press-release values: EPS, revenue, segment splits, full-year guidance change. Cite source URLs.\n`;

  const reactionBlock = ctx.reactionSnapshotMarkdown
    ? `\n## Market reaction (T+2h, captured automatically)\n${ctx.reactionSnapshotMarkdown}\n`
    : `\n## Market reaction\nReaction snapshot not yet captured. If you can determine after-hours / immediate reaction from web_search, cite it; otherwise note the gap.\n`;

  const positionsBlock = renderPositionsBlock(ctx);
  const newslettersBlock = renderNewslettersBlock(ctx, "recap");
  const analystBlock = renderAnalystBlock(ctx);
  const pressBlock = ctx.freshPressReleases
    ? `\n## Press releases since release\n${ctx.freshPressReleases}\n`
    : "";
  const priorCallBlock = renderPriorTranscriptBlock(ctx);

  return `You are a financial analyst writing a focused post-earnings recap for a single portfolio manager who holds ${ctx.symbol}. The release was approximately 2 hours ago. Goal: brief him as a colleague who just digested the print and the immediate market reaction.

## Event
- Symbol: **${ctx.symbol}**
- Family (siblings rolled up): ${ctx.family.join(", ")}
- Date: ${ctx.event.event_date}
- Release time: ${ctx.event.release_time ?? "(not specified)"}
- Source: ${ctx.event.source}
${consensusBlock}
${actualBlock}
${reactionBlock}
${positionsBlock}
${newslettersBlock}
${analystBlock}
${pressBlock}
${priorCallBlock}

## Your task

Use the structured context above as the source of truth. **For anything missing — call commentary, post-print sell-side reactions, transcript quotes, guidance change details — use web_search** with focus on the last 4 hours of coverage. Cite source URLs inline.

Write the recap as markdown:

1. **Headline** — beat / miss / in-line. Clean numbers: actual vs. consensus on EPS and revenue with beat-by-X% calls. Guidance direction.

2. **Line by line** — every reportable metric we have data on (EPS, revenue, segments, margin, FCF where available). Compare to consensus and to year-ago. Flag anything that surprised either way.

3. **The reaction** — stock move vs. SPY/QQQ/sector. If transcript / call quotes are available via web_search, lead with the one or two quotes that explain the move. If not, note "transcript not yet posted — recap will update if a follow-up runs."

4. **Sell-side first takes** — web_search for analyst notes published in the last few hours. Quote the headline, flag price-target changes, name the firm. If nothing is out yet, say so.

5. **Position implications** — given the user's combined position (use §Positions verbatim), what's the immediate P&L impact at the reaction-snapshot price? Any hedging / IV-crush dynamics for option holdings? Should the thesis change?

6. **Sources** — newsletter articles cited + web URLs.

Tone: analytical colleague. Numbers and direct quotes over adjectives. 500-900 words.`;
}

function renderPositionsBlock(ctx: PreviewContext): string {
  if (ctx.positions.length === 0) {
    return `\n## Positions\nThe user does NOT currently hold ${ctx.family.join("/")} (or any sibling). Treat this as a watchlist note — explain the relevance assuming pure observer interest.\n`;
  }
  const lines = ctx.positions.map((p) => formatPositionLine(p));
  const summary = formatPositionSummary(ctx);
  return `\n## Positions (cross-account, stock + options + sibling classes rolled up)\n${lines.join("\n")}\n\n${summary}\n`;
}

function formatPositionLine(p: PositionEntry): string {
  const last = p.latest_price != null ? `$${p.latest_price.toFixed(2)}` : "?";
  const cost = p.cost_basis != null ? `$${p.cost_basis.toFixed(2)}` : "?";
  if (p.security_type.toLowerCase() === "option") {
    const right = p.option_type ? p.option_type.toUpperCase().charAt(0) : "?";
    const strike = p.strike_price != null ? `$${p.strike_price.toFixed(2)}` : "?";
    const expiry = p.expiration_date ?? "?";
    const mult = p.multiplier ?? 100;
    const contracts = p.quantity;
    const notionalShares = contracts * mult;
    const blendedPer = p.cost_basis != null && contracts > 0
      ? `$${(p.cost_basis / contracts).toFixed(2)}`
      : "?";
    return `- **${p.underlying_symbol ?? "?"} ${expiry} ${right}${strike}** option (${p.symbol.trim()}) in ${p.account_name}: ${contracts} contract(s) — ${notionalShares} shares notional × ${mult}, total cost ${cost} (~${blendedPer}/contract), underlying last ${last} (as of ${p.as_of_date})`;
  }
  const blendedPer = p.cost_basis != null && p.quantity > 0
    ? `$${(p.cost_basis / p.quantity).toFixed(2)}`
    : "?";
  return `- **${p.symbol}** in ${p.account_name}: ${p.quantity} sh, cost basis ${cost} (~${blendedPer}/sh), last price ${last} (as of ${p.as_of_date})`;
}

function formatPositionSummary(ctx: PreviewContext): string {
  const parts: string[] = [];
  if (ctx.combinedShares > 0) {
    parts.push(`${ctx.combinedShares.toFixed(0)} shares`);
  }
  if (ctx.combinedContracts > 0) {
    // Approximate notional in shares for context — uses 100x multiplier as
    // the dominant case, but the per-line entries already give the exact mult.
    const optionEntries = ctx.positions.filter(
      (p) => p.security_type.toLowerCase() === "option",
    );
    const notional = optionEntries.reduce(
      (s, p) => s + p.quantity * (p.multiplier ?? 100),
      0,
    );
    parts.push(`${ctx.combinedContracts.toFixed(0)} option contract(s) (~${notional.toFixed(0)} shares notional)`);
  }
  const exposure = parts.length > 0 ? parts.join(" + ") : "no live exposure";
  return `**Combined exposure:** ${exposure} across ${ctx.positions.length} account-position(s). Stocks and options are listed separately above; do NOT add raw share counts and contract counts together when sizing — instead reason about delta-weighted exposure and the asymmetry of each leg.`;
}

function renderNewslettersBlock(
  ctx: PreviewContext,
  phase: "preview" | "recap",
): string {
  if (ctx.recentArticles.length === 0) {
    return `\n## Newsletter coverage\nNo recent newsletter articles mention ${ctx.symbol}. Use web_search to gather sell-side / buy-side commentary instead.\n`;
  }
  const blocks = ctx.recentArticles.map((a) => {
    const sentSuffix = a.sentiment_score != null
      ? ` (sentiment score: ${a.sentiment_score.toFixed(2)})`
      : "";
    return `### [${a.received_at.slice(0, 16).replace("T", " ")}] ${a.source_name} — ${a.subject}${sentSuffix}\n${a.body}`;
  });
  const framing = phase === "preview"
    ? `These are the user's preferred newsletter feeds covering ${ctx.symbol} (or a sibling) in the last 7 days. Treat these as **bogies + buy-side / sell-side commentary** — quote authors by name, surface where they disagree, and note any specific numbers (EPS, revenue, segment splits, price targets) they mention.`
    : `These are the user's preferred newsletter feeds covering ${ctx.symbol} in the last 7 days — context for how the position was being framed *into* the print. Reference these only where they're directly relevant to interpreting the actual.`;
  return `\n## Newsletter coverage (preferred sources, last 7 days)\n${framing}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

function renderAnalystBlock(ctx: PreviewContext): string {
  const parts: string[] = [];
  if (ctx.recommendationTrend) {
    parts.push(`### Recommendation trend (last 6 months)\n${ctx.recommendationTrend}`);
  }
  if (ctx.priceTarget) {
    parts.push(`### Price target consensus\n${ctx.priceTarget}`);
  }
  if (ctx.ratingChanges) {
    parts.push(`### Recent rating changes (last 8)\n${ctx.ratingChanges}`);
  }
  if (parts.length === 0) {
    return `\n## Analyst coverage\nNo cached analyst data for ${ctx.symbol}. If relevant, use web_search to fill in price-target consensus and recent upgrade/downgrade activity.\n`;
  }
  return `\n## Analyst coverage (cached, Finnhub)\n${parts.join("\n\n")}\n`;
}

function renderPriorTranscriptBlock(ctx: PreviewContext): string {
  if (!ctx.priorTranscript) return "";
  const t = ctx.priorTranscript;
  const summary = t.summary && t.summary.length > 4000
    ? t.summary.slice(0, 4000) + "…"
    : t.summary;
  const guidance = t.guidance && t.guidance.length > 1500
    ? t.guidance.slice(0, 1500) + "…"
    : t.guidance;
  const parts: string[] = [];
  parts.push(`*Cached call: ${t.year}-Q${t.quarter} (source: ${t.source}${t.sentiment_label ? `, sentiment: ${t.sentiment_label}` : ""})*`);
  if (summary) parts.push(`**Summary:**\n${summary}`);
  if (guidance) parts.push(`**Guidance:**\n${guidance}`);
  return `\n## Prior call (most recent cached)\n${parts.join("\n\n")}\n`;
}

// ── Anthropic call with web_search ─────────────────────────────────

async function callClaude(
  prompt: string,
  phase: "preview" | "recap",
): Promise<string> {
  const featureKey = phase === "preview" ? "earningsPreview" : "earningsRecap";
  const client = getRawAnthropicClient(featureKey);
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 4096,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    messages: [{ role: "user", content: prompt }],
  });
  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  const text = textBlocks.map((b) => b.text).join("\n").trim();
  if (!text) {
    throw new EarningsEmailError(
      `Claude returned empty content for ${phase}.`,
      500,
    );
  }
  return text;
}

// ── Date helpers ───────────────────────────────────────────────────

function formatDateLong(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Re-export the types so tests can import the contract.
export type {
  PositionEntry as EarningsPositionEntry,
  NewsletterEntry as EarningsNewsletterEntry,
  PreviewContext as EarningsPreviewContext,
  RecapContext as EarningsRecapContext,
};
