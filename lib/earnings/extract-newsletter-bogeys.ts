/**
 * Auto-extract earnings bogeys (EPS/revenue consensus + whisper numbers)
 * for upcoming reporters from newsletter text.
 *
 * Sibling of lib/alerts/extract-newsletter-levels.ts (price levels) and
 * lib/earnings/extract-bogeys.ts (multi-symbol PDF bogeys) — same
 * mark-scanned discipline as the former, same ExtractedBogey field
 * vocabulary + issuer-family fan-out as the latter.
 *
 * Pipeline: getUnscannedArticles → per-article symbol pre-filter (only
 * call Claude when the article's text actually mentions one of the
 * upcoming held/watchlist reporters) → Claude call → extractJsonArray +
 * parseLargeUSD parsing → upsertBogey (source='newsletter') → mark
 * scanned.
 */

import type Database from "better-sqlite3";
import { generateTextForFeature } from "@/lib/ai/generate";
import { resolveFeatureModel } from "@/lib/ai/models";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { coercePercent, parseLargeUSD } from "@/lib/format";
import { coveredForEvents } from "@/lib/queries/briefing-symbols";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import type { ExtraMetricSpec } from "@/lib/print-watch/extra-metrics";
import {
  WATCH_METRICS_INSTRUCTIONS,
  existingWatchLinesForEvent,
  mergeWatchMetricsJson,
  parseWatchMetrics,
} from "@/lib/earnings/watch-metrics";
import {
  fetchNewsletterImages,
  isRequestRejectedAsSent,
  newsletterImageUrls,
  type FetchNewsletterImagesFn,
  type NewsletterImage,
} from "@/lib/earnings/newsletter-images";

// Max chars per article sent to Claude. Bogey mentions are almost always in
// prose context near the top of a preview newsletter, not buried deep in a
// long weekly — matches the newsletterLevelExtraction precedent.
const MAX_ARTICLE_CHARS = 30_000;

// Max articles to process per extraction run (safety cap on cost + runtime).
const DEFAULT_BATCH_SIZE = 10;

// Claude concurrency cap.
const CONCURRENCY = 3;

// Upcoming-reporter window: [today, today+14d].
const WINDOW_DAYS_AHEAD = 14;

export interface ArticleInput {
  id: number;
  source_name: string;
  subject: string;
  received_at: string;
  raw_text: string;
  /** Stored sanitized HTML. Read only for its content images
   *  (lib/earnings/newsletter-images.ts); absent or null = text only. */
  raw_html?: string | null;
}

/** Seams for the image half of the scan. Production passes nothing. */
export interface NewsletterScanDeps {
  fetchImages?: FetchNewsletterImagesFn;
  signal?: AbortSignal;
}

export interface UpcomingReporter {
  symbol: string;
  event_id: number;
  event_date: string;
  /** Extra metric lines already on this event's sheet (prompt text from
   *  `existingWatchLinesForEvent`), so a later issue reuses their labels. */
  existing_lines?: string[];
}

export interface ExtractedBogey {
  symbol: string;
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus: number | null;
  revenue_whisper: number | null;
  expected_move_pct: number | null;
  /** Forward-looking company/author guidance prose — never a bogey number. */
  guidance_notes: string | null;
  notes: string | null;
  /** The company-specific figures the print is judged on, as sheet lines
   *  (lib/earnings/watch-metrics.ts). [] when the author names none. */
  watch_metrics: ExtraMetricSpec[];
}

/**
 * Build the Claude extraction prompt. Pure function — unit-testable.
 * Only the reporters passed in (already filtered to symbols mentioned in
 * this specific article) are listed, so the model can't wander onto an
 * unrelated ticker.
 */
