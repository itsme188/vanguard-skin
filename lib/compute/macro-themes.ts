/**
 * macro-themes.ts — AI composer for weekly macro themes per scope.
 *
 * Cache-first via analysis_macro_themes. On miss, builds a 7d signal blob
 * from research_articles + calendar_events + level_alerts, fills the prompt in
 * priority order under a size cap (whole items only), calls the model,
 * validates with Zod, CHECKS EACH THEME AGAINST THE INPUT IT CITES (dropping
 * any that fail), attaches per-scope exposure + top-3 contributors, UPSERTs,
 * returns.
 */

import { z } from "zod";

const FACTOR_LABELS = [
  "interest_rate_sensitive", "growth_vs_value", "cyclical",
  "international_exposure", "geopolitical_onshoring", "tariff_exposure",
  "ai_exposure", "crypto_adjacent", "regulatory_risk",
] as const;

export const ThemeDirection = z.enum(["risk-on", "risk-off", "neutral"]);
export type ThemeDirection = z.infer<typeof ThemeDirection>;

const MacroThemeCoreSchema = z.object({
  name: z.string().min(3).max(60),
  factor_label: z.enum(FACTOR_LABELS),
  direction: ThemeDirection,
  summary: z.string().min(15).max(280),
});

// What the MODEL returns. The citation fields are deliberately loose here: a
// missing or malformed citation must drop that ONE theme in the check below,
// not fail the whole reply at the schema.
const MacroThemeAiSchema = MacroThemeCoreSchema.extend({
  cited_kind: z.string().nullish(),
  cited_id: z.union([z.number(), z.string()]).nullish(),
  cited_excerpt: z.string().nullish(),
  cited_read: z.string().nullish(),
});
export type MacroThemeAi = z.infer<typeof MacroThemeAiSchema>;

export const CitedKind = z.enum(["article", "event", "alert"]);
export type CitedKind = z.infer<typeof CitedKind>;
/** What the cited input says about its own subject, in the model's reading. */
export const CitedRead = z.enum(["positive", "negative", "mixed"]);
export type CitedRead = z.infer<typeof CitedRead>;

export const MacroThemesSchema = z.array(MacroThemeAiSchema).min(1).max(5);

const ContributorSchema = z.object({
  symbol: z.string(),
  weight: z.number(),
});
export const ExposureBucket = z.enum(["low", "moderate", "high", "very-high"]);
export type ExposureBucket = z.infer<typeof ExposureBucket>;

// Relative marker across ONE week's themes (owner ruling on the QA finding
// analysis-macro-themes--exposure-badge-always-very-high): the absolute bucket
// saturates — every factor tilt on a diversified book clears the top
// threshold — so the card shows the computed percentage and which theme the
// book is most / least exposed to this week.
export const ExposureRank = z.enum(["highest", "lowest"]);
export type ExposureRank = z.infer<typeof ExposureRank>;

export const MacroThemeSchema = MacroThemeCoreSchema.extend({
  // The citation (owner ruling 2026-10-08). All OPTIONAL: a theme cached
  // before citations existed has none and must keep parsing and rendering.
  // A theme written since always carries kind + id + title + excerpt, and the
  // excerpt has been found in the text that was sent for that input.
  cited_kind: CitedKind.optional(),
  cited_id: z.number().optional(),
  cited_title: z.string().optional(),
  cited_excerpt: z.string().optional(),
  cited_read: CitedRead.optional(),
  // Still stored: the weekly briefing markdown reads it. The card no longer
  // prints it.
  exposure_bucket: ExposureBucket,
  // Both OPTIONAL: a row cached before these existed must keep parsing.
  // exposure_pct is 0-100 (the theme factor's weighted exposure) and is
  // absent when the scope has no tilt for that factor — unknown, not zero.
  exposure_pct: z.number().optional(),
  exposure_rank: ExposureRank.nullable().optional(),
  top_contributors: z.array(ContributorSchema).max(3),
});
export type MacroTheme = z.infer<typeof MacroThemeSchema>;

/**
 * Mark the week's most and least exposed themes. Input is one entry per theme
 * (0-100, or null/undefined when the exposure is unknown); output is aligned.
 *
 * Compared at the WHOLE-PERCENT precision the card prints, so a marker can
 * never contradict two figures that read the same. Themes tied at an end all
 * carry the marker (two themes on one factor have the same exposure — picking
 * one would be arbitrary). No marker at all when fewer than two themes have a
 * figure or when every figure reads the same: there is nothing to rank.
 */
