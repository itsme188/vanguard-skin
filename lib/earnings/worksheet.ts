/**
 * Printable earnings worksheet (feedback #6, 2026-08-03; rich preview-derived
 * sheet added 2026-08-05).
 *
 * The primary sheet is the RICH one: `composeWorksheetForEvent` re-renders
 * the LOCAL preview email's stored prose (bogies table + commentary via
 * `lib/earnings/worksheet-rich.ts`) plus the code-rendered scoreboard/past-
 * prints markdown as a ruled monospace desk sheet with pen-sized blank
 * ACTUAL/Δ boxes. When no local preview exists yet (`loadRichWorksheetInputs`
 * → null — not sent yet, or a `'sent-by-cloud'` row with no stored prose),
 * it falls back to the deterministic sheet below (`composeWorksheet`):
 * scoreboard rows with blank ACTUAL/Δ columns, segment splits, guidance
 * bogeys with fill-in blanks, the user's own notes, scratch lines. Printed
 * via `lp` (CUPS) — zero rendering dependencies, reliable from the launchd
 * sweep.
 *
 * Auto-print: arming an event's flag (earnings_worksheet_flags) prints at
 * the sweep tick where the release instant sits inside [now−30m, now+135m]
 * — the preview window plus a grace band for late arming — AND a local
 * preview email is available (wait-for-preview gate, 2026-08-05 spec: the
 * rich sheet needs the preview's prose, so an armed-but-not-yet-previewed
 * event waits rather than auto-printing the thinner deterministic sheet) —
 * exactly once (printed_at stamp). "Print now" (POST /api/earnings/worksheet)
 * bypasses the window and the stamp entirely, and uses whichever sheet
 * (rich or deterministic) is available at that instant.
 *
 * `printWorksheetNow` additionally prefers an email-identical PDF road
 * (2026-08-06 print/prose round) over the monospace sheets above:
 * `loadPrintSheetInputs` + `composePrintSheetHtml` (lib/earnings/print-sheet.ts)
 * re-render the local preview email's own HTML, `renderHtmlToPdf`
 * (lib/earnings/print-pdf.ts) turns it into a PDF via headless Chrome, and
 * `printPdfViaLp` sends it duplex. Any failure along that road — no Chrome,
 * no local preview prose, a render/print error — falls back to the sheets
 * above, so a print always produces paper. **This is not a Print-now-only
 * path**: `printArmedWorksheets`' default `print` seam IS `printWorksheetNow`,
 * so the launchd auto-print sweep takes the PDF road too whenever a local
 * preview is available — that's the spec's primary goal, not a side effect.
 * `printArmedWorksheets` itself (its wait-gate + stamp/retry control flow) is
 * unchanged; only the sheet its default seam produces changed.
 *
 * Spec: docs/superpowers/specs/2026-08-03-worksheet-print-design.md,
 * docs/superpowers/specs/2026-08-05-worksheet-rich-preview-print-design.md,
 * docs/superpowers/specs/2026-08-06-earnings-print-prose-round-design.md
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  composeRichWorksheet,
  extractPreviewSections,
  wrapText,
  type RichWorksheetInputs,
} from "@/lib/earnings/worksheet-rich";
import { repairCitationLineBreaks } from "@/lib/earnings/repair-citation-linebreaks";
import { getEmailAudit } from "@/lib/queries/earnings-emails";
import {
  loadIntelView,
  renderHeadlineTable,
  renderPastPrintsBlock,
  renderSheetBogeysBlock,
} from "@/lib/digest/send-earnings-email";
import {
  composePrintSheetHtml,
  extractBogiesTableMarkdown,
  type PrintSheetInputs,
  type PrintSheetNote,
} from "@/lib/earnings/print-sheet";
import {
  chromeBinaryPath,
  countPdfPages,
  printPdfViaLp,
  renderHtmlToPdf,
} from "@/lib/earnings/print-pdf";

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
 * Pure composer — fixed-width text. Scratch lines flex down to their 3-line
 * minimum to absorb slack and keep the sheet to one page in the common
 * case, but notes never truncate to force a page count (issue #42):
 * whenever real content overflows MAX_LINES anyway, the sheet spills onto a
 * second page via `lp` instead of dropping tail lines.
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
  // Clamp: source_label is arbitrary newsletter text — padStart never
  // truncates, and a 100-char header wraps on the printer and shoves every
  // later line down (review probe: 104 cols).
  const moveClamped =
    title.length + move.length + 2 > WIDTH
      ? move.slice(0, Math.max(0, WIDTH - title.length - 3)) + "…"
      : move;
  lines.push(title + moveClamped.padStart(Math.max(0, WIDTH - title.length)));
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
      // Cap: every other section is bounded (guidance 4, notes 6) — an
      // unbounded segment dump would truncate GUIDANCE/NOTES/SCRATCH and the
      // footer past the 62-line page (review probe: 60-segment JSON).
      for (const [name, vals] of Object.entries(segs).slice(0, 8)) {
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
    for (const n of noteLines) {
      const wrapped = wrapText(n, 74);
      lines.push(`  · ${wrapped[0]}`);
      for (let i = 1; i < wrapped.length; i++) lines.push(`    ${wrapped[i]}`);
    }
  }

  // Scratch lines fill the remaining page (min 3, floor at MAX_LINES − 1).
  lines.push("");
  lines.push("SCRATCH");
  const scratchCount = Math.max(3, MAX_LINES - lines.length - 2);
  for (let i = 0; i < scratchCount; i++) lines.push(`  ${"_".repeat(WIDTH - 4)}`);

  // Footer is appended last, always. Notes-are-sacred (docs/reference/
  // earnings-pipeline.md §15, issue #42): the sheet used to hard-slice at
  // MAX_LINES − 1 here, silently dropping tail lines whenever bogeys/
  // guidance + notes ran long — NOTES sits late in the assembly (above), so
  // long notes were exactly what got cut. The scratch section above already
  // flexes down to its 3-line minimum whenever the rest of the sheet is
  // long, so if `lines` still exceeds MAX_LINES − 1 here, that overflow is
  // real content (typically notes) — let it spill onto a second page via
  // `lp` instead of truncating.
  const src = bogeys.find((b) => b.source_label)?.source_label;
  const body = lines;
  body.push(pad(`[${src ? `bogeys: ${src} · ` : ""}deterministic worksheet]`, WIDTH));
  return body.join("\n") + "\n";
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
  const noteLines = getNotesForFamily(db, [...issuerSiblings(event.symbol)]).map((n) =>
    n.content.replace(/\s+/g, " ").trim(),
  );

  return { event, bogeys, expectedMove, noteLines };
}

/**
 * Rich-sheet inputs from the LOCAL preview email. Null when the preview
 * hasn't been sent from this Mac (not yet, or 'sent-by-cloud' — those store
 * no prose) or its stored prose yields neither a bogies table nor
 * commentary. The auto-print pass treats null as "wait" (user decision,
 * 2026-08-05 spec); Print-now falls back to the deterministic sheet.
 */
