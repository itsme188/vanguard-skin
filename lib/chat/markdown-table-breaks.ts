/**
 * A chat answer sometimes writes `<br>` inside a GFM table cell to stack
 * several lines in one cell. The renderer (MarkdownMessage) escapes raw HTML
 * on purpose, so the tag printed as text and the lines ran together
 * (qa:chat-overlay-mobile-390x844-answer-tables-all-accounts-chat-answer-table-prints-literal-br-tags-inside-its-cel).
 *
 * A GFM table cell cannot hold a line break, so the tag is turned into a
 * separator on table rows only. Prose outside a table is left as written.
 */

const BR_RE = /<br\s*\/?>/gi;
const FENCE_RE = /^\s*(```|~~~)/;

export const TABLE_CELL_SEPARATOR = " · ";

/** True for a line that reads as a GFM table row: a leading pipe, or a pipe between cells. */
export function isTableRowLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (t.startsWith("|")) return true;
  return /\S\s*\|\s*\S/.test(t);
}

/** Replace `<br>` tags on table rows with a cell separator; leave every other line alone. */
export function softenTableBreaks(markdown: string): string {
  if (!BR_RE.test(markdown)) return markdown;
  BR_RE.lastIndex = 0;
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || !isTableRowLine(line)) return line;
      return line
        .replace(BR_RE, TABLE_CELL_SEPARATOR)
        // A tag at the start or end of a cell leaves a dangling separator.
        .replace(/\|\s*·\s+/g, "| ")
        .replace(/\s+·\s*\|/g, " |")
        .replace(/\s+·\s*$/g, "");
    })
    .join("\n");
}
