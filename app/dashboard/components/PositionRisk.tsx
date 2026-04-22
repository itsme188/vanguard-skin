"use client";

import { useState, useEffect } from "react";
import type {
  PositionRisk,
  CorrelationEntry,
  PositionRiskResult,
} from "@/lib/compute/risk";
import { Pct } from "@/lib/privacy/components";

// ─── Formatters ──────────────────────────────────────────────────

function formatCorr(value: number): string {
  return value.toFixed(2);
}

// ─── Correlation color ───────────────────────────────────────────

function corrColor(corr: number): string {
  // High positive correlation = warm (red-ish), low/negative = cool (blue-ish)
  if (corr >= 0.8) return "bg-down/30 text-down";
  if (corr >= 0.5) return "bg-amber-400/15 text-amber-400";
  if (corr >= 0.2) return "bg-ink-faint/15 text-ink-dim";
  if (corr >= -0.2) return "bg-up/20 text-up";
  return "bg-blue-500/20 text-blue-400";
}

function corrBg(corr: number): string {
  const abs = Math.abs(corr);
  if (abs >= 0.8) return "rgba(248, 113, 113, 0.25)";
  if (abs >= 0.5) return "rgba(251, 191, 36, 0.15)";
  if (abs >= 0.2) return "rgba(148, 163, 184, 0.1)";
  return "rgba(52, 211, 153, 0.1)";
}

// ─── Component ───────────────────────────────────────────────────

