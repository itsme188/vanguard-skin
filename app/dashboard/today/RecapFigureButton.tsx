"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * Clickable wrapper for headline consensus/actual figures on a recapped
 * EarningsHub row (R9, 2026-07-16): clicking the numbers opens the same
 * recap viewer the "rec ✓" chip does. The row's single viewer instance
 * lives in EarningsRowChips — this dispatches the scoped
 * `open-earnings-email` custom event instead of mounting a second viewer
 * (same custom-DOM-event idiom as earnings-data-changed / open-settings).
 *
 * Dense-table touch rule: ±6px vertical hit extension only (SymbolLink
 * precedent) so adjacent rows can't steal each other's taps.
 */
export function RecapFigureButton({
  eventId,
  phase = "recap",
  className,
  style,
  children,
}: {
  eventId: number;
  phase?: "preview" | "recap";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("open-earnings-email", { detail: { eventId, phase } }),
        )
      }
      className={`relative cursor-pointer text-left hover:underline decoration-dotted underline-offset-2 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:inset-x-0 ${className ?? ""}`}
      style={style}
      title={`View the ${phase} email`}
    >
      {children}
    </button>
  );
}
