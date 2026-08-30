"use client";

import { useState } from "react";
import { Money, Pct, PrivateText } from "@/lib/privacy/components";
import {
  equitySleeveCaptionLead,
  type CashDeploySuggestion,
} from "@/lib/compute/cash-deploy";

interface Props {
  scope: string;
}

export function CashDeployCard({ scope }: Props) {
  const [cash, setCash] = useState<number>(0);
  const [result, setResult] = useState<CashDeploySuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (cash <= 0) {
      setError("Enter a positive cash amount");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/analysis/cash-deploy?scope=${encodeURIComponent(scope)}&cash=${cash}`
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Request failed");
      setResult(data.data as CashDeploySuggestion);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to compute");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <header className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-ink">Cash-Deploy</h3>
          <p className="text-xs text-ink-faint mt-0.5">
            Allocate cash to close sector gaps vs benchmark, ranked by watchlist match.
          </p>
        </div>
      </header>

      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm text-ink-faint">$</span>
        <input
          type="number"
          value={cash || ""}
          onChange={(e) => setCash(Number(e.target.value) || 0)}
          placeholder="Amount to deploy"
          // md:max-xl:w-44 (finding #10) — the base w-32 (128px) truncates its
          // own placeholder in the portrait-tablet band, where this card is
          // full-width (grid-cols-1 below lg). Band-scoped rather than
          // unconditional so the input stays byte-identical at >=1280
          // desktop (2-col grid, plenty of room either way) and <768 phone.
          className="bg-canvas border border-edge rounded px-2 py-1.5 text-sm font-mono text-ink w-32 md:max-xl:w-44 focus-ring"
        />
        <button
          onClick={run}
          disabled={loading}
          className="relative px-3 py-1.5 text-xs bg-gold/15 text-gold-ink border border-gold/40 rounded hover:bg-gold/25 transition-colors disabled:opacity-50 focus-ring pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-1"
        >
          {loading ? "Computing..." : "Suggest"}
        </button>
      </div>

      {error && <p className="text-xs text-down">{error}</p>}

      {result && (
        <div className="space-y-4">
          <p className="text-xs text-ink-faint">
            Benchmark: <span className="font-mono text-ink">{result.benchmarkSymbol}</span>
            {result.mode === "heuristic" && (
              <span className="ml-2 text-gold-ink">heuristic mode (composition unavailable)</span>
            )}
          </p>

          {result.gaps.length > 0 && (
            <div className="bg-canvas border border-edge/60 rounded-lg p-3">
              <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-2">
                Sector Gaps (|≥ 2pp|)
              </h4>
              {/*
                Equity-only benchmark (QA finding
                analysis-cash-deploy--fixed-income-gap-vs-equity-benchmark):
                the gaps below are measured on the equity sleeve, so the
                weights no longer sum to the portfolio. Name the sleeve that
                was left out — its weights are portfolio-derived, so they
                render through <Pct>.
              */}
              {result.excludedSleeve && (
                <p className="text-[11px] text-ink-faint mb-2">
                  {equitySleeveCaptionLead(result.benchmarkSymbol)}{" "}
                  {result.excludedSleeve.buckets.map((b, i) => (
                    <span key={b.sector}>
                      {i > 0 && ", "}
                      {b.sector} <Pct value={b.weightPct} digits={1} />
                    </span>
                  ))}
                  {result.excludedSleeve.buckets.length > 1 && (
                    <>
                      {" "}(<Pct value={result.excludedSleeve.totalPct} digits={1} /> in
                      total)
                    </>
                  )}
                  .
                </p>
              )}
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-ink-faint">
                    <th className="text-left py-1">Sector</th>
                    <th className="text-right py-1">Current</th>
                    <th className="text-right py-1">Target</th>
                    <th className="text-right py-1">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {result.gaps.slice(0, 8).map((g) => (
                    <tr key={g.sector} className="border-t border-edge/30">
                      <td className="py-1 text-ink">{g.sector}</td>
                      <td className="text-right py-1 font-mono text-ink-dim">
                        <Pct value={g.currentWeight * 100} digits={1} />
                      </td>
                      <td className="text-right py-1 font-mono text-ink-dim">
                        {(g.targetWeight * 100).toFixed(1)}%
                      </td>
                      <td className={`text-right py-1 font-mono ${g.gapPp < 0 ? "text-gold-ink" : "text-ink-dim"}`}>
                        {/*
                          Privacy leak (review finding): gap = current − target.
                          currentWeight renders through <Pct> (masked in privacy
                          mode) and targetWeight is public benchmark data left
                          plain, but the gap itself was rendered RAW — since
                          target is public, a masked current weight is exactly
                          recoverable from an unmasked gap. <Pct> has no "pp"
                          style (it always appends "%"), so this keeps the "pp"
                          unit and masks the whole string via <PrivateText>
                          instead, matching the template-string masking idiom
                          already used elsewhere in TrustStripDrawer.
                        */}
                        <PrivateText>{`${g.gapPp >= 0 ? "+" : ""}${g.gapPp.toFixed(1)}pp`}</PrivateText>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.picks.length > 0 && (
            <div>
              <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-2">
                Suggested Picks
              </h4>
              <div className="space-y-2">
                {result.picks.map((p) => (
                  <div key={p.symbol} className="bg-canvas border border-edge/60 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-medium text-gold-ink">{p.symbol}</span>
                        <span className="text-[11px] text-ink-faint">{p.sectorTarget}</span>
                      </div>
                      <span className="font-mono text-ink"><Money value={p.allocationDollars} /></span>
                    </div>
                    <p className="text-[11px] text-ink-faint">{p.rationale}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.notes.length > 0 && (
            <ul className="space-y-1">
              {result.notes.map((n, i) => (
                <li key={i} className="text-[11px] text-ink-faint italic">
                  · {n}
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between border-t border-edge pt-3 text-xs">
            <span className="text-ink-faint">Allocated:</span>
            <span className="font-mono text-ink"><Money value={result.totalAllocated} /></span>
          </div>
          {result.cashRemaining > 0.01 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-faint">Remaining:</span>
              <span className="font-mono text-ink-dim"><Money value={result.cashRemaining} /></span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
