"use client";

import { useState, useCallback } from "react";
import { SecurityChart } from "./SecurityChart";

interface ChartableSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  currency: string | null;
}

type LayoutKey = "1" | "2" | "4";

const LAYOUTS: { key: LayoutKey; label: string; cols: number; rows: number }[] = [
  { key: "1", label: "1", cols: 1, rows: 1 },
  { key: "2", label: "1\u00d72", cols: 2, rows: 1 },
  { key: "4", label: "2\u00d72", cols: 2, rows: 2 },
];

interface PanelState {
  securityId: number | null;
}

export function MultiChart({
  securities,
  initialSecurityId,
}: {
  securities: ChartableSecurity[];
  initialSecurityId: number | null;
}) {
  const [layout, setLayout] = useState<LayoutKey>("1");
  const panelCount = layout === "1" ? 1 : layout === "2" ? 2 : 4;

  // Initialize panels — first panel gets the initial security, rest get sequential picks
  const [panels, setPanels] = useState<PanelState[]>(() => {
    // Prefer stocks/ETFs over bonds/treasuries for default panel securities
    const stocks = securities.filter(
      (s) => s.security_type?.toLowerCase() === "stock" || s.security_type?.toLowerCase() === "etf",
    );
    const initial: PanelState[] = [];
    for (let i = 0; i < 4; i++) {
      if (i === 0 && initialSecurityId) {
        initial.push({ securityId: initialSecurityId });
      } else if (stocks[i]) {
        initial.push({ securityId: stocks[i].id });
      } else if (securities[i]) {
        initial.push({ securityId: securities[i].id });
      } else {
        initial.push({ securityId: null });
      }
    }
    return initial;
  });

  const handlePanelSecurityChange = useCallback(
    (panelIndex: number, secId: number) => {
      setPanels((prev) => {
        const next = [...prev];
        next[panelIndex] = { securityId: secId };
        return next;
      });
    },
    [],
  );

  const gridCols = layout === "1" ? "grid-cols-1" : "grid-cols-2";
  const chartHeight = layout === "4" ? "h-[350px]" : "h-[600px]";

  return (
    <div className="space-y-3">
      {/* Layout switcher */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-faint font-medium">Layout</span>
        <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
          {LAYOUTS.map((l) => (
            <button
              key={l.key}
              onClick={() => setLayout(l.key)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                layout === l.key
                  ? "bg-panel text-gold-ink"
                  : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart grid */}
      <div className={`grid ${gridCols} gap-3`}>
        {Array.from({ length: panelCount }, (_, i) => {
          const panel = panels[i];
          const sec = panel.securityId
            ? securities.find((s) => s.id === panel.securityId)
            : null;

          return (
            <div
              key={i}
              className={`rounded-xl border border-edge bg-panel overflow-hidden ${chartHeight}`}
            >
              {/* Per-panel security picker */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge bg-raised/50">
                <select
                  value={panel.securityId ?? ""}
                  onChange={(e) =>
                    handlePanelSecurityChange(i, Number(e.target.value))
                  }
                  className="bg-transparent border-none text-xs font-mono text-ink
                    focus:outline-none focus:ring-0 cursor-pointer"
                >
                  {securities.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.symbol}
                    </option>
                  ))}
                </select>
                {sec && (
                  <span className="text-xs text-ink-faint truncate">
                    {sec.name}
                  </span>
                )}
              </div>

              {/* Chart */}
              <div className="h-[calc(100%-32px)]">
                {sec ? (
                  <SecurityChart
                    key={`${i}-${sec.id}`}
                    securityId={sec.id}
                    symbol={sec.symbol}
                    currency={sec.currency}
                    securityType={sec.security_type}
                    compact
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-ink-faint text-sm">
                    Select a security
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
