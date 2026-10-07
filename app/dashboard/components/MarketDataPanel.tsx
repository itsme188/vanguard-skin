"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { SecurityChart } from "./SecurityChart";
import { LevelsPanel } from "./LevelsPanel";
import { KpiCell } from "./TerminalSection";
import { formatUSDPrecise, formatPercent, formatNumber, rendersAsZero } from "@/lib/format";
import { todayET, nowET, addDays } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import type { SecurityKpis } from "@/lib/queries/security-detail";

/**
 * Everything this panel prints is PUBLIC market data (quote, day change,
 * open / range / volume / ATR): anyone can look it up and it reveals nothing
 * about the user's holdings, so it stays visible under Hide amounts and uses
 * plain formatters — the same rule QuoteStats follows for the 52-week range
 * lower on the page. Sign is decided after rounding (never "+$0.00").
 */
export function formatPublicUSD(
  value: number,
  opts: { bare?: boolean; signed?: boolean } = {}
): string {
  const formatted = formatUSDPrecise(Math.abs(value));
  const numeric = opts.bare ? formatted.replace(/^\$/, "") : formatted;
  const sign = rendersAsZero(numeric) ? "" : value < 0 ? "−" : opts.signed ? "+" : "";
  return `${sign}${numeric}`;
}

export function formatPublicPct(value: number, digits = 1, signed = false): string {
  const formatted = formatPercent(Math.abs(value), digits);
  const sign = rendersAsZero(formatted) ? "" : value < 0 ? "−" : signed ? "+" : "";
  return `${sign}${formatted}`;
}

/** Regular US session, ET wall clock (HH:MM, lexically comparable). */
const SESSION_OPEN_ET = "09:30";
const SESSION_CLOSE_ET = "16:00";

/** The last date strictly before `date` on which the market was open. */
function previousTradingDay(date: string): string {
  let d = addDays(date, -1);
  let guard = 0;
  while (isMarketClosed(d) && guard++ < 14) d = addDays(d, -1);
  return d;
}

/**
 * How current the price shown in the hero is.
 *  - "live":    the price is dated today (ET) and the regular session is open.
 *  - "closed":  the price is the newest one a closed market can have — the
 *               last session's close on a weekend / holiday / before the open,
 *               or today's price after the close.
 *  - "stale":   a session has opened since the price was stored.
 *  - "none":    no price at all.
 *  - "unknown": the clock is not known yet (server render) — claim nothing.
 *
 * Decided ONLY from the price's own date (`prices.date`, a YYYY-MM-DD day —
 * the table carries no time of day) against the ET clock and the shared
 * market calendar. Connection state is deliberately not an input: a price
 * from June is stale whether or not TWS is connected.
 */
export type PriceFreshness = "live" | "closed" | "stale" | "none" | "unknown";

export function priceFreshness(priceDate: string | null, now: Date | null): PriceFreshness {
  if (priceDate == null) return "none";
  if (now == null) return "unknown";
  const today = todayET(now);
  const clock = nowET(now);
  const tradingDay = !isMarketClosed(today);
  // The newest session that has started: today once the bell has rung on a
  // trading day, otherwise the previous trading day.
  const newestSession =
    tradingDay && clock >= SESSION_OPEN_ET ? today : previousTradingDay(today);
  if (priceDate < newestSession) return "stale";
  const sessionOpen = tradingDay && clock >= SESSION_OPEN_ET && clock < SESSION_CLOSE_ET;
  return sessionOpen && priceDate === today ? "live" : "closed";
}

/**
 * Caption under the hero change. The change is the shown price minus the
 * previous STORED price row, so it is "Today" only when the shown price is
 * dated today (ET) — and, when the caller knows the previous row's date, only
 * when that row is the prior session (the prices table has gaps; a three-day
 * move is not today's move). Otherwise it names the comparison.
 */
