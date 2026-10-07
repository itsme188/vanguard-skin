"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { OhlcvBar } from "@/lib/tws/types";
import { computeSMA, computeEMA } from "@/lib/chart/indicators";
import { formatChartPrice } from "@/lib/chart/price-formatter";
import { markerTypeLabel } from "@/lib/chart/marker-label";
import { Count } from "@/lib/privacy/components";
import { formatNumber, formatUSDPrecise, rendersAsZero } from "@/lib/format";
import { usePrivacy } from "@/lib/privacy/context";
import { AddLevelPopover } from "./AddLevelPopover";
import { ScrollFade } from "./ScrollFade";
import apiFetch from "@/lib/http/apiFetch";

// LightweightCharts types imported dynamically to avoid SSR issues
type IChartApi = import("lightweight-charts").IChartApi;
type ISeriesApi<T extends import("lightweight-charts").SeriesType> =
  import("lightweight-charts").ISeriesApi<T>;

interface TransactionMarker {
  date: string;
  type: string;
  quantity: number | null;
  price: number | null;
}

interface ChartResponse {
  bars: OhlcvBar[];
  symbol: string;
  securityId: number;
  barSize: string;
  cached: boolean;
  stale: boolean;
  lastBarDate: string | null;
  warning?: string;
  barsInserted?: number;
  transactions?: TransactionMarker[];
  /** True latest close from the prices table (native currency), which can be
   *  fresher than the last cached bar. Absent on intraday responses. */
  latestPrice?: { price: number; date: string } | null;
}

const DURATIONS = [
  { label: "1M", duration: "1 M", months: 1 },
  { label: "3M", duration: "3 M", months: 3 },
  { label: "6M", duration: "6 M", months: 6 },
  { label: "1Y", duration: "1 Y", months: 12 },
  { label: "2Y", duration: "2 Y", months: 24 },
  { label: "All", duration: "10 Y", months: 0 },
] as const;

const TIMEFRAMES = [
  { label: "D", barSize: "1 day", isIntraday: false },
  { label: "5m", barSize: "5 mins", isIntraday: true },
  { label: "1m", barSize: "1 min", isIntraday: true },
] as const;

type TimeframeLabel = (typeof TIMEFRAMES)[number]["label"];

/** Filter bars to only include the last N months. months=0 means show all. */
function filterBarsByWindow(bars: OhlcvBar[], months: number): OhlcvBar[] {
  if (months === 0 || bars.length === 0) return bars;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return bars.filter((b) => b.date >= cutoffStr);
}

/**
 * Human label for a DURATIONS window, used by chartEmptyStateMessage
 * ("3 months", "1 year", ...). Only called for the fixed 1/3/6/12/24 month
 * domain — an empty "All" (months=0) window only happens when there's no
 * cached history at all, which chartEmptyStateMessage's other branch already
 * covers, so 0 never reaches here in practice.
 */
function durationRangeLabel(months: number): string {
  if (months === 1) return "1 month";
  if (months < 12) return `${months} months`;
  const years = months / 12;
  return years === 1 ? "1 year" : `${years} years`;
}

/**
 * Decide the chart's empty-state overlay copy. barCount is scoped to the
 * SELECTED WINDOW (see the "Footer count must describe the PLOTTED window"
 * comment on the init effect below), so barCount===0 does not by itself mean
 * "no cached history" — a security can have hundreds of cached bars that all
 * fall outside the 1M/3M/etc. cutoff (deep-QA: GLW has 501 bars cached
 * through 2026-04-28; selecting 1M/3M shows zero bars in-window while the
 * footer still reads "through 2026-04-28" and the stats strip is populated).
 * lastBarDate is the whole-cache latest bar date (same value the footer's
 * "through <date>" renders from, set once per fetch from the full,
 * un-windowed cache — see fetchChartData / the API route's getOhlcvBars call)
 * — non-null there means the cache is NOT empty, it's just that none of it
 * falls in the current window. Returns null when there's nothing to show
 * (bars are visible in the window).
 */
export function chartEmptyStateMessage({
  visibleBarCount,
  lastBarDate,
  rangeLabel,
  symbol,
  intradayLabel = null,
  dailyLastBarDate = null,
}: {
  visibleBarCount: number;
  lastBarDate: string | null;
  rangeLabel: string;
  symbol: string;
  /** "5m" / "1m" when an intraday interval is selected, else null. Intraday
   *  bars are live-fetched and never cached, so an empty intraday view says
   *  nothing about the daily cache (deep-QA: charts-intraday--empty-state-
   *  copy-denies-cached-daily-bars). */
  intradayLabel?: string | null;
  /** Latest bar date of the last DAILY fetch — the intraday response carries
   *  no lastBarDate of its own. */
  dailyLastBarDate?: string | null;
}): string | null {
  if (visibleBarCount > 0) return null;
  if (intradayLabel) {
    const base = `No ${intradayLabel} intraday bars for ${symbol} — intraday needs a live TWS connection.`;
    return dailyLastBarDate
      ? `${base} Daily bars are cached through ${dailyLastBarDate}.`
      : base;
  }
  if (lastBarDate) {
    return `No bars in the last ${rangeLabel} — cached history ends ${lastBarDate}.`;
  }
  return `No cached price history for ${symbol} — connect TWS to load bars.`;
}

/**
 * Staleness footer text — "N bars · through YYYY-MM-DD" (or "No data" when
 * barCount is 0). Shared by the Single-mode full footer and the
 * compact/Watchlist slim footer so the two surfaces can never drift apart
 * (deep-QA: charts-watchlist-panels--no-bars-through-date-staleness-footer —
 * compact panels used to render NO staleness text at all, so a panel whose
 * cache ended months ago was indistinguishable from a current one).
 */
export function chartFooterStalenessText({
  barCount,
  lastDate,
  intraday = false,
  dailyLastBarDate = null,
}: {
  barCount: number;
  lastDate: string | null;
  /** True on the 5m/1m intervals — an empty intraday view must not read as
   *  "No data" while daily bars are cached. */
  intraday?: boolean;
  dailyLastBarDate?: string | null;
}): string {
  if (intraday && barCount === 0) {
    return dailyLastBarDate
      ? `No intraday bars · daily bars cached through ${dailyLastBarDate}`
      : "No intraday bars";
  }
  const base = barCount > 0 ? `${barCount} bars` : "No data";
  return lastDate ? `${base} · through ${lastDate}` : base;
}

/**
 * Price label for the chart's own axis ticks, last-price pill, level badges
 * and crosshair label (the chart-level priceFormatter).
 *
 * - Public market data: never masked in privacy mode (deep-QA:
 *   charts-privacy--masks-public-price-axis-and-last-price-badge).
 * - A negative price cannot exist for a listed security. LightweightCharts
 *   builds ticks across the WHOLE pane, including the band the scale margins
 *   reserve under the candles for the volume histogram, so it extrapolates
 *   below zero on any wide-range chart. Those ticks get no label (deep-QA:
 *   charts-price-axis--negative-dollar-ticks-*).
 * - USD rounds through Intl like the page header does, so a stored half-cent
 *   close cannot read one cent apart on the same screen — `toFixed` rounds
 *   the binary float instead (deep-QA: charts-header--half-cent-price-rounds-
 *   differently-from-chart-badge). The chart keeps its no-grouping style.
 */
const usdChartLabelFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

export function chartAxisPriceLabel(
  currency: string | null | undefined,
  price: number,
): string {
  if (!Number.isFinite(price) || price < 0) return "";
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD") {
    return `$${usdChartLabelFormatter.format(price)}`;
  }
  return formatChartPrice(currency, price);
}

