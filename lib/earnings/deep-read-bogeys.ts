/**
 * Deep read of an armed name's previews (2026-10-20, owner request): when the
 * desk arms an earnings event, a frontier-tier model reads EVERY newsletter
 * from the days before the print that mentions the company, in ONE call, and
 * writes one reconciled bogey sheet.
 *
 * Why a second pass on top of the per-article scan
 * (lib/earnings/extract-newsletter-bogeys.ts):
 *   - The per-article scan only reads an article whose text carries the
 *     TICKER. Plenty of previews write "Micron" and never "MU". This pass also
 *     matches the company's name (`companyNameAliases`).
 *   - The per-article scan sees one issue at a time, so it cannot tell a
 *     stale figure from a revised one, or one author's whisper from another's
 *     Street number. This pass sees all of them, newest first, and is told to
 *     prefer the latest issue and to name every disagreement.
 *   - It runs on the frontier tier (`armedBogeyDeepRead`), not the workhorse.
 *
 * What it writes: ONE `earnings_bogeys` row per event, source `newsletter`,
 * label `DEEP_READ_BOGEY_LABEL`, fully overwritten by each re-run (the latest
 * reading replaces the previous one; an all-empty answer writes nothing, per
 * `upsertBogey`). `compileContracts` ranks it above per-article newsletter
 * rows and the vendor row, below the desk's own manual and uploaded sheets
 * (`BOGEY_SOURCE_RANK_SQL`, lib/print-watch/contracts.ts).
 *
 * Only articles received BEFORE the print's slot floor are read (07:00 ET for
 * a before-open or unknown slot, 16:00 ET for an after-close one), so a recap
 * that lands after the print can never turn into a bogey.
 */
import type Database from "better-sqlite3";
import { generateTextForFeature } from "@/lib/ai/generate";
import { resolveFeatureModel } from "@/lib/ai/models";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { coercePercent, parseLargeUSD } from "@/lib/format";
import { DEEP_READ_BOGEY_LABEL } from "@/lib/earnings/bogey-claim";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { AMC_FLOOR_ET, BMO_FLOOR_ET } from "@/lib/earnings/pre-print-floor";
import {
  AMBIGUOUS_TICKER_WORDS,
  isSymbolMentioned,
  newsletterIssueLabel,
} from "@/lib/earnings/extract-newsletter-bogeys";
import {
  WATCH_METRICS_INSTRUCTIONS,
  existingWatchLinesForEvent,
  parseWatchMetrics,
} from "@/lib/earnings/watch-metrics";
import { saveBogeyWithRecompile } from "@/lib/mutations/earnings-bogeys";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import type { ExtraMetricSpec } from "@/lib/print-watch/extra-metrics";
import {
  fetchNewsletterImages,
  newsletterImageUrls,
  MAX_NEWSLETTER_IMAGES,
  type FetchNewsletterImagesFn,
} from "@/lib/earnings/newsletter-images";

/** Bump when the prompt or parser changes enough that a stored reading should
 *  be redone; it is part of the prepare step's fingerprint. */
export const DEEP_READ_VERSION = 1;
/** "The week before", with a few days' margin for a long weekend. */
export const DEEP_READ_WINDOW_DAYS = 10;
/** Context either side of each mention. */
const EXCERPT_RADIUS = 2_500;
/** Per article, after merging overlapping windows. */
const MAX_ARTICLE_EXCERPT_CHARS = 12_000;
/** Whole prompt's article text (~20k tokens); the oldest articles drop first. */
const MAX_TOTAL_EXCERPT_CHARS = 80_000;
const MAX_ARTICLES = 25;

interface EventRow {
  id: number;
  symbol: string | null;
  event_date: string;
  event_time: string | null;
  raw_json: string | null;
}

export interface DeepReadArticle {
  id: number;
  source_name: string;
  subject: string;
  received_at: string;
  raw_text: string;
}

/** Corporate suffixes and share-class words that are not how prose names a company. */
const NAME_SUFFIXES = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited",
  "plc", "holdings", "holding", "group", "sa", "nv", "ag", "se", "llc", "lp",
  "class", "a", "b", "c", "common", "stock", "shares", "ordinary", "adr", "ads",
  "sponsored", "the", "new",
]);

/** First words too common to stand alone as a company's name in prose. */
const GENERIC_FIRST_WORDS = new Set([
  "american", "united", "first", "national", "international", "global", "general",
  "digital", "advanced", "applied", "royal", "southern", "northern", "western",
  "eastern", "pacific", "atlantic", "energy", "health", "home", "data", "power",
  "capital", "financial", "bank", "select", "technology", "technologies", "systems",
  "target", "block", "snap", "gap", "best", "match", "service", "public", "real",
  "invesco", "ishares", "vanguard", "spdr",
]);

