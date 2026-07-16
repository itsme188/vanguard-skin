/**
 * EOD earnings-wrap cluster logic (#17) — pure decisions only; the send
 * lives in lib/earnings/wrap-send.ts.
 *
 * A (date, slot) cluster is in WRAP MODE when its expected-unsent recap
 * count reaches WRAP_THRESHOLD. Expected = held/watchlist (family-aware),
 * family-deduped, not superseded/skipped/muted, recap not completed.
 * An 'in_progress' claim row keeps the event a member (someone is sending
 * it — usually the wrap itself mid-flight).
 *
 * Spec: docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md
 */

import type Database from "better-sqlite3";
import { mondayOf } from "@/lib/calendar/date-utils";
import { getEarningsForWeekDeduped } from "@/lib/queries/calendar";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getEarningsSettings, shouldSendEarningsEmail } from "@/lib/queries/earnings-settings";

export const WRAP_THRESHOLD = 3;

export type WrapSlot = "BMO" | "AMC";

// User-set deadlines (2026-07-16): the wrap fires no later than these, in
// ET wall-clock. Worker mirror must match (fallback-earnings).
export const SLOT_DEADLINES_ET: Record<WrapSlot, string> = {
  BMO: "12:00",
  AMC: "20:00",
};

/** Same precedence as the cockpit's laneFor / the digest block's slotFor. */
export function wrapSlotFor(e: {
  event_time: string | null;
  title: string | null;
  release_time: string | null;
}): WrapSlot | null {
  const marker = `${e.event_time ?? ""} ${e.title ?? ""}`.toUpperCase();
  if (marker.includes("BMO") || marker.includes("BEFORE MARKET")) return "BMO";
  if (marker.includes("AMC") || marker.includes("AFTER MARKET")) return "AMC";
  if (e.release_time) return e.release_time < "12:00" ? "BMO" : "AMC";
  return null; // TBD — never clusters
}

export interface WrapClusterMember {
  eventId: number;
  symbol: string;
  releaseTime: string | null;
  /** Recap-ready: actual captured AND enrichment stamped complete. */
  ready: boolean;
}

export function getExpectedRecapCluster(
  db: Database.Database,
  date: string,
  slot: WrapSlot,
): WrapClusterMember[] {
  const events = getEarningsForWeekDeduped(db, mondayOf(date)).filter(
    (e) => e.event_date === date && e.symbol && wrapSlotFor(e) === slot,
  );
  if (events.length === 0) return [];

  const status = getSymbolStatus(db, events.map((e) => e.symbol!));
  const settings = getEarningsSettings(db);

  const ids = events.map((e) => e.id);
  const ph = ids.map(() => "?").join(",");
  const sentRecaps = new Set(
    (db.prepare(
      `SELECT event_id FROM earnings_emails
        WHERE phase = 'recap' AND event_id IN (${ph})
          AND (error IS NULL OR error = 'sent-by-cloud')`,
    ).all(...ids) as { event_id: number }[]).map((r) => r.event_id),
  );
  const skipped = new Set(
    (db.prepare(
      `SELECT event_id FROM earnings_email_skips
        WHERE phase = 'recap' AND event_id IN (${ph})`,
    ).all(...ids) as { event_id: number }[]).map((r) => r.event_id),
  );

  return events
    .filter((e) => {
      const st = status[e.symbol!.toUpperCase()];
      if (st !== "held" && st !== "watchlist") return false;
      if (sentRecaps.has(e.id) || skipped.has(e.id)) return false;
      if (!shouldSendEarningsEmail(settings, e.symbol!)) return false;
      return true;
    })
    .map((e) => ({
      eventId: e.id,
      symbol: e.symbol!.toUpperCase(),
      releaseTime: e.release_time ?? null,
      ready: e.actual_value != null && e.enriched_at != null,
    }));
}

export function etHHMM(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}

export function slotDeadlinePassed(slot: WrapSlot, now: Date): boolean {
  // Intl with hour12:false can render midnight as "24:00" — normalize.
  const hhmm = etHHMM(now).replace(/^24/, "00");
  return hhmm >= SLOT_DEADLINES_ET[slot];
}