/** Traded volume is public market data — never masked. */
function chartVolumeLabel(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${v}`;
}

/** Whole calendar days from ISO date a to ISO date b (UTC-anchored, so the
 *  viewer's timezone can never shift a date). */
function isoDayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Longest gap between two consecutive daily bars that still counts as "the
 *  market was closed" (a Friday-to-Tuesday long weekend is 4 days). A wider
 *  gap is a hole in the cache, and a trade inside it is not drawn. */
const MAX_CLOSED_MARKET_GAP_DAYS = 5;

export interface PlacedMarker<T> {
  txn: T;
  /** The daily bar the marker is drawn on. */
  barDate: string;
  /** True when the trade date had no bar and the marker sits on the previous
   *  trading day's bar — the label then carries the real trade date. */
  snapped: boolean;
}

export interface MarkerPlacement<T> {
  placed: PlacedMarker<T>[];
  hiddenBeforeFirstBar: number;
  hiddenAfterLastBar: number;
  hiddenNoBar: number;
}

/**
 * Map each trade to the daily bar its marker is drawn on. Trade dates and
 * daily bar dates are both ET calendar dates (YYYY-MM-DD), so this is pure
 * string work — no Date parsing in the viewer's timezone.
 *
 * LightweightCharts draws a marker whose time has no bar on the NEAREST
 * later bar, or on the final bar when none is later. That is how every trade
 * dated after a stale cache's last bar piled onto that bar, each one drawn
 * months before it happened (deep-QA: charts-txn-markers--post-last-bar-
 * markers-stack-right-edge). So the mapping is decided here instead:
 *
 * - a bar exists on the trade date: drawn there;
 * - before the first bar or after the last bar: not drawn, counted;
 * - no bar that day but bars on both sides within a closed-market gap (a
 *   weekend or holiday): drawn on the PREVIOUS bar, flagged `snapped` — the
 *   last close known on that date, never a later one;
 * - inside a wider hole in the cache: not drawn, counted.
 *
 * `barDates` must be ascending.
 */
export function placeTransactionMarkers<T extends { date: string }>(
  transactions: readonly T[],
  barDates: readonly string[],
): MarkerPlacement<T> {
  const out: MarkerPlacement<T> = {
    placed: [],
    hiddenBeforeFirstBar: 0,
    hiddenAfterLastBar: 0,
    hiddenNoBar: 0,
  };
  if (barDates.length === 0) return out;
  const first = barDates[0];
  const last = barDates[barDates.length - 1];
  for (const txn of transactions) {
    const date = txn.date.slice(0, 10);
    if (date < first) {
      out.hiddenBeforeFirstBar++;
      continue;
    }
    if (date > last) {
      out.hiddenAfterLastBar++;
      continue;
    }
    // Lower bound: first bar on or after the trade date (exists: date <= last).
    let lo = 0;
    let hi = barDates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (barDates[mid] < date) lo = mid + 1;
      else hi = mid;
    }
    if (barDates[lo] === date) {
      out.placed.push({ txn, barDate: date, snapped: false });
      continue;
    }
    // date > first, so a previous bar exists.
    const prev = barDates[lo - 1];
    if (isoDayDiff(prev, barDates[lo]) <= MAX_CLOSED_MARKET_GAP_DAYS) {
      out.placed.push({ txn, barDate: prev, snapped: true });
    } else {
      out.hiddenNoBar++;
    }
  }
  return out;
}

/** What the footer needs to disclose about trades the chart did not draw,
 *  plus what the time-scale fit needs to keep edge labels readable. */
export interface MarkerSummary {
  hiddenAfterLastBar: number;
  hiddenNoBar: number;
  /** Longest label (characters) on the first / last plotted bar; 0 = none. */
  firstBarLabelChars: number;
  lastBarLabelChars: number;
}

const NO_MARKERS: MarkerSummary = {
  hiddenAfterLastBar: 0,
  hiddenNoBar: 0,
  firstBarLabelChars: 0,
  lastBarLabelChars: 0,
};

/** Why some trades are not on the chart, for the footer. Null when all are. */
export function hiddenTradesReason(
  summary: Pick<MarkerSummary, "hiddenAfterLastBar" | "hiddenNoBar">,
): string | null {
  const after = summary.hiddenAfterLastBar > 0;
  const noBar = summary.hiddenNoBar > 0;
  if (after && noBar) return "dated after the last bar or on days with no bar";
  if (after) return "dated after the last bar";
  if (noBar) return "dated on days with no bar";
  return null;
}

/**
 * Extra bars of room to leave at each end of the time scale so a marker
 * label on the first or last bar is not cut by the plot edge. Marker labels
 * are centred on their bar, and fitContent() leaves only half a bar of room
 * (deep-QA: charts-txn-markers--first-visible-bar-trade-label-clipped-at-
 * left-plot-edge). Returns fractional bar counts; 0 when no room is needed.
 */
export function markerEdgePaddingBars({
  plotWidth,
  barCount,
  firstBarLabelChars,
  lastBarLabelChars,
}: {
  plotWidth: number;
  barCount: number;
  firstBarLabelChars: number;
  lastBarLabelChars: number;
}): { left: number; right: number } {
  const none = { left: 0, right: 0 };
  if (!(plotWidth > 0) || barCount <= 0) return none;
  // 11px monospace is about 6.6px a character; 4px breathing room.
  const halfLabel = (chars: number) => (chars > 0 ? (chars * 6.6) / 2 + 4 : 0);
  const hl = halfLabel(firstBarLabelChars);
  const hr = halfLabel(lastBarLabelChars);
  if (hl === 0 && hr === 0) return none;
  // Need (0.5 + pad) * spacing >= halfLabel on each side, where
  // spacing = plotWidth / (barCount + left + right). Two passes settle it.
  let left = 0;
  let right = 0;
  for (let i = 0; i < 4; i++) {
    const spacing = plotWidth / (barCount + left + right);
    left = Math.max(0, hl / spacing - 0.5);
    right = Math.max(0, hr / spacing - 0.5);
  }
  // A label wider than a third of the plot cannot be rescued by padding.
  const cap = Math.max(1, barCount);
  return { left: Math.min(left, cap), right: Math.min(right, cap) };
}

/**
 * Suggested levels the chart should draw: the ones no active level already
 * shows. Uses the SAME tolerance as the Levels panel list (the larger of
 * 0.5% or 0.25, against a static active level), so the chart and the list
 * under it always agree on which suggestions exist — plus an exact-label
 * match against any active line, so two axis badges can never print the same
 * price (deep-QA: security-detail-chart--accepted-suggestion-duplicate-line-
 * label-regression-1).
 */
export function dedupeSuggestedLevels<S extends { price: number }>(
  suggested: readonly S[],
  active: readonly { price: number; isStatic: boolean }[],
  currency: string | null | undefined,
): S[] {
  return suggested.filter((sug) => {
    const tol = Math.max(0.25, sug.price * 0.005);
    const label = chartAxisPriceLabel(currency, sug.price);
    return !active.some(
      (a) =>
        (a.isStatic && Math.abs(a.price - sug.price) <= tol) ||
        chartAxisPriceLabel(currency, a.price) === label,
    );
  });
}

/**
 * Widen an autoscale price range so it contains `price`. The amber true-
 * last-price line is a price LINE, which the series autoscale ignores; on a
 * short range whose few bars sit away from the latest price the line and its
 * axis pill fell off the plot while the header still showed that price
 * (deep-QA: charts-short-ranges--last-price-line-dropped-while-header-shows-
 * price).
 */
export function extendPriceRangeToInclude(
  range: { minValue: number; maxValue: number },
  price: number | null,
): { minValue: number; maxValue: number } {
  if (price == null || !Number.isFinite(price)) return range;
  return {
    minValue: Math.min(range.minValue, price),
    maxValue: Math.max(range.maxValue, price),
  };
}

/**
 * Why a moving average cannot be drawn, or null when it can. An average
 * needs at least `period` bars; with fewer the toggle used to light up and
 * draw nothing (deep-QA: charts-indicators--sma-200-toggle-active-on-short-
 * history-draws-nothing-no-reason).
 */
export function indicatorUnavailableReason({
  label,
  period,
  loadedBars,
}: {
  label: string;
  period: number;
  loadedBars: number;
}): string | null {
  if (loadedBars >= period) return null;
  return `${label} needs ${period} daily bars — ${loadedBars} loaded.`;
}

// Terminal Pro theme — dark Bloomberg-adjacent. Amber current-price, bright
// emerald/rose for level treatments (strong, solid) so they can never be
// confused with the amber current-price line.
const C = {
  background: "#0a0a0a",
  gridLines: "#1a1a1a",
  // #8a8a8a (not #777): small text on #0a0a0a needs 4.5:1 — #777 measured
  // 4.4:1 (2026-07-12 HIG audit).
  text: "#8a8a8a",
  upColor: "#22c55e",
  downColor: "#ef4444",
  borderUp: "#22c55e",
  borderDown: "#ef4444",
  wickUp: "#22c55e",
  wickDown: "#ef4444",
  volumeUp: "#22c55e40",
  volumeDown: "#ef444440",
  crosshair: "#ffb84d80",
  gold: "#ffd666",
  // Current-price line: bright amber, solid, thick. This is the ONE horizontal
  // element that uses amber — levels use emerald/rose, so they're visually
  // unambiguous at a glance.
  currentPrice: "#ffb84d",
  // Level line colors (full-strength, solid). Suggested variants fade to ~60%.
  supportLine: "#22c55e",
  resistanceLine: "#ef4444",
  targetLine: "#60A5FA",
  // Indicator colors
  ema9: "#ffd666",     // gold — short-term
  ema21: "#f59e0b",    // amber
  sma50: "#60a5fa",    // blue — medium
  sma200: "#888888",   // grey — long-term
};

// Indicator definitions
const INDICATORS = [
  { key: "ema9", label: "EMA 9", period: 9, color: C.ema9, fn: (bars: OhlcvBar[]) => computeEMA(bars, 9) },
  { key: "ema21", label: "EMA 21", period: 21, color: C.ema21, fn: (bars: OhlcvBar[]) => computeEMA(bars, 21) },
  { key: "sma50", label: "SMA 50", period: 50, color: C.sma50, fn: (bars: OhlcvBar[]) => computeSMA(bars, 50) },
  { key: "sma200", label: "SMA 200", period: 200, color: C.sma200, fn: (bars: OhlcvBar[]) => computeSMA(bars, 200) },
] as const;

type IndicatorKey = (typeof INDICATORS)[number]["key"];

export function SecurityChart({
  securityId,
  symbol,
  currency = null,
  securityType = null,
  compact = false,
}: {
  securityId: number;
  symbol: string;
  /** Security's native currency (e.g. "KRW"). The chart stays in this native
   *  frame — bars, levels, and the last-price pill are never converted — so
   *  this only changes the axis/pill/legend LABEL, never the values. Null
   *  (and "USD") render with the pre-existing "$" style. */
  currency?: string | null;
  /** Security type, forwarded to the click-to-add popover so its
   *  "outside scan range" warning honours the scanner's options exemption. */
  securityType?: string | null;
  compact?: boolean;
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indicatorMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersPluginRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLinesRef = useRef<any[]>([]);

  const [loading, setLoading] = useState(true);
  // True once the candle series exists, so overlay effects (levels) can fetch and draw.
  const [seriesReady, setSeriesReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [activeDuration, setActiveDuration] = useState("1Y");
  const [activeTimeframe, setActiveTimeframe] = useState<TimeframeLabel>("D");
  const [barCount, setBarCount] = useState(0);
  const [lastDate, setLastDate] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [legend, setLegend] = useState<
    (OhlcvBar & { indicators?: Record<string, number> }) | null
  >(null);

  // Toggle states. Transaction markers default ON in single-chart view but
  // OFF in compact (Watchlist grid) panels — four marker-dense mini-charts
  // read as clutter; the Txns pill turns them on per panel.
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorKey>>(new Set());
  const [showMarkers, setShowMarkers] = useState(!compact);
  const [showSuggested, setShowSuggested] = useState(false);
  // Level-overlay fetch failed — chart renders without level lines, which is
  // indistinguishable from "no levels set" unless we say so. Self-heals on
  // the 30s poll, at which point the hint clears.
  const [levelsUnavailable, setLevelsUnavailable] = useState(false);
  // Last DAILY fetch: how many bars are loaded (an average needs `period` of
  // them) and where the daily cache ends (the intraday empty state must not
  // deny it). Intraday fetches leave this alone.
  const [dailyLoaded, setDailyLoaded] = useState<{ count: number; lastDate: string | null }>({
    count: 0,
    lastDate: null,
  });
  // Reason shown when the user clicks an average that cannot be drawn.
  const [indicatorNote, setIndicatorNote] = useState<string | null>(null);
  // Trades the marker overlay did not draw (see placeTransactionMarkers) and
  // which edge bars carry a label. The ref is what the time-scale fit reads
  // (it runs in the same tick as the marker update); the state feeds the
  // footer disclosure.
  const [markerSummary, setMarkerSummary] = useState<MarkerSummary>(NO_MARKERS);
  const markerSummaryRef = useRef<MarkerSummary>(NO_MARKERS);
  const reportMarkers = useCallback((s: MarkerSummary) => {
    markerSummaryRef.current = s;
    setMarkerSummary(s);
  }, []);
  // Active-level prices the suggested overlay must not repeat. A string key
  // so the 30s levels poll only re-runs the suggested effect on a real change.
  const [activeLevelKey, setActiveLevelKey] = useState("");
  const activeLevelKeyRef = useRef(activeLevelKey);
  activeLevelKeyRef.current = activeLevelKey;
  // Redraws the suggested lines from the last fetched set (no refetch). Set
  // by the suggested-levels effect while the overlay is on, else null.
  const redrawSuggestedRef = useRef<(() => void) | null>(null);
  // Price of the amber true-last-price override line, read by the candle
  // series' autoscaleInfoProvider. Null when the built-in line is in use.
  const overridePriceRef = useRef<number | null>(null);

  // Click-to-add-level popover. Null when no level is being added.
  const [addPopover, setAddPopover] = useState<{
    x: number;
    y: number;
    price: number;
  } | null>(null);
  const [latestClose, setLatestClose] = useState<number | null>(null);
  // True latest close from the prices table (native currency) — can postdate
  // the last cached bar by months when TWS hasn't refreshed bars.
  const [latestPriceRow, setLatestPriceRow] = useState<{ price: number; date: string } | null>(null);
  // Handle for the amber override line (see the true-last-price effect below).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastPriceLineRef = useRef<any>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const suggestedLinesRef = useRef<any[]>([]);

  const isIntraday = activeTimeframe !== "D";

  // Store current bars for indicator recomputation
  const currentBarsRef = useRef<OhlcvBar[]>([]);
  const currentTransactionsRef = useRef<TransactionMarker[]>([]);

  const { isPrivate } = usePrivacy();
  const isPrivateRef = useRef(isPrivate);
  isPrivateRef.current = isPrivate;

  // Mirrored for the same reason as isPrivateRef: the chart-level
  // priceFormatter closure is created once (chart init effect, deps
  // [securityId] only) and called by LightweightCharts internals on its own
  // schedule — it must read the current value, not the one captured at
  // creation time. In practice currency only changes together with
  // securityId (every caller keys/remounts on it), but this keeps the two
  // priceFormatter definitions symmetric and correct regardless.
  const currencyRef = useRef(currency);
  currencyRef.current = currency;

  // Mirrored for the init effect, which deliberately excludes showMarkers from
  // its deps (a toggle must not re-create the chart) but still needs the
  // current value when the initial fetch resolves.
  const showMarkersRef = useRef(showMarkers);
  showMarkersRef.current = showMarkers;

  const fetchChartData = useCallback(
    async (duration: string, refresh = false, barSizeOverride?: string) => {
      try {
        setLoading(!refresh);
        setRefreshing(refresh);
        setError(null);
        setWarning(null);

        const res = await apiFetch("/api/tws/chart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ securityId, barSize: barSizeOverride ?? "1 day", duration, refresh }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data: ChartResponse = await res.json();
        if (data.warning) setWarning(data.warning);
        setBarCount(data.bars.length);
        setLastDate(data.lastBarDate);
        if ((barSizeOverride ?? "1 day") === "1 day") {
          setDailyLoaded({ count: data.bars.length, lastDate: data.lastBarDate });
          setIndicatorNote(null);
        }
        currentBarsRef.current = data.bars;
        currentTransactionsRef.current = data.transactions ?? [];
        setLatestPriceRow(data.latestPrice ?? null);
        // "Last price" prefers the prices-table close when it postdates the
        // last cached bar — bars can be months stale while the page header
        // shows the fresh close, and the two must agree on the same screen.
        const lastBar = data.bars.length > 0 ? data.bars[data.bars.length - 1] : null;
        const trueLast =
          data.latestPrice && (!lastBar || data.latestPrice.date > lastBar.date)
            ? data.latestPrice.price
            : lastBar?.close ?? null;
        if (trueLast != null) setLatestClose(trueLast);
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load chart";
        setError(msg);
        return null;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [securityId],
  );

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    let chart: IChartApi;
    let candleSeries: ISeriesApi<"Candlestick">;
    let volumeSeries: ISeriesApi<"Histogram">;
    let resizeObserver: ResizeObserver;
    let disposed = false;
    let lastObservedWidth = -1;

    async function init() {
      const lc = await import("lightweight-charts");
      if (disposed || !chartContainerRef.current) return;

      chart = lc.createChart(chartContainerRef.current, {
        localization: {
          // Public market data — never masked (see chartAxisPriceLabel).
          priceFormatter: (p: number) => chartAxisPriceLabel(currencyRef.current, p),
        },
        layout: {
          background: { color: C.background },
          textColor: C.text,
          fontFamily: "var(--font-mono), monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: C.gridLines },
          horzLines: { color: C.gridLines },
        },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: C.crosshair, labelBackgroundColor: C.gold },
          horzLine: { color: C.crosshair, labelBackgroundColor: C.gold },
        },
        leftPriceScale: {
          visible: false,
        },
        rightPriceScale: {
          borderColor: C.gridLines,
          scaleMargins: { top: 0.05, bottom: 0.25 },
        },
        timeScale: {
          borderColor: C.gridLines,
          timeVisible: false,
        },
        handleScroll: { vertTouchDrag: false },
      });

      candleSeries = chart.addSeries(lc.CandlestickSeries, {
        upColor: C.upColor,
        downColor: C.downColor,
        borderUpColor: C.borderUp,
        borderDownColor: C.borderDown,
        wickUpColor: C.wickUp,
        wickDownColor: C.wickDown,
        // Current-price line: override the default (which tracks candle color
        // and collides with resistance rose). Bright amber, solid, thick — the
        // only amber element on the chart, so current price is unambiguous.
        priceLineColor: C.currentPrice,
        priceLineStyle: 0, // solid
        priceLineWidth: 2,
        // Keep the amber true-last-price line on the plot at every range.
        autoscaleInfoProvider: (
          original: () => import("lightweight-charts").AutoscaleInfo | null,
        ) => {
          const info = original();
          if (!info || !info.priceRange) return info;
          return {
            ...info,
            priceRange: extendPriceRangeToInclude(info.priceRange, overridePriceRef.current),
          };
        },
      });

      volumeSeries = chart.addSeries(lc.HistogramSeries, {
        priceFormat: {
          type: "custom",
          minMove: 1,
          formatter: chartVolumeLabel,
        },
        priceScaleId: "volume",
        // The volume scale is hidden, but without these the last-value pill
        // still paints onto the visible right axis THROUGH the chart-level
        // $-price formatter ("$175275.31" deep-QA finding). The crosshair
        // legend carries the volume number; the axis label adds nothing.
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
        visible: false,
      });

      // Crosshair legend — OHLCV + active indicator values at the cursor position.
      // Indicators are resolved via the ref so new toggles show up immediately without
      // re-subscribing.
      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.seriesData.size) {
          setLegend(null);
          return;
        }
        const cd = param.seriesData.get(candleSeries) as {
          open?: number; high?: number; low?: number; close?: number;
        } | undefined;
        if (cd?.open != null) {
          const vd = param.seriesData.get(volumeSeries) as { value?: number } | undefined;
          const indicators: Record<string, number> = {};
          for (const [key, series] of indicatorMapRef.current) {
            const d = param.seriesData.get(series) as { value?: number } | undefined;
            if (d?.value != null) indicators[key] = d.value;
          }
          setLegend({
            date: String(param.time),
            open: cd.open, high: cd.high!, low: cd.low!, close: cd.close!,
            volume: vd?.value ?? null,
            indicators: Object.keys(indicators).length > 0 ? indicators : undefined,
          });
        }
      });

      // Click-to-add-level. LightweightCharts only fires this on an actual
      // click (not while dragging to pan/zoom), so we don't need extra
      // gating. We still guard: ignore if the click landed outside the pane
      // (no point) or if we couldn't resolve a price (chart empty).
      chart.subscribeClick((param) => {
        if (compact) return;
        if (!param.point) return;
        const series = candleSeriesRef.current;
        if (!series) return;
        const price = series.coordinateToPrice(param.point.y);
        if (typeof price !== "number" || !Number.isFinite(price)) return;
        // The band reserved under the candles for volume extrapolates below
        // zero; a click there must not open an add-level form at a negative
        // price.
        if (price <= 0) return;
        setAddPopover({ x: param.point.x, y: param.point.y, price });
      });

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      setSeriesReady(true);
      volumeSeriesRef.current = volumeSeries;

      resizeObserver = new ResizeObserver((entries) => {
        // Guard: the container's detach-triggered resize record can be
        // delivered around the unmount commit, after chart.remove() has
        // disposed the instance — LWC then throws "Object is disposed".
        if (disposed) return;
        const { width, height } = entries[0].contentRect;
        // A width change alone keeps the OLD bar spacing: widening leaves a
        // blank band on the left, narrowing silently drops the left-hand
        // bars while the footer still counts them (deep-QA: charts--stale-
        // bar-spacing-after-rail-resize-blank-left-band, and the twin-panel
        // row). Re-apply the logical range that was visible so the same bars
        // re-space to the new width (a manual zoom survives); with no range
        // yet, fit.
        const widthChanged = width !== lastObservedWidth;
        const timeScale = chart.timeScale();
        const rangeBefore =
          widthChanged && lastObservedWidth > 0 ? timeScale.getVisibleLogicalRange() : null;
        chart.applyOptions({ width, height });
        if (widthChanged && width > 0) {
          if (rangeBefore) timeScale.setVisibleLogicalRange(rangeBefore);
          else if (candleSeries.data().length > 0) fitChartContent(chart, candleSeries, markerSummaryRef.current);
        }
        lastObservedWidth = width;
      });
      resizeObserver.observe(chartContainerRef.current!);

      // Initial data load — fetch 2Y so SMA 200 has enough lookback data
      const data = await fetchChartData("2 Y");
      if (data && data.bars.length > 0 && !disposed) {
        const defaultDuration = DURATIONS.find((d) => d.label === "1Y")!;
        const visibleBars = filterBarsByWindow(data.bars, defaultDuration.months);
        // Footer count must describe the PLOTTED window, not the 2Y payload
        // fetched for SMA lookback — fetchChartData set the raw length.
        setBarCount(visibleBars.length);
        applyBarsToChart(lc, candleSeries, volumeSeries, visibleBars);
        markersPluginRef.current = updateMarkers(lc, candleSeries, data.transactions ?? [], showMarkersRef.current, null, isPrivateRef.current, reportMarkers);
        fitChartContent(chart, candleSeries, markerSummaryRef.current);
      }
    }

    init();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      indicatorMapRef.current.clear();
      // Detach (not just null) the markers plugin BEFORE removing the chart —
      // an attached plugin with a pending internal update otherwise fires
      // into the disposed instance ("Object is disposed" on mode switch).
      try { markersPluginRef.current?.detach?.(); } catch { /* noop */ }
      markersPluginRef.current = null;
      chart?.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      setSeriesReady(false);
      volumeSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [securityId]);

  // True-last-price override: the candle series' built-in price line tracks
  // the last BAR close, which asserts a months-stale number as "last price"
  // whenever the cached bars lag the prices table (the header on the same
  // screen shows the fresh close). When the prices-table row postdates the
  // last daily bar, hide the built-in line and draw the amber line at the
  // true latest price instead. Intraday bars are live-fetched, so the
  // built-in line is already current there.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    if (lastPriceLineRef.current) {
      try {
        series.removePriceLine(lastPriceLineRef.current);
      } catch {
        /* series already disposed */
      }
      lastPriceLineRef.current = null;
    }
    const override =
      !isIntraday &&
      barCount > 0 &&
      latestPriceRow != null &&
      lastDate != null &&
      latestPriceRow.date > lastDate;
    // lastValueVisible is the SEPARATE built-in last-value axis pill — it
    // inherits the amber priceLineColor and would keep asserting the stale
    // bar close on the axis even with the line hidden.
    // Set before applyOptions: that call re-runs the autoscale, which reads it.
    overridePriceRef.current = override ? latestPriceRow.price : null;
    series.applyOptions({ priceLineVisible: !override, lastValueVisible: !override });
    if (override) {
      lastPriceLineRef.current = series.createPriceLine({
        price: latestPriceRow.price,
        color: C.currentPrice,
        lineWidth: 2,
        lineStyle: 0, // solid — same treatment as the built-in line
        axisLabelVisible: true,
        title: "",
      });
    }
  }, [latestPriceRow, lastDate, barCount, isIntraday]);

  // Reapply indicators when toggles change
  useEffect(() => {
    const chart = chartRef.current;
    const allBars = currentBarsRef.current;
    if (!chart || allBars.length === 0) return;

    const selected = DURATIONS.find((d) => d.label === activeDuration);
    const visibleBars = filterBarsByWindow(allBars, selected?.months ?? 12);
    // Zero bars in the selected window: the range handler just cleared the
    // chart under its "No data" overlay. This effect fires on the same
    // activeDuration change and (via the dynamic import) always lands last,
    // so re-adding indicator lines here would paint a stale full-history
    // SMA/EMA under the overlay (deep-QA:
    // charts-1m-range--no-data-overlay-over-visible-candles, step-4 leak).
    // Remove any leftovers and bail instead.
    if (visibleBars.length === 0) {
      for (const [, series] of indicatorMapRef.current) {
        chartRef.current?.removeSeries(series);
      }
      indicatorMapRef.current.clear();
      return;
    }
    const visibleStart = visibleBars[0].date;

    (async () => {
      const lc = await import("lightweight-charts");
      // Re-check after the await — the captured chart may have been disposed
      // by the init effect's cleanup (keyed remount) while the import resolved.
      if (chartRef.current !== chart) return;
      updateIndicators(lc, chart, allBars, activeIndicators, indicatorMapRef.current, visibleStart);
    })();
  }, [activeIndicators, activeDuration]);

  // SPY benchmark overlay removed — the normalized-% approach on a hidden price scale
  // alongside raw-$ candles was visually misleading. Needs a proper dual-axis or
  // percent-change chart mode to be meaningful. Deferred to a future session.

  // Reapply transaction markers when toggle changes
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    (async () => {
      const lc = await import("lightweight-charts");
      // Re-check after the await — refs are nulled when the chart is disposed
      // on unmount, and touching the old markers plugin then throws.
      const series = candleSeriesRef.current;
      if (!series) return;
      markersPluginRef.current = updateMarkers(lc, series, currentTransactionsRef.current, showMarkers, markersPluginRef.current, isPrivateRef.current, reportMarkers);
    })();
  }, [showMarkers, reportMarkers]);

  // Privacy toggle: re-render the marker text, which drops the share counts
  // (portfolio-derived). The price axis, last-price pill, level badges and
  // volume are public market data and are NOT masked, so no formatter needs a
  // nudge here.
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    (async () => {
      const lc = await import("lightweight-charts");
      // Re-check after the await — see the markers effect above.
      const series = candleSeriesRef.current;
      if (!series) return;
      markersPluginRef.current = updateMarkers(
        lc,
        series,
        currentTransactionsRef.current,
        showMarkers,
        markersPluginRef.current,
        isPrivate,
        reportMarkers,
      );
    })();
  }, [isPrivate, showMarkers, reportMarkers]);

  // Render active security_levels as horizontal price lines on the chart.
  // Polls on mount + every 30s so manual edits in LevelsPanel show up without a page reload.
  useEffect(() => {
    let cancelled = false;

    async function loadLevels() {
      const series = candleSeriesRef.current;
      if (!series) return;

      try {
        const res = await fetch(`/api/levels?securityId=${securityId}&activeOnly=true`);
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) {
          setLevelsUnavailable(true);
          return;
        }
        setLevelsUnavailable(false);

        // Clear existing lines
        for (const line of priceLinesRef.current) {
          try { series.removePriceLine(line); } catch { /* already removed */ }
        }
        priceLinesRef.current = [];

        // Level colors — full-strength, solid, 2px. Terminal Pro treatment:
        // impossible to confuse with the amber current-price line.
        const COLOR: Record<string, string> = {
          support: C.supportLine,
          entry: C.supportLine,
          scale_in: C.supportLine,
          resistance: C.resistanceLine,
          exit: C.targetLine,
          stop: C.resistanceLine,
        };

        const activeForDedupe: { price: number; isStatic: boolean }[] = [];
        for (const lvl of json.levels) {
          // effective_price: echoes static price OR current MA value. Falls back to
          // lvl.price if the server couldn't compute (insufficient bars).
          const displayPrice = typeof lvl.effective_price === "number" ? lvl.effective_price : lvl.price;
          const lineColor = COLOR[lvl.level_type] ?? C.gold;
          const line = series.createPriceLine({
            price: displayPrice,
            color: lineColor,
            lineWidth: 2,
            lineStyle: 0, // solid — strong/committed S/R
            axisLabelVisible: true,
            // No title — the verbose per-line label clutters the right axis
            // and redundantly echoes what LevelsPanel already shows below.
            // Color + solid-vs-dotted distinguishes active from suggested;
            // the panel row carries type/touches/narrative context.
            title: "",
            axisLabelColor: lineColor,
            axisLabelTextColor: "#0a0a0a",
          });
          priceLinesRef.current.push(line);
          if (typeof displayPrice === "number" && Number.isFinite(displayPrice)) {
            activeForDedupe.push({ price: displayPrice, isStatic: lvl.price_source === "static" });
          }
        }
        setActiveLevelKey(
          activeForDedupe
            .map((a) => `${a.isStatic ? "s" : "d"}${a.price}`)
            .sort()
            .join("|"),
        );
      } catch {
        // Network error — say so instead of rendering a level-less chart
        // that looks identical to "no levels set". The poll retries.
        if (!cancelled) setLevelsUnavailable(true);
      }
    }

    loadLevels();
    const interval = setInterval(loadLevels, 30_000);

    // Refresh immediately when a level is added from the click popover (or
    // elsewhere) so the new priceLine appears without the 30s poll wait.
    const onLevelAdded = () => loadLevels();
    window.addEventListener("level-added", onLevelAdded);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("level-added", onLevelAdded);
      const series = candleSeriesRef.current;
      if (series) {
        for (const line of priceLinesRef.current) {
          try { series.removePriceLine(line); } catch { /* noop */ }
        }
      }
      priceLinesRef.current = [];
    };
  }, [securityId, seriesReady]);

  // Suggested support/resistance overlay (Theme G). Toggleable — off by
  // default to avoid visual clutter. Dashed muted lines, distinct from the
  // user-created level colors above so the two don't get confused.
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Always clear existing suggested lines when toggle flips or securityId changes.
    // Re-read the ref instead of capturing the series: on chart re-creation the
    // init cleanup has already disposed the chart and nulled the ref by the time
    // this cleanup runs, and removePriceLine on a removed chart doesn't throw —
    // it silently schedules a draw rAF that fires into the disposed canvas
    // ("Object is disposed", uncaught). The disposal removed the lines anyway.
    const clear = () => {
      const s = candleSeriesRef.current;
      if (s) {
        for (const line of suggestedLinesRef.current) {
          try { s.removePriceLine(line); } catch { /* noop */ }
        }
      }
      suggestedLinesRef.current = [];
    };

    if (!showSuggested) {
      clear();
      return;
    }

    let cancelled = false;
    let fetched: { price: number; type: string }[] = [];

    // Never draw a suggestion an active level already shows — an accepted
    // suggestion stays in /api/suggested-levels, and drawing it again printed
    // the same price twice on the axis. Also called (via redrawSuggestedRef)
    // whenever the active levels change, e.g. right after an ACCEPT.
    const draw = () => {
      const s = candleSeriesRef.current;
      if (!s || cancelled) return;
      clear();
      const active = activeLevelKeyRef.current
        .split("|")
        .filter(Boolean)
        .map((k) => ({ isStatic: k[0] === "s", price: Number(k.slice(1)) }));
      for (const lvl of dedupeSuggestedLevels(fetched, active, currencyRef.current)) {
        // Suggested levels share hue with active S/R (green/red) but are
        // dotted + faded so they read as "proposed, not yet committed."
        // The axis pill uses the full-strength color for readability — only
        // the line itself is dimmed, not the label.
        const isRes = lvl.type === "resistance";
        const fullColor = isRes ? "#ef4444" : "#22c55e";
        const fadedColor = isRes ? "#ef444480" : "#22c55e80";
        const line = s.createPriceLine({
          price: lvl.price,
          color: fadedColor,
          lineWidth: 1,
          lineStyle: 1, // dotted — visually distinct from user-accepted levels (solid)
          axisLabelVisible: true,
          title: "", // LevelsPanel below carries confidence/touches context
          axisLabelColor: fullColor,
          axisLabelTextColor: "#0a0a0a",
        });
        suggestedLinesRef.current.push(line);
      }
    };
    redrawSuggestedRef.current = draw;

    async function loadSuggested() {
      if (!candleSeriesRef.current) return;
      try {
        const res = await fetch(`/api/suggested-levels?securityId=${securityId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        fetched = Array.isArray(data.levels) ? data.levels : [];
        draw();
      } catch {
        /* silent */
      }
    }

    loadSuggested();
    // Re-fetch every 5 min — pivot structure only shifts when new daily bars land.
    const interval = setInterval(loadSuggested, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      redrawSuggestedRef.current = null;
      clearInterval(interval);
      clear();
    };
  }, [securityId, showSuggested, seriesReady]);

  // Active levels changed (an ACCEPT, an edit, the 30s poll finding a new
  // one): re-filter the suggested lines already fetched.
  useEffect(() => {
    redrawSuggestedRef.current?.();
  }, [activeLevelKey]);

  const handleDurationChange = useCallback(
    async (label: string) => {
      setActiveDuration(label);
      const selected = DURATIONS.find((d) => d.label === label);
      if (!selected) return;

      let allBars = currentBarsRef.current;
      const txns = currentTransactionsRef.current;

      // If we need more data than what's cached (e.g. switching to "All"),
      // fetch it. Otherwise just filter what we already have.
      if (allBars.length > 0 && selected.months > 0) {
        const oldestBar = allBars[0].date;
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - selected.months);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        if (oldestBar > cutoffStr) {
          // We don't have enough history — fetch more
          const data = await fetchChartData(selected.duration);
          if (data) allBars = data.bars;
        }
      } else if (allBars.length === 0) {
        const data = await fetchChartData(selected.duration);
        if (data) allBars = data.bars;
      } else if (selected.months === 0 && allBars.length > 0) {
        // "All" — fetch full history if we might not have it
        const data = await fetchChartData(selected.duration);
        if (data) allBars = data.bars;
      }

      const visibleBars = filterBarsByWindow(allBars, selected.months);
      const visibleStart = visibleBars.length > 0 ? visibleBars[0].date : undefined;
      setBarCount(visibleBars.length);

      if (visibleBars.length > 0) {
        const lc = await import("lightweight-charts");
        if (candleSeriesRef.current && volumeSeriesRef.current) {
          applyBarsToChart(lc, candleSeriesRef.current, volumeSeriesRef.current, visibleBars);
          updateIndicators(lc, chartRef.current!, allBars, activeIndicators, indicatorMapRef.current, visibleStart);
          if (showMarkers) {
            const filteredTxns = selected.months === 0
              ? txns
              : txns.filter((t) => {
                  const cutoff = new Date();
                  cutoff.setMonth(cutoff.getMonth() - selected.months);
                  return t.date >= cutoff.toISOString().slice(0, 10);
                });
            markersPluginRef.current = updateMarkers(lc, candleSeriesRef.current!, filteredTxns, true, markersPluginRef.current, isPrivateRef.current, reportMarkers);
          }
          if (chartRef.current) fitChartContent(chartRef.current, candleSeriesRef.current, markerSummaryRef.current);
        }
      } else if (candleSeriesRef.current && volumeSeriesRef.current) {
        // Zero bars in the selected window (e.g. cached daily bars are all
        // older than the "1M" cutoff) — clear the stale series so the
        // "No data" overlay isn't painted over the previous range's candles
        // (deep-QA: charts-1m-range--no-data-overlay-over-visible-candles).
        clearChartSeries(candleSeriesRef.current, volumeSeriesRef.current, chartRef.current, indicatorMapRef.current, markersPluginRef);
      }
    },
    [fetchChartData, activeIndicators, showMarkers, reportMarkers],
  );

  const handleTimeframeChange = useCallback(
    async (label: TimeframeLabel) => {
      setActiveTimeframe(label);
      const tf = TIMEFRAMES.find((t) => t.label === label)!;

      if (tf.isIntraday) {
        // Intraday: fetch live from TWS, no duration filtering
        const data = await fetchChartData("", false, tf.barSize);
        if (data && data.bars.length > 0) {
          const lc = await import("lightweight-charts");
          if (candleSeriesRef.current && volumeSeriesRef.current) {
            // Enable time display for intraday
            chartRef.current?.timeScale().applyOptions({ timeVisible: true, secondsVisible: false });
            applyBarsToChart(lc, candleSeriesRef.current, volumeSeriesRef.current, data.bars);
            // Clear indicators (not meaningful on intraday)
            for (const [, series] of indicatorMapRef.current) {
              chartRef.current?.removeSeries(series);
            }
            indicatorMapRef.current.clear();
            // Clear transaction markers (not meaningful on intraday) —
            // detach so the plugin doesn't stay attached to the series
            if (markersPluginRef.current) {
              try { markersPluginRef.current.detach?.(); } catch { /* noop */ }
              markersPluginRef.current = null;
            }
            chartRef.current?.timeScale().fitContent();
          }
        } else if (data && candleSeriesRef.current && volumeSeriesRef.current) {
          // Zero bars returned for the intraday fetch — clear the stale
          // (likely daily) series so the "No data" overlay isn't painted
          // over leftover candles (deep-QA: charts-1m-range--no-data-
          // overlay-over-visible-candles, 2026-08-10 5m manifestation).
          clearChartSeries(candleSeriesRef.current, volumeSeriesRef.current, chartRef.current, indicatorMapRef.current, markersPluginRef);
        }
      } else {
        // Back to daily: reload daily bars
        chartRef.current?.timeScale().applyOptions({ timeVisible: false });
        const selected = DURATIONS.find((d) => d.label === activeDuration)!;
        const data = await fetchChartData(selected.duration, false, "1 day");
        if (!data) return;
        // Gate on VISIBLE bars, not raw bars — raw bars can be non-empty
        // while every one of them falls outside the selected duration's
        // window (deep-QA: charts-1m-range--no-data-overlay-over-visible-
        // candles, the two-gap variant: raw bars > 0 but visible bars = 0
        // used to take the success path below and paint a full-history
        // indicator line under the "No data" overlay).
        const visibleBars = filterBarsByWindow(data.bars, selected.months);
        setBarCount(visibleBars.length);
        if (visibleBars.length > 0) {
          const visibleStart = visibleBars[0].date;
          const lc = await import("lightweight-charts");
          if (candleSeriesRef.current && volumeSeriesRef.current) {
            applyBarsToChart(lc, candleSeriesRef.current, volumeSeriesRef.current, visibleBars);
            updateIndicators(lc, chartRef.current!, data.bars, activeIndicators, indicatorMapRef.current, visibleStart);
            if (showMarkers) markersPluginRef.current = updateMarkers(lc, candleSeriesRef.current!, data.transactions ?? [], true, markersPluginRef.current, isPrivateRef.current, reportMarkers);
            if (chartRef.current) fitChartContent(chartRef.current, candleSeriesRef.current, markerSummaryRef.current);
          }
        } else if (candleSeriesRef.current && volumeSeriesRef.current) {
          // Zero VISIBLE bars for the daily fetch — clear the stale
          // intraday series so the "No data" overlay isn't painted over
          // leftover candles (deep-QA: charts-1m-range--no-data-overlay-
          // over-visible-candles).
          clearChartSeries(candleSeriesRef.current, volumeSeriesRef.current, chartRef.current, indicatorMapRef.current, markersPluginRef);
        }
      }
    },
    [fetchChartData, activeDuration, activeIndicators, showMarkers, reportMarkers],
  );

  const handleRefresh = useCallback(async () => {
    if (isIntraday) {
      const tf = TIMEFRAMES.find((t) => t.label === activeTimeframe)!;
      const data = await fetchChartData("", true, tf.barSize);
      if (data && data.bars.length > 0) {
        import("lightweight-charts").then((lc) => {
          if (candleSeriesRef.current && volumeSeriesRef.current) {
            applyBarsToChart(lc, candleSeriesRef.current, volumeSeriesRef.current, data.bars);
            chartRef.current?.timeScale().fitContent();
          }
        });
      } else if (data && candleSeriesRef.current && volumeSeriesRef.current) {
        // Zero bars on refresh — clear the stale series so the "No data"
        // overlay isn't painted over leftover candles (deep-QA: charts-1m-
        // range--no-data-overlay-over-visible-candles).
        clearChartSeries(candleSeriesRef.current, volumeSeriesRef.current, chartRef.current, indicatorMapRef.current, markersPluginRef);
      }
      return;
    }

    const selected = DURATIONS.find((d) => d.label === activeDuration);
    if (!selected) return;
    const data = await fetchChartData(selected.duration, true);
    if (!data) return;
    // Gate on VISIBLE bars, not raw bars — see the identical gate in
    // handleTimeframeChange's back-to-daily branch (deep-QA: charts-1m-
    // range--no-data-overlay-over-visible-candles, two-gap variant).
    const visibleBars = filterBarsByWindow(data.bars, selected.months);
    setBarCount(visibleBars.length);
    if (visibleBars.length > 0) {
      const visibleStart = visibleBars[0].date;
      import("lightweight-charts").then((lc) => {
        if (candleSeriesRef.current && volumeSeriesRef.current) {
          applyBarsToChart(lc, candleSeriesRef.current, volumeSeriesRef.current, visibleBars);
          updateIndicators(lc, chartRef.current!, data.bars, activeIndicators, indicatorMapRef.current, visibleStart);
          if (showMarkers) markersPluginRef.current = updateMarkers(lc, candleSeriesRef.current!, data.transactions ?? [], true, markersPluginRef.current, isPrivateRef.current, reportMarkers);
          if (chartRef.current) fitChartContent(chartRef.current, candleSeriesRef.current, markerSummaryRef.current);
        }
      });
    } else if (candleSeriesRef.current && volumeSeriesRef.current) {
      // Zero VISIBLE bars on refresh — clear the stale series + indicator
      // overlays so the "No data" overlay isn't painted over leftover
      // candles (deep-QA: charts-1m-range--no-data-overlay-over-visible-
      // candles).
      clearChartSeries(candleSeriesRef.current, volumeSeriesRef.current, chartRef.current, indicatorMapRef.current, markersPluginRef);
    }
  }, [activeDuration, activeTimeframe, isIntraday, fetchChartData, activeIndicators, showMarkers, reportMarkers]);

  const indicatorReason = (ind: (typeof INDICATORS)[number]) =>
    indicatorUnavailableReason({ label: ind.label, period: ind.period, loadedBars: dailyLoaded.count });

  const toggleIndicator = (key: IndicatorKey) => {
    // An average with too few bars would light up and draw nothing: say why
    // instead of switching it on. Switching one OFF always works.
    const ind = INDICATORS.find((i) => i.key === key)!;
    const reason = indicatorReason(ind);
    if (reason && !activeIndicators.has(key)) {
      setIndicatorNote(reason);
      return;
    }
    setIndicatorNote(null);
    setActiveIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Trades left off the chart are disclosed only while the overlay is on and
  // daily bars are plotted (intraday has no trade markers at all).
  const hiddenTradesVisible =
    showMarkers && !isIntraday && barCount > 0 && hiddenTradesReason(markerSummary) != null;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar — symbol + controls ONLY. The crosshair legend has its own
          row below: sharing this row pushed Txns / S/R / Refresh off the
          panel on hover and at 1280 with the chat rail open. From md up the
          control groups wrap onto a second line instead of overflowing;
          phones keep the single scrolling row (ScrollFade adds the right-edge
          cue), where a five-line toolbar would eat the chart. */}
      <ScrollFade className="border-b border-edge shrink-0">
        <div className="flex items-center gap-x-2 gap-y-1.5 px-3 py-1.5 min-w-0 md:flex-wrap">
        {/* chart-legend: inside the dark MarketDataPanel this scope re-maps
            --ink/--ink-faint/--up/--down to dark-theme values (globals.css)
            so the symbol + OHLC crosshair legend stay legible. */}
        {!compact && (
          <div className="chart-legend flex items-center gap-2 shrink-0">
            <span className="font-mono font-semibold text-ink text-lg">{symbol}</span>
          </div>
        )}

        <div className="flex items-center gap-x-2 gap-y-1.5 shrink-0 ml-auto md:shrink md:min-w-0 md:flex-wrap md:justify-end">
          {/* Timeframe buttons */}
          <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.label}
                onClick={() => handleTimeframeChange(tf.label)}
                className={`relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:inset-x-0 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  activeTimeframe === tf.label ? "bg-panel text-gold-ink" : "text-ink-faint hover:text-ink-dim"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>

          {/* Duration buttons (daily only) */}
          {!isIntraday && (
            <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
              {DURATIONS.map((d) => (
                <button
                  key={d.label}
                  onClick={() => handleDurationChange(d.label)}
                  className={`relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:inset-x-0 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    activeDuration === d.label ? "bg-panel text-gold-ink" : "text-ink-faint hover:text-ink-dim"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}

          {/* Indicator toggles (daily only) */}
          {!isIntraday && (
            <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
              {INDICATORS.map((ind) => {
                // Not `disabled`: a disabled button swallows the click that
                // shows the reason, and its tooltip is hover-only.
                const unavailable =
                  !activeIndicators.has(ind.key) ? indicatorReason(ind) : null;
                return (
                <button
                  key={ind.key}
                  onClick={() => toggleIndicator(ind.key)}
                  aria-disabled={unavailable ? true : undefined}
                  className={`relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:inset-x-0 px-2 py-1 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1 ${
                    activeIndicators.has(ind.key)
                      ? "bg-panel text-gold-ink"
                      : unavailable
                        ? "text-ink-faint line-through decoration-1"
                        : "text-ink-faint hover:text-ink-dim"
                  }`}
                  title={unavailable ?? ind.label}
                >
                  {activeIndicators.has(ind.key) && (
                    // Series-color swatch preserves the color association with
                    // the chart line; the label text uses the same accessible
                    // active-state color as the sibling D/All/Txns/S/R toggles
                    // instead of the raw series color (qa:security-detail-chart--
                    // ma-toggle-active-label-low-contrast: EMA 9/21 + SMA 50/200
                    // label text measured as low as 1.39:1 on the light-mode
                    // pill — series colors are tuned for the dark chart canvas,
                    // not this toolbar).
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: ind.color }}
                    />
                  )}
                  {ind.label}
                </button>
                );
              })}
            </div>
          )}

          {/* Overlay toggles (daily only) */}
          {!isIntraday && (
            <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
            <button
              onClick={() => setShowMarkers((v) => !v)}
              className={`relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:inset-x-0 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                showMarkers ? "bg-panel text-gold-ink" : "text-ink-faint hover:text-ink-dim"
              }`}
              title="Show BUY/SELL transaction markers"
            >
              Txns
            </button>
            <button
              onClick={() => setShowSuggested((v) => !v)}
              className={`relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:inset-x-0 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                showSuggested ? "bg-panel text-gold-ink" : "text-ink-faint hover:text-ink-dim"
              }`}
              title="Show computed support / resistance levels (pivot-based)"
            >
              S/R
            </button>
            </div>
          )}

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="chart-chrome relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 px-3 py-1 text-xs font-medium text-ink-faint hover:text-ink-dim
              border border-edge rounded-lg transition-colors disabled:opacity-50"
            title="Refresh from TWS"
          >
            {refreshing ? "..." : "Refresh"}
          </button>
        </div>
        </div>
      </ScrollFade>

      {/* Crosshair legend — its own row with a RESERVED height, so hovering
          the plot never moves or resizes the toolbar above it. Single line,
          clipped rather than wrapped for the same reason. Compact panels
          have no legend. Prices and volume here are public market data. */}
      {!compact && (
        <div className="chart-legend shrink-0 h-6 px-3 flex items-center gap-3 text-xs font-mono whitespace-nowrap overflow-hidden border-b border-edge">
          {legend && (
            <>
              {/* O/H/L hidden on phones — too cramped with indicators.
                  Close + optional delta-to-open + active indicators always show. */}
              <span className="hidden md:inline-flex items-center gap-1">
                <span className="text-ink-faint">O</span>
                <ChartMoney value={legend.open} currency={currency} className="text-ink" />
              </span>
              <span className="hidden md:inline-flex items-center gap-1">
                <span className="text-ink-faint">H</span>
                <ChartMoney value={legend.high} currency={currency} className="text-ink" />
              </span>
              <span className="hidden md:inline-flex items-center gap-1">
                <span className="text-ink-faint">L</span>
                <ChartMoney value={legend.low} currency={currency} className="text-ink" />
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="text-ink-faint">C</span>
                <ChartMoney
                  value={legend.close}
                  currency={currency}
                  className={legend.close >= legend.open ? "text-up" : "text-down"}
                />
              </span>
              {/* Mobile-only: signed delta from open (replaces O/H/L for context). */}
              <span className="inline-flex md:hidden items-baseline">
                <ChartMoney
                  value={legend.close - legend.open}
                  currency={currency}
                  signed
                  className={legend.close >= legend.open ? "text-up" : "text-down"}
                />
              </span>
              {legend.volume != null && (
                <span className="hidden md:inline-flex items-center gap-1">
                  <span className="text-ink-faint">Vol</span>
                  <span className="text-ink">{formatNumber(legend.volume)}</span>
                </span>
              )}
              {/* Toolbar order, not the order the toggles were clicked in. */}
              {INDICATORS.filter((ind) => legend.indicators?.[ind.key] != null).map((ind) => (
                <span key={ind.key} className="flex items-baseline gap-1">
                  <span className="text-ink-faint" style={{ color: ind.color }}>{ind.label}</span>
                  <ChartMoney value={legend.indicators![ind.key]} currency={currency} className="text-ink" />
                </span>
              ))}
            </>
          )}
        </div>
      )}

      {/* Status bar */}
      {(warning || error) && (
        <div className={`shrink-0 px-4 py-1.5 text-xs font-medium ${error ? "bg-down/20 text-down" : "bg-gold/20 text-gold"}`}>
          {error || warning}
        </div>
      )}
      {!warning && !error && levelsUnavailable && (
        <div className="shrink-0 px-4 py-1.5 text-xs font-medium bg-gold/20 text-gold">
          Price-level overlays unavailable — the levels fetch failed; retrying automatically.
        </div>
      )}
      {!warning && !error && !levelsUnavailable && indicatorNote && !isIntraday && (
        <div className="shrink-0 px-4 py-1.5 text-xs font-medium bg-gold/20 text-gold">
          {indicatorNote}
        </div>
      )}

      {/* Chart container */}
      {/* Compact panels live in a FIXED-height box (MultiChart): the chart
          area is the one row allowed to give way, so a wrapped toolbar or a
          two-line banner shrinks the plot instead of crushing the footer
          (deep-QA: mobile-charts-2x2--bars-footer-crushed-blank-strip). */}
      <div className={`flex-1 relative ${compact ? "min-h-[160px]" : "min-h-[300px]"}`}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-panel/80 z-10">
            <div className="text-ink-faint text-sm">Loading chart data...</div>
          </div>
        )}
        {/* Explicit empty state — a blank black canvas next to a "cached data"
            banner reads as broken. Centered message inside the chart area
            (EmptySection's card chrome doesn't fit inside a chart panel).
            Shows in both Single and Watchlist (compact) modes. */}
        {!loading && !error && barCount === 0 && (
          <div className="absolute inset-0 z-[5] flex items-center justify-center px-4 pointer-events-none">
            <p
              className="text-sm font-mono text-center"
              style={{ color: C.text }}
            >
              {chartEmptyStateMessage({
                visibleBarCount: barCount,
                lastBarDate: lastDate,
                rangeLabel: durationRangeLabel(
                  DURATIONS.find((d) => d.label === activeDuration)?.months ?? 12,
                ),
                symbol,
                intradayLabel: isIntraday ? activeTimeframe : null,
                dailyLastBarDate: dailyLoaded.lastDate,
              })}
            </p>
          </div>
        )}
        <div ref={chartContainerRef} className="w-full h-full" />
        {addPopover && !compact && (
          <AddLevelPopover
            securityId={securityId}
            symbol={symbol}
            price={addPopover.price}
            currentPrice={latestClose}
            currency={currency}
            securityType={securityType}
            x={addPopover.x}
            y={addPopover.y}
            onClose={() => setAddPopover(null)}
            onAdded={() => setAddPopover(null)}
          />
        )}
      </div>

      {/* Footer — full controls in Single mode. Compact/Watchlist panels get
          a slim staleness-only line (same barCount/lastDate source, same
          format via chartFooterStalenessText) so a panel whose cache is
          months stale doesn't read as current (deep-QA: charts-watchlist-
          panels--no-bars-through-date-staleness-footer). MultiChart reserves
          extra fixed panel height for this bar — see chartHeight in
          MultiChart.tsx, mirroring how it already reserves 32px for its own
          per-panel picker header. */}
      {compact ? (
        // shrink-0: `truncate` sets overflow hidden, which lets a flex item
        // shrink to nothing — this line was painted as a 9px blank strip.
        <div className="chart-chrome shrink-0 px-3 py-1 border-t border-edge text-xs text-ink-faint truncate">
          {chartFooterStalenessText({ barCount, lastDate, intraday: isIntraday, dailyLastBarDate: dailyLoaded.lastDate })}
          {hiddenTradesVisible && <HiddenTradesNote summary={markerSummary} />}
        </div>
      ) : (
        <div className="chart-chrome shrink-0 px-4 py-1.5 border-t border-edge flex items-center justify-between text-xs text-ink-faint gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <span>{chartFooterStalenessText({ barCount, lastDate, intraday: isIntraday, dailyLastBarDate: dailyLoaded.lastDate })}</span>
            {hiddenTradesVisible && <HiddenTradesNote summary={markerSummary} />}
            {/* Level-type color key — maps chart overlay colors to what they mean. */}
            <div className="hidden sm:flex items-center gap-2 text-[10px] opacity-70">
              <LegendDot color="#ffb84d" label="last price" />
              <LegendDot color="#22c55e" label="support / entry" />
              <LegendDot color="#60a5fa" label="target" />
              <LegendDot color="#ef4444" label="resistance / stop" />
            </div>
          </div>
          <span>{isIntraday ? `${activeTimeframe} intraday` : "Daily OHLCV"} via TWS</span>
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        aria-hidden
        className="inline-block w-2.5 h-[2px] rounded-sm"
        style={{ background: color, boxShadow: `0 0 0 1px ${color}` }}
      />
      <span>{label}</span>
    </span>
  );
}