export function rankThemeExposures(
  pcts: ReadonlyArray<number | null | undefined>,
): Array<ExposureRank | null> {
  const shown = pcts.map((p) =>
    typeof p === "number" && Number.isFinite(p) ? Math.round(p) : null,
  );
  const known = shown.filter((p): p is number => p !== null);
  if (known.length < 2) return shown.map(() => null);
  const max = Math.max(...known);
  const min = Math.min(...known);
  if (max === min) return shown.map(() => null);
  return shown.map((p) => (p === null ? null : p === max ? "highest" : p === min ? "lowest" : null));
}

// ---------------------------------------------------------------------------
// Signal aggregation
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

const MIN_SIGNAL_THRESHOLD = 2;
const ARTICLE_LOAD_LIMIT = 200;

export interface ArticleSignal {
  id: number;
  subject: string;
  /** The stored AI summary (lib/gmail/process.ts); null on an unenriched row. */
  summary: string | null;
  sentiment: string | null;
  mentioned_symbols: string[];
  excerpt: string;
}
export interface EventSignal {
  id: number;
  event_date: string;
  event_type: string;
  /** The event's own name ("CPI Release"); a macro row has no symbol to go by. */
  title: string;
  symbol: string | null;
  actual_value: string | null;
  consensus_value: string | null;
  previous_value: string | null;
  reaction_snapshot: string | null;
}
export interface AlertSignal {
  id: number;
  symbol: string;
  /** 'support' | 'resistance' | 'entry' | 'exit' | 'stop' | 'scale_in' */
  level_type: string | null;
  triggered_at: string;
}
export interface MacroSignalBlob {
  articleCount: number;
  enrichedEventCount: number;
  alertCount: number;
  totalSignalCount: number;
  underThreshold: boolean;
  articles: ArticleSignal[];
  enrichedEvents: EventSignal[];
  alerts: AlertSignal[];
}

// Signals (articles, enriched events, level alerts) are portfolio-wide —
// scope-specific filtering happens later in the post-process step when we
// attach exposure_bucket + top_contributors from computeFactorAnalysis. The
// _scope param is accepted for interface symmetry with future scope-aware
// expansion (e.g., narrowing alerts to held-only in the scope).
export function buildMacroSignalBlob(
  db: Database.Database,
  _scope: string,
  weekOf: string
): MacroSignalBlob {
  // is_relevant = 1: an article voted off-topic never reaches the model. The
  // limit is a safety bound on the week, not the selection: which articles are
  // SENT is decided by buildMacroPromptInputs (held-relevance, then newest),
  // so a held name's article is not lost for being older than 60 others.
  const articleRows = db.prepare(
    `SELECT id, subject, summary, sentiment, mentioned_symbols, substr(raw_text, 1, 2000) AS excerpt
     FROM research_articles
     WHERE datetime(received_at) >= datetime(?, '-7 days')
       AND is_relevant = 1
     ORDER BY datetime(received_at) DESC, id DESC
     LIMIT ${ARTICLE_LOAD_LIMIT}`
  ).all(weekOf) as Array<{
    id: number; subject: string; summary: string | null; sentiment: string | null;
    mentioned_symbols: string | null; excerpt: string | null;
  }>;

  const articles: ArticleSignal[] = articleRows.map((r) => {
    let symbols: string[] = [];
    try { symbols = r.mentioned_symbols ? JSON.parse(r.mentioned_symbols) : []; } catch { symbols = []; }
    if (!Array.isArray(symbols)) symbols = [];
    return {
      id: r.id, subject: r.subject, summary: r.summary, sentiment: r.sentiment,
      mentioned_symbols: symbols.filter((x): x is string => typeof x === "string"),
      excerpt: r.excerpt ?? "",
    };
  });

  const eventRows = db.prepare(
    // superseded = 0: a superseded earnings twin is the same print under a
    // retired row — listing it shows the print twice and crowds the canonical
    // row out of the LIMIT.
    `SELECT id, event_date, event_type, title, symbol, actual_value,
            consensus_value, previous_value, reaction_snapshot
     FROM calendar_events
     WHERE datetime(event_date) >= datetime(?, '-7 days')
       AND enriched_at IS NOT NULL
       AND superseded = 0
     ORDER BY event_date DESC
     LIMIT 30`
  ).all(weekOf) as EventSignal[];

  const alertRows = db.prepare(
    `SELECT la.id, s.symbol, sl.level_type, la.triggered_at
     FROM level_alerts la
     JOIN securities s ON s.id = la.security_id
     LEFT JOIN security_levels sl ON sl.id = la.level_id
     WHERE datetime(la.triggered_at) >= datetime(?, '-7 days')
     ORDER BY la.triggered_at DESC
     LIMIT 30`
  ).all(weekOf) as AlertSignal[];

  const articleCount = articles.length;
  const enrichedEventCount = eventRows.length;
  const alertCount = alertRows.length;
  const totalSignalCount = articleCount + enrichedEventCount;
  const underThreshold = articleCount < MIN_SIGNAL_THRESHOLD && enrichedEventCount < 1;

  return {
    articleCount, enrichedEventCount, alertCount, totalSignalCount, underThreshold,
    articles, enrichedEvents: eventRows, alerts: alertRows,
  };
}

