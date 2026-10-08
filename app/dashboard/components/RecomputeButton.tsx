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
      {summary && (
        <div className="max-w-xl rounded-lg border border-edge bg-panel p-3 text-xs text-ink-dim">
          <div className="font-medium text-ink">Recompute preview</div>
          <div className="mt-2 space-y-1">
            {summary.years.map((year) => (
              <div key={year.taxYear} className="grid grid-cols-1 gap-1 border-t border-edge/60 pt-2 first:border-t-0 first:pt-0">
                <div className="font-mono text-ink">{year.taxYear}</div>
                <div>
                  Realized: <Money value={year.realizedGainBefore} /> →{" "}
                  <Money value={year.realizedGainAfter} />
                </div>
                <div>
                  Lots opened <Count value={year.lotsOpened} />, closed{" "}
                  <Count value={year.lotsClosed} />, changed{" "}
                  <Count value={year.lotsChanged} />
                </div>
                <div>
                  Engine closes added <Count value={year.engineClosesAdded} />, removed{" "}
                  <Count value={year.engineClosesRemoved} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