/**
 * "Trades not plotted: N (reason)" — the footer disclosure for markers the
 * chart refused to draw on the wrong bar. The count is portfolio-derived, so
 * it goes through <Count> (masked in privacy mode); the wording never
 * singularises, so it cannot reveal that the count is one.
 */
function HiddenTradesNote({ summary }: { summary: MarkerSummary }) {
  const reason = hiddenTradesReason(summary);
  if (!reason) return null;
  return (
    <span>
      {" · "}Trades not plotted:{" "}
      <Count value={summary.hiddenAfterLastBar + summary.hiddenNoBar} /> ({reason})
    </span>
  );
}

/**
 * OHLC-legend / indicator price cell. The crosshair legend reads raw NATIVE
 * bar values (never FX-converted, same frame as the candles themselves), so
 * it needs the same native-currency labeling as the chart's own axis/pill.
 *
 * A bar's open/high/low/close and a moving average of them are PUBLIC market
 * data, so this renders plain in privacy mode — it used to delegate to
 * <Money>, which masked the whole readout. USD keeps <Money precise>'s exact
 * format (formatUSDPrecise); any other currency goes through formatChartPrice.
 */
function ChartMoney({
  value,
  currency,
  className,
  signed = false,
}: {
  value: number;
  currency: string | null | undefined;
  className?: string;
  signed?: boolean;
}) {
  const code = (currency ?? "").trim().toUpperCase();
  const formatted =
    code === "" || code === "USD"
      ? formatUSDPrecise(Math.abs(value))
      : formatChartPrice(currency, Math.abs(value));
  // Same negative-zero guard as <Money> — sign decided after rounding, never
  // "−₩0" / "+₩0" for a tiny value that rounds to zero at render precision.
  const sign = rendersAsZero(formatted)
    ? ""
    : signed && value > 0
      ? "+"
      : value < 0
        ? "−"
        : "";
  return <span className={className}>{`${sign}${formatted}`}</span>;
}

