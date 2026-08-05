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
      out.push(stripInline(heading[1]).toUpperCase());
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