export function buildExtractionPrompt(
  article: ArticleInput,
  reporters: UpcomingReporter[],
  opts: { imageCount?: number } = {},
): string {
  const imageCount = opts.imageCount ?? 0;
  const reportersList = reporters
    .map((r) => {
      const head = `${r.symbol} (reports ${r.event_date})`;
      const lines = r.existing_lines ?? [];
      return lines.length > 0 ? `${head}; lines already on its sheet: ${lines.join("; ")}` : head;
    })
    .join("\n");

  const truncatedText =
    article.raw_text.length > MAX_ARTICLE_CHARS
      ? article.raw_text.slice(0, MAX_ARTICLE_CHARS) + "\n[truncated]"
      : article.raw_text;

  return [
    `Extract earnings bogeys (consensus + whisper numbers) this newsletter author gives for the following UPCOMING reporters ONLY. Ignore every other ticker mentioned.`,
    ``,
    `UPCOMING REPORTERS (only extract for these):`,
    reportersList || "(none)",
    ``,
    `NEWSLETTER:`,
    `Source: ${article.source_name}`,
    `Subject: ${article.subject}`,
    `Received: ${article.received_at}`,
    ``,
    `CONTENT:`,
    truncatedText,
    ``,
    ...(imageCount > 0 ? [imagesInstruction(imageCount), ``] : []),
    `INSTRUCTIONS:`,
    `Return a JSON array (and nothing else — no markdown fence, no preamble). Each element captures the bogeys the author gives for ONE of the listed upcoming reporters.`,
    ``,
    `Schema per element:`,
    `{`,
    `  "symbol": string,                    // must match one of the listed reporters (or a same-issuer share class)`,
    `  "eps_consensus": number | null,`,
    `  "eps_whisper": number | null,         // above/below-consensus number traders are positioning for`,
    `  "revenue_consensus": number | null,   // RAW dollars, not abbreviated (e.g. 40200000000, not "$40.2B")`,
    `  "revenue_whisper": number | null,     // RAW dollars`,
    `  "expected_move_pct": number | null,   // expected/implied earnings move the author states, as an absolute percent ("±6%" -> 6)`,
    `  "guidance_notes": string | null,      // forward-looking guidance as SHORT text: company guides, next-quarter guide bogeys, and a one-line summary of the watch metrics. Never a bogey number field. <300 chars`,
    `  "notes": string | null,               // brief paraphrase of the author's reasoning, <200 chars`,
    `  "watch_metrics": array                // the company-specific figures this print is judged on; see WATCH METRICS`,
    `}`,
    ``,
    WATCH_METRICS_INSTRUCTIONS,
    ``,
    `KNOWN FORMATS:`,
    `Some authors (e.g. TMT Breakout's "Buyside Bogeys") post a compact per-ticker block:`,
    ``,
    `  CRWD — 4:10p / 5:00p`,
    `  FQ2 NN ARR: ~$305M+ vs. guide of $285M`,
    `  FQ3 ARR: slightly ahead vs. Street @ $6.122B (NN ARR $331M)`,
    `  FY'27 Rev Guide: 23% vs street at 21-22%`,
    `  NVDA — 4:15p / 5:00p`,
    `  FQ2 Revenue: ~$95B vs. guide of $91B and Street @ $92.4B`,
    `  FQ3 Revenue Guide: $108.5B+ vs. Street @ $105B`,
    ``,
    `Read that shape as follows:`,
    `- The LEADING figure on a line is the buyside/whisper number — "FQ2 Revenue: ~$95B" means revenue_whisper = 95000000000.`,
    `- "Street @" / "street at" / "consensus" is the SELL-SIDE consensus — "Street @ $92.4B" means revenue_consensus = 92400000000.`,
    `- "guide of" / "prior guide" / "the guide" is COMPANY guidance, never a bogey number. Summarize it in guidance_notes.`,
    `- ONLY the CURRENT-quarter Revenue and EPS lines map to revenue_*/eps_*. The current quarter is the one that is about to be reported.`,
    `- NEXT-quarter total revenue / EPS guide lines ("FQ3 Revenue Guide") go into guidance_notes as short text — they are forward-looking, not this quarter's print. Metric lines (ARR, NN ARR, cRPO, RPO, GM, gross/operating margin) and full-year guides ("FY'27 Rev Guide") go into watch_metrics with their numbers, and may also be summarized in guidance_notes. Other commentary goes in notes.`,
    `- A header like "4:15p / 5:00p" is the print time / call time. Ignore it — it is not a number to extract.`,
    `- A block like this usually carries SEVERAL numbers per ticker. Capture every one of them: the whisper, the consensus, each metric line in watch_metrics, and the next-quarter guide in guidance_notes.`,
    ``,
    `RULES:`,
    `- Only extract for the listed upcoming reporters.`,
    `- Use null (not 0) for any field the author doesn't give a number for.`,
    `- Numbers are RAW dollars: convert "$40.2B" to 40200000000.`,
    `- If the article gives no numbers and flags no watch metric for any listed reporter, return [].`,
    `- Return ONLY the JSON array. No other text.`,
  ].join("\n");
}

