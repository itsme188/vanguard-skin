/**
 * Document text extractor for the armed-print filing summary.
 *
 * Turns one EDGAR filing document (HTML / inline XBRL) into numbered text
 * blocks and table grids, so later steps can footnote a quote as
 * "page 3, paragraph 4" and read a table as a grid when checking a figure.
 *
 * Rules (plan Task 3):
 * - Page break: an element whose style says `page-break-before:always` /
 *   `break-before:page` (break before it) or `page-break-after:always` /
 *   `break-after:page` (break after it). EDGAR filers mostly write
 *   `<hr style="page-break-after:always">`. A break takes effect at the next
 *   text-bearing block, so back-to-back breaks and a trailing break never make
 *   an empty page. With no break at all, everything is page 1 and
 *   `pageBreaksReliable` is false.
 * - Block: the innermost text-bearing `p | div | li | h1-6 | tr`. Text is cut
 *   into blocks at every block-level open or close tag, so nested wrappers
 *   collapse to their innermost text. `para` counts blocks from 1 within each
 *   page; a table row is one block.
 * - Tables: header rows are the leading rows with no numeric cell (a bare
 *   year such as "2026" is not numeric). colspan text is spread across every
 *   covered column (R3; unlike repA in `lib/print-watch/representations.ts`,
 *   which puts it in the first column only). A table where no row has a
 *   numeric cell has no header rows (every row is a body row), so text-only
 *   layout tables still get row labels.
 * - Block indexing: a body-row block carries `tableId` = `TableGrid.id`
 *   (1-based, in document order) and `rowIndex` = its 0-based index into
 *   `TableGrid.rows`; a header-row block carries `tableId` and `rowIndex: null`.
 * - `<ix:header>` (hidden inline-XBRL facts), `<head>`, scripts, styles and
 *   comments are stripped before tokenising.
 */
import { decodeEntities, tokenize } from "@/lib/print-watch/representations";
import type { DocText, TableGrid, TextBlock } from "./types";

export const EXTRACTOR_VERSION = 1;

const SCALE_RE = /\b(in|amounts in)\s+(thousands|millions|billions)\b[^)\n]*/i;

/** Tags whose open or close tag ends the current run of body text. */
const BOUNDARY_TAGS = new Set([
  "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "dl", "dt", "dd", "blockquote", "section", "article", "header",
  "footer", "center", "pre", "address", "body", "html", "hr", "table",
]);

/** Tags that never have a closing tag; a break-after on them applies at once. */
const VOID_TAGS = new Set(["hr", "br", "img", "meta", "link", "input", "col", "wbr", "area", "base", "source"]);

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function preClean(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<ix:header\b[\s\S]*?<\/ix:header\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
    .replace(/<(script|style|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
}

function breakStyle(attrs: Record<string, string>): { before: boolean; after: boolean } {
  const style = (attrs.style ?? "").replace(/\s+/g, "").toLowerCase();
  if (!style) return { before: false, after: false };
  return {
    before: style.includes("page-break-before:always") || style.includes("break-before:page"),
    after: style.includes("page-break-after:always") || style.includes("break-after:page"),
  };
}

/**
 * A cell is numeric when, after removing currency signs, percent signs,
 * thousands separators, parentheses and a leading sign, it is a number. A
 * bare four-digit year (1900–2099) is a column heading, not a figure.
 */
function isNumericCell(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(19|20)\d{2}$/.test(t)) return false;
  const stripped = t.replace(/[$€£¥%,()\s]/g, "").replace(/^[-+−–]/, "");
  return /^(\d+(\.\d+)?|\.\d+)$/.test(stripped);
}

/** First scale statement ("in millions, except …") among the texts, in order. */
function firstScaleNote(texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(SCALE_RE);
    if (m) return m[0].trim();
  }
  return null;
}

/** A block's text; a table-row block split back into its cells. */
function blockParts(b: TextBlock): string[] {
  return b.tableId === null ? [b.text] : b.text.split(" | ");
}

