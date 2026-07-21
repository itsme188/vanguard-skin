/**
 * Cloud-side newsletter ingestion fallback.
 *
 * Closes the gap where the Mac is asleep (travel, weekend) and Gmail keeps
 * receiving newsletter content that the launchd cron can't process. The
 * Worker fetches new messages, runs the same Claude analysis the Mac would
 * run, and writes each result to KV as `cloud-fetched-newsletter-<msgId>`.
 *
 * The Mac, on wake, polls `GET /internal/cloud-fetched-newsletters`, inserts
 * each payload into `research_articles` (INSERT OR IGNORE keyed on
 * `gmail_message_id`), then DELETEs the KV key per article.
 *
 * Sibling pattern to Tier 4a's level scan + Pushover fan-out: cloud fires
 * when Mac is unreachable; Mac reconciles on wake; KV markers gate duplicate
 * work.
 *
 * Gating:
 *   - shouldRunNewsletterFetch() returns true on the top-of-hour tick
 *     within ET 06:00-20:59 (minute === 0 only, so ~hourly cadence).
 *   - `mac-recent-newsletter-sync` KV marker (60-min TTL) — Mac sets after
 *     its own `fetchNewArticles` completes; Worker skips when present.
 *   - Per-message dedup: skip if `cloud-fetched-newsletter-<msgId>` already
 *     exists (avoid re-Claude'ing the same article across Worker ticks).
 */

import { generateObject, jsonSchema } from "ai";
import {
  getAccessToken,
  listMessages,
  getMessage,
  extractMessage,
  type ExtractedMessage,
} from "./gmail";
import { loadLatestSnapshot, type Snapshot } from "./state";
import { generateWithFailover } from "./ai";
import { normalizeThemes, sanitizeModelSummary } from "./fallback-digest";
import { getCurrentETHour, getCurrentETMinute } from "./dst";

const MAX_ARTICLES_PER_RUN = 10;
const MAX_MESSAGES_PER_SOURCE = 3;
const KV_TTL_SECONDS = 72 * 60 * 60; // 72h — wider than Mac's typical wake window

export interface NewsletterFetchEnv {
  CRON_KV: KVNamespace;
  ARCHIVE: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  WORKER_GMAIL_CLIENT_ID?: string;
  WORKER_GMAIL_CLIENT_SECRET?: string;
  WORKER_GMAIL_REFRESH_TOKEN?: string;
}

export interface NewsletterFetchResult {
  kind: "success" | "no_snapshot" | "no_articles" | "skipped" | "error";
  fetched?: number;
  reason?: string;
  error?: string;
}

/**
 * ET 06:00-20:59, top of hour only — runs once an hour. Newsletter senders
 * publish through the day + evening; staying out of the overnight window
 * avoids waking the AI Gateway on schedules that have nothing to do.
 */
export function shouldRunNewsletterFetch(
  hour: number = getCurrentETHour(),
  minute: number = getCurrentETMinute(),
): boolean {
  if (minute !== 0) return false;
  return hour >= 6 && hour <= 20;
}

interface NewsletterPayload {
  source_id: number;
  source_name: string;
  gmail_message_id: string;
  received_at: string;
  subject: string;
  sender: string;
  raw_text: string;
  raw_html: string | null;
  summary: string;
  key_themes: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  sentiment_score: number;
  mentioned_symbols: string[];
  portfolio_relevance: string;
  is_portfolio_relevant: boolean;
  ai_model: string;
  fetched_by: "cloud";
  fetched_at: string;
}

/**
 * Mirrors the Mac's lib/gmail/process.ts ANALYSIS_SCHEMA. The is_portfolio_relevant
 * field is the D3 gate — Mac reconciler applies the source-level allow_off_topic
 * opt-out after merging.
 */
const ARTICLE_SCHEMA = jsonSchema<{
  summary: string;
  key_themes: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  sentiment_score: number;
  mentioned_symbols: string[];
  portfolio_relevance: string;
  is_portfolio_relevant: boolean;
}>({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    key_themes: { type: "array", items: { type: "string" } },
    sentiment: { type: "string", enum: ["bullish", "bearish", "neutral", "mixed"] },
    sentiment_score: { type: "number" },
    mentioned_symbols: { type: "array", items: { type: "string" } },
    portfolio_relevance: { type: "string" },
    is_portfolio_relevant: { type: "boolean" },
  },
  required: [
    "summary",
    "key_themes",
    "sentiment",
    "sentiment_score",
    "mentioned_symbols",
    "portfolio_relevance",
    "is_portfolio_relevant",
  ],
});

/**
 * Test-only seam — production code uses the defaults at the bottom of the
 * file. Tests inject in-memory stand-ins for the I/O dependencies.
 */