export function changeCaption(
  priceDate: string | null,
  prevPriceDate: string | null,
  now: Date | null
): string {
  const fallback = prevPriceDate != null ? `vs ${prevPriceDate}` : "vs prior close";
  if (priceDate == null || now == null) return fallback;
  if (priceDate !== todayET(now)) return fallback;
  if (prevPriceDate != null && prevPriceDate !== previousTradingDay(priceDate)) return fallback;
  return "Today";
}

/** Ticking clock, null until mounted so SSR never emits a stale instant. */
function useNow(intervalMs: number): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    // First tick is deferred a task so the effect body itself sets no state.
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

const ET_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const FRESHNESS_LABEL: Record<PriceFreshness, string | null> = {
  live: "live",
  closed: "market closed",
  stale: "stale",
  none: "no price",
  unknown: null,
};

/**
 * Right side of the command strip: a freshness pill driven by the price's
 * own date, the price's as-of date, and the current ET wall clock. The clock
 * is labelled "now" because it is the time of day, NOT the time of the price
 * (the two used to read as one stamp: "as of 2026-06-11 · 06:20:48 ET").
 */
function FreshnessStamp({ priceDate }: { priceDate: string | null }) {
  const now = useNow(1000);
  const state = priceFreshness(priceDate, now);
  const label = FRESHNESS_LABEL[state];
  // Green only while live; amber for a price a session has passed by; the
  // strip's own dim grey otherwise.
  const color = state === "live" ? "#22c55e" : state === "stale" ? "#ffb84d" : "#8a8a8a";
  return (
    <div className="flex items-center gap-2 shrink-0">
      {label && (
        <>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{
              background: color,
              ...(state === "live" && {
                boxShadow: "0 0 6px #22c55e",
                animation: "pulse 1.6s ease-in-out infinite",
              }),
            }}
          />
          <span style={{ color }}>{label}</span>
        </>
      )}
      {priceDate && <span>{label ? "· " : ""}as of {priceDate}</span>}
      {now && <span>· now {ET_CLOCK.format(now)} ET</span>}
    </div>
  );
}

function ChangeCaption({
  priceDate,
  prevPriceDate,
}: {
  priceDate: string | null;
  prevPriceDate: string | null;
}) {
  const now = useNow(60_000);
  return <>{changeCaption(priceDate, prevPriceDate, now)}</>;
}

interface Props {
  securityId: number;
  symbol: string;
  name: string | null;
  typeLabel: string | null;
  currentPrice: number | null;
  priceChange: number | null;
  priceChangePct: number | null;
  priceDate: string | null;
  /**
   * Date of the previous stored price row the change is measured against.
   * Optional: when supplied the caption names it ("vs 2026-06-10") and only
   * says "Today" for a one-session move; without it a stale price reads
   * "vs prior close".
   */
  prevPriceDate?: string | null;
  kpis: SecurityKpis | null;
  /**
   * FX factor for foreign-currency securities (1 for USD). Price + KPI props
   * arrive NATIVE — the chart's price line and the ATR% ratio need native
   * units — so only the $-labeled displays multiply by this at render time.
   */
  usdPerUnit?: number;
  /** Security's native currency (e.g. "KRW"). Passed through to the embedded
   *  SecurityChart, which stays in the native frame and needs this to label
   *  its axis/pill correctly instead of always assuming USD. */
  currency?: string | null;
  /** Raw security_type (not the display typeLabel). Passed through to the
   *  chart + levels panel so their "outside scan range" warnings honour the
   *  scanner's options exemption. */
  securityType?: string | null;
}

/**
 * True when the KPI strip's bar-derived cells (Open / Day Range / Volume /
 * ATR 14 — all sourced from the latest cached ohlcv_bars row) predate the
 * hero price's own as-of date. The bars backfill and the live price feed
 * are independent pipelines; the bars can lag by months while the hero
 * price stays current (2026-08-15 QA repro: HOOD bars 114d stale next to a
 * live quote, hero price sitting ABOVE the strip's own stated day-range
 * high — an internally impossible display with no caption to explain it).
 *
 * Mirrors the week52AsOf freshness arbitration in getKpisForSecurity: plain
 * YYYY-MM-DD string compare, never `new Date()` (timezone-shift hazard).
 * No price as-of to compare against → not stale, so the strip stays
 * uncluttered rather than warning on data we can't actually judge.
 */
