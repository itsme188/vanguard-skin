/**
 * Printable one-page earnings worksheet (feedback #6, 2026-08-03).
 *
 * A fixed-width (80-col) monospace desk sheet for following a live print by
 * hand: scoreboard rows with blank ACTUAL/Δ columns, segment splits,
 * guidance bogeys with fill-in blanks, the user's own notes, scratch lines.
 * Printed via `lp` (CUPS) — zero rendering dependencies, reliable from the
 * launchd sweep, always exactly one page (hard line cap).
 *
 * Auto-print: arming an event's flag (earnings_worksheet_flags) prints at
 * the sweep tick where the release instant sits inside [now−30m, now+135m]
 * — the preview window plus a grace band for late arming — exactly once
 * (printed_at stamp). "Print now" (POST /api/earnings/worksheet) bypasses
 * the window and the stamp entirely.
 *
 * Spec: docs/superpowers/specs/2026-08-03-worksheet-print-design.md
 */

import { spawn } from "node:child_process";
import type Database from "better-sqlite3";
import { getBogeysForEvent, getExpectedMoveBogeysForEvents, type EarningsBogey } from "@/lib/queries/earnings-bogeys";
import { getIntelForEvents } from "@/lib/queries/earnings-intel";
import { getUnprintedWorksheetEvents } from "@/lib/queries/earnings-worksheet-flags";
import { stampWorksheetPrinted } from "@/lib/mutations/earnings-worksheet-flags";
import { resolveExpectedMove } from "@/lib/earnings/expected-move";
import { getNotesForFamily } from "@/lib/queries/notes";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { formatLargeUSD } from "@/lib/format";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import type { CalendarEvent } from "@/lib/types";

const WIDTH = 80;
const MAX_LINES = 62; // one US-letter page at 12cpi with margins

// Auto-print window: preview band plus a 30-min grace for late arming.
const AUTO_PRINT_MIN_MS = -30 * 60 * 1000;
const AUTO_PRINT_MAX_MS = 135 * 60 * 1000;

export interface WorksheetInputs {
  event: Pick<
    CalendarEvent,
    "symbol" | "event_date" | "event_time" | "release_time" | "consensus_estimate" | "consensus_value"
  >;
  bogeys: EarningsBogey[];
  expectedMove: { pct: number; method: string; sourceLabel: string | null } | null;
  /** User note excerpts, newest first (already truncated by the loader). */
  noteLines: string[];
}

