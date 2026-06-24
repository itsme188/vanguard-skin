"use client";

import { useState, useEffect, type ReactNode } from "react";
import type { FactorAnalysisResult, FactorTilt } from "@/lib/compute/factors";
import { Pct } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import {
  DEFAULT_BENCHMARK_BY_SCOPE,
  BENCHMARK_OPTIONS,
} from "@/lib/analysis/benchmarks";
import { NarrativeBlock } from "./analysis/NarrativeBlock";
import { DrillDownPanel } from "./analysis/DrillDownPanel";
import { WeekOverWeekBadge } from "./analysis/WeekOverWeekBadge";
import {
  interpretBeta,
  interpretAlpha,
  interpretR2,
  interpretTrackingError,
} from "@/lib/analysis/interpret";
import type { DrillDownFilter } from "@/lib/queries/drill-down";

// ─── W-o-W delta shape (mirrors computeFactorDelta in the API route) ─────

interface FactorDelta {
  marketRegression: {
    beta: number | null;
    alpha: number | null;
    rSquared: number | null;
  };
}

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
  const [delta, setDelta] = useState<FactorDelta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<string>(
    DEFAULT_BENCHMARK_BY_SCOPE[scope ?? "all"] ?? "SPY",
  );
  const [drillFilter, setDrillFilter] = useState<DrillDownFilter | null>(null);

  // Reset benchmark to scope default when scope flips
  useEffect(() => {
    setBenchmark(DEFAULT_BENCHMARK_BY_SCOPE[scope ?? "all"] ?? "SPY");
  }, [scope]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (scope && scope !== "all") params.set("scope", scope);
    params.set("benchmark", benchmark);
    fetch(`/api/compute/factors?${params.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setData(json.data);
          setDelta(json.delta ?? null);
        } else {
          setError(json.error ?? "Failed to compute factors");
        }
      })
      .catch(() => setError("Failed to fetch factor analysis"))
      .finally(() => setLoading(false));
  }, [scope, benchmark]);

  if (loading) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Quantitative Factor Analysis</h3>
        <div className="text-sm text-ink-faint animate-pulse">Computing factor exposures...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Quantitative Factor Analysis</h3>
        <div className="text-sm text-ink-faint">{error ?? "No data available"}</div>
      </div>
    );
  }

  const reg = data.marketRegression;
  const hasTilts = data.sizeTilt || data.styleTilt || data.sectorTilt || data.geographyTilt;

  if (!reg && !hasTilts) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Quantitative Factor Analysis</h3>
        <div className="text-sm text-ink-faint">
          Insufficient data. Sync benchmark prices and classify securities to see factor analysis.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Quantitative Factor Analysis</h3>
        <label className="flex items-center gap-2 text-[11px] text-ink-faint uppercase tracking-widest">
          Benchmark
          <select
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
            className="bg-panel border border-edge rounded px-2 py-1 text-[12px] text-ink font-mono uppercase tracking-normal"
          >
            {BENCHMARK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <NarrativeBlock scope={scope ?? "all"} surfaceKey="factor-analysis" />

      {/* ── Market regression ── */}
      {reg && (
        <div>
          <h4 className="text-xs text-ink-faint uppercase tracking-widest mb-3">
            Market Regression (vs {benchmark})
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <MetricCell
              label="Beta"
              value={
                <>
                  {formatBeta(reg.beta)}
                  <WeekOverWeekBadge
                    value={delta?.marketRegression.beta ?? null}
                    kind="neutral"
                    digits={2}
                  />
                </>
              }
              hint={interpretBeta(reg.beta, benchmark).text}
              color={reg.beta > 1 ? "amber" : reg.beta > 0.7 ? "neutral" : "blue"}
            />
            <MetricCell
              label="Alpha"
              value={
                <>
                  <Pct value={reg.alpha * 100} digits={2} signed />
                  <WeekOverWeekBadge
                    value={delta?.marketRegression.alpha ?? null}
                    kind="signed"
                    digits={2}
                    asPercent
                  />
                </>
              }
              hint={interpretAlpha(reg.alpha).text}
              color={reg.alpha >= 0 ? "up" : "down"}
            />
            <MetricCell
              label="R²"
              value={
                <>
                  <Pct value={reg.rSquared * 100} digits={1} />
                  <WeekOverWeekBadge
                    value={delta?.marketRegression.rSquared ?? null}
                    kind="neutral"
                    digits={1}
                    asPercent
                  />
                </>
              }
              hint={interpretR2(reg.rSquared).text}
              color="neutral"
            />
            <MetricCell
              label="Tracking Error"
              value={<Pct value={reg.trackingError * 100} digits={2} signed />}
              hint={interpretTrackingError(reg.trackingError).text}
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
            {data.sectorTilt && (
              <TiltBar
                tilt={data.sectorTilt}
                onBucketClick={(label) => {
                  // "Other" rollups don't map to a single sector — skip.
                  if (!label || label === "Other") return;
                  setDrillFilter({ kind: "sector", sector: label });
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* P3 Slice C — sector tilt bucket click opens drill-down */}
      <DrillDownPanel
        open={drillFilter !== null}
        onClose={() => setDrillFilter(null)}
        scope={scope ?? "all"}
        filter={drillFilter}
      />
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

function TiltBar({
  tilt,
  onBucketClick,
}: {
  tilt: FactorTilt;
  /**
   * P3 Slice C — caller wires this to open the DrillDownPanel filtered to the
   * clicked bucket. Currently only the sector tilt is drillable (the drill-down
   * query only supports `sector`); other tilts pass no callback and remain
   * static.
   */
  onBucketClick?: (label: string) => void;
}) {
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
        {display.map((bucket, i) => {
          const drillable = !!onBucketClick && bucket.label !== "Other";
          return (
            <div
              key={bucket.label}
              className={`h-full transition-[width,opacity] ${drillable ? "cursor-pointer hover:opacity-80" : ""}`}
              style={{
                width: `${bucket.weight * 100}%`,
                backgroundColor: TILT_COLORS[i % TILT_COLORS.length],
              }}
              title={
                isPrivate
                  ? `${bucket.label}: •••`
                  : `${bucket.label}: ${(bucket.weight * 100).toFixed(1)}%`
              }
              onClick={drillable ? () => onBucketClick!(bucket.label) : undefined}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {display.map((bucket, i) => {
          const drillable = !!onBucketClick && bucket.label !== "Other";
          return (
            <span
              key={bucket.label}
              className={`flex items-center gap-1 text-[10px] text-ink-faint ${drillable ? "cursor-pointer hover:text-ink-dim" : ""}`}
              onClick={drillable ? () => onBucketClick!(bucket.label) : undefined}
            >
              <span
                className="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: TILT_COLORS[i % TILT_COLORS.length] }}
              />
              {bucket.label}
              <Pct value={bucket.weight * 100} digits={0} className="font-mono text-ink-dim" />
            </span>
          );
        })}
      </div>
    </div>
  );
}
