/**
 * Cloud-fallback daily digest — runs when the Mac primary path fails.
 *
 * Flow:
 *   1. Load latest R2 snapshot (for source list + already-processed article meta).
 *   2. Fetch Gmail: for each active source, list messages received since the
 *      snapshot's most recent article from that source.
 *   3. Process each new message via Claude Sonnet + source's processing_prompt.
 *   4. Compose digest markdown combining newly-processed + snapshot meta.
 *   5. Send via Gmail REST with an italic footer noting fallback delivery.
 *
 * Guardrails:
 *   - Cap total new articles processed per run at 15 (latency + cost).
 *   - Per-article failures are swallowed with a log; the digest still ships.
 *   - If the snapshot is missing, we refuse to send — no state ≠ better
 *     than a placeholder email.
 */

import { generateObject, jsonSchema } from "ai";
import {
  getAccessToken,
  listMessages,
  getMessage,
  extractMessage,
  type ExtractedMessage,
} from "./gmail";
import { sendEmail } from "./resend";
import { loadLatestSnapshot, type Snapshot, type RecentArticleMeta } from "./state";
import { generateWithFailover } from "./ai";
import { briefingToHtml } from "./html";
import { todayET } from "./dst";
import { sourceKind, editionLabel } from "./editions";
import { fetchOvernightMovesWorker, renderOvernightLines } from "./overnight";
import { buildTodaysReportersBlock } from "./todays-reporters";

// Workers Free plan caps each invocation at 50 subrequests. The digest does
// 1 list call per source + 2 calls per processed article (getMessage + Claude)
// + 1 Yahoo spark call for the Overnight block (2026-07-15).
// 28 active sources × 1 list + 10 articles × 2 + 1 spark = 49 — the last
// slot is spent by Resend/recipient work. Bumping any constant risks the
// "Too many subrequests by single Worker invocation" failure that produced
// the silent miss on 2026-05-20.
const MAX_ARTICLES_PER_RUN = 10;
const MAX_MESSAGES_PER_SOURCE = 1;

export interface FallbackEnv {
  CRON_KV: KVNamespace;
  ARCHIVE: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  WORKER_GMAIL_CLIENT_ID?: string;
  WORKER_GMAIL_CLIENT_SECRET?: string;
  WORKER_GMAIL_REFRESH_TOKEN?: string;
  BRIEFING_EMAIL_TO?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_DOMAIN?: string;
  // Tier 3: live IBKR position refresh (briefing holdings context). All optional
  // — unset means the composer uses the snapshot's held-symbol list verbatim.
  IBKR_CONSUMER_KEY?: string;
  IBKR_ACCESS_TOKEN?: string;
  IBKR_PREPEND?: string;
  IBKR_DH_PRIME?: string;
  IBKR_SIGNATURE_KEY_PKCS8?: string;
  IBKR_DH_GENERATOR?: string;
  IBKR_BASE_URL?: string;
  IBKR_REALM?: string;
}

export interface FallbackResult {
  kind: "success" | "no_snapshot" | "no_articles" | "skipped" | "error";
  sentMessageId?: string;
  processedCount?: number;
  reason?: string;
  error?: string;
  htmlLength?: number;
}

export interface ProcessedArticle {
  source_name: string;
  subject: string;
  received_at: string;
  source_url: string | null;
  summary: string;
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  key_themes: string[];
  portfolio_relevance: string;
  /** Gmail message id of the source email — lets callers dedup a freshly
   *  fetched article against snapshot meta. */
  gmail_message_id: string | null;
}

export interface FetchAndProcessResult {
  processed: ProcessedArticle[];
  listErrors: number;
  articleErrors: number;
  lastError: string | null;
}

/**
 * Live-fetch + Claude-process today's new newsletter articles from Gmail.
 *
 * Shared by the digest AND evening fallbacks: the R2 snapshot freezes at 2am,
 * so any newsletter that lands during the day is invisible to a snapshot-only
 * reader. Both emails need to see today's mail, so this is the one place that
 * does the live Gmail list → getMessage → Claude-extract loop.
 *
 * Dedups against `snapshot.recentArticlesMeta` (by gmail_message_id), respects
 * the per-source + total caps, and tracks list/article errors separately from
 * "nothing new" so a total upstream wipeout (API outage, billing hold,
 * subrequest cap) is diagnosable rather than indistinguishable from a quiet day.
 */