// ---------- Helper functions ----------

type LightweightChartsModule = typeof import("lightweight-charts");

/** Convert a bar date to LightweightCharts time.
 *  Daily dates ("2025-03-26") → string (business day).
 *  Intraday dates ("2025-03-26 09:30") → UTCTimestamp (epoch seconds). */
function toChartTime(dateStr: string): import("lightweight-charts").Time {
  if (dateStr.includes(" ")) {
    // Intraday: parse "YYYY-MM-DD HH:MM" → epoch seconds
    const d = new Date(dateStr.replace(" ", "T") + ":00");
    return (d.getTime() / 1000) as import("lightweight-charts").UTCTimestamp;
  }
  return dateStr as import("lightweight-charts").Time;
}

function applyBarsToChart(
  _lc: LightweightChartsModule,
  candleSeries: ISeriesApi<"Candlestick">,
  volumeSeries: ISeriesApi<"Histogram">,
  bars: OhlcvBar[],
) {
  candleSeries.setData(
    bars.map((b) => ({
      time: toChartTime(b.date),
      open: b.open, high: b.high, low: b.low, close: b.close,
    })),
  );
  volumeSeries.setData(
    bars.map((b) => ({
      time: toChartTime(b.date),
      value: b.volume ?? 0,
      color: b.close >= b.open ? C.volumeUp : C.volumeDown,
    })),
  );
}

