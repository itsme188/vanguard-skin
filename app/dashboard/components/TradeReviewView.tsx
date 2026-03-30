"use client";

import { useState, useCallback } from "react";
import type { TradeReview, TradeRoundtrip } from "@/lib/types";
import { MarkdownMessage } from "./MarkdownMessage";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";

// ─── Types ──────────────────────────────────────────────────────

interface ReviewPeriod {
  periodStart: string;
  periodEnd: string;
  tradeCount: number;
}

interface TradeReviewWithAccount extends TradeReview {
  account_name: string;
}

interface TradeReviewViewProps {
  initialReviews: TradeReviewWithAccount[];
  accounts: { id: number; name: string }[];
  initialPeriods: ReviewPeriod[];
  defaultAccountId: number | null;
}

// ─── Grade styling ──────────────────────────────────────────────

const GRADE_STYLES: Record<string, string> = {
  A: "bg-up/20 text-up border-up/30",
  B: "bg-up/10 text-up/80 border-up/20",
  C: "bg-gold/15 text-gold border-gold/25",
  D: "bg-down/10 text-down/80 border-down/20",
  F: "bg-down/20 text-down border-down/30",
};

function GradeBadge({ grade }: { grade: string | null }) {
  if (!grade) return <span className="text-ink-faint">—</span>;
  return (
    <span
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md border text-xs font-bold ${GRADE_STYLES[grade] ?? "bg-muted text-ink-dim border-edge"}`}
    >
      {grade}
    </span>
  );
}

// ─── SSE helper ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readSseStream(res: Response, onData: (data: any) => void) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return;
      try {
        onData(JSON.parse(payload));
      } catch {
        /* skip */
      }
    }
  }
}

// ─── Main Component ─────────────────────────────────────────────

export function TradeReviewView({
  initialReviews,
  accounts,
  initialPeriods,
  defaultAccountId,
}: TradeReviewViewProps) {
  const [reviews, setReviews] = useState(initialReviews);
  const [periods, setPeriods] = useState(initialPeriods);
  const [selectedAccountId, setSelectedAccountId] = useState(
    defaultAccountId ?? accounts[0]?.id ?? 0
  );
  const [expandedReviewId, setExpandedReviewId] = useState<number | null>(null);
  const [detailRoundtrips, setDetailRoundtrips] = useState<TradeRoundtrip[]>(
    []
  );
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Generate state
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<string>(
    periods[0]?.periodStart ?? ""
  );

  // Confirm re-generate
  const [confirmRegenerate, setConfirmRegenerate] = useState<{
    periodStart: string;
    periodEnd: string;
  } | null>(null);

  // ── Load detail ───────────────────────────────────────────────
  const loadReviewDetail = useCallback(async (reviewId: number) => {
    if (expandedReviewId === reviewId) {
      setExpandedReviewId(null);
      return;
    }
    setLoadingDetail(true);
    setExpandedReviewId(reviewId);
    try {
      const res = await fetch(`/api/trade-review?id=${reviewId}`);
      if (res.ok) {
        const json = await res.json();
        setDetailRoundtrips(json.roundTrips ?? []);
      }
    } finally {
      setLoadingDetail(false);
    }
  }, [expandedReviewId]);

  // ── Generate review ───────────────────────────────────────────
  const handleGenerate = useCallback(
    async (periodStart: string, periodEnd: string) => {
      // Check if review already exists
      const existing = reviews.find(
        (r) =>
          r.account_id === selectedAccountId &&
          r.period_start === periodStart
      );
      if (existing) {
        setConfirmRegenerate({ periodStart, periodEnd });
        return;
      }
      await doGenerate(periodStart, periodEnd);
    },
    [reviews, selectedAccountId]
  );

  const doGenerate = async (periodStart: string, periodEnd: string) => {
    setGenerating(true);
    setGenerateMsg("Starting...");
    try {
      const res = await fetch("/api/trade-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: selectedAccountId,
          periodStart,
          periodEnd,
        }),
      });
      if (!res.ok) {
        setGenerateMsg(`Error: ${res.statusText}`);
        return;
      }

      await readSseStream(res, (data) => {
        if (data.progress) setGenerateMsg(data.progress.message);
        if (data.complete) {
          setGenerateMsg(
            `Review complete — ${data.data.tradeCount} trades, ${(data.data.winRate * 100).toFixed(0)}% win rate`
          );
        }
        if (data.error) setGenerateMsg(`Error: ${data.error}`);
      });

      // Refresh reviews list
      const listRes = await fetch(
        `/api/trade-review?accountId=${selectedAccountId}`
      );
      if (listRes.ok) {
        const json = await listRes.json();
        setReviews(json.reviews);
      }

      // Refresh available periods
      const periodsRes = await fetch(
        `/api/trade-review?periods=true&accountId=${selectedAccountId}`
      );
      if (periodsRes.ok) {
        const json = await periodsRes.json();
        setPeriods(json.periods);
      }
    } catch (err) {
      setGenerateMsg(
        `Error: ${err instanceof Error ? err.message : "Unknown"}`
      );
    } finally {
      setGenerating(false);
    }
  };

  // ── Account change ────────────────────────────────────────────
  const handleAccountChange = async (accountId: number) => {
    setSelectedAccountId(accountId);
    setExpandedReviewId(null);

    const [listRes, periodsRes] = await Promise.all([
      fetch(`/api/trade-review?accountId=${accountId}`),
      fetch(`/api/trade-review?periods=true&accountId=${accountId}`),
    ]);

    if (listRes.ok) {
      const json = await listRes.json();
      setReviews(json.reviews);
    }
    if (periodsRes.ok) {
      const json = await periodsRes.json();
      setPeriods(json.periods);
      setSelectedPeriod(json.periods[0]?.periodStart ?? "");
    }
  };

  // ── Find unreviewd periods ────────────────────────────────────
  const unreviewedPeriods = periods.filter(
    (p) =>
      !reviews.some(
        (r) =>
          r.account_id === selectedAccountId &&
          r.period_start === p.periodStart
      )
  );

  return (
    <div className="space-y-6">
      {/* ── Account picker + Generator ───────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex items-center gap-3">
          <label className="text-xs text-ink-faint uppercase tracking-wide">
            Account
          </label>
          <select
            value={selectedAccountId}
            onChange={(e) => handleAccountChange(Number(e.target.value))}
            className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus-ring"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 flex-1">
          <label className="text-xs text-ink-faint uppercase tracking-wide">
            Month
          </label>
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            disabled={generating || periods.length === 0}
            className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus-ring min-w-[160px]"
          >
            {periods.length === 0 && (
              <option value="">No trades found</option>
            )}
            {periods.map((p) => {
              const hasReview = reviews.some(
                (r) =>
                  r.account_id === selectedAccountId &&
                  r.period_start === p.periodStart
              );
              return (
                <option key={p.periodStart} value={p.periodStart}>
                  {formatMonthLabel(p.periodStart)} ({p.tradeCount} trades)
                  {hasReview ? " ✓" : ""}
                </option>
              );
            })}
          </select>

          <button
            onClick={() => {
              const period = periods.find(
                (p) => p.periodStart === selectedPeriod
              );
              if (period) handleGenerate(period.periodStart, period.periodEnd);
            }}
            disabled={generating || !selectedPeriod}
            className="px-4 py-1.5 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all focus-ring whitespace-nowrap"
          >
            {generating ? "Generating..." : "Generate Review"}
          </button>
        </div>
      </div>

      {/* ── Progress message ─────────────────────────────────── */}
      {generateMsg && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            generateMsg.startsWith("Error")
              ? "border-down/30 bg-down/10 text-down"
              : "border-edge bg-raised text-ink-dim"
          }`}
        >
          {generating && (
            <span className="inline-block w-3 h-3 border-2 border-gold border-t-transparent rounded-full animate-spin mr-2 align-text-bottom" />
          )}
          {generateMsg}
        </div>
      )}

      {/* ── Unreviewed prompt ────────────────────────────────── */}
      {unreviewedPeriods.length > 0 && !generating && (
        <div className="rounded-lg border border-gold/20 bg-gold/5 px-4 py-3 text-sm text-ink-dim">
          {unreviewedPeriods.length} month
          {unreviewedPeriods.length > 1 ? "s" : ""} with trades but no review:{" "}
          {unreviewedPeriods
            .slice(0, 3)
            .map((p) => formatMonthLabel(p.periodStart))
            .join(", ")}
          {unreviewedPeriods.length > 3 &&
            ` and ${unreviewedPeriods.length - 3} more`}
        </div>
      )}

      {/* ── Reviews list ─────────────────────────────────────── */}
      {reviews.length === 0 ? (
        <EmptyState
          icon={<span className="text-xl">📊</span>}
          title="No trade reviews yet"
          description="Select a month with closed trades and click Generate Review to get AI-powered analysis of your trading."
        />
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              isExpanded={expandedReviewId === review.id}
              roundtrips={
                expandedReviewId === review.id ? detailRoundtrips : []
              }
              loadingDetail={
                loadingDetail && expandedReviewId === review.id
              }
              onToggle={() => loadReviewDetail(review.id)}
              onRegenerate={() =>
                handleGenerate(review.period_start, review.period_end)
              }
            />
          ))}
        </div>
      )}

      {/* ── Confirm re-generate dialog ───────────────────────── */}
      <ConfirmDialog
        open={!!confirmRegenerate}
        title="Regenerate Review?"
        message="This will replace the existing review for this month with a new AI analysis. The previous review will be lost."
        confirmLabel="Regenerate"
        onConfirm={() => {
          if (confirmRegenerate) {
            doGenerate(
              confirmRegenerate.periodStart,
              confirmRegenerate.periodEnd
            );
          }
          setConfirmRegenerate(null);
        }}
        onCancel={() => setConfirmRegenerate(null)}
      />
    </div>
  );
}

