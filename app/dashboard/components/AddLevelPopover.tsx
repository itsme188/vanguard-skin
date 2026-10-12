"use client";

import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { useConfirmPrompt } from "./useConfirmPrompt";
import {
  CREATE_DECLINED_MESSAGE,
  createRefusalPrompt,
  type CreateRefusalCode,
} from "@/lib/levels/create-level-prompt";
import { formatChartPrice, formatLevelPrice } from "@/lib/chart/price-formatter";
import apiFetch from "@/lib/http/apiFetch";
import {
  BEYOND_SCAN_RANGE_EXPLANATION,
  isLevelBeyondScanRange,
} from "@/lib/levels/scan-range";

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
  /** Security type — options are exempt from the scanner's plausibility band,
   *  so the "won't alert" warning below must not fire for them. */
  securityType?: string | null;
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
  securityType = null,
}: Props) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState<"support" | "resistance" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const prompt = useConfirmPrompt();
  // The question is portalled to the document body, outside `ref`, so the
  // close-on-outside-click and close-on-Escape listeners below must stand
  // down while it is open: otherwise answering it would close the popover,
  // and unmounting the popover answers the question "no".
  const promptOpen = prompt.isOpen;

  useEffect(() => {
    if (promptOpen) return;
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
  }, [onClose, promptOpen]);

  // Suggest a default based on proximity to current price. User still has to
  // pick (2-click confirm) — we just highlight the likely one so the common
  // case is a straight tap.
  const suggestedType: "support" | "resistance" | null =
    currentPrice == null
      ? null
      : price < currentPrice
        ? "support"
        : "resistance";

  // A level this far from spot can still be saved (the user may be marking
  // structure for later), but the scanner will skip it on every pass, so the
  // popover says so up front. The server asks the arm guard on every create
  // (lib/levels/create-level.ts) and refuses such a level, or one the price is
  // already past, with a 409; submit() then asks "Add anyway?" before
  // resending with `force`.
  const beyondScanRange = isLevelBeyondScanRange(price, currentPrice, securityType);

  async function submit(
    type: "support" | "resistance",
    confirmed: CreateRefusalCode | null = null,
  ) {
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
          force: confirmed !== null,
        }),
      });
      const raw = (await res.clone().json().catch(() => null)) as
        | { code?: unknown; currentPrice?: unknown; effectivePrice?: unknown }
        | null;
      const result = await readMutationResult<{ warning?: unknown }>(res);
      if (!result.ok) {
        const question = createRefusalPrompt(result.status, raw, (p) => formatLevelPrice(currency, p));
        if (question) {
          // Same body, resent with force when the user confirms.
          if (!(await prompt.ask(question))) {
            toast(CREATE_DECLINED_MESSAGE, "info");
            setSubmitting(null);
            return;
          }
          await submit(type, question.code);
          return;
        }
        toast(`Couldn't add the level: ${result.message}`, "error");
        setSubmitting(null);
        return;
      }
      if (confirmed === "beyond_scan_range" || result.data.warning) {
        toast(
          `${symbol} ${type} at ${formatChartPrice(currency, price)} added — but it is outside the scanner's range, so it will not alert`,
          "info",
        );
      } else if (confirmed === "would_fire_immediately") {
        toast(
          `${symbol} ${type} at ${formatChartPrice(currency, price)} added. The price is already past it, so it will alert on the next scan.`,
          "success",
        );
      } else {
        toast(`${symbol} ${type} at ${formatChartPrice(currency, price)} added`, "success");
      }
      window.dispatchEvent(new CustomEvent("level-added"));
      onAdded();
    } catch {
      toast(networkFailureMessage("add the level"), "error");
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
      {beyondScanRange && (
        <p
          className="mb-2.5 text-[11px] leading-snug text-warn"
          title={BEYOND_SCAN_RANGE_EXPLANATION}
        >
          Heads up: this level is outside the scanner&apos;s range and will not
          alert. You can still save it.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => submit("support")}
          disabled={submitting !== null}
          className={`px-3 py-2 text-xs font-medium rounded border transition-colors ${
            suggestedType === "support"
              ? `border-up/50 ${CHIP_TONE_CLASSES.up} hover:bg-up/30`
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
              ? `border-down/50 ${CHIP_TONE_CLASSES.down} hover:bg-down/30`
              : "border-edge bg-raised text-ink-dim hover:text-ink hover:border-edge-strong"
          } disabled:opacity-40`}
        >
          {submitting === "resistance" ? "…" : "Resistance"}
        </button>
      </div>
      <p className="text-[10px] text-ink-faint mt-2">
        Esc or click outside to cancel
      </p>
      {prompt.dialog}
    </div>
  );
}
