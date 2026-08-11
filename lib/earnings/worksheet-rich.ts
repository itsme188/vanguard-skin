/**
 * Rich preview-based worksheet composer (feedback follow-up, 2026-08-05).
 *
 * Pure: no DB, no IO. Re-renders the stored preview email
 * (earnings_emails.ai_output_md — the AI "## Line-by-line bogies" table +
 * commentary) plus the code-rendered scoreboard / past-prints markdown as a
 * ruled 80-col monospace sheet with pen-sized blank ACTUAL/Δ columns.
 *
 * Spec: docs/superpowers/specs/2026-08-05-worksheet-rich-preview-print-design.md
 */

export interface ParsedMarkdownTable {
  header: string[];
  rows: string[][];
}

export interface PreviewSections {
  bogiesTable: ParsedMarkdownTable | null;
  commentary: string;
}

const stripInline = (s: string): string =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();

const isTableRow = (line: string): boolean => line.trim().startsWith("|");
const isSeparatorRow = (line: string): boolean =>
  /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => stripInline(c));
}

/** Parse a markdown table starting at lines[0]; null if lines[0] isn't one. */
export function parseMarkdownTable(lines: string[]): ParsedMarkdownTable | null {
  if (lines.length === 0 || !isTableRow(lines[0])) return null;
  const header = splitCells(lines[0]);
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!isTableRow(lines[i])) break;
    if (isSeparatorRow(lines[i])) continue;
    rows.push(splitCells(lines[i]));
  }
  return { header, rows };
}

/** First markdown table in md, plus everything after it (or all of md). */
export function extractFirstTable(md: string): {
  table: ParsedMarkdownTable | null;
  after: string;
} {
  const lines = md.split("\n");
  const start = lines.findIndex(isTableRow);
  if (start === -1) return { table: null, after: md };
  let end = start;
  while (end < lines.length && isTableRow(lines[end])) end++;
  return {
    table: parseMarkdownTable(lines.slice(start, end)),
    after: lines.slice(end).join("\n"),
  };
}

const BOGIES_HEADING = /^##\s+line.by.line/i;
const SOURCES_HEADING = /^##\s+sources\b/i;

