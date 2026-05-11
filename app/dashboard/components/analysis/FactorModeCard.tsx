"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../Toast";
import { FactorHeatmap } from "../FactorHeatmap";
import { NarrativeBlock } from "./NarrativeBlock";
import { DrillDownPanel } from "./DrillDownPanel";
import type { FactorHeatmapRow, FactorCoverage } from "@/lib/queries/analysis";
import type { DrillDownFilter } from "@/lib/queries/drill-down";

interface Props {
  factorHeatmap?: FactorHeatmapRow[];
  factorCoverage?: FactorCoverage;
  scope?: string;
}

export function FactorModeCard({ factorHeatmap, factorCoverage, scope }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [factorClassifyLoading, setFactorClassifyLoading] = useState(false);
  const [drillFilter, setDrillFilter] = useState<DrillDownFilter | null>(null);

  async function runFactorAutoClassify() {
    setFactorClassifyLoading(true);
    try {
      const res = await fetch("/api/compute/classify-factors", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(
          `Classified ${data.classified} securities` +
            (data.skipped > 0 ? ` (${data.skipped} skipped)` : "") +
            (data.errors?.length > 0 ? ` · ${data.errors.length} errors` : ""),
          "success"
        );
        router.refresh();
      } else {
        toast(`Factor classification failed: ${data.error}`, "error");
      }
    } catch {
      toast("Failed to connect to server", "error");
    } finally {
      setFactorClassifyLoading(false);
    }
  }

  return (
    <>
      <NarrativeBlock scope={scope ?? "all"} surfaceKey="factor-heatmap" />
      {factorHeatmap && (
        <FactorHeatmap
          rows={factorHeatmap}
          onCellClick={(factor, bucket) =>
            setDrillFilter({ kind: "factor", factor, bucket })
          }
        />
      )}

      <div className="bg-panel border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">
            Factor Coverage
            {factorCoverage && (
              <span className="text-ink-faint font-normal ml-2">
                {factorCoverage.withFactors} of {factorCoverage.totalHoldings} holdings ({factorCoverage.coveragePct}%)
              </span>
            )}
          </h3>
          <button
            onClick={runFactorAutoClassify}
            disabled={factorClassifyLoading}
            className="px-3 py-1 text-xs bg-gold/10 text-gold border border-gold/30 rounded hover:bg-gold/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
          >
            {factorClassifyLoading ? "Classifying..." : "Auto-Classify Factors"}
          </button>
        </div>
        {factorCoverage && factorCoverage.bySource.length > 0 && (
          <div className="flex gap-4 mt-3">
            {factorCoverage.bySource.map((s) => (
              <span key={s.source} className="text-xs text-ink-faint">
                <span className="text-ink-dim font-mono">{s.count}</span>{" "}
                {s.source}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* P3 Slice C — factor cell click opens drill-down */}
      <DrillDownPanel
        open={drillFilter !== null}
        onClose={() => setDrillFilter(null)}
        scope={scope ?? "all"}
        filter={drillFilter}
      />
    </>
  );
}
