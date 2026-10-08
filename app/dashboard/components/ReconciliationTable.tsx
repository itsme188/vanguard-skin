"use client";

import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CHECKPOINT_DIFFERENCE_LEGEND,
  checkpointDifferenceBand,
  checkpointFormBlocker,
  parseCheckpointConflict,
  type ExistingCheckpointSummary,
  type ReconciliationCheckpoint,
} from "@/lib/queries/reconciliation";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { ScrollFade } from "./ScrollFade";
import { Money } from "@/lib/privacy/components";
import apiFetch from "@/lib/http/apiFetch";
import { todayET } from "@/lib/calendar/date-utils";

interface Account {
  id: number;
  name: string;
}

export function ReconciliationTable({
  checkpoints,
  accounts,
}: {
  checkpoints: ReconciliationCheckpoint[];
  accounts: Account[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    accountId: accounts[0]?.id?.toString() ?? "",
    checkpointDate: "",
    statementValue: "",
    notes: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  // The saved checkpoint a refused save would replace; set only by a 409.
  const [replaceTarget, setReplaceTarget] = useState<ExistingCheckpointSummary | null>(null);

  // The Eastern day: the latest date a statement can carry. The route refuses
  // a later one with the same message.
  const today = todayET();
  const formBlocker = checkpointFormBlocker(formData, today);
  const isFormValid = formBlocker === null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void saveCheckpoint();
  }

  // `replaceCheckpointId` is sent only after the user confirmed replacing that row.
  async function saveCheckpoint(replaceCheckpointId?: number) {
    if (!isFormValid) return;
    setReplaceTarget(null);
    setIsSubmitting(true);
    try {
      const res = await apiFetch("/api/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: parseInt(formData.accountId, 10),
          checkpointDate: formData.checkpointDate,
          statementValue: parseFloat(formData.statementValue),
          notes: formData.notes || undefined,
          ...(replaceCheckpointId !== undefined ? { replaceCheckpointId } : {}),
        }),
      });
      const conflict =
        res.status === 409
          ? parseCheckpointConflict(await res.clone().json().catch(() => null))
          : null;
      const result = await readMutationResult(res);
      if (conflict) {
        // Nothing was written: keep the form filled and ask before replacing.
        setError(null);
        setReplaceTarget(conflict);
      } else if (result.ok) {
        setShowForm(false);
        setFormData({ accountId: accounts[0]?.id?.toString() ?? "", checkpointDate: "", statementValue: "", notes: "" });
        setError(null);
        toast(replaceCheckpointId !== undefined ? "Checkpoint replaced" : "Checkpoint saved", "success");
        router.refresh();
      } else {
        setError(`Couldn't save the checkpoint: ${result.message}`);
      }
    } catch {
      setError(networkFailureMessage("save the checkpoint"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    setDeleteTarget(null);
    try {
      const res = await apiFetch(`/api/reconciliation?id=${id}`, { method: "DELETE" });
      const result = await readMutationResult(res);
      if (!result.ok) {
        setError(`Couldn't remove the checkpoint: ${result.message}`);
        return;
      }
      setError(null);
      toast("Checkpoint removed", "success");
      router.refresh();
    } catch {
      setError(networkFailureMessage("remove the checkpoint"));
    }
  }

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove checkpoint"
        message="Are you sure you want to remove this reconciliation checkpoint? This cannot be undone."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => deleteTarget !== null && handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={replaceTarget !== null}
        title="Replace the saved checkpoint?"
        message={
          replaceTarget
            ? `A checkpoint is already saved for ${replaceTarget.account_name} on ${replaceTarget.checkpoint_date}. Nothing has been changed yet. Replacing it overwrites its statement value and its note with what you just entered. This cannot be undone. Cancel to keep it and pick another date.`
            : ""
        }
        confirmLabel="Replace"
        variant="danger"
        onConfirm={() => replaceTarget !== null && saveCheckpoint(replaceTarget.id)}
        onCancel={() => setReplaceTarget(null)}
      >
        {replaceTarget && (
          <dl className="mt-3 rounded-lg border border-edge bg-raised px-3 py-2 text-xs space-y-1">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-dim">Saved statement value</dt>
              <dd className="font-mono tabular-nums text-ink">
                <Money value={replaceTarget.statement_value} precise />
              </dd>
            </div>
            <div>
              <dt className="text-ink-dim">Saved note</dt>
              <dd className="text-ink whitespace-normal break-words">
                {replaceTarget.notes ?? "No note"}
              </dd>
            </div>
          </dl>
        )}
      </ConfirmDialog>

      {error && (
        <div role="alert" className="rounded-lg bg-down-tint border border-down/30 px-4 py-2 text-sm text-down flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-down hover:text-ink transition-colors ml-2 focus-ring" aria-label="Dismiss error">&times;</button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink-dim">Checkpoints</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 rounded-lg bg-raised border border-edge text-sm font-medium text-ink-dim hover:text-ink hover:border-edge-strong transition-[color,border-color,scale] active:scale-[0.96] focus-ring"
        >
          {showForm ? "Cancel" : "+ Add Checkpoint"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-edge bg-panel p-5 space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="recon-account" className="block text-xs font-medium text-ink-faint mb-1.5">
                Account
              </label>
              <select
                id="recon-account"
                value={formData.accountId}
                onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="recon-date" className="block text-xs font-medium text-ink-faint mb-1.5">
                Date
              </label>
              <input
                id="recon-date"
                type="date"
                value={formData.checkpointDate}
                onChange={(e) => setFormData({ ...formData, checkpointDate: e.target.value })}
                required
                max={today}
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink font-mono"
              />
            </div>
            <div>
              <label htmlFor="recon-value" className="block text-xs font-medium text-ink-faint mb-1.5">
                Statement Value ($)
              </label>
              <input
                id="recon-value"
                type="number"
                step="0.01"
                min="0.01"
                value={formData.statementValue}
                onChange={(e) => setFormData({ ...formData, statementValue: e.target.value })}
                required
                placeholder="0.00"
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink font-mono"
              />
            </div>
            <div>
              <label htmlFor="recon-notes" className="block text-xs font-medium text-ink-faint mb-1.5">
                Notes (optional)
              </label>
              <input
                id="recon-notes"
                type="text"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="e.g., From January statement"
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-3">
            {formBlocker && (
              <p id="recon-save-blocker" className="text-xs text-ink-dim">
                {formBlocker}
              </p>
            )}
            <button
              type="submit"
              disabled={isSubmitting || !isFormValid}
              title={formBlocker ?? undefined}
              aria-describedby={formBlocker ? "recon-save-blocker" : undefined}
              className="px-5 py-2 rounded-lg bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
            >
              {isSubmitting ? "Saving..." : "Save Checkpoint"}
            </button>
          </div>
        </form>
      )}

      {checkpoints.length > 0 ? (
        <div className="rounded-xl border border-edge overflow-hidden">
          <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Account</th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Date</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Statement</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Computed</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs">Difference</th>
                <th className="text-left px-4 py-2.5 text-ink-faint font-medium text-xs">Notes</th>
                <th className="text-right px-4 py-2.5 text-ink-faint font-medium text-xs"></th>
              </tr>
            </thead>
            <tbody>
              {checkpoints.map((cp) => {
                const band = checkpointDifferenceBand(cp.difference);

                return (
                  <tr
                    key={cp.id}
                    className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                  >
                    <td className="px-4 py-3 text-ink-dim text-xs">{cp.account_name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-faint">{cp.checkpoint_date}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Money value={cp.statement_value} precise />
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      <Money value={cp.computed_value} precise />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {band !== null ? (
                        <span
                          title={band.label}
                          className={`font-mono font-medium tabular-nums text-xs px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                            band.band === "match"
                              ? "bg-up/20 text-up"
                              : band.band === "close"
                                ? "bg-gold/20 text-gold-ink"
                                : "bg-down/20 text-down"
                          }`}
                        >
                          <span aria-hidden="true">{band.glyph}</span>
                          <span className="sr-only">{band.label}: </span>
                          <Money value={cp.difference} precise signed />
                        </span>
                      ) : (
                        <span className="text-ink-faint text-xs">&mdash;</span>
                      )}
                    </td>
                    <td
                      title={cp.notes ?? undefined}
                      className="px-4 py-3 text-ink-faint text-xs whitespace-normal break-words min-w-[150px] max-w-[320px]"
                    >
                      {cp.notes ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setDeleteTarget(cp.id)}
                        className="relative text-xs text-ink-faint hover:text-down transition-colors focus-ring pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
                        aria-label={`Remove checkpoint for ${cp.account_name} on ${cp.checkpoint_date}`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </ScrollFade>
          <p className="border-t border-edge px-4 py-2 text-xs text-ink-dim">
            Difference: {CHECKPOINT_DIFFERENCE_LEGEND}
          </p>
        </div>
      ) : (
        !showForm && (
          <EmptyState
            icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
            title="No checkpoints yet"
            description="Add a checkpoint to compare your statement values against computed portfolio values."
          />
        )
      )}
    </div>
  );
}
