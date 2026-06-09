"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../Toast";
import { MetricCard } from "./MetricCard";
import { Pct, PrivateText, usePrivateFormatter } from "@/lib/privacy/components";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import type { ConcentrationMetrics, ClassificationCoverage } from "@/lib/queries/analysis";

interface Props {
  concentration: ConcentrationMetrics;
  coverage: ClassificationCoverage;
}

export function ClassificationCard({ concentration, coverage }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [showCoverage, setShowCoverage] = useState(false);
  const [classifyLoading, setClassifyLoading] = useState(false);
  const pctTickFormatter = usePrivateFormatter((v: number) => `${v.toFixed(0)}%`);
  const pctTooltipFormatter = usePrivateFormatter(
    (v: number | string | undefined) => `${Number(v).toFixed(1)}%`,
  );

  async function runAutoClassify() {
    setClassifyLoading(true);
    try {
      const res = await fetch("/api/compute/classify", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        if (data.classified === 0 && !data.unresolvedCount) {
          // Explain the no-op — "Classified 0" with no why reads as a broken button.
          toast(`Nothing to classify — all ${data.skipped} held securities already have sector/fund classifications.`, "info");
        } else {
          const parts = [`Classified ${data.classified}`, `${data.skipped} already done`];
          if (data.unresolvedCount > 0) parts.push(`${data.unresolvedCount} couldn't be auto-classified`);
          toast(parts.join(" · "), data.unresolvedCount > 0 ? "info" : "success");
        }
        router.refresh();
      } else {
        toast(`Classification failed: ${data.error}`, "error");
      }
    } catch {
      toast("Failed to connect to server", "error");
    } finally {
      setClassifyLoading(false);
    }
  }

  return (
    <>
      <div className="bg-panel border border-edge rounded-lg p-4">
        <h3 className="text-sm font-medium text-ink mb-4">Concentration Metrics</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <MetricCard
            label="Herfindahl Index (HHI)"
            value={concentration.hhi.toFixed(4)}
            description={
              concentration.hhi > 0.25
                ? "Highly concentrated"
                : concentration.hhi > 0.15
                ? "Moderately concentrated"
                : concentration.hhi > 0.06
                ? "Moderately diversified"
                : "Well diversified"
            }
            color={
              concentration.hhi > 0.25
                ? "text-down"
                : concentration.hhi > 0.15
                ? "text-gold"
                : "text-up"
            }
          />
          <MetricCard
            label="Effective Positions"
            value={concentration.effective_positions.toFixed(1)}
            description="1/HHI — equivalent equal-weighted positions"
            color="text-blue"
          />
          <MetricCard
            label="Classification Coverage"
            value={`${coverage.coverage_pct}%`}
            description={`${coverage.classified} of ${coverage.total} securities classified`}
            color={coverage.coverage_pct > 90 ? "text-up" : coverage.coverage_pct > 70 ? "text-gold" : "text-down"}
          />
        </div>

        {concentration.top_positions.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-ink-faint uppercase mb-2">Top 10 Positions</h4>
            <ResponsiveContainer width="100%" height={Math.max(200, concentration.top_positions.length * 24)}>
              <BarChart
                data={concentration.top_positions}
                layout="vertical"
                margin={{ top: 8, left: 60, right: 20, bottom: 4 }}
              >
                <XAxis type="number" tickFormatter={pctTickFormatter} tick={{ fill: "var(--color-ink-faint)", fontSize: 11 }} />
                <YAxis type="category" dataKey="symbol" tick={{ fill: "var(--color-ink-dim)", fontSize: 11 }} width={70} interval={0} />
                <Tooltip
                  formatter={(value: number | string | undefined) => [pctTooltipFormatter(value), "Weight"]}
                  contentStyle={{
                    backgroundColor: "var(--color-panel)",
                    border: "1px solid var(--color-edge)",
                    borderRadius: "8px",
                    color: "var(--color-ink)",
                  }}
                  itemStyle={{ color: "var(--color-ink)" }}
                />
                <Bar dataKey="weight_pct" fill="#C9A44E" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {concentration.warnings.length > 0 && (
          <div className="mt-4 space-y-1">
            {concentration.warnings.slice(0, 8).map((w, i) => (
              <p key={i} className="text-xs text-gold">
                {/\d/.test(w) ? <PrivateText>{w}</PrivateText> : w}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="bg-panel border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Classification</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={runAutoClassify}
              disabled={classifyLoading}
              className="px-3 py-1 text-xs bg-gold/10 text-gold border border-gold/30 rounded hover:bg-gold/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
            >
              {classifyLoading ? "Classifying..." : "Auto-Classify"}
            </button>
            <button
              onClick={() => setShowCoverage(!showCoverage)}
              className="px-3 py-1 text-xs bg-panel text-ink-faint border border-edge rounded hover:text-ink-dim transition-colors"
            >
              {showCoverage ? "Hide Details" : "Show Details"}
            </button>
          </div>
        </div>

        <div className="flex gap-4 mt-3">
          {coverage.by_source.map((s) => (
            <span key={s.source} className="text-xs text-ink-faint">
              <span className="text-ink-dim font-mono">{s.count}</span>{" "}
              {s.source}
            </span>
          ))}
        </div>

        {showCoverage && coverage.unclassified_securities.length > 0 && (
          <div className="mt-4">
            <h4 className="text-xs font-medium text-ink-faint uppercase mb-2">
              Unclassified Securities ({coverage.unclassified_securities.length})
            </h4>
            <div className="max-h-60 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-edge text-ink-faint">
                    <th className="text-left py-1 pr-2">Symbol</th>
                    <th className="text-left py-1 pr-2">Name</th>
                    <th className="text-left py-1">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.unclassified_securities.map((s) => (
                    <tr key={s.id} className="border-b border-edge/30">
                      <td className="py-1 pr-2 font-mono text-ink">{s.symbol}</td>
                      <td className="py-1 pr-2 text-ink-faint truncate max-w-xs">{s.name ?? "—"}</td>
                      <td className="py-1 text-ink-faint">{s.security_type ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
