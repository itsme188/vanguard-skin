"use client";

import { useMemo, useState } from "react";
import type { FactorHeatmapRow } from "@/lib/queries/analysis";
import { ScrollFade } from "./ScrollFade";
import {
  FACTOR_COLUMNS,
  FACTOR_LABELS,
  FACTOR_SORT_RANK,
  getFactorColor,
  type FactorColumn,
} from "@/lib/factors";
import { Pct } from "@/lib/privacy/components";

type SortColumn = FactorColumn | "weight";

/** Get numeric rank for a factor value (higher = more exposure). Null → -1 (always last). */
function getFactorRank(value: string | null): number {
  if (value === null || value === undefined) return -1;
  return FACTOR_SORT_RANK[value] ?? 0;
}

interface FactorHeatmapProps {
  rows: FactorHeatmapRow[];
}

export function FactorHeatmap({ rows }: FactorHeatmapProps) {
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  if (rows.length === 0) {
    return (
      <div className="bg-panel border border-edge rounded-lg p-6 text-center text-ink-faint text-sm">
        No positions with factor data. Import a factor CSV or run auto-classify.
      </div>
    );
  }

  // Only show positions that have at least one factor value
  const positionsWithFactors = rows.filter((r) =>
    FACTOR_COLUMNS.some((col) => r[col] !== null)
  );

  const positionsWithoutFactors = rows.filter(
    (r) => !FACTOR_COLUMNS.some((col) => r[col] !== null)
  );

  function handleSort(col: SortColumn) {
    if (sortColumn === col) {
      // Same column: toggle direction, then clear on third click
      if (sortDirection === "desc") {
        setSortDirection("asc");
      } else {
        // Was asc, now clear sort (back to default weight order)
        setSortColumn(null);
        setSortDirection("desc");
      }
    } else {
      // New column: set to descending
      setSortColumn(col);
      setSortDirection("desc");
    }
  }

  // Sort positions based on current sort state
  const sortedPositions = useMemo(() => {
    if (sortColumn === null) return positionsWithFactors;

    return [...positionsWithFactors].sort((a, b) => {
      let cmp: number;

      if (sortColumn === "weight") {
        cmp = a.weight_pct - b.weight_pct;
      } else {
        const rankA = getFactorRank(a[sortColumn]);
        const rankB = getFactorRank(b[sortColumn]);
        // Null values (-1) always sort to bottom regardless of direction
        if (rankA === -1 && rankB === -1) return 0;
        if (rankA === -1) return 1;
        if (rankB === -1) return -1;
        cmp = rankA - rankB;
      }

      return sortDirection === "desc" ? -cmp : cmp;
    });
  }, [positionsWithFactors, sortColumn, sortDirection]);

  /** Render sort indicator arrow for a column header */
  function sortIndicator(col: SortColumn) {
    if (sortColumn !== col) return null;
    return (
      <span className="ml-0.5 text-gold">
        {sortDirection === "desc" ? "▼" : "▲"}
      </span>
    );
  }

  return (
    <div className="bg-panel border border-edge rounded-lg p-4">
      <h3 className="text-sm font-medium text-ink mb-3">
        Factor Heatmap
        <span className="text-ink-faint font-normal ml-2">
          {positionsWithFactors.length} positions
          {positionsWithoutFactors.length > 0 && (
            <> · {positionsWithoutFactors.length} unclassified</>
          )}
        </span>
      </h3>

      <ScrollFade>
        <table className="w-full text-xs" aria-label="Factor exposure heatmap">
          <thead>
            <tr className="border-b border-edge">
              <th className="text-left py-2 pr-2 font-medium text-ink-faint sticky left-0 bg-panel z-10 min-w-[120px]">
                Position
              </th>
              <th
                className="text-right py-2 px-2 font-medium text-ink-faint min-w-[60px] cursor-pointer hover:text-ink-dim select-none"
                onClick={() => handleSort("weight")}
              >
                Weight{sortIndicator("weight")}
              </th>
              {FACTOR_COLUMNS.map((col, colIdx) => (
                <th
                  key={col}
                  className={`text-center py-2 px-1 font-medium text-ink-faint min-w-[72px] cursor-pointer hover:text-ink-dim select-none ${colIdx >= 3 ? "hidden md:table-cell" : ""}`}
                  title={`Sort by ${FACTOR_LABELS[col]}`}
                  onClick={() => handleSort(col)}
                >
                  {FACTOR_LABELS[col]}{sortIndicator(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedPositions.map((row, rowIdx) => (
              <tr key={row.symbol} className="border-b border-edge/30 hover:bg-raised/30">
                <td className="py-1.5 pr-2 sticky left-0 bg-panel z-10">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-ink font-medium">
                      {row.symbol}
                    </span>
                    {row.is_option && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-400 font-medium">
                        OPT
                      </span>
                    )}
                  </div>
                </td>
                <td className="text-right py-1.5 px-2 font-mono text-ink-dim">
                  <Pct value={row.weight_pct} digits={1} />
                </td>
                {FACTOR_COLUMNS.map((col, colIdx) => {
                  const value = row[col];
                  const color = getFactorColor(value);
                  const isHovered =
                    hoveredCell?.row === rowIdx && hoveredCell?.col === colIdx;

                  return (
                    <td
                      key={col}
                      className={`text-center py-1.5 px-1 relative ${colIdx >= 3 ? "hidden md:table-cell" : ""}`}
                      onMouseEnter={() => setHoveredCell({ row: rowIdx, col: colIdx })}
                      onMouseLeave={() => setHoveredCell(null)}
                    >
                      {value ? (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight"
                          style={{
                            backgroundColor: `${color}20`,
                            color: color,
                            border: `1px solid ${color}40`,
                          }}
                        >
                          {value}
                        </span>
                      ) : (
                        <span className="text-ink-faint/30">—</span>
                      )}
                      {isHovered && value && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-canvas border border-edge rounded shadow-lg text-[10px] text-ink whitespace-nowrap z-20">
                          {row.symbol}: {FACTOR_LABELS[col]} = {value}
                          {row.is_option && (
                            <span className="text-violet-400 ml-1">(from underlying)</span>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollFade>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
        {[
          { label: "Low", color: getFactorColor("Low") },
          { label: "Moderate", color: getFactorColor("Moderate") },
          { label: "High", color: getFactorColor("High") },
          { label: "Very High", color: getFactorColor("Very High") },
          { label: "Growth", color: getFactorColor("Growth") },
          { label: "Value", color: getFactorColor("Value") },
        ].map(({ label, color }) => (
          <span
            key={label}
            className="inline-flex items-center gap-1 text-ink-faint"
          >
            <span
              className="w-2 h-2 rounded-sm"
              style={{ backgroundColor: color }}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