/**
 * The ways prose names the company: the cleaned full name, and its first word
 * when that word is distinctive enough to stand alone ("Micron Technology,
 * Inc." -> ["Micron Technology", "Micron"]). Matched case-sensitively on word
 * boundaries; a stray hit costs prompt tokens only, because the model is told
 * to use nothing that is not about this company's print.
 */
export function companyNameAliases(name: string | null | undefined): string[] {
  if (!name) return [];
  const words = name
    .replace(/[.,()/]/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "");
  while (words.length > 0 && NAME_SUFFIXES.has(words[words.length - 1].toLowerCase())) words.pop();
  while (words.length > 0 && words[0].toLowerCase() === "the") words.shift();
  if (words.length === 0) return [];
  const out: string[] = [];
  const full = words.join(" ");
  if (full.length >= 4) out.push(full);
  const first = words[0];
  if (
    words.length > 1 &&
    first.length >= 4 &&
    /^[A-Za-z][A-Za-z&-]*$/.test(first) &&
    !GENERIC_FIRST_WORDS.has(first.toLowerCase())
  ) {
    out.push(first);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameMentionRegex(alias: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${escapeRegExp(alias)}(?![A-Za-z])`, "g");
}

/** Every character offset where the text names the company, by ticker or name. */
function mentionOffsets(text: string, symbols: string[], aliases: string[]): number[] {
  const offsets: number[] = [];
  const upper = text.toUpperCase();
  for (const sym of symbols) {
    if (!isSymbolMentioned(text, sym)) continue;
    const s = escapeRegExp(sym.toUpperCase());
    // A ticker that is also a word ("NOW", "ON") only counts as a cashtag or
    // before a finance cue, the per-article scan's own rule; every bare "now"
    // would otherwise pull a window of unrelated prose into the prompt.
    const re = AMBIGUOUS_TICKER_WORDS.has(sym.toUpperCase())
      ? new RegExp(`\\$${s}\\b|\\b${s}(?=\\s*(?:EARNINGS|REPORTS?|PRINTS?|EPS|Q[1-4])\\b)`, "g")
      : new RegExp(`\\$?\\b${s}\\b`, "g");
    for (const m of upper.matchAll(re)) offsets.push(m.index ?? 0);
  }
  for (const alias of aliases) {
    for (const m of text.matchAll(nameMentionRegex(alias))) offsets.push(m.index ?? 0);
  }
  return offsets.sort((a, b) => a - b);
}

/** Merged windows around the mentions, joined with an elision marker. */
export function mentionExcerpt(text: string, offsets: number[]): string {
  if (offsets.length === 0) return "";
  const spans: Array<[number, number]> = [];
  for (const at of offsets) {
    const start = Math.max(0, at - EXCERPT_RADIUS);
    const end = Math.min(text.length, at + EXCERPT_RADIUS);
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  let out = "";
  for (const [s, e] of spans) {
    const piece = (s > 0 ? "[…] " : "") + text.slice(s, e) + (e < text.length ? " […]" : "");
    if (out.length + piece.length > MAX_ARTICLE_EXCERPT_CHARS) {
      out += piece.slice(0, Math.max(0, MAX_ARTICLE_EXCERPT_CHARS - out.length));
      break;
    }
    out += (out ? "\n" : "") + piece;
  }
  return out;
}

export interface DeepReadInputs {
  event: { id: number; symbol: string; event_date: string; slot: "bmo" | "amc" | null };
  companyName: string | null;
  /** Articles before the slot floor that mention the company, newest first, with
   *  excerpts and the content images the read may fetch ([] = text only). */
  articles: Array<DeepReadArticle & { excerpt: string; label: string; imageUrls: string[] }>;
  /** ISO UTC instant; only articles received before it are read. */
  cutoffIso: string;
}

/** Stored `received_at` is space-separated UTC; compare as instants. */
function receivedMs(receivedAt: string): number {
  const raw = receivedAt.trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  return Date.parse(raw.replace(" ", "T") + (hasZone ? "" : "Z"));
}

/**
 * Everything the deep read reads, from the database. Pure aside from reads;
 * the prepare step fingerprints the article ids it returns, so a new preview
 * before the print re-runs the read and a recap after it never does.
 */
export function gatherDeepReadInputs(db: Database.Database, eventId: number): DeepReadInputs | null {
  const ev = db
    .prepare(`SELECT id, symbol, event_date, event_time, raw_json FROM calendar_events WHERE id = ?`)
    .get(eventId) as EventRow | undefined;
  if (!ev?.symbol) return null;

  const slot = deriveEarningsSlot({ event_time: ev.event_time, raw_json: ev.raw_json });
  const floor = slot === "amc" ? AMC_FLOOR_ET : BMO_FLOOR_ET;
  const cutoff = composeReleaseInstant(ev.event_date, floor);
  if (!cutoff) return null;
  const cutoffMs = cutoff.getTime();

  const family = issuerSiblings(ev.symbol).map((s) => s.toUpperCase());
  const marks = family.map(() => "?").join(", ");
  const nameRow = db
    .prepare(
      `SELECT name FROM securities
        WHERE UPPER(symbol) IN (${marks}) AND name IS NOT NULL AND TRIM(name) <> ''
        ORDER BY id ASC LIMIT 1`,
    )
    .get(...family) as { name: string } | undefined;
  const companyName = nameRow?.name ?? null;
  const aliases = companyNameAliases(companyName);

  // Two instants, datetime() on both sides (stored received_at is
  // space-separated UTC); the exact bounds are checked again in JS below.
  const fromMs = cutoffMs - DEEP_READ_WINDOW_DAYS * 86_400_000;
  const sqlInstant = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const rows = db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text,
              CASE WHEN instr(COALESCE(a.raw_html, ''), '<img') > 0 THEN 1 ELSE 0 END AS has_img
         FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id
        WHERE a.raw_text IS NOT NULL AND length(a.raw_text) > 200
          AND datetime(a.received_at) >= datetime(?) AND datetime(a.received_at) < datetime(?)
        ORDER BY a.received_at DESC, a.id DESC`,
    )
    .all(sqlInstant(fromMs), sqlInstant(cutoffMs)) as Array<DeepReadArticle & { has_img: number }>;
  // The HTML is read only for an article that names the company and has an
  // <img> at all, and only for its image URLs (this runs on every fingerprint).
  const htmlStmt = db.prepare(`SELECT raw_html FROM research_articles WHERE id = ?`);

  const articles: DeepReadInputs["articles"] = [];
  let total = 0;
  for (const { has_img, ...a } of rows) {
    const at = receivedMs(a.received_at);
    if (!Number.isFinite(at) || at >= cutoffMs || at < fromMs) continue;
    const text = `${a.subject}\n${a.raw_text}`;
    const excerpt = mentionExcerpt(text, mentionOffsets(text, family, aliases));
    if (!excerpt) continue;
    if (articles.length >= MAX_ARTICLES || total + excerpt.length > MAX_TOTAL_EXCERPT_CHARS) break;
    total += excerpt.length;
    const imageUrls = has_img
      ? newsletterImageUrls((htmlStmt.get(a.id) as { raw_html: string | null } | undefined)?.raw_html ?? null)
      : [];
    articles.push({ ...a, excerpt, label: newsletterIssueLabel(a), imageUrls });
  }

  return {
    event: { id: ev.id, symbol: ev.symbol.toUpperCase(), event_date: ev.event_date, slot },
    companyName,
    articles,
    cutoffIso: cutoff.toISOString(),
  };
}

/** One attached image and the article it came from, in attachment order. */
export interface DeepReadImageRef {
  articleId: number;
  label: string;
}

/**
 * Which images the read attaches: newest article first, in document order
 * within an article, at most MAX_NEWSLETTER_IMAGES in all.
 */
export function selectDeepReadImages(inputs: DeepReadInputs): Array<DeepReadImageRef & { url: string }> {
  const out: Array<DeepReadImageRef & { url: string }> = [];
  for (const a of inputs.articles) {
    for (const url of a.imageUrls) {
      if (out.length >= MAX_NEWSLETTER_IMAGES) return out;
      out.push({ articleId: a.id, label: a.label, url });
    }
  }
  return out;
}

export function buildDeepReadPrompt(
  inputs: DeepReadInputs,
  existingLines: string[],
  attached: DeepReadImageRef[] = [],
): string {
  const { event, companyName } = inputs;
  const who = companyName ? `${event.symbol} (${companyName})` : event.symbol;
  const when = event.slot === "amc" ? "after the close" : event.slot === "bmo" ? "before the open" : "time not known";
  const blocks = inputs.articles.map(
    (a) =>
      `=== ARTICLE ${a.id} · ${a.label} · received ${a.received_at} UTC · subject: ${a.subject} ===\n${a.excerpt}`,
  );
  return [
    `You are building the bogey sheet a trader will hold ${who} against when it reports on ${event.event_date} (${when}).`,
    `Below are excerpts from every newsletter received in the ${DEEP_READ_WINDOW_DAYS} days before the print that names the company, newest first. Read all of them together and produce ONE reconciled sheet for THIS upcoming print.`,
    ``,
    `RULES:`,
    `- Only figures for ${event.symbol}'s upcoming print. Ignore last quarter's results, peers, read-throughs, price targets, and anything about another company in the same paragraph.`,
    `- Keep the three kinds apart: Street / sell-side CONSENSUS; buyside / author WHISPER (the number traders want); COMPANY GUIDANCE (what management guided). Guidance is never a consensus or whisper value; summarize it in guidance_notes.`,
    `- When issues disagree, use the most recent issue's figure, and say who disagreed in "conflicts".`,
    `- Never compute, average, or convert between figures. Report only numbers an article states. null when none does.`,
    `- Numbers are RAW: revenue in dollars (40200000000, not "$40.2B"); EPS per share; expected_move_pct as an absolute percent ("±6%" -> 6).`,
    `- Cite the ARTICLE ids each figure came from in "sources".`,
    ``,
    WATCH_METRICS_INSTRUCTIONS,
    existingLines.length > 0 ? `Lines already on this sheet: ${existingLines.join("; ")}` : ``,
    ``,
    `Return a JSON array with exactly ONE object and nothing else:`,
    `[{`,
    `  "eps_consensus": number|null, "eps_whisper": number|null,`,
    `  "revenue_consensus": number|null, "revenue_whisper": number|null,`,
    `  "expected_move_pct": number|null,`,
    `  "guidance_notes": string|null,   // <300 chars`,
    `  "notes": string|null,            // what the debate is, <200 chars`,
    `  "watch_metrics": array,`,
    `  "sources": [{"figure": string, "article_id": number}],`,
    `  "conflicts": [string]            // one short line per disagreement, naming both sources`,
    `}]`,
    `If no article gives anything about this print, return [{}].`,
    ``,
    ...(attached.length > 0
      ? [
          `IMAGES: ${attached.length} image(s) are attached after this text, in this order: ${attached
            .map((r, i) => `image ${i + 1} is from ARTICLE ${r.articleId} (${r.label})`)
            .join("; ")}. They are part of those articles: many authors post their figures only as screenshots. One image often holds several companies; read only the block headed by ${event.symbol}${companyName ? ` or ${companyName}` : ""}, never a neighbouring company's numbers. Cite a figure read from an image with that image's ARTICLE id.`,
          ``,
        ]
      : []),
    ...blocks,
  ].join("\n");
}

export interface DeepReadResult {
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus: number | null;
  revenue_whisper: number | null;
  expected_move_pct: number | null;
  guidance_notes: string | null;
  notes: string | null;
  watch_metrics: ExtraMetricSpec[];
  /** Only ids from the articles actually given; anything else is dropped. */
  sourceArticleIds: number[];
  conflicts: string[];
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parseLargeUSD(v);
  return null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, max);
}

