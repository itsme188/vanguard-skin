import type Database from "better-sqlite3";
import { getRecentArticles } from "@/lib/queries/research";

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
    .all(sinceDate + "T00:00:00") as RecentAlertRow[];

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
export function generateDigestSince(db: Database.Database, sinceDate: string): string | null {
  const articles = getRecentArticles(db, {
    startDate: sinceDate,
    processedOnly: true,
    limit: 30,
  });

  if (articles.length === 0) return null;

  const now = new Date();

  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const alertsBlock = formatTriggeredAlertsSection(db, sinceDate);

  const lines: string[] = [
    `# Morning Research Digest`,
    `### ${dateStr}`,
    "",
    `${articles.length} article${articles.length === 1 ? "" : "s"} from ${countSources(articles)} source${countSources(articles) === 1 ? "" : "s"}`,
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
    const themes = parseJsonArray(article.key_themes);
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
 * Backward-compatible wrapper for the cron job.
 */
export function generateDailyDigest(db: Database.Database): string | null {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return generateDigestSince(db, yesterday.toISOString().slice(0, 10));
}

function countSources(articles: { source_name: string }[]): number {
  return new Set(articles.map((a) => a.source_name)).size;
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
