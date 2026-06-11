"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { OhlcvBar } from "@/lib/tws/types";
import { computeSMA, computeEMA } from "@/lib/chart/indicators";
import { Money, Count } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import { AddLevelPopover } from "./AddLevelPopover";

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

// Terminal Pro theme — dark Bloomberg-adjacent. Amber current-price, bright
// emerald/rose for level treatments (strong, solid) so they can never be
// confused with the amber current-price line.
const C = {
  background: "#0a0a0a",
  gridLines: "#1a1a1a",
  text: "#777777",
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
  { key: "ema9", label: "EMA 9", color: C.ema9, fn: (bars: OhlcvBar[]) => computeEMA(bars, 9) },
  { key: "ema21", label: "EMA 21", color: C.ema21, fn: (bars: OhlcvBar[]) => computeEMA(bars, 21) },
  { key: "sma50", label: "SMA 50", color: C.sma50, fn: (bars: OhlcvBar[]) => computeSMA(bars, 50) },
  { key: "sma200", label: "SMA 200", color: C.sma200, fn: (bars: OhlcvBar[]) => computeSMA(bars, 200) },
] as const;

type IndicatorKey = (typeof INDICATORS)[number]["key"];

export function SecurityChart({
  securityId,
  symbol,
  compact = false,
}: {
  securityId: number;
  symbol: string;
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

  // Toggle states
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorKey>>(new Set());
  const [showMarkers, setShowMarkers] = useState(true);
  const [showSuggested, setShowSuggested] = useState(false);
  // Level-overlay fetch failed — chart renders without level lines, which is
  // indistinguishable from "no levels set" unless we say so. Self-heals on
  // the 30s poll, at which point the hint clears.
  const [levelsUnavailable, setLevelsUnavailable] = useState(false);

  // Click-to-add-level popover. Null when no level is being added.
  const [addPopover, setAddPopover] = useState<{
    x: number;
    y: number;
    price: number;
  } | null>(null);
  const [latestClose, setLatestClose] = useState<number | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const suggestedLinesRef = useRef<any[]>([]);

  const isIntraday = activeTimeframe !== "D";

  // Store current bars for indicator recomputation
  const currentBarsRef = useRef<OhlcvBar[]>([]);
  const currentTransactionsRef = useRef<TransactionMarker[]>([]);

  const { isPrivate } = usePrivacy();
  const isPrivateRef = useRef(isPrivate);
  isPrivateRef.current = isPrivate;

  const fetchChartData = useCallback(
    async (duration: string, refresh = false, barSizeOverride?: string) => {
      try {
        setLoading(!refresh);
        setRefreshing(refresh);
        setError(null);
        setWarning(null);

        const res = await fetch("/api/tws/chart", {
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
        currentBarsRef.current = data.bars;
        currentTransactionsRef.current = data.transactions ?? [];
        if (data.bars.length > 0) {
          setLatestClose(data.bars[data.bars.length - 1].close);
        }
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

    async function init() {
      const lc = await import("lightweight-charts");
      if (disposed || !chartContainerRef.current) return;

      chart = lc.createChart(chartContainerRef.current, {
        localization: {
          priceFormatter: (p: number) =>
            isPrivateRef.current
              ? "\u2022\u2022\u2022"
              : `$${p.toFixed(2)}`,
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
      });

      volumeSeries = chart.addSeries(lc.HistogramSeries, {
        priceFormat: {
          type: "custom",
          minMove: 1,
          formatter: (v: number) => {
            if (isPrivateRef.current) return "\u2022\u2022\u2022";
            if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
            if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
            return `${v}`;
          },
        },
        priceScaleId: "volume",
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
        setAddPopover({ x: param.point.x, y: param.point.y, price });
      });

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      volumeSeriesRef.current = volumeSeries;

      resizeObserver = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        chart.applyOptions({ width, height });
      });
      resizeObserver.observe(chartContainerRef.current!);

      // Initial data load — fetch 2Y so SMA 200 has enough lookback data
      const data = await fetchChartData("2 Y");
      if (data && data.bars.length > 0 && !disposed) {
        const defaultDuration = DURATIONS.find((d) => d.label === "1Y")!;
        const visibleBars = filterBarsByWindow(data.bars, defaultDuration.months);
        applyBarsToChart(lc, candleSeries, volumeSeries, visibleBars);
        markersPluginRef.current = updateMarkers(lc, candleSeries, data.transactions ?? [], true, null, isPrivateRef.current);
        chart.timeScale().fitContent();
      }
    }

    init();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      indicatorMapRef.current.clear();
      markersPluginRef.current = null;
      chart?.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [securityId]);

  // Reapply indicators when toggles change
  useEffect(() => {
    const chart = chartRef.current;
    const allBars = currentBarsRef.current;
    if (!chart || allBars.length === 0) return;

    const selected = DURATIONS.find((d) => d.label === activeDuration);
    const visibleBars = filterBarsByWindow(allBars, selected?.months ?? 12);
    const visibleStart = visibleBars.length > 0 ? visibleBars[0].date : undefined;

    (async () => {
      const lc = await import("lightweight-charts");
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
      markersPluginRef.current = updateMarkers(lc, candleSeriesRef.current!, currentTransactionsRef.current, showMarkers, markersPluginRef.current, isPrivateRef.current);
    })();
  }, [showMarkers]);

  // Privacy toggle: force chart to re-read its formatters (axis labels) + re-render markers.
  // LightweightCharts only calls priceFormatter/volume formatter when data changes, so we
  // nudge it with applyOptions and explicitly re-render the marker text.
  useEffect(() => {
    const chart = chartRef.current;
    const volume = volumeSeriesRef.current;
    if (!chart || !volume) return;

    chart.applyOptions({
      localization: {
        priceFormatter: (p: number) =>
          isPrivate ? "\u2022\u2022\u2022" : `$${p.toFixed(2)}`,
      },
    });
    volume.applyOptions({
      priceFormat: {
        type: "custom",
        minMove: 1,
        formatter: (v: number) => {
          if (isPrivate) return "\u2022\u2022\u2022";
          if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
          if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
          return `${v}`;
        },
      },
    });

    if (candleSeriesRef.current) {
      (async () => {
        const lc = await import("lightweight-charts");
        markersPluginRef.current = updateMarkers(
          lc,
          candleSeriesRef.current!,
          currentTransactionsRef.current,
          showMarkers,
          markersPluginRef.current,
          isPrivate,
        );
      })();
    }
  }, [isPrivate, showMarkers]);

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
        }
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
  }, [securityId]);

  // Suggested support/resistance overlay (Theme G). Toggleable — off by
  // default to avoid visual clutter. Dashed muted lines, distinct from the
  // user-created level colors above so the two don't get confused.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    // Always clear existing suggested lines when toggle flips or securityId changes.
    const clear = () => {
      for (const line of suggestedLinesRef.current) {
        try { series.removePriceLine(line); } catch { /* noop */ }
      }
      suggestedLinesRef.current = [];
    };

    if (!showSuggested) {
      clear();
      return;
    }

    let cancelled = false;

    async function loadSuggested() {
      const s = candleSeriesRef.current;
      if (!s) return;
      try {
        const res = await fetch(`/api/suggested-levels?securityId=${securityId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        clear();

        for (const lvl of data.levels ?? []) {
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
      } catch {
        /* silent */
      }
    }

    loadSuggested();
    // Re-fetch every 5 min — pivot structure only shifts when new daily bars land.
    const interval = setInterval(loadSuggested, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clear();
    };
  }, [securityId, showSuggested]);

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
            markersPluginRef.current = updateMarkers(lc, candleSeriesRef.current!, filteredTxns, true, markersPluginRef.current, isPrivateRef.current);
          }
          chartRef.current?.timeScale().fitContent();
        }
      }
    },
    [fetchChartData, activeIndicators, showMarkers],
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
            // Clear transaction markers (not meaningful on intraday)
            if (markersPluginRef.current) {
              markersPluginRef.current.setMarkers([]);
              markersPluginRef.current = null;
            }
            chartRef.current?.timeScale().fitContent();
          }
        }
      } else {
        // Back to daily: reload daily bars
        chartRef.current?.timeScale().applyOptions({ timeVisible: false });
        const selected = DURATIONS.find((d) => d.label === activeDuration)!;
        const data = await fetchChartData(selected.duration, false, "1 day");
        if (data && data.bars.length > 0) {
          const visibleBars = filterBarsByWindow(data.bars, selected.months);
          const visibleStart = visibleBars.length > 0 ? visibleBars[0].date : undefined;
          const lc = await import("lightweight-charts");
          if (candleSeriesRef.current && volumeSeriesRef.current) {
            applyBarsToChart(lc, candleSeriesRef.current, volumeSeriesRef.current, visibleBars);
            updateIndicators(lc, chartRef.current!, data.bars, activeIndicators, indicatorMapRef.current, visibleStart);
            if (showMarkers) markersPluginRef.current = updateMarkers(lc, candleSeriesRef.current!, data.transactions ?? [], true, markersPluginRef.current, isPrivateRef.current);
            chartRef.current?.timeScale().fitContent();
          }
        }
      }
    },
    [fetchChartData, activeDuration, activeIndicators, showMarkers],
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
      }
      return;
    }

    const selected = DURATIONS.find((d) => d.label === activeDuration);
    if (!selected) return;
    const data = await fetchChartData(selected.duration, true);
    if (data && data.bars.length > 0) {
      const visibleBars = filterBarsByWindow(data.bars, selected.months);
      const visibleStart = visibleBars.length > 0 ? visibleBars[0].date : undefined;
      import("lightweight-charts").then((lc) => {
        if (candleSeriesRef.current && volumeSeriesRef.current) {
          applyBarsToChart(lc, candleSeriesRef.current, volumeSeriesRef.current, visibleBars);
          updateIndicators(lc, chartRef.current!, data.bars, activeIndicators, indicatorMapRef.current, visibleStart);
          if (showMarkers) markersPluginRef.current = updateMarkers(lc, candleSeriesRef.current!, data.transactions ?? [], true, markersPluginRef.current, isPrivateRef.current);
          chartRef.current?.timeScale().fitContent();
        }
      });
    }
  }, [activeDuration, activeTimeframe, isIntraday, fetchChartData, activeIndicators, showMarkers]);

  const toggleIndicator = (key: IndicatorKey) => {
    setActiveIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge overflow-x-auto min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          {!compact && <span className="font-mono font-semibold text-ink text-lg">{symbol}</span>}
          {!compact && legend && (
            <div className="flex items-center gap-3 text-xs font-mono">
              {/* O/H/L hidden on phones — too cramped with indicators.
                  Close + optional delta-to-open + active indicators always show. */}
              <span className="hidden md:inline-flex items-center gap-1">
                <span className="text-ink-faint">O</span>
                <Money value={legend.open} precise className="text-ink" />
              </span>
              <span className="hidden md:inline-flex items-center gap-1">
                <span className="text-ink-faint">H</span>
                <Money value={legend.high} precise className="text-ink" />
              </span>
              <span className="hidden md:inline-flex items-center gap-1">
                <span className="text-ink-faint">L</span>
                <Money value={legend.low} precise className="text-ink" />
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="text-ink-faint">C</span>
                <Money
                  value={legend.close}
                  precise
                  className={legend.close >= legend.open ? "text-up" : "text-down"}
                />
              </span>
              {/* Mobile-only: signed delta from open (replaces O/H/L for context). */}
              <span className="inline-flex md:hidden items-baseline">
                <Money
                  value={legend.close - legend.open}
                  precise
                  signed
                  className={legend.close >= legend.open ? "text-up" : "text-down"}
                />
              </span>
              {legend.volume != null && (
                <span className="hidden md:inline-flex items-center gap-1">
                  <span className="text-ink-faint">Vol</span>
                  <Count value={legend.volume} className="text-ink" />
                </span>
              )}
              {legend.indicators && Object.entries(legend.indicators).map(([key, value]) => {
                const label = INDICATORS.find((i) => i.key === key)?.label ?? key;
                const color = INDICATORS.find((i) => i.key === key)?.color ?? "#C9A44E";
                return (
                  <span key={key} className="flex items-baseline gap-1">
                    <span className="text-ink-faint" style={{ color }}>{label}</span>
                    <Money value={value} precise className="text-ink" />
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {/* Timeframe buttons */}
          <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.label}
                onClick={() => handleTimeframeChange(tf.label)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  activeTimeframe === tf.label ? "bg-panel text-gold" : "text-ink-faint hover:text-ink-dim"
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
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    activeDuration === d.label ? "bg-panel text-gold" : "text-ink-faint hover:text-ink-dim"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}

          {/* Indicator toggles (daily, full mode only) */}
          {!isIntraday && !compact && (
            <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
              {INDICATORS.map((ind) => (
                <button
                  key={ind.key}
                  onClick={() => toggleIndicator(ind.key)}
                  className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                    activeIndicators.has(ind.key)
                      ? "bg-panel"
                      : "text-ink-faint hover:text-ink-dim"
                  }`}
                  style={activeIndicators.has(ind.key) ? { color: ind.color } : undefined}
                  title={ind.label}
                >
                  {ind.label}
                </button>
              ))}
            </div>
          )}

          {/* Overlay toggles (daily, full mode only) */}
          {!isIntraday && !compact && (
            <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
            <button
              onClick={() => setShowMarkers((v) => !v)}
              className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                showMarkers ? "bg-panel text-gold" : "text-ink-faint hover:text-ink-dim"
              }`}
              title="Show BUY/SELL transaction markers"
            >
              Txns
            </button>
            <button
              onClick={() => setShowSuggested((v) => !v)}
              className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                showSuggested ? "bg-panel text-gold" : "text-ink-faint hover:text-ink-dim"
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
            className="px-3 py-1 text-xs font-medium text-ink-faint hover:text-ink-dim
              border border-edge rounded-lg transition-colors disabled:opacity-50"
            title="Refresh from TWS"
          >
            {refreshing ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Status bar */}
      {(warning || error) && (
        <div className={`px-4 py-1.5 text-xs font-medium ${error ? "bg-down/20 text-down" : "bg-gold/20 text-gold"}`}>
          {error || warning}
        </div>
      )}
      {!warning && !error && levelsUnavailable && (
        <div className="px-4 py-1.5 text-xs font-medium bg-gold/20 text-gold">
          Price-level overlays unavailable — the levels fetch failed; retrying automatically.
        </div>
      )}

      {/* Chart container */}
      <div className="flex-1 relative min-h-[300px]">
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
              No cached price history for {symbol} — connect TWS to load bars.
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
            x={addPopover.x}
            y={addPopover.y}
            onClose={() => setAddPopover(null)}
            onAdded={() => setAddPopover(null)}
          />
        )}
      </div>

      {/* Footer (hidden in compact/multi-panel mode) */}
      {!compact && (
        <div className="px-4 py-1.5 border-t border-edge flex items-center justify-between text-xs text-ink-faint gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <span>
              {barCount > 0 ? `${barCount} bars` : "No data"}
              {lastDate && ` \u00b7 through ${lastDate}`}
            </span>
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

function markerText(t: TransactionMarker, privateMode: boolean): string {
  if (privateMode) return t.type;
  return `${t.type}${t.quantity != null ? ` ${t.quantity}` : ""}`;
}

function updateMarkers(
  lc: LightweightChartsModule,
  candleSeries: ISeriesApi<"Candlestick">,
  transactions: TransactionMarker[],
  show: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existing: any,
  privateMode = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // Remove old markers
  if (existing) {
    existing.setMarkers([]);
  }

  if (!show || transactions.length === 0) return null;

  const isBuy = (t: string) =>
    t === "BUY" || t === "BUY_TO_OPEN" || t === "BUY_TO_CLOSE";

  type MarkerType = import("lightweight-charts").SeriesMarker<import("lightweight-charts").Time>;
  const markers: MarkerType[] = transactions.map((t) => ({
    time: t.date as import("lightweight-charts").Time,
    position: isBuy(t.type) ? ("belowBar" as const) : ("aboveBar" as const),
    shape: isBuy(t.type) ? ("arrowUp" as const) : ("arrowDown" as const),
    color: isBuy(t.type) ? C.upColor : C.downColor,
    text: markerText(t, privateMode),
    size: 1,
  }));

  return lc.createSeriesMarkers(candleSeries, markers);
}
