import type Database from "better-sqlite3";
import { getRecentArticles, countRecentArticles } from "@/lib/queries/research";
import { bucketByCompany } from "@/lib/digest/group-by-company";
import { splitDigestOpening } from "./synthesis-editorial";
import { synthesize, SynthesisEmptyError } from "@/lib/digest/synthesize";
import { computeAnomalies, formatVanguardAnomaliesBlock } from "@/lib/digest/anomalies";
import { splitLateArrivals, renderLateArrivalsBlock } from "@/lib/digest/late-arrivals";
import { composeOvernightBlock } from "@/lib/digest/overnight";
import { composeTodaysReportersBlock } from "@/lib/digest/todays-reporters";
import { composeCallTranscriptsBlock } from "@/lib/digest/call-transcripts";
import { splitEssays, renderResearchDesk, insertCrossFilePointers } from "@/lib/digest/research-desk";
import { sanitizeThemeList } from "@/lib/gmail/theme-sanitize";
import {
  renderThinCoverageLines,
  insertBeforeAlsoCovered,
} from "@/lib/digest/thin-coverage";

// ── Alerts block ────────────────────────────────────────────────────

interface RecentAlertRow {
  symbol: string | null;
  level_type: string | null;
  price: number | null;
  price_source: string | null;
  source_author: string | null;
  triggered_price: number;
  user_response: string;
  suggested_action: string | null;
}

/**
 * Returns a markdown block summarizing alerts triggered since `sinceDate`,
 * or an empty string if none fired. Prepended to the digest so the user sees
 * actionable level crossings before article content.
 */