export interface NewsletterFetchDeps {
  loadSnapshot: (bucket: R2Bucket) => Promise<Snapshot | null>;
  getAccessToken: (env: NewsletterFetchEnv) => Promise<string>;
  listMessages: (token: string, query: string, maxResults: number) => Promise<{ id: string }[]>;
  getMessage: (token: string, id: string) => Promise<unknown>;
  extractMessage: (msg: unknown) => ExtractedMessage | null;
  analyzeArticle: (
    env: NewsletterFetchEnv,
    source: Snapshot["researchSources"][number],
    detail: ExtractedMessage,
    holdingsContext: string,
  ) => Promise<ArticleAnalysis | null>;
}

export interface ArticleAnalysis {
  summary: string;
  key_themes: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  sentiment_score: number;
  mentioned_symbols: string[];
  portfolio_relevance: string;
  is_portfolio_relevant: boolean;
}

export async function runNewsletterFetch(
  env: NewsletterFetchEnv,
  deps: Partial<NewsletterFetchDeps> = {},
): Promise<NewsletterFetchResult> {
  // loadSnapshot + getAccessToken/listMessages/getMessage/extractMessage resolve
  // immediately; analyzeArticle is wired AFTER the snapshot loads so we can
  // pass snapshot.modelCatalog into the default implementation without changing
  // the NewsletterFetchDeps interface (which tests mock without a catalog param).
  const loadSnapshot = deps.loadSnapshot ?? loadLatestSnapshot;
  const resolvedGetAccessToken = deps.getAccessToken ?? getAccessToken;
  const resolvedListMessages = deps.listMessages ?? listMessages;
  const resolvedGetMessage = deps.getMessage ?? (getMessage as NewsletterFetchDeps["getMessage"]);
  const resolvedExtractMessage =
    deps.extractMessage ??
    ((msg: unknown) => extractMessage(msg as Parameters<typeof extractMessage>[0]));

  // Skip when Mac has run its own sync recently — avoids paying for a
  // duplicate Claude pass while Mac is alive.
  const macRecent = await env.CRON_KV.get("mac-recent-newsletter-sync");
  if (macRecent) {
    return { kind: "skipped", reason: "mac-recent-newsletter-sync marker present" };
  }

  const snapshot = await loadSnapshot(env.ARCHIVE);
  if (!snapshot) return { kind: "no_snapshot" };

  // Wire analyzeArticle AFTER snapshot load so the default can capture the
  // catalog for tier-aware model resolution + failover. Injected mocks override.
  const catalog = snapshot.modelCatalog ?? [];
  const d: NewsletterFetchDeps = {
    loadSnapshot,
    getAccessToken: resolvedGetAccessToken,
    listMessages: resolvedListMessages,
    getMessage: resolvedGetMessage,
    extractMessage: resolvedExtractMessage,
    analyzeArticle:
      deps.analyzeArticle ??
      ((e, source, detail, holdingsCtx) => defaultAnalyze(e, source, detail, holdingsCtx, catalog)),
  };

  const accessToken = await d.getAccessToken(env);
  const heldSymbolsContext = snapshot.heldSymbols.join(", ");

  // Build dedup set from the snapshot (already-ingested rows) + the cloud
  // KV (already-Claude'd-but-not-yet-reconciled rows).
  const alreadyProcessedIds = new Set(
    snapshot.recentArticlesMeta
      .map((a) => a.gmail_message_id)
      .filter((id): id is string => id != null && id.length > 0),
  );
  const pendingKvList = await env.CRON_KV.list({ prefix: "cloud-fetched-newsletter-" });
  for (const k of pendingKvList.keys) {
    const m = /^cloud-fetched-newsletter-(.+)$/.exec(k.name);
    if (m) alreadyProcessedIds.add(m[1]);
  }

  const activeSources = snapshot.researchSources.filter(
    (s) => s.is_active === 1 && s.sender_email,
  );

  console.log(
    `[newsletter-fetch] starting sources=${activeSources.length} ` +
      `snapshotArticles=${alreadyProcessedIds.size - pendingKvList.keys.length} ` +
      `kvPending=${pendingKvList.keys.length}`,
  );

  let totalFetched = 0;
  let totalCandidatesDeduped = 0;
  for (const source of activeSources) {
    if (totalFetched >= MAX_ARTICLES_PER_RUN) break;

    const query = `from:${source.sender_email} newer_than:1d`;
    let messages: { id: string }[];
    try {
      messages = await d.listMessages(accessToken, query, MAX_MESSAGES_PER_SOURCE);
    } catch (err) {
      console.warn(`[newsletter-fetch] list for ${source.name} failed:`, err);
      continue;
    }

    if (messages.length === 0) continue;
    const dedupedCount = messages.filter((m) => alreadyProcessedIds.has(m.id)).length;
    totalCandidatesDeduped += dedupedCount;
    console.log(
      `[newsletter-fetch] source=${source.name} listed=${messages.length} ` +
        `deduped=${dedupedCount} candidates=${messages.length - dedupedCount}`,
    );

    for (const m of messages) {
      if (totalFetched >= MAX_ARTICLES_PER_RUN) break;
      if (alreadyProcessedIds.has(m.id)) continue;

      try {
        const detail = d.extractMessage(await d.getMessage(accessToken, m.id));
        if (!detail) {
          console.log(`[newsletter-fetch] ${source.name} msg=${m.id} extractMessage returned null`);
          continue;
        }

        const result = await d.analyzeArticle(env, source, detail, heldSymbolsContext);
        if (!result) {
          console.log(`[newsletter-fetch] ${source.name} msg=${m.id} analyzeArticle returned null`);
          continue;
        }

        const payload: NewsletterPayload = {
          source_id: source.id,
          source_name: source.name,
          gmail_message_id: detail.messageId,
          received_at: detail.receivedAt,
          subject: detail.subject,
          sender: detail.sender,
          raw_text: detail.body,
          raw_html: detail.html,
          summary: result.summary,
          key_themes: result.key_themes.slice(0, 5),
          sentiment: result.sentiment,
          sentiment_score: clamp(result.sentiment_score, -1, 1),
          mentioned_symbols: result.mentioned_symbols.map((s) => s.toUpperCase().trim()),
          portfolio_relevance: result.portfolio_relevance,
          is_portfolio_relevant: result.is_portfolio_relevant !== false,
          ai_model: "cloud-fallback",
          fetched_by: "cloud",
          fetched_at: new Date().toISOString(),
        };

        await env.CRON_KV.put(
          `cloud-fetched-newsletter-${detail.messageId}`,
          JSON.stringify(payload),
          { expirationTtl: KV_TTL_SECONDS },
        );
        totalFetched++;
      } catch (err) {
        console.warn(`[newsletter-fetch] article ${m.id} failed:`, err);
      }
    }
  }

  console.log(
    `[newsletter-fetch] done fetched=${totalFetched} dedupedAcrossSources=${totalCandidatesDeduped}`,
  );
  if (totalFetched === 0) return { kind: "no_articles" };
  return { kind: "success", fetched: totalFetched };
}