export function isBarsStaleVsPrice(
  barsAsOfDate: string,
  priceAsOfDate: string | null
): boolean {
  if (priceAsOfDate == null) return false;
  return barsAsOfDate < priceAsOfDate;
}

/** Compact volume label: 12.3M / 4.7K / 812. */
function formatVolumeValue(v: number | null): { num: number; suffix: string } | null {
  if (v == null) return null;
  if (v >= 1e9) return { num: v / 1e9, suffix: "B" };
  if (v >= 1e6) return { num: v / 1e6, suffix: "M" };
  if (v >= 1e3) return { num: v / 1e3, suffix: "K" };
  return { num: v, suffix: "" };
}

/**
 * Terminal-style "market data" module. Self-contained dark (Bloomberg-adjacent)
 * container holding the live/market content of the Security Detail page:
 * symbol + big price header, chart, and Levels panel.
 *
 * Intentionally scoped to its own near-black canvas (#0a0a0a) so the pattern
 * survives when the surrounding app is flipped to a light/paper palette — the
 * contrast of dark-module-on-light-page is the future design idiom.
 */
export function MarketDataPanel({
  securityId,
  symbol,
  name,
  typeLabel,
  currentPrice,
  priceChange,
  priceChangePct,
  priceDate,
  prevPriceDate = null,
  kpis,
  usdPerUnit = 1,
  currency = null,
  securityType = null,
}: Props) {
  const isUp = priceChange != null && priceChange >= 0;
  const gainColor = isUp ? "#22c55e" : "#ef4444";
  const vol = kpis ? formatVolumeValue(kpis.volume) : null;
  const barsAsOf = kpis?.asOfDate ?? null;
  const barsStale = barsAsOf != null && isBarsStaleVsPrice(barsAsOf, priceDate);
  const barsAsOfCaption = barsStale ? `as of ${barsAsOf}` : undefined;

  return (
    <section
      className="dark-module-chart rounded-2xl overflow-hidden font-mono"
      style={{
        background: "#0a0a0a",
        border: "1px solid #1f1f1f",
        boxShadow: "0 32px 64px -32px rgba(0,0,0,0.6)",
        // Scoped override for the .scroll-fade gradient (globals.css) so the
        // SecurityChart toolbar's scroll fade — rendered inside this dark
        // module — fades to THIS panel's own near-black background instead
        // of the app's light-theme --color-panel (a white smudge). Inherits
        // down through every descendant via normal CSS custom-property
        // inheritance; nothing else needs to opt in.
        "--scroll-fade-color": "#0a0a0a",
      } as CSSProperties}
    >
      {/* Command strip — tiny ticker-tape context line at the very top.
          flex-wrap below md: the right group (live dot + as-of stamp) is
          shrink-0 and ~330px wide, so in a 350px phone strip it squeezed the
          symbol/name group to zero width even with min-w-0 (measured live
          2026-09-02). Wrapping lets the name take the full first line and
          truncate there, with the stamp dropping to a second line; md and up
          stays a single nowrap line. */}
      <div
        className="flex flex-wrap md:flex-nowrap gap-x-3 gap-y-1 items-center justify-between px-5 py-2"
        style={{
          background: "#0d0d0d",
          borderBottom: "1px solid #1f1f1f",
          fontSize: "11px",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          // Dim but AA-passing: #555 measured 2.6:1 on #0d0d0d (needs 4.5).
          color: "#8a8a8a",
        }}
      >
        {/* min-w-0 lets this flex child shrink below its content width (the
            flex default is min-width:auto, which pins it at content size and
            either overflows past the panel's own overflow-hidden edge — a
            mid-word hard clip with no ellipsis — or, when space is too
            tight, collapses to zero). The three parts are wrapped in one
            child span (rather than truncate on the flex container itself)
            because text-overflow:ellipsis only renders on a block-level
            container whose OWN content overflows a line box — a flex
            container's children are flex items, not inline text, so
            ellipsis silently no-ops when applied to the flex row directly.
            The inner pieces are inline text now, so the old gap-3 no longer
            spaces them — ml-3 on each piece keeps the 12px separation. */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="truncate">
            <span style={{ color: "#ffb84d", fontWeight: 600 }}>{symbol}</span>
            {name && <span className="ml-3">· {name}</span>}
            {typeLabel && <span className="ml-3" style={{ color: "#8a8a8a" }}>· {typeLabel}</span>}
          </span>
        </div>
        <FreshnessStamp priceDate={priceDate} />
      </div>

      {/* Hero header: symbol + big price + signed change. Symbol and price
          scale down with the viewport: at a fixed 3rem each, a 6-character
          ticker plus the price overran a 350px phone panel and the section's
          overflow-hidden cut the last digit and the whole change column. */}
      <div
        className="grid gap-3 sm:gap-6 px-6 py-6 items-center"
        style={{
          gridTemplateColumns: "auto 1fr",
          borderBottom: "1px solid #1f1f1f",
        }}
      >
        <div>
          <div
            style={{
              color: "#ffffff",
              fontWeight: 700,
              fontSize: "clamp(1.75rem, 8vw, 3rem)",
              lineHeight: 1,
              letterSpacing: "-0.03em",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {symbol}
          </div>
          {name && (
            <div
              style={{
                color: "#888",
                fontSize: "11px",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                marginTop: "0.4rem",
              }}
            >
              {name}
            </div>
          )}
        </div>

        {currentPrice != null && (
          <div className="flex items-baseline justify-end gap-5 flex-wrap">
            {/* whitespace-nowrap: the "$" and the number are one unit. Without
                it a long name squeezed this block to the number's exact width
                and the "$" wrapped onto a line of its own above the price. */}
            <div
              className="whitespace-nowrap"
              style={{
                color: "#ffb84d",
                fontWeight: 700,
                fontSize: "clamp(2rem, 7vw, 5rem)",
                lineHeight: 1,
                letterSpacing: "-0.02em",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <span
                style={{
                  fontSize: "0.42em",
                  color: "#555",
                  fontWeight: 400,
                  verticalAlign: "top",
                  marginRight: "0.08em",
                  display: "inline-block",
                  paddingTop: "0.15em",
                }}
              >
                $
              </span>
              {formatPublicUSD(currentPrice * usdPerUnit, { bare: true })}
            </div>

            {priceChange != null && priceChangePct != null && (
              <div className="flex flex-col items-end gap-0.5">
                <div
                  style={{
                    color: gainColor,
                    fontWeight: 600,
                    fontSize: "1.4rem",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatPublicUSD(priceChange * usdPerUnit, { signed: true })}
                </div>
                <div
                  style={{
                    color: gainColor,
                    fontSize: "0.95rem",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatPublicPct(priceChangePct, 2, true)}
                </div>
                <div
                  style={{
                    color: "#8a8a8a",
                    fontSize: "10px",
                    letterSpacing: "0.22em",
                    textTransform: "uppercase",
                    marginTop: "0.35rem",
                  }}
                >
                  <ChangeCaption priceDate={priceDate} prevPriceDate={prevPriceDate} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chart — the SecurityChart component already paints its own Terminal
          palette after the color refactor, so it drops in cleanly here. */}
      <div className="h-[460px] md:h-[520px]" style={{ borderBottom: "1px solid #1f1f1f" }}>
        <SecurityChart
          securityId={securityId}
          symbol={symbol}
          currency={currency}
          securityType={securityType}
        />
      </div>

      {/* Quote-strip KPIs — Bloomberg-style row between chart and levels.
          Hidden entirely when no bars exist (options, new watchlist adds). */}
      {kpis && (
        <div
          // Portrait-tablet band only: 5 KpiCells at flex-basis 160px wrap
          // 4+1 (ATR alone on its own row) at iPad-portrait widths. An
          // explicit 3-col grid in that band wraps 3+2 instead; grid ignores
          // each cell's inline flex-basis, so no per-cell change is needed.
          // Untouched at >=1280 (flex-wrap, same as before) and <768 (phone
          // already stacks narrower via the flex-basis shrink).
          className="flex flex-wrap md:max-lg:grid md:max-lg:grid-cols-3"
          style={{ borderBottom: "1px solid #1f1f1f", background: "#0b0b0b" }}
        >
          <KpiCell
            label="Open"
            value={
              kpis.open != null ? (
                <>
                  <span style={{ color: "#555", marginRight: "0.08em" }}>$</span>
                  {formatPublicUSD(kpis.open * usdPerUnit, { bare: true })}
                </>
              ) : (
                "—"
              )
            }
            // Bar-derived, not live — caption when the cached bar predates
            // the hero price's own as-of date (see isBarsStaleVsPrice).
            subvalue={barsAsOfCaption}
          />
          <KpiCell
            label="Day Range"
            value={
              kpis.dayLow != null && kpis.dayHigh != null ? (
                <>
                  {formatPublicUSD(kpis.dayLow * usdPerUnit)} – {formatPublicUSD(kpis.dayHigh * usdPerUnit)}
                </>
              ) : (
                "—"
              )
            }
            subvalue={barsAsOfCaption}
          />
          <KpiCell
            label="52w Range"
            value={
              kpis.week52Low != null && kpis.week52High != null ? (
                <>
                  {formatPublicUSD(kpis.week52Low * usdPerUnit)} – {formatPublicUSD(kpis.week52High * usdPerUnit)}
                </>
              ) : (
                "—"
              )
            }
            // As-of of whichever 52wk source won the freshness arbitration
            // (IBKR quote vs bars) — surfaces staleness instead of letting a
            // back-shifted bars window contradict QuoteStats silently.
            subvalue={
              kpis.week52AsOf != null ? `as of ${kpis.week52AsOf}` : undefined
            }
          />
          <KpiCell
            label="Volume"
            value={
              vol != null ? (
                <>
                  {formatNumber(vol.suffix ? Math.round(vol.num * 10) / 10 : Math.round(vol.num))}
                  {vol.suffix && <span style={{ color: "#8a8a8a" }}>{vol.suffix}</span>}
                </>
              ) : (
                "—"
              )
            }
            subvalue={barsAsOfCaption}
          />
          <KpiCell
            label="ATR 14"
            value={
              kpis.atr14 != null ? (
                <>
                  <span style={{ color: "#555", marginRight: "0.08em" }}>$</span>
                  {formatPublicUSD(kpis.atr14 * usdPerUnit, { bare: true })}
                </>
              ) : (
                "—"
              )
            }
            // When stale, the as-of caption takes priority over the %-of-price
            // subvalue — that ratio itself mixes a stale ATR against the live
            // hero price, the same class of problem this fix addresses.
            subvalue={
              barsStale
                ? barsAsOfCaption
                : kpis.atr14 != null && currentPrice != null && currentPrice > 0
                  ? formatPublicPct((kpis.atr14 / currentPrice) * 100, 2)
                  : undefined
            }
          />
        </div>
      )}

      {/* Levels — rendered embedded so it drops its own chrome and inherits
          the dark Terminal background from this panel. */}
      <LevelsPanel
        securityId={securityId}
        symbol={symbol}
        currentPrice={currentPrice}
        embedded
        currency={currency}
        securityType={securityType}
      />

      {/* Local keyframes — scoped to this panel via no `:global` */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.4; }
        }
      `}</style>
    </section>
  );
}
