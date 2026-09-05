/**
 * The post-print sheet: the whole print on one piece of paper (live print v2
 * slice E, spec §4.5 "Print sheet → composePostPrintSheetHtml (scoreboard,
 * accepted callouts, read, bogeys by source, notes) → renderHtmlToPdf →
 * printPdfViaLp, existing fallback and one-sheet ladder").
 *
 * This module does every derived computation — the delta, the state word, every
 * formatted figure — so the composer in lib/earnings/print-sheet.ts stays a pure
 * layout function (M-E15). That purity is the reason the split exists:
 * print-sheet.ts has ONE import (briefingToHtml) and no database, and pulling
 * `read-facts` in there for one delta formula would have dragged store.ts and
 * reconcile.ts along with it.
 *
 * Formatting goes through the print-watch line contract's own unit, using the
 * same `formatValue` the panel uses, so the paper and the screen agree digit for
 * digit.
 *
 * Paper is LOCAL: nothing here is privacy-masked (M-E9). The pre-print
 * worksheet has always printed real figures, and a fill-in sheet whose numbers
 * are dots is not a sheet. Model PROSE is a different question and still goes
 * through `sanitizeProseLines` — at render as well as at storage, because the
 * composer interpolates what it is handed verbatim by design.
 */
import type Database from "better-sqlite3";
import { getBogeysForEvent } from "@/lib/queries/earnings-bogeys";
import { renderSheetBogeysBlock } from "@/lib/digest/send-earnings-email";
import { getPrintById, getSheet } from "@/lib/print-watch/store";
import { getLatestDoneRead, listCallouts } from "@/lib/print-watch/read-store";
import { deltaPctNumber } from "@/lib/print-watch/read-facts";
import { formatValue, sanitizeProseLines } from "@/lib/print-watch/first-pass-format";
import {
  composePostPrintSheetHtml,
  composePostPrintText,
  type PostPrintSheetCallout,
  type PostPrintSheetInputs,
  type PostPrintSheetLine,
} from "@/lib/earnings/print-sheet";
import { printHtmlOneSheet } from "@/lib/earnings/print-ladder";
import { chromeBinaryPath } from "@/lib/earnings/print-pdf";
import { loadPrintSheetNotes, printerName, printViaLp } from "@/lib/earnings/worksheet";
import type { renderHtmlToPdf, printPdfViaLp } from "@/lib/earnings/print-pdf";
import type { PrintWatchLine } from "@/lib/print-watch/types";

// Typed as literal characters, never as a backslash-u escape: the Write/Edit
// hazard note (memory "Unicode-escape write hazard") is about escapes becoming
// raw bytes, so the raw byte is what gets typed in the first place.
/** Em dash — the sheet's "nothing here" cell. */
const DASH = "—";
/** En dash – the range separator, per typographic convention for spans. */
const NDASH = "–";

/**
 * The line state as a desk word. `retired` is absent on purpose: a retired line
 * never reaches this map because it never reaches the sheet.
 */
const STATE_WORDS: Record<string, string> = {
  accepted: "accepted",
  agreed: "agreed",
  single_source: "single source",
  flash: "flash",
  conflict: "conflict",
  blank: "not disclosed",
  pending: "pending",
};

function figure(line: PrintWatchLine, value: number | null): string {
  return value === null ? DASH : formatValue(value, line.contract.unit);
}

