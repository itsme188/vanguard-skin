"use client";

import { useState, useEffect, type ReactNode } from "react";
import type { PortfolioGreeks, PositionGreeks, GreeksDiagnostic } from "@/lib/compute/options-greeks";
import { PrivateText } from "@/lib/privacy/components";
import { EmptySection } from "./EmptySection";

/**
 * Portfolio-level Greeks summary + per-position Greeks table.
 * Only renders if the portfolio has option positions.
 */
export function OptionsGreeksCard({ scope }: { scope?: string }) {
  const [data, setData] = useState<PortfolioGreeks | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/compute/options-greeks${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data.positions?.length > 0) setData(json.data);
        else setData(null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) return null;
  if (!data) {
    return (
      <EmptySection
        title="Options Greeks"
        reason="No option positions in this scope."
        hint="Greeks (delta, gamma, theta, vega) appear once you hold call or put options. Open an options trade in IBKR or Vanguard to see this section populate."
      />
    );
  }

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-4">
      <h3 className="text-sm font-medium text-ink">Options Greeks</h3>

      {/* Portfolio-level summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCell
          label="Net Delta"
          value={<PrivateText>{formatNum(data.totalDelta)}</PrivateText>}
          description="Share-equivalents"
          color={(data.totalDelta ?? 0) > 0 ? "text-up" : (data.totalDelta ?? 0) < 0 ? "text-down" : "text-ink"}
        />
        <MetricCell
          label="Net Gamma"
          value={<PrivateText>{formatNum(data.totalGamma)}</PrivateText>}
          description="Per $1 move"
          color="text-ink"
        />
        <MetricCell
          label="Daily Theta"
          value={<PrivateText>{formatDollar(data.totalTheta)}</PrivateText>}
          description="Time decay / day"
          color="text-down"
        />
        <MetricCell
          label="Net Vega"
          value={<PrivateText>{formatDollar(data.totalVega)}</PrivateText>}
          description="Per 1% IV move"
          color="text-blue"
        />
      </div>

      {/* Per-position table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-ink-faint border-b border-edge">
              <th className="text-left py-2 pr-3 font-medium">Option</th>
              <th className="hidden md:table-cell text-right py-2 px-2 font-medium">Qty</th>
              <th className="hidden md:table-cell text-right py-2 px-2 font-medium">Underlying</th>
              <th className="text-right py-2 px-2 font-medium">DTE</th>
              <th className="hidden md:table-cell text-right py-2 px-2 font-medium">IV</th>
              <th className="text-right py-2 px-2 font-medium">Delta</th>
              <th className="hidden md:table-cell text-right py-2 px-2 font-medium">Gamma</th>
              <th className="text-right py-2 px-2 font-medium">Theta</th>
              <th className="hidden md:table-cell text-right py-2 px-2 font-medium">Vega</th>
            </tr>
          </thead>
          <tbody>
            {data.positions.map((p) => {
              const delta = p.greeks?.delta ?? null;
              const gamma = p.greeks?.gamma ?? null;
              const theta = p.greeks?.theta ?? null;
              const vega = p.greeks?.vega ?? null;
              const iv = p.greeks?.iv ?? null;
              const dte = p.daysToExpiry ?? 0;

              return (
                <tr key={p.symbol} className="border-b border-edge/50 hover:bg-muted/30">
                  <td className="py-2 pr-3">
                    <span className="font-mono text-ink">{p.underlying}</span>
                    <span className="text-ink-faint ml-1">
                      {formatStrike(p.strike)} {p.optionType[0]} {formatExpiry(p.expiration)}
                    </span>
                  </td>
                  <td className={`hidden md:table-cell text-right py-2 px-2 font-mono ${p.quantity < 0 ? "text-down" : "text-ink"}`}>
                    <PrivateText>{p.quantity > 0 ? `+${p.quantity}` : String(p.quantity)}</PrivateText>
                  </td>
                  <td className="hidden md:table-cell text-right py-2 px-2 font-mono text-ink-dim">
                    ${p.underlyingPrice.toFixed(2)}
                  </td>
                  <td className={`text-right py-2 px-2 font-mono ${dte <= 7 ? "text-down" : dte <= 30 ? "text-gold" : "text-ink-dim"}`}>
                    {dte}d
                  </td>
                  <td className="hidden md:table-cell text-right py-2 px-2 font-mono text-ink-dim">
                    {iv != null ? `${(iv * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td className={`text-right py-2 px-2 font-mono ${(delta ?? 0) > 0 ? "text-up" : (delta ?? 0) < 0 ? "text-down" : "text-ink-dim"}`}>
                    {delta != null ? delta.toFixed(3) : "—"}
                  </td>
                  <td className="hidden md:table-cell text-right py-2 px-2 font-mono text-ink-dim">
                    {gamma != null ? gamma.toFixed(4) : "—"}
                  </td>
                  <td className="text-right py-2 px-2 font-mono text-down">
                    {theta != null ? (
                      <PrivateText>{`$${theta.toFixed(2)}`}</PrivateText>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="hidden md:table-cell text-right py-2 px-2 font-mono text-blue">
                    {vega != null ? (
                      <PrivateText>{`$${vega.toFixed(2)}`}</PrivateText>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Diagnostics: positions that couldn't compute Greeks */}
      {data.diagnostics && data.diagnostics.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-ink-faint cursor-pointer">
            {data.diagnostics.length} position{data.diagnostics.length === 1 ? "" : "s"} couldn&apos;t compute Greeks
          </summary>
          <div className="mt-2 space-y-1 text-xs text-ink-dim font-mono">
            {data.diagnostics.map((d) => (
              <div key={d.symbol}>
                {d.symbol} · <span className="text-ink-faint">{REASON_LABELS[d.reason]}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── Diagnostics label map ──────────────────────────────────────

const REASON_LABELS: Record<GreeksDiagnostic["reason"], string> = {
  no_underlying_price: "no underlying price",
  expired: "already expired",
  missing_iv: "couldn't solve for IV (using 30% vol fallback)",
  missing_option_price: "no option price (using 30% vol fallback)",
};

// ─── Helpers ────────────────────────────────────────────────────

function MetricCell({
  label,
  value,
  description,
  color,
}: {
  label: string;
  value: ReactNode;
  description: string;
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

function formatNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(1);
}

function formatDollar(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatStrike(strike: number): string {
  return strike % 1 === 0 ? `$${strike}` : `$${strike.toFixed(2)}`;
}

function formatExpiry(expiry: string): string {
  const d = new Date(expiry + "T12:00:00Z");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
