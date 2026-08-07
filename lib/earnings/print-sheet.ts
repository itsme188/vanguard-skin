/**
 * Email-identical printed earnings sheet (2026-08-06 print/prose round).
 *
 * Pure: no DB, no IO. Renders through the SAME markdown → email-HTML
 * renderer used for the earnings preview/recap emails (`briefingToHtml`,
 * `lib/calendar/briefing-html.ts`) — the sheet is deliberately a print-CSS
 * augmented version of the actual preview email, not a re-derived layout.
 * `assembleEmailMarkdown`-style section order pins scoreboard → sheet
 * bogeys → AI bogies table → user notes → past prints.
 *
 * Spec: docs/superpowers/specs/2026-08-06-earnings-print-prose-round-design.md
 */

import { briefingToHtml } from "@/lib/calendar/briefing-html";

export interface PrintSheetNote {
  date: string;
  noteType: string;
  symbol: string;
  content: string;
}

export interface PrintSheetInputs {
  symbol: string; // upper-cased
  eventDate: string; // YYYY-MM-DD
  eventTime: string | null; // BMO/AMC
  scoreboardMd: string; // renderHeadlineTable output
  sheetBogeysMd: string; // renderSheetBogeysBlock output ("" ok)
  bogiesTableMd: string; // verbatim from ai_output_md (heading + table)
  notes: PrintSheetNote[]; // complete content, newest first
  pastPrintsMd: string; // "" ok
  sentAt: string; // preview sent_at for the footer line
}

// Same regex as worksheet-rich.ts:67 — the AI's markdown heading for the
// line-by-line bogies table.
const BOGIES_HEADING = /^##\s+line.by.line/i;

/**
 * Extract the "## Line-by-line bogies" heading + its table VERBATIM (no
 * re-parse, no re-wrap) from a stored `ai_output_md`. Returns null when the
 * heading is missing, or when the next `##` heading appears before any
 * table row does (a heading with no table under it).
 */
export function extractBogiesTableMarkdown(aiOutputMd: string): string | null {
  const lines = aiOutputMd.split("\n");
  const headingIdx = lines.findIndex((l) => BOGIES_HEADING.test(l.trim()));
  if (headingIdx === -1) return null;

  let i = headingIdx + 1;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith("|")) break;
    if (/^##\s/.test(t)) return null;
    i++;
  }
  if (i >= lines.length) return null; // heading present, no table ever found

  const tableStart = i;
  while (i < lines.length && lines[i].trim().startsWith("|")) i++;

  return [lines[headingIdx], ...lines.slice(tableStart, i)].join("\n");
}

/**
 * The email envelope's inner content table pins `width="680"` (with a
 * matching `max-width:680px` inline style) so mail clients render a fixed
 * reading column — see `briefingToHtml` at lib/calendar/briefing-html.ts:98.
 * That table has no id/class (inline-styles-only, Outlook-safe renderer), so
 * the print override targets it via its unique `width="680"` attribute —
 * the only element in the envelope carrying that attribute. Widening it on
 * print lets the sheet's tables use the full page instead of the email's
 * fixed reading column.
 */
const PRINT_CSS = `<style>
  @page { size: letter; margin: 12mm 14mm; }
  @media print {
    table[width="680"] { max-width: 100% !important; width: 100% !important; }
  }
  /* A table never splits across the sheet boundary; notes flow. */
  table { break-inside: avoid; page-break-inside: avoid; }
  h2 { break-after: avoid; page-break-after: avoid; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style>`;

export function composePrintSheetHtml(inputs: PrintSheetInputs): string;
export function composePrintSheetHtml(
  inputs: PrintSheetInputs,
  opts: { includePastPrints?: boolean },
): string;
export function composePrintSheetHtml(
  inputs: PrintSheetInputs,
  opts: { includePastPrints?: boolean } = {},
): string {
  const includePast = opts.includePastPrints !== false;
  const slot = inputs.eventTime ? ` (${inputs.eventTime.toUpperCase()})` : "";
  const notesMd = inputs.notes.length
    ? `## Your notes\n\n${inputs.notes
        .map((n) => `**[${n.date}] · ${n.noteType} · ${n.symbol}**\n\n${n.content}`)
        .join("\n\n")}`
    : "";
  const md = [
    inputs.scoreboardMd,
    inputs.sheetBogeysMd,
    inputs.bogiesTableMd,
    notesMd,
    includePast ? inputs.pastPrintsMd : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const title = `${inputs.symbol} earnings sheet — ${inputs.eventDate}${slot}`;
  const html = briefingToHtml(md, title, `from preview email sent ${inputs.sentAt} · fill-in sheet`);
  return html.replace("</body>", `${PRINT_CSS}\n</body>`);
}
