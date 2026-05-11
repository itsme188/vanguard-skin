"use client";

import { useEffect, useState } from "react";
import { MacroThemeReceiptDrawer } from "./MacroThemeReceiptDrawer";

interface MacroTheme {
  name: string;
  factor_label: string;
  direction: "risk-on" | "risk-off" | "neutral";
  summary: string;
  exposure_bucket: "low" | "moderate" | "high" | "very-high";
  top_contributors: Array<{ symbol: string; weight: number }>;
}

interface ApiResponse {
  success: boolean;
  themes?: MacroTheme[];
  sourceSummary?: {
    articles: Array<{ id: number; title: string }>;
    events: Array<{ id: number; symbol: string | null; event_date: string }>;
    alerts: Array<{ id: number; symbol: string }>;
  } | null;
  underThreshold?: boolean;
  generatedAt?: string;
  fromCache?: boolean;
  error?: string;
}

const FACTOR_LABELS: Record<string, string> = {
  interest_rate_sensitive: "Rate-sensitive",
  growth_vs_value: "Growth vs value",
  cyclical: "Cyclicality",
  international_exposure: "International",
  geopolitical_onshoring: "Onshoring",
  tariff_exposure: "Tariff",
  ai_exposure: "AI",
  crypto_adjacent: "Crypto-adjacent",
  regulatory_risk: "Regulatory",
};

function directionColor(d: MacroTheme["direction"]) {
  if (d === "risk-on") return "var(--up, #10b981)";
  if (d === "risk-off") return "var(--down, #ef4444)";
  return "var(--ink-faint, #94a3b8)";
}

function exposurePillClass(b: MacroTheme["exposure_bucket"]) {
  switch (b) {
    case "very-high":
      return "bg-amber/30 text-amber border-amber/40";
    case "high":
      return "bg-amber/20 text-amber border-amber/30";
    case "moderate":
      return "bg-edge/40 text-ink-dim border-edge";
    case "low":
      return "bg-edge/20 text-ink-faint border-edge/40";
  }
}

export function MacroOverlayCard({ scope }: { scope: string }) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpenForThemeIdx, setDrawerOpenForThemeIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/analysis/macro-themes?scope=${encodeURIComponent(scope)}`)
      .then((r) => r.json())
      .then((j: ApiResponse) => {
        if (!cancelled) setData(j);
      })
      .catch(() => {
        if (!cancelled) setData({ success: false, error: "network error" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink">Macro this week</h3>
          <p className="text-xs text-ink-faint mt-0.5">
            AI-distilled themes from research feeds + macro releases
            <span className="ml-2 italic">· {scope}</span>
          </p>
        </div>
        {data?.generatedAt && (
          <span className="text-[10px] text-ink-faint uppercase tracking-wider">
            {data.fromCache ? "cached" : "fresh"}
          </span>
        )}
      </header>

      {loading && (
        <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
          <p className="text-xs text-ink-faint">Loading…</p>
        </div>
      )}

      {!loading && data?.underThreshold && (
        <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
          <p className="text-xs text-ink-faint">
            No actionable themes this week — insufficient signal.
          </p>
        </div>
      )}

      {!loading && data?.themes && data.themes.length > 0 && (
        <ul className="space-y-2">
          {data.themes.map((t, i) => (
            <li key={i} className="rounded-lg border border-edge/60 bg-canvas px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full mt-1.5 shrink-0"
                  style={{ backgroundColor: directionColor(t.direction) }}
                />
                <h4 className="text-sm font-medium text-ink flex-1">{t.name}</h4>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded border ${exposurePillClass(t.exposure_bucket)} uppercase tracking-wide`}
                >
                  your exposure: {t.exposure_bucket}
                </span>
              </div>
              <p className="text-xs text-ink-dim mt-1 ml-4">{t.summary}</p>
              <div className="mt-2 ml-4 flex items-center gap-3 text-[11px]">
                <span className="text-ink-faint">
                  factor: {FACTOR_LABELS[t.factor_label] ?? t.factor_label}
                </span>
                {t.top_contributors.length > 0 && (
                  <span className="text-ink-faint">
                    top: {t.top_contributors.map((c) => c.symbol).join(", ")}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setDrawerOpenForThemeIdx(i)}
                  className="ml-auto text-amber hover:text-amber/80 transition-colors"
                >
                  View sources →
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!loading && data && !data.success && !data.underThreshold && (
        <div className="rounded-lg border border-down/40 bg-canvas px-3 py-3 text-center">
          <p className="text-xs text-down">{data.error ?? "Failed to load macro themes"}</p>
        </div>
      )}

      {drawerOpenForThemeIdx !== null && data?.sourceSummary && data.themes && (
        <MacroThemeReceiptDrawer
          theme={data.themes[drawerOpenForThemeIdx]}
          sourceSummary={data.sourceSummary}
          onClose={() => setDrawerOpenForThemeIdx(null)}
        />
      )}
    </section>
  );
}
