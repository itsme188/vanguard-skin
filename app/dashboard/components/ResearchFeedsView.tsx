"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import type { ResearchArticle, ResearchSource } from "@/lib/queries/research";

interface Props {
  initialArticles: ResearchArticle[];
  sources: ResearchSource[];
}

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  const colors: Record<string, string> = {
    bullish: "bg-up-tint text-up",
    bearish: "bg-down-tint text-down",
    neutral: "bg-raised text-ink-dim",
    mixed: "bg-gold/10 text-gold",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${colors[sentiment] || colors.neutral}`}
    >
      {sentiment}
    </span>
  );
}

function SymbolPills({ symbolsJson }: { symbolsJson: string | null }) {
  if (!symbolsJson) return null;
  let symbols: string[];
  try {
    symbols = JSON.parse(symbolsJson);
  } catch {
    return null;
  }
  if (symbols.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {symbols.slice(0, 8).map((s) => (
        <Link
          key={s}
          href={`/dashboard/search?q=${s}`}
          className="px-1.5 py-0.5 rounded bg-blue-tint text-blue text-[10px] font-mono hover:bg-blue/20 transition-colors"
        >
          {s}
        </Link>
      ))}
      {symbols.length > 8 && (
        <span className="text-[10px] text-ink-faint">
          +{symbols.length - 8} more
        </span>
      )}
    </div>
  );
}

function ThemePills({ themesJson }: { themesJson: string | null }) {
  if (!themesJson) return null;
  let themes: string[];
  try {
    themes = JSON.parse(themesJson);
  } catch {
    return null;
  }
  if (themes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {themes.map((t) => (
        <span
          key={t}
          className="px-1.5 py-0.5 rounded bg-raised text-ink-faint text-[10px]"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

export function ResearchFeedsView({ initialArticles, sources }: Props) {
  const [articles, setArticles] = useState(initialArticles);
  const [sourceFilter, setSourceFilter] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncStatus("Connecting to Gmail...");

    try {
      const res = await fetch("/api/research/sync", { method: "POST" });
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
            setSyncStatus(
              `Fetched ${data.fetched} new article${data.fetched !== 1 ? "s" : ""}`
            );
          } else if (data.phase === "process" && data.status === "started") {
            setSyncStatus("Processing with AI...");
          } else if (data.phase === "process" && data.status === "done") {
            setSyncStatus(
              `Processed ${data.processed} article${data.processed !== 1 ? "s" : ""}`
            );
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

      // Refresh articles
      const articlesRes = await fetch(
        `/api/research/articles?${sourceFilter ? `sourceId=${sourceFilter}&` : ""}limit=50`
      );
      const articlesData = await articlesRes.json();
      if (articlesData.success) setArticles(articlesData.data);
    } catch (err) {
      setSyncStatus(
        `Error: ${err instanceof Error ? err.message : "Sync failed"}`
      );
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncStatus(null), 5000);
    }
  }, [sourceFilter]);

  const handleFilterChange = useCallback(
    async (id: number | null) => {
      setSourceFilter(id);
      try {
        const params = new URLSearchParams();
        if (id) params.set("sourceId", String(id));
        if (searchQuery) params.set("search", searchQuery);
        params.set("limit", "50");

        const res = await fetch(`/api/research/articles?${params}`);
        const data = await res.json();
        if (data.success) setArticles(data.data);
      } catch {
        // Keep existing articles
      }
    },
    [searchQuery]
  );

  const handleSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (query.length > 0 && query.length < 2) return; // Wait for 2+ chars

      try {
        const params = new URLSearchParams();
        if (sourceFilter) params.set("sourceId", String(sourceFilter));
        if (query) params.set("search", query);
        params.set("limit", "50");

        const res = await fetch(`/api/research/articles?${params}`);
        const data = await res.json();
        if (data.success) setArticles(data.data);
      } catch {
        // Keep existing articles
      }
    },
    [sourceFilter]
  );

  return (
    <div className="space-y-4">
      {/* Controls bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Source filter pills */}
          <button
            onClick={() => handleFilterChange(null)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              sourceFilter === null
                ? "bg-panel text-ink shadow-sm border border-edge"
                : "text-ink-dim hover:text-ink hover:bg-raised"
            }`}
          >
            All
          </button>
          {sources
            .filter((s) => s.is_active && s.article_count && s.article_count > 0)
            .map((s) => (
              <button
                key={s.id}
                onClick={() => handleFilterChange(s.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
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
          {/* Search */}
          <input
            type="text"
            placeholder="Search articles..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="px-3 py-1.5 rounded-md bg-raised border border-edge text-xs text-ink placeholder:text-ink-faint w-48 focus:outline-none focus:border-gold"
          />

          {/* Sync button */}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-gold text-canvas hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? (
              <div className="w-3 h-3 border border-canvas border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"
                />
              </svg>
            )}
            Sync Feeds
          </button>
        </div>
      </div>

      {/* Sync status */}
      {syncStatus && (
        <div className="px-3 py-2 rounded-md bg-raised border border-edge text-xs text-ink-dim">
          {syncStatus}
        </div>
      )}

      {/* Articles list */}
      {articles.length === 0 ? (
        <div className="rounded-xl border border-edge bg-panel p-8 text-center">
          <p className="text-ink-dim text-sm">No articles yet.</p>
          <p className="text-ink-faint text-xs mt-1">
            Connect Gmail and click &quot;Sync Feeds&quot; to fetch newsletters.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {articles.map((article) => (
            <ArticleCard key={article.id} article={article} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArticleCard({ article }: { article: ResearchArticle }) {
  const dateStr = article.received_at.slice(0, 10);

  return (
    <div className="rounded-lg border border-edge bg-panel p-4 space-y-2 hover:border-edge-strong transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-medium text-gold uppercase tracking-wide">
              {article.source_name}
            </span>
            <span className="text-[10px] text-ink-faint font-mono">
              {dateStr}
            </span>
            <SentimentBadge sentiment={article.sentiment} />
          </div>
          <h4 className="text-sm font-medium text-ink leading-snug truncate">
            {article.subject}
          </h4>
        </div>
      </div>

      {article.summary && (
        <p className="text-xs text-ink-dim leading-relaxed">{article.summary}</p>
      )}

      {article.portfolio_relevance && (
        <p className="text-xs text-gold/80 leading-relaxed">
          <span className="font-medium">Portfolio:</span>{" "}
          {article.portfolio_relevance}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <SymbolPills symbolsJson={article.mentioned_symbols} />
        <ThemePills themesJson={article.key_themes} />
      </div>
    </div>
  );
}