/** Model text -> a validated result; null when it is not the one-object array. */
export function parseDeepReadResponse(raw: string, allowedArticleIds: ReadonlySet<number>): DeepReadResult | null {
  const jsonText = extractJsonArray(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      parsed = JSON.parse(jsonText.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      return null;
    }
  }
  const obj = Array.isArray(parsed) ? parsed[0] : null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const ids = Array.isArray(o.sources)
    ? o.sources
        .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).article_id : null))
        .filter((id): id is number => typeof id === "number" && allowedArticleIds.has(id))
    : [];
  const conflicts = Array.isArray(o.conflicts)
    ? o.conflicts.map((c) => text(c, 160)).filter((c): c is string => c !== null).slice(0, 3)
    : [];
  return {
    eps_consensus: num(o.eps_consensus),
    eps_whisper: num(o.eps_whisper),
    revenue_consensus: num(o.revenue_consensus),
    revenue_whisper: num(o.revenue_whisper),
    expected_move_pct: coercePercent(o.expected_move_pct),
    guidance_notes: text(o.guidance_notes, 300),
    notes: text(o.notes, 200),
    watch_metrics: parseWatchMetrics(o.watch_metrics),
    sourceArticleIds: [...new Set(ids)],
    conflicts,
  };
}

/** The stored notes: the model's line, then who disagreed, then the sources. */
function composeNotes(result: DeepReadResult, labelById: Map<number, string>): string | null {
  const parts: string[] = [];
  if (result.notes) parts.push(result.notes);
  if (result.conflicts.length > 0) parts.push(`Disagreements: ${result.conflicts.join("; ")}`);
  const labels = [...new Set(result.sourceArticleIds.map((id) => labelById.get(id)).filter((l): l is string => !!l))];
  if (labels.length > 0) parts.push(`From: ${labels.join(", ")}`);
  const out = parts.join(" · ");
  return out === "" ? null : out.slice(0, 500);
}

