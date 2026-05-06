"use client";

import { useEffect, useState } from "react";
import type { LevelAlert, AlertResponse } from "@/lib/types";
import { Money } from "@/lib/privacy/components";
import { Section } from "./Section";
import { Chip, type ChipTone } from "./Chip";

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

const RESPONSE_TONE: Record<AlertResponse, { label: string; tone: ChipTone }> = {
  pending: { label: "Pending", tone: "gold" },
  acted: { label: "Acted", tone: "up" },
  ignored: { label: "Ignored", tone: "neutral" },
  dismissed: { label: "Dismissed", tone: "neutral" },
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
    <Section
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
          const resp = RESPONSE_TONE[a.user_response];
          return (
            <div
              key={a.id}
              className={`px-5 py-3 flex items-baseline gap-3.5 text-sm ${idx === 0 ? "" : "border-t border-edge"}`}
            >
              <span
                className="font-mono text-ink-faint flex-shrink-0"
                style={{ fontSize: "12px", letterSpacing: "0.08em", width: "100px" }}
              >
                {when}
              </span>
              <span className="flex-1 min-w-0 flex items-baseline gap-2.5 flex-wrap">
                {a.level && (
                  <>
                    <span
                      className="font-mono uppercase text-ink-dim"
                      style={{ fontSize: "11px", letterSpacing: "0.18em" }}
                    >
                      {a.level.level_type.replace("_", " ")}
                    </span>
                    <span className="font-mono text-ink tabular-nums">
                      @ <Money value={a.level.price} precise />
                    </span>
                    {a.level.price_source && a.level.price_source !== "static" && (
                      <Chip tone="neutral" size="xs" uppercase>
                        {formatPriceSourceLabel(a.level.price_source)}
                      </Chip>
                    )}
                  </>
                )}
                <span className="font-mono text-ink-dim tabular-nums">
                  hit <Money value={a.triggered_price} precise />
                </span>
                {a.level?.source_author && (
                  <span className="text-ink-faint">— {a.level.source_author}</span>
                )}
              </span>
              <span className="flex-shrink-0">
                <Chip tone={resp.tone} size="xs" uppercase>{resp.label}</Chip>
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
