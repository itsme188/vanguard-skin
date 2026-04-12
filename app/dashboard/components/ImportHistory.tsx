"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ImportBatch } from "@/lib/types";

const SOURCE_LABELS: Record<string, string> = {
  "ibkr-activity": "IBKR Activity",
  "ibkr-holdings": "IBKR Holdings",
  "monthly-values": "Monthly Values",
  "vanguard-cost-basis": "Vanguard Cost Basis",
  "vanguard-holdings": "Vanguard Holdings",
  "vanguard-pdf": "Vanguard Statement",
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const mon = MONTHS[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${mon} ${day}, ${year}, ${h12}:${m} ${ampm}`;
}

export function ImportHistory({ batches }: { batches: ImportBatch[] }) {
  const router = useRouter();
  const [undoingId, setUndoingId] = useState<number | null>(null);

  if (batches.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-medium text-ink-dim mb-3">Import History</h3>
        <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
          <p className="text-ink-faint text-sm">
            No imports yet. Drop files above to get started.
          </p>
        </div>
      </div>
    );
  }

  const [undoError, setUndoError] = useState<string | null>(null);

  const handleUndo = async (batchId: number) => {
    if (!confirm("Undo this import? This will delete all records from this batch and recompute tax lots.")) return;
    setUndoingId(batchId);
    setUndoError(null);
    try {
      const res = await fetch(`/api/import?batchId=${batchId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Undo failed" }));
        setUndoError(data.error ?? "Undo failed");
        return;
      }
      router.refresh();
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : "Undo failed");
    } finally {
      setUndoingId(null);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">Import History</h3>
      {undoError && (
        <div className="mb-3 px-3 py-2 bg-down/10 text-down text-xs rounded-lg">
          {undoError}
        </div>
      )}
      <div className="rounded-xl border border-edge overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge bg-panel">
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                File
              </th>
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Type
              </th>
              <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                Records
              </th>
              <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                Date
              </th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr
                key={batch.id}
                className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
              >
                <td className="px-4 py-3 text-ink">
                  {batch.filename ?? "\u2014"}
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs px-2 py-0.5 rounded bg-blue-tint text-blue font-mono">
                    {SOURCE_LABELS[batch.source_type] ?? batch.source_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-ink-dim tabular-nums">
                  {batch.record_count}
                </td>
                <td className="px-4 py-3 text-ink-dim text-xs">
                  {formatDate(batch.created_at)}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleUndo(batch.id)}
                    disabled={undoingId === batch.id}
                    className="text-xs text-ink-faint hover:text-down transition-colors disabled:opacity-50"
                  >
                    {undoingId === batch.id ? (
                      <div className="w-4 h-4 border-2 border-ink-faint border-t-transparent rounded-full animate-spin" />
                    ) : (
                      "Undo"
                    )}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
