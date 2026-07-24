"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import type { ResearchArticle, ResearchSource, FilteredArticle } from "@/lib/queries/research";
import { trimEmailFooter } from "@/lib/gmail/sanitize";
import { sanitizeThemeList } from "@/lib/gmail/theme-sanitize";
import { ManageSourcesModal } from "./ManageSourcesModal";
import { SendDigestPanel } from "./SendDigestPanel";
import { DigestEmailViewer } from "./DigestEmailViewer";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useResearchSync } from "@/lib/hooks/useResearchSync";
import { useToast } from "./Toast";

interface Props {
  initialArticles: ResearchArticle[];
  sources: ResearchSource[];
  initialSymbolMap: Record<string, number>;
  /** D5 — articles flipped to is_relevant=0 by D1/D2 short-circuit or D3 gate. */
  initialFilteredArticles: FilteredArticle[];
  initialFilteredCount: number;
}

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

function SymbolPills({
  symbolsJson,
  symbolMap,
}: {
  symbolsJson: string | null;
  symbolMap: Record<string, number>;
}) {
  if (!symbolsJson) return null;
  let symbols: string[];
  try {
    const parsed = JSON.parse(symbolsJson);
    if (!Array.isArray(parsed)) return null;
    symbols = parsed;
  } catch { return null; }
  if (symbols.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {symbols.slice(0, 6).map((s) => {
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
      {symbols.length > 6 && (
        <span className="text-xs text-ink-faint">+{symbols.length - 6} more</span>
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

// ── Main view ────────────────────────────────────────────────────────

export function ResearchFeedsView({
  initialArticles,
  sources,
  initialSymbolMap,
  initialFilteredArticles,
  initialFilteredCount,
}: Props) {
  const isMobile = useIsMobile();
  const [articles, setArticles] = useState(initialArticles);
  const [symbolMap, setSymbolMap] = useState<Record<string, number>>(initialSymbolMap);
  const [currentSources, setCurrentSources] = useState(sources);
  const [sourceFilter, setSourceFilter] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
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

  const handleUnfilter = useCallback(async (articleId: number) => {
    // Optimistic removal — flicker would be worse than a race-loss on failure.
    setFilteredArticles((prev) => prev.filter((a) => a.id !== articleId));
    setFilteredCount((n) => Math.max(0, n - 1));
    try {
      const res = await fetch(`/api/research/articles/${articleId}/unfilter`, {
        method: "POST",
      });
      if (!res.ok) {
        // Rollback: refetch the full filtered list to recover correct state —
        // and explain, or the reappearing row looks like a glitch.
        toast(`Couldn't unfilter the article (server returned ${res.status}) — it stays in the filtered list.`, "error");
        const reload = await fetch("/api/research/articles?filtered=1&limit=100");
        const data = await reload.json();
        if (data.success) {
          setFilteredArticles(data.data ?? []);
          setFilteredCount((data.data ?? []).length);
        }
      }
    } catch {
      // Network blip — the row already vanished optimistically, so say the
      // server may not have gotten it rather than leaving a silent mismatch.
      toast("Unfilter may not have reached the server — check the Filtered tab after the next sync.", "info");
    }
  }, [toast]);

  const refreshArticles = useCallback(
    async (overrides?: { sourceId?: number | null; search?: string }) => {
      const params = new URLSearchParams();
      const sid = overrides?.sourceId !== undefined ? overrides.sourceId : sourceFilter;
      const q = overrides?.search !== undefined ? overrides.search : searchQuery;
      if (sid) params.set("sourceId", String(sid));
      if (q) params.set("search", q);
      params.set("limit", "50");

      const res = await fetch(`/api/research/articles?${params}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Throw so callers can explain — a silently-stale list after a
        // filter/search change looks like the filter simply doesn't work.
        throw new Error(data.error ?? `Articles fetch failed (${res.status})`);
      }
      setArticles(data.data);
      if (data.symbolMap) setSymbolMap(data.symbolMap);
    },
    [sourceFilter, searchQuery]
  );

  // Auto-sync on mount + on app refocus after 10+ min idle. Debounced
  // to once per 5 min across the whole session via localStorage. The hook
  // shares the syncing/syncStatus slots with the manual Sync Feeds button,
  // so its callbacks must never clobber a manual sync's feedback: when the
  // Gmail pre-flight short-circuits (unconfigured), the hook re-fires every
  // mount and its onSyncDone used to null out the status — racing a manual
  // sync's error message into oblivion (qa: sync-feeds silent-400 regression).
  const manualSyncRef = useRef(false);
  useResearchSync({
    onSyncStart: () => {
      if (manualSyncRef.current) return;
      setSyncing(true);
      setSyncStatus("Refreshing in background…");
    },
    onSyncDone: () => {
      if (!manualSyncRef.current) {
        setSyncing(false);
        // Only clear the message this hook wrote — a manual sync's error
        // (which outlives the manual run by 5s) must survive this cleanup.
        setSyncStatus((prev) =>
          prev === "Refreshing in background…" ? null : prev
        );
      }
      // Background freshness pass — a failure here just means the list keeps
      // its current (valid) contents, so log rather than toast.
      refreshArticles().catch((err) =>
        console.warn("[research] background article refresh failed:", err)
      );
    },
  });

  const handleSync = useCallback(async () => {
    manualSyncRef.current = true;
    setSyncing(true);
    setSyncStatus("Connecting to Gmail...");

    try {
      const res = await fetch("/api/research/sync", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Sync failed" }));
        throw new Error(err.error ?? `Sync failed (${res.status})`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

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
            setSyncStatus("Fetching new articles...");
          } else if (data.phase === "fetch" && data.status === "done") {
            setSyncStatus(`Fetched ${data.fetched} new article${data.fetched !== 1 ? "s" : ""}`);
          } else if (data.phase === "process" && data.status === "started") {
            setSyncStatus("Processing with AI...");
          } else if (data.phase === "process" && data.status === "done") {
            setSyncStatus(`Processed ${data.processed} article${data.processed !== 1 ? "s" : ""}`);
          } else if (data.phase === "complete") {
            setSyncStatus(
              data.totalFetched > 0
                ? `Done — ${data.totalFetched} new article${data.totalFetched !== 1 ? "s" : ""}`
                : "Up to date — no new articles"
            );
          } else if (data.phase === "error") {
            setSyncStatus(`Error: ${data.message}`);
          }
        }
      }

      await refreshArticles();
    } catch (err) {
      setSyncStatus(`Error: ${err instanceof Error ? err.message : "Sync failed"}`);
    } finally {
      manualSyncRef.current = false;
      setSyncing(false);
      setTimeout(() => setSyncStatus(null), 5000);
    }
  }, [refreshArticles]);

  const handleFilterChange = useCallback(
    async (id: number | null) => {
      setSourceFilter(id);
      setExpandedId(null);
      try {
        await refreshArticles({ sourceId: id });
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
        await refreshArticles({ search: query });
      } catch {
        toast("Search failed — the list below is unchanged.", "error");
      }
    },
    [refreshArticles, toast]
  );

  const handleSourcesChanged = useCallback(async () => {
    try {
      const res = await fetch("/api/research/sources");
      const data = await res.json();
      if (data.success) setCurrentSources(data.data);
      await refreshArticles();
    } catch {
      toast("Sources changed, but the article list couldn't refresh — it may be stale until the next sync.", "info");
    }
  }, [refreshArticles, toast]);

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
        setExpandedText(data.data.raw_text ? trimEmailFooter(data.data.raw_text) : null);
        setExpandedHtml(data.data.raw_html ? trimEmailFooter(data.data.raw_html) : null);
      }
    } catch { /* ignore */ } finally {
      setLoadingExpand(false);
    }
  }, [expandedId]);

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
            .filter((s) => s.is_active && s.article_count && s.article_count > 0)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.article_count})
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
            phone (<768, unaffected band). */}
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none md:max-lg:pr-4">
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
            <span className="hidden sm:inline">Sources</span>
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-gold text-canvas hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? (
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
      </div>
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
              {filteredCount}
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

      {/* Sync status */}
      {syncStatus && (
        <div className="px-4 py-2.5 rounded-lg bg-raised border border-edge text-sm text-ink-dim">
          {syncStatus}
        </div>
      )}

      {/* Articles — reader layout */}
      {viewMode === "filtered" ? (
        <FilteredArticlesList
          articles={filteredArticles}
          onUnfilter={handleUnfilter}
        />
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
      ) : articles.length === 0 ? (
        <div className="rounded-xl border border-edge bg-panel p-10 text-center max-w-2xl mx-auto">
          <p className="text-ink-dim">No articles yet.</p>
          <p className="text-ink-faint text-sm mt-1">
            Connect Gmail and click &quot;Sync Feeds&quot; to fetch newsletters.
          </p>
        </div>
      ) : (
        <div className="max-w-3xl mx-auto divide-y divide-edge/50">
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

  return (
    // break-words (overflow-wrap, inherited): AI summaries/relevance lines can
    // contain long unbreakable tokens (e.g. "AAPL/AMZN/META/MSFT/GOOG/CRWD" —
    // slashes are not break opportunities) which otherwise push the whole page
    // into horizontal scroll at mobile widths.
    <article className={`py-6 first:pt-0 break-words ${expanded ? "" : "cursor-pointer group"}`}>
      {/* Collapsed view — click to expand */}
      <div onClick={expanded ? undefined : onToggle}>
        {/* Meta line */}
        <div className="flex items-center gap-2.5 mb-2">
          <span className="text-xs font-semibold text-gold-ink uppercase tracking-wider">
            {article.source_name}
          </span>
          <span className="text-ink-faint">·</span>
          <time className="text-xs text-ink-faint">{dateStr}</time>
          <SentimentBadge sentiment={article.sentiment} />
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
        </div>

        {/* Headline — reader-app scale (~21px / line-height tight) */}
        <h3 className={`text-xl font-semibold leading-snug text-ink mb-2 ${expanded ? "" : "group-hover:text-gold transition-colors"}`}>
          {article.subject}
        </h3>

        {/* AI Summary — reader-app body (17px / 1.7 line-height) */}
        {article.summary && (
          <p className="text-[17px] leading-[1.7] text-ink-dim mb-3">{article.summary}</p>
        )}

        {/* Portfolio relevance */}
        {article.portfolio_relevance && (
          <p className={`text-[17px] leading-[1.7] text-gold/80 mb-3 pl-3 border-l-2 ${border}`}>
            {article.portfolio_relevance}
          </p>
        )}

        {/* Tags row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 mt-3">
          <SymbolPills symbolsJson={article.mentioned_symbols} symbolMap={symbolMap} />
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
              <div
                className="prose-newsletter"
                dangerouslySetInnerHTML={{ __html: expandedHtml }}
              />
            ) : expandedText ? (
              <div className="prose-reader">
                {expandedText.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>{para}</p>
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
            onClick={onToggle}
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
};

function FilteredArticlesList({
  articles,
  onUnfilter,
}: {
  articles: FilteredArticle[];
  onUnfilter: (id: number) => void;
}) {
  if (articles.length === 0) {
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

  // Group by category so the user can scan one bucket at a time. The map
  // preserves insertion order, so categories surface in the order their
  // first article appeared (most recent first by query order).
  const buckets = new Map<string, FilteredArticle[]>();
  for (const a of articles) {
    const key = a.excluded_category || "other";
    const list = buckets.get(key) ?? [];
    list.push(a);
    buckets.set(key, list);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {Array.from(buckets.entries()).map(([category, items]) => (
        <section key={category}>
          <h3 className="text-xs font-semibold text-gold-ink uppercase tracking-wider mb-3">
            {FILTERED_CATEGORY_LABEL[category] ?? category} · {items.length}
          </h3>
          <div className="divide-y divide-edge/50">
            {items.map((article) => (
              <FilteredArticleRow
                key={article.id}
                article={article}
                onUnfilter={onUnfilter}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FilteredArticleRow({
  article,
  onUnfilter,
}: {
  article: FilteredArticle;
  onUnfilter: (id: number) => void;
}) {
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
            {article.excluded_reason}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onUnfilter(article.id)}
        className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
        title="Move back into the digest stream"
      >
        Unfilter
      </button>
    </div>
  );
}
