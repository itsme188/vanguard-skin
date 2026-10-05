"use client";

import { useEffect, useState } from "react";
import { outOfWeekSaveNote } from "./EarningsHubAddForm";

/** Window event the date chip fires after a successful Fix date. */
export const EARNINGS_DATE_CORRECTED_EVENT = "earnings-date-corrected";

/**
 * Survives the chip's own row unmounting. A Fix date that moves a row into
 * another week makes it vanish from the hub after router.refresh(); this
 * shows the same "Saved to the week of …" notice the add form shows. The hub
 * is a server component, so the chip cannot receive a callback prop — it
 * signals through a window event instead. The note is replaced (or cleared,
 * for an in-week fix) by the next correction.
 */
export function EarningsHubDateCorrectionNote({ weekOf }: { weekOf: string }) {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    function onCorrected(e: Event) {
      const date = (e as CustomEvent<{ date?: string }>).detail?.date;
      setNote(date ? outOfWeekSaveNote(date, weekOf) : null);
    }
    window.addEventListener(EARNINGS_DATE_CORRECTED_EVENT, onCorrected);
    return () => window.removeEventListener(EARNINGS_DATE_CORRECTED_EVENT, onCorrected);
  }, [weekOf]);
  if (!note) return null;
  return (
    <p role="status" className="text-[11px] text-ink-faint italic">
      {note}
    </p>
  );
}
