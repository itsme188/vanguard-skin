/**
 * How the weekly briefing sorts a week's calendar rows into its three lists.
 *
 * MIRRORED: the block between the BEGIN / END markers below is carried
 * byte-for-byte inside workers/cron/src/fallback-briefing.ts (the Worker
 * cannot cross the Next.js path-alias boundary). Change both together;
 * workers/cron/test/fallback-briefing-partition.test.ts fails when they drift.
 * Keep the block free of imports for that reason.
 *
 * The one thing each side supplies is its issuer-family table (share-class
 * siblings): `partitionBriefingEvents` at the foot of this file is the Mac's
 * entry point, and the Worker has its twin beside its copy of the block.
 */
import { issuerSiblings } from "@/lib/securities/issuer-family";

// ── BEGIN briefing-partition (mirrored; see the file header) ──────────
/** The fields the partition reads. Both the Mac's `CalendarEvent` and the
 *  Worker's snapshot row satisfy it. */
export interface BriefingPartitionRow {
  id?: number | null;
  source: string;
  event_type: string;
  event_date: string;
  event_time?: string | null;
  symbol?: string | null;
  /** A JSON string on the Mac; the Worker's snapshot may hand an object. */
  raw_json?: unknown;
  superseded?: unknown;
}

export interface BriefingPartition<T> {
  /** One row per earnings print: the row the duplicate check kept. */
  portfolioEarnings: T[];
  /** WSH earnings announcements (their own, lighter section). */
  wshEarnings: T[];
  /** Every non-earnings row (macro releases and the rest). */
  otherEvents: T[];
}

/**
 * Does the row state a real before-open / after-close slot? Same evidence
 * order as the shared resolver (lib/earnings/earnings-slot.ts, with no
 * release-time fallback): a BMO/AMC word or a clock on `event_time`, else
 * the vendor hour in `raw_json.entry.hour`. "During market hours", "TAS"
 * and an unknown hour are not a slot. tests/calendar/briefing-canonical-
 * earnings.test.ts pins this against the resolver.
 */
export function briefingRowHasRealSlot(row: {
  event_time?: string | null;
  raw_json?: unknown;
}): boolean {
  const et = typeof row.event_time === "string" ? row.event_time.trim().toUpperCase() : "";
  if (et === "BMO" || et === "AMC") return true;
  if (/^\d{2}:\d{2}/.test(et)) return true;
  if (et === "TAS") return false;

  let parsed: unknown = row.raw_json;
  if (typeof parsed === "string") {
    if (parsed === "") return false;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== "object") return false;
  const entry = (parsed as { entry?: unknown }).entry;
  if (!entry || typeof entry !== "object") return false;
  const hour = (entry as { hour?: unknown }).hour;
  if (typeof hour !== "string") return false;
  const normalized = hour.trim().toLowerCase();
  return normalized === "bmo" || normalized === "amc";
}

/** Lower is better. A real slot first, then Finnhub, Nasdaq, hand-entered. */
function briefingEarningsRank(row: BriefingPartitionRow): number {
  const sourceRank =
    row.source === "finnhub" ? 0 : row.source === "nasdaq" ? 1 : row.source === "manual" ? 2 : 3;
  return (briefingRowHasRealSlot(row) ? 0 : 10) + sourceRank;
}

/**
 * Sort a week's rows into the briefing's lists.
 *
 * "Portfolio earnings" is every earnings row that is the kept row for its
 * print, WHATEVER its source. It used to be `source === "finnhub"`, which
 * dropped a print whose kept row came from Nasdaq or was typed by hand into
 * the macro list (and left its symbol out of the prices block).
 *
 * Rows the duplicate check has hidden (`superseded`) are dropped from every
 * list. The Mac's week reader already leaves them out; the Worker's snapshot
 * carries them, so the rule lives here for both.
 *
 * Guard for a pair no reconcile pass has seen yet (both rows still showing):
 * one ISSUER on one date is listed once. The row with a real slot is kept,
 * then Finnhub, then Nasdaq, then a hand-entered row, then the lower id. Rows
 * on different dates are both listed: choosing between dates is the
 * reconciler's job, never this guard's.
 *
 * `familyKey` maps an upper-cased symbol to one key per issuer, so a
 * share-class pair from two vendors (GOOG from one, GOOGL from the other) is
 * one print. It is a parameter because this block cannot import: each side
 * passes a function built on its own issuer-family table (see
 * `partitionBriefingEvents` outside the block). Without it, or when it
 * returns nothing for a symbol, the symbol itself is the key.
 *
 * Input order is preserved in every list.
 */
export function partitionBriefingEventsBy<T extends BriefingPartitionRow>(
  events: readonly T[],
  familyKey?: (symbol: string) => string | null | undefined,
): BriefingPartition<T> {
  const printKey = (e: T): string | null => {
    const symbol = typeof e.symbol === "string" ? e.symbol.trim().toUpperCase() : "";
    if (!symbol) return null;
    const family = familyKey ? familyKey(symbol) : null;
    return `${typeof family === "string" && family !== "" ? family : symbol}|${e.event_date}`;
  };

  const live = events.filter((e) => !e.superseded || e.superseded === "0");

  const wshEarnings = live.filter((e) => e.source === "wsh" && e.event_type === "earnings");
  // A Finnhub row is only ever an earnings row; the source test keeps the old
  // rule that nothing from that feed is narrated as a macro event.
  const otherEvents = live.filter((e) => e.event_type !== "earnings" && e.source !== "finnhub");

  const candidates = live.filter((e) => e.event_type === "earnings" && e.source !== "wsh");
  const bestByPrint = new Map<string, T>();
  for (const e of candidates) {
    const key = printKey(e);
    if (key === null) continue;
    const held = bestByPrint.get(key);
    if (!held) {
      bestByPrint.set(key, e);
      continue;
    }
    const diff = briefingEarningsRank(e) - briefingEarningsRank(held);
    const idDiff = (e.id ?? Number.MAX_SAFE_INTEGER) - (held.id ?? Number.MAX_SAFE_INTEGER);
    if (diff < 0 || (diff === 0 && idDiff < 0)) bestByPrint.set(key, e);
  }
  const portfolioEarnings = candidates.filter((e) => {
    const key = printKey(e);
    return key === null || bestByPrint.get(key) === e;
  });

  return { portfolioEarnings, wshEarnings, otherEvents };
}
// ── END briefing-partition ────────────────────────────────────────────

/** One key per issuer: the alphabetically first share-class sibling. */
function issuerFamilyKey(symbol: string): string {
  return (
    issuerSiblings(symbol)
      .map((s) => s.toUpperCase())
      .sort()[0] ?? symbol
  );
}

/**
 * The Mac's entry point: the shared partition with the Mac's issuer-family
 * table, so a share-class pair from two vendors on one date is one print.
 */
export function partitionBriefingEvents<T extends BriefingPartitionRow>(
  events: readonly T[],
): BriefingPartition<T> {
  return partitionBriefingEventsBy(events, issuerFamilyKey);
}
