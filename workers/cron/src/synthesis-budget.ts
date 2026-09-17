import { editionLabel } from "./editions";
import { issuerSiblings } from "./fallback-earnings";
import type { RecentArticleMeta } from "./state";
type CompanyBucket = { symbol: string; companyName: string | null; articles: RecentArticleMeta[] };

// Budget implementation mirrored in lib/digest and workers/cron/src; parity-tested.
const NO_SYMBOL_BUCKET = "(no symbol)";

/**
 * Render one bucket to a compact markdown block for the user prompt.
 *
 *   ## NVDA (NVIDIA Corp)
 *   - Vital Knowledge (bullish) [https://...]: <summary>
 */
export function renderBucket(bucket: CompanyBucket): string {
  const isNoSymbol = bucket.symbol === NO_SYMBOL_BUCKET;
  let heading: string;
  if (isNoSymbol) {
    heading = "## Macro";
  } else if (bucket.companyName) {
    heading = `## ${bucket.symbol} (${bucket.companyName})`;
  } else {
    heading = `## ${bucket.symbol}`;
  }

  const lines: string[] = [heading];
  for (const article of bucket.articles) {
    const sentiment = article.sentiment ?? "neutral";
    const url = article.source_url || article.website_url;
    const urlPart = url ? ` [${url}]` : "";
    const summaryText = article.summary ?? article.subject ?? "(no summary)";
    lines.push(
      `- ${article.source_name}${editionLabel(article.source_name, article.subject)} (${sentiment})${urlPart}: ${summaryText}`,
    );
  }

  return lines.join("\n");
}

// ─── Prompt bounding ──────────────────────────────────────────────────────────

/**
 * Caps that keep the synthesis call inside the model's context window.
 *
 * Articles mentioning many symbols are repeated across buckets. Bound that
 * duplication before requesting synthesis; a length finish alone cannot tell
 * us whether the model reached its context or output limit.
 *
 * `maxTotalChars` is the real bound; the per-bucket caps shape what fits.
 */
export const DEFAULT_SYNTHESIS_LIMITS = {
  /** Hard ceiling on rendered buckets (the macro bucket occupies slot 1). */
  maxBuckets: 30,
  /** Article lines rendered per bucket, keeping the bucket's own order. */
  maxArticlesPerBucket: 6,
  /** Per-line summary cap (truncateAtWord adds an ellipsis). */
  maxSummaryChars: 700,
  /** Total rendered-bucket character budget for the user prompt. */
  maxTotalChars: 60_000,
} as const;

export interface ResolvedSynthesisLimits {
  maxBuckets: number;
  maxArticlesPerBucket: number;
  maxSummaryChars: number;
  maxTotalChars: number;
}

export type SynthesisBucketLimits = Partial<ResolvedSynthesisLimits>;

export interface BoundedSynthesisBuckets {
  /** Buckets rendered in full, in the order the model should read them. */
  priority: CompanyBucket[];
  /** Symbols that did not fit — disclosed as one compact line, sorted. */
  overflowSymbols: string[];
  limited: boolean;
}

export interface SynthesisPriorityContext {
  heldSymbols: string[];
  watchlist: string[];
  anomalySymbols: string[];
}

function upperSet(symbols: string[]): Set<string> {
  return new Set(symbols.filter(Boolean).map((s) => s.toUpperCase()));
}

/** 1 = anomaly, 2 = held, 3 = watchlist, 4 = everything else. */
function bucketRank(
  symbol: string,
  anomalies: Set<string>,
  held: Set<string>,
  watchlist: Set<string>,
): number {
  const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
  if (family.some((s) => anomalies.has(s))) return 1;
  if (family.some((s) => held.has(s))) return 2;
  if (family.some((s) => watchlist.has(s))) return 3;
  return 4;
}

