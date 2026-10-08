"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./Toast";
import apiFetch from "@/lib/http/apiFetch";
import { Count, Money } from "@/lib/privacy/components";
import type { TaxLotRecomputeSummary } from "@/lib/compute/tax-lot-recompute-summary";

export function RecomputeButton({
  endpoint,
  label,
  completionEventName,
}: {
  endpoint: string;
  label: string;
  completionEventName?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [summary, setSummary] = useState<TaxLotRecomputeSummary | null>(null);

  async function handleClick() {
    setIsLoading(true);
    try {
      const res = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: summary ? JSON.stringify({ confirmRecompute: true }) : undefined,
      });
      const data = await res.json();
      if (data.success) {
        if (data.data?.requiresConfirmation) {
          setSummary(data.data.summary as TaxLotRecomputeSummary);
          toast(`${label} preview ready`, "success");
        } else {
          setSummary(null);
          toast(`${label} complete`, "success");
          if (completionEventName) window.dispatchEvent(new CustomEvent(completionEventName));
          router.refresh();
        }
      } else {
        toast(`${label} failed: ${data.error}`, "error");
      }
    } catch {
      toast("Failed to connect to server", "error");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleClick}
        disabled={isLoading}
        title={isLoading ? "Computing..." : undefined}
        className="px-4 py-2 rounded-lg bg-raised border border-edge text-sm font-medium text-ink-dim hover:text-ink hover:border-edge-strong transition-[color,border-color,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
      >
        {isLoading ? "Computing..." : summary ? "Confirm recompute" : label}
      </button>
      {summary && !isLoading && (
        <button
          type="button"
          onClick={() => setSummary(null)}
          className="ml-2 px-4 py-2 rounded-lg border border-edge text-sm font-medium text-ink-dim hover:text-ink hover:border-edge-strong focus-ring"
        >
          Cancel
        </button>
      )}
      {summary && (
        <div className="max-w-xl rounded-lg border border-edge bg-panel p-3 text-xs text-ink-dim">
          <div className="font-medium text-ink">Recompute preview</div>
          <div className="mt-2 space-y-1">
            {summary.years.map((year) => (
              <div key={year.taxYear} className="grid grid-cols-1 gap-1 border-t border-edge/60 pt-2 first:border-t-0 first:pt-0">
                <div className="font-mono text-ink">{year.taxYear} (year of sale)</div>
                <div>
                  Realized: <Money value={year.realizedGainBefore} /> →{" "}
                  <Money value={year.realizedGainAfter} />
                </div>
                <div>
                  Lot sales added <Count value={year.lotSalesAdded} />, removed{" "}
                  <Count value={year.lotSalesRemoved} />
                </div>
                <div>
                  Engine closes added <Count value={year.engineClosesAdded} />, removed{" "}
                  <Count value={year.engineClosesRemoved} />
                </div>
              </div>
            ))}
            <div className="grid grid-cols-1 gap-1 border-t border-edge/60 pt-2 first:border-t-0 first:pt-0">
              <div className="text-ink">Open lots (not sold, so in no tax year)</div>
              <div>
                Count: <Count value={summary.openLots.before} /> →{" "}
                <Count value={summary.openLots.after} />
              </div>
              <div>
                New or changed <Count value={summary.openLots.added} />, gone or changed{" "}
                <Count value={summary.openLots.removed} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