export async function fetchAndProcessNewArticles(
  env: FallbackEnv,
  snapshot: Snapshot,
  opts: { maxArticles?: number } = {},
): Promise<FetchAndProcessResult> {
  const maxArticles = opts.maxArticles ?? MAX_ARTICLES_PER_RUN;
  const catalog = snapshot.modelCatalog ?? [];
  const accessToken = await getAccessToken(env);
  const heldSymbolsContext = snapshot.heldSymbols.join(", ");

  const alreadyProcessedIds = new Set(
    snapshot.recentArticlesMeta
      .map((a) => a.gmail_message_id)
      .filter((id): id is string => id != null && id.length > 0),
  );

  const processed: ProcessedArticle[] = [];
  const activeSources = snapshot.researchSources.filter(
    (s) => s.is_active === 1 && s.sender_email,
  );

  let listErrors = 0;
  let articleErrors = 0;
  let lastError: string | null = null;

  for (const source of activeSources) {
    if (processed.length >= maxArticles) break;

    const query = `from:${source.sender_email} newer_than:1d`;
    let list: { id: string }[];
    try {
      list = await listMessages(accessToken, query, MAX_MESSAGES_PER_SOURCE);
    } catch (err) {
      listErrors++;
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[fallback-fetch] list for ${source.name} failed:`, err);
      continue;
    }

    for (const m of list) {
      if (processed.length >= maxArticles) break;
      if (alreadyProcessedIds.has(m.id)) continue;

      try {
        const detail = extractMessage(await getMessage(accessToken, m.id));
        if (!detail) continue;
        const article = await processArticle(env, source, detail, heldSymbolsContext, catalog);
        if (article) {
          article.gmail_message_id = m.id;
          processed.push(article);
        }
      } catch (err) {
        articleErrors++;
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[fallback-fetch] article ${m.id} failed:`, err);
      }
    }
  }

  return { processed, listErrors, articleErrors, lastError };
}

export async function runFallbackDigest(
  env: FallbackEnv,
  opts: { dryRun?: boolean } = {}
): Promise<FallbackResult> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_DOMAIN) {
    return {
      kind: "error",
      error: "RESEND_API_KEY / RESEND_FROM_DOMAIN missing",
    };
  }

  const snapshot = await loadLatestSnapshot(env.ARCHIVE);
  if (!snapshot) return { kind: "no_snapshot" };

  // ── Recipient resolution ─────────────────────────────────────────────────
  const rawRecipients = snapshot.settings.digest_email_recipients;
  let recipient: string;
  if (rawRecipients && rawRecipients.trim().length > 0) {
    // Normalize comma-separated: trim each, rejoin with ", "
    recipient = rawRecipients
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .join(", ");
  } else if (env.BRIEFING_EMAIL_TO) {
    recipient = env.BRIEFING_EMAIL_TO;
  } else {
    return { kind: "error", error: "recipient missing: no digest_email_recipients in snapshot and BRIEFING_EMAIL_TO is unset" };
  }

  // Live-fetch today's newsletters (the snapshot froze at 2am; intraday mail
  // isn't in recentArticlesMeta). Shared with the evening fallback.
  const { processed: newProcessed, listErrors, articleErrors, lastError } =
    await fetchAndProcessNewArticles(env, snapshot);

  // Overnight scoreboard (numbers-only mirror of the Mac block) — ONE spark
  // subrequest for all four symbols; a Yahoo failure degrades to no block.
  const overnightBlock = renderOvernightLines(await fetchOvernightMovesWorker(todayET()));

  // Today's reporters (#18) — snapshot-only, zero subrequests.
  const reportersBlock = buildTodaysReportersBlock(snapshot, todayET());

  // Combine: newly-processed on top (fresh today), then snapshot meta as context.
  const snapshotRecent = filterTodayArticles(snapshot.recentArticlesMeta);
  const digest = composeDigestMarkdown(newProcessed, snapshotRecent, overnightBlock, reportersBlock);
  if (!digest) {
    if (articleErrors > 0 || listErrors > 0) {
      return {
        kind: "error",
        error: `digest produced no content: listErrors=${listErrors}, articleErrors=${articleErrors}, lastError=${lastError ?? "unknown"}`,
        processedCount: 0,
      };
    }
    return { kind: "no_articles", processedCount: newProcessed.length };
  }

  const title = `Morning Research Digest — ${todayET()}`;
  const footer = `(fallback delivery, state snapshot ${snapshot.snapshotDate}) — the Mac didn't complete this send in time.`;
  const html = briefingToHtml(digest, title, footer);

  if (opts.dryRun) {
    return { kind: "success", processedCount: newProcessed.length };
  }

  const send = await sendEmail(env, {
    to: recipient,
    subject: `📰 ${title}`,
    html,
    fromLocalPart: "digest",
  });
  return { kind: "success", sentMessageId: send.id, processedCount: newProcessed.length };
}

// ── Processing ──────────────────────────────────────────────────────

