import type Database from "better-sqlite3";
import type { CalendarEventType } from "@/lib/types";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

/**
 * WSH JSON format is undocumented by IBKR. This parser is built
 * defensively — it handles the expected shape but logs and skips
 * unknown structures. The raw JSON is always preserved in each
 * event's `raw_json` field for iteration.
 *
 * Expected WSH JSON structure (from @stoqey/ib test suite + community):
 * {
 *   "wpiFilterData": [ ... ], // or "wsh_events" / "events" — format varies
 * }
 *
 * Each event entry typically has:
 * - conid / conId
 * - event_type / eventType
 * - event_date / eventDate (YYYYMMDD or YYYY-MM-DD)
 * - event_time / eventTime
 * - title / event_title
 * - description / summary
 */

// Event type strings we've seen in WSH data → our canonical types
const WSH_EVENT_TYPE_MAP: Record<string, CalendarEventType> = {
  earnings: "earnings",
  earnings_date: "earnings",
  "earnings date": "earnings",
  analyst_meeting: "analyst_meeting",
  analyst_day: "analyst_meeting",
  "analyst day": "analyst_meeting",
  conference: "conference",
  split: "split",
  stock_split: "split",
  // Dividends excluded per user preference — filtered out below
  dividend: "__skip__" as CalendarEventType,
  ex_dividend: "__skip__" as CalendarEventType,
  "ex-dividend": "__skip__" as CalendarEventType,
  ex_date: "__skip__" as CalendarEventType,
};

function normalizeEventType(raw: string): CalendarEventType | null {
  const lower = raw.toLowerCase().trim();
  const mapped = WSH_EVENT_TYPE_MAP[lower];
  if (mapped === ("__skip__" as CalendarEventType)) return null; // filtered out
  if (mapped) return mapped;
  // Unknown type — keep as "other" rather than dropping
  return "other";
}

function normalizeDateStr(raw: string): string {
  // YYYYMMDD → YYYY-MM-DD
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  return raw;
}

interface SecurityLookup {
  security_id: number;
  symbol: string;
}

/**
 * Parse WSH JSON response into CalendarEventInput[].
 *
 * @param dataJson  Raw JSON string from reqWshEventData
 * @param weekOf    Monday of the week this fetch covers (YYYY-MM-DD)
 * @param db        Database for conId → security_id lookups
 * @returns Parsed events (dividends filtered out)
 */
export function parseWshEvents(
  dataJson: string,
  weekOf: string,
  db: Database.Database
): CalendarEventInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    console.warn("[parseWshEvents] Failed to parse WSH JSON:", dataJson.slice(0, 200));
    return [];
  }

  // Build conId → security lookup from DB
  const conIdMap = new Map<number, SecurityLookup>();
  const rows = db
    .prepare("SELECT id, symbol, ib_con_id FROM securities WHERE ib_con_id IS NOT NULL")
    .all() as { id: number; symbol: string; ib_con_id: number }[];
  for (const row of rows) {
    conIdMap.set(row.ib_con_id, { security_id: row.id, symbol: row.symbol });
  }

  // Extract the events array — try known keys
  const obj = parsed as Record<string, unknown>;
  let rawEvents: unknown[] = [];

  if (Array.isArray(parsed)) {
    rawEvents = parsed;
  } else if (Array.isArray(obj.wpiFilterData)) {
    rawEvents = obj.wpiFilterData;
  } else if (Array.isArray(obj.wsh_events)) {
    rawEvents = obj.wsh_events;
  } else if (Array.isArray(obj.events)) {
    rawEvents = obj.events;
  } else {
    // Log the structure for debugging — we'll iterate on this
    console.warn(
      "[parseWshEvents] Unknown WSH JSON structure. Top-level keys:",
      Object.keys(obj)
    );
    console.warn("[parseWshEvents] Raw JSON (first 500 chars):", dataJson.slice(0, 500));
    return [];
  }

  const events: CalendarEventInput[] = [];

  for (const raw of rawEvents) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    // Extract fields — try multiple possible key names
    const conId = Number(entry.conid ?? entry.conId ?? entry.con_id ?? 0);
    const rawType = String(entry.event_type ?? entry.eventType ?? entry.type ?? "other");
    const rawDate = String(entry.event_date ?? entry.eventDate ?? entry.date ?? "");
    const rawTime = entry.event_time ?? entry.eventTime ?? entry.time ?? null;
    const title = String(
      entry.title ?? entry.event_title ?? entry.eventTitle ?? entry.summary ?? "Unknown Event"
    );
    const description = entry.description ?? entry.summary ?? entry.details ?? null;

    // Skip if no date
    if (!rawDate) continue;

    // Normalize event type — returns null for dividends (filtered out)
    const eventType = normalizeEventType(rawType);
    if (!eventType) continue;

    const eventDate = normalizeDateStr(rawDate);
    const security = conId ? conIdMap.get(conId) : undefined;

    const sourceKey = `wsh:${conId || "portfolio"}:${rawType}:${eventDate}`;

    events.push({
      source: "wsh",
      event_type: eventType,
      event_date: eventDate,
      event_time: rawTime ? String(rawTime) : null,
      title,
      description: description ? String(description) : null,
      security_id: security?.security_id ?? null,
      symbol: security?.symbol ?? (entry.symbol ? String(entry.symbol) : null),
      ib_con_id: conId || null,
      raw_json: JSON.stringify(entry),
      source_key: sourceKey,
      week_of: weekOf,
    });
  }

  return events;
}
