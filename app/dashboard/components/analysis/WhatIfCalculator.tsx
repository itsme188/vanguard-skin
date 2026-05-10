"use client";

import { useState } from "react";
import { Money, Pct } from "@/lib/privacy/components";
import type { ExposureDelta, HypotheticalLeg } from "@/lib/compute/exposure-delta";

interface Props {
  scope: string;
}

interface LegInput extends HypotheticalLeg {
  id: string;
}

function newLeg(): LegInput {
  return {
    id: Math.random().toString(36).slice(2),
    symbol: "",
    action: "buy",
    dollarAmount: 0,
  };
}

export function WhatIfCalculator({ scope }: Props) {
  const [legs, setLegs] = useState<LegInput[]>([newLeg()]);
  const [delta, setDelta] = useState<ExposureDelta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateLeg(id: string, patch: Partial<LegInput>) {
    setLegs((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function removeLeg(id: string) {
    setLegs((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.id !== id)));
  }

  function addLeg() {
    setLegs((prev) => [...prev, newLeg()]);
  }

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const cleanLegs: HypotheticalLeg[] = legs
        .filter((l) => l.symbol.trim().length > 0 && l.dollarAmount > 0)
        .map((l) => ({
          symbol: l.symbol.trim().toUpperCase(),
          action: l.action,
          dollarAmount: l.dollarAmount,
        }));
      const res = await fetch("/api/analysis/what-if", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, legs: cleanLegs }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Request failed");
      setDelta(data.data as ExposureDelta);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to compute");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-ink">What-if Calculator</h3>
          <p className="text-xs text-ink-faint mt-0.5">
            Multi-leg exposure delta — how would my portfolio change if I…
          </p>
        </div>
      </header>

      <div className="space-y-2">
        {legs.map((leg) => (
          <div key={leg.id} className="flex items-center gap-2">
            <select
              value={leg.action}
              onChange={(e) => updateLeg(leg.id, { action: e.target.value as "buy" | "sell" })}
              className="bg-canvas border border-edge rounded px-2 py-1.5 text-sm text-ink focus-ring"
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
            <input
              type="text"
              placeholder="SYMBOL"
              value={leg.symbol}
              onChange={(e) => updateLeg(leg.id, { symbol: e.target.value })}
              className="bg-canvas border border-edge rounded px-2 py-1.5 text-sm font-mono text-ink w-24 focus-ring"
            />
            <span className="text-sm text-ink-faint">$</span>
            <input
              type="number"
              placeholder="0"
              value={leg.dollarAmount || ""}
              onChange={(e) => updateLeg(leg.id, { dollarAmount: Number(e.target.value) || 0 })}
              className="bg-canvas border border-edge rounded px-2 py-1.5 text-sm font-mono text-ink w-28 focus-ring"
            />
            <button
              onClick={() => removeLeg(leg.id)}
              disabled={legs.length === 1}
              className="text-ink-faint hover:text-down disabled:opacity-30 px-2"
              aria-label="Remove leg"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={addLeg}
          className="px-3 py-1.5 text-xs border border-edge text-ink-dim rounded hover:text-ink hover:border-ink-faint transition-colors"
        >
          + Add leg
        </button>
        <button
          onClick={run}
          disabled={loading}
          className="px-3 py-1.5 text-xs bg-gold/15 text-gold border border-gold/40 rounded hover:bg-gold/25 transition-colors disabled:opacity-50 focus-ring"
        >
          {loading ? "Computing..." : "Compute Δ"}
        </button>
      </div>

      {error && <p className="text-xs text-down mt-3">{error}</p>}

      {delta && (
        <div className="mt-5 space-y-4">
          <DeltaTable delta={delta} />
          {delta.flags.length > 0 && (
            <div className="space-y-1">
              {delta.flags.map((flag) => (
                <p
                  key={flag.metric + flag.message}
                  className={`text-xs ${flag.severity === "error" ? "text-down" : "text-gold"}`}
                >
                  ⚠ {flag.message}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DeltaTable({ delta }: { delta: ExposureDelta }) {
  const rows: Array<{
    label: string;
    before: string | React.ReactNode;
    after: string | React.ReactNode;
    diff?: string;
  }> = [
    {
      label: "Total Value",
      before: <Money value={delta.before.totalValue} />,
      after: <Money value={delta.after.totalValue} />,
      diff: formatDeltaUsd(delta.after.totalValue - delta.before.totalValue),
    },
    {
      label: "Portfolio Beta",
      before: delta.before.beta.toFixed(2),
      after: delta.after.beta.toFixed(2),
      diff: signed(delta.after.beta - delta.before.beta, 2),
    },
  ];

  // Top concentrations diff (compare top symbol)
  if (delta.after.topConcentrations.length > 0) {
    const top = delta.after.topConcentrations[0];
    const matching = delta.before.topConcentrations.find((c) => c.symbol === top.symbol);
    rows.push({
      label: `Top: ${top.symbol}`,
      before: <Pct value={(matching?.weightPct ?? 0) * 100} digits={1} />,
      after: <Pct value={top.weightPct * 100} digits={1} />,
    });
  }

  return (
    <div className="bg-canvas border border-edge rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-edge text-ink-faint">
            <th className="text-left py-2 px-3">Metric</th>
            <th className="text-right py-2 px-3">Before</th>
            <th className="text-right py-2 px-3">After</th>
            <th className="text-right py-2 px-3">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-edge/40">
              <td className="py-2 px-3 text-ink">{r.label}</td>
              <td className="text-right py-2 px-3 font-mono text-ink-dim">{r.before}</td>
              <td className="text-right py-2 px-3 font-mono text-ink">{r.after}</td>
              <td className="text-right py-2 px-3 font-mono text-ink-faint">{r.diff ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function signed(n: number, digits: number): string {
  const v = n.toFixed(digits);
  return n >= 0 ? `+${v}` : v;
}

function formatDeltaUsd(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