export function loadRichWorksheetInputs(
  db: Database.Database,
  eventId: number,
): RichWorksheetInputs | null {
  const event = db
    .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
    .get(eventId) as CalendarEvent | undefined;
  if (!event || !event.symbol) return null;

  const audit = getEmailAudit(db, eventId, "preview");
  if (!audit?.ai_output_md) return null;

  // Display/print-time repair only (never at send/compose time) — see
  // lib/earnings/repair-citation-linebreaks.ts.
  const sections = extractPreviewSections(repairCitationLineBreaks(audit.ai_output_md));
  if (!sections.bogiesTable && !sections.commentary.trim()) return null;

  const symbol = event.symbol.toUpperCase();
  const intelView = loadIntelView(db, eventId, symbol);
  const scoreboardMd = renderHeadlineTable(event, symbol, "preview", intelView);
  const pastPrintsMd = renderPastPrintsBlock(intelView.history);

  const expectedMoveLabel = intelView.impliedMovePct != null
    ? `exp move ±${intelView.impliedMovePct.toFixed(1)}% (${
        intelView.impliedMethod === "sheet"
          ? intelView.sheetSourceLabel ?? "bogey sheet"
          : intelView.impliedMethod === "straddle"
            ? "straddle"
            : "IV approx"
      })`
    : "";

  const noteLines = getNotesForFamily(db, [...issuerSiblings(event.symbol)])
    .map((n) => n.content.replace(/\s+/g, " ").trim());

  return {
    event: {
      symbol: event.symbol,
      event_date: event.event_date,
      event_time: event.event_time,
    },
    scoreboardMd,
    pastPrintsMd,
    sections,
    noteLines,
    sentAt: audit.sent_at,
    expectedMoveLabel,
  };
}

/**
 * Email-identical print-sheet inputs (2026-08-06 print/prose round). Null
 * when there's no LOCAL preview email yet (not sent, or a 'sent-by-cloud'
 * row with no stored prose — same nullness as `loadRichWorksheetInputs`) or
 * its stored prose has no verbatim "## Line-by-line bogies" table (the PDF
 * road re-renders exactly what the email said; a table-less preview has
 * nothing worth an email-fidelity reproduction, so `printWorksheetNow` falls
 * back to the deterministic sheet instead).
 */
