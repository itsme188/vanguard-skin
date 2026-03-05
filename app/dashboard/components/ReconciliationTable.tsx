"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReconciliationCheckpoint } from "@/lib/queries/reconciliation";

function formatCurrency(value: number | null): string {
  if (value === null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

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
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    accountId: accounts[0]?.id?.toString() ?? "",
    checkpointDate: "",
    statementValue: "",
    notes: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: parseInt(formData.accountId, 10),
          checkpointDate: formData.checkpointDate,
          statementValue: parseFloat(formData.statementValue),
          notes: formData.notes || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowForm(false);
        setFormData({ accountId: accounts[0]?.id?.toString() ?? "", checkpointDate: "", statementValue: "", notes: "" });
        router.refresh();
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Remove this checkpoint?")) return;
    try {
      const res = await fetch(`/api/reconciliation?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete checkpoint");
      setError(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-down-tint border border-down/30 px-4 py-2 text-sm text-down flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-down hover:text-ink transition-colors ml-2">&times;</button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink-dim">Checkpoints</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 rounded-lg bg-raised border border-edge text-sm font-medium text-ink-dim hover:text-ink hover:border-edge-strong transition-all"
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
              <label className="block text-xs font-medium text-ink-faint mb-1.5">
                Account
              </label>
              <select
                value={formData.accountId}
                onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink focus:outline-none focus:border-gold"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5">
                Date
              </label>
              <input
                type="date"
                value={formData.checkpointDate}
                onChange={(e) => setFormData({ ...formData, checkpointDate: e.target.value })}
                required
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink font-mono focus:outline-none focus:border-gold"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5">
                Statement Value ($)
              </label>
              <input
                type="number"
                step="0.01"
                value={formData.statementValue}
                onChange={(e) => setFormData({ ...formData, statementValue: e.target.value })}
                required
                placeholder="0.00"
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink font-mono focus:outline-none focus:border-gold"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5">
                Notes (optional)
              </label>
              <input
                type="text"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="e.g., From January statement"
                className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink focus:outline-none focus:border-gold"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 rounded-lg bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-all disabled:opacity-50"
            >
              {isSubmitting ? "Saving..." : "Save Checkpoint"}
            </button>
          </div>
        </form>
      )}

      {checkpoints.length > 0 ? (
        <div className="rounded-xl border border-edge overflow-hidden">
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
                const diffAbs = cp.difference !== null ? Math.abs(cp.difference) : null;
                const isMatch = diffAbs !== null && diffAbs < 0.01;
                const isClose = diffAbs !== null && diffAbs < 100;

                return (
                  <tr
                    key={cp.id}
                    className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                  >
                    <td className="px-4 py-3 text-ink-dim text-xs">{cp.account_name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-faint">{cp.checkpoint_date}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                      {formatCurrency(cp.statement_value)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      {formatCurrency(cp.computed_value)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {cp.difference !== null ? (
                        <span
                          className={`font-mono tabular-nums text-xs px-2 py-0.5 rounded ${
                            isMatch
                              ? "bg-up-tint text-up"
                              : isClose
                                ? "bg-gold-glow text-gold"
                                : "bg-down-tint text-down"
                          }`}
                        >
                          {cp.difference >= 0 ? "+" : ""}
                          {formatCurrency(cp.difference)}
                        </span>
                      ) : (
                        <span className="text-ink-faint text-xs">&mdash;</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-faint text-xs truncate max-w-[150px]">
                      {cp.notes ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(cp.id)}
                        className="text-xs text-ink-faint hover:text-down transition-colors"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        !showForm && (
          <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
            <p className="text-ink-faint text-sm">
              No reconciliation checkpoints yet. Add a checkpoint to compare your statement values
              against computed portfolio values.
            </p>
          </div>
        )
      )}
    </div>
  );
}
