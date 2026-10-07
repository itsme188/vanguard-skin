"use client";

import { useEffect, useState } from "react";
import { outOfWeekSaveNote } from "./EarningsHubAddForm";

/** Window event the date chip fires after a successful Fix date. */
export const EARNINGS_DATE_CORRECTED_EVENT = "earnings-date-corrected";

/** How long the notice stays up after a correction. */
export const CORRECTION_NOTE_TTL_MS = 20_000;

/**
 * Survives the chip's own row unmounting. A Fix date that moves a row into
 * another week makes it vanish from the hub after router.refresh(); this
 * shows the same "Saved to the week of …" notice the add form shows. The hub
 * is a server component, so the chip cannot receive a callback prop — it
 * signals through a window event instead. The note is replaced (or cleared,
 * for an in-week fix) by the next correction, ends on its own after
 * CORRECTION_NOTE_TTL_MS, and is dropped when the hub moves to another week
 * (it was written about the week that was on screen).
 */
export function EarningsHubDateCorrectionNote({ weekOf }: { weekOf: string }) {
  const [note, setNote] = useState<{ text: string; weekOf: string } | null>(null);
  useEffect(() => {
    function onCorrected(e: Event) {
      const date = (e as CustomEvent<{ date?: string }>).detail?.date;
      const text = date ? outOfWeekSaveNote(date, weekOf) : null;
      setNote(text ? { text, weekOf } : null);
    }
    window.addEventListener(EARNINGS_DATE_CORRECTED_EVENT, onCorrected);
    return () => window.removeEventListener(EARNINGS_DATE_CORRECTED_EVENT, onCorrected);
  }, [weekOf]);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), CORRECTION_NOTE_TTL_MS);
    return () => clearTimeout(id);
  }, [note]);
  if (!note || note.weekOf !== weekOf) return null;
  return (
    <p role="status" className="text-[11px] text-ink-faint italic">
      {note.text}
    </p>
  );
}
