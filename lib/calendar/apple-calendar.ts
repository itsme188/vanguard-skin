import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface AppleCalendarEvent {
  title: string;
  startDate: string; // ISO 8601
  endDate: string;
  allDay: boolean;
  notes: string | null;
  location: string | null;
  calendar: string;
}

/**
 * Resolve the path to the compiled Swift `read-calendar` helper.
 *
 * Dev: <repo>/bin/read-calendar. Packaged Electron: process.resourcesPath/bin.
 * Returns null if the binary can't be found — callers should treat that as
 * "Apple Calendar integration unavailable" rather than throwing.
 */
export function getReadCalendarBinary(): string | null {
  // Electron sets process.resourcesPath to the .app Resources dir; not in Node types.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    path.join(process.cwd(), "bin", "read-calendar"),
    resourcesPath ? path.join(resourcesPath, "bin", "read-calendar") : null,
  ].filter((p): p is string => p !== null);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Read events from a named Apple (macOS) Calendar.app calendar between the
 * given inclusive dates. Returns [] if the calendar doesn't exist or the
 * binary isn't available (e.g. on non-macOS or before first build).
 *
 * macOS will prompt for Calendar access on the first invocation — the Swift
 * helper handles the permission request via EventKit.
 */
export async function fetchAppleCalendarEvents(
  calendarName: string,
  startDate: string, // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD (inclusive)
): Promise<AppleCalendarEvent[]> {
  const bin = getReadCalendarBinary();
  if (!bin) return [];

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [calendarName, startDate, endDate]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => err.push(d));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(err).toString().trim();
        return reject(
          new Error(`read-calendar exited ${code}: ${msg || "no stderr"}`)
        );
      }
      try {
        const s = Buffer.concat(out).toString().trim();
        resolve(s ? (JSON.parse(s) as AppleCalendarEvent[]) : []);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Best-effort ticker extraction from an event title. IBKR-pasted titles
 * commonly look like "AAPL Earnings", "Earnings: AAPL", "AAPL - Apple Inc.",
 * or "Apple Inc (AAPL)". Returns null if no plausible ticker is found.
 */
export function extractSymbolFromTitle(title: string): string | null {
  // 1) Parenthesized ticker: "(AAPL)"
  const paren = title.match(/\(([A-Z]{1,5})\)/);
  if (paren) return paren[1];
  // 2) Leading ticker followed by space/dash/colon: "AAPL ...", "AAPL - ..."
  const leading = title.match(/^([A-Z]{1,5})\b/);
  if (leading && !isCommonWord(leading[1])) return leading[1];
  // 3) "$TICKER" style
  const dollar = title.match(/\$([A-Z]{1,5})\b/);
  if (dollar) return dollar[1];
  return null;
}

// Titles like "IT Meeting" or "OR Call" shouldn't resolve to a ticker.
function isCommonWord(s: string): boolean {
  return ["A", "I", "AN", "IT", "AS", "AT", "BE", "OR", "TO", "IS", "ON", "IN", "IF", "ER"].includes(s);
}

/**
 * Convert Apple Calendar events into calendar_events upsert input.
 * Filters to events whose event_date falls within [startDate, endDate].
 */
export function toCalendarEventInputs(
  events: AppleCalendarEvent[],
  weekOf: string,
  startDate: string,
  endDate: string
): Array<{
  source: "apple_calendar";
  event_type: "earnings";
  event_date: string;
  event_time: string | null;
  title: string;
  description: string | null;
  symbol: string | null;
  source_key: string;
  week_of: string;
}> {
  return events
    .map((e) => {
      const d = new Date(e.startDate);
      const event_date = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0"),
      ].join("-");
      if (event_date < startDate || event_date > endDate) return null;
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const event_time = e.allDay ? null : `${hh}:${mm}`;
      return {
        source: "apple_calendar" as const,
        event_type: "earnings" as const,
        event_date,
        event_time,
        title: e.title,
        description: e.notes ?? null,
        symbol: extractSymbolFromTitle(e.title),
        source_key: `apple:${e.calendar}:${event_date}:${e.title}`.slice(0, 240),
        week_of: weekOf,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
