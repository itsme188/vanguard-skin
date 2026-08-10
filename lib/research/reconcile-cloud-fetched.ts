import type Database from "better-sqlite3";
import { sanitizeThemeList } from "@/lib/gmail/theme-sanitize";
import { subjectSymbolBackstop } from "@/lib/gmail/subject-symbol-backstop";
import { getHeldStockSymbols } from "@/lib/queries/briefing-symbols";
import { getActiveWatchlistStockSymbols } from "@/lib/queries/watchlist";

/**
 * Reconcile cloud-fetched newsletter articles.
 *
 * Sibling to `lib/alerts/reconcile-cloud-fired.ts`. When the Mac is asleep,
 * the Worker fetches new Gmail messages, Claude-analyzes them, and writes
 * each result to KV as `cloud-fetched-newsletter-<gmail_message_id>`.
 *
 * On every Mac wake (auto-refresh / research-sync), this routine drains the
 * KV markers into `research_articles`. INSERT OR IGNORE on
 * `gmail_message_id` (UNIQUE) makes the merge idempotent — if Mac's own
 * fetch picked up the same message in the meantime, the Worker copy is
 * silently skipped.
 *
 * D3 portfolio-relevance gate is applied AT reconcile time, not by the
 * Worker, so the per-source `allow_off_topic` flag (Mac-only column) still
 * has effect. Worker stores the raw judgment; reconciler decides whether to
 * flip `is_relevant=0`.
 */

