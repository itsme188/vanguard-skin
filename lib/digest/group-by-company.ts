import type Database from "better-sqlite3";
import { getRecentArticles, countRecentArticles } from "@/lib/queries/research";
import { formatTriggeredAlertsSection, formatArticleCountLine } from "./daily-digest";
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
 * symbols appears once per symbol — this is the MENTION view, used to rank
 * companies and to build the AI synthesis buckets (each company's prompt
 * section is self-contained). Articles with no mentioned_symbols are
 * collected into a single "(no symbol)" bucket so macro / journal /
 * non-ticker content still participates.
 *
 * Buckets are sorted by article count desc (most-discussed companies first),
 * with the no-symbol bucket pinned to the end.
 *
 * NOT the rendering view: fanning an article out into every mentioned symbol
 * and re-printing its full block under each one made a 30-article window
 * render ~845 KB of HTML (8x Gmail's clip threshold). `renderDigestByCompany`
 * uses `homeArticlesByCompany` instead, which keeps this ranking but prints
 * each article once.
 */
export function bucketByCompany(articles: ArticleLike[]): CompanyBucket[] {
  const buckets = new Map<string, ArticleLike[]>();

  for (const article of articles) {
    const symbols = dedupedSymbolList(article.mentioned_symbols);
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

export interface HomedCompanyBucket extends CompanyBucket {
  /**
   * How many articles in the window MENTION this symbol, including the ones
   * homed under a different (higher-ranked) company. Always >= articles.length.
   */
  mentionCount: number;
}

/**
 * Assign every article to exactly ONE company bucket: its highest-ranked
 * mentioned symbol, ranking being the `bucketByCompany` order (mention count
 * desc, ties alphabetical, macro last). Articles with no mentioned symbols go
 * to the macro / no-ticker bucket.
 *
 * Buckets come back in that same ranking order, minus any bucket that ends up
 * with zero homed articles (every article mentioning it is filed under a
 * bigger story). Each surviving bucket also carries the symbol's total mention
 * count so the renderer can say how much of the coverage sits elsewhere.
 *
 * Output size is therefore bounded by the number of ARTICLES, not by
 * articles x symbols.
 */
export function homeArticlesByCompany(articles: ArticleLike[]): HomedCompanyBucket[] {
  const ranked = bucketByCompany(articles);
  const rankOf = new Map<string, number>();
  ranked.forEach((bucket, index) => rankOf.set(bucket.symbol, index));

  const homed = new Map<string, ArticleLike[]>();
  for (const article of articles) {
    let home = NO_SYMBOL_BUCKET;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const symbol of dedupedSymbolList(article.mentioned_symbols)) {
      const rank = rankOf.get(symbol);
      if (rank != null && rank < bestRank) {
        bestRank = rank;
        home = symbol;
      }
    }
    pushBucket(homed, home, article);
  }

  const result: HomedCompanyBucket[] = [];
  for (const bucket of ranked) {
    const homedArticles = homed.get(bucket.symbol);
    if (!homedArticles || homedArticles.length === 0) continue;
    result.push({
      symbol: bucket.symbol,
      companyName: bucket.companyName,
      articles: homedArticles,
      mentionCount: bucket.articles.length,
    });
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

/**
 * `parseSymbolList` does not dedupe — an article whose mentioned_symbols
 * carries the same ticker twice with different case (["nvda","NVDA"]) or
 * padding ([" AAPL","AAPL"]) both uppercase/trim to the same string. Bucket
 * membership, home selection, and the mention chips all need the DEDUPED
 * list — otherwise a single mention gets counted (and, in bucketByCompany,
 * pushed) twice, inflating mentionCount and the "(also mentioned in N
 * articles filed under other companies)" disclosure with a false elsewhere
 * count. `parseSymbolList` itself stays non-deduping because
 * `lib/digest/thin-coverage.ts` uses its raw length for a breadth check.
 */
function dedupedSymbolList(json: string | null): string[] {
  return [...new Set(parseSymbolList(json))];
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
 * generateDigestSince() but groups by company instead of iterating the flat
 * per-source list. Header + alerts block are rendered once at the top so the
 * two views share their non-article chrome.
 *
 * Each article is printed ONCE, under the company that leads its coverage;
 * the rest of its mentioned symbols follow as a chips line directly beneath
 * the article's headline. A heading whose symbol is also mentioned by
 * articles filed elsewhere says so in one line.
 */
export function renderDigestByCompany(
  articles: ArticleLike[],
  alertsBlock: string,
  dateStr: string,
  /**
   * Total articles in the window, from countRecentArticles on the identical
   * predicate. When it exceeds `articles.length` the count line says so
   * instead of passing the fetch cap off as the window total.
   */
  windowTotal?: number | null,
): string {
  const buckets = homeArticlesByCompany(articles);
  const articleSourceNames = new Set(articles.map((a) => a.source_name));

  const baseCountLine = formatArticleCountLine(
    articles.length,
    articleSourceNames.size,
    windowTotal,
  );
  const countLine =
    articles.length === 0 ? baseCountLine : `${baseCountLine} · grouped by company`;

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
    const homedCount = bucket.articles.length;
    const heading = isNoSymbol
      ? `## Macro / no-ticker (${homedCount})`
      : `## ${bucket.symbol} · ${homedCount} article${homedCount === 1 ? "" : "s"}`;
    lines.push(heading);
    lines.push("");

    const elsewhere = bucket.mentionCount - homedCount;
    if (!isNoSymbol && elsewhere > 0) {
      lines.push(
        `*(also mentioned in ${elsewhere} article${elsewhere === 1 ? "" : "s"} filed under other companies)*`,
      );
      lines.push("");
    }

    for (const article of bucket.articles) {
      const sentiment = article.sentiment ?? "neutral";
      const articleUrl = article.source_url || article.website_url;
      const mentions = dedupedSymbolList(article.mentioned_symbols);

      lines.push(`**${article.source_name}** · *${sentiment}*`);
      if (articleUrl) {
        lines.push(`### [${article.subject}](${articleUrl})`);
      } else {
        lines.push(`### ${article.subject}`);
      }
      lines.push("");

      // Chips sit UNDER the headline — the subject leads the block.
      if (mentions.length > 0) {
        lines.push(`Mentions: ${mentions.join(" · ")}`);
        lines.push("");
      }

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
const BY_COMPANY_ARTICLE_CAP = 30;

export function generateDigestByCompanySince(
  db: Database.Database,
  sinceDate: string,
): string | null {
  const windowFilter = {
    startDate: sinceDate,
    processedOnly: true,
    relevantOnly: true,
  } as const;
  const articles = getRecentArticles(db, {
    ...windowFilter,
    limit: BY_COMPANY_ARTICLE_CAP,
  });
  // Only worth a COUNT when the fetch saturated the cap.
  const windowTotal =
    articles.length >= BY_COMPANY_ARTICLE_CAP ? countRecentArticles(db, windowFilter) : null;
  const alertsBlock = formatTriggeredAlertsSection(db, sinceDate);
  if (articles.length === 0 && !alertsBlock) return null;

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return renderDigestByCompany(articles, alertsBlock, dateStr, windowTotal);
}
