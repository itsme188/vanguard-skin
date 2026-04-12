"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import type { ResearchArticle, ResearchSource } from "@/lib/queries/research";
import { trimEmailFooter } from "@/lib/gmail/sanitize";
import { ManageSourcesModal } from "./ManageSourcesModal";

interface Props {
  initialArticles: ResearchArticle[];
  sources: ResearchSource[];
  initialSymbolMap: Record<string, number>;
}

// ── Sentiment helpers ────────────────────────────────────────────────

const sentimentColors: Record<string, string> = {
  bullish: "bg-up-tint text-up",
  bearish: "bg-down-tint text-down",
  neutral: "bg-raised text-ink-dim",
  mixed: "bg-gold/10 text-gold",
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
      {symbols.slice(0, 8).map((s) => {
        const secId = symbolMap[s];
        return secId ? (
          <Link
            key={s}
            href={`/dashboard/security/${secId}`}
            className="px-2 py-0.5 rounded bg-blue-tint text-blue text-xs font-mono hover:bg-blue/20 transition-colors"
          >
            {s}
          </Link>
        ) : (
          <span key={s} className="px-2 py-0.5 rounded bg-raised text-ink-faint text-xs font-mono">
            {s}
          </span>
        );
      })}
      {symbols.length > 8 && (
        <span className="text-xs text-ink-faint">+{symbols.length - 8} more</span>
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
    themes = parsed;
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

export function ResearchFeedsView({ initialArticles, sources, initialSymbolMap }: Props) {
  const [articles, setArticles] = useState(initialArticles);
  const [symbolMap, setSymbolMap] = useState<Record<string, number>>(initialSymbolMap);
  const [currentSources, setCurrentSources] = useState(sources);
  const [sourceFilter, setSourceFilter] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const [expandedHtml, setExpandedHtml] = useState<string | null>(null);
  const [loadingExpand, setLoadingExpand] = useState(false);

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
      if (data.success) {
        setArticles(data.data);
        if (data.symbolMap) setSymbolMap(data.symbolMap);
      }
    },
    [sourceFilter, searchQuery]
  );

  const handleSync = useCallback(async () => {
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
      setSyncing(false);
      setTimeout(() => setSyncStatus(null), 5000);
    }
  }, [refreshArticles]);

  const handleFilterChange = useCallback(
    async (id: number | null) => {
      setSourceFilter(id);
      setExpandedId(null);
      try { await refreshArticles({ sourceId: id }); } catch { /* keep */ }
    },
    [refreshArticles]
  );

  const handleSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (query.length > 0 && query.length < 2) return;
      setExpandedId(null);
      try { await refreshArticles({ search: query }); } catch { /* keep */ }
    },
    [refreshArticles]
  );

  const handleSourcesChanged = useCallback(async () => {
    try {
      const res = await fetch("/api/research/sources");
      const data = await res.json();
      if (data.success) setCurrentSources(data.data);
      await refreshArticles();
    } catch { /* keep */ }
  }, [refreshArticles]);

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
      {/* Controls bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => handleFilterChange(null)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              sourceFilter === null
                ? "bg-panel text-ink shadow-sm border border-edge"
                : "text-ink-dim hover:text-ink hover:bg-raised"
            }`}
          >
            All
          </button>
          {currentSources
            .filter((s) => s.is_active && s.article_count && s.article_count > 0)
            .map((s) => (
              <button
                key={s.id}
                onClick={() => handleFilterChange(s.id)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  sourceFilter === s.id
                    ? "bg-panel text-ink shadow-sm border border-edge"
                    : "text-ink-dim hover:text-ink hover:bg-raised"
                }`}
              >
                {s.name}
                <span className="ml-1 text-ink-faint">({s.article_count})</span>
              </button>
            ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search articles..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink placeholder:text-ink-faint w-56 focus:outline-none focus:border-gold"
          />
          <button
            onClick={() => setManageOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
            Sources
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-gold text-canvas hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? (
              <div className="w-3.5 h-3.5 border-2 border-canvas border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
            )}
            Sync Feeds
          </button>
        </div>
      </div>

      {/* Sync status */}
      {syncStatus && (
        <div className="px-4 py-2.5 rounded-lg bg-raised border border-edge text-sm text-ink-dim">
          {syncStatus}
        </div>
      )}

      {/* Articles — reader layout */}
      {articles.length === 0 ? (
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

  return (
    <article className={`py-6 first:pt-0 ${expanded ? "" : "cursor-pointer group"}`}>
      {/* Collapsed view — click to expand */}
      <div onClick={expanded ? undefined : onToggle}>
        {/* Meta line */}
        <div className="flex items-center gap-2.5 mb-2">
          <span className="text-xs font-semibold text-gold uppercase tracking-wider">
            {article.source_name}
          </span>
          <span className="text-ink-faint">·</span>
          <time className="text-xs text-ink-faint">{dateStr}</time>
          <SentimentBadge sentiment={article.sentiment} />
        </div>

        {/* Headline */}
        <h3 className={`text-lg font-semibold leading-snug text-ink mb-2 ${expanded ? "" : "group-hover:text-gold transition-colors"}`}>
          {article.subject}
        </h3>

        {/* AI Summary */}
        {article.summary && (
          <p className="text-[15px] leading-[1.7] text-ink-dim mb-3">{article.summary}</p>
        )}

        {/* Portfolio relevance */}
        {article.portfolio_relevance && (
          <p className={`text-[15px] leading-[1.7] text-gold/80 mb-3 pl-3 border-l-2 ${border}`}>
            {article.portfolio_relevance}
          </p>
        )}

        {/* Tags row */}
        <div className="flex items-center justify-between gap-3 mt-3">
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
                Full text not available for this article.
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
