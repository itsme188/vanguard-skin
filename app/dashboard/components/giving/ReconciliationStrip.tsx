"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReconciliationReport } from "@/lib/compute/donation-reconciliation";
import { Chip } from "../Chip";
import { Money, Shares } from "@/lib/privacy/components";
import { useToast } from "../Toast";
import apiFetch from "@/lib/http/apiFetch";

/**
 * Reconciliation strip (Task 13) — the client island for the six report
 * classes returned by reconcileDonations (spec §7): suggested matches get a
 * one-click Confirm; ambiguous matches, attempts, and legs-missing render
 * informational rows/chips; duplicate suspects + unmatched pairs collapse
 * behind a <details> (DefenseView's diagnostics idiom).
 *
 * Honest-feedback rules (carried ruling): check res.ok AND data.success;
 * when data.data.recomputed === false, surface the specific recompute-
 * failure message instead of a generic success toast; never close/advance
 * UI state before the mutation actually succeeds.
 */
export function ReconciliationStrip({ report }: { report: ReconciliationReport }) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const hasAnything =
    report.suggestedMatches.length > 0 ||
    report.ambiguousMatches.length > 0 ||
    report.attempts.length > 0 ||
    report.legsMissing.length > 0 ||
    report.duplicateSuspects.length > 0 ||
    report.unmatchedPairs.length > 0;

  async function confirmMatch(donationId: number, outTransactionId: number, artifactTransactionId: number | null) {
    setConfirmingId(donationId);
    try {
      const res = await apiFetch(`/api/donations/${donationId}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outTransactionId, artifactTransactionId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast(`Failed to confirm match: ${json.error ?? "unknown error"}`, "error");
        return;
      }
      if (json.data?.recomputed === false) {
        toast(
          `Saved — lot recompute failed: ${json.data.recomputeError ?? "unknown error"}. Retry from the drawer.`,
          "error"
        );
      } else {
        toast("Match confirmed", "success");
      }
      router.refresh();
    } catch (err) {
      toast(`Failed to confirm match: ${err instanceof Error ? err.message : "network error"}`, "error");
    } finally {
      setConfirmingId(null);
    }
  }

  return (
    <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-ink-dim">Reconciliation</h3>
        {!hasAnything && <Chip tone="up">clean</Chip>}
      </div>

      {!hasAnything ? (
        <p className="text-sm text-ink-faint">
          No unmatched transfer legs — every eligible stock donation with a candidate leg is already linked.
        </p>
      ) : (
        <div className="space-y-4">
          {report.suggestedMatches.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-ink-faint mb-2">
                Suggested matches ({report.suggestedMatches.length})
              </h4>
              <ul className="space-y-2">
                {report.suggestedMatches.map(({ donation, outLeg, artifactLeg }) => {
                  const submitting = confirmingId === donation.id;
                  return (
                    <li
                      key={donation.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-edge bg-raised/50 px-3 py-2 text-sm"
                    >
                      <div className="text-ink-dim">
                        <span className="font-mono font-medium text-ink">{outLeg.symbol}</span>{" "}
                        <Shares value={donation.quantity} digits={4} className="text-ink" /> sh ·{" "}
                        <span className="text-ink-faint">
                          received {donation.received_date} → OUT leg {outLeg.trade_date}
                        </span>
                        {artifactLeg && (
                          <span className="text-ink-faint"> · + routing artifact leg</span>
                        )}
                      </div>
                      <button
                        onClick={() => confirmMatch(donation.id, outLeg.id, artifactLeg?.id ?? null)}
                        disabled={submitting}
                        className="px-3 py-1.5 rounded-lg bg-gold text-canvas text-xs font-medium hover:brightness-110 disabled:opacity-50 transition-[filter,scale] active:scale-[0.96] focus-ring"
                      >
                        {submitting ? "Confirming…" : "Confirm"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {report.ambiguousMatches.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-ink-faint mb-2">
                Ambiguous matches ({report.ambiguousMatches.length})
              </h4>
              <ul className="space-y-1.5">
                {report.ambiguousMatches.map(({ donation, candidateLegs }) => (
                  <li key={donation.id} className="text-sm text-ink-dim">
                    {donation.symbol_raw ?? "—"} · {donation.received_date} —{" "}
                    {candidateLegs.length} candidate legs found; resolve manually.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.attempts.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-ink-faint mb-2">
                Transfer attempts ({report.attempts.length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {report.attempts.map((a) => (
                  <Chip
                    key={a.leg.id}
                    tone={a.state === "bounced" ? "down" : "warn"}
                    title={
                      a.state === "bounced" && a.returnLeg
                        ? `Returned ${a.returnLeg.trade_date}`
                        : "No matching return leg yet — likely still settling"
                    }
                  >
                    {a.leg.symbol} · {a.leg.trade_date} · {a.state}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {report.legsMissing.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-ink-faint mb-2">
                Legs missing ({report.legsMissing.length})
              </h4>
              <p className="text-xs text-ink-faint mb-1.5">
                No candidate transfer leg found for these donations — check the source statement/CSV for a routed OUT leg.
              </p>
              <ul className="space-y-1.5">
                {report.legsMissing.map((d) => (
                  <li key={d.id} className="text-sm text-ink-dim">
                    {d.symbol_raw ?? "—"} · {d.received_date} · <Money value={d.fmv_usd} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(report.duplicateSuspects.length > 0 || report.unmatchedPairs.length > 0) && (
            <details className="bg-raised/40 border border-edge rounded-lg p-3">
              <summary className="text-xs text-ink-faint cursor-pointer">
                {report.duplicateSuspects.length} duplicate suspect group
                {report.duplicateSuspects.length === 1 ? "" : "s"}, {report.unmatchedPairs.length} unmatched
                pair{report.unmatchedPairs.length === 1 ? "" : "s"} — informational
              </summary>
              <div className="mt-2 space-y-1.5 text-xs text-ink-dim">
                {report.duplicateSuspects.map((group, i) => (
                  <div key={`dup-${i}`}>
                    Duplicate: {group[0]?.symbol} · {group[0]?.trade_date} · {group[0]?.type} · {group.length} legs
                    with differing amounts
                  </div>
                ))}
                {report.unmatchedPairs.map((p, i) => (
                  <div key={`pair-${i}`}>
                    Unmatched pair: {p.symbol} · {p.date} · <Shares value={p.quantity} digits={4} /> sh
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