interface CellBuild { parts: string[]; colspan: number }
interface RowBuild { cells: CellBuild[]; current: CellBuild | null }
interface DoneRow { cells: Array<{ text: string; colspan: number }>; breakBefore: boolean }
interface TableBuild { rows: DoneRow[]; current: RowBuild | null }

function colspanOf(attrs: Record<string, string>): number {
  const n = parseInt(attrs.colspan ?? "1", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 1;
}

export function extractDocText(html: string): DocText {
  const cleaned = preClean(html);
  const blocks: TextBlock[] = [];
  const tables: TableGrid[] = [];

  let page = 1;
  let para = 0;
  let pendingBreak = false;
  let breaksFound = 0;

  let bodyText: string[] = [];
  /** Open non-void elements with a break-after style, by tag name. */
  const openStack: Array<{ name: string; breakAfter: boolean }> = [];
  /** Outermost table being read; nested tables only add text to its cell. */
  let table: TableBuild | null = null;
  let tableDepth = 0;

  const markBreak = (): void => {
    breaksFound++;
    pendingBreak = true;
  };

  const emit = (text: string, tableId: number | null, rowIndex: number | null, breakBefore: boolean): TextBlock => {
    if (breakBefore && blocks.length > 0) {
      page++;
      para = 0;
    }
    para++;
    const block: TextBlock = { index: blocks.length, page, para, text, tableId, rowIndex };
    blocks.push(block);
    return block;
  };

  const flushBody = (): void => {
    if (bodyText.length === 0) return;
    const text = squash(bodyText.join(""));
    bodyText = [];
    if (!text) return;
    emit(text, null, null, pendingBreak);
    pendingBreak = false;
  };

  const finishCell = (): void => {
    const row = table?.current;
    if (!row || !row.current) return;
    row.cells.push(row.current);
    row.current = null;
  };

  const finishRow = (): void => {
    if (!table || !table.current) return;
    finishCell();
    const cells = table.current.cells.map((c) => ({ text: squash(c.parts.join("")), colspan: c.colspan }));
    table.current = null;
    if (!cells.some((c) => c.text)) return; // spacer row
    table.rows.push({ cells, breakBefore: pendingBreak });
    pendingBreak = false;
  };

  const finishTable = (): void => {
    if (!table) return;
    finishRow();
    const done = table;
    table = null;
    if (done.rows.length === 0) return; // layout spacer table

    const id = tables.length + 1;
    const anyNumeric = done.rows.some((r) => r.cells.some((c) => isNumericCell(c.text)));
    let headerCount = 0;
    if (anyNumeric) {
      while (headerCount < done.rows.length && !done.rows[headerCount].cells.some((c) => isNumericCell(c.text))) {
        headerCount++;
      }
    }

    // Grid with colspan text spread across every covered column (R3).
    const grids = done.rows.map((r) => {
      const out: string[] = [];
      for (const c of r.cells) for (let k = 0; k < c.colspan; k++) out.push(c.text);
      return out;
    });
    const width = Math.max(...grids.map((g) => g.length));
    for (const g of grids) while (g.length < width) g.push("");

    const headerGrids = grids.slice(0, headerCount);
    const bodyGrids = grids.slice(headerCount);
    const columnHeaders: string[] = [];
    for (let c = 0; c < width; c++) {
      columnHeaders.push(headerGrids.map((g) => g[c]).filter((t) => t).join(" / "));
    }

    // Scale note: header rows first, then the two blocks just above the table,
    // matched cell by cell so the note never runs on into the next column.
    const headerCells = done.rows.slice(0, headerCount).flatMap((r) => r.cells.map((c) => c.text));
    const scaleNote = firstScaleNote(headerCells) ?? firstScaleNote(blocks.slice(-2).flatMap(blockParts));

    let firstPage: number | null = null;
    done.rows.forEach((r, i) => {
      const text = r.cells.map((c) => c.text).filter((t) => t).join(" | ");
      const block = emit(text, id, i < headerCount ? null : i - headerCount, r.breakBefore);
      if (firstPage === null) firstPage = block.page;
    });

    tables.push({
      id,
      page: firstPage ?? page,
      rows: bodyGrids,
      columnHeaders,
      rowLabels: bodyGrids.map((g) => g.find((t) => t) ?? ""),
      scaleNote,
    });
  };

  const sinkText = (raw: string): void => {
    const text = decodeEntities(raw);
    if (table) {
      const cell = table.current?.current;
      if (cell) cell.parts.push(text);
      // text inside <table> but outside a cell is layout noise — drop it
      return;
    }
    bodyText.push(text);
  };

  for (const tok of tokenize(cleaned)) {
    if (tok.kind === "text") {
      sinkText(tok.text);
      continue;
    }
    const { name, closing, attrs } = tok;

    if (!closing) {
      const brk = breakStyle(attrs);
      if (brk.before || (brk.after && VOID_TAGS.has(name))) {
        // Close the text before the break first. Inside a table a break takes
        // effect from the next row on (a break-before on a <tr> is that row).
        if (!table) flushBody();
        else if (name === "tr" && tableDepth === 1 && brk.before) finishRow();
        markBreak();
      }
      if (!VOID_TAGS.has(name)) openStack.push({ name, breakAfter: brk.after });
    }

    if (name === "table") {
      if (!closing) {
        if (table) {
          tableDepth++;
          table.current?.current?.parts.push(" ");
        } else {
          flushBody();
          table = { rows: [], current: null };
          tableDepth = 1;
        }
      } else if (table) {
        tableDepth--;
        if (tableDepth <= 0) finishTable();
        else table.current?.current?.parts.push(" ");
      }
    } else if (table) {
      if (tableDepth === 1) {
        if (name === "tr") {
          if (!closing) {
            finishRow();
            table.current = { cells: [], current: null };
          } else {
            finishRow();
          }
        } else if (name === "td" || name === "th") {
          if (!closing) {
            if (!table.current) table.current = { cells: [], current: null };
            finishCell();
            table.current.current = { parts: [], colspan: colspanOf(attrs) };
          } else {
            finishCell();
          }
        } else if (BOUNDARY_TAGS.has(name) || name === "br") {
          table.current?.current?.parts.push(" ");
        }
      } else if (BOUNDARY_TAGS.has(name) || name === "br" || name === "tr" || name === "td" || name === "th") {
        table.current?.current?.parts.push(" ");
      }
    } else if (BOUNDARY_TAGS.has(name)) {
      flushBody();
    } else if (name === "br") {
      bodyText.push(" ");
    }

    if (closing) {
      for (let k = openStack.length - 1; k >= 0; k--) {
        if (openStack[k].name !== name) continue;
        const entry = openStack[k];
        openStack.length = k;
        if (entry.breakAfter) {
          if (!table) flushBody();
          markBreak();
        }
        break;
      }
    }
  }
  if (table) finishTable();
  flushBody();

  const documentScaleNote = firstScaleNote(blocks.flatMap(blockParts));

  const pageCount = blocks.length > 0 ? blocks[blocks.length - 1].page : 1;
  return {
    extractorVersion: EXTRACTOR_VERSION,
    pageCount,
    pageBreaksReliable: breaksFound > 0,
    blocks,
    tables,
    documentScaleNote,
  };
}

/**
 * The text sent to the model: one line per block. A body-row block reads
 * `[table N row R] cell | cell` (R is 1-based: `rowIndex + 1`); a header-row
 * block reads `[table N header] cell | cell`.
 */
export function blockText(doc: DocText): string {
  return doc.blocks
    .map((b) => {
      if (b.tableId === null) return b.text;
      if (b.rowIndex === null) return `[table ${b.tableId} header] ${b.text}`;
      return `[table ${b.tableId} row ${b.rowIndex + 1}] ${b.text}`;
    })
    .join("\n");
}