// ─── Review Card ────────────────────────────────────────────────

function ReviewCard({
  review,
  isExpanded,
  roundtrips,
  loadingDetail,
  onToggle,
  onRegenerate,
}: {
  review: TradeReviewWithAccount;
  isExpanded: boolean;
  roundtrips: TradeRoundtrip[];
  loadingDetail: boolean;
  onToggle: () => void;
  onRegenerate: () => void;
}) {
  const pnlColor =
    review.total_realized_pnl >= 0 ? "text-up" : "text-down";
  const pnlSign = review.total_realized_pnl >= 0 ? "+" : "";

  return (
    <div className="rounded-xl border border-edge bg-panel overflow-hidden">
      {/* Summary header — always visible */}
      <button
        onClick={onToggle}
        className="w-full text-left px-5 py-4 hover:bg-raised/50 transition-colors"
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-ink">
            {formatMonthLabel(review.period_start)}
          </h3>
          <span className="text-xs text-ink-faint">
            {review.account_name}
          </span>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <span className="text-ink-dim">
            <span className="text-ink font-medium">{review.total_trades}</span>{" "}
            trades
          </span>
          <span className="text-ink-dim">
            <span className="text-ink font-medium">
              {(review.win_rate * 100).toFixed(0)}%
            </span>{" "}
            win rate
          </span>
          <span className={pnlColor}>
            <span className="font-mono font-medium">
              {pnlSign}${review.total_realized_pnl.toFixed(0)}
            </span>{" "}
            P&L
          </span>
          {review.profit_factor != null && (
            <span className="text-ink-dim">
              <span className="text-ink font-medium">
                {review.profit_factor.toFixed(1)}x
              </span>{" "}
              profit factor
            </span>
          )}
          {review.avg_holding_days != null && (
            <span className="text-ink-dim">
              <span className="text-ink font-medium">
                {review.avg_holding_days.toFixed(1)}
              </span>{" "}
              avg days
            </span>
          )}
          <span className="text-ink-faint ml-auto">
            {isExpanded ? "▲" : "▼"}
          </span>
        </div>

        {/* Best/Worst trade quick view */}
        {review.best_trade_symbol && review.worst_trade_symbol && (
          <div className="flex gap-4 mt-2 text-xs">
            <span className="text-up">
              Best: {review.best_trade_symbol}{" "}
              <span className="font-mono">
                +${review.best_trade_pnl?.toFixed(0)}
              </span>
            </span>
            <span className="text-down">
              Worst: {review.worst_trade_symbol}{" "}
              <span className="font-mono">
                ${review.worst_trade_pnl?.toFixed(0)}
              </span>
            </span>
          </div>
        )}
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-edge">
          {loadingDetail ? (
            <div className="p-5 text-sm text-ink-dim">
              Loading review details...
            </div>
          ) : (
            <ReviewDetail
              review={review}
              roundtrips={roundtrips}
              onRegenerate={onRegenerate}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Review Detail ──────────────────────────────────────────────

function ReviewDetail({
  review,
  roundtrips,
  onRegenerate,
}: {
  review: TradeReviewWithAccount;
  roundtrips: TradeRoundtrip[];
  onRegenerate: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"review" | "grades" | "patterns">(
    "review"
  );

  const tabs = [
    { key: "review" as const, label: "Full Review" },
    { key: "grades" as const, label: `Trade Grades (${roundtrips.length})` },
    { key: "patterns" as const, label: "Patterns" },
  ];

  return (
    <div className="divide-y divide-edge">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-5 py-2 bg-raised/30">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-raised text-ink"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={onRegenerate}
          className="text-[10px] text-ink-faint hover:text-gold transition-colors"
          title="Regenerate this review"
        >
          ↻ Regenerate
        </button>
      </div>

      {/* Tab content */}
      <div className="p-5">
        {activeTab === "review" && (
          <div className="prose-sm max-w-none">
            <MarkdownMessage content={review.review_markdown} />
          </div>
        )}

        {activeTab === "grades" && (
          <TradeGradeTable roundtrips={roundtrips} />
        )}

        {activeTab === "patterns" && (
          <PatternsPanel review={review} />
        )}
      </div>

      {/* Meta footer */}
      <div className="px-5 py-2 text-[10px] text-ink-faint flex gap-4">
        <span>Model: {review.model ?? "unknown"}</span>
        {review.prompt_tokens != null && (
          <span>
            Tokens: {review.prompt_tokens?.toLocaleString()} in /{" "}
            {review.completion_tokens?.toLocaleString()} out
          </span>
        )}
        <span>Generated: {review.generated_at}</span>
      </div>
    </div>
  );
}

// ─── Trade Grade Table ──────────────────────────────────────────

function TradeGradeTable({ roundtrips }: { roundtrips: TradeRoundtrip[] }) {
  if (roundtrips.length === 0) {
    return (
      <p className="text-sm text-ink-dim">
        No trade grades available for this review.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-edge">
            <th className="text-left text-[10px] uppercase tracking-widest text-ink-faint font-medium pb-2 pr-3">
              Grade
            </th>
            <th className="text-left text-[10px] uppercase tracking-widest text-ink-faint font-medium pb-2 pr-3">
              Symbol
            </th>
            <th className="text-left text-[10px] uppercase tracking-widest text-ink-faint font-medium pb-2 pr-3">
              Entry
            </th>
            <th className="text-left text-[10px] uppercase tracking-widest text-ink-faint font-medium pb-2 pr-3">
              Exit
            </th>
            <th className="text-right text-[10px] uppercase tracking-widest text-ink-faint font-medium pb-2 pr-3">
              Days
            </th>
            <th className="text-right text-[10px] uppercase tracking-widest text-ink-faint font-medium pb-2 pr-3">
              P&L
            </th>
            <th className="text-right text-[10px] uppercase tracking-widest text-ink-faint font-medium pb-2">
              Return
            </th>
          </tr>
        </thead>
        <tbody>
          {roundtrips.map((rt) => {
            const pnlColor =
              rt.realized_pnl >= 0 ? "text-up" : "text-down";
            const sign = rt.realized_pnl >= 0 ? "+" : "";
            return (
              <tr
                key={rt.id}
                className="border-b border-edge/50 last:border-0 group"
              >
                <td className="py-2 pr-3">
                  <GradeBadge grade={rt.grade} />
                </td>
                <td className="py-2 pr-3 font-mono font-medium text-ink">
                  {rt.symbol}
                </td>
                <td className="py-2 pr-3 text-ink-dim tabular-nums">
                  {rt.entry_date}
                  <span className="text-ink-faint ml-1.5">
                    @${rt.entry_price.toFixed(2)}
                  </span>
                </td>
                <td className="py-2 pr-3 text-ink-dim tabular-nums">
                  {rt.exit_date}
                  <span className="text-ink-faint ml-1.5">
                    @${rt.exit_price.toFixed(2)}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-ink-dim">
                  {rt.holding_days}
                </td>
                <td
                  className={`py-2 pr-3 text-right font-mono tabular-nums ${pnlColor}`}
                >
                  {sign}${rt.realized_pnl.toFixed(0)}
                </td>
                <td
                  className={`py-2 text-right font-mono tabular-nums ${pnlColor}`}
                >
                  {sign}{rt.return_pct.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Per-trade AI assessments (expandable) */}
      {roundtrips.some((rt) => rt.entry_thesis) && (
        <div className="mt-4 space-y-3">
          <h4 className="text-xs uppercase tracking-widest text-ink-faint font-medium">
            Per-Trade Analysis
          </h4>
          {roundtrips
            .filter((rt) => rt.entry_thesis || rt.exit_assessment)
            .map((rt) => (
              <div
                key={rt.id}
                className="rounded-lg border border-edge bg-raised/30 p-3"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <GradeBadge grade={rt.grade} />
                  <span className="font-mono text-xs font-medium text-ink">
                    {rt.symbol}
                  </span>
                  <span className="text-[10px] text-ink-faint">
                    {rt.entry_date} → {rt.exit_date}
                  </span>
                </div>
                {rt.entry_thesis && (
                  <p className="text-xs text-ink-dim mb-1">
                    <span className="text-ink-faint">Entry:</span>{" "}
                    {rt.entry_thesis}
                  </p>
                )}
                {rt.exit_assessment && (
                  <p className="text-xs text-ink-dim mb-1">
                    <span className="text-ink-faint">Exit:</span>{" "}
                    {rt.exit_assessment}
                  </p>
                )}
                {rt.what_went_well && (
                  <p className="text-xs text-up/80">
                    ✓ {rt.what_went_well}
                  </p>
                )}
                {rt.what_went_wrong && (
                  <p className="text-xs text-down/80">
                    ✗ {rt.what_went_wrong}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Patterns Panel ─────────────────────────────────────────────

function PatternsPanel({ review }: { review: TradeReview }) {
  const strengths = safeParseJson<string[]>(review.strengths);
  const weaknesses = safeParseJson<string[]>(review.weaknesses);
  const patterns = safeParseJson<string[]>(review.patterns_identified);
  const cumulative = safeParseJson<string[]>(review.cumulative_patterns);

  return (
    <div className="space-y-4">
      {patterns && patterns.length > 0 && (
        <PatternSection
          title="Patterns Identified"
          items={patterns}
          color="text-ink-dim"
        />
      )}
      {strengths && strengths.length > 0 && (
        <PatternSection
          title="Strengths"
          items={strengths}
          color="text-up"
          icon="✓"
        />
      )}
      {weaknesses && weaknesses.length > 0 && (
        <PatternSection
          title="Weaknesses"
          items={weaknesses}
          color="text-down"
          icon="✗"
        />
      )}
      {cumulative && cumulative.length > 0 && (
        <div className="border-t border-edge pt-4">
          <PatternSection
            title="Cumulative Patterns (across all reviews)"
            items={cumulative}
            color="text-gold"
          />
        </div>
      )}
      {!patterns?.length &&
        !strengths?.length &&
        !weaknesses?.length && (
          <p className="text-sm text-ink-dim">
            No structured patterns available for this review.
          </p>
        )}
    </div>
  );
}

function PatternSection({
  title,
  items,
  color,
  icon,
}: {
  title: string;
  items: string[];
  color: string;
  icon?: string;
}) {
  return (
    <div>
      <h4 className="text-xs uppercase tracking-widest text-ink-faint font-medium mb-2">
        {title}
      </h4>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className={`text-sm ${color}`}>
            {icon && <span className="mr-1.5">{icon}</span>}
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function formatMonthLabel(periodStart: string): string {
  const d = new Date(periodStart + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function safeParseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