/**
 * The prompt paragraph that goes with attached newsletter images. Exported for
 * the tests. One screenshot often holds several companies (a day's reporters
 * side by side), so the model is told to read only the listed reporters' block.
 */
export function imagesInstruction(imageCount: number): string {
  return [
    `IMAGES: ${imageCount} image(s) from this newsletter are attached after this text, in the order they appear in it. They are part of the CONTENT: many authors post their figures only as screenshots, so read them as carefully as the text.`,
    `- One image often holds blocks for SEVERAL companies. Find the block headed by a listed reporter's ticker or company name and read only that block. Never take a number from another company's block, even when it sits right beside it.`,
    `- A listed reporter that appears in no image and no text gets no element.`,
  ].join("\n");
}

/**
 * Parse Claude's response into validated bogey objects. Tolerant of
 * conversational preamble/trailer via extractJsonArray, and of stringified
 * abbreviated numbers ("$40.2B") via parseLargeUSD. Returns [] on any parse
 * failure — a garbled response is treated as "no bogeys found", not a
 * retry-worthy failure (only the AI call itself gates the scanned marker).
 */
export function parseExtractionResponse(raw: string): ExtractedBogey[] {
  const jsonText = extractJsonArray(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedBogey[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const symbol = typeof obj.symbol === "string" ? obj.symbol.trim().toUpperCase() : "";
    if (!symbol) continue;

    out.push({
      symbol,
      eps_consensus: coerceNumber(obj.eps_consensus),
      eps_whisper: coerceNumber(obj.eps_whisper),
      revenue_consensus: coerceNumber(obj.revenue_consensus),
      revenue_whisper: coerceNumber(obj.revenue_whisper),
      expected_move_pct: coercePercent(obj.expected_move_pct),
      guidance_notes: normalizeStringField(obj.guidance_notes),
      notes: normalizeStringField(obj.notes),
      watch_metrics: parseWatchMetrics(obj.watch_metrics),
    });
  }
  return out;
}

/**
 * Trim + collapse a blank/whitespace-only string to null. Feeds
 * upsertBogey's preserveExisting has-content check downstream — a model
 * response of `notes: ""` must read as "no content", not as a value that
 * advances provenance while COALESCE-preserving the OLD notes forever
 * (2026-08-28 fix; upsertBogey normalizes defensively too).
 */
function normalizeStringField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed.slice(0, 500);
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" || typeof v === "string" || v == null) {
    return parseLargeUSD(v as string | number | null | undefined);
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tickers that are also ordinary English words — a bare `\bSYMBOL\b` test on
// these matches ordinary prose constantly, regardless of how short (or long)
// the symbol is. Gating on LENGTH instead of this stoplist is wrong: it
// silently gates real 3-char tickers too (TSM, AMD, GS, ...), leaving the
// feature permanently silent for major holdings whose newsletter mentions
// never carry a $cashtag or a finance-cue word. Curated to real collisions
// only — every one of these is also an actual NYSE/Nasdaq ticker.
export const AMBIGUOUS_TICKER_WORDS = new Set([
  "A", "AIR", "ALL", "AM", "AN", "ANY", "ARE", "AT", "BE", "BIG", "BY",
  "CAN", "CAR", "COST", "DAY", "DO", "EAT", "FOR", "GO", "GOOD", "HAS",
  "HE", "IT", "KEY", "LOVE", "LOW", "MAIN", "MAN", "MET", "NEXT", "NICE",
  "NOW", "ON", "ONE", "OR", "OUT", "PLAY", "PRO", "REAL", "RUN", "SEE",
  "SO", "TAP", "TELL", "TWO", "UP", "WELL", "WIN", "YOU",
]);

// Finance-context cues that, immediately following an ambiguous-word symbol,
// make the mention unambiguous even without a cashtag ("IT earnings", "IT
// reports").
const AMBIGUOUS_TICKER_CONTEXT_CUES = "EARNINGS|REPORTS?|PRINTS?|EPS|Q[1-4]";

/**
 * Pure symbol-mention test. Guards against common-English-word tickers (IT,
 * ALL, ON, NOW, SO, KEY, ...) via an explicit stoplist (`AMBIGUOUS_TICKER_WORDS`),
 * NOT symbol length: length-gating every symbol <= 3 chars silently blocked
 * real 3-char tickers (TSM, AMD, GS, IBM, CAT, ...) from ever matching in
 * ordinary prose ("TSM beat on both lines"), leaving the feature permanently
 * silent for exactly the major holdings it exists for.
 *
 * For a symbol IN the stoplist, require either a `$SYMBOL` cashtag or the
 * symbol immediately followed by a finance-context cue (earnings/reports/
 * prints/EPS/Qn). Every other symbol — regardless of length — uses a plain
 * case-sensitive-in-uppercase-text word-boundary test.
 */
export function isSymbolMentioned(text: string, symbol: string): boolean {
  const upperSymbol = symbol.toUpperCase();
  const escaped = escapeRegExp(upperSymbol);
  const upperText = text.toUpperCase();

  if (!AMBIGUOUS_TICKER_WORDS.has(upperSymbol)) {
    return new RegExp(`\\b${escaped}\\b`).test(upperText);
  }

  const cashtagRe = new RegExp(`\\$${escaped}\\b`);
  const contextRe = new RegExp(
    `\\b${escaped}(?=\\s*(?:${AMBIGUOUS_TICKER_CONTEXT_CUES})\\b)`
  );
  return cashtagRe.test(upperText) || contextRe.test(upperText);
}

/**
 * Fetch upcoming earnings reporters in [today, today+14d] scoped to
 * covered events only (coveredForEvents: held/watchlist family OR the
 * event itself is armed — spec §4.1). Excludes superseded calendar_events
 * rows.
 */
function getUpcomingReporters(
  db: Database.Database,
  opts: { today?: string } = {},
): UpcomingReporter[] {
  const today = opts.today ?? todayET();
  const endDate = addDays(today, WINDOW_DAYS_AHEAD);

  const rows = db
    .prepare(
      `SELECT id AS event_id, symbol, event_date
       FROM calendar_events
       WHERE event_type = 'earnings'
         AND symbol IS NOT NULL
         AND event_date >= ? AND event_date <= ?
         AND COALESCE(superseded, 0) = 0`
    )
    .all(today, endDate) as { event_id: number; symbol: string; event_date: string }[];

  if (rows.length === 0) return [];

  const covered = coveredForEvents(db, rows.map((r) => ({ symbol: r.symbol, eventId: r.event_id })));

  return rows
    .filter((r) => covered.has(r.event_id))
    .map((r) => ({
      symbol: r.symbol.toUpperCase(),
      event_id: r.event_id,
      event_date: r.event_date,
    }));
}

/** Test seam — the function stays private to the module's callers. */
export const __getUpcomingReportersForTests = getUpcomingReporters;

/**
 * Per-article symbol pre-filter: only the reporters actually mentioned in
 * this article's text (issuer-family aware, so a GOOGL mention matches a
 * GOOG reporter row) get passed to the prompt. An article that mentions
 * none of the tracked reporters skips the AI call entirely.
 */
function filterReportersMentionedInArticle(
  article: ArticleInput,
  reporters: UpcomingReporter[]
): UpcomingReporter[] {
  return reporters.filter((r) =>
    issuerSiblings(r.symbol).some((sym) => isSymbolMentioned(article.raw_text, sym))
  );
}

function getUnscannedArticles(
  db: Database.Database,
  opts: { sinceDays?: number; batchSize?: number }
): ArticleInput[] {
  const sinceDays = opts.sinceDays ?? 30;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  return db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text, a.raw_html
       FROM research_articles a
       JOIN research_sources rs ON rs.id = a.source_id
       WHERE a.bogeys_scanned_at IS NULL
         AND datetime(a.received_at) >= datetime('now', '-${sinceDays} days')
         AND a.raw_text IS NOT NULL AND length(a.raw_text) > 200
       ORDER BY a.received_at DESC
       LIMIT ?`
    )
    .all(batchSize) as ArticleInput[];
}

function markArticleScanned(db: Database.Database, articleId: number): void {
  db.prepare(
    "UPDATE research_articles SET bogeys_scanned_at = datetime('now') WHERE id = ?"
  ).run(articleId);
}

/** Extractor identity stamped on every `earnings_bogey_scans` ledger row. Bump
 *  it when the prompt/parser changes materially enough that an already-scanned
 *  (event, article) pair deserves a fresh pass — the ledger PK carries it, so a
 *  bump re-opens every pair without touching the rows the old version wrote.
 *
 *  2 (2026-10-20): watch metrics. An armed event's rescan re-reads the previews
 *  version 1 already extracted, so their margin / segment / KPI lines reach the
 *  sheet; the stored numbers are kept (`preserveExisting`). */
export const NEWSLETTER_EXTRACTOR_VERSION = 2;

/**
 * 3 (2026-10-21): images. The version an article is read at when it carries
 * content images the scan can fetch (`newsletterImageUrls`). Only those
 * articles move: a text-only article keeps NEWSLETTER_EXTRACTOR_VERSION, so
 * its banked ledger rows still answer the rescan's R20 shortcut and no model
 * call is spent re-reading it. An image-bearing article read text-only under
 * version 2 (and banked `no_numbers`) has no version-3 row, so the armed
 * rescan reads it again, this time with its pictures.
 */
export const NEWSLETTER_IMAGE_EXTRACTOR_VERSION = 3;

/** The ledger version this article is read at (see the two constants above). */
export function newsletterExtractorVersionForArticle(article: Pick<ArticleInput, "raw_html">): number {
  return newsletterImageUrls(article.raw_html).length > 0
    ? NEWSLETTER_IMAGE_EXTRACTOR_VERSION
    : NEWSLETTER_EXTRACTOR_VERSION;
}

/**
 * [C-3] Issue-scoped bogey label: "<publication> <M/D>" with the issue date in
 * ET, so two issues of one newsletter are two rows under
 * UNIQUE(event_id, source, source_label) rather than one clobbering the other
 * (the 2026-08-26 class, only half-mitigated by `preserveExisting`).
 *
 * Both the global scan and the per-event rescan label through this one
 * function — otherwise the two paths would mint different labels for the same
 * article and duplicate its numbers onto the sheet.
 *
 * `received_at` is stored as space-separated UTC ("YYYY-MM-DD HH:MM:SS", see
 * lib/gmail/fetch.ts); an unparseable value falls back to the bare publication
 * name rather than labelling the row "Invalid Date".
 */
export function newsletterIssueLabel(
  article: Pick<ArticleInput, "source_name" | "received_at">
): string {
  const raw = (article.received_at ?? "").trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const parsed = new Date(raw.replace(" ", "T") + (hasZone ? "" : "Z"));
  if (Number.isNaN(parsed.getTime())) return article.source_name;
  const md = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
  }).format(parsed);
  return `${article.source_name} ${md}`;
}

/** Does this extracted element carry anything worth a row? Mirrors
 *  CONTENT_COLUMNS in lib/mutations/earnings-bogeys.ts (`symbol` is the key,
 *  not content). */
function hasExtractedContent(bogey: ExtractedBogey): boolean {
  return (
    bogey.eps_consensus != null ||
    bogey.eps_whisper != null ||
    bogey.revenue_consensus != null ||
    bogey.revenue_whisper != null ||
    bogey.expected_move_pct != null ||
    bogey.guidance_notes != null ||
    bogey.notes != null ||
    bogey.watch_metrics.length > 0
  );
}

/**
 * The global scan's half of the `earnings_bogey_scans` ledger: one row per
 * (event, article) it read, at this extractor version, with `attempts = 0`
 * (no rescan attempt was spent). An event armed later then finds the pair
 * already read and spends no second model call on it. `DO NOTHING` on a
 * conflict: a row the rescan wrote, or a live claim it holds, is its own.
 */
function bankGlobalScan(
  db: Database.Database,
  eventId: number,
  articleId: number,
  version: number,
  status: "hit" | "no_numbers",
  modelId: string | null,
): void {
  db.prepare(
    `INSERT INTO earnings_bogey_scans
       (event_id, article_id, extractor_version, status, model_id, attempts, scanned_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
     ON CONFLICT(event_id, article_id, extractor_version) DO NOTHING`,
  ).run(eventId, articleId, version, status, modelId);
}

/** The stored watch lines of the row this write lands on, so a re-scan adds to
 *  them instead of replacing what the desk kept or edited. */
function storedExtraMetricsJson(
  db: Database.Database,
  eventId: number,
  sourceLabel: string,
): string | null {
  const row = db
    .prepare(
      `SELECT extra_metrics_json FROM earnings_bogeys
        WHERE event_id = ? AND source = 'newsletter' AND COALESCE(source_label, '') = ?`,
    )
    .get(eventId, sourceLabel) as { extra_metrics_json: string | null } | undefined;
  return row?.extra_metrics_json ?? null;
}

interface CallAndStoreResult {
  bogeysStored: number;
  eventsMatched: number;
  modelId: string | null;
  /** A model call was actually made (the article mentioned at least one reporter). */
  called: boolean;
  /** The model call itself failed — the caller decides whether to retry. */
  failed: boolean;
  /** The article carries content images and at least one could not be
   *  fetched, so the model read less than the whole article. A reporter with
   *  no hit is then NOT a final "no numbers". */
  imagesIncomplete: boolean;
  /** Ledger version the article was read at. */
  version: number;
}

/**
 * The ONE prompt → model → parse → write path. Both the global scan
 * (`extractBogeysFromArticle`) and the per-event rescan
 * (`extractBogeysFromArticleForEvent`) go through it, so the two can never
 * drift into different prompts, different parsing, or different bogey labels.
 *
 * `reporters` is already filtered to the ones this article mentions. This
 * helper deliberately does NOT touch `research_articles.bogeys_scanned_at`:
 * the global marker belongs to the global sweep alone, and the per-event path
 * must never consume an article on the sweep's behalf.
 */
async function callAndStore(
  db: Database.Database,
  article: ArticleInput,
  mentioned: UpcomingReporter[],
  opts: { bankLedger: boolean },
  deps: NewsletterScanDeps = {},
): Promise<CallAndStoreResult> {
  const imageUrls = newsletterImageUrls(article.raw_html);
  const version = imageUrls.length > 0 ? NEWSLETTER_IMAGE_EXTRACTOR_VERSION : NEWSLETTER_EXTRACTOR_VERSION;
  const nothing: CallAndStoreResult = {
    bogeysStored: 0,
    eventsMatched: 0,
    modelId: null,
    called: false,
    failed: false,
    imagesIncomplete: false,
    version,
  };
  if (mentioned.length === 0) return nothing;
  const reporters = mentioned.map((r) => ({
    ...r,
    existing_lines: existingWatchLinesForEvent(db, r.event_id),
  }));

  // Images first, so a fetch failure degrades this call to text instead of
  // failing it. `fetchNewsletterImages` never throws; the guard is for a seam.
  let images: NewsletterImage[] = [];
  let imagesIncomplete = false;
  if (imageUrls.length > 0) {
    try {
      const fetched = await (deps.fetchImages ?? fetchNewsletterImages)(imageUrls, { signal: deps.signal });
      images = Array.isArray(fetched?.images) ? fetched.images : [];
      imagesIncomplete = images.length < imageUrls.length;
      if (imagesIncomplete) {
        console.warn(
          `[earnings/extract-newsletter-bogeys] article ${article.id}: ${imageUrls.length - images.length} of ${imageUrls.length} image(s) unreadable; reading the rest`,
        );
      }
    } catch (err) {
      imagesIncomplete = true;
      console.warn(
        `[earnings/extract-newsletter-bogeys] article ${article.id}: image fetch failed; reading text only:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const callModel = async (withImages: NewsletterImage[]): Promise<string> => {
    const prompt = buildExtractionPrompt(article, reporters, { imageCount: withImages.length });
    const { text } = await generateTextForFeature("newsletterBogeyExtraction", {
      // Watch metrics run ~80 tokens a line, up to six lines a company: 2,048
      // truncated a multi-company preview mid-array, which parses as nothing.
      maxOutputTokens: 6144,
      ...(withImages.length > 0
        ? {
            messages: [
              {
                role: "user" as const,
                content: [
                  { type: "text" as const, text: prompt },
                  ...withImages.map((img) => ({ type: "image" as const, image: img.data, mediaType: img.mediaType })),
                ],
              },
            ],
          }
        : { prompt }),
    });
    return text;
  };

  let responseText: string;
  try {
    try {
      responseText = await callModel(images);
    } catch (err) {
      // The request was refused AS SENT (400/413) and carried images: an
      // oversize or corrupt picture is the likely cause, and it would be
      // refused on every retry, holding the article unscanned forever (the
      // global scan has no attempt cap). Read the text once instead; the
      // images count as unread, so nothing is banked as a final "no numbers".
      if (images.length === 0 || !isRequestRejectedAsSent(err)) throw err;
      console.warn(
        `[earnings/extract-newsletter-bogeys] article ${article.id}: request with ${images.length} image(s) refused; reading text only:`,
        err instanceof Error ? err.message : err,
      );
      imagesIncomplete = true;
      responseText = await callModel([]);
    }
  } catch (err) {
    console.warn(
      `[earnings/extract-newsletter-bogeys] Claude failed for article ${article.id}:`,
      err instanceof Error ? err.message : err
    );
    return { ...nothing, called: true, failed: true, imagesIncomplete };
  }

  // Mirrors app/api/earnings/bogeys/upload/route.ts:149 — never record
  // FEATURE_MODELS[key] directly (it's a tier token); resolve the concrete
  // model id actually resolved for this feature. Resolved as soon as the call
  // succeeds so the rescan ledger can record WHICH model said "no numbers".
  const { modelId } = resolveFeatureModel("newsletterBogeyExtraction");

  const storedEvents = new Set<number>();
  const bank = () => {
    if (!opts.bankLedger) return;
    for (const r of reporters) {
      const hit = storedEvents.has(r.event_id);
      // A reporter the model found nothing for while some images were
      // unreadable is not a final "no numbers": bank nothing, so the armed
      // rescan reads the article again (with its pictures) instead of taking
      // the R20 shortcut past it.
      if (!hit && imagesIncomplete) continue;
      bankGlobalScan(db, r.event_id, article.id, version, hit ? "hit" : "no_numbers", modelId);
    }
  };

  if (!responseText.trim()) {
    bank();
    return { bogeysStored: 0, eventsMatched: 0, modelId, called: true, failed: false, imagesIncomplete, version };
  }

  const extracted = parseExtractionResponse(responseText);
  const bySymbol = new Map(reporters.map((r) => [r.symbol, r]));

  let bogeysStored = 0;
  let eventsMatched = 0;

  for (const bogey of extracted) {
    // Issuer-family fan-out: the model may echo back a sibling share class
    // (GOOGL) for a reporter row keyed on GOOG.
    let matched: UpcomingReporter | undefined;
    for (const sym of issuerSiblings(bogey.symbol)) {
      const candidate = bySymbol.get(sym.toUpperCase());
      if (candidate) {
        matched = candidate;
        break;
      }
    }
    if (!matched) continue;
    // [C-3] fallout guard: with issue-DATED labels a numberless mention no longer
    // lands on the publication's existing row (where upsertBogey's has-content
    // check would skip it) — it would mint a brand-new all-null row per issue.
    // A bogey row with nothing in any content column is noise on the worksheet
    // and a false "hit" in the rescan ledger, so it is never written.
    // Mirrors CONTENT_COLUMNS in lib/mutations/earnings-bogeys.ts.
    if (!hasExtractedContent(bogey)) continue;

    // [C-3] Issue-dated, so a LATER issue lands beside the earlier one.
    const sourceLabel = newsletterIssueLabel(article);
    upsertBogey(db, {
      event_id: matched.event_id,
      source: "newsletter",
      source_label: sourceLabel,
      research_article_id: article.id,
      eps_consensus: bogey.eps_consensus,
      eps_whisper: bogey.eps_whisper,
      revenue_consensus_usd: bogey.revenue_consensus,
      revenue_whisper_usd: bogey.revenue_whisper,
      expected_move_pct: bogey.expected_move_pct,
      guidance_notes: bogey.guidance_notes,
      notes: bogey.notes,
      // Added to the row's stored lines, never replacing them; null (nothing
      // new and nothing stored) is a no-op under preserveExisting.
      extra_metrics_json: mergeWatchMetricsJson(
        storedExtraMetricsJson(db, matched.event_id, sourceLabel),
        bogey.watch_metrics,
      ),
      ai_extraction_model: modelId,
      // Even within one issue label, a RE-scan of the same article (a rescan
      // step re-run after fingerprint drift) must never let a null erase an
      // already-extracted number. Live 2026-08-26: an issue that mentioned
      // NVDA/CRWD without numbers erased the earlier issue's consensus.
      preserveExisting: true,
    });
    bogeysStored++;
    eventsMatched++;
    storedEvents.add(matched.event_id);
  }

  bank();
  return { bogeysStored, eventsMatched, modelId, called: true, failed: false, imagesIncomplete, version };
}

/**
 * Run bogey extraction on a single article against the full set of
 * upcoming reporters. Marks the article scanned regardless of whether any
 * bogeys were found or matched — only a genuine AI-call failure skips the
 * marker (retries next run).
 */
export async function extractBogeysFromArticle(
  db: Database.Database,
  article: ArticleInput,
  reporters: UpcomingReporter[],
  deps: NewsletterScanDeps = {},
): Promise<{ bogeysStored: number; eventsMatched: number }> {
  const mentioned = filterReportersMentionedInArticle(article, reporters);
  const result = await callAndStore(db, article, mentioned, { bankLedger: true }, deps);

  // Don't mark scanned on a transient AI failure — it should retry next run.
  if (result.failed) return { bogeysStored: 0, eventsMatched: 0 };

  markArticleScanned(db, article.id);
  return { bogeysStored: result.bogeysStored, eventsMatched: result.eventsMatched };
}

/**
 * Spec §4.1 step 1 — the PURE per-(article, event) extraction path.
 *
 * The global scan consumes an article once, for whatever was covered at that
 * moment; an event armed AFTERWARDS would never see the numbers. This path
 * re-reads an already-scanned article for ONE event, using the same prompt,
 * parser and bogey write (`callAndStore`), and NEVER stamps
 * `research_articles.bogeys_scanned_at` — the global marker stays the global
 * sweep's alone.
 *
 * No coverage/status call here by design: it is invoked only by the
 * `newsletter_rescan` prepare step, which runs solely for armed events.
 *
 * Throws when the model call fails, so the step's `earnings_bogey_scans`
 * ledger can book `error` + an attempt (and stop after SCAN_MAX_ATTEMPTS)
 * rather than silently recording a clean "no numbers".
 */
export async function extractBogeysFromArticleForEvent(
  db: Database.Database,
  article: ArticleInput,
  event: { event_id: number; symbol: string; event_date: string },
  deps: NewsletterScanDeps = {},
): Promise<{
  bogeysStored: number;
  modelId: string | null;
  called: boolean;
  /** Some content images were unreadable; optional so a test double may omit it. */
  imagesIncomplete?: boolean;
}> {
  const reporter: UpcomingReporter = {
    symbol: event.symbol.toUpperCase(),
    event_id: event.event_id,
    event_date: event.event_date,
  };
  if (!issuerSiblings(reporter.symbol).some((sym) => isSymbolMentioned(article.raw_text, sym))) {
    return { bogeysStored: 0, modelId: null, called: false };
  }

  const result = await callAndStore(db, article, [reporter], { bankLedger: false }, deps);
  if (result.failed) {
    throw new Error(
      `newsletter extraction failed for article ${article.id} / event ${event.event_id}`
    );
  }
  return {
    bogeysStored: result.bogeysStored,
    modelId: result.modelId,
    called: true,
    ...(result.imagesIncomplete ? { imagesIncomplete: true } : {}),
  };
}

/**
 * Scan recent unscanned research articles and auto-extract earnings bogeys
 * for any upcoming held/watchlist reporter the author gives numbers for.
 * Called from Task A2's wiring into the research sync pipeline.
 */
export async function extractBogeysFromNewArticles(
  db: Database.Database,
  opts: { sinceDays?: number; batchSize?: number } = {}
): Promise<{
  articlesScanned: number;
  bogeysStored: number;
  eventsMatched: number;
}> {
  const reporters = getUpcomingReporters(db);
  if (reporters.length === 0) {
    return { articlesScanned: 0, bogeysStored: 0, eventsMatched: 0 };
  }

  const articles = getUnscannedArticles(db, opts);
  if (articles.length === 0) {
    return { articlesScanned: 0, bogeysStored: 0, eventsMatched: 0 };
  }

  let bogeysStored = 0;
  let eventsMatched = 0;

  // Process with concurrency cap.
  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((a) => extractBogeysFromArticle(db, a, reporters))
    );
    for (const r of results) {
      bogeysStored += r.bogeysStored;
      eventsMatched += r.eventsMatched;
    }
  }

  return {
    articlesScanned: articles.length,
    bogeysStored,
    eventsMatched,
  };
}
