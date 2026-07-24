import type Database from "better-sqlite3";
import { getRecentArticles } from "@/lib/queries/research";
import { formatTriggeredAlertsSection } from "./daily-digest";
import { sanitizeThemeList } from "@/lib/gmail/theme-sanitize";

export interface ArticleLike {
  id: number;
  source_name: string;
  subject: string;
  summary: string | null;
  sentiment: string | null;
  mentioned_symbols: string | null;
  portfolio_relevance: string | null;
  key_themes: string | null;
  source_url: string | null;
  website_url: string | null;
}

const NO_SYMBOL_BUCKET = "(no symbol)";

export interface CompanyBucket {
  /** Ticker symbol, or "(no symbol)" for the macro / no-ticker bucket. */
  symbol: string;
  /**
   * Display name for the company (e.g. "NVIDIA Corp"). Null when unknown or
   * when the bucket represents the macro / no-ticker group.
   */
  companyName: string | null;
  articles: ArticleLike[];
}

/**
 * Group articles by mentioned symbol. An article that mentions multiple
 * symbols appears once per symbol (deliberately — this lets each company's
 * section be self-contained when reading by-company). Articles with no
 * mentioned_symbols are collected into a single "(no symbol)" bucket so
 * macro / journal / non-ticker content still renders.
 *
 * Buckets are sorted by article count desc (most-discussed companies first),
 * with the no-symbol bucket pinned to the end.
 */
export function bucketByCompany(articles: ArticleLike[]): CompanyBucket[] {
  const buckets = new Map<string, ArticleLike[]>();

  for (const article of articles) {
    const symbols = parseSymbolList(article.mentioned_symbols);
    if (symbols.length === 0) {
      pushBucket(buckets, NO_SYMBOL_BUCKET, article);
      continue;
    }
    for (const sym of symbols) {
      pushBucket(buckets, sym, article);
    }
  }

  const result: CompanyBucket[] = [];
  for (const [symbol, bucketArticles] of buckets.entries()) {
    if (symbol === NO_SYMBOL_BUCKET) continue;
    result.push({ symbol, companyName: null, articles: bucketArticles });
  }
  result.sort((a, b) => b.articles.length - a.articles.length || a.symbol.localeCompare(b.symbol));

  const noSym = buckets.get(NO_SYMBOL_BUCKET);
  if (noSym && noSym.length > 0) {
    result.push({ symbol: NO_SYMBOL_BUCKET, companyName: null, articles: noSym });
  }

  return result;
}

function pushBucket(buckets: Map<string, ArticleLike[]>, key: string, article: ArticleLike): void {
  const list = buckets.get(key) ?? [];
  list.push(article);
  buckets.set(key, list);
}

export function parseSymbolList(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim().toUpperCase());
  } catch {
    return [];
  }
}

function parseThemes(json: string | null): string[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  // Same per-element tag-debris/mangled-string guard as the daily-digest and
  // research-desk render sites — this table (research_articles.key_themes)
  // can carry pre-guard rows contaminated with structured-output tag
  // remnants (the 2026-07-22 Research Desk leak).
  return sanitizeThemeList(arr);
}

/**
 * Render the by-company markdown view of articles. Mirrors the structure of
 * generateDigestSince() but groups by mentioned symbol instead of iterating
 * the flat per-source list. Header + alerts block are rendered once at the
 * top so the two views share their non-article chrome.
 */
export function renderDigestByCompany(
  articles: ArticleLike[],
  alertsBlock: string,
  dateStr: string,
): string {
  const buckets = bucketByCompany(articles);
  const articleSourceNames = new Set(articles.map((a) => a.source_name));

  const countLine =
    articles.length === 0
      ? "No new research articles, but price levels fired — see below."
      : `${articles.length} article${articles.length === 1 ? "" : "s"} from ${articleSourceNames.size} source${articleSourceNames.size === 1 ? "" : "s"} · grouped by company`;

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

  for (const bucket of buckets) {
    const isNoSymbol = bucket.symbol === NO_SYMBOL_BUCKET;
    const heading = isNoSymbol
      ? `## Macro / no-ticker (${bucket.articles.length})`
      : `## ${bucket.symbol} · ${bucket.articles.length} mention${bucket.articles.length === 1 ? "" : "s"}`;
    lines.push(heading);
    lines.push("");

    for (const article of bucket.articles) {
      const sentiment = article.sentiment ?? "neutral";
      const articleUrl = article.source_url || article.website_url;

      lines.push(`**${article.source_name}** · *${sentiment}*`);
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
      const themes = parseThemes(article.key_themes);
      if (themes.length > 0) {
        lines.push(`*${themes.join(" · ")}*`);
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Convenience generator that mirrors generateDigestSince's signature but
 * returns the by-company rendering. Returns null when no articles AND no
 * alerts (matches the existing behavior).
 */
export function generateDigestByCompanySince(
  db: Database.Database,
  sinceDate: string,
): string | null {
  const articles = getRecentArticles(db, {
    startDate: sinceDate,
    processedOnly: true,
    relevantOnly: true,
    limit: 30,
  });
  const alertsBlock = formatTriggeredAlertsSection(db, sinceDate);
  if (articles.length === 0 && !alertsBlock) return null;

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return renderDigestByCompany(articles, alertsBlock, dateStr);
}