/** Copy a bucket with its article list and summary lines capped. Pure. */
function trimBucket(
  bucket: CompanyBucket,
  limits: ResolvedSynthesisLimits,
): CompanyBucket {
  const articles = bucket.articles
    .slice(0, limits.maxArticlesPerBucket)
    .map((article) => {
      const summary = article.summary ?? article.subject;
      if (summary == null || summary.length <= limits.maxSummaryChars) return article;
      return {
        ...article,
        summary: truncateAtWord(
          summary.replace(/\s+/g, " ").trim(),
          limits.maxSummaryChars,
        ),
      };
    });
  return { ...bucket, articles };
}

/**
 * Pick the buckets worth spending context on and cap what each one renders.
 *
 * Priority: the Macro / no-symbol bucket ranks first (it is the source of
 * the lead session section), then anomaly symbols, then held (issuerSiblings-
 * aware, so a held GOOG keeps the GOOGL bucket — same rule
 * `partitionListingOnlyHeldBuckets` uses), then watchlist, then the remaining
 * buckets by article count. Selection stops at the first bucket that would
 * breach `maxBuckets` or `maxTotalChars`; every bucket from there on is
 * overflow, so a low-priority bucket can never displace a higher-priority one.
 *
 * Pure — the input buckets are never mutated. Exported for tests.
 */
export function boundSynthesisBuckets(
  buckets: CompanyBucket[],
  context: SynthesisPriorityContext,
  limits?: SynthesisBucketLimits,
): BoundedSynthesisBuckets {
  const lim: ResolvedSynthesisLimits = { ...DEFAULT_SYNTHESIS_LIMITS, ...(limits ?? {}) };
  const anomalies = upperSet(context.anomalySymbols);
  const held = upperSet(context.heldSymbols);
  const watchlist = upperSet(context.watchlist);

  const macro = buckets.filter((b) => b.symbol === NO_SYMBOL_BUCKET);
  const symbolBuckets = buckets.filter((b) => b.symbol !== NO_SYMBOL_BUCKET);

  const ranked = [...symbolBuckets].sort((a, b) => {
    const ra = bucketRank(a.symbol, anomalies, held, watchlist);
    const rb = bucketRank(b.symbol, anomalies, held, watchlist);
    if (ra !== rb) return ra - rb;
    if (a.articles.length !== b.articles.length) return b.articles.length - a.articles.length;
    return a.symbol.localeCompare(b.symbol);
  });

  const priority: CompanyBucket[] = [];
  const overflowSymbols: string[] = [];
  let used = 0;

  let stopped = false;
  for (const bucket of [...macro, ...ranked]) {
    if (stopped) {
      overflowSymbols.push(bucket.symbol === NO_SYMBOL_BUCKET ? "Macro" : bucket.symbol);
      continue;
    }
    const trimmed = trimBucket(bucket, lim);
    const size = renderBucket(trimmed).length + 2;
    if (priority.length >= lim.maxBuckets || used + size > lim.maxTotalChars) {
      stopped = true;
      overflowSymbols.push(bucket.symbol === NO_SYMBOL_BUCKET ? "Macro" : bucket.symbol);
      continue;
    }
    priority.push(trimmed);
    used += size;
  }

  overflowSymbols.sort();
  const limited = overflowSymbols.length > 0 || priority.some((bucket) => {
    const original = buckets.find((b) => b.symbol === bucket.symbol)!;
    return original.articles.length !== bucket.articles.length ||
      bucket.articles.some((article, i) => article.summary !== original.articles[i].summary);
  });
  return { priority, overflowSymbols, limited };
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}


/** Deterministic disclosure; never depend on the model repeating prompt metadata. */
export function synthesisCoverageNotice(bounded: BoundedSynthesisBuckets): string {
  if (!bounded.limited) return "";
  const overflow = bounded.overflowSymbols.length
    ? ` ${bounded.overflowSymbols.length} additional company/topic buckets were outside the AI input.`
    : "";
  return `*Coverage note: AI synthesis uses a limited selection of sources and shortened summaries. Related stories may be grouped; ticker mentions without substantive commentary are omitted.${overflow}*`;
}
