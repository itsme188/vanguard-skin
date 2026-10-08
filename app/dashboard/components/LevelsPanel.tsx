"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import type {
  SecurityLevel,
  LevelType,
  LevelDirection,
  LevelActionHint,
  LevelTimeframe,
  LevelPriceSource,
} from "@/lib/types";
// Level prices are PUBLIC market data (a price level reveals neither what the
// user owns nor earns), so they render via pure formatters — never privacy-
// masked. This matches the SuggestedLevels rows, which always show full prices.
// formatLevelPrice is currency-aware (2026-08-12 QA follow-up to 9ba9158,
// which fixed the chart itself but deliberately left this panel — levels
// render in the security's NATIVE currency and need a matching label, e.g.
// "₩976,000" rather than "$976,000" for a KRW security).
import { formatLevelPrice } from "@/lib/chart/price-formatter";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
// What a suggested-level card says is one composed string: a templated fact
// sentence written from the same metadata the chip prints (touch count, touch
// dates), then the model's sentence as the rationale — shown only when every
// figure in it agrees with the chip, otherwise hidden (never rewritten).
// resolveAcceptedThesis returns that same string, so ACCEPT can never store a
// sentence the card would have hidden. Owner rulings built 2026-10-07; see
// lib/levels/narrative-guard.ts.
import { composeLevelNarrative, resolveAcceptedThesis } from "@/lib/levels/narrative-guard";
import { levelActionVisibility, levelReviewGuidance } from "@/lib/levels/action-visibility";
import { lastFiredDateET } from "@/lib/levels/last-fired-date";
// The scanner's two skip conditions. A level outside the plausibility band —
// or one whose price has gone stale — is armed in the DB but never evaluated,
// so this panel must warn before the save and label the row after it, using
// the same predicates the scanner runs (lib/levels/scan-range.ts). The band is
// judged client-side from currentPrice; freshness needs the price DATE, so the
// server stamps it onto each row (GET /api/levels).
import {
  BEYOND_SCAN_RANGE_EXPLANATION,
  BEYOND_SCAN_RANGE_LABEL,
  STALE_PRICE_EXPLANATION,
  STALE_PRICE_LABEL,
  isLevelBeyondScanRange,
} from "@/lib/levels/scan-range";
import { todayET } from "@/lib/calendar/date-utils";
import { useToast } from "./Toast";
import { Chip } from "./Chip";
import { ConfirmDialog } from "./ConfirmDialog";
import { SortPicker } from "./SortPicker";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";
import apiFetch from "@/lib/http/apiFetch";

type LevelSortField =
  | "price"
  | "level_type"
  | "direction"
  | "source_author"
  | "created_at"
  | "is_active";

const LEVEL_SORT_OPTIONS = [
  { field: "price" as const, label: "Price" },
  { field: "level_type" as const, label: "Type" },
  { field: "direction" as const, label: "Direction" },
  { field: "source_author" as const, label: "Source" },
  { field: "created_at" as const, label: "Added" },
  { field: "is_active" as const, label: "Status" },
];

type EnrichedLevel = SecurityLevel & {
  effective_price: number | null;
  /** Date of the latest price for this security (YYYY-MM-DD), null when it has
   *  none. Stamped by GET /api/levels. */
  price_date?: string | null;
  /** True when that price is too old for the scanner's freshness window — the
   *  level is armed but not being monitored. */
  price_is_stale?: boolean;
  /** True when this level already produced an alert in the scanner's current
   *  dedupe day. Stamped by GET /api/levels from the scanner's own check, so
   *  the panel never derives "today" from the browser's local date. */
  alerted_today?: boolean;
};

const PRICE_SOURCE_OPTIONS: Array<{ value: LevelPriceSource; label: string }> = [
  { value: "static", label: "Specific price" },
  { value: "sma_9", label: "SMA 9" },
  { value: "sma_21", label: "SMA 21" },
  { value: "sma_50", label: "SMA 50" },
  { value: "sma_200", label: "SMA 200" },
  { value: "ema_9", label: "EMA 9" },
  { value: "ema_21", label: "EMA 21" },
];

function priceSourceLabel(src: LevelPriceSource): string {
  return PRICE_SOURCE_OPTIONS.find((o) => o.value === src)?.label ?? src;
}

/** The status a row's chips show. `is_active` alone is not it: an active row
 *  can be armed, pending review or rejected, and an inactive one either fired
 *  or was paused. Derived from levelActionVisibility (the single owner of the
 *  armed / unarmed rules) so it cannot drift from the chips and buttons. */
export type LevelRowStatus = "armed" | "triggered" | "pending_review" | "rejected" | "inactive";

export function levelRowStatus(
  level: Pick<SecurityLevel, "is_active" | "review_status" | "triggered_at">,
): LevelRowStatus {
  const { showPause, unarmedReview, showRequeue } = levelActionVisibility(level);
  if (showPause) return "armed";
  if (unarmedReview) return showRequeue ? "rejected" : "pending_review";
  return level.triggered_at != null ? "triggered" : "inactive";
}

// Status sort order. The pill's first click sorts descending, so the first
// status here gets the highest rank and leads the list.
const LEVEL_STATUS_ORDER: LevelRowStatus[] = [
  "armed",
  "triggered",
  "pending_review",
  "rejected",
  "inactive",
];

/** Sort key for the Status pill: one number per visible status, so rows with
 *  the same chip sit together (sorting on `is_active` interleaved them). */
export function levelStatusRank(
  l: Pick<SecurityLevel, "is_active" | "review_status" | "triggered_at">,
): number {
  return LEVEL_STATUS_ORDER.length - LEVEL_STATUS_ORDER.indexOf(levelRowStatus(l));
}

const HIDDEN_STATUS_LABEL: Array<[LevelRowStatus, string]> = [
  ["pending_review", "pending review"],
  ["rejected", "rejected"],
  ["triggered", "fired"],
  ["inactive", "inactive"],
];

/** What the default (armed-only) view leaves out, named by status — e.g.
 *  "3 not shown: 1 pending review, 2 rejected". Null when nothing is hidden. */
