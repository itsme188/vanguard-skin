"use client";

import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ImportBatch } from "@/lib/types";
import { parseStoredTimestamp } from "@/lib/format";
import apiFetch from "@/lib/http/apiFetch";
import { ScrollFade } from "./ScrollFade";
import { useConfirmPrompt } from "./useConfirmPrompt";

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
  // created_at is SQLite datetime('now') — UTC with no tz marker. Parse as UTC
  // (not local) so an evening import doesn't render as the next calendar day.
  const d = parseStoredTimestamp(dateStr);
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
  const [undoError, setUndoError] = useState<string | null>(null);
  // Before the early return below: hooks run in the same order every render.
  const prompt = useConfirmPrompt();

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

  const handleUndo = async (batch: ImportBatch) => {
    const batchId = batch.id;
    const label = SOURCE_LABELS[batch.source_type] ?? batch.source_type;
    const name = batch.filename ?? "unnamed file";
    const when = formatDate(batch.created_at);
    if (
      !(await prompt.ask({
        title: `Undo import "${name}"?`,
        message:
          `${label}, ${when}. This will delete all records from this batch and recompute tax lots.\n\n` +
          `A recovery snapshot is saved first, in the "undo-recovery" folder beside the database. There is no Restore button in the app: restoring a batch means running scripts/restore-import-batch.ts from a terminal in the project folder.`,
        confirmLabel: "Undo import",
        variant: "danger",
      }))
    )
      return;
    setUndoingId(batchId);
    setUndoError(null);
    try {
      // Deliberate two-step (task 20, §G): the first DELETE returns a
      // short-lived, single-use confirmation token; the second presents it.
      // A stray or replayed DELETE therefore can't unwind a batch on its own.
      const challenge = await apiFetch(`/api/import?batchId=${batchId}`, { method: "DELETE" });
      const challengeData = await challenge.json().catch(() => null);
      if (!challenge.ok || !challengeData?.requiresConfirmation || !challengeData?.confirmToken) {
        setUndoError(
          typeof challengeData?.error === "string" && challengeData.error
            ? challengeData.error
            : `Couldn't undo the import: the server returned an error (HTTP ${challenge.status}).`,
        );
        return;
      }

      const confirmToken = encodeURIComponent(challengeData.confirmToken as string);
      const res = await apiFetch(
        `/api/import?batchId=${batchId}&confirm=${confirmToken}`,
        { method: "DELETE" },
      );
      const result = await readMutationResult(res);
      if (!result.ok) {
        setUndoError(`Couldn't undo the import: ${result.message}`);
        return;
      }
      router.refresh();
    } catch {
      setUndoError(networkFailureMessage("undo the import"));
    } finally {
      setUndoingId(null);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">Import History</h3>
      {prompt.dialog}
      {undoError && (
        <div className="mb-3 px-3 py-2 bg-down/20 text-down text-xs font-medium rounded-lg">
          {undoError}
        </div>
      )}
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                  File
                </th>
                <th className="w-16 px-4 py-2.5 text-left text-ink-faint font-medium text-xs">Undo</th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Type
                </th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Records
                </th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">
                  Date
                </th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                >
                  <td className="px-4 py-3 text-ink" title={batch.filename ?? undefined}>
                    <div className="truncate max-w-[14rem] md:max-w-[26rem]">{batch.filename ?? "—"}</div>
                    {batch.summary && (
                      <div className="text-xs text-ink-faint truncate max-w-[14rem] md:max-w-[26rem]" title={batch.summary}>
                        {batch.summary}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-left">
                    <button
                      onClick={() => handleUndo(batch)}
                      disabled={undoingId === batch.id}
                      className="relative text-xs text-ink-faint hover:text-down transition-colors disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
                    >
                      {undoingId === batch.id ? (
                        <div className="w-4 h-4 border-2 border-ink-faint border-t-transparent rounded-full animate-spin" />
                      ) : (
                        "Undo"
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="text-xs px-2 py-0.5 rounded bg-blue/20 text-blue font-mono font-medium">
                      {SOURCE_LABELS[batch.source_type] ?? batch.source_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-ink-dim tabular-nums">
                    {batch.record_count}
                  </td>
                  <td className="px-4 py-3 text-ink-dim text-xs whitespace-nowrap">
                    {formatDate(batch.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}
