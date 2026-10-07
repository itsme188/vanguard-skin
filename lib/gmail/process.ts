import type Database from "better-sqlite3";
import { jsonSchema } from "ai";
import { generateObjectForFeature } from "@/lib/ai/generate";
import { resolveFeatureModel } from "@/lib/ai/models";
import { getHeldSymbolSet, heldSymbolsMentioned } from "@/lib/research/held-symbol-relevance";
import { verifyMentions } from "@/lib/research/verify-mentions";
import { truncateForPrompt } from "./prompt-caps";
import { sanitizeModelSummary, sanitizeThemeList } from "@/lib/gmail/theme-sanitize";
import { subjectSymbolBackstop } from "@/lib/gmail/subject-symbol-backstop";
import { getHeldStockSymbols } from "@/lib/queries/briefing-symbols";
import { getActiveWatchlistStockSymbols } from "@/lib/queries/watchlist";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import {
  COUNTED_AGAINST_ARTICLE_MARKER,
  MAX_ENRICH_ATTEMPTS,
  classifyEnrichmentError,
  describeEnrichmentFailure,
  type EnrichmentFailureClass,
} from "@/lib/gmail/enrichment-failure";

interface UnprocessedArticle {
  id: number;
  source_id: number;
  subject: string;
  sender: string;
  raw_text: string;
  source_name: string;
  processing_prompt: string | null;
  allow_off_topic: number;
}

interface ProcessedResult {
  summary: string;
  key_themes: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  sentiment_score: number;
  mentioned_symbols: string[];
  portfolio_relevance: string;
  is_portfolio_relevant: boolean;
}

/**
 * QA finding research-feeds--empty-enrichment-marked-processed-fake-neutral-chip
 * (2026-08-19, HIGH): true when the LLM extraction produced nothing usable —
 * empty summary AND empty key_themes, the "parse produced nothing" tell.
 * This is an AND, not an OR: a genuine terse read can legitimately come back
 * with zero themes (or, rarely, an empty summary alongside real themes) and
 * must still store normally — only the combination of both empty signals a
 * failed parse rather than a successful neutral one.
 */
export function isEmptyEnrichmentResult(result: ProcessedResult): boolean {
  return result.summary.trim() === "" && result.key_themes.length === 0;
}

// Retry ceiling for ARTICLE-level failures. Defined (with the account-level
// vs article-level classifier) in lib/gmail/enrichment-failure.ts; re-exported
// so existing importers keep working.
export { MAX_ENRICH_ATTEMPTS };

export interface ProcessArticlesResult {
  processed: number;
  /** Articles tried this pass that did not end up enriched. */
  failed: number;
  /**
   * Of `failed`, how many were left queued WITHOUT using an attempt because
   * the failure was account-level (billing, key, rate limit, outage, no
   * network) and nothing in the pass showed the article itself was at fault.
   * 0, 1 or 2: a pass stops at two account-level failures in a row.
   */
  deferred: number;
}

/**
 * Process unprocessed research articles with Claude Sonnet.
 * Extracts: summary, key themes, sentiment, mentioned tickers, portfolio relevance.
 * Links mentioned symbols to existing securities in the portfolio.
 *
 * Failure accounting (owner ruling 2026-10-06). An ARTICLE-level failure
 * (empty parse, refusal, malformed output, a rejected request, anything
 * unrecognised) uses one of the article's MAX_ENRICH_ATTEMPTS. An
 * ACCOUNT-level failure (out of credit, bad or missing key, rate limit,
 * outage, no network) is judged by what else happens in the same pass:
 *   1. Two account-level failures in a row stop the pass; neither is counted.
 *   2. It is counted against its article when the provider ANSWERS another
 *      article in the same pass (a success or a real reply such as a refusal),
 *      before or after it; rule 1 is checked first.
 *   3. A RATE LIMIT is counted only when a LATER article gets an answer: the
 *      pass's own earlier calls can be what used up the limit.
 *   4. Otherwise (alone in the pass, or last with nothing proving it) it is
 *      never counted, whatever attempts the article already has.
 * Rule 2 exists because the queue is newest first: an article the provider
 * always fails would otherwise block everything older. Rule 4 means an outage
 * alone can never exclude an article. An outage costs two enrichment calls per
 * pass; an article that fails alone costs one per pass until newer mail is
 * enriched in the same pass. The pass cadence (the 90-minute market-hours
 * job, the in-app refresh, a manual Sync, the two digest sends, each holding
 * the research sync lock) bounds the rest.
 */
