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

/**
 * Seed for the Watchlist grid: the security the user was just looking at
 * (when there is one), then the active watchlist in watchlist order. No
 * security is seeded twice, a watchlist name the picker cannot chart is
 * skipped, and leftover panels stay EMPTY — a mode named "Watchlist" never
 * fills itself with names that are not on the watchlist.
 */
export function seedWatchlistPanels(
  initialSecurityId: number | null,
  watchlistIds: readonly number[],
  chartableIds: readonly number[],
  panelCount = 4,
): (number | null)[] {
  const chartable = new Set(chartableIds);
  const used = new Set<number>();
  const seeded: (number | null)[] = [];
  for (const id of [initialSecurityId, ...watchlistIds]) {
    if (seeded.length >= panelCount) break;
    if (id == null || used.has(id) || !chartable.has(id)) continue;
    used.add(id);
    seeded.push(id);
  }
  while (seeded.length < panelCount) seeded.push(null);
  return seeded;
}

/** What an unseeded panel says, given how many names the watchlist holds. */
export function emptyPanelCopy(watchlistCount: number): string {
  return watchlistCount === 0
    ? "Your watchlist is empty. Pick a security above."
    : "No more watchlist names. Pick a security above.";
}

export function MultiChart({
  securities,
  initialSecurityId,
  watchlistIds,
}: {
  securities: ChartableSecurity[];
  initialSecurityId: number | null;
  /** Active watchlist security ids, in watchlist order. */
  watchlistIds: number[];
}) {
  const [layout, setLayout] = useState<LayoutKey>("1");
  const panelCount = layout === "1" ? 1 : layout === "2" ? 2 : 4;

  // Initialize panels from the watchlist (see seedWatchlistPanels).
  const [panels, setPanels] = useState<PanelState[]>(() =>
    seedWatchlistPanels(
      initialSecurityId,
      watchlistIds,
      securities.map((s) => s.id),
    ).map((securityId) => ({ securityId })),
  );

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
  // Panel height must fit the compact SecurityChart's laid-out content or
  // the overflow-hidden panel silently clips the bottom — the date axis
  // first, then the staleness footer. Fixed rows of a 2x2 panel:
  //   per-panel picker header       32  (reserved via the wrapper's
  //                                     h-[calc(100%-32px)])
  //   toolbar, one line             47
  //   compact staleness footer      25  (SecurityChart.tsx: text-xs = 16px
  //                                     line box + py-1 = 8px + 1px border-t)
  //   ------------------------------------
  //   fixed rows                   104  -> 328 of the 432 left for the plot
  // Two rows are NOT fixed: from md up the toolbar wraps onto a second line
  // in a narrow panel (about 34px more), and a status banner ("TWS not
  // connected", 28px) shows only sometimes. The plot is the one row that
  // gives way for them: the compact chart area is flex-1 with a 160px floor
  // (SecurityChart.tsx min-h-[160px]) and the footer is shrink-0, so the
  // footer is never the row that gets clipped. A two-line toolbar plus a
  // banner still leaves the plot about 266px, well above the floor; the
  // floor itself is only reached at 432 - 104 - 160 = 168px of toolbar and
  // banner. (History: 350px and 416px budgets, sized when the chart area
  // had a fixed 300px floor, clipped the date axis and then the footer.)
  // 1x2 at 628px has more slack still.
  const chartHeight = layout === "4" ? "h-[432px]" : "h-[628px]";

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
              className={`rounded-xl border border-edge bg-panel overflow-hidden min-w-0 ${chartHeight}`}
            >
              {/* Per-panel security picker */}
              {/* min-w-0 down the chain + a capped picker: in a 170px phone
                  tile the picker used to run past the tile edge and push the
                  name fully outside, where overflow-hidden painted nothing. */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge bg-raised/50 min-w-0">
                <select
                  value={panel.securityId ?? ""}
                  onChange={(e) =>
                    handlePanelSecurityChange(i, Number(e.target.value))
                  }
                  className="bg-transparent border-none text-xs font-mono text-ink
                    focus:outline-none focus:ring-0 cursor-pointer min-w-0 max-w-[60%] truncate"
                >
                  {panel.securityId == null && (
                    <option value="" disabled>
                      Select
                    </option>
                  )}
                  {securities.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.symbol}
                    </option>
                  ))}
                </select>
                {sec && (
                  <span
                    className="text-xs text-ink-faint truncate min-w-0 flex-1"
                    title={sec.name ?? undefined}
                  >
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
                  <div className="flex items-center justify-center h-full px-3 text-center text-ink-faint text-sm">
                    {emptyPanelCopy(watchlistIds.length)}
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