function toSheetLine(line: PrintWatchLine): PostPrintSheetLine {
  const expected = line.expected?.value ?? null;
  const reported =
    line.contract.kind === "range" && line.value !== null && line.value_high !== null
      ? `${figure(line, line.value)}${NDASH}${figure(line, line.value_high)}`
      : figure(line, line.value);
  // A guide RANGE has no single number to compare against a single bogey, so it
  // carries no delta — a made-up midpoint would be a number the desk never said.
  const delta = line.contract.kind === "range" ? null : deltaPctNumber(expected, line.value);
  return {
    metricId: line.metric_id,
    label: line.contract.label,
    stateWord: STATE_WORDS[line.state] ?? line.state,
    bogeyText: figure(line, expected),
    reportedText: reported,
    deltaText: delta === null ? DASH : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`,
  };
}

export function loadPostPrintSheetInputs(
  db: Database.Database,
  printId: number,
  now: Date = new Date(),
): PostPrintSheetInputs | null {
  const print = getPrintById(db, printId);
  if (!print) return null;

  // BMO / AMC comes from the EVENT, not the print: `release_time_et` is a
  // wall-clock time, and the slot is what the header line says.
  const ev = db
    .prepare(`SELECT event_time FROM calendar_events WHERE id = ?`)
    .get(print.event_id) as { event_time: string | null } | undefined;
  const slot = ev?.event_time ? ev.event_time.trim().toUpperCase() : null;

  // A retired line is preserved evidence of a contract that no longer applies
  // (089); it is never coverage and never prints.
  const lines = getSheet(db, printId)
    .filter((l) => l.state !== "retired")
    .map(toSheetLine);

  const callouts: PostPrintSheetCallout[] = listCallouts(db, printId)
    .filter((c) => c.effective_state === "accepted")
    .map((c) => {
      // The label is a MODEL-proposed string, so it is sanitised like any other
      // model prose. The figure is re-formatted from the verified `value`
      // rather than printed from the stored `value_text`, which is the model's
      // own transcription of it — the number the verifier accepted is the
      // number that goes on the paper.
      const [label] = sanitizeProseLines([c.label], 1);
      return {
        label: label ?? "",
        valueText: formatValue(c.value, c.unit),
        vsBogeyText: sanitizeProseLines([c.vs_bogey_text ?? ""], 1)[0] ?? "",
      };
    })
    // A label the sanitiser rejected outright leaves nothing to print BESIDE a
    // figure, and a bare figure on paper is worse than no row.
    .filter((c) => c.label !== "");

  const readRow = getLatestDoneRead(db, printId);
  let read: PostPrintSheetInputs["read"] = null;
  if (readRow?.prose_json) {
    try {
      const p = JSON.parse(readRow.prose_json) as {
        read?: unknown;
        call_watch?: unknown;
        caveats?: unknown;
      };
      read = {
        read: sanitizeProseLines(p.read, 10),
        call_watch: sanitizeProseLines(p.call_watch, 3),
        caveats: sanitizeProseLines(p.caveats, 6),
      };
    } catch {
      // Stored prose that no longer parses is not worth a failed print.
      read = null;
    }
  }

  const symbol = print.symbol.toUpperCase();
  return {
    symbol,
    eventDate: print.event_date,
    slot,
    lines,
    callouts,
    read,
    bogeysMd: renderSheetBogeysBlock(getBogeysForEvent(db, print.event_id)),
    notes: loadPrintSheetNotes(db, symbol),
    // ET wall-clock, never UTC: the desk reads this against the wire time.
    // The whitespace collapse normalises the narrow no-break space some ICU
    // versions put before AM/PM, so the string is the same on every machine.
    printedAtEt: `${now
      .toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
      .replace(/\s+/g, " ")} ET`,
  };
}

/**
 * Compose + print one print's post-print sheet.
 *
 * Same downgrade rule as the pre-print worksheet (2026-08-07): the PDF road is
 * preferred, and ANY failure along it — no Chrome, an unparseable render, an lp
 * error — falls back to the monospace sheet, so a press always produces paper.
 * Only a failure of BOTH roads throws.
 *
 * A sheet with no figure on it is refused rather than printed: the whole point
 * of the paper is the scoreboard, and blank paper wastes the one thing the desk
 * cannot get back during a print — the next thirty seconds.
 */
export async function printPostPrintSheetNow(
  db: Database.Database,
  printId: number,
  seams: {
    renderPdf?: typeof renderHtmlToPdf;
    printPdf?: typeof printPdfViaLp;
    printText?: typeof printViaLp;
    now?: () => Date;
  } = {},
): Promise<{ road: "pdf" | "monospace"; pages: number | null; symbol: string }> {
  const inputs = loadPostPrintSheetInputs(db, printId, seams.now ? seams.now() : new Date());
  if (!inputs) throw new Error(`No print ${printId}.`);
  if (!inputs.lines.some((l) => l.reportedText !== DASH)) {
    // The route refuses this first with the same domain copy
    // (PRINT_SHEET_DISABLED); this is the guard for every other caller.
    throw new Error("no line has a value yet — nothing to print");
  }

  const printText = seams.printText ?? printViaLp;
  const printer = printerName(db);
  const title = `${inputs.symbol} post-print sheet`;

  // No injected renderer and no Chrome on this machine means the PDF road
  // cannot even be attempted — skip straight to paper rather than burn a
  // spawn attempt during a print.
  if (seams.renderPdf || chromeBinaryPath()) {
    try {
      const { pages } = await printHtmlOneSheet({
        compose: ({ dropFlexible, compact }) => composePostPrintSheetHtml(inputs, { dropFlexible, compact }),
        symbol: inputs.symbol,
        title,
        printer,
        seams: { renderPdf: seams.renderPdf, printPdf: seams.printPdf },
      });
      return { road: "pdf", pages, symbol: inputs.symbol };
    } catch (err) {
      console.warn(
        `[post-print-sheet] PDF road failed for ${inputs.symbol} — falling back to monospace:`,
        err,
      );
    }
  }

  await printText(composePostPrintText(inputs), { printer, title });
  return { road: "monospace", pages: null, symbol: inputs.symbol };
}
