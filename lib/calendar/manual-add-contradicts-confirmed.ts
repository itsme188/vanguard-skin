/**
 * Would a hand-entered earnings date sit beside a CONFIRMED vendor date for
 * the same company in the same week? (qa:dashboard-today-earningshub-add-
 * ticker-hand-entered-date-beside-a-vendor-date-in-the-same-week-hand-
 * entered-da; owner ruling 2026-10-12, option 1.)
 *
 * The cross-week guard (`checkManualAddWouldSupersedeVendor`) never fires
 * inside one week, so typing Friday beside a vendor Thursday that two
 * sources agree on (or that a web lookup verified) answered 200 and left two
 * prints a day apart, each with its own preview and recap emails, and nothing
 * marking the conflict. POST and PATCH on /api/calendar/events now answer 409
 * `would_contradict_confirmed_date` until the body carries
 * `forceContradictConfirmed: true`. That flag answers ONLY this question;
 * `force` and `forceSlot` never answer it.
 *
 * "Confirmed" means either:
 *  - the vendor row's `date_status` is 'confirmed' (the reconciler's two
 *    agreeing sources), or
 *  - the symbol's release time is `web_verified` FOR THAT DATE
 *    (`getSymbolReleaseTimeRow`, the release cascade's own reader).
 *
 * Scope: earnings only; vendor rows only (`source != 'manual'`) that are
 * showing (`superseded = 0`); same issuer family; a DIFFERENT date in the same
 * Monday-to-Sunday week (`mondayOf`, the week every calendar surface files
 * under). The same exact date is not this guard's business: the feed-row
 * hider and the manual-row 409s already own it.
 *
 * Read-only.
 */
import type Database from "better-sqlite3";
import { addDays, mondayOf } from "@/lib/calendar/date-utils";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { getSymbolReleaseTimeRow } from "@/lib/earnings/wire-times";
import { vendorDisplayName } from "@/lib/calendar/reconcile-earnings-dates";

export const WOULD_CONTRADICT_CONFIRMED_DATE = "would_contradict_confirmed_date";

export interface ConfirmedDateContradiction {
  reason: typeof WOULD_CONTRADICT_CONFIRMED_DATE;
  vendorEventId: number;
  vendorDate: string;
  vendorSource: string;
  /** Why the vendor date counts as confirmed. */
  basis: "two_sources" | "web_verified";
  /** Plain-English refusal for an ADD, ready to render. */
  message: string;
}

export function checkManualAddContradictsConfirmedDate(
  db: Database.Database,
  opts: {
    symbol: string;
    eventDate: string;
    /** Defaults to 'earnings'; anything else is not gated. */
    eventType?: string;
    /** The row being edited (PATCH): never its own contradiction. */
    excludeEventId?: number;
  },
): ConfirmedDateContradiction | null {
  if ((opts.eventType ?? "earnings") !== "earnings") return null;
  const symbol = opts.symbol.trim().toUpperCase();
  if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(opts.eventDate)) return null;

  const weekStart = mondayOf(opts.eventDate);
  const weekEnd = addDays(weekStart, 6);
  const family = [
    ...new Set([symbol, ...issuerSiblings(symbol).map((s) => s.trim().toUpperCase())]),
  ];
  const rows = db
    .prepare(
      `SELECT id, symbol, event_date, source, date_status
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND source != 'manual'
          AND COALESCE(superseded, 0) = 0
          AND UPPER(symbol) IN (${family.map(() => "?").join(", ")})
          AND event_date BETWEEN ? AND ?
          AND event_date != ?
        ORDER BY event_date, id`,
    )
    .all(...family, weekStart, weekEnd, opts.eventDate) as Array<{
    id: number;
    symbol: string;
    event_date: string;
    source: string;
    date_status: string | null;
  }>;

  for (const row of rows) {
    if (row.id === opts.excludeEventId) continue;
    let basis: ConfirmedDateContradiction["basis"] | null = null;
    if (row.date_status === "confirmed") {
      basis = "two_sources";
    } else {
      const time = getSymbolReleaseTimeRow(db, row.symbol);
      if (time?.source === "web_verified" && time.verified_for_date === row.event_date) {
        basis = "web_verified";
      }
    }
    if (!basis) continue;
    const vendor = vendorDisplayName(row.source);
    const why = basis === "two_sources" ? "two sources agree" : "its release time is web-verified for that day";
    return {
      reason: WOULD_CONTRADICT_CONFIRMED_DATE,
      vendorEventId: row.id,
      vendorDate: row.event_date,
      vendorSource: row.source,
      basis,
      message:
        `${vendor} has ${symbol} earnings confirmed for ${row.event_date} (${why}). ` +
        `Nothing was added. Your ${opts.eventDate} entry would show as a second print the same week, ` +
        `with its own preview and recap emails. Change the date, or add anyway to keep both.`,
    };
  }
  return null;
}
