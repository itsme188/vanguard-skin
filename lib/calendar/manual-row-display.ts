/**
 * How a hand-entered earnings row is worded on screen. DISPLAY ONLY: nothing
 * here is stored, and nothing here decides a gate, a sweep or an email.
 *
 * A plain module on purpose (no client directive, no React, no database): the
 * Today releases block is a client module and the week view is a Server
 * Component, and a Server Component may not call a client module's function.
 * Both import the one rule from here, so it cannot drift between screens.
 */
import type { CalendarEvent } from "@/lib/types";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";

/** The words a screen prints on a row the owner entered by hand. */
export const HAND_ENTERED_LABEL = "Entered by you";

/**
 * Manual earnings rows are titled "<SYM> earnings (Manual entry)", which names
 * the source instead of the slot. When the row's own slot is known (event_time
 * or raw_json only, via deriveEarningsSlot), print it the way the vendor rows
 * do. Display only; the stored title is never rewritten.
 */
export function slotAwareTitle(
  event: Pick<CalendarEvent, "title" | "event_time" | "raw_json" | "event_type">,
): string {
  const title = event.title;
  if (!title || event.event_type !== "earnings" || !/\(Manual entry\)\s*$/.test(title)) return title;
  const slot = deriveEarningsSlot({ event_time: event.event_time, raw_json: event.raw_json });
  if (!slot) return title;
  return title.replace(
    /\(Manual entry\)\s*$/,
    slot === "bmo" ? "(Before Market Open)" : "(After Market Close)",
  );
}
