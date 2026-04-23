"use client";

import { useEffect, useState } from "react";
import { SecurityChart } from "./SecurityChart";
import { LevelsPanel } from "./LevelsPanel";
import { Money, Pct } from "@/lib/privacy/components";

/**
 * Live clock — conveys "this panel is streaming, not static." Updates every
 * second, shows HH:MM:SS local. Rendered client-side only so SSR doesn't emit
 * stale time text.
 */
function LiveClock() {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => {
    setT(new Date());
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!t) return null;
  const hh = t.getHours().toString().padStart(2, "0");
  const mm = t.getMinutes().toString().padStart(2, "0");
  const ss = t.getSeconds().toString().padStart(2, "0");
  return <span>{hh}:{mm}:{ss} ET</span>;
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
}: Props) {
  const isUp = priceChange != null && priceChange >= 0;
  const gainColor = isUp ? "#22c55e" : "#ef4444";

  return (
    <section
      className="rounded-2xl overflow-hidden font-mono"
      style={{
        background: "#0a0a0a",
        border: "1px solid #1f1f1f",
        boxShadow: "0 32px 64px -32px rgba(0,0,0,0.6)",
      }}
    >
      {/* Command strip — tiny ticker-tape context line at the very top */}
      <div
        className="flex items-center justify-between px-5 py-2"
        style={{
          background: "#0d0d0d",
          borderBottom: "1px solid #1f1f1f",
          fontSize: "11px",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#555",
        }}
      >
        <div className="flex items-center gap-3 truncate">
          <span style={{ color: "#ffb84d", fontWeight: 600 }}>{symbol}</span>
          {name && <span>· {name}</span>}
          {typeLabel && <span style={{ color: "#777" }}>· {typeLabel}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{
              background: "#22c55e",
              boxShadow: "0 0 6px #22c55e",
              animation: "pulse 1.6s ease-in-out infinite",
            }}
          />
          <span style={{ color: "#22c55e" }}>live</span>
          {priceDate && <span>· as of {priceDate}</span>}
          <span>· <LiveClock /></span>
        </div>
      </div>

      {/* Hero header: symbol + big price + signed change */}
      <div
        className="grid gap-6 px-6 py-6 items-center"
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
              fontSize: "3rem",
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
            <div
              style={{
                color: "#ffb84d",
                fontWeight: 700,
                fontSize: "clamp(3rem, 7vw, 5rem)",
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
              <Money value={currentPrice} precise />
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
                  <Money value={priceChange} precise signed />
                </div>
                <div
                  style={{
                    color: gainColor,
                    fontSize: "0.95rem",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <Pct value={priceChangePct} digits={2} signed />
                </div>
                <div
                  style={{
                    color: "#555",
                    fontSize: "10px",
                    letterSpacing: "0.22em",
                    textTransform: "uppercase",
                    marginTop: "0.35rem",
                  }}
                >
                  Today
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chart — the SecurityChart component already paints its own Terminal
          palette after the color refactor, so it drops in cleanly here. */}
      <div className="h-[460px] md:h-[520px]" style={{ borderBottom: "1px solid #1f1f1f" }}>
        <SecurityChart securityId={securityId} symbol={symbol} />
      </div>

      {/* Levels — rendered embedded so it drops its own chrome and inherits
          the dark Terminal background from this panel. */}
      <LevelsPanel
        securityId={securityId}
        symbol={symbol}
        currentPrice={currentPrice}
        embedded
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