const ARTICLE_SCHEMA = jsonSchema<{
  summary: string;
  key_themes: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  portfolio_relevance: string;
}>({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    key_themes: { type: "array", items: { type: "string" } },
    sentiment: { type: "string", enum: ["bullish", "bearish", "neutral", "mixed"] },
    portfolio_relevance: { type: "string" },
  },
  required: ["summary", "key_themes", "sentiment", "portfolio_relevance"],
});

/**
 * Coerce the model's key_themes to a real string[] (2026-07-15 outage).
 * jsonSchema() does NOT runtime-validate, so despite the array schema the
 * model occasionally returns a comma-joined STRING — which survived
 * `.slice(0, 5)` (strings have slice) and then crashed renderItem's
 * `.join()`, failing every digest tick from 9:00–10:30 ET AFTER its ~10
 * Claude calls had already succeeded. Arrays pass through (strings only,
 * cap 5); a string splits on commas; anything else → [].
 */
/**
 * Sibling guard: the model intermittently dumps its ENTIRE tagged response
 * inside the `summary` string field ("...</summary>\n<key_themes">[...]").
 * jsonSchema() can't catch it — the field IS a valid string. Cut at the first
 * tagged remnant, strip a leading <summary> wrapper. Mac mirror:
 * lib/gmail/process.ts::sanitizeModelSummary (semantic parity — change both).
 */
const SUMMARY_TAG_REMNANT =
  /<\/?(?:summary|key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant|parameter)\b/i;

// Sibling guard for a JSON-shaped variant of the same leak (2026-08-14,
// research_articles rows 71098/71094/68064, ALL via the cloud-fallback
// path): no XML tags at all this time — the model dumps the rest of the
// raw tool-call JSON envelope as literal text inside the `summary` string
// ("...ends here.", "key_themes": [...], "sentiment": "bullish",
// "sentiment_score": 0.55, "mentioned_symbols": [...]"). A quoted schema
// field name glued directly to a colon essentially never occurs in prose,
// so it's a safe cut signal — same family as SUMMARY_TAG_REMNANT above.
// Mac mirror: lib/gmail/theme-sanitize.ts (semantic parity — change both).
const SUMMARY_JSON_ENVELOPE_REMNANT =
  /"(?:key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant)"\s*:/i;

