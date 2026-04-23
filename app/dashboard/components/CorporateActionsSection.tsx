"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TerminalSection } from "./TerminalSection";

interface CorporateAction {
  id: number;
  actionType: string;
  effectiveDate: string;
  ratioNumerator: number;
  ratioDenominator: number;
  notes: string | null;
  applied: number;
  createdAt: string;
}

export function CorporateActionsSection({
  securityId,
  symbol,
}: {
  securityId: number;
  symbol: string;
}) {
  const router = useRouter();
  const [actions, setActions] = useState<CorporateAction[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [actionType, setActionType] = useState<"SPLIT" | "REVERSE_SPLIT">("SPLIT");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [ratioNum, setRatioNum] = useState("2");
  const [ratioDen, setRatioDen] = useState("1");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    fetch(`/api/corporate-actions?securityId=${securityId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setActions(d.actions);
      });
  }, [securityId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch("/api/corporate-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          securityId,
          actionType,
          effectiveDate,
          ratioNumerator: parseFloat(ratioNum),
          ratioDenominator: parseFloat(ratioDen),
          notes: notes || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setActions((prev) => [data.action, ...prev]);
        setShowForm(false);
        setEffectiveDate("");
        setRatioNum("2");
        setRatioDen("1");
        setNotes("");
        router.refresh();
      } else {
        alert(`Error: ${data.error}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUndo(actionId: number) {
    if (!confirm("Undo this corporate action? This will reverse all adjustments.")) return;

    const res = await fetch(`/api/corporate-actions?id=${actionId}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (data.success) {
      setActions((prev) => prev.filter((a) => a.id !== actionId));
      router.refresh();
    } else {
      alert(`Error: ${data.error}`);
    }
  }

  function formatRatio(num: number, den: number): string {
    return den === 1 ? `${num}:1` : `${num}:${den}`;
  }

  return (
    <TerminalSection
      title="Corporate Actions"
      action={
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            padding: "5px 11px",
            background: "transparent",
            border: "1px solid #333",
            color: "#ffb84d",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            borderRadius: "2px",
            cursor: "pointer",
          }}
        >
          {showForm ? "Cancel" : "+ Add"}
        </button>
      }
    >

      {/* Add form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="px-5 py-4 border-b border-edge bg-raised/50 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-ink-faint block mb-1">Type</label>
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value as "SPLIT" | "REVERSE_SPLIT")}
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink focus-ring"
              >
                <option value="SPLIT">Forward Split</option>
                <option value="REVERSE_SPLIT">Reverse Split</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-ink-faint block mb-1">Effective Date</label>
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                required
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink font-mono focus-ring"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-ink-faint block mb-1">
                {actionType === "SPLIT" ? "New shares per old" : "Numerator"}
              </label>
              <input
                type="number"
                step="any"
                min="0.01"
                value={ratioNum}
                onChange={(e) => setRatioNum(e.target.value)}
                required
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink font-mono focus-ring"
              />
            </div>
            <div>
              <label className="text-xs text-ink-faint block mb-1">Denominator</label>
              <input
                type="number"
                step="any"
                min="0.01"
                value={ratioDen}
                onChange={(e) => setRatioDen(e.target.value)}
                required
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink font-mono focus-ring"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-ink-faint block mb-1">Notes (optional)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., 2:1 forward split"
              className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink focus-ring"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            This will adjust all historical prices, holdings, and tax lots for {symbol} before the effective date.
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-all disabled:opacity-50"
          >
            {submitting ? "Applying..." : "Apply Corporate Action"}
          </button>
        </form>
      )}

      {/* Actions list */}
      {actions.length > 0 ? (
        <div className="divide-y divide-edge/50">
          {actions.map((action) => (
            <div key={action.id} className="px-5 py-3 flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink font-medium">
                    {action.actionType === "SPLIT" ? "Forward Split" : "Reverse Split"}
                  </span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-raised text-ink-dim">
                    {formatRatio(action.ratioNumerator, action.ratioDenominator)}
                  </span>
                  {action.applied ? (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-up/15 text-up">Applied</span>
                  ) : (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-gold/15 text-gold">Pending</span>
                  )}
                </div>
                <div className="text-xs text-ink-faint font-mono">
                  Effective: {action.effectiveDate}
                  {action.notes && <span className="ml-3 text-ink-dim">{action.notes}</span>}
                </div>
              </div>
              <button
                onClick={() => handleUndo(action.id)}
                className="text-xs text-down/70 hover:text-down transition-colors"
                title="Undo this corporate action"
              >
                Undo
              </button>
            </div>
          ))}
        </div>
      ) : (
        !showForm && (
          <div className="px-5 py-6 text-center text-sm text-ink-faint">
            No corporate actions recorded
          </div>
        )
      )}
    </TerminalSection>
  );
}
