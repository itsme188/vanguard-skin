"use client";

import { useState, useEffect, useCallback } from "react";
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
// Suggested-level narratives are Haiku prose and occasionally state a
// distance figure ("N% above/below") that contradicts the level's own
// price/currentPrice — QA regression security-detail-suggested-levels--
// narrative-magnitude-contradiction-regression-6 (2026-08-16). Storage
// already gates this (lib/chart/narrate-levels.ts), but this render call
// is defense for rows persisted before that fix, and resolveAcceptedThesis
// is the ACCEPT-path gate so a bad sentence can never ride into
// security_levels.thesis on an armed level.
import { guardNarrative, resolveAcceptedThesis } from "@/lib/levels/narrative-guard";
import { todayET } from "@/lib/calendar/date-utils";
import { useToast } from "./Toast";
import { Chip } from "./Chip";
import { SortPicker } from "./SortPicker";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";

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

type EnrichedLevel = SecurityLevel & { effective_price: number | null };

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

function triggeredToday(triggeredAt: string | null): boolean {
  if (!triggeredAt) return false;
  // Compare local dates (user's tz). The scanner dedup uses SQLite's date('now')
  // which is UTC, but this is a UI hint — good-enough tolerance.
  const t = new Date(triggeredAt);
  if (isNaN(t.getTime())) return false;
  const now = new Date();
  return t.toDateString() === now.toDateString();
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
  narrative?: string | null;
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
    fetch(`/api/suggested-levels?securityId=${securityId}&narratives=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: SuggestedLevelsResponse | null) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        /* silent */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
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

  // Render-time defense: re-check the narrative's numeric claims against
  // this card's own price/level even though storage already gates them —
  // covers rows that were cached before the guard shipped. Falls back to
  // the raw narrative only when currentPrice isn't known yet (best effort).
  const displayNarrative = data?.currentPrice != null
    ? (sug: SuggestedLevel) => guardNarrative(sug.narrative ?? null, data.currentPrice as number, sug)
    : (sug: SuggestedLevel) => sug.narrative ?? null;

  async function accept(sug: SuggestedLevel, index: number) {
    setAccepting(index);
    try {
      const res = await fetch("/api/levels", {
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
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast(`Failed to add level: ${json.error ?? "unknown"}`, "error");
        return;
      }
      toast(`${symbol} ${sug.type} at ${formatLevelPrice(currency, sug.price)} added`, "success");
      onAccepted();
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
                    {sug.narrative && (
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
                {sug.narrative && (
                  <p className="mt-1 text-[11px] text-ink-dim leading-snug">
                    {displayNarrative(sug)}
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

export function LevelsPanel({
  securityId,
  symbol,
  currentPrice,
  embedded = false,
  currency = null,
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
}) {
  const { toast } = useToast();
  const [levels, setLevels] = useState<EnrichedLevel[]>([]);
  const [loading, setLoading] = useState(false);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/levels?securityId=${securityId}&activeOnly=${!showInactive}`
      );
      const json = await res.json();
      if (json.success) setLevels(json.levels);
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
      const res = await fetch("/api/levels", {
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
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast(`Failed to add level: ${json.error ?? "unknown"}`, "error");
        return;
      }
      toast(`${symbol} ${levelType} level added`, "success");
      // Reset form — keep "Me" as the default author after submit so a quick
      // series of self-originated entries doesn't need re-typing.
      setPrice("");
      setThesis("");
      setSourceAuthor("Me");
      setPriceSource("static");
      setExpiresAt("");
      setAdding(false);
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handleDeactivate(id: number) {
    const res = await fetch("/api/levels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "deactivate" }),
    });
    if (res.ok) toast("Level paused", "info");
    else toast("Failed to pause level", "error");
    refresh();
  }

  async function handleReactivate(id: number) {
    const res = await fetch("/api/levels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "reactivate" }),
    });
    if (res.ok) toast("Level reactivated", "success");
    else toast("Failed to reactivate level", "error");
    refresh();
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this level permanently?")) return;
    const res = await fetch(`/api/levels?id=${id}`, { method: "DELETE" });
    if (res.ok) toast("Level deleted", "info");
    else toast("Failed to delete level", "error");
    refresh();
  }

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
            onClick={() => setAdding((v) => !v)}
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
          onSubmit={handleAdd}
          className="mb-4 p-4 rounded-lg border border-edge bg-raised space-y-3"
        >
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
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required={priceSource === "static"}
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
                min={todayET()}
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
              {loading ? "Saving..." : `Add ${symbol} level`}
            </button>
          </div>
        </form>
      )}

      {/* Auto-suggested support/resistance from pivot clustering. Collapsible,
          hidden when no novel suggestions exist. */}
      <SuggestedLevels
        securityId={securityId}
        symbol={symbol}
        userLevels={levels}
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
        const visibleLevels = levelSort.field
          ? [...filtered].sort((a, b) =>
              compareValues(
                a[levelSort.field as keyof EnrichedLevel] as unknown,
                b[levelSort.field as keyof EnrichedLevel] as unknown,
                levelSort.dir,
              ),
            )
          : filtered;

        if (visibleLevels.length === 0) {
          if (embedded) {
            return (
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
                  ? "No active levels · accept a suggestion or add your own"
                  : `No levels from ${authorFilter}`}
              </p>
            );
          }
          return (
            <p className="text-[11px] text-ink-faint italic py-4 text-center">
              {levels.length === 0
                ? "No levels set. Add one above."
                : `No levels from ${authorFilter}.`}
            </p>
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
              {visibleLevels.map((l) => {
                const color = typeColor(l.level_type);
                const triggered = l.is_active === 0 && l.triggered_at != null;
                const alertedToday = triggeredToday(l.triggered_at);
                const inactive = l.is_active === 0 && !l.triggered_at;
                // is_active=1 alone does not make a level armed — the scanner's
                // whitelist also requires review_status='auto_approved'.
                // Rejected / pending-review levels must read as not-armed here.
                const unarmedReview = l.is_active === 1 && l.review_status !== "auto_approved";
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
                        {triggered && (
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
                            Triggered @ {l.triggered_price !== null ? formatLevelPrice(currency, l.triggered_price) : "—"}
                          </span>
                        )}
                        {alertedToday && (
                          <span
                            title="Already alerted today. Reactivating now would no-op — the dedup guard suppresses a same-day second alert."
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
                        {unarmedReview && (
                          <span
                            title="Not armed — the alert scanner only watches auto-approved levels. Approve or reject it on the Alerts Review tab."
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
                      {unarmedReview ? null : l.is_active === 1 ? (
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
                      ) : (
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
                      )}
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
          <ul className="divide-y divide-edge">
            {visibleLevels.map((l) => (
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
                        <span className="text-[10px] text-amber-400" title="Not enough OHLCV history to compute this MA yet — the level won't fire until bars accumulate.">
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
                  {l.is_active === 0 && l.triggered_at && (
                    <Chip size="xs" tone="gold">
                      triggered @ {l.triggered_price !== null ? formatLevelPrice(currency, l.triggered_price) : "—"}
                    </Chip>
                  )}
                  {triggeredToday(l.triggered_at) && (
                    <Chip
                      size="xs"
                      tone="warn"
                      uppercase
                      title="Already alerted today. Reactivating now would no-op — the dedup guard suppresses a same-day second alert. Reactivate tomorrow or after the price has moved off the level."
                    >
                      alerted today
                    </Chip>
                  )}
                  {l.is_active === 0 && !l.triggered_at && (
                    <Chip size="xs" tone="neutral">inactive</Chip>
                  )}
                  {l.is_active === 1 && l.review_status !== "auto_approved" && (
                    <Chip
                      size="xs"
                      tone="warn"
                      uppercase
                      title="Not armed — the alert scanner only watches auto-approved levels. Approve or reject it on the Alerts Review tab."
                    >
                      {l.review_status === "rejected" ? "rejected" : "pending review"}
                    </Chip>
                  )}
                </div>
                {(l.thesis || l.source_author) && (
                  <p className="text-[11px] text-ink-faint mt-0.5">
                    {l.source_author && (
                      <span className="text-ink-dim">{l.source_author}: </span>
                    )}
                    {l.thesis}
                  </p>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                {l.is_active === 1 && l.review_status !== "auto_approved" ? null : l.is_active === 1 ? (
                  <button
                    onClick={() => handleDeactivate(l.id)}
                    className="text-[10px] text-ink-faint hover:text-ink"
                    title="Deactivate"
                  >
                    Pause
                  </button>
                ) : (
                  <button
                    onClick={() => handleReactivate(l.id)}
                    disabled={triggeredToday(l.triggered_at)}
                    className="text-[10px] text-emerald-400 hover:text-emerald-300 disabled:text-ink-faint disabled:cursor-not-allowed disabled:hover:text-ink-faint"
                    title={
                      triggeredToday(l.triggered_at)
                        ? "Already alerted today — reactivation is blocked until tomorrow to prevent duplicate alerts."
                        : "Reactivate"
                    }
                  >
                    Reactivate
                  </button>
                )}
                <button
                  onClick={() => handleDelete(l.id)}
                  className="text-[10px] text-rose-400 hover:text-rose-300 ml-2"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        );
      })()}
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