export function hiddenLevelsSummary(
  allLevels: Array<Pick<SecurityLevel, "is_active" | "review_status" | "triggered_at">>,
): string | null {
  const counts = new Map<LevelRowStatus, number>();
  for (const l of allLevels) {
    const status = levelRowStatus(l);
    if (status === "armed") continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts = HIDDEN_STATUS_LABEL.flatMap(([status, label]) => {
    const n = counts.get(status) ?? 0;
    return n > 0 ? [`${n} ${label}`] : [];
  });
  if (parts.length === 0) return null;
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  return `${total} not shown: ${parts.join(", ")}`;
}

/** The muted line under a row's chips: when it was added (Eastern date of the
 *  stored UTC timestamp), and the timeframe and expiry the add form took.
 *  `expires_at` is a plain date; past it the scanner ignores the level, so it
 *  reads "Expired". `today` is the Eastern date (todayET()). */
export function levelRowMeta(
  l: Pick<SecurityLevel, "created_at" | "timeframe" | "expires_at">,
  today: string,
): string[] {
  const parts: string[] = [];
  // lastFiredDateET is the shared "stored UTC timestamp to Eastern date" reader.
  const added = lastFiredDateET(l.created_at);
  if (added) parts.push(`Added ${added}`);
  if (l.timeframe) parts.push(`Timeframe ${l.timeframe}`);
  if (l.expires_at) parts.push(`${l.expires_at < today ? "Expired" : "Expires"} ${l.expires_at}`);
  return parts;
}

/** The two refusals the reactivate route can return; both can be overridden. */
type ArmRefusalCode = "would_fire_immediately" | "beyond_scan_range";

function lastFiredCopy(l: EnrichedLevel, currency?: string | null): string {
  const price =
    l.triggered_price !== null ? formatLevelPrice(currency ?? null, l.triggered_price) : "an unrecorded price";
  // Eastern calendar date — triggered_at is a UTC timestamp.
  const date = lastFiredDateET(l.triggered_at) ?? "an unrecorded date";
  return `${price} on ${date}`;
}

const LEVEL_TYPE_OPTIONS: LevelType[] = [
  "support",
  "resistance",
  "entry",
  "exit",
  "stop",
  "scale_in",
];

const LEVEL_TYPE_LABEL: Record<LevelType, string> = {
  support: "Support",
  resistance: "Resistance",
  entry: "Entry",
  exit: "Exit / Target",
  stop: "Stop",
  scale_in: "Scale In",
};

const LEVEL_TYPE_COLOR: Record<LevelType, string> = {
  support: "text-emerald-400",
  resistance: "text-rose-400",
  entry: "text-emerald-400",
  exit: "text-blue-400",
  stop: "text-rose-400",
  scale_in: "text-emerald-300",
};

interface SuggestedLevel {
  price: number;
  type: "support" | "resistance";
  touches: number;
  lastTouchDate: string;
  firstTouchDate: string;
  confidence: "high" | "medium" | "low";
  distancePct: number;
  /** The model's sentence only (null until generated). The card shows it
   *  through composeLevelNarrative, never raw. */
  narrative?: string | null;
  /** Set by POST /api/suggested-levels when generating this narrative failed. */
  narrativeUnavailable?: boolean;
}

interface SuggestedLevelsResponse {
  levels: SuggestedLevel[];
  atr: number | null;
  /** NATIVE currency frame (the bars' frame) — display converts via usdPerUnit. */
  currentPrice: number | null;
  /** USD per native unit (1 for USD securities). Dollar-TEXT sites multiply
   *  by this; the POST body when accepting a level stays NATIVE (levels are
   *  stored in the security's native currency). */
  usdPerUnit?: number;
  barsAnalyzed: number;
  warning?: string;
}

function SuggestedLevels({
  securityId,
  symbol,
  userLevels,
  onAccepted,
  embedded = false,
  currency = null,
}: {
  securityId: number;
  symbol: string;
  userLevels: EnrichedLevel[];
  onAccepted: () => void;
  embedded?: boolean;
  /** Security's native currency (e.g. "KRW") — see LevelsPanel below. */
  currency?: string | null;
}) {
  const { toast } = useToast();
  const [data, setData] = useState<SuggestedLevelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(true);
  // The narrative request itself failed (network, non-2xx). The cards then say
  // so instead of showing the facts with an unexplained gap.
  const [narrativeRequestFailed, setNarrativeRequestFailed] = useState(false);
  // Suggested prices/ATR arrive NATIVE. Prices render NATIVE — the accepted-
  // levels list in this same panel is documented "intentionally left native"
  // (CLAUDE.md foreign-currency section), and a USD-converted suggestion next
  // to a native accepted copy of itself read 1,500x apart for KRW names. Only
  // ATR converts: it mirrors MarketDataPanel's KPI-row ATR, which is USD.
  // DECIDED (user, 2026-08-05; re-reverted 2026-08-06): do NOT re-add
  // `* usd` to the price sites below — the "$919,000 for a $611 stock"
  // symptom was the $ glyph on a native value, not the value itself.
  // RESOLVED (2026-08-12, LevelsPanel follow-up to chart fix 9ba9158): the
  // glyph is fixed too now — sug.price renders via formatLevelPrice(currency,
  // …), so a KRW suggestion shows "₩919,000" instead of "$919,000". Values
  // still never multiply by `usd` here. ATR is the one deliberate exception:
  // it mirrors MarketDataPanel's KPI-row ATR, which IS a USD value (converted
  // via `* usd` below), so its "$" is correct as-is.
  const usd = data?.usdPerUnit ?? 1;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNarrativeRequestFailed(false);

    // GET is side-effect-free (#35 task 5): it returns levels with narratives
    // READ FROM CACHE (null when not yet generated). When any narrative is
    // missing we POST once to generate them (the paid-AI write path) —
    // routed through apiFetch (#35 task 9-12) since it's the mutating call;
    // the GET stays a plain fetch.
    (async () => {
      try {
        const getRes = await fetch(
          `/api/suggested-levels?securityId=${securityId}&narratives=1`,
        );
        const json = (getRes.ok ? await getRes.json() : null) as
          | SuggestedLevelsResponse
          | null;
        if (!cancelled) setData(json);

        const needsNarratives =
          json?.levels?.some((l) => l.narrative == null) ?? false;
        if (needsNarratives) {
          try {
            const postRes = await apiFetch(
              `/api/suggested-levels?securityId=${securityId}&narratives=1`,
              { method: "POST" },
            );
            if (postRes.ok) {
              const enriched = (await postRes.json()) as SuggestedLevelsResponse;
              if (!cancelled) setData(enriched);
            } else if (!cancelled) {
              setNarrativeRequestFailed(true);
            }
          } catch {
            // The levels from the GET stay on screen; only the commentary is missing.
            if (!cancelled) setNarrativeRequestFailed(true);
          }
        }
      } catch {
        /* silent */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [securityId]);

  // Filter out suggestions that already have a matching user level (within a
  // small tolerance) — prevents double-adding the same price.
  const filtered = (data?.levels ?? []).filter((sug) => {
    const tol = Math.max(0.25, sug.price * 0.005); // 0.5% or $0.25, whichever bigger
    return !userLevels.some(
      (u) =>
        u.price_source === "static" &&
        typeof u.price === "number" &&
        Math.abs(u.price - sug.price) <= tol,
    );
  });

  // The card's text: templated facts from the chip's own metadata, then the
  // model's sentence when it agrees with the chip. The same call ACCEPT makes
  // (resolveAcceptedThesis), so the card and the stored thesis are one string.
  const displayNarrative = (sug: SuggestedLevel) =>
    composeLevelNarrative(sug, data?.currentPrice ?? null);
  // True when this card has no model sentence because generating it failed
  // (the server's per-level marker, or the request itself failing).
  const narrativeUnavailable = (sug: SuggestedLevel) =>
    sug.narrative == null && (sug.narrativeUnavailable === true || narrativeRequestFailed);

  async function accept(sug: SuggestedLevel, index: number) {
    setAccepting(index);
    try {
      const res = await apiFetch("/api/levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          security_id: securityId,
          level_type: sug.type,
          price: sug.price,
          price_source: "static",
          direction: null,
          action_hint: "watch",
          source: "suggested",
          source_author: "chart-analysis",
          thesis: resolveAcceptedThesis(sug, data?.currentPrice ?? null),
          timeframe: null,
          expires_at: null,
        }),
      });
      const result = await readMutationResult(res);
      if (!result.ok) {
        toast(`Couldn't add the level: ${result.message}`, "error");
        return;
      }
      toast(`${symbol} ${sug.type} at ${formatLevelPrice(currency, sug.price)} added`, "success");
      onAccepted();
    } catch {
      toast(networkFailureMessage("add the level"), "error");
    } finally {
      setAccepting(null);
    }
  }

  if (loading) {
    if (embedded) {
      return (
        <div
          style={{
            padding: "10px 0",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "12px",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#555",
          }}
        >
          Computing suggested levels…
        </div>
      );
    }
    return (
      <div className="mb-3 text-[11px] text-ink-faint">
        Computing suggested levels…
      </div>
    );
  }
  if (!data || filtered.length === 0) return null;

  if (embedded) {
    return (
      <div style={{ marginBottom: "1rem", borderTop: "1px solid #1f1f1f", borderBottom: "1px solid #1f1f1f" }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            width: "100%",
            padding: "10px 0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "12px",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#999",
          }}
        >
          <span>
            <span style={{ color: "#ffb84d", marginRight: "0.5em" }}>{expanded ? "▾" : "▸"}</span>
            {filtered.length} Suggested · Auto-detected
            {data.atr != null && (
              <span style={{ color: "#555", marginLeft: "1em" }}>
                · ATR ≈ ${(data.atr * usd).toFixed(2)}
              </span>
            )}
          </span>
          <span style={{ color: "#555" }}>{expanded ? "hide" : "show"}</span>
        </button>
        {expanded && (
          <div>
            {filtered.map((sug, i) => {
              const isRes = sug.type === "resistance";
              const color = isRes ? "#ef4444" : "#22c55e";
              return (
                <div
                  key={`${sug.type}-${sug.price}-${i}`}
                  style={{
                    padding: "14px 0",
                    borderTop: "1px solid #161616",
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    gap: "16px",
                    alignItems: "start",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "14px", flexWrap: "wrap" }}>
                      {/* Colored tag block — matches the chart's left-edge level chips */}
                      <span
                        style={{
                          background: color,
                          color: "#0a0a0a",
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "12px",
                          fontWeight: 700,
                          letterSpacing: "0.14em",
                          textTransform: "uppercase",
                          padding: "3px 8px",
                          borderRadius: "2px",
                        }}
                      >
                        {isRes ? "R" : "S"}
                      </span>
                      {/* Price — the row's dominant element */}
                      <span
                        style={{
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "20px",
                          fontWeight: 600,
                          color,
                          fontVariantNumeric: "tabular-nums",
                          letterSpacing: "-0.01em",
                        }}
                      >
                        {formatLevelPrice(currency, sug.price)}
                      </span>
                      {/* Distance — colored to match side */}
                      <span
                        style={{
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "14px",
                          color,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {sug.distancePct >= 0 ? "+" : ""}{sug.distancePct.toFixed(1)}%
                      </span>
                      {/* Touches, confidence, last date — uppercase meta strip */}
                      <span
                        style={{
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "11px",
                          letterSpacing: "0.18em",
                          textTransform: "uppercase",
                          color: sug.confidence === "high" ? "#ffb84d" : "#888",
                        }}
                      >
                        {sug.confidence} · {sug.touches}× · last {sug.lastTouchDate}
                      </span>
                    </div>
                    <p
                      style={{
                        marginTop: "10px",
                        fontFamily: "Geist, system-ui, sans-serif",
                        fontSize: "14px",
                        lineHeight: 1.55,
                        color: "#bbb",
                      }}
                    >
                      {displayNarrative(sug)}
                    </p>
                    {narrativeUnavailable(sug) && (
                      <p
                        style={{
                          marginTop: "4px",
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "11px",
                          letterSpacing: "0.14em",
                          textTransform: "uppercase",
                          color: "#888",
                        }}
                      >
                        AI commentary unavailable
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => accept(sug, i)}
                    disabled={accepting === i}
                    className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2"
                    style={{
                      padding: "6px 14px",
                      background: "transparent",
                      border: "1px solid #444",
                      color: "#ffb84d",
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "12px",
                      fontWeight: 600,
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      borderRadius: "2px",
                      cursor: "pointer",
                      transition: "all 180ms ease",
                      opacity: accepting === i ? 0.4 : 1,
                      alignSelf: "center",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "#ffb84d";
                      e.currentTarget.style.background = "rgba(255, 184, 77, 0.08)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "#444";
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    {accepting === i ? "…" : "Accept"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-edge bg-raised/40 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-[11px] hover:bg-raised transition-colors"
      >
        <span className="text-ink-dim">
          <span className="text-gold">{expanded ? "▾" : "▸"}</span> {filtered.length} suggested level
          {filtered.length === 1 ? "" : "s"}
          {data.atr != null && (
            <span className="text-ink-faint ml-2">
              · ATR ≈ ${(data.atr * usd).toFixed(2)}
            </span>
          )}
        </span>
        <span className="text-ink-faint">{expanded ? "hide" : "show"}</span>
      </button>
      {expanded && (
        <div className="divide-y divide-edge/50">
          {filtered.map((sug, i) => (
            <div
              key={`${sug.type}-${sug.price}-${i}`}
              className="px-3 py-2 flex items-start justify-between gap-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`font-mono text-sm font-medium ${
                      sug.type === "resistance" ? "text-down" : "text-up"
                    }`}
                  >
                    {formatLevelPrice(currency, sug.price)}
                  </span>
                  <Chip tone={sug.type === "resistance" ? "down" : "up"} size="xs" uppercase>
                    {sug.type}
                  </Chip>
                  <span className="text-[11px] text-ink-dim">
                    {sug.distancePct >= 0 ? "+" : ""}
                    {sug.distancePct.toFixed(1)}%
                  </span>
                  <Chip
                    tone={sug.confidence === "high" ? "gold" : "neutral"}
                    size="xs"
                  >
                    {sug.confidence}
                  </Chip>
                  <span className="text-[11px] text-ink-faint">
                    {sug.touches}× · last {sug.lastTouchDate}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-ink-dim leading-snug">
                  {displayNarrative(sug)}
                </p>
                {narrativeUnavailable(sug) && (
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    AI commentary unavailable
                  </p>
                )}
              </div>
              <button
                onClick={() => accept(sug, i)}
                disabled={accepting === i}
                className="px-2.5 py-1 text-[11px] font-medium rounded border border-edge text-ink hover:bg-raised hover:border-edge-strong disabled:opacity-40 transition-colors shrink-0"
              >
                {accepting === i ? "…" : "accept"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// [qa:security-detail-levels-panel--failed-fetch-renders-no-active-levels-empty-state]
// Shared failed-load notice for LevelsPanel below. `inline` renders the
// compact one-liner placed above an already-loaded (possibly stale) list;
// the default renders the full block that replaces the ordinary empty-state
// copy when there are zero rows to show. Markup/classes/tone copied from
// DataConfidenceIndicator's "Data unavailable" + Retry precedent.
function LevelsLoadError({
  message,
  onRetry,
  embedded,
  inline = false,
}: {
  message: string;
  onRetry: () => void;
  embedded: boolean;
  inline?: boolean;
}) {
  if (embedded) {
    return (
      <div
        style={
          inline
            ? {
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 0",
                borderBottom: "1px solid #1f1f1f",
                marginBottom: "8px",
              }
            : {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                padding: "20px 0",
                borderTop: "1px solid #1f1f1f",
                marginTop: "1rem",
              }
        }
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "9999px",
            background: "#f87171",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-mono), monospace",
            fontSize: "12px",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#f87171",
          }}
        >
          {message}
        </span>
        <button
          type="button"
          onClick={onRetry}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            color: "#60a5fa",
            textDecoration: "underline",
            cursor: "pointer",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "12px",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div
      className={
        inline
          ? "flex items-center gap-2 text-[11px] text-ink-faint font-mono mb-2"
          : "flex items-center justify-center gap-2 text-[11px] text-ink-faint font-mono py-4"
      }
    >
      <span className="w-2 h-2 rounded-full bg-orange-400 shrink-0" />
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="text-blue hover:text-blue/80 underline"
      >
        Retry
      </button>
    </div>
  );
}

export function LevelsPanel({
  securityId,
  symbol,
  currentPrice,
  embedded = false,
  currency = null,
  securityType = null,
}: {
  securityId: number;
  symbol: string;
  currentPrice: number | null;
  // When embedded inside MarketDataPanel, drop the outer chrome (rounded
  // border, bg-panel, padding) so the component becomes a flat content region
  // that inherits the panel's dark Terminal background.
  embedded?: boolean;
  /** Security's native currency (e.g. "KRW"). Levels are stored and rendered
   *  NATIVE (never converted) — same frame as the chart above this panel —
   *  so this only changes the price LABEL, matching 9ba9158's chart fix. */
  currency?: string | null;
  /** Security type — options are exempt from the scanner's plausibility band,
   *  so neither the add-form warning nor the row chip fires for them. */
  securityType?: string | null;
}) {
  const { toast } = useToast();
  const [levels, setLevels] = useState<EnrichedLevel[]>([]);
  // Every level for this security, whatever the Show-inactive toggle says.
  // `levels` above is only what the list displays. The suggestion de-dupe and
  // the empty state read this one, so a display toggle cannot change which
  // suggestions exist or hide that paused / rejected / pending rows are there.
  // Null until the first successful load.
  const [allLevels, setAllLevels] = useState<EnrichedLevel[] | null>(null);
  const [loading, setLoading] = useState(false);
  // [qa:security-detail-levels-panel--failed-fetch-renders-no-active-levels-empty-state]
  // A rejected fetch or a non-2xx/{success:false} response used to leave
  // `levels` at its initial [] with no signal that anything went wrong — the
  // panel then rendered the ordinary "No active levels" empty state, making a
  // failed load indistinguishable from a genuinely empty one. This tracks the
  // failure explicitly so the render can tell the two apart.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  // Provenance filter: "All" | "Me" | specific author. Lets the user triage
  // their own levels vs newsletter-derived ones once the list grows.
  const [authorFilter, setAuthorFilter] = useState<string>("All");
  const { sort: levelSort, setSort: setLevelSort } = useSortParam<LevelSortField>(
    "levels",
    null,
    "desc",
  );

  // Form state. Default author = "Me" so user-originated levels are tracked as
  // the user's own. Dropdown also surfaces known research_sources for one-click
  // provenance when the level came from a newsletter.
  const [levelType, setLevelType] = useState<LevelType>("entry");
  const [priceSource, setPriceSource] = useState<LevelPriceSource>("static");
  const [price, setPrice] = useState("");
  const [direction, setDirection] = useState<LevelDirection | "">("");
  const [actionHint, setActionHint] = useState<LevelActionHint | "">("");
  const [sourceAuthor, setSourceAuthor] = useState("Me");
  const [thesis, setThesis] = useState("");
  const [timeframe, setTimeframe] = useState<LevelTimeframe | "">("");
  const [expiresAt, setExpiresAt] = useState("");
  // Mobile only: collapses Direction/Action/Source/Timeframe/Expires/Thesis
  // behind a "More options" disclosure to keep tap targets large. Desktop
  // always shows the full form.
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The row being edited. While set, the form above the list is prefilled
  // from it and saves with PATCH (action "edit") instead of adding a level.
  const [editing, setEditing] = useState<EnrichedLevel | null>(null);
  // The form sits above the list; bring it into view when a row far down the
  // list is opened for editing.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (editing) formRef.current?.scrollIntoView({ block: "nearest" });
  }, [editing]);
  // The one confirmation this panel is waiting on (delete, or overriding an
  // arm refusal), shown in the app's ConfirmDialog. Null when none is open.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    variant?: "danger" | "default";
    onConfirm: () => void;
    onCancel?: () => void;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/levels?securityId=${securityId}&activeOnly=${!showInactive}`
      );
      // [qa:security-detail-levels-panel--failed-fetch-renders-no-active-levels-empty-state]
      // Tolerate a non-JSON body (e.g. an HTML error page from a proxy/500)
      // instead of letting res.json() throw past the check below.
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        // Keep whatever rows are already on screen — a failed refetch must
        // never clear a previously-loaded list, only flag it as possibly
        // stale (see the render-side notice below).
        setLoadError("Levels could not be loaded");
        return;
      }
      // The full set. With Show inactive on, the list already is the full set.
      let full: EnrichedLevel[] = json.levels;
      if (!showInactive) {
        const fullRes = await fetch(`/api/levels?securityId=${securityId}&activeOnly=false`);
        const fullJson = await fullRes.json().catch(() => null);
        if (!fullRes.ok || !fullJson?.success) {
          setLoadError("Levels could not be loaded");
          return;
        }
        full = fullJson.levels;
      }
      setLevels(json.levels);
      setAllLevels(full);
      setLoadError(null);
    } catch {
      // Network error / timeout / thrown fetch — same treatment as an
      // explicit !success response: report it, don't wipe existing rows.
      setLoadError("Levels could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [securityId, showInactive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refetch when an alert fires elsewhere (AlertsBell's poll detects it).
  // Without this the panel can show a level as active for up to 30s after it
  // triggered, even though is_active flipped to 0 in the DB.
  useEffect(() => {
    const onAlertFired = () => refresh();
    const onLevelAdded = () => refresh();
    window.addEventListener("alert-fired", onAlertFired);
    window.addEventListener("level-added", onLevelAdded);
    return () => {
      window.removeEventListener("alert-fired", onAlertFired);
      window.removeEventListener("level-added", onLevelAdded);
    };
  }, [refresh]);

  // Load known research sources once so the Source/Author field can offer
  // them as a datalist. "Me" is always first to nudge user toward tracking
  // self-originated levels separately from followed-authors.
  useEffect(() => {
    fetch("/api/research/sources")
      .then((r) => r.json())
      .then((j) => {
        if (j.success && Array.isArray(j.data)) {
          const names = j.data.map((s: { name: string }) => s.name).filter(Boolean);
          setSourceOptions(["Me", ...names]);
        }
      })
      .catch(() => setSourceOptions(["Me"]));
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    // For MA-based levels, use the current price as a reference (the server will
    // recompute the effective price daily from ohlcv_bars). For static levels,
    // require a valid number.
    const priceNum = price ? parseFloat(price) : currentPrice ?? 0;
    if (priceSource === "static" && (!priceNum || Number.isNaN(priceNum))) return;

    setLoading(true);
    try {
      const res = await apiFetch("/api/levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          security_id: securityId,
          level_type: levelType,
          price: priceNum,
          price_source: priceSource,
          direction: direction || null,
          action_hint: actionHint || null,
          source: "user",
          source_author: sourceAuthor || null,
          thesis: thesis || null,
          timeframe: timeframe || null,
          expires_at: expiresAt || null,
        }),
      });
      const result = await readMutationResult<{ warning?: unknown }>(res);
      if (!result.ok) {
        toast(`Couldn't add the level: ${result.message}`, "error");
        return;
      }
      const json = result.data;
      // Honest feedback: the save succeeded, but a level outside the scanner's
      // range is not monitored coverage. The form warns before the save too —
      // this covers the case where the user pressed on anyway, and the "info"
      // tone keeps it from reading as an outright failure.
      if (json.warning) {
        toast(
          `${symbol} ${levelType} level added — but it is outside the scanner's range, so it will not alert`,
          "info",
        );
      } else {
        toast(`${symbol} ${levelType} level added`, "success");
      }
      // Reset form — keep "Me" as the default author after submit so a quick
      // series of self-originated entries doesn't need re-typing.
      setPrice("");
      setThesis("");
      setSourceAuthor("Me");
      setPriceSource("static");
      setExpiresAt("");
      setAdding(false);
      await refresh();
    } catch {
      toast(networkFailureMessage("add the level"), "error");
    } finally {
      setLoading(false);
    }
  }

  // Edit: the add form, prefilled from the row. Every field the form takes
  // can be changed; the server keeps the rest of the row as it is.
  function startEdit(l: EnrichedLevel) {
    setEditing(l);
    setLevelType(l.level_type);
    setPriceSource(l.price_source);
    setPrice(l.price_source === "static" ? String(l.price) : "");
    setDirection(l.direction ?? "");
    setActionHint(l.action_hint ?? "");
    setSourceAuthor(l.source_author ?? "");
    setThesis(l.thesis ?? "");
    setTimeframe(l.timeframe ?? "");
    setExpiresAt(l.expires_at ?? "");
    setShowAdvanced(true);
    setAdding(true);
  }

  // Closes the form and puts it back to the add defaults, so the next
  // "+ Add Level" does not open on the edited row's values.
  function closeEdit() {
    setEditing(null);
    setLevelType("entry");
    setPriceSource("static");
    setPrice("");
    setDirection("");
    setActionHint("");
    setSourceAuthor("Me");
    setThesis("");
    setTimeframe("");
    setExpiresAt("");
    setAdding(false);
  }

  // `confirmed` names the arm refusal the user just overrode (null on the
  // first try), as in handleReactivate below.
  async function saveLevelEdit(target: EnrichedLevel, confirmed: ArmRefusalCode | null = null) {
    // A moving-average level keeps its stored reference price; the field is
    // disabled for it.
    const priceNum = priceSource === "static" ? parseFloat(price) : target.price;
    if (priceSource === "static" && (!priceNum || Number.isNaN(priceNum))) return;

    setLoading(true);
    try {
      const res = await apiFetch("/api/levels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: target.id,
          action: "edit",
          force: confirmed !== null,
          level_type: levelType,
          price: priceNum,
          price_source: priceSource,
          direction: direction || null,
          action_hint: actionHint || null,
          source_author: sourceAuthor || null,
          thesis: thesis || null,
          timeframe: timeframe || null,
          expires_at: expiresAt || null,
        }),
      });
      const raw = (await res.clone().json().catch(() => null)) as
        | {
            code?: unknown;
            currentPrice?: unknown;
            effectivePrice?: unknown;
            alertedToday?: unknown;
            armed?: unknown;
          }
        | null;
      const result = { ...(await readMutationResult(res)), code: raw?.code };
      const alertedToday = raw?.alertedToday === true;
      const current =
        typeof raw?.currentPrice === "number" ? formatLevelPrice(currency, raw.currentPrice) : "the current price";
      const effective =
        typeof raw?.effectivePrice === "number" ? formatLevelPrice(currency, raw.effectivePrice) : "the edited level";
      if (result.ok) {
        if (confirmed === "beyond_scan_range") {
          toast("Level saved, but it is outside the scanner's range, so it will not alert.", "info");
        } else if (confirmed === "would_fire_immediately" && alertedToday) {
          toast("Level saved. It already alerted today, so the next alert can come tomorrow.", "success");
        } else if (confirmed === "would_fire_immediately") {
          toast("Level saved. The price is already past it, so it will alert on the next scan.", "success");
        } else {
          toast(`${symbol} level saved`, "success");
        }
        closeEdit();
        await refresh();
      } else if (result.status === 409 && result.code === "would_fire_immediately") {
        const consequence = alertedToday
          ? "It already alerted today, so it can next alert tomorrow."
          : "Saving will fire an alert on the next scan.";
        setConfirmPrompt({
          title: "Save this change?",
          message: `Price ${current} is already past the edited level (${effective}). ${consequence} Save anyway?`,
          confirmLabel: "Save anyway",
          onConfirm: () => saveLevelEdit(target, "would_fire_immediately"),
          onCancel: () => toast("Nothing was saved. The level is unchanged.", "info"),
        });
      } else if (result.status === 409 && result.code === "beyond_scan_range") {
        setConfirmPrompt({
          title: "Save this change?",
          message: `The edited level (${effective}) is outside the scanner's range at the current price ${current}, so every scan would skip it and it could not alert. This usually means a mis-scaled price. Save anyway?`,
          confirmLabel: "Save anyway",
          onConfirm: () => saveLevelEdit(target, "beyond_scan_range"),
          onCancel: () => toast("Nothing was saved. The level is unchanged.", "info"),
        });
      } else {
        toast(`Couldn't save the level: ${result.message}`, "error");
      }
    } catch {
      toast(networkFailureMessage("save the level"), "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDeactivate(id: number) {
    try {
      const res = await apiFetch("/api/levels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "deactivate" }),
    });
      const result = await readMutationResult(res);
      if (result.ok) toast("Level paused", "info");
      else toast(`Couldn't pause the level: ${result.message}`, "error");
    } catch {
      toast(networkFailureMessage("pause the level"), "error");
    }
    refresh();
  }

  // `confirmed` names the refusal the user just overrode (null on the first
  // try). It is what makes the retry a forced one, and it decides the success
  // wording: a forced out-of-range level does NOT alert.
  async function handleReactivate(id: number, confirmed: ArmRefusalCode | null = null) {
    const force = confirmed !== null;
    try {
      const res = await apiFetch("/api/levels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "reactivate", force }),
    });
      const raw = (await res.clone().json().catch(() => null)) as
        | {
            code?: unknown;
            currentPrice?: unknown;
            effectivePrice?: unknown;
            alertedToday?: unknown;
            armed?: unknown;
          }
        | null;
      const result = { ...(await readMutationResult(res)), code: raw?.code };
      // The server says whether this level already alerted in the scanner's
      // current dedupe day; a re-armed level then stays quiet until tomorrow.
      const alertedToday = raw?.alertedToday === true;
      const current =
        typeof raw?.currentPrice === "number" ? formatLevelPrice(currency, raw.currentPrice) : "the current price";
      const effective =
        typeof raw?.effectivePrice === "number" ? formatLevelPrice(currency, raw.effectivePrice) : "this level";
      if (result.ok) {
        if (raw?.armed === false) {
          toast("Level is active again, but the alert scanner is not watching it (it is not approved, or it has expired).", "info");
        } else if (confirmed === "beyond_scan_range") {
          toast("Active again, but outside the scanner's range, so it will not alert.", "info");
        } else if (alertedToday) {
          toast("Re-armed. It already alerted today, so the next alert can come tomorrow.", "success");
        } else if (confirmed === "would_fire_immediately") {
          toast("Re-armed. The price is already past this level, so it will alert on the next scan.", "success");
        } else {
          toast("Level reactivated", "success");
        }
      } else if (result.status === 409 && result.code === "would_fire_immediately") {
        const consequence = alertedToday
          ? "It already alerted today, so a re-armed level can next alert tomorrow."
          : "Reactivating will fire an alert on the next scan.";
        setConfirmPrompt({
          title: "Reactivate this level?",
          message: `Price ${current} is already past this level (${effective}). ${consequence} Reactivate anyway?`,
          confirmLabel: "Reactivate anyway",
          onConfirm: () => handleReactivate(id, "would_fire_immediately"),
          onCancel: () => toast("Level left paused", "info"),
        });
      } else if (result.status === 409 && result.code === "beyond_scan_range") {
        setConfirmPrompt({
          title: "Reactivate this level?",
          message: `This level (${effective}) is outside the scanner's range at the current price ${current}, so every scan would skip it and it could not alert. This usually means a mis-scaled price. Reactivate anyway?`,
          confirmLabel: "Reactivate anyway",
          onConfirm: () => handleReactivate(id, "beyond_scan_range"),
          onCancel: () => toast("Level left paused", "info"),
        });
      } else {
        toast(`Couldn't reactivate the level: ${result.message}`, "error");
      }
    } catch {
      toast(networkFailureMessage("reactivate the level"), "error");
    }
    refresh();
  }

  function handleDelete(id: number) {
    setConfirmPrompt({
      title: "Delete level",
      message: "Delete this level permanently?",
      confirmLabel: "Delete",
      variant: "danger",
      onConfirm: () => deleteConfirmedLevel(id),
    });
  }

  async function deleteConfirmedLevel(id: number) {
    try {
      const res = await apiFetch(`/api/levels?id=${id}`, { method: "DELETE" });
      const result = await readMutationResult(res);
      if (result.ok) toast("Level deleted", "info");
      else toast(`Couldn't delete the level: ${result.message}`, "error");
    } catch {
      toast(networkFailureMessage("delete the level"), "error");
    }
    refresh();
  }

  // Sends a rejected level back to pending_review so the Alerts Review tab
  // (which only queries review_status='pending_review') can act on it again.
  // Reuses PATCH /api/levels/review — the same route the Review tab's own
  // Approve/Reject buttons call — status: "pending_review" routes to
  // setLevelReviewStatus, never approveLevelGuarded, so this can never arm
  // a level on its own.
  async function handleRequeue(id: number) {
    try {
      const res = await apiFetch("/api/levels/review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "pending_review" }),
      });
      const result = await readMutationResult(res);
      if (result.ok) {
        toast("Re-queued — visit the Alerts Review tab to approve or reject it", "info");
        await refresh();
      } else {
        toast(`Couldn't re-queue the level: ${result.message}`, "error");
      }
    } catch {
      toast(networkFailureMessage("re-queue the level"), "error");
    }
  }

  // Add-form warning: non-blocking by design (the user may be marking
  // structure to arm later), but the scanner skips anything outside the band,
  // so staying silent would promise an alert that never fires. MA-based levels
  // resolve server-side each day and aren't judged from the typed reference.
  const typedPrice = priceSource === "static" ? parseFloat(price) : NaN;
  const newLevelBeyondScanRange =
    Number.isFinite(typedPrice) &&
    isLevelBeyondScanRange(typedPrice, currentPrice, securityType);

  // Row disclosure. Pending-review rows are included on purpose (2026-08-20):
  // the original bug was a mis-scaled extracted level arriving pending_review,
  // showing no chip, and approving silently into dead coverage — the chip has
  // to be visible BEFORE the decision, not only after it. Rejected rows are
  // excluded: they aren't going to arm, so the warning is noise there. An MA
  // level whose value can't be computed yet is left unjudged — it already says
  // so in its own row.
  const rowBeyondScanRange = (l: EnrichedLevel): boolean => {
    if (l.is_active !== 1 || l.review_status === "rejected") return false;
    const effective = l.price_source === "static" ? l.price : l.effective_price;
    return isLevelBeyondScanRange(effective, currentPrice, securityType);
  };

  // The scanner's OTHER skip condition. Only armed rows can mislead here: a
  // pending row isn't claiming to be monitored, but an armed one is, and a
  // stale price means every scan pass skips it however close the level looks.
  // Server-computed (the price DATE never reaches this component) — see
  // lib/levels/scan-range.ts for the shared window.
  const rowStalePrice = (l: EnrichedLevel): boolean =>
    l.is_active === 1 &&
    l.review_status === "auto_approved" &&
    l.price_is_stale === true;

  return (
    <section
      className={
        embedded
          ? "px-5 py-5"
          : "rounded-xl border border-edge bg-panel p-5"
      }
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-medium text-ink tracking-wide uppercase" style={embedded ? { letterSpacing: "0.18em", fontSize: "12px", color: "#999" } : undefined}>
            {embedded ? "Levels · Auto-detected" : "Levels & Alerts"}
          </h2>
          {!embedded && (
            <p className="text-[11px] text-ink-faint mt-0.5">
              Entry, exit, stop, or support/resistance levels. Alerts fire once per level when crossed.
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            style={
              embedded
                ? {
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "11px",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "#888",
                  }
                : undefined
            }
          >
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className={embedded ? "" : "accent-gold"}
              style={embedded ? { accentColor: "#ffb84d" } : undefined}
            />
            <span className={embedded ? "" : "text-[10px] text-ink-faint"}>
              Show inactive
            </span>
          </label>
          <button
            onClick={() => (editing ? closeEdit() : setAdding((v) => !v))}
            className={
              embedded
                ? "relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-1"
                : "px-3 py-1.5 text-xs font-medium rounded-lg border border-gold/30 bg-gold/10 text-gold hover:bg-gold/20 transition-colors"
            }
            style={
              embedded
                ? {
                    padding: "6px 14px",
                    background: "transparent",
                    border: "1px solid #444",
                    color: "#ffb84d",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "12px",
                    fontWeight: 600,
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    borderRadius: "2px",
                    cursor: "pointer",
                    transition: "all 180ms ease",
                  }
                : undefined
            }
            onMouseEnter={
              embedded
                ? (e) => {
                    e.currentTarget.style.borderColor = "#ffb84d";
                    e.currentTarget.style.background = "rgba(255, 184, 77, 0.08)";
                  }
                : undefined
            }
            onMouseLeave={
              embedded
                ? (e) => {
                    e.currentTarget.style.borderColor = "#444";
                    e.currentTarget.style.background = "transparent";
                  }
                : undefined
            }
          >
            {adding ? "Cancel" : embedded ? "+ Add Level" : "+ Add Level"}
          </button>
        </div>
      </div>

      {adding && (
        <form
          ref={formRef}
          onSubmit={(e) => {
            if (!editing) return handleAdd(e);
            e.preventDefault();
            return saveLevelEdit(editing);
          }}
          className="mb-4 p-4 rounded-lg border border-edge bg-raised space-y-3"
        >
          {editing && (
            <p className="text-xs text-ink-dim">
              Editing the {LEVEL_TYPE_LABEL[editing.level_type]} level at{" "}
              {editing.price_source === "static"
                ? formatLevelPrice(currency, editing.price)
                : priceSourceLabel(editing.price_source)}
              . Its status and alert history are kept.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Field label="Type">
              <select
                value={levelType}
                onChange={(e) => setLevelType(e.target.value as LevelType)}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              >
                {LEVEL_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{LEVEL_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </Field>
            <Field label="Reference">
              <select
                value={priceSource}
                onChange={(e) => setPriceSource(e.target.value as LevelPriceSource)}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              >
                {PRICE_SOURCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label={priceSource === "static" ? "Price" : "Price (optional)"}>
              <input
                type="number"
                // A stored level can carry more than two decimals; the browser
                // must not refuse an unchanged price on edit.
                step={editing ? "any" : "0.01"}
                min={editing ? undefined : "0.01"}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required={priceSource === "static"}
                title="A level marks a point on the price axis — it must be a positive amount."
                placeholder={
                  priceSource === "static"
                    ? (currentPrice ? currentPrice.toFixed(2) : "0.00")
                    : "auto (uses MA)"
                }
                disabled={priceSource !== "static"}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs disabled:opacity-40"
              />
            </Field>
            <div className={`contents ${showAdvanced ? "" : "hidden md:contents"}`}>
              <Field label="Direction">
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as LevelDirection | "")}
                  className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                >
                  <option value="">—</option>
                  <option value="bullish">Bullish</option>
                  <option value="bearish">Bearish</option>
                </select>
              </Field>
              <Field label="Action">
                <select
                  value={actionHint}
                  onChange={(e) => setActionHint(e.target.value as LevelActionHint | "")}
                  className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                >
                  <option value="">—</option>
                  <option value="new_position">New position</option>
                  <option value="scale_in">Scale in</option>
                  <option value="trim">Trim</option>
                  <option value="close">Close</option>
                  <option value="watch">Watch</option>
                </select>
              </Field>
            </div>
          </div>
          {newLevelBeyondScanRange && (
            <p
              className="text-[11px] leading-snug text-warn"
              title={BEYOND_SCAN_RANGE_EXPLANATION}
            >
              Heads up: this level is outside the scanner&apos;s range and will
              not alert. You can still save it.
            </p>
          )}
          {/* Mobile-only disclosure. Desktop always shows the second grid. */}
          {!showAdvanced && (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="md:hidden w-full text-center text-[11px] text-gold py-2 border border-dashed border-gold/30 rounded hover:bg-gold/5"
            >
              More options ↓
            </button>
          )}
          <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 ${showAdvanced ? "" : "hidden md:grid"}`}>
            <Field label="Source / Author">
              <input
                type="text"
                list="levels-sources"
                value={sourceAuthor}
                onChange={(e) => setSourceAuthor(e.target.value)}
                placeholder="Me, Purple Drink, Eliant…"
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              />
              <datalist id="levels-sources">
                {sourceOptions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="Timeframe (context)">
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value as LevelTimeframe | "")}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                title="Informational — what horizon the author is talking about. Does NOT auto-expire the level."
              >
                <option value="">—</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </Field>
            <Field label="Expires (auto-deactivate)">
              <input
                type="date"
                value={expiresAt}
                // An edit may keep the row's own (possibly past) expiry.
                min={editing && expiresAt === (editing.expires_at ?? "") ? undefined : todayET()}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                title="Optional. After this date the level is ignored by the scan. Separate from Timeframe, which is informational only. Must be today or later — a past date would be created already expired and could never fire."
              />
            </Field>
            <Field label="Thesis (why this level)">
              <input
                type="text"
                value={thesis}
                onChange={(e) => setThesis(e.target.value)}
                placeholder="e.g. 50-day SMA held in March"
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={loading || (priceSource === "static" && !price)}
              className="px-4 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold hover:bg-gold/30 disabled:opacity-50"
            >
              {loading ? "Saving..." : editing ? "Save changes" : `Add ${symbol} level`}
            </button>
          </div>
        </form>
      )}

      {/* Auto-suggested support/resistance from pivot clustering. Collapsible,
          hidden when no novel suggestions exist. */}
      <SuggestedLevels
        securityId={securityId}
        symbol={symbol}
        userLevels={allLevels ?? levels}
        onAccepted={refresh}
        embedded={embedded}
        currency={currency}
      />

      {/* Provenance filter — derived from distinct authors on this security's
          levels. Hidden when there's nothing to filter (≤1 distinct author). */}
      {(() => {
        const distinctAuthors = Array.from(
          new Set(levels.map((l) => l.source_author).filter((a): a is string => !!a))
        ).sort();
        if (distinctAuthors.length <= 1) return null;
        const pills = ["All", ...distinctAuthors];
        return (
          <div className="flex items-center gap-1 mb-3 flex-wrap">
            {pills.map((p) => (
              <button
                key={p}
                onClick={() => setAuthorFilter(p)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                  authorFilter === p
                    ? "bg-gold/20 text-gold"
                    : "bg-raised text-ink-dim hover:text-ink"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        );
      })()}

      {levels.length > 1 && (
        <div className="mb-3">
          <SortPicker
            options={LEVEL_SORT_OPTIONS}
            sort={levelSort}
            onSort={setLevelSort}
          />
        </div>
      )}

      {(() => {
        const filtered =
          authorFilter === "All"
            ? levels
            : levels.filter((l) => l.source_author === authorFilter);
        // The Status pill keeps its URL key (`is_active`) but sorts on the
        // status the row's chips show, not on the raw flag.
        const sortValue = (l: EnrichedLevel): unknown =>
          levelSort.field === "is_active"
            ? levelStatusRank(l)
            : l[levelSort.field as keyof EnrichedLevel];
        const visibleLevels = levelSort.field
          ? [...filtered].sort((a, b) =>
              compareValues(sortValue(a), sortValue(b), levelSort.dir),
            )
          : filtered;
        const today = todayET();
        // Only the default view hides rows; with Show inactive on, an empty
        // list really is empty.
        const hiddenSummary =
          !showInactive && levels.length === 0 ? hiddenLevelsSummary(allLevels ?? []) : null;

        if (visibleLevels.length === 0) {
          // [qa:security-detail-levels-panel--failed-fetch-renders-no-active-levels-empty-state]
          // The ordinary empty-state copy ("No active levels…") is only
          // accurate when the load actually succeeded — gate it on
          // `!loadError` so a failed refresh renders the error notice
          // instead of silently claiming there are zero levels.
          if (embedded) {
            return (
              <>
                {loadError && (
                  <LevelsLoadError message={loadError} onRetry={refresh} embedded />
                )}
                {!loadError && (
                  <p
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "12px",
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      color: "#555",
                      padding: "20px 0",
                      textAlign: "center",
                      borderTop: "1px solid #1f1f1f",
                      marginTop: "1rem",
                    }}
                  >
                    {levels.length === 0
                      ? hiddenSummary
                        ? `No armed levels · ${hiddenSummary}`
                        : "No active levels · accept a suggestion or add your own"
                      : `No levels from ${authorFilter}`}
                    {levels.length === 0 && hiddenSummary && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          onClick={() => setShowInactive(true)}
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            color: "#60a5fa",
                            textDecoration: "underline",
                            cursor: "pointer",
                            font: "inherit",
                            letterSpacing: "inherit",
                            textTransform: "inherit",
                          }}
                        >
                          Show inactive
                        </button>
                      </>
                    )}
                  </p>
                )}
              </>
            );
          }
          return (
            <>
              {loadError && (
                <LevelsLoadError message={loadError} onRetry={refresh} embedded={false} />
              )}
              {!loadError && (
                <p className="text-[11px] text-ink-faint italic py-4 text-center">
                  {levels.length === 0
                    ? hiddenSummary
                      ? `No armed levels. ${hiddenSummary}.`
                      : "No levels set. Add one above."
                    : `No levels from ${authorFilter}.`}
                  {levels.length === 0 && hiddenSummary && (
                    <>
                      {" "}
                      <button
                        type="button"
                        onClick={() => setShowInactive(true)}
                        className="text-blue hover:text-blue/80 underline not-italic"
                      >
                        Show inactive
                      </button>
                    </>
                  )}
                </p>
              )}
            </>
          );
        }

        if (embedded) {
          // Terminal render — uppercase meta, colored tag block, big mono price,
          // full-width thesis, right-aligned actions. Mirrors the suggested-levels
          // row pattern so active + suggested read as one visual language.
          const typeColor = (t: LevelType) => {
            if (t === "support" || t === "entry" || t === "scale_in") return "#22c55e";
            if (t === "resistance" || t === "stop") return "#ef4444";
            if (t === "exit") return "#60a5fa";
            return "#ffb84d";
          };
          const typeTag = (t: LevelType) => {
            if (t === "support") return "S";
            if (t === "resistance") return "R";
            if (t === "entry") return "E";
            if (t === "exit") return "T"; // target
            if (t === "stop") return "X";
            if (t === "scale_in") return "+S";
            return "·";
          };
          return (
            <div>
              {/* [qa:security-detail-levels-panel--failed-fetch-renders-no-active-levels-empty-state]
                  Rows already on screen survive a failed refetch (see
                  refresh() above) — this notice keeps that possibly-stale
                  list from reading as confirmed-fresh. */}
              {loadError && (
                <LevelsLoadError message={loadError} onRetry={refresh} embedded inline />
              )}
              {visibleLevels.map((l) => {
                const color = typeColor(l.level_type);
                const lastFired = l.triggered_at != null;
                const alertedToday = l.alerted_today === true;
                const inactive = l.is_active === 0 && !lastFired;
                // is_active=1 alone does not make a level armed — the scanner's
                // whitelist also requires review_status='auto_approved'.
                // Rejected / pending-review levels must read as not-armed here.
                // levelActionVisibility is the single owner of which buttons a
                // row gets — do not add conditions on top of its result here.
                const { unarmedReview, showPause, showReactivate, showRequeue } =
                  levelActionVisibility(l);
                const meta = levelRowMeta(l, today);
                const pendingReview = levelRowStatus(l) === "pending_review";
                return (
                  <div
                    key={l.id}
                    style={{
                      padding: "14px 0",
                      borderTop: "1px solid #161616",
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      gap: "16px",
                      alignItems: "start",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: "14px", flexWrap: "wrap" }}>
                        <span
                          style={{
                            background: color,
                            color: "#0a0a0a",
                            fontFamily: "var(--font-mono), monospace",
                            fontSize: "12px",
                            fontWeight: 700,
                            letterSpacing: "0.14em",
                            textTransform: "uppercase",
                            padding: "3px 8px",
                            borderRadius: "2px",
                            opacity: inactive ? 0.4 : 1,
                          }}
                        >
                          {typeTag(l.level_type)}
                        </span>
                        {l.price_source === "static" ? (
                          <span
                            style={{
                              fontFamily: "var(--font-mono), monospace",
                              fontSize: "20px",
                              fontWeight: 600,
                              color,
                              fontVariantNumeric: "tabular-nums",
                              letterSpacing: "-0.01em",
                              opacity: inactive ? 0.5 : 1,
                            }}
                          >
                            {formatLevelPrice(currency, l.price)}
                          </span>
                        ) : (
                          <>
                            <span
                              style={{
                                fontFamily: "var(--font-mono), monospace",
                                fontSize: "18px",
                                fontWeight: 600,
                                color,
                                letterSpacing: "0.02em",
                                opacity: inactive ? 0.5 : 1,
                              }}
                            >
                              {priceSourceLabel(l.price_source).toUpperCase()}
                            </span>
                            {l.effective_price !== null ? (
                              <span
                                style={{
                                  fontFamily: "var(--font-mono), monospace",
                                  fontSize: "16px",
                                  color: "#888",
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              >
                                ≈ {formatLevelPrice(currency, l.effective_price)}
                              </span>
                            ) : (
                              <span
                                title="Not enough OHLCV history to compute this MA yet — the level won't fire until bars accumulate."
                                style={{
                                  fontFamily: "var(--font-mono), monospace",
                                  fontSize: "11px",
                                  color: "#ffb84d",
                                  letterSpacing: "0.14em",
                                  textTransform: "uppercase",
                                }}
                              >
                                insufficient history
                              </span>
                            )}
                          </>
                        )}
                        {/* Uppercase meta strip — direction, action, status */}
                        <span
                          style={{
                            fontFamily: "var(--font-mono), monospace",
                            fontSize: "11px",
                            letterSpacing: "0.18em",
                            textTransform: "uppercase",
                            color: "#888",
                          }}
                        >
                          {[l.direction, l.action_hint?.replace("_", " ")]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {lastFired && (
                          <span
                            style={{
                              fontFamily: "var(--font-mono), monospace",
                              fontSize: "11px",
                              letterSpacing: "0.14em",
                              textTransform: "uppercase",
                              color: "#ffb84d",
                              border: "1px solid #ffb84d",
                              padding: "2px 6px",
                              borderRadius: "2px",
                            }}
                          >
                            Last fired at {lastFiredCopy(l, currency)}
                          </span>
                        )}
                        {alertedToday && (
                          <span
                            title="Already alerted today. The scanner sends one alert per level per day, so the next alert can come tomorrow."
                            style={{
                              fontFamily: "var(--font-mono), monospace",
                              fontSize: "11px",
                              letterSpacing: "0.14em",
                              textTransform: "uppercase",
                              color: "#f59e0b",
                              border: "1px solid #f59e0b",
                              padding: "2px 6px",
                              borderRadius: "2px",
                            }}
                          >
                            Alerted Today
                          </span>
                        )}
                        {inactive && (
                          <span
                            style={{
                              fontFamily: "var(--font-mono), monospace",
                              fontSize: "11px",
                              letterSpacing: "0.14em",
                              textTransform: "uppercase",
                              color: "#666",
                              border: "1px solid #333",
                              padding: "2px 6px",
                              borderRadius: "2px",
                            }}
                          >
                            Inactive
                          </span>
                        )}
                        {rowBeyondScanRange(l) && (
                          <span
                            title={BEYOND_SCAN_RANGE_EXPLANATION}
                            style={{
                              fontFamily: "var(--font-mono), monospace",
                              fontSize: "11px",
                              letterSpacing: "0.14em",
                              textTransform: "uppercase",
                              color: "#f87171",
                              border: "1px solid #f87171",
                              padding: "2px 6px",
                              borderRadius: "2px",
                            }}
                          >
                            {BEYOND_SCAN_RANGE_LABEL}
                          </span>
                        )}
                        {rowStalePrice(l) && (
                          <span
                            title={STALE_PRICE_EXPLANATION}
                            style={{
                              fontFamily: "var(--font-mono), monospace",
                              fontSize: "11px",
                              letterSpacing: "0.14em",
                              textTransform: "uppercase",
                              color: "#f59e0b",
                              border: "1px solid #f59e0b",
                              padding: "2px 6px",
                              borderRadius: "2px",
                            }}
                          >
                            {STALE_PRICE_LABEL}
                          </span>
                        )}
                        {unarmedReview && (
                          <span
                            title={levelReviewGuidance(l.review_status)}
                            style={{
                              fontFamily: "var(--font-mono), monospace",
                              fontSize: "11px",
                              letterSpacing: "0.14em",
                              textTransform: "uppercase",
                              color: l.review_status === "rejected" ? "#f87171" : "#f59e0b",
                              border: "1px solid " + (l.review_status === "rejected" ? "#f87171" : "#f59e0b"),
                              padding: "2px 6px",
                              borderRadius: "2px",
                            }}
                          >
                            {l.review_status === "rejected" ? "Rejected" : "Pending Review"}
                          </span>
                        )}
                      </div>
                      {meta.length > 0 && (
                        <p
                          style={{
                            marginTop: "6px",
                            fontFamily: "var(--font-mono), monospace",
                            fontSize: "11px",
                            letterSpacing: "0.14em",
                            textTransform: "uppercase",
                            color: "#888",
                          }}
                        >
                          {meta.join(" · ")}
                        </p>
                      )}
                      {(l.thesis || l.source_author) && (
                        <p
                          style={{
                            marginTop: "8px",
                            fontFamily: "Geist, system-ui, sans-serif",
                            fontSize: "14px",
                            lineHeight: 1.55,
                            color: "#bbb",
                          }}
                        >
                          {l.source_author && (
                            <span
                              style={{
                                color: "#888",
                                fontFamily: "var(--font-mono), monospace",
                                fontSize: "12px",
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                marginRight: "0.5em",
                              }}
                            >
                              {l.source_author}
                            </span>
                          )}
                          {l.thesis}
                        </p>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "8px", alignSelf: "center" }}>
                      {/* A pending level is decided in the alerts inbox — the one
                          review surface (owner ruling 2026-09-14). This is a link
                          to it, not a second Approve / Reject. */}
                      {pendingReview && (
                        <Link
                          href="/dashboard/alerts?view=review"
                          title="Approve or reject this level in the alerts inbox"
                          className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
                          style={{
                            border: "1px solid #f59e0b",
                            color: "#f59e0b",
                            fontFamily: "var(--font-mono), monospace",
                            fontSize: "11px",
                            fontWeight: 600,
                            letterSpacing: "0.2em",
                            textTransform: "uppercase",
                            padding: "5px 10px",
                            borderRadius: "2px",
                            textDecoration: "none",
                          }}
                        >
                          Review
                        </Link>
                      )}
                      {showRequeue && (
                        <button
                          onClick={() => handleRequeue(l.id)}
                          title="Send back to pending_review so the Alerts Review tab can approve or reject it"
                          className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
                          style={{
                            background: "transparent",
                            border: "1px solid #f59e0b",
                            color: "#f59e0b",
                            fontFamily: "var(--font-mono), monospace",
                            fontSize: "11px",
                            fontWeight: 600,
                            letterSpacing: "0.2em",
                            textTransform: "uppercase",
                            padding: "5px 10px",
                            borderRadius: "2px",
                            cursor: "pointer",
                          }}
                        >
                          Re-queue
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(l)}
                        title="Edit this level"
                        className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
                        style={{
                          background: "transparent",
                          border: "1px solid #333",
                          color: "#888",
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "11px",
                          fontWeight: 600,
                          letterSpacing: "0.2em",
                          textTransform: "uppercase",
                          padding: "5px 10px",
                          borderRadius: "2px",
                          cursor: "pointer",
                        }}
                      >
                        Edit
                      </button>
                      {showPause ? (
                        <button
                          onClick={() => handleDeactivate(l.id)}
                          title="Deactivate"
                          className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
                          style={{
                            background: "transparent",
                            border: "1px solid #333",
                            color: "#888",
                            fontFamily: "var(--font-mono), monospace",
                            fontSize: "11px",
                            fontWeight: 600,
                            letterSpacing: "0.2em",
                            textTransform: "uppercase",
                            padding: "5px 10px",
                            borderRadius: "2px",
                            cursor: "pointer",
                          }}
                        >
                          Pause
                        </button>
                      ) : showReactivate ? (
                        <button
                          onClick={() => handleReactivate(l.id)}
                          disabled={alertedToday}
                          title={
                            alertedToday
                              ? "Already alerted today — reactivation is blocked until tomorrow."
                              : "Reactivate"
                          }
                          className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
                          style={{
                            background: "transparent",
                            border: "1px solid " + (alertedToday ? "#333" : "#22c55e"),
                            color: alertedToday ? "#555" : "#22c55e",
                            fontFamily: "var(--font-mono), monospace",
                            fontSize: "11px",
                            fontWeight: 600,
                            letterSpacing: "0.2em",
                            textTransform: "uppercase",
                            padding: "5px 10px",
                            borderRadius: "2px",
                            cursor: alertedToday ? "not-allowed" : "pointer",
                          }}
                        >
                          Reactivate
                        </button>
                      ) : null}
                      <button
                        onClick={() => handleDelete(l.id)}
                        title="Delete"
                        className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
                        style={{
                          background: "transparent",
                          border: "1px solid #444",
                          color: "#ef4444",
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "13px",
                          fontWeight: 700,
                          padding: "4px 10px",
                          borderRadius: "2px",
                          cursor: "pointer",
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }

        return (
          <>
            {/* [qa:security-detail-levels-panel--failed-fetch-renders-no-active-levels-empty-state]
                Same stale-list guard as the embedded variant above. */}
            {loadError && (
              <LevelsLoadError message={loadError} onRetry={refresh} embedded={false} inline />
            )}
            <ul className="divide-y divide-edge">
            {visibleLevels.map((l) => {
              const lastFired = l.triggered_at != null;
              const alertedToday = l.alerted_today === true;
              const inactive = l.is_active === 0 && !lastFired;
              // Single owner, as in the embedded rows above.
              const { showPause, showReactivate, showRequeue } = levelActionVisibility(l);
              const meta = levelRowMeta(l, today);
              const pendingReview = levelRowStatus(l) === "pending_review";
              return (
            <li key={l.id} className="py-2.5 flex items-start gap-3">
              <div
                className={`text-[11px] uppercase tracking-wide font-semibold w-20 shrink-0 ${LEVEL_TYPE_COLOR[l.level_type]}`}
              >
                {LEVEL_TYPE_LABEL[l.level_type]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  {l.price_source === "static" ? (
                    <span className="text-sm font-mono font-medium text-ink">
                      {formatLevelPrice(currency, l.price)}
                    </span>
                  ) : (
                    <>
                      <span className="text-sm font-mono font-medium text-ink">
                        {priceSourceLabel(l.price_source)}
                      </span>
                      {l.effective_price !== null ? (
                        <span className="text-[10px] text-ink-faint">
                          ≈ {formatLevelPrice(currency, l.effective_price)}
                        </span>
                      ) : (
                        <span className="text-[10px] text-warn" title="Not enough OHLCV history to compute this MA yet — the level won't fire until bars accumulate.">
                          insufficient history
                        </span>
                      )}
                    </>
                  )}
                  {l.direction && (
                    <span className="text-[11px] font-medium text-ink-dim uppercase tracking-wide">
                      {l.direction}
                    </span>
                  )}
                  {l.action_hint && (
                    <Chip size="xs" tone="neutral">
                      {l.action_hint.replace("_", " ")}
                    </Chip>
                  )}
                  {lastFired && (
                    <Chip size="xs" tone="gold">
                      last fired at {lastFiredCopy(l, currency)}
                    </Chip>
                  )}
                  {alertedToday && (
                    <Chip
                      size="xs"
                      tone="warn"
                      uppercase
                      title="Already alerted today. The scanner sends one alert per level per day, so the next alert can come tomorrow."
                    >
                      alerted today
                    </Chip>
                  )}
                  {inactive && (
                    <Chip size="xs" tone="neutral">inactive</Chip>
                  )}
                  {rowBeyondScanRange(l) && (
                    <Chip
                      size="xs"
                      tone="down"
                      title={BEYOND_SCAN_RANGE_EXPLANATION}
                    >
                      {BEYOND_SCAN_RANGE_LABEL}
                    </Chip>
                  )}
                  {rowStalePrice(l) && (
                    <Chip size="xs" tone="warn" title={STALE_PRICE_EXPLANATION}>
                      {STALE_PRICE_LABEL}
                    </Chip>
                  )}
                  {l.is_active === 1 && l.review_status !== "auto_approved" && (
                    <Chip
                      size="xs"
                      tone="warn"
                      uppercase
                      title={levelReviewGuidance(l.review_status)}
                    >
                      {l.review_status === "rejected" ? "rejected" : "pending review"}
                    </Chip>
                  )}
                </div>
                {meta.length > 0 && (
                  <p className="text-[11px] text-ink-faint mt-0.5">{meta.join(" · ")}</p>
                )}
                {(l.thesis || l.source_author) && (
                  <p className="text-[11px] text-ink-faint mt-0.5">
                    {l.source_author && (
                      <span className="text-ink-dim">{l.source_author}: </span>
                    )}
                    {l.thesis}
                  </p>
                )}
              </div>
              <div className="flex gap-1 shrink-0 items-center">
                {/* The alerts inbox is the one review surface; link to it. */}
                {pendingReview && (
                  <Link
                    href="/dashboard/alerts?view=review"
                    className="text-[10px] text-warn hover:text-warn/90 underline"
                    title="Approve or reject this level in the alerts inbox"
                  >
                    Review
                  </Link>
                )}
                {showRequeue && (
                  <button
                    onClick={() => handleRequeue(l.id)}
                    className="text-[10px] text-warn hover:text-warn/90"
                    title="Send back to pending_review so the Alerts Review tab can approve or reject it"
                  >
                    Re-queue
                  </button>
                )}
                <button
                  onClick={() => startEdit(l)}
                  className="text-[10px] text-ink-faint hover:text-ink"
                  title="Edit this level"
                >
                  Edit
                </button>
                {showPause ? (
                  <button
                    onClick={() => handleDeactivate(l.id)}
                    className="text-[10px] text-ink-faint hover:text-ink"
                    title="Deactivate"
                  >
                    Pause
                  </button>
                ) : showReactivate ? (
                  <button
                    onClick={() => handleReactivate(l.id)}
                    disabled={alertedToday}
                    className="text-[10px] text-emerald-400 hover:text-emerald-300 disabled:text-ink-faint disabled:cursor-not-allowed disabled:hover:text-ink-faint"
                    title={
                      alertedToday
                        ? "Already alerted today — reactivation is blocked until tomorrow to prevent duplicate alerts."
                        : "Reactivate"
                    }
                  >
                    Reactivate
                  </button>
                ) : null}
                <button
                  onClick={() => handleDelete(l.id)}
                  className="text-[10px] text-rose-400 hover:text-rose-300 ml-2"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </li>
              );
            })}
            </ul>
          </>
        );
      })()}
      <ConfirmDialog
        open={confirmPrompt !== null}
        title={confirmPrompt?.title ?? ""}
        message={confirmPrompt?.message ?? ""}
        confirmLabel={confirmPrompt?.confirmLabel}
        variant={confirmPrompt?.variant}
        onConfirm={() => {
          const prompt = confirmPrompt;
          setConfirmPrompt(null);
          prompt?.onConfirm();
        }}
        onCancel={() => {
          const prompt = confirmPrompt;
          setConfirmPrompt(null);
          prompt?.onCancel?.();
        }}
      />
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] text-ink-faint block mb-1">{label}</span>
      {children}
    </label>
  );
}
