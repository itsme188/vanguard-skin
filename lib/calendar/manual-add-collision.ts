/**
 * "Is there already a hand-entered row on this exact symbol, date and type?"
 * Asked by POST /api/calendar/events before it writes, because the answer the
 * user needs depends on whether that row can be seen.
 *
 *  - SHOWING: the old answer stands. The row is on the calendar; edit it.
 *  - HIDDEN: the row is on no calendar surface (another entry for the same
 *    print took its place, or a confirm folded it away), so "edit it" sends
 *    the user looking for something that is not there. The refusal says the
 *    entry is hidden and, when one can be found, names the entry showing in
 *    its place.
 *
 * Read-only. The hidden row is deliberately NOT brought back here: its
 * bogeys, email records and arm were moved to the entry that replaced it, so
 * a revived row would be an empty second card for the same print, and the
 * add's own slot and time would be silently dropped in favour of the old
 * row's. Bringing a hidden hand-entered row back stays the reconciler's
 * decision (it does so for a row dated today or later).
 */
import type Database from "better-sqlite3";
import { addDays } from "@/lib/calendar/date-utils";
import { issuerSiblings } from "@/lib/securities/issuer-family";

/**
 * How far apart two rows of one company can sit and still be one print to the
 * reconciler (`CLUSTER_PROXIMITY_DAYS`, private to
 * lib/calendar/reconcile-earnings-dates.ts). Used only to pick which showing
 * entry to NAME in a message; nothing is decided by it.
 */
const SAME_PRINT_DAYS = 14;

export type ManualAddCollision =
  | { kind: "showing"; eventId: number }
  | {
      kind: "hidden";
      eventId: number;
      /** The showing earnings entry nearest the hidden one, or null. */
      replacedBy: { eventId: number; eventDate: string; source: string } | null;
    };

export function findManualAddCollision(
  db: Database.Database,
  input: { symbol: string; eventDate: string; eventType: string },
): ManualAddCollision | null {
  const symbol = input.symbol.trim().toUpperCase();
  const existing = db
    .prepare(
      `SELECT id, COALESCE(superseded, 0) AS superseded
         FROM calendar_events WHERE source_key = ?`,
    )
    .get(`manual:${symbol}:${input.eventDate}:${input.eventType}`) as
    | { id: number; superseded: number }
    | undefined;
  if (!existing) return null;
  if (existing.superseded === 0) return { kind: "showing", eventId: existing.id };
  if (input.eventType !== "earnings") {
    return { kind: "hidden", eventId: existing.id, replacedBy: null };
  }

  const family = [...new Set([symbol, ...issuerSiblings(symbol).map((s) => s.trim().toUpperCase())])];
  const nearby = db
    .prepare(
      `SELECT id, event_date, source FROM calendar_events
        WHERE event_type = 'earnings'
          AND COALESCE(superseded, 0) = 0
          AND UPPER(symbol) IN (${family.map(() => "?").join(", ")})
          AND event_date BETWEEN ? AND ?
        ORDER BY id`,
    )
    .all(
      ...family,
      addDays(input.eventDate, -SAME_PRINT_DAYS),
      addDays(input.eventDate, SAME_PRINT_DAYS),
    ) as { id: number; event_date: string; source: string }[];
  const distance = (date: string) =>
    Math.abs(Date.parse(`${date}T12:00:00Z`) - Date.parse(`${input.eventDate}T12:00:00Z`));
  // Nearest date first; the query order (lowest id) breaks a tie.
  const nearest = nearby.reduce<(typeof nearby)[number] | null>(
    (best, row) => (best === null || distance(row.event_date) < distance(best.event_date) ? row : best),
    null,
  );
  return {
    kind: "hidden",
    eventId: existing.id,
    replacedBy: nearest
      ? { eventId: nearest.id, eventDate: nearest.event_date, source: nearest.source }
      : null,
  };
}

/** The refusal text for each kind, ready to render. Nothing was written. */
export function manualAddCollisionMessage(
  collision: ManualAddCollision,
  input: { symbol: string; eventDate: string; eventType: string },
): string {
  const symbol = input.symbol.trim().toUpperCase();
  if (collision.kind === "showing") {
    return `A manual calendar event already exists for ${symbol} on ${input.eventDate} (${input.eventType}). Edit it instead.`;
  }
  const lead = `You already entered ${symbol} for ${input.eventDate}, and that entry is hidden`;
  if (!collision.replacedBy) {
    return `${lead}, so it is not on the calendar and cannot be edited there. Nothing was added.`;
  }
  const { eventDate, source } = collision.replacedBy;
  const whose = source === "manual" ? "your entry" : "the entry";
  return eventDate === input.eventDate
    ? `${lead}: ${whose} showing on that date took its place. Nothing was added.`
    : `${lead}: ${whose} on ${eventDate} took its place. Nothing was added. ` +
        `To move ${symbol} to ${input.eventDate}, change the date on the ${eventDate} entry.`;
}