interface CloudFetchedPayload {
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

export interface CloudFetchedReconcileResult {
  ok: boolean;
  reconciled: number;
  skipped_already_in_db: number;
  skipped_source_missing: number;
  errors?: { messageId: string; error: string }[];
  error?: string;
  note?: string;
  status?: number;
}

function workerBase(): string | null {
  const raw = process.env.WORKER_MARKER_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export async function reconcileCloudFetchedNewsletters(
  db: Database.Database,
  secret: string,
): Promise<CloudFetchedReconcileResult> {
  const base = workerBase();
  if (!base) {
    return {
      ok: true,
      reconciled: 0,
      skipped_already_in_db: 0,
      skipped_source_missing: 0,
      note: "WORKER_MARKER_URL unset — no-op",
    };
  }

  let payloads: Record<string, CloudFetchedPayload> = {};
  try {
    const res = await fetch(`${base}/internal/cloud-fetched-newsletters`, {
      headers: { "X-Cron-Secret": secret },
    });
    if (!res.ok) {
      return {
        ok: false,
        reconciled: 0,
        skipped_already_in_db: 0,
        skipped_source_missing: 0,
        error: `worker returned ${res.status}`,
        status: 502,
      };
    }
    const body = (await res.json()) as { payloads?: Record<string, CloudFetchedPayload> };
    payloads = body.payloads ?? {};
  } catch (err) {
    return {
      ok: false,
      reconciled: 0,
      skipped_already_in_db: 0,
      skipped_source_missing: 0,
      error: err instanceof Error ? err.message : String(err),
      status: 502,
    };
  }

  const entries = Object.entries(payloads);
  if (entries.length === 0) {
    return { ok: true, reconciled: 0, skipped_already_in_db: 0, skipped_source_missing: 0 };
  }

  // INSERT OR IGNORE on gmail_message_id (UNIQUE) — silently swallows
  // any race where Mac's own fetch picked the same message between
  // Worker write and Mac reconcile.
  const insertArticle = db.prepare(`
    INSERT OR IGNORE INTO research_articles
      (source_id, gmail_message_id, gmail_thread_id, received_at, subject, sender,
       raw_text, raw_html, source_url,
       summary, key_themes, sentiment, sentiment_score,
       mentioned_symbols, portfolio_relevance, ai_model,
       processed_at, is_relevant, excluded_category, excluded_reason)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
  `);

  const selectSource = db.prepare(
    `SELECT id, COALESCE(allow_off_topic, 0) as allow_off_topic
       FROM research_sources WHERE id = ?`,
  );
  const linkSecurity = db.prepare(`
    INSERT OR IGNORE INTO research_article_securities (article_id, security_id, mention_context, sentiment)
    VALUES (?, ?, ?, ?)
  `);
  const findSecurity = db.prepare(
    `SELECT id FROM securities WHERE symbol = ? LIMIT 1`,
  );

  // Sibling of the deterministic subject-line backstop in
  // lib/gmail/process.ts (subjectSymbolBackstop) — parity-pinned, change
  // both together. The Worker's own extraction (workers/cron/src/
  // newsletter-fetch.ts::defaultAnalyze) never links securities itself (no
  // DB access from a Worker); this reconcile step is where cloud-fetched
  // mentions actually become research_article_securities rows, so it needs
  // the same catch as the direct-fetch path or a model-dropped ticker in a
  // Worker-sourced article would stay invisible forever.
  const knownSymbols = new Set(
    [...getHeldStockSymbols(db), ...getActiveWatchlistStockSymbols(db)].map((s) =>
      s.toUpperCase(),
    ),
  );

  let reconciled = 0;
  let skippedAlreadyInDb = 0;
  let skippedSourceMissing = 0;
  const errors: { messageId: string; error: string }[] = [];

  for (const [messageId, payload] of entries) {
    try {
      const source = selectSource.get(payload.source_id) as
        | { id: number; allow_off_topic: number }
        | undefined;
      if (!source) {
        // Source was deleted between Worker scan and reconcile — just clear
        // the KV marker; no-op locally.
        await deleteFromWorker(base, secret, messageId);
        skippedSourceMissing += 1;
        continue;
      }

      // D3 gate: if Worker's Claude voted off-topic AND the source isn't
      // opted out via allow_off_topic, mark the row is_relevant=0 with the
      // same shape as Mac-side processUnprocessedArticles.
      let isRelevant: 0 | 1 = 1;
      let excludedCategory: string | null = null;
      let excludedReason: string | null = null;
      if (!payload.is_portfolio_relevant && source.allow_off_topic !== 1) {
        isRelevant = 0;
        excludedCategory = "off_topic";
        excludedReason =
          payload.portfolio_relevance && payload.portfolio_relevance.trim().length > 0
            ? payload.portfolio_relevance.slice(0, 280)
            : "Claude judged article off-topic";
      }

      // Deterministic subject-line backstop (see lib/gmail/subject-symbol-
      // backstop.ts) — union'd in before storage, same as the direct-fetch
      // path. Bypasses AI verification entirely; only exact-case matches
      // against the held/watchlist universe survive.
      const backstopHits = subjectSymbolBackstop(payload.subject, knownSymbols).filter(
        (s) => !payload.mentioned_symbols.includes(s),
      );
      const mentionedSymbols = [...payload.mentioned_symbols, ...backstopHits];

      const info = insertArticle.run(
        payload.source_id,
        payload.gmail_message_id,
        payload.received_at,
        payload.subject,
        payload.sender,
        payload.raw_text,
        payload.raw_html,
        payload.summary,
        JSON.stringify(sanitizeThemeList(payload.key_themes)),
        payload.sentiment,
        payload.sentiment_score,
        JSON.stringify(mentionedSymbols),
        payload.portfolio_relevance,
        payload.ai_model,
        isRelevant,
        excludedCategory,
        excludedReason,
      );

      if (info.changes === 0) {
        // INSERT OR IGNORE matched on gmail_message_id — Mac already had it.
        await deleteFromWorker(base, secret, messageId);
        skippedAlreadyInDb += 1;
        continue;
      }

      // Link mentioned symbols. The Worker's mention list went through
      // Claude only (no verifyMentions pass), so accept it as-is here —
      // verifyMentions catches "HOOD" in "likelihood" only when the
      // Mac side processes natively, and the cost of running it again
      // here on every reconcile is not worth defending against this
      // edge case for cloud-fetched rows (the digest filter still
      // protects against the most common case anyway).
      const articleId = info.lastInsertRowid as number;
      for (const symbol of payload.mentioned_symbols) {
        const sec = findSecurity.get(symbol) as { id: number } | undefined;
        if (sec) {
          linkSecurity.run(articleId, sec.id, "cloud-fetched mention", payload.sentiment);
        }
      }
      for (const symbol of backstopHits) {
        const sec = findSecurity.get(symbol) as { id: number } | undefined;
        if (sec) {
          linkSecurity.run(
            articleId,
            sec.id,
            `Subject-line backstop match: "${payload.subject.slice(0, 300)}"`,
            payload.sentiment,
          );
        }
      }

      reconciled += 1;
      await deleteFromWorker(base, secret, messageId);
    } catch (err) {
      errors.push({
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    reconciled,
    skipped_already_in_db: skippedAlreadyInDb,
    skipped_source_missing: skippedSourceMissing,
    errors,
  };
}

async function deleteFromWorker(
  base: string,
  secret: string,
  messageId: string,
): Promise<void> {
  try {
    await fetch(
      `${base}/internal/cloud-fetched-newsletters?messageId=${encodeURIComponent(messageId)}`,
      {
        method: "DELETE",
        headers: { "X-Cron-Secret": secret },
      },
    );
  } catch {
    // If KV delete fails, payload re-reconciles on next wake — idempotent
    // because INSERT OR IGNORE in research_articles dedups by
    // gmail_message_id.
  }
}

/**
 * Post the "mac-recent-newsletter-sync" marker to the Worker. Fire-and-forget
 * after Mac's own fetchNewArticles completes successfully. Worker pre-checks
 * this marker before its hourly fetch — prevents duplicate Claude analysis
 * when Mac is alive.
 */
export async function postMacRecentNewsletterSyncMarker(secret: string): Promise<void> {
  const base = workerBase();
  if (!base) return;
  try {
    await fetch(`${base}/internal/mac-recent-newsletter-sync`, {
      method: "POST",
      headers: { "X-Cron-Secret": secret },
    });
  } catch {
    // Fire-and-forget — never block the sync pipeline on Worker RTT.
  }
}
