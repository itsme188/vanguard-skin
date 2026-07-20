"use client";

import { Fragment, useState } from "react";
import { Money, Pct } from "@/lib/privacy/components";
import { FACTOR_COLUMNS, FACTOR_LABELS, type FactorColumn } from "@/lib/factors";
import type { ExposureDelta, HypotheticalLeg } from "@/lib/compute/exposure-delta";

const MATERIAL_DELTA_PCT = 0.005; // 0.5pp threshold for sector + factor rows

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
          className="relative px-3 py-1.5 text-xs border border-edge text-ink-dim rounded hover:text-ink hover:border-ink-faint transition-colors pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-1"
        >
          + Add leg
        </button>
        <button
          onClick={run}
          disabled={loading}
          className="relative px-3 py-1.5 text-xs bg-gold/15 text-gold-ink border border-gold/40 rounded hover:bg-gold/25 transition-colors disabled:opacity-50 focus-ring pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-1"
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
                  className={`text-xs ${flag.severity === "error" ? "text-down" : "text-gold-ink"}`}
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

interface Row {
  label: string;
  before: string | React.ReactNode;
  after: string | React.ReactNode;
  diff?: string;
  indent?: boolean;
}

interface Section {
  title: string;
  rows: Row[];
}

function buildHeadlineRows(delta: ExposureDelta): Row[] {
  return [
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
}

function buildConcentrationRows(delta: ExposureDelta): Row[] {
  const topSymbols = delta.after.topConcentrations.slice(0, 3).map((c) => c.symbol);
  return topSymbols.map((symbol) => {
    const after = delta.after.topConcentrations.find((c) => c.symbol === symbol)!.weightPct;
    const before = delta.before.topConcentrations.find((c) => c.symbol === symbol)?.weightPct ?? 0;
    return {
      label: symbol,
      before: <Pct value={before * 100} digits={1} />,
      after: <Pct value={after * 100} digits={1} />,
      diff: signedPp(after - before),
      indent: true,
    };
  });
}

function buildSectorRows(delta: ExposureDelta): Row[] {
  const allSectors = new Set<string>([
    ...Object.keys(delta.before.sectorWeights),
    ...Object.keys(delta.after.sectorWeights),
  ]);
  return Array.from(allSectors)
    .map((sector) => {
      const before = delta.before.sectorWeights[sector] ?? 0;
      const after = delta.after.sectorWeights[sector] ?? 0;
      return { sector, before, after, diff: after - before };
    })
    .filter((r) => Math.abs(r.diff) >= MATERIAL_DELTA_PCT)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .map(({ sector, before, after, diff }) => ({
      label: sector,
      before: <Pct value={before * 100} digits={1} />,
      after: <Pct value={after * 100} digits={1} />,
      diff: signedPp(diff),
      indent: true,
    }));
}

function buildFactorRows(delta: ExposureDelta): Row[] {
  const rows: Row[] = [];
  for (const factor of FACTOR_COLUMNS) {
    const beforeBuckets = delta.before.factorTilts[factor] ?? {};
    const afterBuckets = delta.after.factorTilts[factor] ?? {};
    const allBuckets = new Set<string>([...Object.keys(beforeBuckets), ...Object.keys(afterBuckets)]);
    const moves = Array.from(allBuckets)
      .map((bucket) => {
        const before = beforeBuckets[bucket] ?? 0;
        const after = afterBuckets[bucket] ?? 0;
        return { bucket, before, after, diff: after - before };
      })
      .filter((r) => Math.abs(r.diff) >= MATERIAL_DELTA_PCT)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    if (moves.length === 0) continue;
    for (const m of moves) {
      rows.push({
        label: `${FACTOR_LABELS[factor as FactorColumn]} · ${m.bucket}`,
        before: <Pct value={m.before * 100} digits={1} />,
        after: <Pct value={m.after * 100} digits={1} />,
        diff: signedPp(m.diff),
        indent: true,
      });
    }
  }
  return rows;
}

function DeltaTable({ delta }: { delta: ExposureDelta }) {
  const sections: Section[] = [
    { title: "Headline", rows: buildHeadlineRows(delta) },
    { title: "Top 3 concentrations", rows: buildConcentrationRows(delta) },
    { title: "Sector weights · material moves", rows: buildSectorRows(delta) },
    { title: "Factor tilts · material moves", rows: buildFactorRows(delta) },
  ].filter((s) => s.rows.length > 0);

  return (
    <div className="bg-canvas border border-edge rounded-lg overflow-hidden overflow-x-auto">
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
          {sections.map((section, sIdx) => (
            <Fragment key={section.title}>
              {sIdx > 0 && (
                <tr className="bg-canvas">
                  <td colSpan={4} className="py-1.5 px-3 text-[11px] uppercase tracking-wide text-ink-faint border-t border-edge">
                    {section.title}
                  </td>
                </tr>
              )}
              {section.rows.map((r) => (
                <tr key={r.label} className="border-b border-edge/40">
                  <td className={`py-2 px-3 text-ink ${r.indent ? "pl-6" : ""}`}>{r.label}</td>
                  <td className="text-right py-2 px-3 font-mono text-ink-dim">{r.before}</td>
                  <td className="text-right py-2 px-3 font-mono text-ink">{r.after}</td>
                  <td className="text-right py-2 px-3 font-mono text-ink-faint">{r.diff ?? "—"}</td>
                </tr>
              ))}
            </Fragment>
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

function signedPp(n: number): string {
  const pp = n * 100;
  const v = pp.toFixed(1);
  return pp >= 0 ? `+${v}pp` : `${v}pp`;
}

function formatDeltaUsd(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
