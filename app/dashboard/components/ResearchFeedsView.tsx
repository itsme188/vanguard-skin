"use client";

import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  ResearchArticle,
  ResearchSource,
  FilteredArticle,
  FilteredArticleCategoryCount,
} from "@/lib/queries/research";
import { trimEmailFooter, htmlHidesStoredText } from "@/lib/gmail/sanitize";
import { sanitizeModelSummary, sanitizeThemeList } from "@/lib/gmail/theme-sanitize";
import { Chip } from "./Chip";
import { ScrollFade } from "./ScrollFade";
import { ManageSourcesModal } from "./ManageSourcesModal";
import { NewsletterArticleFrame } from "./NewsletterArticleFrame";
import { SendDigestPanel } from "./SendDigestPanel";
import { DigestEmailViewer } from "./DigestEmailViewer";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useResearchSync } from "@/lib/hooks/useResearchSync";
import {
  errorFeedback,
  nextFeedback,
  progressFeedback,
  readSyncFailure,
  shouldAutoDismiss,
  type SyncFeedback,
} from "@/lib/research/sync-feedback";
import { PrivateText } from "@/lib/privacy/components";
import { useToast } from "./Toast";
import apiFetch from "@/lib/http/apiFetch";

interface Props {
  initialArticles: ResearchArticle[];
  sources: ResearchSource[];
  initialSymbolMap: Record<string, number>;
  /** D5 — articles flipped to is_relevant=0 by D1/D2 short-circuit or D3 gate. */
  initialFilteredArticles: FilteredArticle[];
  initialFilteredCount: number;
  /** Full-set per-category counts for the Filtered list's section headers —
   *  never derived from initialFilteredArticles, which is page-capped. */
  initialFilteredCategoryCounts: FilteredArticleCategoryCount[];
  /** How many articles the main feed holds under the filter `initialArticles`
   *  was read with (same predicate, no limit). Null when the page did not count. */
  initialTotal?: number | null;
  /** `?symbol=` from the URL, resolved by the page. Null = no symbol filter. */
  symbolFilter?: FeedSymbolFilter | null;
  /** The raw `?article=` value, or null. */
  linkedArticleParam?: string | null;
  /** The row `?article=` names, or null when there is no such article. */
  linkedArticle?: ResearchArticle | null;
}

/**
 * The feed's symbol filter. It is the route's existing `securityId` filter
 * (articles linked to that security), so the list and its count stay on one
 * predicate. `securityId` is null when no security carries the symbol.
 */
export interface FeedSymbolFilter {
  symbol: string;
  securityId: number | null;
}

/** Matches the server's default `limit` for the filtered=1 endpoint. */
const FILTERED_PAGE_SIZE = 100;

/** Matches the server's default `limit` for the main feed; Load more adds one page. */
const FEED_PAGE_SIZE = 50;

/** The most rows the articles route returns in one request (its MAX_LIMIT). */
export const FEED_MAX_LIMIT = 500;

/** Shown in place of Load more once the list has reached FEED_MAX_LIMIT. */
export const FEED_CAP_NOTICE = `This list shows the newest ${FEED_MAX_LIMIT} articles at most. To reach an older article, search for it or pick a source.`;

// ── Sentiment helpers ────────────────────────────────────────────────

const sentimentColors: Record<string, string> = {
  bullish: "bg-up/20 text-up",
  bearish: "bg-down/20 text-down",
  neutral: "bg-raised text-ink-dim",
  mixed: "bg-gold/20 text-gold-ink",
};

