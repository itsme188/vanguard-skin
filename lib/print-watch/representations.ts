// Ported, behavior-identical, from scripts/spike-bakeoff-parse.ts (the
// bake-off pilot's repA/repB builders, validated against the real corpus —
// see tests/print-watch/representations.test.ts's golden test). Pure
// functions, no db, no new dependencies. Do not diverge from this file —
// the spike now imports FROM here rather than keeping its own copy.
//
// Two representations of the same EX-99.* HTML exhibit:
//   htmlToTablesRepresentation (repA) — deterministic table normalization:
//     colspan expanded positionally (text in the first spanned column, the
//     rest blank), rowspan carried down by repeating the label, indentation
//     recovered from `padding-left:Npt` on the first cell, each table
//     captioned with its 3 preceding non-trivial body lines (EDGAR puts a
//     table's scale, e.g. "(In thousands...)", on its own line just above
//     it), empty rows/columns pruned. Non-table body text follows with
//     [TABLE n] position markers.
//   htmlToRawText (repB) — naive tag-strip to flowing text: entities
//     decoded, <pre> blocks preserved verbatim, no table structure survives.
//
// KNOWN LIMITS (findings, not bugs — see the bake-off report):
//   - colspan text lands in the first spanned column only.
//   - rowspan repeats the label in every spanned row.
//   - nested tables are flattened into the containing cell.
//   - only padding-left indentation is recovered (bold/italic/rules lost).
//   - <pre>-formatted ASCII tables are not <table> markup and fall through
//     to body text in repA.
//   - filer agents differ on negative-number markup: some split "(5,313" and
//     ")" into adjacent cells, others keep "(7,238)" whole. Both survive
//     normalization as printed.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", minus: "−", hyphen: "-",
  lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„",
  hellip: "…", bull: "•", middot: "·", dagger: "†",
  reg: "®", trade: "™", copy: "©", sect: "§", para: "¶",
  deg: "°", times: "×", divide: "÷", plusmn: "±",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
  frac12: "½", frac14: "¼", frac34: "¾",
  sup1: "¹", sup2: "²", sup3: "³",
  larr: "←", rarr: "→", harr: "↔",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó",
  uacute: "ú", ntilde: "ñ", ccedil: "ç",
  auml: "ä", ouml: "ö", uuml: "ü", szlig: "ß",
  ensp: " ", emsp: " ", thinsp: " ", shy: "",
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // NBSP and friends become plain spaces so number parsing stays sane.
      if (code === 160 || code === 8194 || code === 8195 || code === 8201 || code === 8239) return " ";
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const mapped = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return mapped !== undefined ? mapped : whole;
  });
}

/**
 * Collapse runs of whitespace to single spaces and trim. JS `\s` already covers
 * NBSP and the other Unicode spaces, so no explicit character class is needed.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Remove <script>/<style> bodies and HTML comments before any tokenizing. */
function preClean(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
}

interface TagToken {
  kind: "tag";
  name: string;
  closing: boolean;
  attrs: Record<string, string>;
}
interface TextToken {
  kind: "text";
  text: string;
}
type Token = TagToken | TextToken;

/**
 * Minimal HTML scanner. Quote-aware inside tags so a `>` in an attribute value
 * (rare but legal) doesn't split the tag early.
 */