function fmtShortDate(iso: string): string {
  const [y, m, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s.padEnd(w);
}

function figure(n: number | null | undefined, eps: boolean): string {
  if (n == null) return "—";
  return eps ? n.toFixed(2) : formatLargeUSD(n);
}

/** First non-null value across bogeys, newest first (list arrives newest-first). */
function firstBogey<K extends keyof EarningsBogey>(
  bogeys: EarningsBogey[],
  key: K,
): EarningsBogey[K] | null {
  for (const b of bogeys) if (b[key] != null) return b[key];
  return null;
}

/**
 * Pure composer — fixed-width text, hard-capped at MAX_LINES so the sheet
 * can never spill to a second page (scratch lines absorb the slack).
 */
export function composeWorksheet(inputs: WorksheetInputs): string {
  const { event, bogeys, expectedMove, noteLines } = inputs;
  const symbol = (event.symbol ?? "").toUpperCase();
  const slot = event.event_time && /^(BMO|AMC)$/i.test(event.event_time.trim())
    ? ` (${event.event_time.trim().toUpperCase()})`
    : "";
  const move = expectedMove
    ? `exp move ±${expectedMove.pct.toFixed(1)}% (${
        expectedMove.method === "sheet"
          ? expectedMove.sourceLabel ?? "bogey sheet"
          : expectedMove.method === "straddle"
            ? "straddle"
            : "IV approx"
      })`
    : "";

  const lines: string[] = [];
  const title = `${symbol} — ${fmtShortDate(event.event_date)}${slot}`;
  lines.push(title + move.padStart(Math.max(0, WIDTH - title.length)));
  lines.push("─".repeat(WIDTH));

  // Scoreboard: METRIC 24 | CONS 12 | WHISPER 12 | ACTUAL 14 | Δ 8
  const row = (metric: string, cons: string, whisper: string) =>
    `${pad(metric, 24)}${pad(cons, 12)}${pad(whisper, 12)}${pad("__________", 14)}______`;
  lines.push(`${pad("METRIC", 24)}${pad("CONS", 12)}${pad("WHISPER", 12)}${pad("ACTUAL", 14)}Δ`);

  const cons = parseFinnhubFigure(effectiveConsensus(event as CalendarEvent));
  lines.push(
    row("EPS", figure(firstBogey(bogeys, "eps_consensus") ?? cons.eps, true), figure(firstBogey(bogeys, "eps_whisper"), true)),
  );
  lines.push(
    row(
      "Revenue",
      figure(firstBogey(bogeys, "revenue_consensus_usd") ?? cons.revenue, false),
      figure(firstBogey(bogeys, "revenue_whisper_usd"), false),
    ),
  );

  // Segment splits — newest bogey carrying them wins.
  const segJson = firstBogey(bogeys, "segment_breakdown_json");
  if (segJson) {
    try {
      const segs = JSON.parse(segJson) as Record<string, { consensus?: number; whisper?: number }>;
      for (const [name, vals] of Object.entries(segs)) {
        lines.push(row(`  ${name}`, figure(vals.consensus ?? null, false), figure(vals.whisper ?? null, false)));
      }
    } catch {
      // Malformed stored JSON — skip silently (same tolerance as the composer).
    }
  }

  // Guidance bogeys, each with a fill-in blank underneath.
  const guidance = bogeys.map((b) => b.guidance_notes).filter((g): g is string => !!g);
  if (guidance.length > 0) {
    lines.push("");
    lines.push("GUIDANCE");
    for (const g of guidance.slice(0, 4)) {
      for (const gl of g.split("\n").slice(0, 2)) lines.push(pad(`  ${gl}`, WIDTH));
      lines.push(`    → ${"_".repeat(WIDTH - 6)}`);
    }
  }

  if (noteLines.length > 0) {
    lines.push("");
    lines.push("NOTES (yours)");
    for (const n of noteLines.slice(0, 6)) lines.push(pad(`  · ${n}`, WIDTH));
  }

  // Scratch lines fill the remaining page (min 3, floor at MAX_LINES − 1).
  lines.push("");
  lines.push("SCRATCH");
  const scratchCount = Math.max(3, MAX_LINES - lines.length - 2);
  for (let i = 0; i < scratchCount; i++) lines.push(`  ${"_".repeat(WIDTH - 4)}`);

  const src = bogeys.find((b) => b.source_label)?.source_label;
  lines.push(pad(`[${src ? `bogeys: ${src} · ` : ""}deterministic worksheet]`, WIDTH));

  return lines.slice(0, MAX_LINES).join("\n") + "\n";
}

/** Assemble WorksheetInputs from the DB for one event. */
export function loadWorksheetInputs(db: Database.Database, eventId: number): WorksheetInputs | null {
  const event = db
    .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
    .get(eventId) as CalendarEvent | undefined;
  if (!event || !event.symbol) return null;

  const bogeys = getBogeysForEvent(db, eventId);
  const intel = getIntelForEvents(db, [eventId]).get(eventId) ?? null;
  const expectedMove = resolveExpectedMove({
    bogeys: getExpectedMoveBogeysForEvents(db, [eventId]).get(eventId) ?? [],
    impliedMovePct: intel?.impliedMovePct ?? null,
    impliedMethod: intel?.impliedMethod ?? null,
  });
  const noteLines = getNotesForFamily(db, [...issuerSiblings(event.symbol)])
    .slice(0, 6)
    .map((n) => n.content.replace(/\s+/g, " ").trim().slice(0, 74));

  return { event, bogeys, expectedMove, noteLines };
}

/** Optional named printer (settings key worksheet_printer_name; blank = default). */
function printerName(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = 'worksheet_printer_name'`)
      .get() as { value: string } | undefined;
    const v = row?.value.trim();
    return v ? v : null;
  } catch {
    return null; // settings table absent (minimal test DBs)
  }
}

/** Pipe text to lp. Resolves on queue acceptance; rejects on spawn/exit error. */
export function printViaLp(
  text: string,
  opts: { printer?: string | null; title?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    if (opts.printer) args.push("-d", opts.printer);
    if (opts.title) args.push("-t", opts.title);
    const child = spawn("lp", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lp exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/** Compose + print one event's worksheet immediately (Print now path). */
export async function printWorksheetNow(
  db: Database.Database,
  eventId: number,
): Promise<{ symbol: string }> {
  const inputs = loadWorksheetInputs(db, eventId);
  if (!inputs) throw new Error(`Event ${eventId} not found or symbol-less.`);
  const text = composeWorksheet(inputs);
  await printViaLp(text, {
    printer: printerName(db),
    title: `${(inputs.event.symbol ?? "").toUpperCase()} earnings worksheet`,
  });
  return { symbol: (inputs.event.symbol ?? "").toUpperCase() };
}

/**
 * Auto-print pass for the sweep: armed, unprinted flags whose release
 * instant sits in [now−30m, now+135m]. Best-effort per event — a failed
 * print logs and retries next tick (no stamp); rows with no computable
 * release instant are left to "Print now". Never throws.
 */
export async function printArmedWorksheets(
  db: Database.Database,
  opts: {
    now?: Date;
    /** DI seam for tests — defaults to printWorksheetNow (real lp). */
    print?: (db: Database.Database, eventId: number) => Promise<unknown>;
  } = {},
): Promise<{ printed: number }> {
  let printed = 0;
  const doPrint = opts.print ?? printWorksheetNow;
  try {
    const nowMs = (opts.now ?? new Date()).getTime();
    for (const f of getUnprintedWorksheetEvents(db)) {
      if (!f.release_time) continue;
      const release = composeReleaseInstant(f.event_date, f.release_time);
      if (!release) continue;
      const until = release.getTime() - nowMs;
      if (until < AUTO_PRINT_MIN_MS || until > AUTO_PRINT_MAX_MS) continue;
      try {
        await doPrint(db, f.eventId);
        stampWorksheetPrinted(db, f.eventId);
        printed++;
        console.log(`[worksheet] auto-printed ${f.symbol ?? f.eventId} worksheet`);
      } catch (err) {
        console.warn(`[worksheet] auto-print failed for ${f.symbol ?? f.eventId} (retries next tick):`, err);
      }
    }
  } catch (err) {
    console.warn(`[worksheet] auto-print pass failed:`, err);
  }
  return { printed };
}
