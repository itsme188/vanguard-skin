"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../Toast";
import { Count, PrivateText, usePrivateFormatter } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import type { ConcentrationMetrics, ClassificationCoverage } from "@/lib/queries/analysis";
import { interpretHHI, effectivePositionsFromHHI } from "@/lib/analysis/interpret";
import { displaySecurityName } from "@/lib/format";
import apiFetch from "@/lib/http/apiFetch";

interface Props {
  concentration: ConcentrationMetrics;
  coverage: ClassificationCoverage;
}

/**
 * Plain-language names for the stored method values behind the two coverage
 * legends: `securities.classification_source` (Classification card) and
 * `security_factors.factor_source` (Factor Coverage card), plus the two
 * placeholders the coverage queries emit for a missing value. The one mapping
 * for both legends: never print the stored value itself.
 */
export const CLASSIFICATION_METHOD_LABELS: Record<string, string> = {
  static_lookup: "reference table",
  auto: "automatic",
  auto_option: "from the option's underlying",
  auto_ai: "AI classified",
  auto_default: "default for the security type",
  csv_import: "from a CSV import",
  manual: "set by hand",
  unclassified: "unclassified",
  none: "no method recorded",
};

/** Label for a stored method value. An unknown value reads as spaced words. */
export function classificationMethodLabel(source: string | null | undefined): string {
  const key = (source ?? "").trim().toLowerCase();
  if (key === "") return CLASSIFICATION_METHOD_LABELS.none;
  return CLASSIFICATION_METHOD_LABELS[key] ?? key.replace(/[_-]+/g, " ");
}

function wireCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The line shown after an Auto-Classify run that did some work. The engine
 * counts every security ever imported, while this card counts current
 * holdings only, so the line names both populations instead of printing the
 * engine's tally as if it were the card's. `heldUnclassifiedBefore` is the
 * card's own list length before the run; pass null to leave that count out
 * (privacy mode).
 */
export function classifyRunSummary(
  result: { classified?: unknown; skipped?: unknown; unresolvedCount?: unknown },
  aiErrors: string[],
  heldUnclassifiedBefore: number | null,
): string {
  const classified = wireCount(result.classified);
  const skipped = wireCount(result.skipped);
  const unresolved = wireCount(result.unresolvedCount);
  const parts = [
    `Classified ${classified} ${classified === 1 ? "security" : "securities"} across the whole security list (every security ever imported, not only current holdings)`,
    `${skipped} already classified`,
  ];
  if (unresolved > 0) parts.push(`${unresolved} couldn't be auto-classified`);
  parts.push(
    heldUnclassifiedBefore != null && heldUnclassifiedBefore > 0
      ? `this card counts current holdings only and listed ${heldUnclassifiedBefore} unclassified before the run`
      : "this card counts current holdings only",
  );
  // Surface the AI batch failure instead of swallowing it — a silent
  // aiErrors[] left the classify step hard-failing on every run with
  // no visible signal (qa:analysis-classification--auto-classify-swallows-ai-json-error).
  if (aiErrors.length > 0) parts.push(`AI step failed: ${aiErrors[0]}`);
  return parts.join(" · ");
}

