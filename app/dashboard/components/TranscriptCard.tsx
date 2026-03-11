"use client";

import { useState } from "react";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";

const SOURCE_BADGES: Record<string, { label: string; className: string }> = {
  edgar_8k: { label: "8-K", className: "bg-gold/15 text-gold" },
  motley_fool: { label: "MF", className: "bg-blue/15 text-blue" },
  api_ninjas: { label: "API", className: "bg-up/15 text-up" },
};

const SENTIMENT_STYLES: Record<string, string> = {
  bullish: "bg-up/15 text-up",
  bearish: "bg-down/15 text-down",
  neutral: "bg-muted text-ink-dim",
};

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}, ${year}`;
}

interface TranscriptCardProps {
  transcript: TranscriptSummaryEntry;
  onFetch?: (ticker: string, year: number, quarter: number) => void;
  isFetching?: boolean;
}

export function TranscriptCard({
  transcript: t,
  onFetch,
  isFetching,
}: TranscriptCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const source = SOURCE_BADGES[t.source] || {
    label: t.source,
    className: "bg-muted text-ink-dim",
  };

  async function loadFullTranscript() {
    if (fullText) {
      setShowFullTranscript(true);
      return;
    }
    setLoadingFull(true);
    try {
      const res = await fetch(
        `/api/transcripts?ticker=${t.ticker}&year=${t.year}&quarter=${t.quarter}`
      );
      const data = await res.json();
      if (data.success && data.data?.transcript) {
        setFullText(data.data.transcript);
        setShowFullTranscript(true);
      }
    } catch {
      // Silent fail
    } finally {
      setLoadingFull(false);
    }
  }

  return (
    <>
      <div className="bg-panel border border-edge rounded-xl border-l-4 border-l-[#818CF8] p-4">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="font-mono text-sm font-semibold text-ink">
            {t.ticker}
          </span>
          <span className="text-xs text-ink-dim">
            Q{t.quarter} {t.year}
          </span>
          {t.call_date && (
            <span className="text-xs text-ink-faint">
              {formatDate(t.call_date)}
            </span>
          )}
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${source.className}`}
          >
            {source.label}
          </span>
          {t.sentiment_label && (
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${SENTIMENT_STYLES[t.sentiment_label] ?? ""}`}
            >
              {t.sentiment_label}
              {t.sentiment_score !== null && (
                <span className="ml-1 opacity-75">
                  ({t.sentiment_score > 0 ? "+" : ""}
                  {t.sentiment_score.toFixed(2)})
                </span>
              )}
            </span>
          )}
          <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint bg-muted px-1.5 py-0.5 rounded">
            transcript
          </span>
        </div>

        {/* Summary */}
        {t.summary && (
          <p className="text-sm text-ink-dim leading-relaxed mb-3">
            {t.summary.length > 300 && !expanded
              ? t.summary.slice(0, 300) + "..."
              : t.summary}
            {t.summary.length > 300 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="ml-1 text-xs text-gold hover:text-gold/80"
              >
                {expanded ? "Show less" : "Read more"}
              </button>
            )}
          </p>
        )}

        {/* Expandable sections */}
        {(t.guidance || t.risk_factors) && (
          <div className="space-y-2 mb-3">
            {t.guidance && (
              <details className="group">
                <summary className="text-xs font-medium text-blue cursor-pointer hover:text-blue/80">
                  Guidance
                </summary>
                <p className="text-xs text-ink-dim mt-1 pl-3 border-l border-blue/30 leading-relaxed">
                  {t.guidance}
                </p>
              </details>
            )}
            {t.risk_factors && (
              <details className="group">
                <summary className="text-xs font-medium text-down cursor-pointer hover:text-down/80">
                  Risk Factors
                </summary>
                <p className="text-xs text-ink-dim mt-1 pl-3 border-l border-down/30 leading-relaxed">
                  {t.risk_factors}
                </p>
              </details>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {t.has_full_transcript && (
            <button
              onClick={loadFullTranscript}
              disabled={loadingFull}
              className="text-xs text-gold hover:text-gold/80 disabled:opacity-40"
            >
              {loadingFull ? "Loading..." : "View Full Transcript"}
            </button>
          )}
          {onFetch && (
            <button
              onClick={() => onFetch(t.ticker, t.year, t.quarter)}
              disabled={isFetching}
              className="text-xs text-ink-faint hover:text-ink disabled:opacity-40"
            >
              {isFetching ? "Fetching..." : "Refresh"}
            </button>
          )}
        </div>
      </div>

      {/* Full transcript modal */}
      {showFullTranscript && fullText && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowFullTranscript(false)}
        >
          <div
            className="bg-panel border border-edge rounded-2xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-edge">
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold text-ink">
                  {t.ticker}
                </span>
                <span className="text-sm text-ink-dim">
                  Q{t.quarter} {t.year} Earnings
                </span>
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${source.className}`}
                >
                  {source.label}
                </span>
              </div>
              <button
                onClick={() => setShowFullTranscript(false)}
                className="text-ink-faint hover:text-ink p-1"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal body */}
            <div className="overflow-y-auto px-6 py-4">
              <pre className="text-sm text-ink whitespace-pre-wrap font-sans leading-relaxed">
                {fullText}
              </pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Fetch button for fetching a new transcript.
 */
export function FetchTranscriptButton({
  ticker,
  onFetched,
}: {
  ticker: string;
  onFetched?: () => void;
}) {
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFetch() {
    setIsFetching(true);
    setError(null);
    try {
      const res = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      onFetched?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setIsFetching(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={handleFetch}
        disabled={isFetching}
        className="text-xs text-gold hover:text-gold/80 disabled:opacity-40"
      >
        {isFetching ? "Fetching..." : `Fetch ${ticker} Transcript`}
      </button>
      {error && <span className="text-xs text-down">{error}</span>}
    </div>
  );
}