const sentimentBorder: Record<string, string> = {
  bullish: "border-l-up",
  bearish: "border-l-down",
  mixed: "border-l-gold",
  neutral: "border-l-edge-strong",
};

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sentimentColors[sentiment] || sentimentColors.neutral}`}>
      {sentiment}
    </span>
  );
}

// ── Pills ────────────────────────────────────────────────────────────

/** How many symbol pills a collapsed card shows before "+N more". */
const COLLAPSED_SYMBOL_LIMIT = 6;

/**
 * The symbols a card renders and how many it holds back. An expanded card
 * shows every symbol, so "+N more" always resolves by opening the card.
 */
export function visibleSymbols(
  symbols: string[],
  showAll: boolean,
): { shown: string[]; hidden: number } {
  if (showAll) return { shown: symbols, hidden: 0 };
  const shown = symbols.slice(0, COLLAPSED_SYMBOL_LIMIT);
  return { shown, hidden: symbols.length - shown.length };
}

function SymbolPills({
  symbolsJson,
  symbolMap,
  showAll = false,
}: {
  symbolsJson: string | null;
  symbolMap: Record<string, number>;
  /** True on an expanded card: render the whole list. */
  showAll?: boolean;
}) {
  if (!symbolsJson) return null;
  let symbols: string[];
  try {
    const parsed = JSON.parse(symbolsJson);
    if (!Array.isArray(parsed)) return null;
    symbols = parsed;
  } catch { return null; }
  if (symbols.length === 0) return null;
  const { shown, hidden } = visibleSymbols(symbols, showAll);

  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((s) => {
        const secId = symbolMap[s];
        return secId ? (
          <Link
            key={s}
            href={`/dashboard/security/${secId}`}
            // T2 (finding #8): dozens of these links per card, wrapped both
            // axes at gap-1.5 (6px) — after:-inset-1 gives real hit-area
            // growth; the ~2px mutual overlap between adjacent chips'
            // extensions is an acceptable trade-off vs. a dead zone between
            // them (the chip's own visible box stays the primary target).
            className="relative px-2 py-0.5 rounded bg-blue/20 text-blue text-xs font-mono font-medium hover:bg-blue/30 transition-colors pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-1"
          >
            {s}
          </Link>
        ) : (
          <span key={s} className="px-2 py-0.5 rounded bg-raised text-ink-faint text-xs font-mono">
            {s}
          </span>
        );
      })}
      {hidden > 0 && (
        <span className="text-xs text-ink-faint" title="Open the article to see every symbol">
          +{hidden} more
        </span>
      )}
    </div>
  );
}

function ThemePills({ themesJson }: { themesJson: string | null }) {
  if (!themesJson) return null;
  let themes: string[];
  try {
    const parsed = JSON.parse(themesJson);
    if (!Array.isArray(parsed)) return null;
    themes = sanitizeThemeList(parsed);
  } catch { return null; }
  if (themes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {themes.map((t) => (
        <span key={t} className="px-2 py-0.5 rounded bg-raised text-ink-faint text-xs">
          {t}
        </span>
      ))}
    </div>
  );
}

/**
 * A source is selectable in the filter dropdown/fallback logic when it owns
 * at least one article the feed can show (processed). Whether the source is
 * still ACTIVE does not matter: deactivating stops future fetching, but its
 * articles stay in the feed, so they must stay reachable through the filter.
 * Shared between the dropdown options list and handleSourcesChanged's "is the
 * current filter still valid" check so the two never drift.
 */
export function isSelectableSource(s: ResearchSource): boolean {
  return (s.processed_article_count ?? 0) > 0;
}

/** Dropdown text for a source: its feed count, and "(inactive)" when it no longer syncs. */
export function sourceOptionLabel(s: ResearchSource): string {
  const count = (s.processed_article_count ?? 0).toLocaleString("en-US");
  return `${s.name} (${count})${s.is_active ? "" : " (inactive)"}`;
}

/**
 * How many articles the main feed holds for the current source selection,
 * from the per-source feed counts (same predicate as the list: processed
 * only). Not known under a text search, where the caller passes no total.
 */
export function feedTotalForSource(sources: ResearchSource[], sourceId: number | null): number {
  return sources
    .filter((s) => sourceId === null || s.id === sourceId)
    .reduce((sum, s) => sum + (s.processed_article_count ?? 0), 0);
}

/**
 * The line above the main feed: how much of the set is on screen, and which
 * search the list reflects. `total` is null when the server sent no count.
 * `hasMore` says whether Load more would fetch older articles.
 */
export function describeFeedWindow(input: {
  shown: number;
  total: number | null;
  pageLimit: number;
  search: string;
}): { text: string; hasMore: boolean } {
  const { shown, total, pageLimit, search } = input;
  const n = shown.toLocaleString("en-US");
  if (search && total != null) {
    // The server counted the matches: say exactly how many there are.
    const allMatches = Math.max(total, shown);
    const hasMore = shown < allMatches;
    return {
      text: hasMore
        ? `Showing the newest ${n} of ${allMatches.toLocaleString("en-US")} matches for "${search}"`
        : `${n} match${shown === 1 ? "" : "es"} for "${search}"`,
      hasMore,
    };
  }
  if (search) {
    // No count: the list was cut at the page limit, so older matches may exist.
    const hasMore = shown >= pageLimit;
    return {
      text: hasMore
        ? `Showing the newest ${n} matches for "${search}"`
        : `${n} match${shown === 1 ? "" : "es"} for "${search}"`,
      hasMore,
    };
  }
  // A count read before the latest sync can trail the list; never print N of fewer-than-N.
  const all = Math.max(total ?? shown, shown);
  const hasMore = shown < all;
  return {
    text: hasMore
      ? `Showing the newest ${n} of ${all.toLocaleString("en-US")} articles`
      : `${n} article${shown === 1 ? "" : "s"}`,
    hasMore,
  };
}

/**
 * The status line when a manual sync finishes. An account-level AI failure
 * (the sync route's `accountFailureMessage`) is appended and made sticky, so
 * "Done" never hides that articles were left unanalysed.
 */
export function syncCompletionFeedback(
  totalFetched: number,
  accountFailureMessage: unknown,
): SyncFeedback {
  const done =
    totalFetched > 0
      ? `Done — ${totalFetched} new article${totalFetched !== 1 ? "s" : ""}`
      : "Up to date — no new articles";
  const failure = typeof accountFailureMessage === "string" ? accountFailureMessage.trim() : "";
  return failure ? errorFeedback(`${done}. ${failure}`) : progressFeedback(done);
}

/** What `?article=<id>` asks the feed to do. */
export type LinkedArticleRequest =
  | { kind: "none" }
  /** Open this article: in the list if it is loaded, else pinned above it. */
  | { kind: "open"; id: number }
  /** The article cannot be shown in the feed; say why. */
  | { kind: "notice"; text: string };

/**
 * Decide what a deep link to one article does. The feed's own rule applies:
 * it lists analysed articles only (processed_at set), filtered ones included
 * (those carry the Filtered marker on their card).
 */
export function resolveLinkedArticle(
  param: string | null | undefined,
  article: Pick<ResearchArticle, "id" | "processed_at" | "is_relevant"> | null | undefined,
): LinkedArticleRequest {
  const raw = (param ?? "").trim();
  if (!raw) return { kind: "none" };
  if (!/^\d+$/.test(raw)) {
    return { kind: "notice", text: "The link to one article is not valid, so no article was opened." };
  }
  if (!article) {
    return {
      kind: "notice",
      text: `Article ${raw} was not found. It may have been deleted.`,
    };
  }
  if (article.processed_at == null) {
    return {
      kind: "notice",
      text:
        article.is_relevant === 0
          ? "The linked article was filtered out before AI analysis, so it is not in this list. It is in the Filtered tab."
          : "The linked article has not been analysed by AI yet, so it is not in this list. It appears after the next feed sync has analysed it.",
    };
  }
  return { kind: "open", id: article.id };
}

/** Shown while the search box holds a single character (the search needs two). */
export const SEARCH_TOO_SHORT_HINT =
  "Type at least 2 characters to search. The list below has not changed.";

// ── Main view ────────────────────────────────────────────────────────

export function ResearchFeedsView({
  initialArticles,
  sources,
  initialSymbolMap,
  initialFilteredArticles,
  initialFilteredCount,
  initialFilteredCategoryCounts,
  initialTotal = null,
  symbolFilter = null,
  linkedArticleParam = null,
  linkedArticle = null,
}: Props) {
  const isMobile = useIsMobile();
  const router = useRouter();
  const searchParams = useSearchParams();
  // The exact size of the set the list on screen was read from (the route's
  // `total`: same filter as the list, no limit). Null until a count is known.
  const [feedTotal, setFeedTotal] = useState<number | null>(initialTotal);
  const [articles, setArticles] = useState(initialArticles);
  const [symbolMap, setSymbolMap] = useState<Record<string, number>>(initialSymbolMap);
  const [currentSources, setCurrentSources] = useState(sources);
  const [sourceFilter, setSourceFilter] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // The search the main list on screen was actually fetched with. It trails
  // `searchQuery` while the box holds one character or a fetch failed.
  const [appliedSearch, setAppliedSearch] = useState("");
  const [articleLimit, setArticleLimit] = useState(FEED_PAGE_SIZE);
  const [loadingMoreArticles, setLoadingMoreArticles] = useState(false);
  // `syncing` is the MANUAL sync only — it gates the button. The background
  // auto-sync uses `bgSyncing` so it can never make the button inert.
  const [syncing, setSyncing] = useState(false);
  const [bgSyncing, setBgSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<SyncFeedback | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const [expandedHtml, setExpandedHtml] = useState<string | null>(null);
  const [loadingExpand, setLoadingExpand] = useState(false);
  // D5 — filtered articles state lives alongside the main feed; toggling the
  // "Filtered" pill swaps render branches but reuses the rest of the chrome.
  const [viewMode, setViewMode] = useState<"all" | "filtered">("all");
  const [filteredArticles, setFilteredArticles] = useState<FilteredArticle[]>(initialFilteredArticles);
  const [filteredCount, setFilteredCount] = useState(initialFilteredCount);
  // Full-set per-category counts for the CURRENT sourceId/search predicate —
  // qa fix: the section headers must render from this, never from
  // filteredArticles.length, or they silently undercount past the page cap.
  const [filteredCategoryCounts, setFilteredCategoryCounts] = useState<FilteredArticleCategoryCount[]>(
    initialFilteredCategoryCounts,
  );
  const [loadingMoreFiltered, setLoadingMoreFiltered] = useState(false);
  const filteredTotal = filteredCategoryCounts.reduce((sum, c) => sum + c.count, 0);
  const filteredRemaining = Math.max(0, filteredTotal - filteredArticles.length);

  // Re-read the filtered list from the server (first page, no source/search
  // narrowing, same as the page's initial load). Returns false when the list
  // could not be refreshed, so the caller can say so.
  const reloadFilteredList = useCallback(async (): Promise<boolean> => {
    try {
      const reload = await fetch(`/api/research/articles?filtered=1&limit=${FILTERED_PAGE_SIZE}`);
      const data = await reload.json().catch(() => null);
      if (!reload.ok || !data?.success) return false;
      setFilteredArticles(data.data ?? []);
      const counts: FilteredArticleCategoryCount[] = data.categoryCounts ?? [];
      setFilteredCategoryCounts(counts);
      // This reload has no sourceId/search — its total is the true
      // global count, same thing getFilteredArticleCount would return.
      setFilteredCount(counts.reduce((sum, c) => sum + c.count, 0));
      return true;
    } catch {
      // No answer from the server: the caller reports it.
      return false;
    }
  }, []);

  // Unfilter and Retry enrichment both take a row OUT of the filtered list, so
  // they share one handler: optimistic removal, then the server's answer
  // decides. After a refusal, or a request whose outcome is unknown, the list
  // is re-read from the server so the screen shows what is really stored.
  const releaseFilteredArticle = useCallback(async (articleId: number, action: FilteredRowAction) => {
    const copy = FILTERED_ROW_ACTION_COPY[action];
    const before = {
      articles: filteredArticles,
      count: filteredCount,
      categoryCounts: filteredCategoryCounts,
    };
    const restoreBefore = () => {
      setFilteredArticles(before.articles);
      setFilteredCount(before.count);
      setFilteredCategoryCounts(before.categoryCounts);
    };
    // Optimistic removal — flicker would be worse than a race-loss on failure.
    const removed = filteredArticles.find((a) => a.id === articleId);
    const removedCategory = removed?.excluded_category || "other";
    setFilteredArticles((prev) => prev.filter((a) => a.id !== articleId));
    setFilteredCount((n) => Math.max(0, n - 1));
    setFilteredCategoryCounts((prev) =>
      prev
        .map((c) => (c.category === removedCategory ? { ...c, count: Math.max(0, c.count - 1) } : c))
        .filter((c) => c.count > 0),
    );

    let res: Response;
    try {
      res = await apiFetch(`/api/research/articles/${articleId}/${copy.endpoint}`, {
        method: "POST",
      });
    } catch {
      // The request did not complete. It may have reached the server before
      // the connection dropped, so whether the article changed is NOT known:
      // say that, and re-read the list instead of guessing either way.
      const reloaded = await reloadFilteredList();
      if (reloaded) {
        toast(
          `The request to ${copy.verb} the article did not complete, so it may or may not have gone through. The filtered list has been reloaded from the server: if the article is still listed, try again.`,
          "error",
        );
      } else {
        restoreBefore();
        toast(
          `The request to ${copy.verb} the article did not complete, and the filtered list could not be reloaded either. The article may or may not have changed; the list shown may be out of date until the server is reachable again.`,
          "error",
        );
      }
      return;
    }

    const result = await readMutationResult<{ data?: { requeued?: boolean } }>(res);
    if (!result.ok) {
      // The server refused and changed nothing. Explain, or the reappearing
      // row looks like a glitch; then re-read the list.
      const reloaded = await reloadFilteredList();
      if (!reloaded) restoreBefore();
      toast(
        `Couldn't ${copy.verb} the article: ${result.message} It stays in the filtered list.` +
          (reloaded ? "" : " The list could not be refreshed and may be out of date."),
        "error",
      );
      return;
    }
    if (result.data.data?.requeued) {
      // The article has no enrichment yet, so it will not show in the feed
      // until a sync has analysed it. Say where it went.
      toast(REQUEUED_FOR_ENRICHMENT_NOTICE, "success");
      // Its card (if loaded) is no longer a processed article.
      setArticles((prev) => prev.filter((a) => a.id !== articleId));
      return;
    }
    // Unfiltered as it is. Say where the article is now: a row the AI never
    // analysed is in neither list until a sync processes it, and without
    // this message it simply vanishes.
    const outcome = describeUnfilterOutcome(removed?.processed_at ?? null);
    toast(outcome.text, outcome.tone);
    // Its card in All articles (if loaded) drops the Filtered marker now.
    setArticles((prev) =>
      prev.map((a) => (a.id === articleId ? { ...a, is_relevant: 1, excluded_category: null } : a)),
    );
  }, [toast, filteredArticles, filteredCount, filteredCategoryCounts, reloadFilteredList]);

  const handleUnfilter = useCallback(
    (articleId: number) => releaseFilteredArticle(articleId, "unfilter"),
    [releaseFilteredArticle],
  );
  const handleRetryEnrichment = useCallback(
    (articleId: number) => releaseFilteredArticle(articleId, "retry"),
    [releaseFilteredArticle],
  );

  const handleLoadMoreFiltered = useCallback(async () => {
    setLoadingMoreFiltered(true);
    try {
      const params = new URLSearchParams({
        filtered: "1",
        limit: String(FILTERED_PAGE_SIZE),
        offset: String(filteredArticles.length),
      });
      if (sourceFilter) params.set("sourceId", String(sourceFilter));
      if (searchQuery.length >= 2) params.set("search", searchQuery);
      const res = await fetch(`/api/research/articles?${params}`);
      const data = await res.json();
      if (res.ok && data.success) {
        setFilteredArticles((prev) => [...prev, ...(data.data ?? [])]);
        if (data.categoryCounts) setFilteredCategoryCounts(data.categoryCounts);
      } else {
        toast(`Couldn't load more filtered articles (server returned ${res.status}).`, "error");
      }
    } catch {
      toast("Load more failed — check your connection and try again.", "error");
    } finally {
      setLoadingMoreFiltered(false);
    }
  }, [filteredArticles.length, sourceFilter, searchQuery, toast]);

  // qa:research-feeds-filtered--search-and-source-controls-noop — the Filtered
  // audit list honors the same toolbar controls as the main feed. Refetch
  // whenever the tab is active and search/source change (the API's filtered=1
  // branch now accepts both params). A failed refetch keeps the current list.
  // This always fetches page 1 (offset 0) — a search/source change resets
  // any "Load more" progress, which is the correct behavior since the
  // underlying predicate changed.
  useEffect(() => {
    if (viewMode !== "filtered") return;
    // Match the main list's 2-char search threshold (single char = too noisy).
    if (searchQuery.length === 1) return;
    const params = new URLSearchParams({ filtered: "1", limit: String(FILTERED_PAGE_SIZE) });
    if (sourceFilter) params.set("sourceId", String(sourceFilter));
    if (searchQuery.length >= 2) params.set("search", searchQuery);
    let cancelled = false;
    fetch(`/api/research/articles?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.success) {
          setFilteredArticles(data.data ?? []);
          if (data.categoryCounts) setFilteredCategoryCounts(data.categoryCounts);
        }
      })
      .catch(() => {
        /* keep the current list — the empty state explains active filters */
      });
    return () => {
      cancelled = true;
    };
  }, [viewMode, searchQuery, sourceFilter]);

  const refreshArticles = useCallback(
    async (overrides?: { sourceId?: number | null; search?: string; limit?: number }) => {
      const params = new URLSearchParams();
      const sid = overrides?.sourceId !== undefined ? overrides.sourceId : sourceFilter;
      // Never send a one-character search: the box may hold one while the
      // list still reflects the last search that ran.
      const typed = overrides?.search !== undefined ? overrides.search : searchQuery;
      const q = typed.length === 1 ? appliedSearch : typed;
      const limit = overrides?.limit ?? articleLimit;
      // A symbol no security carries matches nothing: keep the empty list
      // instead of re-reading the feed without the filter.
      if (symbolFilter && symbolFilter.securityId === null) return;
      if (sid) params.set("sourceId", String(sid));
      if (q) params.set("search", q);
      if (symbolFilter?.securityId) params.set("securityId", String(symbolFilter.securityId));
      params.set("limit", String(limit));

      const res = await fetch(`/api/research/articles?${params}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Throw so callers can explain — a silently-stale list after a
        // filter/search change looks like the filter simply doesn't work.
        throw new Error(data.error ?? `Articles fetch failed (${res.status})`);
      }
      setArticles(data.data);
      setFeedTotal(typeof data.total === "number" ? data.total : null);
      if (data.symbolMap) setSymbolMap(data.symbolMap);
      setAppliedSearch(q);
      setArticleLimit(limit);
    },
    [sourceFilter, searchQuery, appliedSearch, articleLimit, symbolFilter]
  );

  // Re-read the per-source feed counts (the "N of M" total and the dropdown
  // counts) after a sync added articles. A failure keeps the counts on screen.
  const refreshSourceCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/research/sources");
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) setCurrentSources(data.data);
    } catch {
      // Counts stay as they were; describeFeedWindow never prints N of fewer-than-N.
    }
  }, []);

  // Auto-sync on mount + on app refocus after 10+ min idle. Debounced
  // to once per 5 min across the whole session via localStorage.
  //
  // The background pass gets its OWN busy flag (`bgSyncing`), never the
  // manual one: sharing `syncing` disabled the Sync Feeds button while the
  // hook ran, so a click landing in that window did nothing at all — and the
  // spinner was already spinning, so nothing on screen changed either. It
  // also routes its status text through nextFeedback(), which refuses to bury
  // a standing error under "Refreshing in background…". Both matter most when
  // Gmail is unconfigured: the hook's pre-flight short-circuits BEFORE
  // stamping its localStorage debounce, so it re-fires on every mount exactly
  // when the manual sync is 400ing (qa: sync-feeds silent-400 regression).
  //
  // OWNERSHIP RULE for `bgSyncing` (review finding, 2026-08-28): the flag is
  // owned by THIS hook alone, so its start may decline to SET it but its done
  // must ALWAYS CLEAR it. The old code gated the clear on `!manualSyncRef
  // .current` too: click Sync Feeds while a background pass is finishing and
  // the clear was skipped, leaving the background spinner on forever (nothing
  // else ever sets it false). Clearing unconditionally is safe precisely
  // because onSyncStart is the only setter — a start that was skipped leaves
  // the flag already false, and clearing false is a no-op. Only the FEEDBACK
  // MESSAGE stays manual-guarded: that string is shared with the manual sync,
  // whose progress/error line must not be erased by a background run.
  const manualSyncRef = useRef(false);
  useResearchSync({
    onSyncStart: () => {
      // A background pass starting mid-manual-sync stays invisible: it must
      // not flip the spinner on (the manual spinner is already showing) nor
      // overwrite the manual progress line. Not setting it here is what makes
      // the unconditional clear below correct.
      if (manualSyncRef.current) return;
      setBgSyncing(true);
      setSyncFeedback((prev) => nextFeedback(prev, progressFeedback("Refreshing in background…")));
    },
    onSyncDone: () => {
      // ALWAYS clear the background-owned flag — see the ownership rule above.
      setBgSyncing(false);
      if (!manualSyncRef.current) {
        // Only clear the message this hook wrote — a manual sync's error is
        // sticky and must survive this cleanup.
        setSyncFeedback((prev) =>
          prev?.text === "Refreshing in background…" ? null : prev
        );
      }
      // Background freshness pass — a failure here just means the list keeps
      // its current (valid) contents, so log rather than toast.
      refreshArticles().catch((err) =>
        console.warn("[research] background article refresh failed:", err)
      );
      void refreshSourceCounts();
    },
  });

  const handleSync = useCallback(async () => {
    manualSyncRef.current = true;
    setSyncing(true);
    // A fresh attempt clears the previous outcome — the only thing allowed to
    // erase a standing error.
    setSyncFeedback(progressFeedback("Connecting to Gmail..."));

    const setProgress = (text: string) =>
      setSyncFeedback((prev) => nextFeedback(prev, progressFeedback(text)));

    try {
      const res = await apiFetch("/api/research/sync", { method: "POST" });
      if (!res.ok) {
        // The status alone decides this failed; readSyncFailure only supplies
        // the wording, and always yields something non-empty.
        setSyncFeedback(await readSyncFailure(res));
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";
      // Plain words from the AI pass when it stopped on an account-level
      // failure; repeated on the closing line.
      let accountFailure: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataMatch = line.match(/^data: (.+)$/m);
          if (!dataMatch) continue;
          const data = JSON.parse(dataMatch[1]);

          if (data.phase === "fetch" && data.status === "started") {
            setProgress("Fetching new articles...");
          } else if (data.phase === "fetch" && data.status === "done") {
            setProgress(`Fetched ${data.fetched} new article${data.fetched !== 1 ? "s" : ""}`);
          } else if (data.phase === "process" && data.status === "started") {
            setProgress("Processing with AI...");
          } else if (data.phase === "process" && data.status === "done") {
            const processedLine = `Processed ${data.processed} article${data.processed !== 1 ? "s" : ""}`;
            if (typeof data.accountFailureMessage === "string" && data.accountFailureMessage.trim()) {
              // Sticky from here on, in case the stream ends before "complete".
              accountFailure = data.accountFailureMessage.trim();
              setSyncFeedback(errorFeedback(`${processedLine}. ${accountFailure}`));
            } else {
              setProgress(processedLine);
            }
          } else if (data.phase === "complete") {
            const outcome = syncCompletionFeedback(
              data.totalFetched,
              data.accountFailureMessage ?? accountFailure,
            );
            // The failure line replaces the earlier one; plain progress goes
            // through setProgress so it cannot bury a standing error.
            if (outcome.tone === "error") setSyncFeedback(outcome);
            else setProgress(outcome.text);
          } else if (data.phase === "error") {
            // An in-stream failure is as real as a non-ok status — make it
            // sticky too, not a line that fades in five seconds.
            setSyncFeedback(errorFeedback(data.message ?? "Sync failed"));
          }
        }
      }

      await refreshArticles();
      void refreshSourceCounts();
    } catch {
      setSyncFeedback(errorFeedback(networkFailureMessage("sync articles")));
    } finally {
      manualSyncRef.current = false;
      setSyncing(false);
      // Progress text fades; an error stays until the next sync attempt.
      setTimeout(() => setSyncFeedback((prev) => (shouldAutoDismiss(prev) ? null : prev)), 5000);
    }
  }, [refreshArticles, refreshSourceCounts]);

  const handleFilterChange = useCallback(
    async (id: number | null) => {
      setSourceFilter(id);
      setExpandedId(null);
      try {
        await refreshArticles({ sourceId: id, limit: FEED_PAGE_SIZE });
      } catch {
        // The list still shows the PREVIOUS filter's articles — say so, or
        // the dropdown looks broken-but-silent.
        toast("Couldn't load articles for that source — the list still shows the previous selection.", "error");
      }
    },
    [refreshArticles, toast]
  );

  const handleSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (query.length > 0 && query.length < 2) return;
      setExpandedId(null);
      try {
        await refreshArticles({ search: query, limit: FEED_PAGE_SIZE });
      } catch {
        toast("Search failed — the list below is unchanged.", "error");
      }
    },
    [refreshArticles, toast]
  );

  const handleLoadMoreArticles = useCallback(async () => {
    setLoadingMoreArticles(true);
    try {
      // The route takes a limit and no offset, so one more page = the same
      // window re-read one page longer (newest first, so nothing shifts).
      await refreshArticles({ limit: articleLimit + FEED_PAGE_SIZE });
    } catch {
      toast("Couldn't load more articles. The list below is unchanged; try again.", "error");
    } finally {
      setLoadingMoreArticles(false);
    }
  }, [refreshArticles, articleLimit, toast]);

  const handleSourcesChanged = useCallback(async () => {
    try {
      const res = await fetch("/api/research/sources");
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Throw into the catch below — proceeding with stale `currentSources`
        // would silently mask that the source list itself failed to refresh.
        throw new Error(data.error ?? `Sources fetch failed (${res.status})`);
      }
      const fresh: ResearchSource[] = data.data;
      setCurrentSources(fresh);
      // If the selected source can no longer appear in the filter dropdown
      // (deactivated, deleted, or emptied), the select falls back to "All
      // Sources" — the list must follow, or it strands on the old filter
      // while the control claims no filter is applied.
      const filterStillSelectable =
        sourceFilter === null || fresh.some((s) => s.id === sourceFilter && isSelectableSource(s));
      if (!filterStillSelectable) {
        setSourceFilter(null);
        await refreshArticles({ sourceId: null, limit: FEED_PAGE_SIZE });
      } else {
        await refreshArticles();
      }
    } catch {
      toast("Sources changed, but the article list couldn't refresh — it may be stale until the next sync.", "info");
    }
  }, [refreshArticles, toast, sourceFilter]);

  const handleExpand = useCallback(async (articleId: number) => {
    if (expandedId === articleId) {
      setExpandedId(null);
      setExpandedText(null);
      setExpandedHtml(null);
      return;
    }
    setExpandedId(articleId);
    setExpandedText(null);
    setExpandedHtml(null);
    setLoadingExpand(true);
    try {
      const res = await fetch(`/api/research/articles/${articleId}`);
      const data = await res.json();
      if (data.success) {
        const text = data.data.raw_text ? trimEmailFooter(data.data.raw_text) : null;
        const html = data.data.raw_html ? trimEmailFooter(data.data.raw_html) : null;
        setExpandedText(text);
        // Some senders' templates survive sanitize as style-only shells that
        // render a blank panel — prefer the stored raw_text in that case.
        setExpandedHtml(html && htmlHidesStoredText(html, text) ? null : html);
      }
    } catch {
      toast("Couldn't open the article — check your connection and try again.", "error");
    } finally {
      setLoadingExpand(false);
    }
  }, [expandedId, toast]);

  const feedWindow = describeFeedWindow({
    shown: articles.length,
    // The route's own count when it sent one (exact under a search or a symbol
    // too); otherwise the per-source counts, which know neither.
    total: feedTotal ?? (appliedSearch || symbolFilter ? null : feedTotalForSource(currentSources, sourceFilter)),
    pageLimit: articleLimit,
    search: appliedSearch,
  });

  // Take one param out of the URL. The page re-reads it: for `symbol` the
  // page re-keys this view, so the list reloads without the filter.
  const removeUrlParam = useCallback(
    (name: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete(name);
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?");
    },
    [router, searchParams],
  );

  // `?article=<id>`: open that one article once, scrolled into view. If it is
  // not among the loaded rows it renders as a pinned card above the list.
  const linkedRequest = useMemo(
    () => resolveLinkedArticle(linkedArticleParam, linkedArticle),
    [linkedArticleParam, linkedArticle],
  );
  const linkedId = linkedRequest.kind === "open" ? linkedRequest.id : null;
  const pinnedArticle =
    linkedId !== null && linkedArticle && !articles.some((a) => a.id === linkedId)
      ? linkedArticle
      : null;
  const linkedOpenedRef = useRef(false);
  useEffect(() => {
    if (linkedId === null || linkedOpenedRef.current) return;
    linkedOpenedRef.current = true;
    void handleExpand(linkedId);
    requestAnimationFrame(() => {
      document.getElementById(`feed-article-${linkedId}`)?.scrollIntoView({ block: "start" });
    });
    // Once on mount: handleExpand toggles, so a re-run would close the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedId]);

  return (
    <div className="space-y-5">
      {/* Controls bar — single source dropdown (native select) on every
          viewport. The earlier desktop pill cluster surfaced the full
          source list at the page top, which the user flagged as a "jumble"
          on 2026-04-30. The select hides individual sources behind one
          click on the All label. */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <select
          value={sourceFilter ?? ""}
          onChange={(e) => handleFilterChange(e.target.value ? Number(e.target.value) : null)}
          className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink w-full sm:w-auto sm:min-w-[200px] focus:outline-none focus:border-gold"
          aria-label="Filter by source"
        >
          <option value="">All Sources</option>
          {currentSources
            .filter(isSelectableSource)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {sourceOptionLabel(s)}
              </option>
            ))}
        </select>

        {/* overflow-x-auto + scrollbar-none: containment guard — on very narrow
            viewports this action row scrolls within itself (no visible bar)
            instead of pushing the page into horizontal scroll.
            md:max-lg:pr-4 — iPad-portrait only (finding #22): the scrollable
            strip's last button ("Email") otherwise sits flush against the
            container's own scroll boundary with zero trailing space, reading
            as clipped. Small trailing padding gives it breathing room without
            touching the row's appearance at desktop (>=1280, no scroll) or
            phone (<768, unaffected band).
            ScrollFade: with the chat rail open at 1280 the row is wider than
            its column, and a hidden scrollbar alone gave no sign that "Email"
            was cut off. whitespace-nowrap keeps "Sync Feeds" on one line
            instead of wrapping taller than its siblings. */}
        <ScrollFade className="min-w-0 [--scroll-fade-color:var(--color-canvas)]" scrollerClassName="scrollbar-none">
        <div className="flex items-center gap-2 whitespace-nowrap md:max-lg:pr-4">
          {/* Search: full input on desktop, icon toggle on mobile */}
          <input
            type="text"
            placeholder="Search articles..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="hidden sm:block px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink placeholder:text-ink-faint sm:w-56 focus:outline-none focus:border-gold"
          />
          <button
            onClick={() => setSearchOpen(!searchOpen)}
            className={`sm:hidden inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
              searchOpen || searchQuery
                ? "bg-gold/10 border-gold/30 text-gold-ink"
                : "border-edge text-ink-dim hover:text-ink hover:bg-raised"
            }`}
            title="Search articles"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
          </button>
          <button
            onClick={() => setManageOpen(true)}
            title="Manage sources"
            aria-label="Manage sources"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
            <span className="hidden sm:inline">Sources</span>
          </button>
          {/* disabled ONLY for a manual sync — a background pass must never
              make this button inert (qa: sync-feeds silent-400 regression). */}
          <button
            onClick={handleSync}
            disabled={syncing}
            aria-busy={syncing || bgSyncing}
            title={syncing ? "Syncing…" : bgSyncing ? "Background refresh running — click to sync now" : "Sync Feeds"}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-gold text-canvas hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing || bgSyncing ? (
              <div className="w-3.5 h-3.5 border-2 border-canvas border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
            )}
            <span className="hidden sm:inline">Sync Feeds</span>
          </button>
          <button
            onClick={() => setPreviewOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
            title="Preview digest (toggle by publication / by company)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
            <span className="hidden sm:inline">Preview</span>
          </button>
          <button
            onClick={() => setSendOpen(!sendOpen)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
              sendOpen
                ? "bg-gold/10 border-gold/30 text-gold-ink"
                : "border-edge text-ink-dim hover:text-ink hover:bg-raised"
            }`}
            title="Send email"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
            </svg>
            <span className="hidden sm:inline">Email</span>
          </button>
        </div>
        </ScrollFade>
      </div>

      {/* Sync feedback — directly under the controls bar, NOT further down
          the page past the search box and digest panel where it used to sit
          (and could be scrolled out of view entirely). Errors use the same
          treatment as "Discover from Gmail" in ManageSourcesModal so the two
          Gmail failures read identically, and they persist until the next
          sync attempt rather than fading on a 5s timer. */}
      {syncFeedback && (
        <div
          role={syncFeedback.tone === "error" ? "alert" : "status"}
          className={
            syncFeedback.tone === "error"
              ? "px-4 py-2.5 rounded-lg bg-down/10 border border-down/30 text-sm text-down"
              : "px-4 py-2.5 rounded-lg bg-raised border border-edge text-sm text-ink-dim"
          }
        >
          {syncFeedback.text}
        </div>
      )}

      {symbolFilter && (
        <div role="status" className="flex items-center gap-2 flex-wrap text-xs text-ink-dim">
          <Chip tone="info" size="sm">
            Symbol: {symbolFilter.symbol}
            <button
              type="button"
              onClick={() => removeUrlParam("symbol")}
              aria-label={`Clear the ${symbolFilter.symbol} symbol filter`}
              className="relative ml-1.5 hover:brightness-125 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2.5"
            >
              ×
            </button>
          </Chip>
          <span>
            {viewMode === "filtered"
              ? "The Filtered tab is not narrowed by this symbol; All articles is."
              : "Only articles linked to this symbol are listed."}
          </span>
        </div>
      )}

      {linkedRequest.kind === "notice" && (
        <div
          role="status"
          className="px-4 py-2.5 rounded-lg bg-raised border border-edge text-sm text-ink-dim flex items-center justify-between gap-3"
        >
          <span>{linkedRequest.text}</span>
          <button
            type="button"
            onClick={() => removeUrlParam("article")}
            className="shrink-0 text-xs text-ink-dim hover:text-ink transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      <DigestEmailViewer open={previewOpen} onClose={() => setPreviewOpen(false)} />

      {/* D5 — filtered/all toggle. Hidden when there's nothing to audit so
          the toolbar stays calm on quiet days. Visible on both desktop and
          mobile — the audit surface is one tap away wherever you happen to
          be reading. */}
      {(filteredCount > 0 || viewMode === "filtered") && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode("all")}
            className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              viewMode === "all"
                ? "bg-raised border-edge-strong text-ink"
                : "border-edge text-ink-dim hover:text-ink hover:bg-raised"
            }`}
          >
            All articles
          </button>
          <button
            type="button"
            onClick={() => setViewMode("filtered")}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              viewMode === "filtered"
                ? "bg-gold/15 border-gold/40 text-gold-ink"
                : "border-edge text-ink-dim hover:text-ink hover:bg-raised"
            }`}
            title="Articles flipped to is_relevant=0 by the D1/D2 short-circuit or D3 portfolio-relevance gate"
          >
            Filtered
            <span
              className={`inline-flex items-center justify-center min-w-[1.25rem] px-1.5 rounded-full text-[10px] font-mono ${
                viewMode === "filtered" ? "bg-gold/20 text-gold-ink" : "bg-raised text-ink-faint"
              }`}
            >
              {computeFilteredBadgeCount(viewMode, filteredCount, filteredCategoryCounts)}
            </span>
          </button>
        </div>
      )}

      {/* Mobile search input (expands below controls when magnifying glass is tapped) */}
      {searchOpen && isMobile && (
        <input
          type="text"
          placeholder="Search articles..."
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          autoFocus
          className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink placeholder:text-ink-faint w-full focus:outline-none focus:border-gold"
        />
      )}

      {/* Send digest panel */}
      {sendOpen && <SendDigestPanel onClose={() => setSendOpen(false)} />}

      {/* A one-character search does not run (too noisy), so the list below
          still shows the previous result. Say so, or box and list disagree. */}
      {searchQuery.length === 1 && (
        <p role="status" className="max-w-3xl mx-auto text-xs text-ink-dim">
          {SEARCH_TOO_SHORT_HINT}
        </p>
      )}

      {/* The article a `?article=` link names, when it is older than the loaded
          rows (or outside the current search/source/symbol). Kept apart from
          the list so the "N of M" line stays true. */}
      {viewMode === "all" && pinnedArticle && (
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-xs text-ink-dim">Linked article (not among the articles listed below)</p>
            <button
              type="button"
              onClick={() => removeUrlParam("article")}
              className="shrink-0 text-xs text-ink-dim hover:text-ink transition-colors"
            >
              Dismiss
            </button>
          </div>
          <div className="border-b border-edge/50">
            <ArticleCard
              article={pinnedArticle}
              symbolMap={symbolMap}
              expanded={expandedId === pinnedArticle.id}
              expandedText={expandedId === pinnedArticle.id ? expandedText : null}
              expandedHtml={expandedId === pinnedArticle.id ? expandedHtml : null}
              loading={expandedId === pinnedArticle.id && loadingExpand}
              onToggle={() => handleExpand(pinnedArticle.id)}
            />
          </div>
        </div>
      )}

      {/* Articles — reader layout */}
      {viewMode === "filtered" ? (
        <>
          <FilteredArticlesList
            articles={filteredArticles}
            categoryCounts={filteredCategoryCounts}
            onUnfilter={handleUnfilter}
            onRetryEnrichment={handleRetryEnrichment}
            hasActiveFilter={searchQuery.length >= 2 || sourceFilter !== null}
          />
          {filteredRemaining > 0 && (
            <div className="max-w-3xl mx-auto flex justify-center pt-1">
              <button
                type="button"
                onClick={handleLoadMoreFiltered}
                disabled={loadingMoreFiltered}
                className="px-4 py-2 rounded-md text-xs font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors disabled:opacity-50"
              >
                {loadingMoreFiltered ? "Loading…" : `Load more (${filteredRemaining} remaining)`}
              </button>
            </div>
          )}
        </>
      ) : articles.length === 0 && (searchQuery.length > 0 || sourceFilter !== null) ? (
        // Zero results under an active search/filter is a no-match state,
        // not the no-data onboarding (deep-QA: "Connect Gmail" copy wrongly
        // implied Gmail was disconnected).
        <div className="rounded-xl border border-edge bg-panel p-10 text-center max-w-2xl mx-auto">
          <p className="text-ink-dim">
            {searchQuery.length > 0
              ? `No articles match "${searchQuery}".`
              : "No articles from this source yet."}
          </p>
          <p className="text-ink-faint text-sm mt-1">
            Try a different search term or clear the filter.
          </p>
        </div>
      ) : articles.length === 0 && symbolFilter ? (
        <div className="rounded-xl border border-edge bg-panel p-10 text-center max-w-2xl mx-auto">
          <p className="text-ink-dim">
            {symbolFilter.securityId === null
              ? `No security with the symbol ${symbolFilter.symbol} is on file, so no article is linked to it.`
              : `No articles are linked to ${symbolFilter.symbol}.`}
          </p>
          <p className="text-ink-faint text-sm mt-1">Clear the symbol filter above to see every article.</p>
        </div>
      ) : articles.length === 0 ? (
        <div className="rounded-xl border border-edge bg-panel p-10 text-center max-w-2xl mx-auto">
          <p className="text-ink-dim">No articles yet.</p>
          <p className="text-ink-faint text-sm mt-1">
            Connect Gmail and click &quot;Sync Feeds&quot; to fetch newsletters.
          </p>
        </div>
      ) : (
        <div className="max-w-3xl mx-auto">
          {/* How much of the set is on screen, and which search it reflects. */}
          <p className="text-xs text-ink-dim mb-4">{feedWindow.text}</p>
          <div className="divide-y divide-edge/50">
            {articles.map((article) => (
              <ArticleCard
                key={article.id}
                article={article}
                symbolMap={symbolMap}
                expanded={expandedId === article.id}
                expandedText={expandedId === article.id ? expandedText : null}
                expandedHtml={expandedId === article.id ? expandedHtml : null}
                loading={expandedId === article.id && loadingExpand}
                onToggle={() => handleExpand(article.id)}
              />
            ))}
          </div>
          {feedWindow.hasMore && (
            <div className="flex justify-center pt-4">
              {articleLimit >= FEED_MAX_LIMIT ? (
                // The route reads at most FEED_MAX_LIMIT rows: a longer
                // request would return the same list again.
                <p role="status" className="text-xs text-ink-dim text-center">{FEED_CAP_NOTICE}</p>
              ) : (
                <button
                  type="button"
                  onClick={handleLoadMoreArticles}
                  disabled={loadingMoreArticles}
                  className="px-4 py-2 rounded-md text-xs font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors disabled:opacity-50"
                >
                  {loadingMoreArticles ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <ManageSourcesModal
        initialSources={currentSources}
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onSourcesChanged={handleSourcesChanged}
      />
    </div>
  );
}

// ── Article card — reader mode ───────────────────────────────────────

function ArticleCard({
  article,
  symbolMap,
  expanded,
  expandedText,
  expandedHtml,
  loading,
  onToggle,
}: {
  article: ResearchArticle;
  symbolMap: Record<string, number>;
  expanded: boolean;
  expandedText: string | null;
  expandedHtml: string | null;
  loading: boolean;
  onToggle: () => void;
}) {
  const dateStr = new Date(article.received_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const border = sentimentBorder[article.sentiment ?? "neutral"] ?? "border-l-edge-strong";
  // The original article on the publisher's site. Falls back to the source's
  // homepage so there's always a way out to the source even when inline text
  // isn't available (U5). source_url can be null for some rows.
  const originalUrl = article.source_url ?? article.website_url;
  const cardRef = useRef<HTMLElement | null>(null);
  // Collapsing a long article shrinks the page under the reader. Bring the
  // card they just closed back to the top of the view, or they land several
  // unrelated cards further down.
  const collapse = () => {
    onToggle();
    requestAnimationFrame(() => {
      const el = cardRef.current;
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
    });
  };
  const filteredMarker = filteredMarkerText(article);

  return (
    // break-words (overflow-wrap, inherited): AI summaries/relevance lines can
    // contain long unbreakable tokens (e.g. "AAPL/AMZN/META/MSFT/GOOG/CRWD" —
    // slashes are not break opportunities) which otherwise push the whole page
    // into horizontal scroll at mobile widths.
    <article
      ref={cardRef}
      id={`feed-article-${article.id}`}
      className={`py-6 first:pt-0 break-words scroll-mt-20 ${expanded ? "" : "cursor-pointer group"}`}
    >
      {/* Collapsed view — click to expand */}
      <div onClick={expanded ? undefined : onToggle}>
        {/* Meta line. flex-wrap: the Filtered marker can be long on a phone. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mb-2">
          <span className="text-xs font-semibold text-gold-ink uppercase tracking-wider">
            {article.source_name}
          </span>
          <span className="text-ink-faint">·</span>
          <time className="text-xs text-ink-faint">{dateStr}</time>
          <SentimentBadge sentiment={article.sentiment} />
          {/* A filtered article stays in this list (owner ruling) but is
              marked, with the same reason text the Filtered tab uses. Always
              visible: no hover, so it reads the same on touch. */}
          {filteredMarker && (
            <Chip tone="warn" size="xs" title="This article is in the Filtered tab and is left out of digests">
              {filteredMarker}
            </Chip>
          )}
          {originalUrl && (
            <a
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-ink-faint hover:text-gold transition-colors ml-auto"
              title="Open the original article in your browser"
            >
              Open original ↗
            </a>
          )}
          {/* Top Collapse: the bottom one can be several screens away. */}
          {expanded && (
            <button
              type="button"
              onClick={collapse}
              className={`text-xs text-ink-dim hover:text-ink transition-colors ${originalUrl ? "" : "ml-auto"}`}
            >
              Collapse
            </button>
          )}
        </div>

        {/* Headline — reader-app scale (~21px / line-height tight). The title
            is a real button: it opens and closes the card from the keyboard
            (Enter/Space) and stays clickable while expanded. stopPropagation:
            the collapsed wrapper also toggles, and two toggles cancel out. */}
        <h3 className={`text-xl font-semibold leading-snug text-ink mb-2 ${expanded ? "" : "group-hover:text-gold transition-colors"}`}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              if (expanded) collapse();
              else onToggle();
            }}
            className="text-left cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            {article.subject}
          </button>
        </h3>

        {/* AI Summary — reader-app body (17px / 1.7 line-height). Sanitized
            at render too (storage-boundary guard can miss a leak shape on
            old rows) — same helper as ThemePills below. */}
        {article.summary && (
          <p className="text-[17px] leading-[1.7] text-ink-dim mb-3">
            {sanitizeModelSummary(article.summary)}
          </p>
        )}

        {/* Portfolio relevance */}
        {article.portfolio_relevance && (
          <p className={`text-[17px] leading-[1.7] text-gold/80 mb-3 pl-3 border-l-2 ${border}`}>
            <PrivateText>{article.portfolio_relevance}</PrivateText>
          </p>
        )}

        {/* Tags row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 mt-3">
          <SymbolPills symbolsJson={article.mentioned_symbols} symbolMap={symbolMap} showAll={expanded} />
          <ThemePills themesJson={article.key_themes} />
        </div>
      </div>

      {/* Expanded: full article text */}
      {expanded && (
        <div className="mt-5">
          <div className="border-t border-edge/50 pt-5">
            {loading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-sm text-ink-dim">
                <div className="w-4 h-4 border-2 border-ink-faint border-t-transparent rounded-full animate-spin" />
                Loading full article...
              </div>
            ) : expandedHtml ? (
              // Sandboxed iframe, NOT dangerouslySetInnerHTML: an email's
              // document-global <style> block otherwise restyles the whole
              // app (blue anchors, white background) until reload.
              <NewsletterArticleFrame html={expandedHtml} />
            ) : expandedText ? (
              <div className="prose-reader">
                {/* CRLF-tolerant paragraph split (some senders' raw_text is
                    pure \r\n — a bare \n{2,} never matches); pre-line keeps
                    single-newline structure (headings, one-per-line entries). */}
                {expandedText.split(/(?:\r?\n){2,}/).map((para, i) => (
                  <p key={i} className="whitespace-pre-line">{para.replace(/\r\n/g, "\n")}</p>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-faint italic py-4">
                Full text not available for this article
                {originalUrl ? (
                  <>
                    {" — "}
                    <a
                      href={originalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gold-ink hover:text-gold/80 not-italic"
                    >
                      open the original ↗
                    </a>
                  </>
                ) : (
                  "."
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={collapse}
            className="mt-4 text-sm text-ink-faint hover:text-ink transition-colors"
          >
            Collapse
          </button>
        </div>
      )}
    </article>
  );
}

// ── Filtered audit list (D5) ────────────────────────────────────────

const FILTERED_CATEGORY_LABEL: Record<string, string> = {
  receipt: "Payment receipts",
  welcome: "Welcome / onboarding",
  gift: "Gift subscriptions",
  admin: "Admin mail",
  off_topic: "Off-topic (Claude judgment)",
  enrichment_failed: "Enrichment failed",
};

/**
 * Fallback for a category not (yet) in FILTERED_CATEGORY_LABEL — humanize
 * the raw snake_case DB enum (`some_new_category` → "Some new category")
 * instead of rendering it verbatim, so a future excluded_category value
 * never leaks the wire format into the UI.
 */
function humanizeCategory(category: string): string {
  const spaced = category.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Section-header label for a Filtered-tab `excluded_category` value —
 * exported (pure, no render needed) so the "known category" table and the
 * snake_case fallback can both be covered by a plain Vitest test.
 */
export function resolveFilteredCategoryLabel(category: string): string {
  return FILTERED_CATEGORY_LABEL[category] ?? humanizeCategory(category);
}

/**
 * Marker text for an All-articles card whose article is filtered
 * (is_relevant = 0), or null for a normal article. The reason is the SAME
 * label the Filtered tab's section header prints, through the one label
 * table above, with the same "other" fallback for a missing category.
 */
export function filteredMarkerText(article: {
  is_relevant?: number | null;
  excluded_category?: string | null;
}): string | null {
  if (article.is_relevant !== 0) return null;
  return `Filtered: ${resolveFilteredCategoryLabel(article.excluded_category || "other")}`;
}

/**
 * What to tell the user after an Unfilter that did not re-queue the article.
 * An article the AI never analysed (processed_at NULL: the pre-AI rows) is in
 * NEITHER list afterwards: the main feed lists processed articles only. An
 * analysed article is already in All articles and just loses its marker.
 */
export function describeUnfilterOutcome(processedAt: string | null): {
  text: string;
  tone: "success" | "info";
} {
  if (processedAt == null) {
    return {
      text:
        "Unfiltered. This article has not been analysed by AI yet, so it is not in All articles either. It will appear there after the next feed sync has analysed it (click Sync Feeds to run one now).",
      tone: "info",
    };
  }
  return { text: "Unfiltered. The article is back in All articles and in the digest stream.", tone: "success" };
}

/**
 * qa:research-feeds-filtered--badge-ignores-source-filter-regression-1 —
 * the Filtered pill's badge used to always render the raw `filteredCount`
 * state, which only ever reflects the GLOBAL count (initialFilteredCount /
 * getFilteredArticleCount, deliberately unscoped per its doc comment) —
 * even while the Filtered tab's list and section headers correctly narrow
 * to the active source/search filter via filteredCategoryCounts (fetched
 * on the identical buildFilteredArticlesWhere predicate as the list). When
 * the Filtered tab is the active view, the badge must count the same rows
 * the tab renders, so it sums filteredCategoryCounts instead — which
 * already equals the global total when no source/search filter narrows it,
 * so this is a strict improvement with no behavior change in that case.
 * On the "all" tab there is no scoped list on screen to disagree with, so
 * the global count remains the "something to review" teaser.
 */
export function computeFilteredBadgeCount(
  viewMode: "all" | "filtered",
  filteredCount: number,
  filteredCategoryCounts: FilteredArticleCategoryCount[],
): number {
  if (viewMode !== "filtered") return filteredCount;
  return filteredCategoryCounts.reduce((sum, c) => sum + c.count, 0);
}

/** The category the enrichment pass writes when an article runs out of attempts. */
const ENRICHMENT_FAILED_CATEGORY = "enrichment_failed";

type FilteredRowAction = "unfilter" | "retry";

const FILTERED_ROW_ACTION_COPY: Record<FilteredRowAction, { endpoint: string; verb: string }> = {
  unfilter: { endpoint: "unfilter", verb: "unfilter" },
  retry: { endpoint: "retry-enrichment", verb: "retry enrichment for" },
};

const REQUEUED_FOR_ENRICHMENT_NOTICE =
  "Queued for enrichment. It will be analysed on the next feed sync (click Sync Feeds to run one now) and then appear in the feed. If the analysis fails again it comes back to this list.";

function FilteredArticlesList({
  articles,
  categoryCounts,
  onUnfilter,
  onRetryEnrichment,
  hasActiveFilter = false,
}: {
  articles: FilteredArticle[];
  /** Full-set per-category counts under the current predicate — the section
   *  order + header counts always come from here, never from grouping
   *  `articles` (which is only the loaded page, capped at 100 rows). */
  categoryCounts: FilteredArticleCategoryCount[];
  onUnfilter: (id: number) => void;
  onRetryEnrichment: (id: number) => void;
  hasActiveFilter?: boolean;
}) {
  if (articles.length === 0 && categoryCounts.length === 0) {
    // Distinguish "no matches under the active controls" from "nothing has
    // been filtered" — the wrong copy makes the controls look broken.
    if (hasActiveFilter) {
      return (
        <div className="rounded-xl border border-edge bg-panel p-10 text-center max-w-2xl mx-auto">
          <p className="text-ink-dim">
            No filtered articles match the current search or source selection.
          </p>
          <p className="text-ink-faint text-sm mt-1">
            Try a different search term or clear the source filter.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-edge bg-panel p-10 text-center max-w-2xl mx-auto">
        <p className="text-ink-dim">Nothing filtered right now.</p>
        <p className="text-ink-faint text-sm mt-1">
          The D1/D2 regex and the D3 portfolio-relevance gate land articles
          here when they fire. Use Unfilter to override.
        </p>
      </div>
    );
  }

  // Group the LOADED rows by category so each section has something to
  // render — but the section list itself, its order, and its header count
  // are driven by categoryCounts (see prop doc above), not by this map.
  const buckets = new Map<string, FilteredArticle[]>();
  for (const a of articles) {
    const key = a.excluded_category || "other";
    const list = buckets.get(key) ?? [];
    list.push(a);
    buckets.set(key, list);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {categoryCounts.map(({ category, count }) => {
        if (count === 0) return null;
        const items = buckets.get(category) ?? [];
        return (
          <section key={category}>
            <h3 className="text-xs font-semibold text-gold-ink uppercase tracking-wider mb-3">
              {resolveFilteredCategoryLabel(category)} · {count}
            </h3>
            {items.length > 0 ? (
              <div className="divide-y divide-edge/50">
                {items.map((article) => (
                  <FilteredArticleRow
                    key={article.id}
                    article={article}
                    onUnfilter={onUnfilter}
                    onRetryEnrichment={onRetryEnrichment}
                  />
                ))}
              </div>
            ) : (
              // Full count is known but none of this category's rows have
              // loaded yet — they're all older than the current page cutoff.
              <p className="text-xs text-ink-faint italic py-2">
                {count} article{count === 1 ? "" : "s"} in this category — click &quot;Load more&quot; below to review.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function FilteredArticleRow({
  article,
  onUnfilter,
  onRetryEnrichment,
}: {
  article: FilteredArticle;
  onUnfilter: (id: number) => void;
  onRetryEnrichment: (id: number) => void;
}) {
  // An "Enrichment failed" row has no AI analysis to release into the digest,
  // so its action is to run the analysis again, not to unfilter it as it is.
  const enrichmentFailed = article.excluded_category === ENRICHMENT_FAILED_CATEGORY;
  const dateStr = new Date(article.received_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const senderShort = article.sender.replace(/<.*>/, "").trim() || article.sender;

  return (
    <div className="py-4 flex items-start gap-4">
      {/* break-words: same long-token guard as ArticleCard (subjects/reasons). */}
      <div className="min-w-0 flex-1 break-words">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="text-xs font-semibold text-ink-faint uppercase tracking-wider">
            {article.source_name}
          </span>
          <span className="text-xs text-ink-faint">{dateStr}</span>
          {article.processed_at == null && (
            <span className="text-[10px] uppercase tracking-wider text-ink-faint border border-edge rounded px-1.5 py-0.5">
              pre-AI
            </span>
          )}
        </div>
        <h4 className="text-sm font-medium text-ink leading-snug">{article.subject}</h4>
        <p className="text-xs text-ink-faint mt-1">{senderShort}</p>
        {article.excluded_reason && (
          <p className="mt-2 text-xs text-ink-dim italic">
            <PrivateText>{article.excluded_reason}</PrivateText>
          </p>
        )}
      </div>
      {enrichmentFailed ? (
        <button
          type="button"
          onClick={() => onRetryEnrichment(article.id)}
          className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
          title="Queue this article for AI analysis again on the next feed sync"
        >
          Retry enrichment
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onUnfilter(article.id)}
          className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
          title="Move back into the digest stream"
        >
          Unfilter
        </button>
      )}
    </div>
  );
}