// ---------------------------------------------------------------------------
// Theme generation
// ---------------------------------------------------------------------------

import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { parseJsonArrayLenient } from "@/lib/ai/extract-json";
import { resolveFeatureModel } from "@/lib/ai/models";
import { resolveScope } from "@/lib/queries/accounts";
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { getHeldSymbolSet, heldSymbolsMentioned } from "@/lib/research/held-symbol-relevance";
import { isUsableReactionLeg, parseReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";

const SYSTEM_PROMPT = `You are a portfolio analyst identifying the macro themes that actually moved markets this week. Output ONLY valid JSON matching the schema. Never include prose outside the JSON array. 3-5 themes maximum. Each theme must map to one factor_label from the allowed list. Each summary is one sentence, 30-200 chars. Prefer fewer broader themes over many narrow ones — split only when the underlying drivers are independent. Every theme must cite exactly one of the supplied inputs and quote it word for word; a theme you cannot support with a quote from the inputs is left out.`;

const USER_PROMPT_TEMPLATE = `Given the past 7 days of enriched macro events (CPI/PCE/FOMC actuals + market reactions), price-level alerts that fired, and news articles, identify 3-5 macro themes that drove markets this week.

For each theme:
- name: short label (e.g., "Tariff escalation", "AI mania cooling")
- factor_label: one of [interest_rate_sensitive, growth_vs_value, cyclical, international_exposure, geopolitical_onshoring, tariff_exposure, ai_exposure, crypto_adjacent, regulatory_risk]
- direction: "risk-on" | "risk-off" | "neutral"
- summary: one-sentence what it means (30-200 chars). It must agree with the input you cite.
- cited_kind: "article" | "event" | "alert" — which input list the supporting item is in
- cited_id: the "id" of that one item, exactly as given in the inputs
- cited_excerpt: one sentence or phrase copied word for word from that item. For an article, copy it from the article's "summary" or "excerpt" (at least a full clause, not from the subject line). For an event or alert, copy one of its text values (for example its title). Do not paraphrase, shorten with "...", or join text from two places.
- cited_read: "positive" | "negative" | "mixed" — what the cited item says about its own subject (good news, bad news, or both/unclear)

Output JSON array only. Example:
[{"name":"...","factor_label":"...","direction":"...","summary":"...","cited_kind":"article","cited_id":123,"cited_excerpt":"...","cited_read":"negative"}]

Inputs:
{INPUTS_JSON}`;

// ---------------------------------------------------------------------------
// Prompt inputs: a size cap filled in priority order, whole items only
// ---------------------------------------------------------------------------
//
// Owner ruling 2026-10-08. The inputs used to be pretty-printed with the
// articles first and cut at a fixed length, mid-JSON: about a quarter of the
// week's articles got through and no calendar event or alert did.
//
// Now: the same cap, measured on the compact JSON actually sent. Calendar
// events go in first and may use up to MACRO_EVENT_BUDGET_SHARE of it, alerts
// next with up to MACRO_ALERT_BUDGET_SHARE, and articles take everything that
// is left (never less than three quarters). An item is added whole or not at
// all. Articles are ranked by how many HELD names they mention (share-class
// aware, option underlyings included), then newest first.

export const MACRO_PROMPT_INPUT_CAP = 16000;
export const MACRO_EVENT_BUDGET_SHARE = 0.2;
export const MACRO_ALERT_BUDGET_SHARE = 0.05;

const SUBJECT_CHARS = 200;
const SUMMARY_CHARS = 600;
// The stored summary is the denser signal; with one, the raw opening is kept
// short so more of the week's articles fit. Without one it is all there is.
const EXCERPT_CHARS_WITH_SUMMARY = 240;
const EXCERPT_CHARS_ALONE = 800;
const SYMBOLS_PER_ARTICLE = 12;

interface PromptArticle {
  id: number;
  subject: string;
  symbols: string[];
  summary?: string;
  excerpt?: string;
}
interface PromptEvent {
  id: number;
  date: string;
  type: string;
  title: string;
  symbol?: string;
  actual?: string;
  consensus?: string;
  previous?: string;
  /** e.g. "SPY +0.40%, TLT -0.25%" — the usable legs of the stored snapshot. */
  reaction?: string;
}
interface PromptAlert {
  id: number;
  symbol: string;
  level?: string;
  fired: string;
}

/** One input as it was sent: what a citation of it is checked against. */
interface SentItem {
  /** What the card calls this input. */
  title: string;
  /** The text values that were sent; a quote must sit inside ONE of them. */
  texts: string[];
  /** Articles only: the stored sentiment (never sent to the model). */
  sentiment: string | null;
}

export interface MacroPromptSent {
  articles: ArticleSignal[];
  events: EventSignal[];
  alerts: AlertSignal[];
  /** Keyed by `${kind}:${id}`. */
  byRef: Map<string, SentItem>;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatReaction(raw: string | null): string | undefined {
  const snap = parseReactionSnapshot(raw);
  if (!snap) return undefined;
  const parts: string[] = [];
  const add = (label: string, leg: { delta_pct: number }) => {
    parts.push(`${label} ${leg.delta_pct >= 0 ? "+" : ""}${leg.delta_pct.toFixed(2)}%`);
  };
  // An unusable leg (dead quote) is absent, never a flat move.
  if (isUsableReactionLeg(snap.spy)) add("SPY", snap.spy);
  if (isUsableReactionLeg(snap.qqq)) add("QQQ", snap.qqq);
  if (isUsableReactionLeg(snap.tlt)) add("TLT", snap.tlt);
  if (isUsableReactionLeg(snap.sector) && typeof snap.sector.symbol === "string") add(snap.sector.symbol, snap.sector);
  if (isUsableReactionLeg(snap.symbol) && typeof snap.symbol.symbol === "string") add(snap.symbol.symbol, snap.symbol);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function toPromptEvent(e: EventSignal): PromptEvent {
  const reaction = formatReaction(e.reaction_snapshot);
  return {
    id: e.id,
    date: e.event_date,
    type: e.event_type,
    title: squash(e.title ?? "").slice(0, SUBJECT_CHARS),
    ...(e.symbol ? { symbol: e.symbol } : {}),
    ...(e.actual_value ? { actual: squash(e.actual_value).slice(0, SUBJECT_CHARS) } : {}),
    ...(e.consensus_value ? { consensus: squash(e.consensus_value).slice(0, SUBJECT_CHARS) } : {}),
    ...(e.previous_value ? { previous: squash(e.previous_value).slice(0, SUBJECT_CHARS) } : {}),
    ...(reaction ? { reaction } : {}),
  };
}

function toPromptAlert(a: AlertSignal): PromptAlert {
  return {
    id: a.id,
    symbol: a.symbol,
    ...(a.level_type ? { level: a.level_type } : {}),
    fired: a.triggered_at.slice(0, 10),
  };
}

function toPromptArticle(a: ArticleSignal): PromptArticle {
  const summary = squash(a.summary ?? "").slice(0, SUMMARY_CHARS).trim();
  const excerpt = squash(a.excerpt ?? "")
    .slice(0, summary ? EXCERPT_CHARS_WITH_SUMMARY : EXCERPT_CHARS_ALONE)
    .trim();
  return {
    id: a.id,
    subject: squash(a.subject ?? "").slice(0, SUBJECT_CHARS),
    symbols: a.mentioned_symbols.slice(0, SYMBOLS_PER_ARTICLE),
    ...(summary ? { summary } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

/**
 * Rank the week's articles for the prompt: more held names mentioned first,
 * then the order given (newest first). Stable, so ties keep their recency.
 */
export function rankArticlesForPrompt(
  articles: ReadonlyArray<ArticleSignal>,
  held: Set<string>,
): ArticleSignal[] {
  return articles
    .map((a, i) => ({ a, i, hits: heldSymbolsMentioned(a.mentioned_symbols, held).length }))
    .sort((x, y) => y.hits - x.hits || x.i - y.i)
    .map((x) => x.a);
}

/** Add whole items, in order, while they fit. Returns the JSON pieces kept. */
function fillWhole<S, P>(
  candidates: ReadonlyArray<S>,
  toPrompt: (s: S) => P,
  budget: number,
  onKeep: (source: S, sentItem: P) => void,
): { pieces: string[]; used: number } {
  const pieces: string[] = [];
  let used = 0;
  for (const c of candidates) {
    const item = toPrompt(c);
    const piece = JSON.stringify(item);
    const cost = piece.length + 1; // the separating comma
    // An item that does not fit is skipped whole; a smaller one further down
    // may still fit, so keep going rather than stopping at the first miss.
    if (used + cost > budget) continue;
    pieces.push(piece);
    used += cost;
    onKeep(c, item);
  }
  return { pieces, used };
}

function stringValues(item: object): string[] {
  return Object.values(item).filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/**
 * Build the JSON the model is sent, and the record of what was sent that the
 * citation check runs against. `held` is the whole-book held-symbol set
 * (getHeldSymbolSet); relevance ranking is not scope-specific.
 */
export function buildMacroPromptInputs(
  blob: MacroSignalBlob,
  held: Set<string>,
): { json: string; sent: MacroPromptSent } {
  const sent: MacroPromptSent = { articles: [], events: [], alerts: [], byRef: new Map() };
  const open = '{"enriched_events":[';
  const mid1 = '],"alerts":[';
  const mid2 = '],"articles":[';
  const close = "]}";
  const cap = MACRO_PROMPT_INPUT_CAP - (open.length + mid1.length + mid2.length + close.length);

  const events = fillWhole(blob.enrichedEvents, toPromptEvent, Math.floor(cap * MACRO_EVENT_BUDGET_SHARE), (e, item) => {
    sent.events.push(e);
    sent.byRef.set(`event:${e.id}`, { title: item.title, texts: stringValues(item), sentiment: null });
  });
  const alerts = fillWhole(blob.alerts, toPromptAlert, Math.floor(cap * MACRO_ALERT_BUDGET_SHARE), (a, item) => {
    sent.alerts.push(a);
    sent.byRef.set(`alert:${a.id}`, {
      title: `${a.symbol}${a.level_type ? ` ${a.level_type}` : ""} level alert`,
      texts: stringValues(item),
      sentiment: null,
    });
  });
  // Whatever the events and alerts did not use goes to the articles.
  const articles = fillWhole(
    rankArticlesForPrompt(blob.articles, held),
    toPromptArticle,
    cap - events.used - alerts.used,
    (a, item) => {
      sent.articles.push(a);
      sent.byRef.set(`article:${a.id}`, {
        title: item.subject,
        // Summary and excerpt only: a subject line is a headline, not the
        // article's text, and a quote may not straddle the two.
        texts: [item.summary, item.excerpt].filter((t): t is string => typeof t === "string"),
        sentiment: a.sentiment,
      });
    },
  );

  const json = `${open}${events.pieces.join(",")}${mid1}${alerts.pieces.join(",")}${mid2}${articles.pieces.join(",")}${close}`;
  return { json, sent };
}

// ---------------------------------------------------------------------------
// The citation check
// ---------------------------------------------------------------------------

/** A quote from an article must be at least a clause: a ticker alone proves nothing. */
const MIN_ARTICLE_QUOTE_CHARS = 20;
/** An event or alert carries short text values (a title, a ticker). */
const MIN_OTHER_QUOTE_CHARS = 3;

/** Lower-case, one space between words, plain quote marks and dashes. */
function normaliseForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The quote as the model gave it, minus wrapping quote marks and a leading/trailing ellipsis. */
function cleanQuote(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/^(?:\.\.\.|\u2026)\s*/, "")
      .replace(/\s*(?:\.\.\.|\u2026)$/, "")
      .replace(/^["'\u2018\u2019\u201C\u201D]+/, "")
      .replace(/["'\u2018\u2019\u201C\u201D]+$/, "")
      .trim();
  }
  return out;
}

export interface VerifiedCitation {
  cited_kind: CitedKind;
  cited_id: number;
  cited_title: string;
  cited_excerpt: string;
  cited_read?: CitedRead;
}

export type CitationVerdict =
  | { ok: true; citation: VerifiedCitation }
  | { ok: false; reason: string };

/**
 * Check one theme against what was sent.
 *
 *  1. It names an input (kind + id) that was actually in the prompt. No kind
 *     with an id is read as an article.
 *  2. Its quote occurs in that input's sent text (case, whitespace and
 *     typographic quote marks aside), and is long enough to mean something.
 *  3. Articles only: its reading of the article does not CLEARLY contradict
 *     the sentiment stored for it at ingest. Clear = read "positive" on a
 *     "bearish" article, or "negative" on a "bullish" one. A "mixed" read, or
 *     a mixed / neutral / missing stored sentiment, never fails. When the
 *     stored sentiment IS bullish or bearish and the model gave no usable
 *     read, the check cannot be made and the theme fails closed.
 *
 * The theme's risk-on / risk-off direction is NOT compared with the article:
 * it is a market-level call (bad news for one company can be risk-on for the
 * tape), which is why the model is asked for `cited_read` separately.
 */
export function verifyThemeCitation(theme: MacroThemeAi, sent: MacroPromptSent): CitationVerdict {
  const rawKind = typeof theme.cited_kind === "string" ? theme.cited_kind.trim().toLowerCase() : "";
  const idNum = typeof theme.cited_id === "number"
    ? theme.cited_id
    : typeof theme.cited_id === "string" && /^\d+$/.test(theme.cited_id.trim())
      ? Number(theme.cited_id.trim())
      : null;
  if (idNum === null || !Number.isInteger(idNum)) return { ok: false, reason: "names no source" };
  const kind = CitedKind.safeParse(rawKind === "" ? "article" : rawKind);
  if (!kind.success) return { ok: false, reason: `unknown source kind "${rawKind}"` };

  const item = sent.byRef.get(`${kind.data}:${idNum}`);
  if (!item) return { ok: false, reason: `cites ${kind.data} ${idNum}, which was not sent` };

  const quote = cleanQuote(typeof theme.cited_excerpt === "string" ? theme.cited_excerpt : "");
  const needle = normaliseForMatch(quote);
  const minChars = kind.data === "article" ? MIN_ARTICLE_QUOTE_CHARS : MIN_OTHER_QUOTE_CHARS;
  if (needle.length < minChars) return { ok: false, reason: "quote missing or too short" };
  if (!item.texts.some((t) => normaliseForMatch(t).includes(needle))) {
    return { ok: false, reason: `quote not found in ${kind.data} ${idNum}` };
  }

  const read = CitedRead.safeParse(typeof theme.cited_read === "string" ? theme.cited_read.trim().toLowerCase() : "");
  if (kind.data === "article") {
    const stored = (item.sentiment ?? "").trim().toLowerCase();
    if (stored === "bullish" || stored === "bearish") {
      if (!read.success) return { ok: false, reason: `no reading given for a ${stored} article` };
      if ((stored === "bearish" && read.data === "positive") || (stored === "bullish" && read.data === "negative")) {
        return { ok: false, reason: `reads article ${idNum} as ${read.data}; its stored sentiment is ${stored}` };
      }
    }
  }

  return {
    ok: true,
    citation: {
      cited_kind: kind.data,
      cited_id: idNum,
      cited_title: item.title,
      cited_excerpt: quote,
      ...(read.success ? { cited_read: read.data } : {}),
    },
  };
}

/**
 * A themes reply we could not turn into validated themes.
 *
 * `message` is USER-FACING — it is what the API returns and the Macro-this-week
 * card renders, so it never carries parser jargon ("Unterminated string in JSON
 * at position 1074"). `detail` carries that raw text plus the head of the reply
 * for the server log. (2026-09-10 QA: the raw SyntaxError message rendered in
 * the card, in red, as the whole card body.)
 */
export class MacroThemesParseError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "MacroThemesParseError";
    this.detail = detail;
  }
}

const UNREADABLE_MESSAGE =
  "The model's reply couldn't be read as themes — try again in a moment.";
const WRONG_SHAPE_MESSAGE =
  "The model's reply didn't match the themes format — try again in a moment.";
const DETAIL_REPLY_CHARS = 120;

function replySnippet(rawText: string): string {
  return rawText.slice(0, DETAIL_REPLY_CHARS);
}

// Parse the model's themes JSON through the project-standard lenient path
// (fence strip → whole-text parse → first-`[`…last-`]` slice, each with the
// C0-control-character retry — see lib/ai/extract-json.ts). That tolerates the
// three shapes Sonnet actually emits despite the "JSON only" system prompt: a
// prose preamble, a trailing sign-off, and unescaped newlines inside a string
// literal. A genuinely unreadable reply (usually a truncated one) throws
// MacroThemesParseError so the failure surfaces in plain English.
export function parseThemesJson(rawText: string): MacroThemeAi[] {
  let raw: unknown[];
  try {
    raw = parseJsonArrayLenient(rawText, "macro themes");
  } catch (err) {
    // parseJsonArrayLenient keeps the underlying SyntaxError as `cause`.
    const parserMsg =
      err instanceof Error
        ? err.cause instanceof Error
          ? err.cause.message
          : err.message
        : String(err);
    const detail = `${parserMsg} — reply began: ${replySnippet(rawText)}`;
    console.error(`[macro-themes] unreadable model reply: ${detail}`);
    throw new MacroThemesParseError(UNREADABLE_MESSAGE, detail);
  }
  try {
    return MacroThemesSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = `${msg} — reply began: ${replySnippet(rawText)}`;
    console.error(`[macro-themes] reply failed schema validation: ${detail}`);
    throw new MacroThemesParseError(WRONG_SHAPE_MESSAGE, detail);
  }
}

export interface GenerateMacroThemesOpts {
  scope: string;
  weekOf: string;
  forceRegen?: boolean;
}

export interface MacroThemesResult {
  themes: MacroTheme[];
  sourceSummary: {
    articles: Array<{ id: number; title: string }>;
    // title / event_type are absent on a summary cached before 2026-10-07.
    events: Array<{ id: number; symbol: string | null; event_date: string; title?: string; event_type?: string }>;
    alerts: Array<{ id: number; symbol: string }>;
    /**
     * How many of each the week held; the three lists above are what was SENT
     * to the model, in the order sent. Absent on a summary cached before
     * 2026-10-08, whose lists were the ten most recent of each instead.
     */
    totals?: { articles: number; events: number; alerts: number };
    /** Themes the model returned that failed the citation check. */
    droppedThemes?: number;
  } | null;
  fromCache: boolean;
  generatedAt: string;
  underThreshold: boolean;
  /** Themes dropped by the citation check on THIS generation (absent on a cache read). */
  droppedThemes?: number;
  /**
   * The model returned themes and EVERY one failed the citation check. Nothing
   * was cached (an empty cached array means "insufficient signal", which this
   * is not), so an earlier verified set for the week, if any, is still there.
   */
  noneVerified?: boolean;
}

/** What the card shows for `noneVerified`. */
export const MACRO_NONE_VERIFIED_MESSAGE =
  "Themes were generated, but none could be verified against its source, so none are shown. Try again.";

const EXPOSURE_THRESHOLDS = { low: 0.05, moderate: 0.15, high: 0.25 } as const;

function bucketExposure(weight: number): ExposureBucket {
  if (weight < EXPOSURE_THRESHOLDS.low) return "low";
  if (weight < EXPOSURE_THRESHOLDS.moderate) return "moderate";
  if (weight < EXPOSURE_THRESHOLDS.high) return "high";
  return "very-high";
}

/**
 * Drop cash equivalents from a factor's contributor list. A stable-value sweep
 * fund is cash with a ticker: it led the rate theme's "top" list every week
 * while carrying no duration worth naming (QA finding
 * analysis-macro-themes--identical-top-exposure-across-themes-money-market-leads-regression-1).
 * Identity comes from the one shared predicate, never a symbol list. Only the
 * NAMES change — the factor's exposure figure is computed elsewhere and is
 * untouched.
 */
export function dropCashEquivalentContributors<T extends { symbol: string }>(
  db: Database.Database,
  contributors: ReadonlyArray<T>,
): T[] {
  if (contributors.length === 0) return [];
  const symbols = [...new Set(contributors.map((c) => c.symbol))];
  const rows = db.prepare(
    `SELECT symbol, security_type, fund_category FROM securities
     WHERE symbol IN (${symbols.map(() => "?").join(",")})`,
  ).all(...symbols) as Array<{ symbol: string; security_type: string | null; fund_category: string | null }>;
  const cash = new Set(rows.filter((r) => isCashEquivalentSecurity(r)).map((r) => r.symbol));
  return contributors.filter((c) => !cash.has(c.symbol));
}

export async function generateMacroThemes(
  db: Database.Database,
  opts: GenerateMacroThemesOpts
): Promise<MacroThemesResult> {
  if (!opts.forceRegen) {
    const cached = getCachedMacroThemes(db, opts.scope, opts.weekOf);
    if (cached) {
      const themes = JSON.parse(cached.themesJson) as MacroTheme[];
      const sourceSummary = cached.sourceSummary ? JSON.parse(cached.sourceSummary) : null;
      return { themes, sourceSummary, fromCache: true, generatedAt: cached.generatedAt, underThreshold: false };
    }
  }

  const blob = buildMacroSignalBlob(db, opts.scope, opts.weekOf);

  // Under-threshold → empty array + cache it so we don't re-call Sonnet
  // on every page view this week.
  if (blob.underThreshold) {
    upsertMacroThemes(db, {
      scope: opts.scope, weekOf: opts.weekOf, themesJson: "[]",
      sourceSummary: JSON.stringify({ articles: [], events: [], alerts: [], note: "insufficient signal" }),
      modelUsed: "(none — under threshold)",
    });
    return { themes: [], sourceSummary: null, fromCache: false, generatedAt: new Date().toISOString(), underThreshold: true };
  }

  const { json: inputsJson, sent } = buildMacroPromptInputs(blob, getHeldSymbolSet(db));
  const prompt = USER_PROMPT_TEMPLATE.replace("{INPUTS_JSON}", () => inputsJson);

  let rawText: string;
  try {
    const result = await generateTextForFeature("analysisMacroThemes", {
      system: SYSTEM_PROMPT,
      prompt,
      // Explicit cap: the provider's default for an unknown model id is
      // small and thinking counts against it, which can truncate the JSON.
      maxOutputTokens: 8000,
    });
    rawText = result.text.trim();
  } catch (err) {
    // No model family in the text: this message can reach a log line an
    // operator reads, and the route treats any non-MacroThemesParseError throw
    // as raw vendor text — naming a vendor's model here only risks it leaking
    // onto a user surface (CLAUDE.md: never name a model id in user copy).
    if (err instanceof AIRefusalError) {
      throw new Error(`macro-themes generation refused`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`macro-themes generation failed: ${msg}`);
  }

  const replied = parseThemesJson(rawText);

  // The citation check. A theme that names no input, names one that was not
  // sent, quotes text that input does not contain, or reads the article the
  // opposite way to its stored sentiment never reaches the cache.
  const parsed: Array<{ theme: MacroThemeAi; citation: VerifiedCitation }> = [];
  for (const t of replied) {
    const verdict = verifyThemeCitation(t, sent);
    if (verdict.ok) {
      parsed.push({ theme: t, citation: verdict.citation });
    } else {
      console.warn(`[macro-themes] dropped theme "${t.name}" (scope=${opts.scope}): ${verdict.reason}`);
    }
  }
  const droppedThemes = replied.length - parsed.length;
  if (parsed.length === 0) {
    return {
      themes: [], sourceSummary: null, fromCache: false,
      generatedAt: new Date().toISOString(), underThreshold: false,
      droppedThemes, noneVerified: true,
    };
  }

  // Post-process: attach per-scope exposure bucket + top-3 contributors from
  // computeFactorAnalysis().tilts (per-factor weighted exposure across the 9
  // FACTOR_COLUMNS). Shipped 2026-05-11 — replaces the prior defensive
  // `(as any)?.tilts` cast that always degraded to "low" + empty contributors.
  const accountIds = resolveScope(db, opts.scope);
  const factorResult = computeFactorAnalysis(db, { accountIds });

  const tiltFor = (t: MacroThemeAi) =>
    factorResult.tilts.find((tilt) => tilt.factor === t.factor_label) ?? null;
  const ranks = rankThemeExposures(parsed.map((p) => tiltFor(p.theme)?.exposurePct));

  const themes: MacroTheme[] = parsed.map(({ theme: t, citation }, i) => {
    const factorTilt = tiltFor(t);
    const exposureWeight = factorTilt ? factorTilt.exposurePct / 100 : 0;
    // Cash equivalents leave BEFORE the cut to three, so the next holding
    // takes the slot. The tilt carries five names, so a list can run short
    // when several of them are cash.
    const top = factorTilt
      ? dropCashEquivalentContributors(db, factorTilt.topContributors)
          .slice(0, 3)
          .map((c) => ({ symbol: c.symbol, weight: c.weight }))
      : [];
    return {
      name: t.name,
      factor_label: t.factor_label,
      direction: t.direction,
      summary: t.summary,
      // Only the checked citation is stored, never the model's raw fields.
      ...citation,
      exposure_bucket: bucketExposure(exposureWeight),
      // No tilt for the factor → no figure (unknown is not 0%).
      ...(factorTilt && Number.isFinite(factorTilt.exposurePct)
        ? { exposure_pct: factorTilt.exposurePct }
        : {}),
      exposure_rank: ranks[i],
      top_contributors: top,
    };
  });

  // What was actually SENT, in the order sent, plus the size of the week it
  // was chosen from. (It used to list the ten most recent of each, whether or
  // not the prompt cut had let them through.)
  const sourceSummary = {
    articles: sent.articles.map((a) => ({ id: a.id, title: a.subject })),
    events: sent.events.map((e) => ({
      id: e.id, symbol: e.symbol, event_date: e.event_date, title: e.title, event_type: e.event_type,
    })),
    alerts: sent.alerts.map((a) => ({ id: a.id, symbol: a.symbol })),
    totals: {
      articles: blob.articles.length,
      events: blob.enrichedEvents.length,
      alerts: blob.alerts.length,
    },
    droppedThemes,
  };

  const modelUsed = resolveFeatureModel("analysisMacroThemes").modelId;
  upsertMacroThemes(db, {
    scope: opts.scope, weekOf: opts.weekOf,
    themesJson: JSON.stringify(themes),
    sourceSummary: JSON.stringify(sourceSummary),
    modelUsed,
  });

  return {
    themes, sourceSummary, fromCache: false, generatedAt: new Date().toISOString(),
    underThreshold: false, droppedThemes,
  };
}