export async function processUnprocessedArticles(
  db: Database.Database
): Promise<ProcessArticlesResult> {
  const articles = db
    .prepare(
      `SELECT a.id, a.source_id, a.subject, a.sender, a.raw_text,
              s.name as source_name, s.processing_prompt,
              COALESCE(s.allow_off_topic, 0) as allow_off_topic
       FROM research_articles a
       JOIN research_sources s ON a.source_id = s.id
       WHERE a.processed_at IS NULL
         AND COALESCE(a.is_relevant, 1) = 1
         AND COALESCE(a.enrich_attempts, 0) < ${MAX_ENRICH_ATTEMPTS}
       ORDER BY a.received_at DESC
       LIMIT 20`
    )
    .all() as UnprocessedArticle[];

  if (articles.length === 0) return { processed: 0, failed: 0, deferred: 0 };

  // Get current holdings for portfolio context. Latest is keyed per-(account,
  // security) via latestHoldingsPredicate (default keyBy/includeShorts:
  // false to preserve this site's existing quantity > 0 semantics), never a
  // per-account global MAX(as_of_date): a position that only restates on the
  // monthly statement (Treasuries, mutual funds) carried an older
  // as_of_date than the daily broker/Plaid rows for OTHER securities in the
  // same account, so the old per-account MAX silently dropped it from the
  // AI prompt's portfolio context entirely (holdings-latest-sweep task 10).
  const holdings = db
    .prepare(
      `SELECT DISTINCT s.symbol, s.name
       FROM holdings h
       JOIN securities s ON h.security_id = s.id
       WHERE ${latestHoldingsPredicate({ includeShorts: false })}
       ORDER BY s.symbol`
    )
    .all() as { symbol: string; name: string | null }[];

  const holdingsContext = holdings
    .map((h) => `${h.symbol}${h.name ? ` (${h.name})` : ""}`)
    .join(", ");

  // Held-symbol set for the off-topic guard, once per batch.
  const heldSymbols = getHeldSymbolSet(db);

  // Held + watchlist symbol universe for the deterministic subject-line
  // backstop (subjectSymbolBackstop) — same held/watchlist shape as
  // lib/calendar/sync.ts's scan-set union. Computed once for the whole
  // batch since it doesn't vary per article.
  const knownSymbols = new Set(
    [...getHeldStockSymbols(db), ...getActiveWatchlistStockSymbols(db)].map((s) =>
      s.toUpperCase()
    )
  );

  const updateArticle = db.prepare(`
    UPDATE research_articles
    SET summary = ?, key_themes = ?, sentiment = ?, sentiment_score = ?,
        mentioned_symbols = ?, portfolio_relevance = ?, ai_model = ?,
        processed_at = datetime('now')
    WHERE id = ?
  `);

  // D3: when Claude votes the article off-topic AND the source isn't opted
  // out of the gate, flip is_relevant=0 + tag the excluded fields so the
  // D5 audit UI can surface and un-filter it. The AI fields above still get
  // written — unfiltering then shows fully-extracted content in the digest
  // without re-processing cost. Source-level `allow_off_topic` is the
  // escape hatch for general-purpose newsletters (Helene Meisler chart
  // commentary, macro-only sources) where the vote would always be false.
  const markOffTopic = db.prepare(`
    UPDATE research_articles
    SET is_relevant = 0,
        excluded_category = 'off_topic',
        excluded_reason = ?
    WHERE id = ?
  `);

  const bumpAttempts = db.prepare(`
    UPDATE research_articles
    SET enrich_attempts = COALESCE(enrich_attempts, 0) + 1
    WHERE id = ?
    RETURNING enrich_attempts
  `);

  const markEnrichmentFailed = db.prepare(`
    UPDATE research_articles
    SET is_relevant = 0,
        excluded_category = 'enrichment_failed',
        excluded_reason = ?,
        processed_at = datetime('now')
    WHERE id = ?
  `);

  /**
   * Failure accounting for an ARTICLE-level failure (empty parse, or an error
   * classifyEnrichmentError puts on the article): increment the attempt
   * counter; at MAX_ENRICH_ATTEMPTS exclude the article as
   * 'enrichment_failed' (stamping processed_at removes it from the retry
   * queue; the Filtered tab surfaces it and offers Retry). Never call this
   * for an account-level failure.
   */
  const recordEnrichmentFailure = (articleId: number, why: string): void => {
    const { enrich_attempts } = bumpAttempts.get(articleId) as { enrich_attempts: number };
    if (enrich_attempts >= MAX_ENRICH_ATTEMPTS) {
      markEnrichmentFailed.run(
        `Enrichment failed ${enrich_attempts} times — last failure: ${why}`,
        articleId
      );
      console.error(
        `[research] Article ${articleId} excluded as enrichment_failed after ${enrich_attempts} attempts.`
      );
    }
  };

  const linkSecurity = db.prepare(`
    INSERT OR IGNORE INTO research_article_securities (article_id, security_id, mention_context, sentiment)
    VALUES (?, ?, ?, ?)
  `);

  const findSecurity = db.prepare(
    `SELECT id FROM securities WHERE symbol = ? LIMIT 1`
  );

  let processed = 0;
  let failed = 0;
  let deferred = 0;

  // An account-level failure whose blame is not settled yet (see the rules in
  // the function comment). Held in an object so closures can update it.
  interface PendingAccountFailure {
    article: UnprocessedArticle;
    failure: EnrichmentFailureClass;
    /** First 200 characters of what the provider (or the SDK) reported. */
    why: string;
  }
  const blame: { pending: PendingAccountFailure | null; providerAnswered: boolean } = {
    pending: null,
    providerAnswered: false,
  };

  /** Rules 2 and 3: count the pending account-level failure against its article. */
  const chargePendingToArticle = (because: string): void => {
    const p = blame.pending;
    if (!p) return;
    blame.pending = null;
    console.error(
      `[research] Article ${p.article.id}: account-level failure ` +
        `(${describeEnrichmentFailure(p.failure)}) counted toward the retry cap because ${because}.`
    );
    // The reason keeps what the provider returned and says why it was counted.
    recordEnrichmentFailure(p.article.id, `${p.why} ${COUNTED_AGAINST_ARTICLE_MARKER} ${because}]`);
  };

  /** The provider gave a real answer for some article in this pass. */
  const noteProviderAnswered = (): void => {
    blame.providerAnswered = true;
    chargePendingToArticle("the provider answered another article in the same pass");
  };

  for (const article of articles) {
    try {
      const result = await extractWithClaude(article, holdingsContext);
      // Any parsed reply, even an empty one, shows the provider is reachable.
      noteProviderAnswered();

      // An all-defaults parse (empty summary AND empty themes) is a FAILED
      // extraction, not a successful neutral read — do not stamp
      // processed_at and do not store the fabricated 'neutral' sentiment.
      // Leaving processed_at NULL keeps the article eligible for the very
      // next processUnprocessedArticles pass (its SELECT filters on
      // `processed_at IS NULL`). Storing defaults here previously produced
      // 78 empty stub cards rendering a fake 'neutral' chip in the feed —
      // 61/78 on claude-sonnet-5, so this wasn't just a cloud-fallback
      // artifact worth special-casing by ai_model.
      if (isEmptyEnrichmentResult(result)) {
        console.error(
          `[research] Article ${article.id} ("${article.subject}") produced an empty enrichment ` +
            `(no summary, no themes) — leaving unprocessed for retry, not stamping processed_at.`
        );
        recordEnrichmentFailure(article.id, "empty enrichment (no summary, no themes)");
        failed++;
        continue;
      }

      // Two-layer mention gate before linking: word-boundary drops substring
      // matches ("HOOD" in "likelihood"), Haiku drops homonyms ("Robin Hood"
      // the outlaw, "NET" as "net income"). See lib/research/verify-mentions.
      const verified = await verifyMentions(
        result.mentioned_symbols,
        article.subject,
        article.raw_text,
      );

      // Deterministic subject-line backstop, union'd in AFTER verifyMentions
      // rather than before: bypasses the AI verification gate entirely
      // (Haiku would happily drop a bare "U" as too ambiguous — exactly the
      // failure mode this backstop exists to catch). See
      // lib/gmail/subject-symbol-backstop.ts for the full story.
      const alreadyVerified = new Set(verified.map((v) => v.symbol));
      const backstopHits = subjectSymbolBackstop(article.subject, knownSymbols).filter(
        (s) => !alreadyVerified.has(s)
      );
      const verifiedSymbols = [...verified.map((v) => v.symbol), ...backstopHits];

      updateArticle.run(
        result.summary,
        JSON.stringify(result.key_themes),
        result.sentiment,
        result.sentiment_score,
        JSON.stringify(verifiedSymbols),
        result.portfolio_relevance,
        resolveFeatureModel("newsletterProcessing").modelId,
        article.id
      );

      const heldHits =
        !result.is_portfolio_relevant && article.allow_off_topic !== 1
          ? heldSymbolsMentioned(verifiedSymbols, heldSymbols)
          : [];
      if (heldHits.length > 0) {
        // Deterministic guard: the model has voted takeaways on HELD stocks
        // off-topic. A held mention is never off-topic, whatever the vote.
        console.warn(
          `[research] Article ${article.id}: off-topic vote overridden, mentions held symbol(s) ${heldHits.join(", ")}`
        );
      } else if (!result.is_portfolio_relevant && article.allow_off_topic !== 1) {
        const reason =
          result.portfolio_relevance && result.portfolio_relevance.trim().length > 0
            ? result.portfolio_relevance.slice(0, 280)
            : "Claude judged article off-topic";
        markOffTopic.run(reason, article.id);
      }

      for (const { symbol, context } of verified) {
        const sec = findSecurity.get(symbol) as { id: number } | undefined;
        if (sec) {
          linkSecurity.run(article.id, sec.id, context, result.sentiment);
        }
      }
      for (const symbol of backstopHits) {
        const sec = findSecurity.get(symbol) as { id: number } | undefined;
        if (sec) {
          linkSecurity.run(
            article.id,
            sec.id,
            `Subject-line backstop match: "${article.subject.slice(0, 300)}"`,
            result.sentiment
          );
        }
      }

      processed++;
    } catch (err) {
      const failure = classifyEnrichmentError(err);
      const why = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

      if (failure.scope === "account") {
        failed++;
        if (blame.pending) {
          // Rule 1: two in a row. The provider is down for everyone: neither
          // article is counted and the rest of the queue is not attempted.
          const waiting = articles.length - articles.indexOf(blame.pending.article);
          console.error(
            `[research] Enrichment stopped: two account-level AI failures in a row ` +
              `(${describeEnrichmentFailure(blame.pending.failure)} at article ${blame.pending.article.id}; ` +
              `${describeEnrichmentFailure(failure)} at article ${article.id}). ` +
              `Attempts not counted; ${waiting} queued article(s) from this pass will be retried on the next pass.`
          );
          blame.pending = null;
          deferred += 2;
          break;
        }
        // First one: hold it and try the next article before deciding.
        blame.pending = { article, failure, why };
        continue;
      }

      console.error(
        `[research] Failed to process article ${article.id} ("${article.subject}"):`,
        err instanceof Error ? err.message : err
      );
      if (failure.kind === "unknown") {
        // Default bucket for a shape the classifier does not know. Counting it
        // is the safe side (it cannot cause endless retries); logging it is
        // how a new account-level shape gets noticed and added.
        console.warn(
          `[research] Article ${article.id}: unrecognised enrichment error ` +
            `(${describeEnrichmentFailure(failure)}; ` +
            `${err instanceof Error ? err.name : typeof err}) counted toward the retry cap. ` +
            `If this is a provider or account fault, add it to lib/gmail/enrichment-failure.ts.`
        );
      }
      // A refusal, unparseable output or a rejected request is the provider
      // answering. An unknown error proves that only if it carried an HTTP
      // status; otherwise it settles nothing about a pending failure.
      if (failure.kind !== "unknown" || failure.status !== null) noteProviderAnswered();
      recordEnrichmentFailure(article.id, why);
      failed++;
    }
  }

  // The pass ended (queue or batch exhausted) with one account-level failure
  // still undecided: nothing was attempted after it. An answer EARLIER in the
  // pass counts it (rule 2), except for a rate limit (rule 3). With no such
  // answer it is never counted (rule 4).
  if (blame.pending) {
    const p = blame.pending;
    if (blame.providerAnswered && p.failure.kind !== "rate_limit") {
      chargePendingToArticle("the provider answered another article in the same pass");
    } else {
      console.error(
        `[research] Article ${p.article.id}: account-level AI failure ` +
          `(${describeEnrichmentFailure(p.failure)}) with nothing in the pass to show the article is at fault. ` +
          `Attempt not counted; it will be retried on the next pass.`
      );
      blame.pending = null;
      deferred++;
    }
  }

  return { processed, failed, deferred };
}