export function loadPrintSheetInputs(
  db: Database.Database,
  eventId: number,
): PrintSheetInputs | null {
  const event = db
    .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
    .get(eventId) as CalendarEvent | undefined;
  if (!event || !event.symbol) return null;

  const audit = getEmailAudit(db, eventId, "preview");
  if (!audit?.ai_output_md) return null;

  // Same display/print-time repair as loadRichWorksheetInputs, applied
  // BEFORE extracting the table — see lib/earnings/repair-citation-linebreaks.ts.
  const repaired = repairCitationLineBreaks(audit.ai_output_md);
  const bogiesTableMd = extractBogiesTableMarkdown(repaired);
  if (!bogiesTableMd) return null;

  const symbol = event.symbol.toUpperCase();
  const intelView = loadIntelView(db, eventId, symbol);
  const notes: PrintSheetNote[] = getNotesForFamily(db, [...issuerSiblings(event.symbol)]).map(
    (n) => ({
      // Mirrors renderUserNotesBlock's date choice (send-earnings-email.ts)
      // and its `n.symbol ?? <event symbol>` fallback for family-linked notes.
      date: n.event_date ?? n.created_at.slice(0, 10),
      noteType: n.note_type,
      symbol: n.symbol ?? symbol,
      content: n.content,
    }),
  );

  return {
    symbol,
    eventDate: event.event_date,
    eventTime: event.event_time,
    scoreboardMd: renderHeadlineTable(event, symbol, "preview", intelView),
    sheetBogeysMd: renderSheetBogeysBlock(getBogeysForEvent(db, eventId)),
    bogiesTableMd,
    notes,
    pastPrintsMd: renderPastPrintsBlock(intelView.history),
    sentAt: audit.sent_at,
  };
}

/**
 * One entry point for "what would this event's worksheet look like":
 * rich (preview-derived) when available, deterministic fallback otherwise.
 * Null for missing/symbol-less events.
 */
export function composeWorksheetForEvent(
  db: Database.Database,
  eventId: number,
): { text: string; rich: boolean; symbol: string } | null {
  const rich = loadRichWorksheetInputs(db, eventId);
  if (rich) {
    return {
      text: composeRichWorksheet(rich),
      rich: true,
      symbol: (rich.event.symbol ?? "").toUpperCase(),
    };
  }
  const det = loadWorksheetInputs(db, eventId);
  if (!det) return null;
  return {
    text: composeWorksheet(det),
    rich: false,
    symbol: (det.event.symbol ?? "").toUpperCase(),
  };
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
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // A wedged cupsd is the one lp failure mode that hangs instead of
    // failing fast (live-probed: offline printers queue-and-exit, bad
    // destinations reject immediately) — and this runs ahead of the sweep's
    // load-bearing preview loop, so kill after 20s.
    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error("lp timed out after 20s (cupsd wedged?)")));
    }, 20_000);
    child.stderr.on("data", (d) => (stderr += String(d)));
    // lp can exit before draining stdin — without this listener the EPIPE
    // surfaces as an uncaught stream error that bypasses the promise.
    child.stdin.on("error", () => {});
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) resolve();
        else reject(new Error(`lp exited ${code}: ${stderr.trim()}`));
      });
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * Compose + print one event's worksheet. Called directly for "Print now"
 * (POST /api/earnings/worksheet) AND as `printArmedWorksheets`' default
 * `print` seam — i.e. this is ALSO the launchd auto-print sweep's road, not
 * a manual-only path.
 *
 * Two roads: PDF (email-identical — the same markdown → HTML renderer as the
 * preview email, headless-Chrome to PDF, duplex `lp`) is preferred whenever a
 * local preview's prose is available AND Chrome is installed (or a test seam
 * stands in for it). Any failure along that road — no Chrome binary, an
 * unparseable/0-page render, a print error — falls back to the
 * deterministic/rich monospace sheet (`composeWorksheetForEvent`,
 * unchanged), so a print always produces SOME paper. One-sheet rule
 * (2026-08-07: extended to a 3-render ladder, capped — never loops): if the
 * first PDF render comes out longer than 2 pages, re-render WITHOUT the
 * "Past prints" section (the flexible, lowest-priority block); if THAT is
 * still longer than 2 pages, re-render once more with `{ compact: true }`
 * (smaller font, tighter spacing — see `lib/earnings/print-sheet.ts`'s
 * COMPACT_CSS) stacked on top of the dropped Past prints, shrinking the
 * layout to fit WITHOUT truncating anything. Whichever render is LAST
 * attempted is what prints — notes and the bogies table never truncate to
 * force a page count, so a stubborn overflow (3 renders, still >2 pages)
 * prints anyway rather than cutting content.
 *
 * Stamp semantics (2026-08-07 decision, supersedes the spec's original
 * error-table row): a PDF-road `lp` failure falls through to the monospace
 * road rather than surfacing as a print failure, and `printArmedWorksheets`
 * stamps on THAT road's success. A PDF-specific CUPS failure would otherwise
 * fail every retry until the auto-print window closes with zero paper ever
 * printed; a monospace success at least gets something on the desk. Only a
 * failure of BOTH roads (printer-level, e.g. offline/wedged cupsd) leaves
 * the event stampless for the next tick's retry.
 */
