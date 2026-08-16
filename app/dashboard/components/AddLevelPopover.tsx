"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { formatChartPrice } from "@/lib/chart/price-formatter";
import apiFetch from "@/lib/http/apiFetch";

interface Props {
  securityId: number;
  symbol: string;
  price: number;
  currentPrice: number | null;
  x: number;
  y: number;
  onClose: () => void;
  onAdded: () => void;
  /** Security's native currency (e.g. "KRW"). The clicked price is native —
   *  see SecurityChart — so the label here must match instead of assuming USD. */
  currency?: string | null;
}

export function AddLevelPopover({
  securityId,
  symbol,
  price,
  currentPrice,
  x,
  y,
  onClose,
  onAdded,
  currency,
}: Props) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState<"support" | "resistance" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  // Suggest a default based on proximity to current price. User still has to
  // pick (2-click confirm) — we just highlight the likely one so the common
  // case is a straight tap.
  const suggestedType: "support" | "resistance" | null =
    currentPrice == null
      ? null
      : price < currentPrice
        ? "support"
        : "resistance";

  async function submit(type: "support" | "resistance") {
    setSubmitting(type);
    try {
      const res = await apiFetch("/api/levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          security_id: securityId,
          level_type: type,
          price,
          price_source: "static",
          direction: null,
          action_hint: "watch",
          source: "user",
          source_author: "Me",
          thesis: `Added by chart click at ${formatChartPrice(currency, price)}`,
          timeframe: null,
          expires_at: null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast(`Failed to add level: ${json.error ?? "unknown"}`, "error");
        setSubmitting(null);
        return;
      }
      toast(`${symbol} ${type} at ${formatChartPrice(currency, price)} added`, "success");
      window.dispatchEvent(new CustomEvent("level-added"));
      onAdded();
    } catch (e) {
      toast(`Failed to add level: ${e instanceof Error ? e.message : "error"}`, "error");
      setSubmitting(null);
    }
  }

  // Position the popover so it doesn't fall off the right / bottom of the chart.
  // The parent chart container uses position: relative.
  // Inline backgroundColor mirrors the 790d317 fix — bg-panel can degrade to
  // translucent under iOS Safari's backdrop-filter parents; CSS-var fallback
  // keeps the popover legible when tapped on the security-detail chart.
  const style: React.CSSProperties = {
    left: x,
    top: y,
    transform: "translate(-50%, 8px)",
    backgroundColor: "var(--panel)",
  };

  return (
    <div
      ref={ref}
      style={style}
      className="absolute z-30 rounded-lg border border-edge-strong bg-panel shadow-xl p-3 min-w-[220px]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-baseline justify-between mb-2.5">
        <span className="font-mono text-sm font-semibold text-ink">
          {formatChartPrice(currency, price)}
        </span>
        <button
          onClick={onClose}
          className="text-ink-faint hover:text-ink text-lg leading-none"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => submit("support")}
          disabled={submitting !== null}
          className={`px-3 py-2 text-xs font-medium rounded border transition-colors ${
            suggestedType === "support"
              ? "border-up/50 bg-up/20 text-up hover:bg-up/30"
              : "border-edge bg-raised text-ink-dim hover:text-ink hover:border-edge-strong"
          } disabled:opacity-40`}
        >
          {submitting === "support" ? "…" : "Support"}
        </button>
        <button
          onClick={() => submit("resistance")}
          disabled={submitting !== null}
          className={`px-3 py-2 text-xs font-medium rounded border transition-colors ${
            suggestedType === "resistance"
              ? "border-down/50 bg-down/20 text-down hover:bg-down/30"
              : "border-edge bg-raised text-ink-dim hover:text-ink hover:border-edge-strong"
          } disabled:opacity-40`}
        >
          {submitting === "resistance" ? "…" : "Resistance"}
        </button>
      </div>
      <p className="text-[10px] text-ink-faint mt-2">
        Esc or click outside to cancel
      </p>
    </div>
  );
}