function* tokenize(html: string): Generator<Token> {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      if (i < n) yield { kind: "text", text: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: "text", text: html.slice(i, lt) };
    if (html.startsWith("<!", lt)) {
      // doctype / stray declaration — comments already stripped in preClean
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    const raw = html.slice(lt + 1, j);
    i = j + 1;
    if (raw.length === 0) continue;
    const closing = raw[0] === "/";
    const inner = closing ? raw.slice(1) : raw;
    const nameMatch = inner.match(/^([a-zA-Z][a-zA-Z0-9:_-]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const attrs: Record<string, string> = {};
    if (!closing) {
      const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      let m: RegExpExecArray | null;
      const attrText = inner.slice(nameMatch[1].length);
      while ((m = attrRe.exec(attrText)) !== null) {
        attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
      }
    }
    yield { kind: "tag", name, closing, attrs };
  }
}

const BLOCK_TAGS = new Set([
  "p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "section", "article", "header", "footer", "blockquote", "hr",
  "ul", "ol", "dl", "dt", "dd", "caption", "thead", "tbody", "tfoot", "pre",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// ---------------------------------------------------------------------------
// repA — deterministic table normalization
// ---------------------------------------------------------------------------

interface CellBuild {
  parts: string[];
  colspan: number;
  rowspan: number;
  indent: number;
}

interface TableBuild {
  rows: CellBuild[][];
  currentRow: CellBuild[] | null;
  currentCell: CellBuild | null;
  captionParts: string[];
  inCaption: boolean;
  heading: string;
  colspans: number;
  rowspans: number;
  nested: number;
}

export interface NormalizedTable {
  index: number;
  heading: string;
  caption: string;
  rows: string[][];
  colspans: number;
  rowspans: number;
  nested: number;
  droppedColumns: number;
  droppedRows: number;
}

export interface RepAResult {
  text: string;
  tables: NormalizedTable[];
  skippedLayoutTables: number;
  bodyChars: number;
}

function intAttr(attrs: Record<string, string>, key: string): number {
  const raw = attrs[key];
  if (!raw) return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 200 ? n : 1;
}

/** EDGAR filings encode row-label hierarchy as `padding-left:Npt`. Recover it. */
function indentFromStyle(style: string | undefined): number {
  if (!style) return 0;
  const m = style.match(/padding-left:\s*([\d.]+)\s*(pt|px)/i);
  if (!m) return 0;
  const pts = parseFloat(m[1]);
  if (!Number.isFinite(pts) || pts <= 0) return 0;
  return Math.min(6, Math.round(pts / 9));
}

function newTable(heading: string): TableBuild {
  return {
    rows: [],
    currentRow: null,
    currentCell: null,
    captionParts: [],
    inCaption: false,
    heading,
    colspans: 0,
    rowspans: 0,
    nested: 0,
  };
}

function finishCell(tb: TableBuild): void {
  if (!tb.currentCell) return;
  if (!tb.currentRow) tb.currentRow = [];
  tb.currentRow.push(tb.currentCell);
  tb.currentCell = null;
}

function finishRow(tb: TableBuild): void {
  finishCell(tb);
  if (tb.currentRow) {
    tb.rows.push(tb.currentRow);
    tb.currentRow = null;
  }
}

/** Expand colspan/rowspan into a dense grid, then prune empty rows + columns. */
function materialize(tb: TableBuild, index: number): NormalizedTable {
  finishRow(tb);
  const carry = new Map<number, { text: string; left: number }>();
  const grid: string[][] = [];

  for (const row of tb.rows) {
    const out: string[] = [];
    let col = 0;
    const place = (text: string): void => {
      while (out.length < col) out.push("");
      out[col] = text;
    };
    for (const cell of row) {
      while (carry.has(col)) {
        place(carry.get(col)!.text);
        col++;
      }
      const indent = cell.indent > 0 ? "  ".repeat(cell.indent) : "";
      const text = indent + squash(cell.parts.join(" "));
      for (let k = 0; k < cell.colspan; k++) {
        place(k === 0 ? text : "");
        if (cell.rowspan > 1) {
          carry.set(col, { text: k === 0 ? text : "", left: cell.rowspan });
        }
        col++;
      }
    }
    while (carry.has(col)) {
      place(carry.get(col)!.text);
      col++;
    }
    for (const [k, v] of Array.from(carry.entries())) {
      v.left -= 1;
      if (v.left <= 0) carry.delete(k);
    }
    grid.push(out);
  }

  const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const keepCol: boolean[] = [];
  for (let c = 0; c < width; c++) {
    keepCol.push(grid.some((r) => (r[c] ?? "").trim().length > 0));
  }
  const droppedColumns = keepCol.filter((k) => !k).length;

  const rows: string[][] = [];
  let droppedRows = 0;
  for (const r of grid) {
    const kept: string[] = [];
    for (let c = 0; c < width; c++) {
      if (keepCol[c]) kept.push(r[c] ?? "");
    }
    if (kept.some((c) => c.trim().length > 0)) rows.push(kept);
    else droppedRows++;
  }

  return {
    index,
    heading: tb.heading,
    caption: squash(tb.captionParts.join(" ")),
    rows,
    colspans: tb.colspans,
    rowspans: tb.rowspans,
    nested: tb.nested,
    droppedColumns,
    droppedRows,
  };
}

function flattenTableText(t: NormalizedTable): string {
  return t.rows.map((r) => r.filter((c) => c.trim()).join(" ")).join(" ");
}

/** Render a table as an aligned pipe block. Never truncates a cell. */
function renderTable(t: NormalizedTable): string {
  const cols = t.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (const r of t.rows) w = Math.max(w, (r[c] ?? "").length);
    widths.push(Math.min(w, 60)); // pad up to 60; longer cells simply overflow
  }
  const spanNote =
    t.colspans > 0 || t.rowspans > 0
      ? ` | spans: colspan=${t.colspans} rowspan=${t.rowspans}`
      : "";
  const nestedNote = t.nested > 0 ? ` | nested-tables-flattened=${t.nested}` : "";
  const lines: string[] = [
    `--- TABLE ${t.index} | rows=${t.rows.length} cols=${cols}${spanNote}${nestedNote} ---`,
  ];
  if (t.heading) lines.push(`heading: ${t.heading}`);
  if (t.caption) lines.push(`caption: ${t.caption}`);
  for (const r of t.rows) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const v = r[c] ?? "";
      cells.push(v.length >= widths[c] ? v : v.padEnd(widths[c], " "));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildRepA(html: string): RepAResult {
  const cleaned = preClean(html);
  const tables: NormalizedTable[] = [];
  const stack: TableBuild[] = [];
  const bodyParts: string[] = [];
  let headingCapture: string[] | null = null;
  /**
   * The last few non-trivial text lines before a table. THREE, not one: EDGAR
   * releases put the table's SCALE on its own line ("Financial Summary" /
   * "(In thousands, except per share amounts)" / "(Unaudited)"), and losing the
   * scale line is a wrong-unit catastrophic error waiting to happen.
   */
  const recentBodyLines: string[] = [];
  let skippedLayoutTables = 0;
  let tableIndex = 0;

  const pushBody = (text: string): void => {
    bodyParts.push(text);
  };

  const rememberLine = (line: string): void => {
    if (line.length <= 2) return;
    recentBodyLines.push(line.length > 140 ? line.slice(0, 140) + "…" : line);
    if (recentBodyLines.length > 3) recentBodyLines.shift();
  };

  const currentHeadingCandidate = (): string => {
    const candidate = recentBodyLines.join(" / ");
    return candidate.length > 300 ? candidate.slice(0, 300) + "…" : candidate;
  };

  const sinkText = (raw: string): void => {
    const decoded = decodeEntities(raw);
    if (!decoded.trim()) {
      // whitespace still separates words in the body stream
      if (stack.length === 0 && headingCapture === null) pushBody(" ");
      return;
    }
    const top = stack[stack.length - 1];
    if (top) {
      if (top.inCaption) top.captionParts.push(decoded);
      else if (top.currentCell) top.currentCell.parts.push(decoded);
      // text directly inside <table> but outside a cell is layout noise — drop
      return;
    }
    if (headingCapture) {
      headingCapture.push(decoded);
      return;
    }
    pushBody(decoded);
    rememberLine(squash(decoded));
  };

  for (const tok of tokenize(cleaned)) {
    if (tok.kind === "text") {
      sinkText(tok.text);
      continue;
    }
    const { name, closing, attrs } = tok;

    if (name === "table") {
      if (!closing) {
        stack.push(newTable(currentHeadingCandidate()));
      } else {
        const tb = stack.pop();
        if (!tb) continue;
        tableIndex++;
        const table = materialize(tb, tableIndex);
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.nested++;
          const flat = flattenTableText(table);
          if (parent.currentCell) parent.currentCell.parts.push(flat);
          else if (parent.inCaption) parent.captionParts.push(flat);
          tableIndex--; // nested tables don't get their own top-level index
          continue;
        }
        const nonEmpty = table.rows.reduce(
          (acc, r) => acc + r.filter((c) => c.trim().length > 0).length,
          0,
        );
        if (table.rows.length === 0 || nonEmpty < 2) {
          skippedLayoutTables++;
          tableIndex--;
          continue;
        }
        tables.push(table);
        pushBody(`\n[TABLE ${table.index}]\n`);
        recentBodyLines.length = 0;
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (top) {
      if (name === "tr" && !closing) finishRow(top);
      else if (name === "tr" && closing) finishRow(top);
      else if ((name === "td" || name === "th") && !closing) {
        finishCell(top);
        const colspan = intAttr(attrs, "colspan");
        const rowspan = intAttr(attrs, "rowspan");
        if (colspan > 1) top.colspans++;
        if (rowspan > 1) top.rowspans++;
        top.currentCell = {
          parts: [],
          colspan,
          rowspan,
          indent: indentFromStyle(attrs["style"]),
        };
        if (!top.currentRow) top.currentRow = [];
      } else if ((name === "td" || name === "th") && closing) {
        finishCell(top);
      } else if (name === "caption") {
        top.inCaption = !closing;
      } else if (name === "br" && !closing) {
        if (top.currentCell) top.currentCell.parts.push(" ");
      }
      continue;
    }

    if (HEADING_TAGS.has(name)) {
      if (!closing) headingCapture = [];
      else if (headingCapture) {
        const h = squash(decodeEntities(headingCapture.join(" ")));
        if (h) {
          rememberLine(h);
          pushBody(`\n${h}\n`);
        }
        headingCapture = null;
      }
      continue;
    }

    if (BLOCK_TAGS.has(name)) pushBody("\n");
  }

  const body = bodyParts
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const header = [
    "# REPRESENTATION repA-tables — deterministic HTML table normalization",
    `# tables kept: ${tables.length}${skippedLayoutTables > 0 ? ` (${skippedLayoutTables} layout/spacer tables skipped)` : ""}`,
    "# Cells are pipe-delimited and padded for alignment. Empty cells are real",
    "# (colspan padding or a pruned spacer). Row labels keep their indentation.",
  ].join("\n");

  const text = [
    header,
    "",
    "=== TABLES ===",
    tables.map(renderTable).join("\n\n"),
    "",
    "=== NON-TABLE BODY TEXT (with [TABLE n] position markers) ===",
    body,
  ].join("\n");

  return { text, tables, skippedLayoutTables, bodyChars: body.length };
}

// ---------------------------------------------------------------------------
// repB — naive tag-strip
// ---------------------------------------------------------------------------

function buildRepB(html: string): string {
  const cleaned = preClean(html);

  // <pre> is preserved verbatim (entities decoded, whitespace untouched).
  const preBlocks: string[] = [];
  const withPlaceholders = cleaned.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi,
    (_whole, inner: string) => {
      preBlocks.push(decodeEntities(inner));
      return `[[PRE:${preBlocks.length - 1}]]`;
    },
  );

  const out: string[] = [];
  for (const tok of tokenize(withPlaceholders)) {
    if (tok.kind === "text") {
      out.push(decodeEntities(tok.text));
      continue;
    }
    const { name, closing } = tok;
    if (name === "td" || name === "th") out.push(closing ? "  " : " ");
    else if (BLOCK_TAGS.has(name)) out.push("\n");
  }

  let text = out
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  text = text.replace(/\[\[PRE:(\d+)\]\]/g, (_whole, i: string) => {
    const block = preBlocks[Number(i)];
    return block === undefined ? "" : `\n${block}\n`;
  });

  return [
    "# REPRESENTATION repB-rawtext — naive tag-strip of the same document",
    "# (entities decoded, <pre> blocks preserved verbatim, no table structure)",
    "",
    text,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * EX-99.* HTML -> deterministic table normalization, rendered as text.
 * See file header for the full behavior contract; this is a thin export over
 * the ported buildRepA (kept internal since only the model-ready text matters
 * to callers — the structured NormalizedTable[] was a spike diagnostic).
 */
export function htmlToTablesRepresentation(html: string): string {
  return buildRepA(html).text;
}

/** EX-99.* HTML -> naive tag-strip to flowing text. See file header. */
export function htmlToRawText(html: string): string {
  return buildRepB(html);
}
