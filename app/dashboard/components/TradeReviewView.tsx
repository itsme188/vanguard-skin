"use client";

import { useState, useCallback } from "react";
import type { TradeReview } from "@/lib/types";
import { MarkdownMessage } from "./MarkdownMessage";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Money, Pct, Shares, PrivateText } from "@/lib/privacy/components";

// ─── Types ──────────────────────────────────────────────────────

interface ReviewPeriod {
  periodStart: string;
  periodEnd: string;
  tradeCount: number;
}

interface TradeReviewWithAccount extends TradeReview {
  account_name: string;
}

interface GroupedTradeResponse {
  saleTransactionId: number | null;
  symbol: string;
  exitDate: string;
  grade: string | null;
  assessment: string | null;
  whatWorked: string | null;
  whatDidnt: string | null;
  totalPnl: number;
  avgEntryPrice: number;
  exitPrice: number;
  totalQuantity: number;
  maxHoldingDays: number;
  lots: Array<{
    id: number;
    entryDate: string;
    entryPrice: number;
    exitQuantity: number;
    holdingDays: number;
    realizedPnl: number;
    returnPct: number;
  }>;
}

interface TradeQuestion {
  tradeNumber: number;
  symbol: string;
  question: string;
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

const GRADE_COLORS: Record<string, string> = {
  A: "bg-up",
  B: "bg-up/60",
  C: "bg-gold",
  D: "bg-down/60",
  F: "bg-down",
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
  const [detailGroupedTrades, setDetailGroupedTrades] = useState<
    GroupedTradeResponse[]
  >([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Generate state
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<string>(
    periods[0]?.periodStart ?? ""
  );

  // Q&A state
  const [questions, setQuestions] = useState<TradeQuestion[]>([]);
  const [questionAnswers, setQuestionAnswers] = useState<
    Record<number, string>
  >({});
  const [pendingGenerate, setPendingGenerate] = useState<{
    periodStart: string;
    periodEnd: string;
  } | null>(null);

  // Confirm re-generate
  const [confirmRegenerate, setConfirmRegenerate] = useState<{
    periodStart: string;
    periodEnd: string;
  } | null>(null);

  // ── Load detail ───────────────────────────────────────────────
  const loadReviewDetail = useCallback(
    async (reviewId: number) => {
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
          setDetailGroupedTrades(json.groupedTrades ?? []);
        }
      } finally {
        setLoadingDetail(false);
      }
    },
    [expandedReviewId]
  );

  // ── Generate review (Phase 1) ─────────────────────────────────
  const handleGenerate = useCallback(
    async (periodStart: string, periodEnd: string) => {
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

  const doGenerate = async (
    periodStart: string,
    periodEnd: string,
    answers?: Array<{ tradeNumber: number; answer: string }>
  ) => {
    setGenerating(true);
    setGenerateMsg("Starting...");
    setQuestions([]);
    setQuestionAnswers({});

    try {
      const body: Record<string, unknown> = {
        accountId: selectedAccountId,
        periodStart,
        periodEnd,
      };
      if (answers) body.answers = answers;

      const res = await fetch("/api/trade-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setGenerateMsg(`Error: ${res.statusText}`);
        return;
      }

      await readSseStream(res, (data) => {
        if (data.progress) setGenerateMsg(data.progress.message);
        if (data.questions) {
          // Phase 1 complete — show Q&A
          setQuestions(data.questions);
          setPendingGenerate({ periodStart, periodEnd });
          setGenerating(false);
          setGenerateMsg(null);
        }
        if (data.complete) {
          setGenerateMsg(
            `Review complete — ${data.data.tradeCount} trade(s), ${(data.data.winRate * 100).toFixed(0)}% win rate`
          );
        }
        if (data.error) setGenerateMsg(`Error: ${data.error}`);
      });

      // If we didn't get questions (direct complete), refresh
      if (questions.length === 0) {
        await refreshReviews();
      }
    } catch (err) {
      setGenerateMsg(
        `Error: ${err instanceof Error ? err.message : "Unknown"}`
      );
    } finally {
      if (questions.length === 0) setGenerating(false);
    }
  };

  // ── Submit Q&A answers (Phase 2) ──────────────────────────────
  const handleSubmitAnswers = async () => {
    if (!pendingGenerate) return;
    const answers = Object.entries(questionAnswers)
      .filter(([, ans]) => ans.trim())
      .map(([tradeNum, answer]) => ({
        tradeNumber: parseInt(tradeNum, 10),
        answer: answer.trim(),
      }));
    setQuestions([]);
    setPendingGenerate(null);
    await doGenerate(
      pendingGenerate.periodStart,
      pendingGenerate.periodEnd,
      answers.length > 0 ? answers : undefined
    );
    await refreshReviews();
  };

  const handleSkipQuestions = async () => {
    if (!pendingGenerate) return;
    setQuestions([]);
    setPendingGenerate(null);
    // Pass empty answers array to signal Phase 2 (not Phase 1 again)
    await doGenerate(
      pendingGenerate.periodStart,
      pendingGenerate.periodEnd,
      []
    );
    await refreshReviews();
  };

  // ── Refresh data ────────────────────────────────────────────
  const refreshReviews = async () => {
    const [listRes, periodsRes] = await Promise.all([
      fetch(`/api/trade-review?accountId=${selectedAccountId}`),
      fetch(`/api/trade-review?periods=true&accountId=${selectedAccountId}`),
    ]);
    if (listRes.ok) {
      const json = await listRes.json();
      setReviews(json.reviews);
    }
    if (periodsRes.ok) {
      const json = await periodsRes.json();
      setPeriods(json.periods);
    }
  };

  // ── Account change ────────────────────────────────────────────
  const handleAccountChange = async (accountId: number) => {
    setSelectedAccountId(accountId);
    setExpandedReviewId(null);
    setQuestions([]);

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

  // ── Find unreviewed periods ─────────────────────────────────
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

      {/* ── Q&A Panel ────────────────────────────────────────── */}
      {questions.length > 0 && (
        <div className="rounded-xl border border-gold/30 bg-gold/5 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-medium text-ink mb-1">
              Quick context check
            </h3>
            <p className="text-xs text-ink-dim">
              A few questions to help produce a more accurate review. Answer
              what you can — skip any you don&apos;t want to answer.
            </p>
          </div>
          {questions.map((q) => (
            <div key={q.tradeNumber} className="space-y-1.5">
              <label className="text-xs text-ink">
                <span className="font-mono font-medium text-gold">
                  {q.symbol}
                </span>{" "}
                — {q.question}
              </label>
              <input
                type="text"
                value={questionAnswers[q.tradeNumber] ?? ""}
                onChange={(e) =>
                  setQuestionAnswers((prev) => ({
                    ...prev,
                    [q.tradeNumber]: e.target.value,
                  }))
                }
                placeholder="Your answer (optional)"
                className="w-full bg-raised border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-ring"
              />
            </div>
          ))}
          <div className="flex gap-3 pt-1">
            <button
              onClick={handleSubmitAnswers}
              className="px-4 py-1.5 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-all focus-ring"
            >
              Submit & Generate
            </button>
            <button
              onClick={handleSkipQuestions}
              className="px-4 py-1.5 rounded-lg border border-edge text-sm text-ink-dim hover:text-ink transition-colors focus-ring"
            >
              Skip — generate without my input
            </button>
          </div>
        </div>
      )}

      {/* ── Unreviewed prompt ────────────────────────────────── */}
      {unreviewedPeriods.length > 0 &&
        !generating &&
        questions.length === 0 && (
          <div className="rounded-lg border border-gold/20 bg-gold/5 px-4 py-3 text-sm text-ink-dim">
            {unreviewedPeriods.length} month
            {unreviewedPeriods.length > 1 ? "s" : ""} with trades but no
            review:{" "}
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
              groupedTrades={
                expandedReviewId === review.id ? detailGroupedTrades : []
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
  groupedTrades,
  loadingDetail,
  onToggle,
  onRegenerate,
}: {
  review: TradeReviewWithAccount;
  isExpanded: boolean;
  groupedTrades: GroupedTradeResponse[];
  loadingDetail: boolean;
  onToggle: () => void;
  onRegenerate: () => void;
}) {
  const pnlColor =
    review.total_realized_pnl >= 0 ? "text-up" : "text-down";

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
            <span className="text-ink font-medium">
              {review.total_trades}
            </span>{" "}
            trade{review.total_trades !== 1 ? "s" : ""}
          </span>
          <span className="text-ink-dim">
            <Pct
              value={review.win_rate * 100}
              digits={0}
              className="text-ink font-medium"
            />{" "}
            win rate
          </span>
          <span className={pnlColor}>
            <Money
              value={review.total_realized_pnl}
              signed
              className="font-mono font-medium"
            />{" "}
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
          <span className="text-ink-faint ml-auto">
            {isExpanded ? "▲" : "▼"}
          </span>
        </div>
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
              groupedTrades={groupedTrades}
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
  groupedTrades,
  onRegenerate,
}: {
  review: TradeReviewWithAccount;
  groupedTrades: GroupedTradeResponse[];
  onRegenerate: () => void;
}) {
  const [activeTab, setActiveTab] = useState<
    "trades" | "review" | "patterns"
  >("trades");

  const tabs = [
    {
      key: "trades" as const,
      label: `Trades (${groupedTrades.length})`,
    },
    { key: "review" as const, label: "Full Review" },
    { key: "patterns" as const, label: "Patterns" },
  ];

  // Grade distribution for summary strip
  const gradeCounts: Record<string, number> = {};
  for (const t of groupedTrades) {
    if (t.grade) gradeCounts[t.grade] = (gradeCounts[t.grade] || 0) + 1;
  }

  return (
    <div className="divide-y divide-edge">
      {/* Summary strip */}
      <div className="px-5 py-3 flex flex-wrap items-center gap-4 bg-raised/20">
        <MetricBadge
          label="P&L"
          value={<Money value={review.total_realized_pnl} signed />}
          color={review.total_realized_pnl >= 0 ? "text-up" : "text-down"}
        />
        <MetricBadge
          label="Win Rate"
          value={<Pct value={review.win_rate * 100} digits={0} />}
          color="text-ink"
        />
        {review.profit_factor != null && (
          <MetricBadge
            label="Profit Factor"
            value={`${review.profit_factor.toFixed(1)}x`}
            color="text-ink"
          />
        )}
        {/* Grade distribution bar */}
        {Object.keys(gradeCounts).length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-ink-faint">
              Grades
            </span>
            <div className="flex h-3 rounded-sm overflow-hidden min-w-[80px]">
              {["A", "B", "C", "D", "F"].map((g) =>
                gradeCounts[g] ? (
                  <div
                    key={g}
                    className={`${GRADE_COLORS[g]} flex items-center justify-center`}
                    style={{
                      width: `${(gradeCounts[g] / groupedTrades.length) * 100}%`,
                    }}
                    title={`${g}: ${gradeCounts[g]}`}
                  >
                    <span className="text-[8px] font-bold text-canvas/80">
                      {g}
                    </span>
                  </div>
                ) : null
              )}
            </div>
          </div>
        )}
      </div>

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
        {activeTab === "trades" && (
          <GroupedTradeCards groupedTrades={groupedTrades} />
        )}

        {activeTab === "review" && (
          <div className="prose-sm max-w-none">
            <MarkdownMessage content={review.review_markdown} />
          </div>
        )}

        {activeTab === "patterns" && <PatternsPanel review={review} />}
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

// ─── Metric Badge ───────────────────────────────────────────────

function MetricBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: React.ReactNode;
  color: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-ink-faint">
        {label}
      </span>
      <span className={`text-sm font-mono font-medium ${color}`}>
        {value}
      </span>
    </div>
  );
}

// ─── Grouped Trade Cards ────────────────────────────────────────

function GroupedTradeCards({
  groupedTrades,
}: {
  groupedTrades: GroupedTradeResponse[];
}) {
  const [expandedTrade, setExpandedTrade] = useState<number | null>(null);

  if (groupedTrades.length === 0) {
    return (
      <p className="text-sm text-ink-dim">
        No trade data available for this review.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groupedTrades.map((trade, idx) => {
        const pnlColor = trade.totalPnl >= 0 ? "text-up" : "text-down";
        const returnPctValue =
          trade.avgEntryPrice > 0
            ? ((trade.exitPrice - trade.avgEntryPrice) /
                trade.avgEntryPrice) *
              100
            : 0;
        const isExpanded = expandedTrade === idx;

        return (
          <div
            key={idx}
            className="rounded-lg border border-edge bg-raised/30 overflow-hidden"
          >
            {/* Trade header */}
            <button
              onClick={() => setExpandedTrade(isExpanded ? null : idx)}
              className="w-full text-left px-4 py-3 hover:bg-raised/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <GradeBadge grade={trade.grade} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-sm font-medium text-ink">
                      {trade.symbol}
                    </span>
                    <Money
                      value={trade.totalPnl}
                      signed
                      className={`font-mono text-sm ${pnlColor}`}
                    />
                    <span className={`font-mono text-xs ${pnlColor}/70`}>
                      (<Pct value={returnPctValue} digits={1} signed />)
                    </span>
                  </div>
                  <div className="flex gap-3 text-[11px] text-ink-faint mt-0.5">
                    <span>{trade.maxHoldingDays}d hold</span>
                    <span>
                      <Shares
                        value={trade.totalQuantity}
                        digits={trade.totalQuantity >= 1 ? 0 : 3}
                      />{" "}
                      shares
                    </span>
                    {trade.lots.length > 1 && (
                      <span>{trade.lots.length} lots</span>
                    )}
                    <span>
                      Exit {trade.exitDate}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-ink-faint">
                  {isExpanded ? "▲" : "▼"}
                </span>
              </div>

              {/* Price range bar */}
              <div className="mt-2">
                <PriceRangeBar
                  entryPrice={trade.avgEntryPrice}
                  exitPrice={trade.exitPrice}
                />
              </div>
            </button>

            {/* Expanded assessment + lot detail */}
            {isExpanded && (
              <div className="border-t border-edge px-4 py-3 space-y-3">
                {trade.assessment && (
                  <div>
                    <h5 className="text-[10px] uppercase tracking-widest text-ink-faint font-medium mb-1">
                      Assessment
                    </h5>
                    <p className="text-xs text-ink-dim leading-relaxed">
                      {trade.assessment}
                    </p>
                  </div>
                )}
                {trade.whatWorked && (
                  <p className="text-xs text-up/80">
                    ✓ {trade.whatWorked}
                  </p>
                )}
                {trade.whatDidnt && (
                  <p className="text-xs text-down/80">
                    ✗ {trade.whatDidnt}
                  </p>
                )}

                {/* Lot breakdown */}
                {trade.lots.length > 1 && (
                  <div>
                    <h5 className="text-[10px] uppercase tracking-widest text-ink-faint font-medium mb-1">
                      Lot Breakdown
                    </h5>
                    <div className="space-y-1">
                      {trade.lots.map((lot) => {
                        const lotPnlColor =
                          lot.realizedPnl >= 0 ? "text-up" : "text-down";
                        return (
                          <div
                            key={lot.id}
                            className="flex gap-3 text-[11px] font-mono"
                          >
                            <span className="text-ink-dim">
                              {lot.entryDate}
                            </span>
                            <span className="text-ink-faint">
                              @<Money value={lot.entryPrice} precise />
                            </span>
                            <span className="text-ink-faint">
                              <Shares value={lot.exitQuantity} /> shares
                            </span>
                            <span className="text-ink-faint">
                              {lot.holdingDays}d
                            </span>
                            <Money
                              value={lot.realizedPnl}
                              signed
                              className={lotPnlColor}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Price Range Bar ────────────────────────────────────────────

function PriceRangeBar({
  entryPrice,
  exitPrice,
}: {
  entryPrice: number;
  exitPrice: number;
}) {
  if (entryPrice <= 0) return null;

  const min = Math.min(entryPrice, exitPrice) * 0.95;
  const max = Math.max(entryPrice, exitPrice) * 1.05;
  const range = max - min;
  if (range <= 0) return null;

  const entryPct = ((entryPrice - min) / range) * 100;
  const exitPct = ((exitPrice - min) / range) * 100;
  const isGain = exitPrice >= entryPrice;

  return (
    <div className="relative h-1.5 bg-edge/50 rounded-full">
      {/* Fill between entry and exit */}
      <div
        className={`absolute top-0 h-full rounded-full ${isGain ? "bg-up/40" : "bg-down/40"}`}
        style={{
          left: `${Math.min(entryPct, exitPct)}%`,
          width: `${Math.abs(exitPct - entryPct)}%`,
        }}
      />
      {/* Entry marker */}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-ink-dim border border-canvas"
        style={{ left: `${entryPct}%` }}
        title={`Entry $${entryPrice.toFixed(2)}`}
      />
      {/* Exit marker */}
      <div
        className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full border border-canvas ${isGain ? "bg-up" : "bg-down"}`}
        style={{ left: `${exitPct}%` }}
        title={`Exit $${exitPrice.toFixed(2)}`}
      />
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
          title="Areas for Improvement"
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
