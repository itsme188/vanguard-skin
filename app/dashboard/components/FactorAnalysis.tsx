"use client";

import { useState, useEffect, type ReactNode } from "react";
import type { FactorAnalysisResult, FactorTilt } from "@/lib/compute/factors";
import { Pct } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";

// ─── Formatters ──────────────────────────────────────────────────

function formatPct(value: number, decimals = 1): string {
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(decimals)}%`;
}

function formatBeta(value: number): string {
  return value.toFixed(2);
}

// ─── Tilt bar colors ─────────────────────────────────────────────

const TILT_COLORS = [
  "#C9A44E", "#60A5FA", "#34D399", "#F87171", "#A78BFA",
  "#FBBF24", "#2DD4BF", "#FB923C", "#818CF8", "#E879F9",
  "#94A3B8",
];

// ─── Component ───────────────────────────────────────────────────

export function FactorAnalysisCard({ scope }: { scope?: string }) {
  const [data, setData] = useState<FactorAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const params = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/compute/factors${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setData(json.data);
        else setError(json.error ?? "Failed to compute factors");
      })
      .catch(() => setError("Failed to fetch factor analysis"))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) {
    return (
      <div className="bg-raised border border-edge rounded-2xl p-6">
        <h3 className="text-sm font-medium text-ink mb-4">Quantitative Factor Analysis</h3>
        <div className="text-sm text-ink-faint animate-pulse">Computing factor exposures...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-raised border border-edge rounded-2xl p-6">
        <h3 className="text-sm font-medium text-ink mb-4">Quantitative Factor Analysis</h3>
        <div className="text-sm text-ink-faint">{error ?? "No data available"}</div>
      </div>
    );
  }

  const reg = data.marketRegression;
  const hasTilts = data.sizeTilt || data.styleTilt || data.sectorTilt || data.geographyTilt;

  if (!reg && !hasTilts) {
    return (
      <div className="bg-raised border border-edge rounded-2xl p-6">
        <h3 className="text-sm font-medium text-ink mb-4">Quantitative Factor Analysis</h3>
        <div className="text-sm text-ink-faint">
          Insufficient data. Sync benchmark prices and classify securities to see factor analysis.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-raised border border-edge rounded-2xl p-6 space-y-6">
      <h3 className="text-sm font-medium text-ink">Quantitative Factor Analysis</h3>

      {/* ── Market regression ── */}
      {reg && (
        <div>
          <h4 className="text-xs text-ink-faint uppercase tracking-widest mb-3">
            Market Regression (vs SPY)
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <MetricCell
              label="Beta"
              value={formatBeta(reg.beta)}
              hint={
                reg.beta > 1.1
                  ? "Aggressive"
                  : reg.beta > 0.9
                    ? "Market-like"
                    : reg.beta > 0.5
                      ? "Defensive"
                      : "Low sensitivity"
              }
              color={reg.beta > 1 ? "amber" : reg.beta > 0.7 ? "neutral" : "blue"}
            />
            <MetricCell
              label="Alpha"
              value={<Pct value={reg.alpha * 100} digits={2} signed />}
              hint="Annualized excess return"
              color={reg.alpha >= 0 ? "up" : "down"}
            />
            <MetricCell
              label="R²"
              value={<Pct value={reg.rSquared * 100} digits={1} />}
              hint={
                reg.rSquared > 0.8
                  ? "High market dependence"
                  : reg.rSquared > 0.5
                    ? "Moderate dependence"
                    : "Low market dependence"
              }
              color="neutral"
            />
            <MetricCell
              label="Tracking Error"
              value={<Pct value={reg.trackingError * 100} digits={2} signed />}
              hint="Annualized active risk"
              color="neutral"
            />
            <MetricCell
              label="Correlation"
              value={reg.correlation.toFixed(2)}
              hint={`${reg.dataPoints} daily observations`}
              color="neutral"
            />
          </div>
        </div>
      )}

      {/* ── Factor tilts ── */}
      {hasTilts && (
        <div>
          <h4 className="text-xs text-ink-faint uppercase tracking-widest mb-3">
            Portfolio Tilts
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.sizeTilt && <TiltBar tilt={data.sizeTilt} />}
            {data.styleTilt && <TiltBar tilt={data.styleTilt} />}
            {data.geographyTilt && <TiltBar tilt={data.geographyTilt} />}
            {data.sectorTilt && <TiltBar tilt={data.sectorTilt} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function MetricCell({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: ReactNode;
  hint: string;
  color: "up" | "down" | "neutral" | "amber" | "blue";
}) {
  const colorClass =
    color === "up"
      ? "text-up"
      : color === "down"
        ? "text-down"
        : color === "amber"
          ? "text-amber-400"
          : color === "blue"
            ? "text-blue-400"
            : "text-ink";

  return (
    <div className="bg-panel border border-edge rounded-lg px-3 py-2.5">
      <div className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`text-lg font-mono tabular-nums font-semibold ${colorClass}`}>
        {value}
      </div>
      <div className="text-[10px] text-ink-faint mt-0.5">{hint}</div>
    </div>
  );
}

function TiltBar({ tilt }: { tilt: FactorTilt }) {
  // Filter out tiny allocations for cleaner display
  const significant = tilt.buckets.filter((b) => b.weight >= 0.01);
  const other = tilt.buckets
    .filter((b) => b.weight < 0.01)
    .reduce((s, b) => s + b.weight, 0);

  const display =
    other > 0.005
      ? [...significant, { label: "Other", weight: other }]
      : significant;

  const { isPrivate } = usePrivacy();

  return (
    <div>
      <div className="text-xs font-medium text-ink mb-1.5">{tilt.dimension}</div>

      {/* Stacked bar */}
      <div className="flex h-3 rounded-full overflow-hidden bg-edge mb-1.5">
        {display.map((bucket, i) => (
          <div
            key={bucket.label}
            className="h-full transition-all"
            style={{
              width: `${bucket.weight * 100}%`,
              backgroundColor: TILT_COLORS[i % TILT_COLORS.length],
            }}
            title={
              isPrivate
                ? `${bucket.label}: •••`
                : `${bucket.label}: ${(bucket.weight * 100).toFixed(1)}%`
            }
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {display.map((bucket, i) => (
          <span key={bucket.label} className="flex items-center gap-1 text-[10px] text-ink-faint">
            <span
              className="w-2 h-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: TILT_COLORS[i % TILT_COLORS.length] }}
            />
            {bucket.label}
            <Pct value={bucket.weight * 100} digits={0} className="font-mono text-ink-dim" />
          </span>
        ))}
      </div>
    </div>
  );
}
