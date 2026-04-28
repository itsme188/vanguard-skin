"use client";

import { useState } from "react";
import { EarningsEmailViewer } from "../components/EarningsEmailViewer";

interface EarningsRowChipsProps {
  eventId: number;
  previewSent: boolean;
  recapSent: boolean;
}

/**
 * Right-side chip cluster on each EarningsHub row. When a phase has been
 * sent (audit row exists), the chip becomes a button that opens the
 * in-app email viewer. Pending chips stay as plain spans.
 */
export function EarningsRowChips({
  eventId,
  previewSent,
  recapSent,
}: EarningsRowChipsProps) {
  const [openPhase, setOpenPhase] = useState<"preview" | "recap" | null>(null);

  return (
    <span className="flex items-center gap-1 shrink-0">
      {previewSent ? (
        <button
          type="button"
          onClick={() => setOpenPhase("preview")}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 cursor-pointer"
          title="View preview email"
        >
          ✓ pre
        </button>
      ) : (
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded text-ink-faint bg-raised"
          title="Preview pending"
        >
          pre
        </span>
      )}
      {recapSent ? (
        <button
          type="button"
          onClick={() => setOpenPhase("recap")}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 cursor-pointer"
          title="View recap email"
        >
          ✓ rec
        </button>
      ) : (
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded text-ink-faint bg-raised"
          title="Recap pending"
        >
          rec
        </span>
      )}
      {openPhase && (
        <EarningsEmailViewer
          eventId={eventId}
          phase={openPhase}
          open={true}
          onClose={() => setOpenPhase(null)}
        />
      )}
    </span>
  );
}
