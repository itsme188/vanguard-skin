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

// Same shapes as lib/calendar/briefing-html.ts's tableRowRe / tableSeparatorRe
// — a table-like block only counts as a real table when its first line is a
// header row and its second line is a separator row of matching column
// count. Column counts are compared by splitting on UNESCAPED pipes only
// (consistent with parseTableRow's `\|` escape rule in briefing-html.ts /
// workers/cron/src/html.ts), so an escaped pipe inside a header cell doesn't
// inflate the count.
const TABLE_HEADER_ROW_RE = /^\|(.+)\|\s*$/;
const TABLE_SEPARATOR_ROW_RE = /^\|(\s*:?-+:?\s*\|)+\s*$/;

function countColumns(line: string): number {
  return line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
}

/**
 * Extract the "## Line-by-line bogies" heading + its table VERBATIM (no
 * re-parse, no re-wrap) from a stored `ai_output_md`. Returns null when the
 * heading is missing, when the next `##` heading appears before any table
 * row does (a heading with no table under it), or when the table block
 * doesn't structurally validate as a real table (issue #41: a malformed
 * model response — e.g. a single incomplete pipe row with no separator —
 * must fall back to the deterministic worksheet, not print raw pipe text).
 * Only the header + separator rows are validated; data rows after the
 * separator are extracted verbatim without column-count checks, since real
 * model output sometimes varies there.
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

  const tableLines = lines.slice(tableStart, i).map((l) => l.trim());
  if (tableLines.length < 2) return null;
  const [headerLine, separatorLine] = tableLines;
  if (!TABLE_HEADER_ROW_RE.test(headerLine)) return null;
  if (!TABLE_SEPARATOR_ROW_RE.test(separatorLine)) return null;
  if (countColumns(headerLine) !== countColumns(separatorLine)) return null;

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
    /* FEEDBACK 1 (2026-08-07): "blank background, just black on white" — the
       envelope is the outbound-email amber theme (COLORS.canvas cream body,
       COLORS.gold headings/links, TABLE_COLORS.headerBg amber-tinted th, the
       goldGlow blockquote/code fill) — see lib/calendar/briefing-html.ts:37-64.
       Every one of those is an INLINE style (briefingToHtml renders
       Outlook-safe inline styles only, no classes/ids to hook), so inline
       specificity beats any unqualified CSS rule and every override below
       needs !important. Table BORDERS are left untouched — the ruled grid
       (TABLE_COLORS.border, #777) is what makes the sheet fillable by hand. */
    body, table, thead, tbody, tr, td, th, div, p, ul, li,
    h1, h2, h3, blockquote, code, a, strong, em, span {
      background: #ffffff !important;
      background-color: #ffffff !important;
      color: #000000 !important;
    }
    /* Header row keeps a light-gray tint instead of the email's amber
       #f4efe0 — it still reads as "gray, not white" on a B/W printer, so the
       header row stays visually distinct from fill-in body cells even
       though its own border (kept above) already separates them either way. */
    th {
      background-color: #eeeeee !important;
    }
  }
  /* A table never splits across the sheet boundary; notes flow. */
  table { break-inside: avoid; page-break-inside: avoid; }
  h2 { break-after: avoid; page-break-after: avoid; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* FEEDBACK 2a (2026-08-07): the footer ("Portfolio Desk · Generated ..." +
     "from preview email sent ...") was landing on its own orphan page — its
     inline padding:64px top spacer plus the ancestor table's break-inside:
     avoid left the browser no room to fit it at the bottom of the prior
     page, so it pushed the whole block to a fresh page instead. Target it by
     its unique inline-style substrings — briefingToHtml has no id/class to
     hook (see lib/calendar/briefing-html.ts:111-121) and this file must not
     edit that renderer (it's shared by every outbound email). Shrink the top
     spacer AND ban a break directly before it so it stays attached to
     whatever content precedes it.
  */
  td[style*="padding:64px 0 0"] {
    padding-top: 8px !important;
    break-before: avoid !important;
    page-break-before: avoid !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  div[style*="border-top:1px solid"] {
    break-before: avoid !important;
    page-break-before: avoid !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
</style>`;

/**
 * Step 3 of the one-sheet ladder (`printWorksheetNow`, lib/earnings/worksheet.ts):
 * shrinks the layout to fit WITHOUT truncating any content — smaller base
 * font-size, tighter line-height, reduced table/cell padding and margins.
 * Applied only when dropping "Past prints" alone wasn't enough. Same
 * !important requirement as PRINT_CSS (inline styles throughout the
 * envelope). The leading HTML comment is a stable, content-independent
 * marker so callers/tests can detect whether a given render used compaction
 * without depending on the exact tuned values below.
 */
const COMPACT_CSS = `<!-- compact-print-sheet -->
<style>
  @media print {
    body { font-size: 90% !important; }
    p, li { margin: 10px 0 !important; line-height: 1.35 !important; }
    h1 { margin: 0 0 12px !important; }
    h2 { margin: 24px 0 10px !important; padding-bottom: 6px !important; }
    h3 { margin: 18px 0 8px !important; }
    ul { margin: 10px 0 !important; }
    table { margin: 10px 0 !important; }
    th, td { padding: 4px 6px !important; }
    blockquote { margin: 12px 0 !important; padding: 8px 12px !important; }
  }
</style>`;

export function composePrintSheetHtml(inputs: PrintSheetInputs): string;
export function composePrintSheetHtml(
  inputs: PrintSheetInputs,
  opts: { includePastPrints?: boolean; compact?: boolean },
): string;
export function composePrintSheetHtml(
  inputs: PrintSheetInputs,
  opts: { includePastPrints?: boolean; compact?: boolean } = {},
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
  const css = opts.compact ? `${PRINT_CSS}\n${COMPACT_CSS}` : PRINT_CSS;
  return html.replace("</body>", `${css}\n</body>`);
}