// Mirror of Mac lib/gmail/prompt-caps.ts::EXTRACTION_PROMPT_CHAR_CAP —
// parity-pinned in test/newsletter-fetch.test.ts. Was 15k: long weeklies'
// summaries reflected only the opening ~15% of the email (R2 audit
// 2026-07-03). Keep BOTH sides in sync.
export const EXTRACTION_PROMPT_CHAR_CAP = 150_000;

/** Cap text for the AI prompt, marking the cut so the model knows it's partial. */
export function truncateBodyForPrompt(body: string): string {
  return body.length > EXTRACTION_PROMPT_CHAR_CAP
    ? body.slice(0, EXTRACTION_PROMPT_CHAR_CAP) + "\n...[truncated]"
    : body;
}

async function defaultAnalyze(
  env: NewsletterFetchEnv,
  source: Snapshot["researchSources"][number],
  detail: ExtractedMessage,
  holdingsContext: string,
  catalog: string[] = [],
): Promise<ArticleAnalysis | null> {
  const text = truncateBodyForPrompt(detail.body);

  const prompt = `Analyze this financial newsletter article and extract structured data.

Source: ${source.name}
Subject: ${detail.subject}
From: ${detail.sender}

Current portfolio holdings: ${holdingsContext || "(none loaded)"}
${source.processing_prompt ? `\nSource-specific instructions: ${source.processing_prompt}\n` : ""}
Article text:
${text}

For is_portfolio_relevant: Set TRUE when the article touches any held or
watchlist ticker OR meaningfully shifts macro/sector context that already
affects the portfolio (Fed policy, rates, broad indices, sector exposure).
Set FALSE only for clearly off-topic content. Default to TRUE when
uncertain — prefer to under-filter.

ATTRIBUTION (provenance): If this piece is primarily RELAYING a third party's views — a podcast guest, interview subject, or quoted analyst (e.g. the newsletter summarizing someone else's remarks) — the summary MUST name that originator and make the relaying explicit ("TMT Breakout summarizes Gavin Baker's podcast remarks: ..."), and never flatten their view into the newsletter's own first-person voice. When the views are the newsletter author's own, no attribution phrase is needed.`;

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
    // sanitizeModelSummary + normalizeThemes: jsonSchema() doesn't runtime-
    // validate — the model can return array fields as strings (crashed the
    // digest fallback 2026-07-15) or dump its whole tagged response inside
    // the summary string (9 poisoned rows, 2026-07-07..20).
    summary: sanitizeModelSummary(object.summary || ""),
    key_themes: normalizeThemes(object.key_themes),
    sentiment: object.sentiment || "neutral",
    sentiment_score: object.sentiment_score || 0,
    mentioned_symbols: Array.isArray(object.mentioned_symbols)
      ? object.mentioned_symbols.filter((s): s is string => typeof s === "string")
      : [],
    portfolio_relevance: object.portfolio_relevance || "",
    is_portfolio_relevant: object.is_portfolio_relevant !== false,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