export function PositionRiskCard({ scope }: { scope?: string }) {
  const [data, setData] = useState<PositionRiskResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const scopeParam = scope && scope !== "all" ? `&scope=${scope}` : "";
    fetch(`/api/compute/position-risk?topN=10${scopeParam}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setData(json.data);
        else setError(json.error ?? "Failed to compute position risk");
      })
      .catch(() => setError("Failed to fetch position risk"))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) {
    return (
      <div className="bg-raised border border-edge rounded-2xl p-6">
        <h3 className="text-sm font-medium text-ink mb-4">Position-Level Risk</h3>
        <div className="text-sm text-ink-faint animate-pulse">Computing position risk...</div>
      </div>
    );
  }

  if (error || !data || data.positions.length === 0) {
    return (
      <div className="bg-raised border border-edge rounded-2xl p-6">
        <h3 className="text-sm font-medium text-ink mb-4">Position-Level Risk</h3>
        <div className="text-sm text-ink-faint">
          {error ?? "No position data available. Import holdings and prices to see position-level risk."}
        </div>
      </div>
    );
  }

  // Sort by risk contribution (highest first), nulls last
  const sorted = [...data.positions].sort((a, b) => {
    if (a.riskContribution == null && b.riskContribution == null) return 0;
    if (a.riskContribution == null) return 1;
    if (b.riskContribution == null) return -1;
    return b.riskContribution - a.riskContribution;
  });

  // Build correlation matrix
  const corrSymbols = Array.from(
    new Set(data.correlations.flatMap((c) => [c.symbolA, c.symbolB]))
  ).sort();
  const corrMap = new Map<string, number>();
  for (const c of data.correlations) {
    corrMap.set(`${c.symbolA}:${c.symbolB}`, c.correlation);
    corrMap.set(`${c.symbolB}:${c.symbolA}`, c.correlation);
  }

  return (
    <div className="bg-raised border border-edge rounded-2xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Position-Level Risk</h3>
        {data.portfolioVol != null && (
          <span className="text-xs text-ink-faint">
            Portfolio Vol:{" "}
            <Pct value={data.portfolioVol * 100} digits={1} className="font-mono text-ink" />
          </span>
        )}
      </div>

      {/* ── Position table ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge text-ink-faint text-xs">
              <th className="text-left py-2 pr-4 font-medium">Position</th>
              <th className="text-right py-2 px-3 font-medium">Weight</th>
              <th className="text-right py-2 px-3 font-medium">Volatility</th>
              <th className="text-right py-2 px-3 font-medium">Corr w/ Port</th>
              <th className="text-right py-2 pl-3 font-medium">Risk Contrib</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((pos) => (
              <tr key={pos.securityId} className="border-b border-edge/30 last:border-0">
                <td className="py-2 pr-4">
                  <div className="font-mono font-medium text-ink">{pos.symbol}</div>
                  {pos.securityName && (
                    <div className="text-xs text-ink-faint truncate max-w-[180px]">
                      {pos.securityName}
                    </div>
                  )}
                </td>
                <td className="text-right py-2 px-3 font-mono tabular-nums text-ink-dim">
                  <Pct value={pos.weight != null ? pos.weight * 100 : null} digits={1} />
                </td>
                <td className="text-right py-2 px-3 font-mono tabular-nums text-ink">
                  <Pct value={pos.annualizedVol != null ? pos.annualizedVol * 100 : null} digits={1} />
                </td>
                <td className="text-right py-2 px-3">
                  {pos.correlationWithPortfolio != null ? (
                    <span
                      className={`font-mono tabular-nums text-xs px-1.5 py-0.5 rounded ${corrColor(pos.correlationWithPortfolio)}`}
                    >
                      {formatCorr(pos.correlationWithPortfolio)}
                    </span>
                  ) : (
                    <span className="text-ink-faint">{"\u2014"}</span>
                  )}
                </td>
                <td className="text-right py-2 pl-3">
                  {pos.riskContribution != null ? (
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-edge rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gold rounded-full"
                          style={{
                            width: `${Math.min(Math.abs(pos.riskContribution) * 100, 100)}%`,
                          }}
                        />
                      </div>
                      <Pct
                        value={pos.riskContribution != null ? pos.riskContribution * 100 : null}
                        digits={1}
                        className="font-mono tabular-nums text-ink text-xs w-12 text-right"
                      />
                    </div>
                  ) : (
                    <span className="text-ink-faint">{"\u2014"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Correlation matrix ── */}
      {corrSymbols.length >= 3 && (
        <div>
          <h4 className="text-xs text-ink-faint uppercase tracking-widest mb-3">
            Pairwise Correlations
          </h4>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="pr-2 pb-1" />
                  {corrSymbols.map((s) => (
                    <th
                      key={s}
                      className="px-1.5 pb-1 font-mono font-medium text-ink-faint text-center"
                      style={{ minWidth: "44px" }}
                    >
                      {s.length > 5 ? s.slice(0, 4) + "\u2026" : s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {corrSymbols.map((rowSym) => (
                  <tr key={rowSym}>
                    <td className="pr-2 py-0.5 font-mono font-medium text-ink-faint text-right">
                      {rowSym.length > 5 ? rowSym.slice(0, 4) + "\u2026" : rowSym}
                    </td>
                    {corrSymbols.map((colSym) => {
                      if (rowSym === colSym) {
                        return (
                          <td
                            key={colSym}
                            className="px-1.5 py-0.5 text-center font-mono text-ink-faint"
                            style={{ background: "rgba(148, 163, 184, 0.05)" }}
                          >
                            1.00
                          </td>
                        );
                      }
                      const corr = corrMap.get(`${rowSym}:${colSym}`);
                      if (corr === undefined) {
                        return (
                          <td key={colSym} className="px-1.5 py-0.5 text-center text-ink-faint">
                            {"\u2014"}
                          </td>
                        );
                      }
                      return (
                        <td
                          key={colSym}
                          className="px-1.5 py-0.5 text-center font-mono tabular-nums"
                          style={{ background: corrBg(corr) }}
                          title={`${rowSym} × ${colSym}: ${corr.toFixed(3)}`}
                        >
                          {formatCorr(corr)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10px] text-ink-faint">
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(52, 211, 153, 0.2)" }} />
              Low (&lt;0.2)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(148, 163, 184, 0.2)" }} />
              Moderate
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(251, 191, 36, 0.15)" }} />
              High (&gt;0.5)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(248, 113, 113, 0.25)" }} />
              Very High (&gt;0.8)
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