/** Split stored preview prose into the bogies table + the commentary span. */
export function extractPreviewSections(aiOutputMd: string): PreviewSections {
  const lines = aiOutputMd.split("\n");
  const sourcesIdx = lines.findIndex((l) => SOURCES_HEADING.test(l.trim()));
  const scoped = (sourcesIdx === -1 ? lines : lines.slice(0, sourcesIdx)).join("\n");

  const headingIdx = scoped
    .split("\n")
    .findIndex((l) => BOGIES_HEADING.test(l.trim()));
  if (headingIdx === -1) {
    return { bogiesTable: null, commentary: scoped.trim() };
  }
  const fromHeading = scoped.split("\n").slice(headingIdx + 1).join("\n");

  // Guard: only accept the table if it appears before the next ## heading
  const fhLines = fromHeading.split("\n");
  const nextHeading = fhLines.findIndex((l) => /^##\s/.test(l.trim()));
  const tableIdx = fhLines.findIndex(isTableRow);
  if (tableIdx === -1 || (nextHeading !== -1 && tableIdx > nextHeading)) {
    return { bogiesTable: null, commentary: fromHeading.trim() };
  }

  const { table, after } = extractFirstTable(fromHeading);
  return { bogiesTable: table, commentary: after.trim() };
}

/** Word-wrap; words longer than width hard-split. Always ≥1 line. */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (let word of words) {
    while (word.length > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Markdown → wrapped plain-text lines for the printer. */
export function mdToPlainText(md: string, width = 78): string[] {
  const out: string[] = [];
  const pushBlank = () => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      pushBlank();
      for (const w of wrapText(stripInline(heading[1]).toUpperCase(), width)) out.push(w);
      continue;
    }
    if (line.trim() === "") {
      pushBlank();
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const wrapped = wrapText(stripInline(bullet[1]), width - 2);
      out.push("- " + wrapped[0]);
      for (const w of wrapped.slice(1)) out.push("  " + w);
      continue;
    }
    for (const w of wrapText(stripInline(line), width)) out.push(w);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  while (out.length > 0 && out[0] === "") out.shift();
  return out;
}

export interface TableLayout {
  widths: number[];
  fillIn?: number[];
}

/** Ruled fixed-width table. See spec: blank fill-in boxes for "—" cells. */
export function renderMonospaceTable(
  table: ParsedMarkdownTable,
  layout: TableLayout,
): string[] {
  const { widths } = layout;
  const fillIn = new Set(layout.fillIn ?? []);
  const sep = widths.map((w) => "─".repeat(w)).join("┼");

  const renderRow = (cells: string[], isHeader: boolean): string[] => {
    const wrapped = widths.map((w, i) => {
      let cell = cells[i] ?? "";
      if (!isHeader && fillIn.has(i) && (cell === "—" || cell === "")) cell = "";
      return wrapText(cell, w);
    });
    const height = Math.max(...wrapped.map((c) => c.length));
    const lines: string[] = [];
    for (let li = 0; li < height; li++) {
      lines.push(widths.map((w, i) => (wrapped[i][li] ?? "").padEnd(w)).join("│"));
    }
    return lines;
  };

  const out: string[] = [];
  out.push(...renderRow(table.header, true));
  out.push(sep);
  for (const row of table.rows) {
    out.push(...renderRow(row, false));
    out.push(sep);
  }
  return out;
}

export const WIDTH = 80;
export const MAX_LINES = 62;
export const MAX_PAGES = 3;
export const MAX_BOGIES_ROWS = 20;

export const BOGIES_LAYOUT: TableLayout = { widths: [16, 41, 13, 6], fillIn: [2, 3] };
export const SCOREBOARD_LAYOUT: TableLayout = { widths: [26, 22, 18, 10], fillIn: [2, 3] };
export const PAST_PRINTS_LAYOUT: TableLayout = { widths: [12, 20, 12, 16] };

export interface RichWorksheetInputs {
  event: { symbol: string | null; event_date: string; event_time: string | null };
  scoreboardMd: string;
  pastPrintsMd: string;
  sections: PreviewSections;
  noteLines: string[];
  sentAt: string | null;
  expectedMoveLabel: string;
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

/** Table block from renderer markdown: uppercase title + monospace table +
 * trailing prose (footnotes) as plain text. Empty md → []. */
function tableBlock(title: string, md: string, layout: TableLayout, keepAfter: boolean): string[] {
  if (!md.trim()) return [];
  const { table, after } = extractFirstTable(md);
  if (!table) return [];
  const out = ["", title, ...renderMonospaceTable(table, layout)];
  if (keepAfter) {
    const note = mdToPlainText(after);
    // Drop heading-only remnants (the source md's ## title precedes the table
    // and is replaced by our own title; `after` holds only what FOLLOWS).
    if (note.length > 0) out.push(...note);
  }
  return out;
}

export function composeRichWorksheet(inputs: RichWorksheetInputs): string {
  const { event, sections, noteLines } = inputs;
  const symbol = (event.symbol ?? "").toUpperCase();
  const slot = event.event_time && /^(BMO|AMC)$/i.test(event.event_time.trim())
    ? ` (${event.event_time.trim().toUpperCase()})`
    : "";
  const title = `${symbol} — ${fmtShortDate(event.event_date)}${slot}`;
  const move = inputs.expectedMoveLabel;
  const moveClamped =
    title.length + move.length + 2 > WIDTH
      ? move.slice(0, Math.max(0, WIDTH - title.length - 3)) + "…"
      : move;

  const fixed: string[] = [];
  fixed.push(title + moveClamped.padStart(Math.max(0, WIDTH - title.length)));
  fixed.push("─".repeat(WIDTH));

  fixed.push(...tableBlock("SCOREBOARD", inputs.scoreboardMd, SCOREBOARD_LAYOUT, false));
  fixed.push(...tableBlock("PAST PRINTS", inputs.pastPrintsMd, PAST_PRINTS_LAYOUT, true));

  if (sections.bogiesTable) {
    const capped: ParsedMarkdownTable = {
      header: sections.bogiesTable.header,
      rows: sections.bogiesTable.rows.slice(0, MAX_BOGIES_ROWS),
    };
    fixed.push("", "LINE-BY-LINE BOGIES", ...renderMonospaceTable(capped, BOGIES_LAYOUT));
    const dropped = sections.bogiesTable.rows.length - capped.rows.length;
    if (dropped > 0) fixed.push(`(+${dropped} more rows — see email)`);
  }

  const notes: string[] = [];
  if (noteLines.length > 0) {
    notes.push("", "NOTES (YOURS)");
    for (const n of noteLines) {
      const wrapped = wrapText(n, 74);
      notes.push(`  · ${wrapped[0]}`);
      for (let i = 1; i < wrapped.length; i++) {
        notes.push(`    ${wrapped[i]}`);
      }
    }
  }

  function clampLineWidth(line: string): string {
    return line.length > WIDTH ? line.slice(0, WIDTH - 1) + "…" : line;
  }

  const footer = clampLineWidth(`[from preview email sent ${inputs.sentAt ?? "—"} · fill-in worksheet]`);

  // Commentary flexes into whatever the 3-page budget leaves (1 line reserved
  // for the footer). Section titles inside the commentary are its own
  // uppercase headings (THE SETUP, BULL CASE / BEAR CASE, …).
  const budget = MAX_LINES * MAX_PAGES - 1 - fixed.length - notes.length - 1; // −1 leading blank
  let commentary = sections.commentary.trim() ? mdToPlainText(sections.commentary) : [];
  // Only truncate when commentary is non-empty AND actually longer than budget
  if (commentary.length > 0 && commentary.length > budget) {
    commentary = [...commentary.slice(0, Math.max(0, budget - 1)), "… (full text in the preview email)"];
  }
  if (commentary.length > 0) commentary = ["", ...commentary];

  const body = [...fixed, ...commentary, ...notes];

  // Scratch fills the remainder of the final page when there's real room.
  const used = body.length + 1; // + footer
  const free = MAX_LINES - (used % MAX_LINES === 0 ? MAX_LINES : used % MAX_LINES);
  if (free >= 5) {
    body.push("", "SCRATCH");
    for (let i = 0; i < free - 3; i++) body.push(`  ${"_".repeat(WIDTH - 4)}`);
  }

  // 3-page budget: footer is appended last, always. Notes-are-sacred
  // (docs/reference/earnings-pipeline.md §15, issue #42): this used to be a
  // hard `body.slice(0, MAX_LINES * MAX_PAGES - 1)` here, which silently cut
  // into NOTES whenever fixed sections + notes ALONE (even with commentary
  // trimmed to zero by the budget above) still ran past the cap — notes are
  // appended after commentary, so they sat in the discarded tail. Commentary
  // is already budgeted above to fit fixed sections + notes within the cap
  // for the common case; when it isn't enough, keep the full body and let
  // pagination below emit extra page(s) instead of truncating.
  const cappedBody = body;
  cappedBody.push(footer);

  // Deterministic pagination: form feed after every 62 lines.
  const pages: string[] = [];
  for (let i = 0; i < cappedBody.length; i += MAX_LINES) {
    pages.push(cappedBody.slice(i, i + MAX_LINES).join("\n"));
  }
  return pages.join("\f") + "\n";
}
