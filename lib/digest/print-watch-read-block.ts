/**
 * The recap email's "## Print-watch read" block (live print v2 slice E,
 * closing the TODO "Recap email is blind to the print-watch sheet").
 *
 * PRIVACY / DATA-FLOW CONTRACT (spec §4.4, and the reason this module exists at
 * all): the recap composer may see the read's VERDICT WORDS and its prose, and
 * nothing else from the first-pass read. The type system is the enforcement:
 * `facts` is `DirectionSafeFacts`, a NOMINALLY BRANDED type that only
 * `directionSafeFacts()` can mint, and `loadPrintWatchReadBlock` is the ONLY
 * loader — it funnels every fact through that one function.
 *
 * NOTHING THE READ COMPUTED CROSSES THIS BOUNDARY (R-E1). Not a fact's actual,
 * not its consensus, not its delta — and not the accepted callouts either: a
 * callout's `vs_bogey_text` is a figure and a delta computed from the sheet,
 * which is the same class of thing the facts carry, so it stays on the print
 * sheet and in the UI where it belongs. What crosses is the verdict WORDS and
 * the read's prose, which slice D generated under its own prompt contract and
 * which the recap already echoes in the desk's call note.
 *
 * Import direction: lib/digest -> lib/print-watch is allowed; the reverse is
 * banned (R-D22, tests/repo/print-watch-import-boundaries.test.ts).
 */
import type Database from "better-sqlite3";
import { getPrintByEventId } from "@/lib/print-watch/store";
import { buildReadFacts, directionSafeFacts } from "@/lib/print-watch/read-facts";
import { getLatestDoneRead } from "@/lib/print-watch/read-store";
import { sanitizeProseLines } from "@/lib/print-watch/first-pass-format";
import type { DirectionSafeFacts } from "@/lib/print-watch/first-pass-types";

/** How many prose lines of each kind may cross into the recap. Matches the
 *  caps slice D applies at storage; re-applied here so a row written by an
 *  older version cannot widen them. */
const MAX_READ_LINES = 10;
const MAX_WATCH_LINES = 3;

export interface PrintWatchReadBlockInput {
  facts: DirectionSafeFacts;
  prose: { read: string[]; call_watch: string[] } | null;
}

export function renderPrintWatchReadBlock(input: PrintWatchReadBlockInput): string {
  const verdicts = input.facts.map((f) => `- ${f.label} — ${f.verdict}`);
  // Sanitised again HERE, at render (CLAUDE.md: model prose is sanitised at
  // storage AND at render), so a row written by an older version cannot smuggle
  // an instruction-shaped line into the recap prompt.
  const read = sanitizeProseLines(input.prose?.read, MAX_READ_LINES);
  const watch = sanitizeProseLines(input.prose?.call_watch, MAX_WATCH_LINES);

  if (verdicts.length === 0 && read.length === 0 && watch.length === 0) return "";

  const parts: string[] = ["## Print-watch read"];
  parts.push(
    "*Verified on the release itself, on this Mac, at print time. Directions only — the reported figures are in the scoreboard above.*",
  );
  if (verdicts.length) parts.push(`**Against the desk's bogeys**\n${verdicts.join("\n")}`);
  if (read.length) parts.push(`**First-pass read**\n${read.map((l) => `- ${l}`).join("\n")}`);
  if (watch.length) parts.push(`**Watch on the call**\n${watch.map((l) => `- ${l}`).join("\n")}`);
  return parts.join("\n\n");
}

/** The ONE loader. Returns "" when the event has no print or no read yet. */
export function loadPrintWatchReadBlock(db: Database.Database, eventId: number): string {
  const print = getPrintByEventId(db, eventId);
  if (!print) return "";
  const read = getLatestDoneRead(db, print.id);
  let prose: { read: string[]; call_watch: string[] } | null = null;
  if (read?.prose_json) {
    try {
      const parsed = JSON.parse(read.prose_json) as { read?: unknown; call_watch?: unknown };
      prose = {
        read: sanitizeProseLines(parsed.read, MAX_READ_LINES),
        call_watch: sanitizeProseLines(parsed.call_watch, MAX_WATCH_LINES),
      };
    } catch {
      prose = null;
    }
  }
  return renderPrintWatchReadBlock({
    facts: directionSafeFacts(buildReadFacts(db, print.id)),
    prose,
  });
}