/** Same markup as MetricCard, with slots that can hold a privacy component. */
function ConcentrationTile({
  label,
  value,
  description,
  color,
}: {
  label: string;
  value: ReactNode;
  description: ReactNode;
  color: string;
}) {
  return (
    <div className="bg-raised/50 rounded-lg p-3">
      <p className="text-xs text-ink-faint uppercase">{label}</p>
      <p className={`text-xl font-mono font-medium mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-ink-faint mt-1">{description}</p>
    </div>
  );
}

/**
 * What "Show Details" opens. It always renders something: the unclassified
 * list, or a plain statement that nothing is outstanding. At full coverage
 * the toggle used to flip its own label and change nothing else.
 */
export function ClassificationDetails({ coverage }: { coverage: ClassificationCoverage }) {
  if (coverage.unclassified_securities.length === 0) {
    return (
      <p className="mt-4 text-xs text-ink-faint">
        {coverage.total > 0 ? (
          <>
            All <Count value={coverage.total} /> held securities are classified. Nothing is outstanding.
          </>
        ) : (
          "No securities are held in this scope, so there is nothing to classify."
        )}
      </p>
    );
  }
  return (
    <div className="mt-4">
      <h4 className="text-xs font-medium text-ink-faint uppercase mb-2">
        Unclassified Securities (<Count value={coverage.unclassified_securities.length} />)
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
                <td className="py-1 pr-2 text-ink-faint truncate max-w-xs">{displaySecurityName(s.name)}</td>
                <td className="py-1 text-ink-faint">{s.security_type ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ClassificationCard({ concentration, coverage }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const { isPrivate } = usePrivacy();
  const [showCoverage, setShowCoverage] = useState(false);
  const [classifyLoading, setClassifyLoading] = useState(false);
  const pctTickFormatter = usePrivateFormatter((v: number) => `${v.toFixed(0)}%`);
  const pctTooltipFormatter = usePrivateFormatter(
    (v: number | string | undefined) => `${Number(v).toFixed(1)}%`,
  );

  async function runAutoClassify() {
    setClassifyLoading(true);
    try {
      const res = await apiFetch("/api/compute/classify", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        // Guard with Array.isArray — aiErrors comes off the wire as JSON, not
        // a typed value.
        const aiErrors: string[] = Array.isArray(data.aiErrors) ? data.aiErrors : [];
        if (data.classified === 0 && !data.unresolvedCount && aiErrors.length === 0) {
          // Explain the no-op — "Classified 0" with no why reads as a broken button.
          // No count: data.skipped is the engine's whole-table skip tally (every
          // securities row ever seen, ~1.3k), not the held universe — quoting it
          // as "held securities" contradicted the coverage card's 137.
          toast("Nothing to classify — every held security already has sector/fund classifications.", "info");
        } else {
          toast(
            classifyRunSummary(
              data,
              aiErrors,
              isPrivate ? null : coverage.unclassified_securities.length,
            ),
            aiErrors.length > 0 ? "error" : data.unresolvedCount > 0 ? "info" : "success",
          );
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
          {/* HHI, its sentence and the effective-position count restate the
              book's weights, so they mask like the same figures on the Risk
              Decomposition card. */}
          <ConcentrationTile
            label="Herfindahl Index (HHI)"
            value={<PrivateText>{concentration.hhi.toFixed(4)}</PrivateText>}
            description={<PrivateText>{interpretHHI(concentration.hhi).text}</PrivateText>}
            color={
              concentration.hhi > 0.25
                ? "text-down"
                : concentration.hhi > 0.15
                ? "text-gold"
                : "text-up"
            }
          />
          <ConcentrationTile
            label="Effective Positions"
            value={<Count value={Math.round(effectivePositionsFromHHI(concentration.hhi))} />}
            description="1/HHI — equivalent equal-weighted positions (same count as the sentence below)"
            color="text-blue"
          />
          <ConcentrationTile
            label="Classification Coverage"
            value={`${coverage.coverage_pct}%`}
            description={
              <>
                <Count value={coverage.classified} /> of <Count value={coverage.total} /> securities classified
              </>
            }
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
              <p key={i} className="text-xs text-gold-ink">
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
              className="px-3 py-1 text-xs bg-gold/10 text-gold-ink border border-gold/30 rounded hover:bg-gold/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
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

        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
          {coverage.by_source.map((s) => (
            <span key={s.source} className="text-xs text-ink-faint">
              <Count value={s.count} className="text-ink-dim font-mono" />{" "}
              {classificationMethodLabel(s.source)}
            </span>
          ))}
        </div>

        {showCoverage && <ClassificationDetails coverage={coverage} />}
      </div>
    </>
  );
}
