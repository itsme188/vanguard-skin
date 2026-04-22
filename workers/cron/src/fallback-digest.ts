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
  sendMessage,
  type ExtractedMessage,
} from "./gmail";
import { loadLatestSnapshot, type Snapshot, type RecentArticleMeta } from "./state";
import { getModelForFeature } from "./ai";
import { briefingToHtml } from "./html";
import { todayET } from "./dst";

const MAX_ARTICLES_PER_RUN = 15;

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
  FROM_EMAIL?: string;
}

export interface FallbackResult {
  kind: "success" | "no_snapshot" | "no_articles" | "error";
  sentMessageId?: string;
  processedCount?: number;
  error?: string;
}

interface ProcessedArticle {
  source_name: string;
  subject: string;
  received_at: string;
  source_url: string | null;
  summary: string;
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  key_themes: string[];
  portfolio_relevance: string;
}

export async function runFallbackDigest(
  env: FallbackEnv,
  opts: { dryRun?: boolean } = {}
): Promise<FallbackResult> {
  if (!env.BRIEFING_EMAIL_TO || !env.FROM_EMAIL) {
    return { kind: "error", error: "BRIEFING_EMAIL_TO / FROM_EMAIL missing" };
  }

  const snapshot = await loadLatestSnapshot(env.ARCHIVE);
  if (!snapshot) return { kind: "no_snapshot" };

  const accessToken = await getAccessToken(env);
  const heldSymbolsContext = snapshot.heldSymbols.join(", ");

  // Gmail query window: fetch anything received today (ET). If the Mac
  // already processed some of these, they'll be in snapshot.recentArticlesMeta
  // with processed_at set — we dedup by gmail_message_id below.
  const alreadyProcessedIds = new Set(
    snapshot.recentArticlesMeta
      .map((a) => a.gmail_message_id)
      .filter((id): id is string => id != null && id.length > 0)
  );

  const newProcessed: ProcessedArticle[] = [];
  const activeSources = snapshot.researchSources.filter(
    (s) => s.is_active === 1 && s.sender_email
  );

  for (const source of activeSources) {
    if (newProcessed.length >= MAX_ARTICLES_PER_RUN) break;

    const query = `from:${source.sender_email} newer_than:1d`;
    let list: { id: string }[];
    try {
      list = await listMessages(accessToken, query, 5);
    } catch (err) {
      console.warn(`[fallback-digest] list for ${source.name} failed:`, err);
      continue;
    }

    for (const m of list) {
      if (newProcessed.length >= MAX_ARTICLES_PER_RUN) break;
      if (alreadyProcessedIds.has(m.id)) continue;

      try {
        const detail = extractMessage(await getMessage(accessToken, m.id));
        if (!detail) continue;
        const processed = await processArticle(env, source, detail, heldSymbolsContext);
        if (processed) newProcessed.push(processed);
      } catch (err) {
        console.warn(`[fallback-digest] article ${m.id} failed:`, err);
      }
    }
  }

  // Combine: newly-processed on top (fresh today), then snapshot meta as context.
  const snapshotRecent = filterTodayArticles(snapshot.recentArticlesMeta);
  const digest = composeDigestMarkdown(newProcessed, snapshotRecent);
  if (!digest) return { kind: "no_articles", processedCount: newProcessed.length };

  const title = `Morning Research Digest — ${todayET()}`;
  const footer = `(fallback delivery, state snapshot ${snapshot.snapshotDate}) — Mac was offline.`;
  const html = briefingToHtml(digest, title, footer);

  if (opts.dryRun) {
    return { kind: "success", processedCount: newProcessed.length };
  }

  const send = await sendMessage(accessToken, {
    from: `"Vanguard Dashboard" <${env.FROM_EMAIL}>`,
    to: env.BRIEFING_EMAIL_TO,
    subject: `📰 ${title}`,
    html,
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
  properties: {
    summary: { type: "string" },
    key_themes: { type: "array", items: { type: "string" } },
    sentiment: { type: "string", enum: ["bullish", "bearish", "neutral", "mixed"] },
    portfolio_relevance: { type: "string" },
  },
  required: ["summary", "key_themes", "sentiment", "portfolio_relevance"],
});

async function processArticle(
  env: FallbackEnv,
  source: Snapshot["researchSources"][number],
  detail: ExtractedMessage,
  holdingsContext: string
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

  const { object } = await generateObject({
    model: getModelForFeature(env, "fallbackNewsletterProcessing"),
    maxOutputTokens: 2048,
    schema: ARTICLE_SCHEMA,
    prompt,
  });

  return {
    source_name: source.name,
    subject: detail.subject,
    received_at: detail.receivedAt,
    source_url: null,
    summary: object.summary || "",
    sentiment: object.sentiment || "neutral",
    key_themes: (object.key_themes || []).slice(0, 5),
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

function composeDigestMarkdown(
  fresh: ProcessedArticle[],
  snapshotMeta: RecentArticleMeta[]
): string | null {
  const totalCount = fresh.length + snapshotMeta.length;
  if (totalCount === 0) return null;

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const lines: string[] = [
    `# Morning Research Digest`,
    `### ${dateStr}`,
    "",
    `${totalCount} article${totalCount === 1 ? "" : "s"} · ${new Set([...fresh.map((a) => a.source_name), ...snapshotMeta.map((a) => a.source_name)]).size} sources`,
    "",
    "---",
    "",
  ];

  for (const a of fresh) {
    lines.push(`## ${a.source_name.toUpperCase()} · *${a.sentiment}*`);
    lines.push(`### ${a.subject}`);
    lines.push("");
    if (a.summary) {
      lines.push(a.summary);
      lines.push("");
    }
    if (a.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${a.portfolio_relevance}`);
      lines.push("");
    }
    if (a.key_themes.length > 0) {
      lines.push(`*${a.key_themes.join(" · ")}*`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  for (const a of snapshotMeta) {
    const sentiment = a.sentiment ?? "neutral";
    lines.push(`## ${a.source_name.toUpperCase()} · *${sentiment}*`);
    const url = a.source_url || a.website_url;
    lines.push(url ? `### [${a.subject}](${url})` : `### ${a.subject}`);
    lines.push("");
    if (a.summary) {
      lines.push(a.summary);
      lines.push("");
    }
    if (a.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${a.portfolio_relevance}`);
      lines.push("");
    }
    const themes = parseJsonArray(a.key_themes);
    if (themes.length > 0) {
      lines.push(`*${themes.join(" · ")}*`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
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