export interface DeepReadOutcome {
  articlesRead: number;
  stored: boolean;
  modelId: string | null;
  /** Images attached to the call, and images that could not be fetched (the
   *  read went ahead without those). */
  imagesRead?: number;
  imagesUnreadable?: number;
}

/**
 * Run the deep read for one event and store the reconciled row. Throws when
 * the model call fails (the prepare step books an attempt); an answer with
 * nothing in it stores nothing.
 */
export async function runDeepRead(
  db: Database.Database,
  eventId: number,
  opts: { signal?: AbortSignal; fetchImages?: FetchNewsletterImagesFn } = {},
): Promise<DeepReadOutcome> {
  const inputs = gatherDeepReadInputs(db, eventId);
  if (!inputs || inputs.articles.length === 0) {
    return { articlesRead: 0, stored: false, modelId: null };
  }

  // Images degrade, never fail: a picture that cannot be fetched is left out
  // and counted, and the read goes ahead on the rest.
  const wanted = selectDeepReadImages(inputs);
  const attached: Array<DeepReadImageRef & { mediaType: string; data: Uint8Array }> = [];
  if (wanted.length > 0) {
    try {
      const fetched = await (opts.fetchImages ?? fetchNewsletterImages)(
        wanted.map((w) => w.url),
        { signal: opts.signal },
      );
      const byUrl = new Map((Array.isArray(fetched?.images) ? fetched.images : []).map((img) => [img.url, img]));
      for (const w of wanted) {
        const img = byUrl.get(w.url);
        if (img) attached.push({ articleId: w.articleId, label: w.label, mediaType: img.mediaType, data: img.data });
      }
    } catch (err) {
      console.warn(`[deep-read] event ${eventId}: image fetch failed; reading text only:`, err instanceof Error ? err.message : err);
    }
  }

  const prompt = buildDeepReadPrompt(inputs, existingWatchLinesForEvent(db, eventId), attached);
  const { text: responseText } = await generateTextForFeature("armedBogeyDeepRead", {
    maxOutputTokens: 8_192,
    ...(attached.length > 0
      ? {
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: prompt },
                ...attached.map((a) => ({ type: "image" as const, image: a.data, mediaType: a.mediaType })),
              ],
            },
          ],
        }
      : { prompt }),
    abortSignal: opts.signal,
  });
  const { modelId } = resolveFeatureModel("armedBogeyDeepRead");

  const allowed = new Set(inputs.articles.map((a) => a.id));
  const result = parseDeepReadResponse(responseText, allowed);
  if (!result) throw new Error("deep read returned no readable sheet");

  const labelById = new Map(inputs.articles.map((a) => [a.id, a.label]));
  // Newest cited article, for provenance; the articles are newest first.
  const newestCited = inputs.articles.find((a) => result.sourceArticleIds.includes(a.id))?.id ?? null;
  const { result: upsert } = saveBogeyWithRecompile(db, {
    event_id: eventId,
    source: "newsletter",
    source_label: DEEP_READ_BOGEY_LABEL,
    research_article_id: newestCited,
    eps_consensus: result.eps_consensus,
    eps_whisper: result.eps_whisper,
    revenue_consensus_usd: result.revenue_consensus,
    revenue_whisper_usd: result.revenue_whisper,
    expected_move_pct: result.expected_move_pct,
    guidance_notes: result.guidance_notes,
    notes: composeNotes(result, labelById),
    extra_metrics_json: result.watch_metrics.length > 0 ? JSON.stringify(result.watch_metrics) : null,
    ai_extraction_model: modelId,
  });
  return {
    articlesRead: inputs.articles.length,
    stored: !upsert.skipped,
    modelId,
    // Only when the read involved images, so a text-only outcome keeps its shape.
    ...(wanted.length > 0 ? { imagesRead: attached.length, imagesUnreadable: wanted.length - attached.length } : {}),
  };
}