export async function printWorksheetNow(
  db: Database.Database,
  eventId: number,
  seams: {
    renderPdf?: typeof renderHtmlToPdf;
    printPdf?: typeof printPdfViaLp;
    printText?: typeof printViaLp;
  } = {},
): Promise<{ symbol: string; road: "pdf" | "monospace" }> {
  const renderPdf = seams.renderPdf ?? renderHtmlToPdf;
  const printPdf = seams.printPdf ?? printPdfViaLp;
  const printText = seams.printText ?? printViaLp;

  // loadPrintSheetInputs does DB reads + markdown assembly — best-effort,
  // same as every other lookup this function chains: a failure here must
  // degrade to the monospace road, never abort the print entirely.
  let sheet: PrintSheetInputs | null = null;
  try {
    sheet = loadPrintSheetInputs(db, eventId);
  } catch (err) {
    console.warn(`[worksheet] loadPrintSheetInputs failed for event ${eventId} — falling back to monospace:`, err);
  }

  if (sheet && (seams.renderPdf || chromeBinaryPath())) {
    try {
      let html = composePrintSheetHtml(sheet);
      let pdf = await renderPdf(html);
      let pages = countPdfPages(pdf);
      // A 0-page count means the renderer produced something unparseable
      // (garbage bytes, a truncated file) — 0 is NOT <= 2 in a way that
      // should ever be trusted as "fits on one sheet"; treat it as a render
      // failure so it lands in the catch below and degrades to monospace.
      if (pages === 0) throw new Error("unparseable PDF (no /Type /Page objects)");
      if (pages > 2) {
        // Step 2 of the one-sheet ladder: drop Past prints (the flexible,
        // lowest-priority block) and try again.
        html = composePrintSheetHtml(sheet, { includePastPrints: false });
        pdf = await renderPdf(html);
        pages = countPdfPages(pdf);
        if (pages === 0) throw new Error("unparseable PDF (no /Type /Page objects)");
        if (pages > 2) {
          // Step 3: still doesn't fit — compact the layout (smaller font,
          // tighter spacing) instead of truncating anything, stacked on top
          // of the already-dropped Past prints. If this is STILL >2 pages,
          // fall through and print it anyway — notes and the bogies table
          // never truncate to force a page count. Capped here: never a
          // fourth render.
          html = composePrintSheetHtml(sheet, { includePastPrints: false, compact: true });
          pdf = await renderPdf(html);
          pages = countPdfPages(pdf);
          if (pages === 0) throw new Error("unparseable PDF (no /Type /Page objects)");
        }
      }
      const dir = mkdtempSync(join(tmpdir(), "vgs-sheet-"));
      const pdfPath = join(dir, `${sheet.symbol}-sheet.pdf`);
      try {
        writeFileSync(pdfPath, pdf);
        await printPdf(pdfPath, { printer: printerName(db), title: `${sheet.symbol} earnings sheet` });
      } finally {
        // Best-effort: a cleanup throw here must NOT be caught by the outer
        // try — that would re-enter the monospace fallback AFTER lp already
        // accepted the PDF job (double paper) and misreport `road`.
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[worksheet] temp-dir cleanup failed for ${dir}:`, err);
        }
      }
      return { symbol: sheet.symbol, road: "pdf" };
    } catch (err) {
      // PDF-road lp failure deliberately falls through to monospace — paper
      // now beats stampless retries of a road that will keep failing;
      // decision 2026-08-07, supersedes the spec's original error-table row.
      console.warn(`[worksheet] PDF road failed for ${sheet.symbol} — falling back to monospace:`, err);
    }
  }

  const composed = composeWorksheetForEvent(db, eventId);
  if (!composed) throw new Error(`Event ${eventId} not found or symbol-less.`);
  await printText(composed.text, {
    printer: printerName(db),
    title: `${composed.symbol} earnings worksheet`,
  });
  return { symbol: composed.symbol, road: "monospace" };
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
      // Wait-for-preview gate (2026-08-05 spec, user decision): the rich
      // sheet needs the LOCAL preview email's prose. No local preview yet →
      // leave the flag unstamped and retry next tick; the window closing at
      // release+30m naturally ends retries. Cloud-sent previews never
      // auto-print (Mac was asleep — nobody home to collect paper);
      // "Print now" covers those via the deterministic fallback.
      if (loadRichWorksheetInputs(db, f.eventId) === null) {
        console.log(
          `[worksheet] ${f.symbol ?? f.eventId} armed but no local preview yet — waiting`,
        );
        continue;
      }
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
