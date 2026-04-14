"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SecurityChart } from "./SecurityChart";
import { MultiChart } from "./MultiChart";

interface ChartableSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
}

type ViewMode = "single" | "multi";

export function ChartsView({
  securities,
  initialSecurity,
  initialPrice,
}: {
  securities: ChartableSecurity[];
  initialSecurity: ChartableSecurity | null;
  initialPrice: { close_price: number; date: string } | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ChartableSecurity | null>(
    initialSecurity,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("single");

  const handleSelect = (secId: number) => {
    const sec = securities.find((s) => s.id === secId);
    if (sec) {
      setSelected(sec);
      router.replace(`/dashboard/charts?id=${secId}`, { scroll: false });
    }
  };

  if (securities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-12 text-center">
        <p className="text-ink-faint text-sm">
          No chartable securities. Run Enrich Securities to populate IB contract
          IDs.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* View mode toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("single")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === "single" ? "bg-panel text-gold" : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              Single
            </button>
            <button
              onClick={() => setViewMode("multi")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === "multi" ? "bg-panel text-gold" : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              Watchlist
            </button>
          </div>

          {/* Single mode: security picker */}
          {viewMode === "single" && (
            <select
              value={selected?.id ?? ""}
              onChange={(e) => handleSelect(Number(e.target.value))}
              className="bg-raised border border-edge rounded-lg px-3 py-2 text-sm font-mono
                text-ink focus:outline-none focus:ring-1 focus:ring-gold max-w-xs truncate"
            >
              {securities.map((sec) => (
                <option key={sec.id} value={sec.id}>
                  {sec.symbol}
                  {sec.name ? ` \u2014 ${sec.name}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Price info (single mode only) */}
        {viewMode === "single" && initialPrice && selected?.id === initialSecurity?.id && (
          <div className="text-right">
            <div className="font-mono text-lg text-ink tabular-nums">
              ${initialPrice.close_price.toFixed(2)}
            </div>
            <div className="text-xs text-ink-faint">
              as of {initialPrice.date}
            </div>
          </div>
        )}
      </div>

      {/* Chart content */}
      {viewMode === "single" ? (
        selected && (
          <div className="rounded-xl border border-edge bg-panel overflow-hidden h-[400px] md:h-[600px]">
            <SecurityChart
              key={selected.id}
              securityId={selected.id}
              symbol={selected.symbol}
              
            />
          </div>
        )
      ) : (
        <MultiChart
          securities={securities}
          initialSecurityId={selected?.id ?? null}
          
        />
      )}
    </div>
  );
}