// ── Claude extraction ───────────────────────────────────────────────

export const ANALYSIS_SCHEMA = jsonSchema<ProcessedResult>({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "2-3 sentence summary of the article's key points and conclusions.",
    },
    key_themes: {
      type: "array",
      items: { type: "string" },
      description: 'Key themes/topics (e.g., ["fed policy", "tech earnings", "inflation"]) — max 5.',
    },
    sentiment: {
      type: "string",
      enum: ["bullish", "bearish", "neutral", "mixed"],
      description: "Overall market sentiment of the article.",
    },
    sentiment_score: {
      type: "number",
      description: "Sentiment score from -1.0 (very bearish) to 1.0 (very bullish).",
    },
    mentioned_symbols: {
      type: "array",
      items: { type: "string" },
      description: "Stock ticker symbols mentioned (e.g., AAPL, MSFT). Only include actual traded tickers, not generic terms.",
    },
    portfolio_relevance: {
      type: "string",
      description:
        "One sentence on how this article is relevant to the current portfolio holdings, written in second person addressed to the portfolio owner ('relevant to your NVDA position') — never third-person voice.",
    },
    is_portfolio_relevant: {
      type: "boolean",
      description:
        "TRUE when the article touches any held or watchlist ticker OR meaningfully shifts macro/sector context that already affects the portfolio (Fed policy, rates, broad indices, a sector held in the portfolio). FALSE only for clearly off-topic content (single-stock pieces about names not held in the portfolio and that don't read through to held names, crypto/coin-only commentary, lifestyle/non-finance). Default to TRUE when uncertain — prefer to under-filter.",
    },
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

// sanitizeModelSummary / sanitizeThemeList moved to lib/gmail/theme-sanitize.ts
// (2026-07-23) — that module has zero imports (no better-sqlite3 / AI SDK),
// so it's safe for a "use client" component (Research Feeds' ThemePills) to
// import directly. Re-exported here so every existing server-side importer
// (extractWithClaude below, digest render sites, repair scripts, tests)
// keeps working unchanged.
export { sanitizeModelSummary, sanitizeThemeList };

async function extractWithClaude(
  article: UnprocessedArticle,
  holdingsContext: string
): Promise<ProcessedResult> {
  // Cap very long articles for the prompt. 150k chars (was 15k — long
  // weeklies' summaries only reflected the opening ~15% for months; see
  // lib/gmail/prompt-caps.ts). Worker mirror: workers/cron/src/
  // newsletter-fetch.ts::truncateBodyForPrompt (parity-pinned).
  const text = truncateForPrompt(article.raw_text);

  const { object: _rawObject } = await generateObjectForFeature("newsletterProcessing", {
    maxOutputTokens: 2048,
    schema: ANALYSIS_SCHEMA,
    prompt: `Analyze this financial newsletter article and extract structured data.

Source: ${article.source_name}
Subject: ${article.subject}
From: ${article.sender}

Current portfolio holdings: ${holdingsContext || "(none loaded)"}
${article.processing_prompt ? `\nSource-specific instructions: ${article.processing_prompt}\n` : ""}
Article text:
${text}

ATTRIBUTION (provenance): If this piece is primarily RELAYING a third party's views — a podcast guest, interview subject, or quoted analyst (e.g. the newsletter summarizing someone else's remarks) — the summary MUST name that originator and make the relaying explicit ("TMT Breakout summarizes Gavin Baker's podcast remarks: ..."), and never flatten their view into the newsletter's own first-person voice. When the views are the newsletter author's own, no attribution phrase is needed.

VOICE: the summary and portfolio_relevance fields are read directly by the portfolio owner in their morning email. Address them in second person ("your CSX position", "your semis exposure") or neutral prose; NEVER refer to "the user", "the client", or "the portfolio manager" in third person.`,
  });

  // Normalize. is_portfolio_relevant defaults to true on a missing/null
  // response — under-filter when uncertain, matches the prompt direction.
  // Array fields are type-guarded because jsonSchema() does NOT runtime-
  // validate — the model can return them as comma-joined STRINGS, which
  // survive `.slice()` and corrupt storage (crashed the Worker digest
  // fallback for 1.5h on 2026-07-15; same model, same schema shape).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const object = _rawObject as any as ProcessedResult;
  const themes = sanitizeThemeList(object.key_themes);
  const symbols = Array.isArray(object.mentioned_symbols)
    ? object.mentioned_symbols.filter((s): s is string => typeof s === "string")
    : [];
  return {
    summary: sanitizeModelSummary(object.summary || ""),
    key_themes: themes,
    sentiment: object.sentiment || "neutral",
    sentiment_score: Math.max(-1, Math.min(1, object.sentiment_score || 0)),
    mentioned_symbols: symbols.map((s) => s.toUpperCase().trim()),
    portfolio_relevance: object.portfolio_relevance || "",
    is_portfolio_relevant: object.is_portfolio_relevant !== false,
  };
}