export function sanitizeModelSummary(raw: string): string {
  if (!raw) return "";
  const s = raw.replace(/^\s*<summary[^>]*>\s*/i, "");
  const tagCut = s.search(SUMMARY_TAG_REMNANT);
  const jsonCut = s.search(SUMMARY_JSON_ENVELOPE_REMNANT);
  const cuts = [tagCut, jsonCut].filter((i) => i !== -1);
  if (cuts.length === 0) return s.trim();
  // Trim trailing separator debris left by the cut (e.g. the `", ` that
  // precedes the next JSON key) — only applied when a remnant was found.
  return s.slice(0, Math.min(...cuts)).replace(/[",\s]+$/, "").trim();
}

/**
 * key_themes twin of sanitizeModelSummary: the model intermittently wraps a
 * theme element in structured-output tag debris (`<parameter
 * name="key_themes">["theme"` — the 2026-07-22 Research Desk leak, row
 * 55380) or leaves stray brackets/quotes from a JSON-in-string dump. Every
 * upstream guard only filtered NON-STRING elements, so contaminated strings
 * sailed through to the rendered italics line. Clean per element. Mac
 * mirror: lib/gmail/process.ts::sanitizeThemeList (semantic parity — change
 * both).
 */
const THEME_TAG_STRIP = /<\/?(?:summary|key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant|parameter)\b[^>]*>?/gi;

function cleanThemeElement(raw: string): string {
  const cleaned = raw
    .replace(THEME_TAG_STRIP, " ")
    .replace(/^[\s"[\]]+|[\s"[\]]+$/g, "")
    .trim();
  // A leftover incomplete tag opening (e.g. "<par" from a truncated
  // "<parameter") is pure debris, not real theme content — drop it outright
  // rather than let a bare tag fragment survive as a garbage theme string.
  return /^<\/?[a-zA-Z_]*$/.test(cleaned) ? "" : cleaned;
}

export function normalizeThemes(v: unknown): string[] {
  const parts = Array.isArray(v)
    ? v.filter((t): t is string => typeof t === "string")
    : typeof v === "string"
      ? v.split(",")
      : [];
  return parts.map(cleanThemeElement).filter((t) => t.length > 0).slice(0, 5);
}

async function processArticle(
  env: FallbackEnv,
  source: Snapshot["researchSources"][number],
  detail: ExtractedMessage,
  holdingsContext: string,
  catalog: string[] = [],
): Promise<ProcessedArticle | null> {
  const text =
    detail.body.length > 15_000 ? detail.body.slice(0, 15_000) + "\n...[truncated]" : detail.body;

  const prompt = `Analyze this financial newsletter article and extract structured data.

Source: ${source.name}
Subject: ${detail.subject}
From: ${detail.sender}

Current portfolio holdings: ${holdingsContext || "(none loaded)"}
${source.processing_prompt ? `\nSource-specific instructions: ${source.processing_prompt}\n` : ""}
Article text:
${text}`;

  const { object } = await generateWithFailover(
    env,
    "fallbackNewsletterProcessing",
    catalog,
    (model) =>
      generateObject({
        model,
        maxOutputTokens: 2048,
        schema: ARTICLE_SCHEMA,
        prompt,
      }),
  );

  return {
    source_name: source.name,
    subject: detail.subject,
    received_at: detail.receivedAt,
    gmail_message_id: null, // set by the caller from the Gmail message id
    source_url: null,
    summary: sanitizeModelSummary(object.summary || ""),
    sentiment: object.sentiment || "neutral",
    key_themes: normalizeThemes(object.key_themes),
    portfolio_relevance: object.portfolio_relevance || "",
  };
}

// ── Compose ─────────────────────────────────────────────────────────

function filterTodayArticles(metas: RecentArticleMeta[]): RecentArticleMeta[] {
  const today = todayET();
  return metas
    .filter((a) => a.processed_at && a.received_at.startsWith(today))
    .slice(0, 30);
}

interface RenderItem {
  source_name: string;
  subject: string;
  sentiment: string;
  url: string | null;
  summary: string | null;
  portfolio_relevance: string | null;
  themes: string[];
}

export function composeDigestMarkdown(
  fresh: ProcessedArticle[],
  snapshotMeta: RecentArticleMeta[],
  /** Pre-rendered "## Overnight" block (numbers-only mirror of the Mac's) —
   *  rendered above the article sections. Null/omitted = no block. An
   *  overnight block alone never produces an email: no articles stays
   *  kind:"no_articles" so the catch-up sweep keeps retrying for content. */
  overnight?: string | null,
  /** Pre-rendered "## Today's reporters" block (snapshot mirror of the
   *  Mac's, #18) — rendered directly after the overnight block. Same rule:
   *  a reporters block alone never produces an email. */
  reporters?: string | null,
): string | null {
  const totalCount = fresh.length + snapshotMeta.length;
  if (totalCount === 0) return null;

  const items: RenderItem[] = [
    ...fresh.map((a) => ({
      source_name: a.source_name,
      subject: a.subject,
      sentiment: a.sentiment,
      url: null,
      summary: a.summary || null,
      portfolio_relevance: a.portfolio_relevance || null,
      // Defense-in-depth for pre-normalization callers/older payloads — a
      // non-array here crashed every digest tick on 2026-07-15 morning.
      themes: normalizeThemes(a.key_themes),
    })),
    ...snapshotMeta.map((a) => ({
      source_name: a.source_name,
      subject: a.subject,
      sentiment: a.sentiment ?? "neutral",
      url: a.source_url || a.website_url,
      summary: a.summary,
      portfolio_relevance: a.portfolio_relevance,
      themes: normalizeThemes(parseJsonArray(a.key_themes)),
    })),
  ];

  const commentary = items.filter((i) => sourceKind(i.source_name) === "commentary");
  const essays = items.filter((i) => sourceKind(i.source_name) === "essay");

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", // Worker runs in UTC — render the ET market day
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const lines: string[] = [
    `# Morning Research Digest`,
    `### ${dateStr}`,
    "",
    `${totalCount} article${totalCount === 1 ? "" : "s"} · ${new Set(items.map((i) => i.source_name)).size} sources`,
    "",
    "---",
    "",
  ];

  if (overnight) {
    lines.push(overnight);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  if (reporters) {
    lines.push(reporters);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const renderItem = (i: RenderItem, withEdition: boolean) => {
    const tag = withEdition ? editionLabel(i.source_name, i.subject).toUpperCase() : "";
    lines.push(`**${i.source_name.toUpperCase()}${tag}** · *${i.sentiment}*`);
    lines.push(i.url ? `### [${i.subject}](${i.url})` : `### ${i.subject}`);
    lines.push("");
    if (i.summary) {
      lines.push(i.summary);
      lines.push("");
    }
    if (i.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${i.portfolio_relevance}`);
      lines.push("");
    }
    if (i.themes.length > 0) {
      lines.push(`*${i.themes.join(" · ")}*`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  };

  if (commentary.length > 0) {
    lines.push("## Market Commentary");
    lines.push("");
    for (const i of commentary) renderItem(i, true);
  }
  if (essays.length > 0) {
    lines.push("## Research Desk");
    lines.push("");
    for (const i of essays) renderItem(i, false);
  }

  return lines.join("\n").trim();
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
