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