/**
 * Clear the candle/volume series + indicator lines + transaction markers.
 * Every entrance that can land on zero VISIBLE bars (duration/timeframe/
 * refresh fetches all filter raw bars down to a window) must route through
 * here instead of taking the success path — otherwise a stale candle/volume
 * series, or a full-history indicator line (updateIndicators has no visible
 * window to clip to when visibleStart is undefined), paints under the
 * "No cached price history" overlay (deep-QA: charts-1m-range--no-data-
 * overlay-over-visible-candles). Callers must guard on
 * candleSeriesRef.current && volumeSeriesRef.current before calling, same as
 * every other series mutation in this file — a disposed chart must never be
 * touched.
 */
function clearChartSeries(
  candleSeries: ISeriesApi<"Candlestick">,
  volumeSeries: ISeriesApi<"Histogram">,
  chart: IChartApi | null,
  indicatorMap: Map<string, ISeriesApi<"Line">>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  markersPluginRef: { current: any },
) {
  candleSeries.setData([]);
  volumeSeries.setData([]);
  for (const [, series] of indicatorMap) {
    chart?.removeSeries(series);
  }
  indicatorMap.clear();
  if (markersPluginRef.current) {
    try { markersPluginRef.current.detach?.(); } catch { /* noop */ }
    markersPluginRef.current = null;
  }
}