export function formatTriggeredAlertsSection(
  db: Database.Database,
  sinceDate: string
): string {
  // sinceDate may arrive as YYYY-MM-DD (today/since_date modes) OR a full ISO
  // timestamp (since_last mode reads last_digest_sent_at, stored as full ISO).
  // Wrap in datetime() so SQLite interprets both correctly; never string-
  // concat a time suffix — that produced "...ZT00:00:00" for the ISO form
  // and silently matched zero rows.
  const rows = db
    .prepare(
      `SELECT s.symbol, sl.level_type, sl.price, sl.price_source, sl.source_author,
              la.triggered_price, la.user_response, la.suggested_action
         FROM level_alerts la
         JOIN security_levels sl ON sl.id = la.level_id
         JOIN securities s ON s.id = la.security_id
        WHERE datetime(la.triggered_at) >= datetime(?)
        ORDER BY la.triggered_at DESC
        LIMIT 20`
    )
    .all(sinceDate) as RecentAlertRow[];

  if (rows.length === 0) return "";

  const lines: string[] = [
    `## Price Levels Triggered Since Last Digest`,
    "",
    `${rows.length} alert${rows.length === 1 ? "" : "s"} fired. Review on the [alerts page](#alerts).`,
    "",
  ];
  for (const r of rows) {
    const sym = r.symbol ?? "?";
    const lt = (r.level_type ?? "level").replace("_", " ");
    const srcLabel =
      r.price_source && r.price_source !== "static"
        ? r.price_source.toUpperCase().replace("_", " ")
        : r.price != null
          ? `$${r.price.toFixed(2)}`
          : "";
    const author = r.source_author ? ` — ${r.source_author}` : "";
    const response = r.user_response !== "pending" ? ` (${r.user_response})` : "";
    const suggestion = r.suggested_action ? ` — _${r.suggested_action}_` : "";
    lines.push(
      `- **${sym}** ${lt} ${srcLabel} hit $${r.triggered_price.toFixed(2)}${author}${response}${suggestion}`
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

// ── Last-sent tracking ──────────────────────────────────────────────

export function getLastDigestSentAt(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = 'last_digest_sent_at'`)
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function setLastDigestSentAt(db: Database.Database, isoDate: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('last_digest_sent_at', ?, datetime('now'))`
  ).run(isoDate);
}

export function getLastBriefingSentAt(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = 'last_briefing_sent_at'`)
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function setLastBriefingSentAt(db: Database.Database, isoDate: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('last_briefing_sent_at', ?, datetime('now'))`
  ).run(isoDate);
}

// ── Digest generation ───────────────────────────────────────────────

/**
 * Generate a markdown digest from research articles received since a given date.
 * Returns null if no processed articles are available.
 */
const DIGEST_ARTICLE_CAP = 30;

export function generateDigestSince(db: Database.Database, sinceDate: string): string | null {
  const windowFilter = {
    startDate: sinceDate,
    processedOnly: true,
    relevantOnly: true,
  } as const;
  const articles = getRecentArticles(db, { ...windowFilter, limit: DIGEST_ARTICLE_CAP });
  // Only worth a COUNT when the fetch saturated the cap — below it the
  // fetched set IS the window.
  const windowTotal =
    articles.length >= DIGEST_ARTICLE_CAP ? countRecentArticles(db, windowFilter) : null;

  const alertsBlock = formatTriggeredAlertsSection(db, sinceDate);

  // Send the email if EITHER articles OR alerts exist. Returning null on
  // zero-articles previously caused alerts-only mornings to silently skip
  // the digest entirely — a real case when level crossings fire overnight
  // but the newsletter mailing list is quiet.
  if (articles.length === 0 && !alertsBlock) return null;

  const now = new Date();

  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const countLine = formatArticleCountLine(
    articles.length,
    countSources(articles),
    windowTotal,
  );

  const lines: string[] = [
    `# Morning Research Digest`,
    `### ${dateStr}`,
    "",
    countLine,
    "",
    "---",
    "",
  ];

  if (alertsBlock) {
    lines.push(alertsBlock);
  }

  for (const article of articles) {
    // Source + sentiment header
    const sentiment = article.sentiment ?? "neutral";
    lines.push(`## ${article.source_name.toUpperCase()} · *${sentiment}*`);

    // Headline — link to per-article URL, or source homepage, or plain text
    const articleUrl = article.source_url || article.website_url;
    if (articleUrl) {
      lines.push(`### [${article.subject}](${articleUrl})`);
    } else {
      lines.push(`### ${article.subject}`);
    }
    lines.push("");

    // AI summary
    if (article.summary) {
      lines.push(article.summary);
      lines.push("");
    }

    // Portfolio relevance as blockquote
    if (article.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${article.portfolio_relevance}`);
      lines.push("");
    }

    // Themes
    const themes = sanitizeThemeList(parseJsonArray(article.key_themes));
    if (themes.length > 0) {
      lines.push(`*${themes.join(" · ")}*`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Generate a markdown daily digest from research articles received in the last 24 hours.
 * Legacy per-source wrapper — the cron/email paths now use generateDigestSinceAdaptive;
 * this remains for tests and the by-source preview pane.
 */
export function generateDailyDigest(db: Database.Database): string | null {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return generateDigestSince(db, yesterday.toISOString().slice(0, 10));
}

function countSources(articles: { source_name: string }[]): number {
  return new Set(articles.map((a) => a.source_name)).size;
}

/**
 * The digest count line. Every generator fetches only the N NEWEST articles
 * in the window (30 here and in the by-company view, 40 in the adaptive
 * composer), and the old line printed that N as if it were the window total
 * — so a 107-article window rendered byte-identical output to a 30-article
 * one, in the email AND the Research → Feeds preview modal, with no hint
 * anything had been dropped (QA:
 * research-digest--silently-caps-at-30-newest-articles-no-disclosure).
 *
 * `windowTotal` comes from countRecentArticles on the identical predicate.
 * Pass it only when it is known; the wording is unchanged when nothing was
 * dropped. `sources` is counted over the FETCHED set, as before.
 */
export function formatArticleCountLine(
  fetched: number,
  sources: number,
  windowTotal?: number | null,
): string {
  if (fetched === 0) {
    return "No new research articles, but price levels fired — see below.";
  }
  const sourcePart = `${sources} source${sources === 1 ? "" : "s"}`;
  if (windowTotal != null && windowTotal > fetched) {
    return `${fetched} newest of ${windowTotal} articles from ${sourcePart}`;
  }
  return `${fetched} article${fetched === 1 ? "" : "s"} from ${sourcePart}`;
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ── Adaptive digest ─────────────────────────────────────────────────────────

/** Minimum article count to attempt cross-source synthesis. */
const SYNTHESIS_MIN_ARTICLES = 5;

/** Newest-N fetch cap for the adaptive composer (disclosed in the count line). */
const ADAPTIVE_ARTICLE_CAP = 40;

/**
 * Persist a fallback event to a 30-entry ring buffer in the `settings` table.
 * Used for telemetry; errors are silently swallowed so they never block delivery.
 */
function recordSynthesisFallback(
  db: Database.Database,
  reason: string,
  articleCount: number,
): void {
  try {
    const KEY = "synthesis_fallbacks_last_30d";
    const existing = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KEY) as { value: string } | undefined;

    const ring: Array<{ date: string; reason: string; articleCount: number }> =
      existing ? JSON.parse(existing.value) : [];

    const today = new Date().toISOString().slice(0, 10);
    ring.push({ date: today, reason, articleCount });

    // Keep last 30 entries
    const trimmed = ring.slice(-30);

    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(KEY, JSON.stringify(trimmed));
  } catch {
    // Never let telemetry block email delivery
  }
}

/**
 * Query distinct held stock/ETF symbols from the portfolio.
 */
function getHeldSymbols(db: Database.Database): string[] {
  interface SymRow { symbol: string }
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE LOWER(s.security_type) IN ('stock', 'etf', 'common stock')`
    )
    .all() as SymRow[];
  return rows.map((r) => r.symbol);
}

/**
 * Query distinct watchlist symbols.
 */
function getWatchlistSymbols(db: Database.Database): string[] {
  interface SymRow { symbol: string }
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1`
    )
    .all() as SymRow[];
  return rows.map((r) => r.symbol);
}

/**
 * Enrich bucket companyName from the securities table.
 * bucketByCompany always returns companyName: null — we fill it here so
 * synthesize() can produce richer section headers.
 */
function enrichBucketCompanyNames(
  db: Database.Database,
  buckets: ReturnType<typeof bucketByCompany>,
): ReturnType<typeof bucketByCompany> {
  // Build a symbol → name map in one query
  const symbols = buckets
    .map((b) => b.symbol)
    .filter((s) => s !== "(no symbol)");

  if (symbols.length === 0) return buckets;

  const placeholders = symbols.map(() => "?").join(",");
  interface NameRow { symbol: string; name: string | null }
  const nameRows = db
    .prepare(
      `SELECT symbol, name FROM securities WHERE symbol IN (${placeholders})`
    )
    .all(...symbols) as NameRow[];

  const nameMap = new Map(nameRows.map((r) => [r.symbol, r.name]));

  return buckets.map((bucket) => ({
    ...bucket,
    companyName: nameMap.get(bucket.symbol) ?? null,
  }));
}

/**
 * Render the per-source body for the fallback / <5 articles path.
 * Matches the existing `generateDigestSince` article loop exactly.
 */
function renderPerSourceBody(
  articles: ReturnType<typeof getRecentArticles>,
): string[] {
  const lines: string[] = [];
  for (const article of articles) {
    const sentiment = article.sentiment ?? "neutral";
    lines.push(`## ${article.source_name.toUpperCase()} · *${sentiment}*`);

    const articleUrl = article.source_url || article.website_url;
    if (articleUrl) {
      lines.push(`### [${article.subject}](${articleUrl})`);
    } else {
      lines.push(`### ${article.subject}`);
    }
    lines.push("");

    if (article.summary) {
      lines.push(article.summary);
      lines.push("");
    }

    if (article.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${article.portfolio_relevance}`);
      lines.push("");
    }

    const themes = sanitizeThemeList(parseJsonArray(article.key_themes));
    if (themes.length > 0) {
      lines.push(`*${themes.join(" · ")}*`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }
  return lines;
}

/**
 * Adaptive composer: uses cross-source synthesis when ≥5 commentary articles
 * are available, falls back to per-source layout otherwise (or on synthesis
 * error). Essays are split out and rendered in a separate Research Desk section.
 *
 * @param opts.includeAnomalies - When true, includes the Vanguard anomaly
 *   block (if non-empty). Morning digest passes false; evening passes true.
 * @param opts.edition - "morning" (default) or "evening". Controls the title,
 *   session heading passed to synthesize, and late-arrivals label.
 */
export async function generateDigestSinceAdaptive(
  db: Database.Database,
  sinceDate: string,
  opts: { includeAnomalies?: boolean; edition?: "morning" | "evening" } = {},
): Promise<string | null> {
  const edition = opts.edition ?? "morning";

  const windowFilter = {
    startDate: sinceDate,
    processedOnly: true,
    relevantOnly: true,
  } as const;
  let articles = getRecentArticles(db, {
    ...windowFilter,
    limit: ADAPTIVE_ARTICLE_CAP, // raised from 30 — edition collapsing keeps synthesis input flat; covers heavy Mondays
  });
  const capSaturated = articles.length >= ADAPTIVE_ARTICLE_CAP;

  // Cap-saturation guard: late arrivals sit at the OLDEST end of the window,
  // which is exactly what the DESC limit drops first on a >40-article window
  // (heavy Monday after a missed Friday send). Re-fetch the late tranche
  // explicitly so the rescue block can never be truncated away by the cap.
  if (sinceDate.includes("T") && articles.length === ADAPTIVE_ARTICLE_CAP) {
    const lateWindowEnd = new Date(Date.parse(sinceDate) + 60 * 60 * 1000).toISOString();
    const lateTranche = getRecentArticles(db, {
      startDate: sinceDate,
      endDateTime: lateWindowEnd,
      processedOnly: true,
      relevantOnly: true,
      limit: 10,
    });
    const have = new Set(articles.map((a) => a.id));
    articles = [...articles, ...lateTranche.filter((a) => !have.has(a.id))];
  }

  const alertsBlock = formatTriggeredAlertsSection(db, sinceDate);

  // Return null only when there is genuinely nothing to say
  if (articles.length === 0 && !alertsBlock) return null;

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Counted AFTER the late-arrival rescue merge, so the line describes what
  // actually got rendered rather than the bare cap.
  const windowTotal = capSaturated ? countRecentArticles(db, windowFilter) : null;
  const countLine = formatArticleCountLine(
    articles.length,
    countSources(articles),
    windowTotal,
  );

  const title = edition === "evening" ? "# Evening Recap" : "# Morning Research Digest";
  const lines: string[] = [title, `### ${dateStr}`, "", countLine, "", "---", ""];
  let hasMarketOpening = false;

  // ── 1. Late arrivals — articles that just missed the PREVIOUS email ──────
  // Only meaningful when sinceDate is a full ISO send timestamp (the marker);
  // date-only windows (manual/sinceDate modes) have no known send time.
  const { late, rest: working } = splitLateArrivals(articles, sinceDate);
  if (late.length > 0) {
    lines.push(
      renderLateArrivalsBlock(
        late,
        edition === "evening" ? "this morning's email" : "yesterday evening's email",
      ),
    );
  }

  // ── 2. Alerts ─────────────────────────────────────────────────────────────
  if (alertsBlock) {
    lines.push(alertsBlock);
  }

  // ── 2.5 Overnight scoreboard (morning only) ───────────────────────────────
  // Deterministic Asia/BTC moves + optional VK-Dawn extract. The composer
  // never throws; null (Yahoo outage, weekend gaps) simply omits the block.
  if (edition === "morning") {
    const overnightBlock = await composeOvernightBlock(db);
    if (overnightBlock) {
      lines.push(overnightBlock);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    // ── 2.6 Today's reporters (morning only, #18) ────────────────────────────
    // Deterministic earnings schedule for today-ET — read order: what
    // happened overnight, then who prints today. Self-quiets off-season
    // (no reporters → null); never throws.
    const reportersBlock = composeTodaysReportersBlock(db);
    if (reportersBlock) {
      lines.push(reportersBlock);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    // ── 2.7 Call transcripts (morning only, #12) ──────────────────────────
    // Earnings-call transcripts fetched in the last 24h for held/watchlist
    // tickers (lib/digest/call-transcripts.ts) — the morning read completes
    // as overnight → who prints today → what last night's calls said.
    // Sync composer; never throws.
    const transcriptsBlock = composeCallTranscriptsBlock(db);
    if (transcriptsBlock) {
      lines.push(transcriptsBlock);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // ── 3. Anomalies (evening only) ───────────────────────────────────────────
  if (opts.includeAnomalies) {
    const anomalyBlock = formatVanguardAnomaliesBlock(db);
    if (anomalyBlock) {
      lines.push(anomalyBlock);
      lines.push("---");
      lines.push("");
    }
  }

  // ── 4. Split essays out of the synthesis stream ───────────────────────────
  const { essays, commentary } = splitEssays(working);

  // ── 5. Commentary body — synthesized when there's enough to synthesize ────
  if (commentary.length >= SYNTHESIS_MIN_ARTICLES) {
    const heldSymbols = getHeldSymbols(db);
    const watchlist = getWatchlistSymbols(db);
    const anomalyFlags = opts.includeAnomalies ? computeAnomalies(db) : [];
    const anomalies = anomalyFlags.map((a) => ({
      symbol: a.symbol,
      companyName: a.companyName,
    }));

    const rawBuckets = bucketByCompany(commentary);
    const enriched = enrichBucketCompanyNames(db, rawBuckets);
    const buckets = enriched;

    try {
      let synth = await synthesize({
        buckets,
        heldSymbols,
        watchlist,
        anomalies,
        sessionHeading: edition === "evening" ? "The Session" : "Overnight & Setup",
      });
      const lead = splitDigestOpening(synth);
      if (lead) {
        lines.splice(0, 7, lead.opening, "", `*${dateStr}*`, "");
        synth = lead.body;
        hasMarketOpening = true;
      }
      const crossFiled = insertCrossFilePointers(synth, essays, [...heldSymbols, ...watchlist]);
      synth = crossFiled.markdown;
      const thinLines = renderThinCoverageLines([], crossFiled.unfiled);
      if (thinLines) synth = insertBeforeAlsoCovered(synth, thinLines);
      lines.push(synth);
      lines.push("");
      lines.push("---");
      lines.push("");

    } catch (err) {
      if (err instanceof SynthesisEmptyError) {
        console.warn(`[digest] synthesis fell back to per-source: ${(err as Error).message}`);
        recordSynthesisFallback(db, (err as Error).message, commentary.length);
      } else {
        console.warn(`[digest] synthesis error (network/rate-limit), fell back to per-source: ${(err as Error).message}`);
        recordSynthesisFallback(db, `generic: ${(err as Error).message}`, commentary.length);
      }
      lines.push(...renderPerSourceBody(commentary));
    }
  } else if (commentary.length > 0) {
    // < SYNTHESIS_MIN_ARTICLES — per-source layout for the commentary stream
    lines.push(...renderPerSourceBody(commentary));
  }

  // ── 6. Research Desk — one entry per essay, rendered in code ──────────────
  const desk = renderResearchDesk(essays);
  if (desk) {
    lines.push(desk);
  }

  if (hasMarketOpening) lines.push("", countLine);
  return lines.join("\n").trim();
}
