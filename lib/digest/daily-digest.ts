import type Database from "better-sqlite3";
import { getRecentArticles } from "@/lib/queries/research";

/**
 * Generate a markdown daily digest from research articles received in the last 24 hours.
 * Returns null if no processed articles are available.
 */
export function generateDailyDigest(db: Database.Database): string | null {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startDate = yesterday.toISOString().slice(0, 10);

  const articles = getRecentArticles(db, {
    startDate,
    processedOnly: true,
    limit: 30,
  });

  if (articles.length === 0) return null;

  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const lines: string[] = [
    `# Morning Research Digest`,
    `### ${dateStr}`,
    "",
    `${articles.length} article${articles.length === 1 ? "" : "s"} from ${countSources(articles)} source${countSources(articles) === 1 ? "" : "s"}`,
    "",
    "---",
    "",
  ];

  for (const article of articles) {
    // Source + sentiment header
    const sentiment = article.sentiment ?? "neutral";
    lines.push(`## ${article.source_name.toUpperCase()} · *${sentiment}*`);

    // Headline
    lines.push(`### ${article.subject}`);
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
