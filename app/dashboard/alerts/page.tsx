"use client";

import { Suspense, useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { LevelAlert, AlertResponse, LevelReviewStatus } from "@/lib/types";
import { Shares } from "@/lib/privacy/components";
// Level prices, trigger prices, and current market prices are PUBLIC market
// data — they reveal nothing about what the user owns/earns, so they render
// via pure formatters, never privacy-masked (held quantities still mask).
import { formatPercent, formatUSDPrecise } from "@/lib/format";
import { useToast } from "../components/Toast";
import { SortPicker } from "../components/SortPicker";
import { SymbolLink } from "../components/SymbolLink";
import { Chip } from "../components/Chip";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";

// One armed level as returned by GET /api/levels/armed (mirrors ArmedLevel in
// lib/queries/security-levels.ts). Prices here are PUBLIC market data.
interface ArmedLevelView {
  id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  level_type: string;
  price: number;
  price_source: string;
  effective_price: number | null;
  current_price: number | null;
  distance_pct: number | null;
  direction: string | null;
  action_hint: string | null;
  source: string;
  source_author: string | null;
  thesis: string | null;
  timeframe: string | null;
  set_date: string;
}

const LEVEL_TYPE_LABEL: Record<string, string> = {
  support: "Support",
  resistance: "Resistance",
  entry: "Entry",
  exit: "Exit",
  stop: "Stop",
  scale_in: "Scale-in",
};

type ArmedSortField = "nearest" | "symbol" | "level_price" | "source_author" | "level_type";

const ARMED_SORT_OPTIONS = [
  { field: "nearest" as const, label: "Nearest" },
  { field: "symbol" as const, label: "Symbol" },
  { field: "level_price" as const, label: "Price" },
  { field: "source_author" as const, label: "Source" },
  { field: "level_type" as const, label: "Type" },
];

type StreamSortField = "recency" | "symbol" | "level_price" | "source_author";

const SORT_OPTIONS = [
  { field: "recency" as const, label: "Recency" },
  { field: "symbol" as const, label: "Symbol" },
  { field: "level_price" as const, label: "Price" },
  { field: "source_author" as const, label: "Source" },
];

interface EnrichedAlert extends LevelAlert {
  symbol: string | null;
  security_name: string | null;
  level: {
    level_type: string;
    price: number;
    price_source: string;
    direction: string | null;
    source: string;
    source_author: string | null;
    thesis: string | null;
  } | null;
}

interface PendingLevel {
  id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  level_type: string;
  price: number;
  price_source: string;
  direction: string | null;
  action_hint: string | null;
  source_author: string | null;
  thesis: string | null;
  timeframe: string | null;
  source_article_id: number | null;
  current_price: number | null;
  created_at: string;
}

type StreamFilter = "pending" | "review" | "armed" | "acted" | "ignored" | "dismissed" | "all";

const FILTER_OPTIONS: Array<{ label: string; value: StreamFilter }> = [
  { label: "Pending", value: "pending" },
  { label: "Review", value: "review" },
  { label: "Armed", value: "armed" },
  { label: "Acted", value: "acted" },
  { label: "Ignored", value: "ignored" },
  { label: "Dismissed", value: "dismissed" },
  { label: "All", value: "all" },
];

function isToday(iso: string): boolean {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return false;
  const now = new Date();
  return t.toDateString() === now.toDateString();
}

function formatPriceSourceLabel(source: string): string {
  const m = /^(sma|ema)_(\d+)$/.exec(source);
  if (!m) return source;
  return `${m[1].toUpperCase()} ${m[2]}`;
}

function distancePct(level: number, current: number | null): number | null {
  if (current == null) return null;
  return ((current - level) / level) * 100;
}

type StreamItem =
  | { kind: "alert"; recencyAt: string; alert: EnrichedAlert }
  | { kind: "review"; recencyAt: string; level: PendingLevel };

export default function AlertsPage() {
  // useSearchParams below would CSR-bail this entire route at build time
  // without a Suspense boundary. Wrap the inner client logic to localize.
  return (
    <Suspense fallback={<p className="text-[11px] text-ink-faint italic py-6 text-center">Loading…</p>}>
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Filter is reflected in the URL so other surfaces can deep-link:
  // /dashboard/levels/review → ?view=review; the Today "armed levels" link →
  // ?view=armed. Treat those as the matching filter on first render.
  const viewParam = searchParams.get("view");
  const initialFilter: StreamFilter =
    viewParam === "review" ? "review" : viewParam === "armed" ? "armed" : "pending";

  const [filter, setFilter] = useState<StreamFilter>(initialFilter);
  const [alerts, setAlerts] = useState<EnrichedAlert[]>([]);
  const [reviewLevels, setReviewLevels] = useState<PendingLevel[]>([]);
  const [armedLevels, setArmedLevels] = useState<ArmedLevelView[]>([]);
  const [pendingAlertCount, setPendingAlertCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const { sort, setSort } = useSortParam<StreamSortField>("alerts", "recency", "desc");

  // When the user toggles a filter pill we drop ?view=review from the URL
  // (it was only meaningful as an entry hint).
  function selectFilter(next: StreamFilter) {
    setFilter(next);
    if (searchParams.get("view")) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("view");
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?");
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch alerts (filtered by response if the filter maps to a response
      // state) and review levels in parallel.
      const alertsResponseParam =
        filter === "pending"
          ? "pending"
          : filter === "acted" || filter === "ignored" || filter === "dismissed"
            ? filter
            : null;
      const alertsUrl = alertsResponseParam
        ? `/api/alerts?response=${alertsResponseParam}`
        : "/api/alerts";

      // Armed levels are fetched every refresh so the "Armed" pill badge stays
      // live regardless of which filter is active.
      const [alertsRes, reviewRes, armedRes] = await Promise.all([
        fetch(alertsUrl),
        fetch("/api/levels/review"),
        fetch("/api/levels/armed"),
      ]);
      const [alertsJson, reviewJson, armedJson] = await Promise.all([
        alertsRes.json(),
        reviewRes.json(),
        armedRes.json(),
      ]);

      if (alertsJson?.success) {
        setAlerts(alertsJson.alerts as EnrichedAlert[]);
        setPendingAlertCount(alertsJson.pendingCount as number);
      }
      if (reviewJson?.success) {
        setReviewLevels(reviewJson.levels as PendingLevel[]);
      }
      if (armedJson?.success) {
        setArmedLevels(armedJson.levels as ArmedLevelView[]);
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function respond(id: number, response: AlertResponse, note?: string) {
    const res = await fetch("/api/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, response, note }),
    });
    if (res.ok) {
      const kind: "success" | "info" = response === "acted" ? "success" : "info";
      toast(`Alert marked ${response}`, kind);
      window.dispatchEvent(new CustomEvent("alerts-updated"));
    } else {
      toast("Failed to update alert", "error");
    }
    refresh();
  }

  async function decideReview(id: number, status: LevelReviewStatus) {
    const res = await fetch("/api/levels/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) {
      toast("Failed to update level", "error");
      return;
    }
    toast(
      status === "auto_approved" ? "Level approved — now armed" : "Level rejected",
      status === "auto_approved" ? "success" : "info"
    );
    // Optimistic: drop the row immediately.
    setReviewLevels((prev) => prev.filter((l) => l.id !== id));
    window.dispatchEvent(new CustomEvent("reviews-updated"));
  }

  async function approveAll() {
    if (reviewLevels.length === 0) return;
    setApprovingAll(true);
    try {
      const ids = reviewLevels.map((l) => l.id);
      await Promise.all(
        ids.map((id) =>
          fetch("/api/levels/review", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status: "auto_approved" }),
          })
        )
      );
      toast(`${ids.length} level${ids.length === 1 ? "" : "s"} approved`, "success");
      setReviewLevels([]);
      window.dispatchEvent(new CustomEvent("reviews-updated"));
    } finally {
      setApprovingAll(false);
    }
  }

  async function runDetect() {
    setDetecting(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/alerts/detect", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        const { scanned, fired, deduped } = json as {
          scanned: number;
          fired: number;
          deduped: number;
        };
        setActionStatus(
          fired > 0
            ? `Scan complete — ${fired} new alert${fired === 1 ? "" : "s"} fired${
                deduped > 0 ? ` (${deduped} already alerted today)` : ""
              }.`
            : scanned === 0
              ? "Scan complete. No levels have been crossed by the current price. This is normal — a level only fires an alert when the price actually reaches it (e.g., a $150 support fires when the price drops to $150). Your levels are still active and being monitored."
              : `Scan complete — ${scanned} level${scanned === 1 ? "" : "s"} already alerted today; nothing new to report.`
        );
      } else {
        setActionStatus("Scan failed — see console for details.");
      }
      await refresh();
    } finally {
      setDetecting(false);
    }
  }

  async function runSuggest(alertId?: number) {
    setSuggesting(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/alerts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alertId ? { alertId } : {}),
      });
      const json = await res.json();
      if (json.success && !alertId) {
        const { generated, failed } = json as { generated?: number; failed?: number };
        if (generated !== undefined) {
          setActionStatus(
            generated > 0
              ? `Generated ${generated} suggestion${generated === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}.`
              : "No pending alerts needed a suggestion."
          );
        }
      } else if (!json.success) {
        setActionStatus(
          `Suggestion failed: ${json.error ?? `server returned ${res.status}`}. Existing suggestions are unaffected.`
        );
      }
      await refresh();
    } finally {
      setSuggesting(false);
    }
  }

  // Auto-fill suggestions for any pending alerts that don't have one yet —
  // fire-and-forget, runs once per visit. Stays silent if the API errors.
  useEffect(() => {
    const needsSuggestion = alerts.some(
      (a) => a.user_response === "pending" && !a.suggested_action
    );
    if (needsSuggestion && !suggesting) {
      runSuggest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts.length]);

  // Build the stream of items for the current filter.
  const streamItems = useMemo<StreamItem[]>(() => {
    // Armed is its own view (a level list, not an alert/review stream).
    if (filter === "armed") return [];
    if (filter === "review") {
      return reviewLevels.map((l) => ({ kind: "review", recencyAt: l.created_at, level: l }));
    }
    if (filter === "acted" || filter === "ignored" || filter === "dismissed") {
      return alerts.map((a) => ({ kind: "alert", recencyAt: a.triggered_at, alert: a }));
    }
    // 'pending' or 'all' — merged stream
    const items: StreamItem[] = [
      ...alerts.map<StreamItem>((a) => ({ kind: "alert", recencyAt: a.triggered_at, alert: a })),
      ...reviewLevels.map<StreamItem>((l) => ({
        kind: "review",
        recencyAt: l.created_at,
        level: l,
      })),
    ];
    return items;
  }, [filter, alerts, reviewLevels]);

  const sortedItems = useMemo<StreamItem[]>(() => {
    if (!sort.field) return streamItems;
    const field = sort.field;
    const getValue = (it: StreamItem): unknown => {
      if (field === "recency") return it.recencyAt;
      if (field === "symbol") {
        return it.kind === "alert" ? it.alert.symbol : it.level.symbol;
      }
      if (field === "level_price") {
        return it.kind === "alert" ? it.alert.level?.price ?? null : it.level.price;
      }
      if (field === "source_author") {
        return it.kind === "alert"
          ? it.alert.level?.source_author ?? null
          : it.level.source_author ?? null;
      }
      return null;
    };
    return [...streamItems].sort((a, b) => compareValues(getValue(a), getValue(b), sort.dir));
  }, [streamItems, sort]);

  const reviewCount = reviewLevels.length;
  const armedCount = armedLevels.length;
  const isPending = filter === "pending";
  const isReview = filter === "review";
  const isArmed = filter === "armed";
  const totalPending = pendingAlertCount + reviewCount;

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl text-ink font-medium">Alerts</h1>
          <p className="text-[11px] text-ink-faint mt-0.5">
            Triggered levels and newsletter-extracted suggestions in one inbox.{" "}
            <Link
              href="/dashboard/levels/performance"
              className="text-gold hover:text-gold/80"
            >
              Source performance →
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {reviewCount > 0 && (
            <button
              onClick={approveAll}
              disabled={approvingAll}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gold/30 bg-gold/10 text-gold hover:bg-gold/20 disabled:opacity-50"
              title="Approve every pending newsletter level so the scanner can arm them"
            >
              Approve all ({reviewCount})
            </button>
          )}
          <button
            onClick={() => runSuggest()}
            disabled={suggesting}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink disabled:opacity-50"
            title="Ask Claude to write a recommendation for every pending alert without one"
          >
            {suggesting ? "Thinking..." : "Suggest all"}
          </button>
          <button
            onClick={runDetect}
            disabled={detecting}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink disabled:opacity-50"
          >
            {detecting ? "Scanning..." : "Scan now"}
          </button>
          {/* flex-wrap INSIDE the group: the 7-pill row is ~470px — wider
              than a 390px viewport — so wrapping only at the parent level
              still overflowed (the group wraps as one block). */}
          <div className="flex flex-wrap gap-1 p-1 rounded-lg border border-edge bg-panel">
            {FILTER_OPTIONS.map((opt) => {
              const badge =
                opt.value === "pending"
                  ? totalPending
                  : opt.value === "review"
                    ? reviewCount
                    : opt.value === "armed"
                      ? armedCount
                      : 0;
              return (
                <button
                  key={opt.value}
                  onClick={() => selectFilter(opt.value)}
                  className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
                    filter === opt.value
                      ? "bg-gold/15 text-gold"
                      : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {opt.label}
                  {badge > 0 && <span className="ml-1.5 font-mono">{badge}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {actionStatus && (
        <div className="rounded-lg border border-edge bg-panel px-4 py-2.5 text-[11px] text-ink-dim flex items-center justify-between">
          <span>{actionStatus}</span>
          <button
            onClick={() => setActionStatus(null)}
            className="text-ink-faint hover:text-ink text-xs"
            aria-label="Dismiss status"
          >
            ×
          </button>
        </div>
      )}

      {!isArmed && sortedItems.length > 1 && (
        <SortPicker options={SORT_OPTIONS} sort={sort} onSort={setSort} />
      )}

      {isArmed ? (
        loading && armedLevels.length === 0 ? (
          <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
        ) : armedLevels.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <ArmedLevelsList levels={armedLevels} />
        )
      ) : loading && sortedItems.length === 0 ? (
        <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
      ) : sortedItems.length === 0 ? (
        <EmptyState filter={filter} />
      ) : isPending ? (
        <SplitPendingStream items={sortedItems} onRespond={respond} onDecideReview={decideReview} />
      ) : isReview ? (
        <ReviewGroupedByAuthor levels={reviewLevels} onDecide={decideReview} disabled={approvingAll} />
      ) : (
        <ul className="space-y-2">
          {sortedItems.map((it) =>
            it.kind === "alert" ? (
              <AlertRow key={`a-${it.alert.id}`} alert={it.alert} onRespond={respond} />
            ) : (
              <ReviewRow
                key={`r-${it.level.id}`}
                level={it.level}
                onDecide={decideReview}
                disabled={approvingAll}
              />
            )
          )}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ filter }: { filter: StreamFilter }) {
  if (filter === "armed") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-10 text-center">
        <p className="text-sm text-ink-dim">No armed levels.</p>
        <p className="text-[11px] text-ink-faint mt-2">
          Levels you add (or approve from Review) arm automatically and show here with their
          distance to trigger. Add levels on any{" "}
          <Link href="/dashboard/accounts?id=all#holdings" className="text-gold underline">
            security detail page
          </Link>
          .
        </p>
      </div>
    );
  }
  if (filter === "review") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-10 text-center">
        <p className="text-sm text-ink-dim">Nothing to review.</p>
        <p className="text-[11px] text-ink-faint mt-2">
          When the research sync extracts new levels, they appear here for your approval before
          the scan arms them.
        </p>
      </div>
    );
  }
  const label = filter === "all" ? "" : filter;
  return (
    <div className="rounded-xl border border-edge bg-panel p-10 text-center">
      <p className="text-sm text-ink-dim">No {label} alerts.</p>
      <p className="text-[11px] text-ink-faint mt-2">
        Alerts fire when a price crosses a level you&apos;ve set. Add levels on any{" "}
        <Link href="/dashboard/accounts?id=all#holdings" className="text-gold underline">
          security detail page
        </Link>
        .
      </p>
    </div>
  );
}

// ─── Armed levels view (U3) ─────────────────────────────────────────

function ArmedLevelsList({ levels }: { levels: ArmedLevelView[] }) {
  const { sort, setSort } = useSortParam<ArmedSortField>("armedLevels", "nearest", "asc");

  const sorted = useMemo(() => {
    const field = sort.field;
    if (!field) return levels;
    const getValue = (l: ArmedLevelView): unknown => {
      if (field === "nearest") return l.distance_pct === null ? null : Math.abs(l.distance_pct);
      if (field === "symbol") return l.symbol;
      if (field === "level_price") return l.effective_price ?? l.price;
      if (field === "source_author") return l.source_author;
      if (field === "level_type") return l.level_type;
      return null;
    };
    return [...levels].sort((a, b) => compareValues(getValue(a), getValue(b), sort.dir));
  }, [levels, sort]);

  return (
    <div className="space-y-3">
      {levels.length > 1 && (
        <SortPicker options={ARMED_SORT_OPTIONS} sort={sort} onSort={setSort} />
      )}
      <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
        {sorted.map((l) => (
          <ArmedLevelRow key={l.id} level={l} />
        ))}
      </ul>
    </div>
  );
}

function ArmedLevelRow({ level: l }: { level: ArmedLevelView }) {
  const typeLabel = LEVEL_TYPE_LABEL[l.level_type] ?? l.level_type;
  const isStatic = l.price_source === "static";
  const dist = l.distance_pct;
  // "X% away" reads cleanest as an absolute gap; the level type + direction +
  // the live price column tell the user which side of the level price sits on.
  const distanceLabel = dist === null ? null : `${formatPercent(Math.abs(dist) * 100)} away`;
  const near = dist !== null && Math.abs(dist) <= 0.02; // within 2% — about to fire

  return (
    <li className="py-2.5 px-3 flex items-start gap-3">
      <div className="w-16 shrink-0 pt-0.5 font-mono text-[12px] font-medium text-ink">
        <SymbolLink securityId={l.security_id} symbol={l.symbol} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide font-semibold text-ink-dim">
            {typeLabel}
          </span>
          {isStatic ? (
            <span className="text-sm font-mono font-medium text-ink">
              {formatUSDPrecise(l.price)}
            </span>
          ) : (
            <>
              <span className="text-sm font-mono font-medium text-ink">
                {formatPriceSourceLabel(l.price_source)}
              </span>
              {l.effective_price !== null ? (
                <span className="text-[10px] text-ink-faint">
                  ≈ {formatUSDPrecise(l.effective_price)}
                </span>
              ) : (
                <span className="text-[10px] text-amber-400">insufficient history</span>
              )}
            </>
          )}
          {l.direction && (
            <span className="text-[11px] font-medium text-ink-dim uppercase tracking-wide">
              {l.direction}
            </span>
          )}
          {distanceLabel && (
            <Chip size="xs" tone={near ? "warn" : "neutral"}>
              {distanceLabel}
            </Chip>
          )}
          {l.action_hint && (
            <Chip size="xs" tone="neutral">
              {l.action_hint.replace("_", " ")}
            </Chip>
          )}
        </div>
        {(l.thesis || l.source_author) && (
          <p className="text-[11px] text-ink-faint mt-0.5">
            {l.source_author && <span className="text-ink-dim">{l.source_author}: </span>}
            {l.thesis}
          </p>
        )}
      </div>
      {l.current_price !== null && (
        <div className="text-right shrink-0">
          <div className="text-[10px] text-ink-faint uppercase tracking-wide">Now</div>
          <div className="text-sm font-mono text-ink-dim">
            {formatUSDPrecise(l.current_price)}
          </div>
        </div>
      )}
    </li>
  );
}

function SplitPendingStream({
  items,
  onRespond,
  onDecideReview,
}: {
  items: StreamItem[];
  onRespond: (id: number, response: AlertResponse, note?: string) => void;
  onDecideReview: (id: number, status: LevelReviewStatus) => void;
}) {
  // Surface today's activity above older items so the user can act before
  // market close. Both fired alerts (triggered_at = today) and review levels
  // (created_at = today) bubble up.
  const today: StreamItem[] = [];
  const older: StreamItem[] = [];
  for (const it of items) {
    if (isToday(it.recencyAt)) today.push(it);
    else older.push(it);
  }

  return (
    <div className="space-y-5">
      {today.length > 0 && (
        <section>
          <h2 className="text-[11px] font-medium text-gold uppercase tracking-wider mb-2">
            Today&apos;s activity{" "}
            <span className="text-ink-faint font-mono ml-1">{today.length}</span>
          </h2>
          <ul className="space-y-2">
            {today.map((it) =>
              it.kind === "alert" ? (
                <AlertRow key={`a-${it.alert.id}`} alert={it.alert} onRespond={onRespond} />
              ) : (
                <ReviewRow
                  key={`r-${it.level.id}`}
                  level={it.level}
                  onDecide={onDecideReview}
                />
              )
            )}
          </ul>
        </section>
      )}
      {older.length > 0 && (
        <section>
          <h2 className="text-[11px] font-medium text-ink-dim uppercase tracking-wider mb-2">
            Older pending{" "}
            <span className="text-ink-faint font-mono ml-1">{older.length}</span>
          </h2>
          <ul className="space-y-2">
            {older.map((it) =>
              it.kind === "alert" ? (
                <AlertRow key={`a-${it.alert.id}`} alert={it.alert} onRespond={onRespond} />
              ) : (
                <ReviewRow
                  key={`r-${it.level.id}`}
                  level={it.level}
                  onDecide={onDecideReview}
                />
              )
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

function ReviewGroupedByAuthor({
  levels,
  onDecide,
  disabled,
}: {
  levels: PendingLevel[];
  onDecide: (id: number, status: LevelReviewStatus) => void;
  disabled: boolean;
}) {
  // When the user explicitly filters to "Review", group by source_author so
  // they can triage one author at a time (carries over the prior UX from
  // /dashboard/levels/review).
  const grouped = new Map<string, PendingLevel[]>();
  for (const l of levels) {
    const key = l.source_author ?? "Unknown";
    const arr = grouped.get(key) ?? [];
    arr.push(l);
    grouped.set(key, arr);
  }
  return (
    <div className="space-y-5">
      {Array.from(grouped.entries()).map(([author, rows]) => (
        <section key={author}>
          <h2 className="text-[11px] uppercase tracking-wider text-ink-dim mb-2">
            {author}
            <span className="ml-1.5 text-ink-faint font-mono">{rows.length}</span>
          </h2>
          <ul className="space-y-2">
            {rows.map((l) => (
              <ReviewRow key={l.id} level={l} onDecide={onDecide} disabled={disabled} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AlertRow({
  alert,
  onRespond,
}: {
  alert: EnrichedAlert;
  onRespond: (id: number, response: AlertResponse, note?: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  const when = new Date(alert.triggered_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  let context: {
    held?: Array<{ account: string; quantity: number }>;
    onWatchlist?: boolean;
    watchlistGroup?: string | null;
  } = {};
  try {
    if (alert.position_context) context = JSON.parse(alert.position_context);
  } catch {
    // ignore malformed JSON
  }

  const isPending = alert.user_response === "pending";
  const responseLabel: Record<AlertResponse, { label: string; color: string }> = {
    pending: { label: "Pending", color: "text-gold" },
    acted: { label: "Acted", color: "text-emerald-400" },
    ignored: { label: "Ignored", color: "text-ink-faint" },
    dismissed: { label: "Dismissed", color: "text-ink-faint" },
  };

  return (
    <li className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] bg-gold/15 text-gold uppercase tracking-wider"
              title="Fired alert — a level you set was crossed"
            >
              Alert
            </span>
            {alert.symbol && (
              <Link
                href={`/dashboard/security/${alert.security_id}`}
                className="font-mono text-sm font-medium text-ink hover:text-gold"
              >
                {alert.symbol}
              </Link>
            )}
            {alert.level && (
              <span className="text-[11px] text-ink-dim">
                {alert.level.level_type.replace("_", " ")} @{" "}
                {formatUSDPrecise(alert.level.price)}
                {alert.level.price_source && alert.level.price_source !== "static" && (
                  <span
                    className="ml-1.5 inline-block px-1 py-0.5 rounded text-[9px] bg-raised text-ink-faint uppercase tracking-wider"
                    title="This level references a moving average — the trigger price is the MA value at the moment of the cross, not a fixed number."
                  >
                    {formatPriceSourceLabel(alert.level.price_source)}
                  </span>
                )}
              </span>
            )}
            <span className="text-[11px] text-ink-faint">
              hit {formatUSDPrecise(alert.triggered_price)}
            </span>
            <span className="text-[10px] text-ink-faint">{when}</span>
          </div>

          {alert.level?.source_author && (
            <p className="text-[11px] text-ink-dim mt-1">
              <span className="text-ink-faint">Source: </span>
              {alert.level.source_author}
              {alert.level.thesis && <> — {alert.level.thesis}</>}
            </p>
          )}

          {(context.held?.length || context.onWatchlist) && (
            <p className="text-[11px] text-ink-faint mt-1">
              {context.held && context.held.length > 0 && (
                <span>
                  Holding:{" "}
                  {context.held.map((h, i) => (
                    <span key={`${h.account}-${i}`}>
                      {i > 0 && ", "}
                      <Shares value={h.quantity} /> in {h.account}
                    </span>
                  ))}
                </span>
              )}
              {context.held && context.held.length > 0 && context.onWatchlist && " · "}
              {context.onWatchlist && (
                <span>
                  On watchlist
                  {context.watchlistGroup && context.watchlistGroup !== "default"
                    ? ` (${context.watchlistGroup.replace(/_/g, " ")})`
                    : ""}
                </span>
              )}
            </p>
          )}

          {alert.suggested_action && (
            <div className="mt-2 px-3 py-1.5 rounded border border-gold/20 bg-gold/5 text-[11px] text-gold">
              {alert.suggested_action}
            </div>
          )}

          {!isPending && alert.user_response_note && (
            <p className="text-[11px] text-ink-faint italic mt-2">
              Note: {alert.user_response_note}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isPending ? (
            <>
              <button
                onClick={() => setNoteOpen(!noteOpen)}
                className="px-2.5 py-1 text-[11px] rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
              >
                Acted
              </button>
              <button
                onClick={() => onRespond(alert.id, "ignored")}
                className="px-2.5 py-1 text-[11px] rounded text-ink-faint hover:text-ink-dim"
              >
                Ignore
              </button>
              <button
                onClick={() => onRespond(alert.id, "dismissed")}
                className="text-ink-faint hover:text-ink text-xs"
                title="Dismiss"
              >
                ×
              </button>
            </>
          ) : (
            <span className={`text-[11px] ${responseLabel[alert.user_response].color}`}>
              {responseLabel[alert.user_response].label}
            </span>
          )}
        </div>
      </div>

      {noteOpen && isPending && (
        <div className="mt-3 flex items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Bought 50 shares at $175.20"
            className="flex-1 bg-canvas border border-edge rounded px-2 py-1 text-xs"
            autoFocus
          />
          <button
            onClick={() => {
              onRespond(alert.id, "acted", note || undefined);
              setNoteOpen(false);
              setNote("");
            }}
            className="px-3 py-1 text-[11px] rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
          >
            Log
          </button>
          <button
            onClick={() => {
              setNoteOpen(false);
              setNote("");
            }}
            className="text-ink-faint hover:text-ink text-xs"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function ReviewRow({
  level,
  onDecide,
  disabled,
}: {
  level: PendingLevel;
  onDecide: (id: number, status: LevelReviewStatus) => void;
  disabled?: boolean;
}) {
  const distVal = distancePct(level.price, level.current_price);
  const when = new Date(level.created_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <li className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] bg-amber-500/20 text-amber-500 uppercase tracking-wider"
              title="Newsletter-extracted level awaiting your approval before it arms"
            >
              Review
            </span>
            <Link
              href={`/dashboard/security/${level.security_id}`}
              className="font-mono text-sm font-medium text-ink hover:text-gold"
            >
              {level.symbol}
            </Link>
            <span className="text-[11px] text-ink-dim uppercase">
              {level.level_type.replace("_", " ")}
            </span>
            <span className="text-sm font-mono text-ink">
              @ {formatUSDPrecise(level.price)}
            </span>
            {level.price_source && level.price_source !== "static" && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-raised text-ink-faint uppercase tracking-wider">
                {formatPriceSourceLabel(level.price_source)}
              </span>
            )}
            {distVal !== null && (
              <span className="text-[11px] text-ink-faint font-mono">
                {distVal >= 0 ? "+" : ""}
                {formatPercent(distVal, 1)} vs{" "}
                {level.current_price != null ? formatUSDPrecise(level.current_price) : "—"}
              </span>
            )}
            <span className="text-[10px] text-ink-faint">{when}</span>
          </div>
          {level.source_author && (
            <p className="text-[11px] text-ink-dim mt-1">
              <span className="text-ink-faint">Source: </span>
              {level.source_author}
              {level.thesis && <> — {level.thesis}</>}
            </p>
          )}
          {level.timeframe && (
            <p className="text-[10px] text-ink-faint mt-1">Timeframe: {level.timeframe}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onDecide(level.id, "auto_approved")}
            disabled={disabled}
            className="px-3 py-1 text-[11px] rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => onDecide(level.id, "rejected")}
            disabled={disabled}
            className="px-3 py-1 text-[11px] rounded text-ink-faint hover:text-ink-dim disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
    </li>
  );
}
