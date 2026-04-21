"use client";

import { useEffect, useState } from "react";
import type { LevelAlert, AlertResponse } from "@/lib/types";
import { Money } from "@/lib/privacy/components";

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

const RESPONSE_STYLES: Record<AlertResponse, { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-gold" },
  acted: { label: "Acted", className: "text-emerald-400" },
  ignored: { label: "Ignored", className: "text-ink-faint" },
  dismissed: { label: "Dismissed", className: "text-ink-faint" },
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
    <section className="rounded-xl border border-edge bg-panel p-5">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-ink">Recent alerts</h2>
        <p className="text-[11px] text-ink-faint mt-0.5">
          Last {alerts.length} level crossing{alerts.length === 1 ? "" : "s"} on this security. Use
          past responses as context for current levels.
        </p>
      </div>
      <ul className="divide-y divide-edge">
        {alerts.map((a) => {
          const when = new Date(a.triggered_at).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          const respStyle = RESPONSE_STYLES[a.user_response];
          return (
            <li key={a.id} className="py-2 flex items-baseline gap-3 text-[11px]">
              <span className="text-ink-faint w-20 shrink-0 font-mono">{when}</span>
              <span className="flex-1 min-w-0 flex items-baseline gap-2 flex-wrap">
                {a.level && (
                  <>
                    <span className="text-ink-dim uppercase">
                      {a.level.level_type.replace("_", " ")}
                    </span>
                    <span className="text-ink font-mono">
                      @ <Money value={a.level.price} precise />
                    </span>
                    {a.level.price_source && a.level.price_source !== "static" && (
                      <span className="px-1 py-0.5 rounded text-[9px] bg-raised text-ink-faint uppercase tracking-wider">
                        {formatPriceSourceLabel(a.level.price_source)}
                      </span>
                    )}
                  </>
                )}
                <span className="text-ink-faint">hit <Money value={a.triggered_price} precise /></span>
                {a.level?.source_author && (
                  <span className="text-ink-faint italic">— {a.level.source_author}</span>
                )}
              </span>
              <span className={`shrink-0 ${respStyle.className}`}>{respStyle.label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
