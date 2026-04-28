"use client";

import { useState } from "react";
import { BogeysEditModal } from "./BogeysEditModal";

interface Props {
  eventId: number;
  symbol: string;
  hasBogeys: boolean;
}

/**
 * Inline trigger on each EarningsHub row. Renders a small pencil-style
 * affordance + opens BogeysEditModal. The label hints at the current
 * state — "edit bogeys" when bogeys exist, "+ bogeys" otherwise.
 */
export function BogeysEditButton({ eventId, symbol, hasBogeys }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0 text-ink-faint bg-raised hover:text-gold hover:bg-gold/15"
        title={hasBogeys ? "Edit bogeys + actuals" : "Add bogeys / actuals"}
      >
        {hasBogeys ? "✎ bog" : "+ bog"}
      </button>
      <BogeysEditModal
        eventId={eventId}
        symbol={symbol}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