/**
 * Update indicator overlays.
 * @param allBars — full dataset for computing long-period indicators (e.g. SMA 200)
 * @param visibleStartDate — if set, only display indicator points from this date onward
 */
function updateIndicators(
  lc: LightweightChartsModule,
  chart: IChartApi,
  allBars: OhlcvBar[],
  activeKeys: Set<IndicatorKey>,
  existingSeries: Map<string, ISeriesApi<"Line">>,
  visibleStartDate?: string,
) {

  // Remove series that are no longer active
  for (const [key, series] of existingSeries) {
    if (!activeKeys.has(key as IndicatorKey)) {
      chart.removeSeries(series);
      existingSeries.delete(key);
    }
  }

  // Add/update active indicators — compute on ALL bars, then clip to visible range
  for (const ind of INDICATORS) {
    if (!activeKeys.has(ind.key)) continue;

    let points = ind.fn(allBars);
    if (points.length === 0) continue;

    // Clip to visible window
    if (visibleStartDate) {
      points = points.filter((p) => p.date >= visibleStartDate);
    }
    if (points.length === 0) continue;

    let series = existingSeries.get(ind.key);
    if (!series) {
      series = chart.addSeries(lc.LineSeries, {
        color: ind.color,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      existingSeries.set(ind.key, series);
    }

    series.setData(
      points.map((p) => ({
        time: p.date as import("lightweight-charts").Time,
        value: p.value,
      })),
    );
  }
}

/**
 * Fit every plotted bar into the plot, leaving room at an end whose bar
 * carries a marker label (see markerEdgePaddingBars).
 */
function fitChartContent(
  chart: IChartApi,
  candleSeries: ISeriesApi<"Candlestick"> | null,
  summary: MarkerSummary,
) {
  const timeScale = chart.timeScale();
  timeScale.fitContent();
  const barCount = candleSeries ? candleSeries.data().length : 0;
  const pad = markerEdgePaddingBars({
    plotWidth: timeScale.width(),
    barCount,
    firstBarLabelChars: summary.firstBarLabelChars,
    lastBarLabelChars: summary.lastBarLabelChars,
  });
  if (pad.left > 0 || pad.right > 0) {
    timeScale.setVisibleLogicalRange({
      from: -0.5 - pad.left,
      to: barCount - 0.5 + pad.right,
    });
  }
}

/**
 * Marker label. Share counts are portfolio-derived and are dropped in
 * privacy mode. A marker drawn on the previous trading day's bar (the trade
 * date had no bar) carries its real trade date, so it never reads as a trade
 * made on the bar it sits on.
 */
export function markerText(
  t: TransactionMarker,
  privateMode: boolean,
  snapped = false,
): string {
  const label = markerTypeLabel(t.type);
  const base = privateMode
    ? label
    : `${label}${t.quantity != null ? ` ${t.quantity}` : ""}`;
  return snapped ? `${base} · ${t.date.slice(5, 10)}` : base;
}

function updateMarkers(
  lc: LightweightChartsModule,
  candleSeries: ISeriesApi<"Candlestick">,
  transactions: TransactionMarker[],
  show: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existing: any,
  privateMode = false,
  report: (summary: MarkerSummary) => void = () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // When there is nothing to show, DETACH the old plugin rather than just
  // emptying it. Every call used to create a fresh plugin while the emptied
  // one stayed attached to the series — after a few toggles the series
  // carried a stack of orphaned marker plugins whose pending internal
  // updates could fire after chart.remove() ("Object is disposed").
  const detachExisting = () => {
    if (existing) {
      try { existing.detach?.(); } catch { /* chart already disposed */ }
    }
  };

  if (!show || transactions.length === 0) {
    detachExisting();
    report(NO_MARKERS);
    return null;
  }

  // Each trade is mapped to a bar by placeTransactionMarkers — never left to
  // LightweightCharts, which pins a marker with no bar of its own onto the
  // nearest later bar or the final one (trades older than the first bar
  // stacked on the left edge; trades newer than a stale cache's last bar
  // stacked on the right edge, months misdated). Deriving the bar dates from
  // the series covers every caller (mount, refresh, duration change).
  // Intraday bars carry numeric times and get no trade markers.
  const bars = candleSeries.data();
  const barDates: string[] = [];
  for (const b of bars) {
    if (typeof b.time === "string") barDates.push(b.time);
  }
  const placement = placeTransactionMarkers(transactions, barDates);
  const summaryBase = {
    hiddenAfterLastBar: placement.hiddenAfterLastBar,
    hiddenNoBar: placement.hiddenNoBar,
  };
  if (barDates.length !== bars.length || placement.placed.length === 0) {
    detachExisting();
    report(
      barDates.length !== bars.length
        ? NO_MARKERS
        : { ...summaryBase, firstBarLabelChars: 0, lastBarLabelChars: 0 },
    );
    return null;
  }

  const isBuy = (t: string) =>
    t === "BUY" || t === "BUY_TO_OPEN" || t === "BUY_TO_CLOSE";

  type MarkerType = import("lightweight-charts").SeriesMarker<import("lightweight-charts").Time>;
  const firstBar = barDates[0];
  const lastBar = barDates[barDates.length - 1];
  let firstBarLabelChars = 0;
  let lastBarLabelChars = 0;
  const markers: MarkerType[] = placement.placed.map(({ txn: t, barDate, snapped }) => {
    const text = markerText(t, privateMode, snapped);
    if (barDate === firstBar) firstBarLabelChars = Math.max(firstBarLabelChars, text.length);
    if (barDate === lastBar) lastBarLabelChars = Math.max(lastBarLabelChars, text.length);
    return {
      time: barDate as import("lightweight-charts").Time,
      position: isBuy(t.type) ? ("belowBar" as const) : ("aboveBar" as const),
      shape: isBuy(t.type) ? ("arrowUp" as const) : ("arrowDown" as const),
      color: isBuy(t.type) ? C.upColor : C.downColor,
      text,
      size: 1,
    };
  });
  report({ ...summaryBase, firstBarLabelChars, lastBarLabelChars });

  // Reuse the attached plugin when one exists — one plugin per series, ever.
  if (existing) {
    existing.setMarkers(markers);
    return existing;
  }
  return lc.createSeriesMarkers(candleSeries, markers);
}
