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

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ImportHistory({ batches }: { batches: ImportBatch[] }) {
  const router = useRouter();
  const [undoingId, setUndoingId] = useState<number | null>(null);

  if (batches.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-ink-faint text-sm">No imports yet</p>
      </div>
    );
  }

  const handleUndo = async (batchId: number) => {
    setUndoingId(batchId);
    try {
      await fetch(`/api/import?batchId=${batchId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setUndoingId(null);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">Import History</h3>
      <div className="rounded-xl border border-edge overflow-hidden">
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
                    className="text-ink-faint hover:text-down transition-colors disabled:opacity-50"
                    title="Undo import"
                  >
                    {undoingId === batch.id ? (
                      <div className="w-4 h-4 border-2 border-ink-faint border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"
                        />
                      </svg>
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
