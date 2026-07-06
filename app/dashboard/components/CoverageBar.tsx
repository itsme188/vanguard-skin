"use client";

import { usePrivacy } from "@/lib/privacy/context";

/**
 * Sector-coverage fill bar for the Defense tab. Under privacy mode the bar
 * WIDTH must not encode the coverage ratio (portfolio-derived) — every bar
 * renders as a uniform full-width dimmed fill, matching the ••• shown by the
 * adjacent <Pct>. Client leaf because privacy state is a client context;
 * the parent DefenseView stays a server component.
 */
export function CoverageBar({ pct }: { pct: number | null }) {
  const { isPrivate } = usePrivacy();
  const widthPct = Math.min(100, Math.max(0, (pct ?? 0) * 100));
  return (
    <div className="h-2 rounded-full bg-raised overflow-hidden">
      <div
        className={`h-full rounded-full bg-gold${isPrivate ? " opacity-30" : ""}`}
        style={{ width: isPrivate ? "100%" : `${widthPct}%` }}
      />
    </div>
  );
}
