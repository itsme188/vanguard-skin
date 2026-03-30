"use client";

import { useState, useEffect } from "react";

interface PositionGreek {
  symbol: string;
  underlying: string;
  type: string;
  strike: number;
  expiration: string;
  quantity: number;
  underlyingPrice: number;
  daysToExpiry: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
}

interface GreeksData {
  portfolio: {
    totalDelta: number;
    totalGamma: number;
    totalTheta: number;
    totalVega: number;
  };
  positions: PositionGreek[];
}

/**
 * Portfolio-level Greeks summary + per-position Greeks table.
 * Only renders if the portfolio has option positions.
 */
export function OptionsGreeksCard() {
  const [data, setData] = useState<GreeksData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/compute/options-greeks")
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data.positions.length > 0) setData(json.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || !data) return null;

  const { portfolio, positions } = data;

  return (
    <div className="bg-raised border border-edge rounded-2xl p-6 space-y-4">
      <h3 className="text-sm font-medium text-ink">Options Greeks</h3>

      {/* Portfolio-level summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCell
          label="Net Delta"
          value={formatNum(portfolio.totalDelta)}
          description="Share-equivalents"
          color={portfolio.totalDelta > 0 ? "text-up" : portfolio.totalDelta < 0 ? "text-down" : "text-ink"}
        />
        <MetricCell
          label="Net Gamma"
          value={formatNum(portfolio.totalGamma)}
          description="Per $1 move"
          color="text-ink"
        />
        <MetricCell
          label="Daily Theta"
          value={formatDollar(portfolio.totalTheta)}
          description="Time decay / day"
          color="text-down"
        />
        <MetricCell
          label="Net Vega"
          value={formatDollar(portfolio.totalVega)}
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
              <th className="text-right py-2 px-2 font-medium">Qty</th>
              <th className="text-right py-2 px-2 font-medium">Underlying</th>
              <th className="text-right py-2 px-2 font-medium">DTE</th>
              <th className="text-right py-2 px-2 font-medium">IV</th>
              <th className="text-right py-2 px-2 font-medium">Delta</th>
              <th className="text-right py-2 px-2 font-medium">Gamma</th>
              <th className="text-right py-2 px-2 font-medium">Theta</th>
              <th className="text-right py-2 px-2 font-medium">Vega</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol} className="border-b border-edge/50 hover:bg-muted/30">
                <td className="py-2 pr-3">
                  <span className="font-mono text-ink">{p.underlying}</span>
                  <span className="text-ink-faint ml-1">
                    {formatStrike(p.strike)} {p.type[0]} {formatExpiry(p.expiration)}
                  </span>
                </td>
                <td className={`text-right py-2 px-2 font-mono ${p.quantity < 0 ? "text-down" : "text-ink"}`}>
                  {p.quantity > 0 ? `+${p.quantity}` : p.quantity}
                </td>
                <td className="text-right py-2 px-2 font-mono text-ink-dim">
                  ${p.underlyingPrice.toFixed(2)}
                </td>
                <td className={`text-right py-2 px-2 font-mono ${p.daysToExpiry <= 7 ? "text-down" : p.daysToExpiry <= 30 ? "text-gold" : "text-ink-dim"}`}>
                  {p.daysToExpiry}d
                </td>
                <td className="text-right py-2 px-2 font-mono text-ink-dim">
                  {p.iv ?? "—"}
                </td>
                <td className={`text-right py-2 px-2 font-mono ${(p.delta ?? 0) > 0 ? "text-up" : (p.delta ?? 0) < 0 ? "text-down" : "text-ink-dim"}`}>
                  {p.delta != null ? p.delta.toFixed(3) : "—"}
                </td>
                <td className="text-right py-2 px-2 font-mono text-ink-dim">
                  {p.gamma != null ? p.gamma.toFixed(4) : "—"}
                </td>
                <td className="text-right py-2 px-2 font-mono text-down">
                  {p.theta != null ? `$${p.theta.toFixed(2)}` : "—"}
                </td>
                <td className="text-right py-2 px-2 font-mono text-blue">
                  {p.vega != null ? `$${p.vega.toFixed(2)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function MetricCell({
  label,
  value,
  description,
  color,
}: {
  label: string;
  value: string;
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

function formatNum(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(1);
}

function formatDollar(n: number): string {
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
