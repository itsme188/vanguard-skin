"use client";

import { useEffect, useState } from "react";
import type { LevelAlert, AlertResponse } from "@/lib/types";
import { Money } from "@/lib/privacy/components";
import { TerminalSection } from "./TerminalSection";

// Same enriched shape that /api/alerts returns (matches alerts page type).
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

const RESPONSE_STYLES: Record<AlertResponse, { label: string; color: string }> = {
  pending: { label: "Pending", color: "#ffb84d" },
  acted: { label: "Acted", color: "#22c55e" },
  ignored: { label: "Ignored", color: "#666" },
  dismissed: { label: "Dismissed", color: "#666" },
};

function formatPriceSourceLabel(source: string): string {
  const m = /^(sma|ema)_(\d+)$/.exec(source);
  if (!m) return source;
  return `${m[1].toUpperCase()} ${m[2]}`;
}

/**
 * Per-security alerts history. Renders below LevelsPanel on the Security
 * Detail page so the user sees how past level crossings played out —
 * provides context when deciding whether a current level is worth taking
 * seriously (e.g., "the Eliant support line was acted on 4/5 times").
 */
export function RecentAlertsPanel({ securityId }: { securityId: number }) {
  const [alerts, setAlerts] = useState<EnrichedAlert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/alerts?securityId=${securityId}&limit=10`);
        const json = await res.json();
        if (!cancelled && json.success) {
          setAlerts(json.alerts);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [securityId]);

  if (loading) return null; // Don't show skeleton — keep page quiet.
  if (alerts.length === 0) return null; // Hide the section entirely when there's no history.

  return (
    <TerminalSection
      title="Recent Alerts"
      subtitle={`Last ${alerts.length} level crossing${alerts.length === 1 ? "" : "s"} · past responses as context`}
    >
      <div>
        {alerts.map((a, idx) => {
          const when = new Date(a.triggered_at).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          const respStyle = RESPONSE_STYLES[a.user_response];
          return (
            <div
              key={a.id}
              style={{
                padding: "12px 20px",
                borderTop: idx === 0 ? undefined : "1px solid #161616",
                display: "flex",
                alignItems: "baseline",
                gap: "14px",
                fontFamily: "Geist, system-ui, sans-serif",
                fontSize: "14px",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "12px", color: "#666", width: "100px", flexShrink: 0, letterSpacing: "0.08em" }}>
                {when}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
                {a.level && (
                  <>
                    <span style={{ color: "#bbb", fontFamily: "var(--font-mono), monospace", fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase" }}>
                      {a.level.level_type.replace("_", " ")}
                    </span>
                    <span style={{ color: "#ddd", fontFamily: "var(--font-mono), monospace", fontVariantNumeric: "tabular-nums" }}>
                      @ <Money value={a.level.price} precise />
                    </span>
                    {a.level.price_source && a.level.price_source !== "static" && (
                      <span
                        style={{
                          fontFamily: "var(--font-mono), monospace",
                          fontSize: "10px",
                          letterSpacing: "0.2em",
                          textTransform: "uppercase",
                          color: "#888",
                          border: "1px solid #333",
                          padding: "2px 5px",
                          borderRadius: "2px",
                        }}
                      >
                        {formatPriceSourceLabel(a.level.price_source)}
                      </span>
                    )}
                  </>
                )}
                <span style={{ color: "#888", fontFamily: "var(--font-mono), monospace", fontVariantNumeric: "tabular-nums" }}>
                  hit <Money value={a.triggered_price} precise />
                </span>
                {a.level?.source_author && (
                  <span style={{ color: "#666", fontSize: "13px" }}>— {a.level.source_author}</span>
                )}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  color: respStyle.color,
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "11px",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                {respStyle.label}
              </span>
            </div>
          );
        })}
      </div>
    </TerminalSection>
  );
}
