/**
 * SPIKE for the print-watch design (2026-08-20).
 * Measurement tool, NOT product code. Throwaway quality is acceptable — but it
 * must be reproducible, because the numbers it produces decide whether the
 * GREEN gate in §2 of the design spec can ever be claimed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * Phase 3 of the extraction bake-off (docs/superpowers/specs/
 * 2026-08-20-live-print-watch-design.md §4.4 "independent parses").
 *
 * For every event in the frozen corpus built by scripts/spike-bakeoff-corpus.ts,
 * runs up to THREE constrained parses of the SAME print and stores the raw
 * candidates for later scoring:
 *
 *   repA-tables   EX-99.1 HTML -> deterministic table normalization -> model
 *                 (tables rendered as aligned text blocks with a table index
 *                  and the nearest preceding heading; non-table body text
 *                  follows, with [TABLE n] position markers)
 *   repB-rawtext  EX-99.1 HTML -> naive tag-strip to flowing text -> model
 *                 (entities decoded, <pre> preserved verbatim)
 *   repC-djtext   the DJ verbatim wire release (dj-release*.txt) -> model
 *                 (only the events that have one)
 *
 * The two HTML-derived representations are SAVED to disk (parse-input-repA.txt /
 * parse-input-repB.txt) before the model call, so a scoring pass months from now
 * sees the exact bytes the model saw. repC's input is already on disk verbatim,
 * so only its sha256 + filename are recorded.
 *
 * ONE model call per (event, representation). Sonnet tier — this simulates the
 * production fast-parse, not a research-grade re-read. Failures are DATA: a
 * failed call is recorded in the run summary and the run continues.
 *
 * ---------------------------------------------------------------------------
 * THE FIREWALL
 * ---------------------------------------------------------------------------
 * This script must NEVER read a gold-*.json file. The parsers under test may
 * only see contracts.json (the typed line contracts) and the documents. Three
 * guards enforce that:
 *   1. loadContracts() refuses any path whose basename contains "gold".
 *   2. Per-contract fields are WHITELISTED (CONTRACT_FIELDS), not passed
 *      through — an unexpected field on a contract row could carry the answer.
 *   3. The contracts envelope's `labeler_notes` is dropped. On the real corpus
 *      it contains the cross-checked answers in prose ("GAAP -0.10, non-GAAP
 *      basic 0.18, non-GAAP diluted 0.16"); only the period/issuer labels in
 *      CONTEXT_FIELDS reach the prompt.
 * The contracts file's sha256 is recorded in every parse-rep*.json, so a parse
 * produced against a pre-freeze contract set is detectable after the fact.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT (gitignored — tests/fixtures/real/)
 * ---------------------------------------------------------------------------
 *   tests/fixtures/real/bakeoff/{SYMBOL}-{DATE}/
 *     parse-input-repA.txt   normalized-table artifact actually sent
 *     parse-input-repB.txt   raw-text artifact actually sent
 *     parse-repA.json        { representation, model_id, started_at,
 *                              input_sha256, candidates[] , ...diagnostics }
 *     parse-repB.json
 *     parse-repC.json
 *   tests/fixtures/real/bakeoff/parse-run-summary.json
 *     per (event x representation): ok/error/skipped, candidate count, tokens,
 *     latency. Merged with any prior summary so a partial re-run never wipes
 *     the rows it did not touch.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/spike-bakeoff-parse.ts [flags]
 *
 *   --events XMTR-2026-08-04,HD-2026-08-18   only these event dirs (default: all)
 *   --repr A,B,C                             only these representations (default: all)
 *   --contracts-override /path/contracts.json
 *                                            use this contracts file for EVERY
 *                                            selected event instead of the
 *                                            per-event contracts.json (used to
 *                                            validate the harness before the
 *                                            real contracts are frozen)
 *   --dry-run                                build + save the representation
 *                                            artifacts, skip every model call
 *   --max-input-chars N                      cap on document chars sent (default 400000)
 *   --max-tokens N                           output cap (default 16384)
 *   --thinking off|adaptive                  default off (fast-parse simulation)
 *   --concurrency N                          parallel calls within one event (default 3)
 *   --corpus /path/to/bakeoff                corpus root override
 *
 * PREREQUISITES
 *   ANTHROPIC_API_KEY in .env.local (or the environment).
 *   Each selected event dir needs a contracts.json (or use --contracts-override).
 *
 * NOTES ON THE MODEL CALL
 *   - The model id is NEVER hardcoded. It resolves through the repo registry:
 *     resolveTier("workhorse", <live catalog cached in the settings table>),
 *     falling back to SONNET_MODEL (lib/claude-models.ts) when the DB is absent.
 *   - Output comes back through a FORCED tool call (tool_choice: {type:"tool"}).
 *     Every object node in the tool's JSON schema carries
 *     additionalProperties:false (repo gotcha: Anthropic 400s without it).
 *     `strict: true` is deliberately NOT set — it would force every optional
 *     field into `required` with nullable unions, which buys nothing here.
 *   - No `temperature`: sampling parameters are rejected (400) on the current
 *     Sonnet tier.
 *   - One malformed response gets ONE retry, with the C0-control-char handling
 *     precedent from lib/ai/extract-json.ts + lib/securities/verify-sector-tags.ts.
 *
 * KNOWN LIMITS OF THE TABLE EXTRACTOR (findings, not bugs — see the report)
 *   - colspan is expanded positionally: the text lands in the first spanned
 *     column and the rest of the span becomes blanks. A header spanning a
 *     ("$", value, "") triple therefore sits above the "$" column.
 *   - rowspan is carried down by repeating the label in each spanned row.
 *   - Nested tables are flattened into the containing cell.
 *   - Visual hierarchy is CSS-only in EDGAR filings; we recover indentation
 *     from `padding-left:Npt` on the first cell and nothing else (bold /
 *     italic / rule lines are lost).
 *   - <pre>-formatted ASCII tables are not <table> markup and fall through to
 *     the body-text section.
 *   - Some EX-99.1 exhibits carry NO tables at all (MELI 8/05 is a narrative
 *     shareholder letter — every figure lives in a sentence). repA then
 *     degenerates to repB and the "two representations" premise collapses to
 *     one for that event. Measured on the corpus 2026-08-20: 15/17 exhibits
 *     table-bearing, MELI ex99-1 and AMZN ex99-2 not.
 *   - Filer agents differ on negative-number markup: DFIN/Workiva split
 *     "(5,313" and ")" into ADJACENT CELLS (XMTR, AAPL, AKAM), while others
 *     keep "(7,238)" whole (DIS). Both survive normalization, but a scorer
 *     comparing raw_text across representations must expect both shapes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { SONNET_MODEL } from "@/lib/claude-models";
import { resolveTier } from "@/lib/ai/model-tiers";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

function loadEnvLocal(): void {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type ReprId = "A" | "B" | "C";

interface Cli {
  events: string[] | null;
  repr: ReprId[];
  contractsOverride: string | null;
  dryRun: boolean;
  maxInputChars: number;
  maxTokens: number;
  thinking: "off" | "adaptive";
  concurrency: number;
  corpusRoot: string;
}

function parseCli(argv: string[]): Cli {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const eventsRaw = get("--events");
  const reprRaw = get("--repr");
  const maxInput = get("--max-input-chars");
  const maxTok = get("--max-tokens");
  const conc = get("--concurrency");
  const thinkingRaw = (get("--thinking") ?? "off").toLowerCase();

  const repr = (reprRaw ? reprRaw.split(",") : ["A", "B", "C"])
    .map((r) => r.trim().toUpperCase().replace(/^REP/, ""))
    .filter((r): r is ReprId => r === "A" || r === "B" || r === "C");

  return {
    events: eventsRaw ? eventsRaw.split(",").map((e) => e.trim()).filter(Boolean) : null,
    repr: repr.length > 0 ? repr : ["A", "B", "C"],
    contractsOverride: get("--contracts-override"),
    dryRun: argv.includes("--dry-run"),
    maxInputChars: maxInput ? Math.max(1000, parseInt(maxInput, 10)) : 400_000,
    maxTokens: maxTok ? Math.max(1024, parseInt(maxTok, 10)) : 16_384,
    thinking: thinkingRaw === "adaptive" ? "adaptive" : "off",
    concurrency: conc ? Math.max(1, parseInt(conc, 10)) : 3,
    corpusRoot: get("--corpus") ?? join(process.cwd(), "tests", "fixtures", "real", "bakeoff"),
  };
}

const CLI = parseCli(process.argv.slice(2));

// ---------------------------------------------------------------------------
// HTML -> text primitives (dependency-free; NO new npm packages — repo rule)
// ---------------------------------------------------------------------------

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

/**
 * Replace C0 control characters with spaces. Models intermittently emit raw
 * unescaped control characters inside JSON string literals ("Bad control
 * character in string literal") - same retry precedent as lib/ai/extract-json.ts
 * and lib/securities/verify-sector-tags.ts. Built character-by-character rather
 * than with an escaped regex class so this source file stays plain ASCII.
 */
function stripC0(text: string): string {
  let out = "";
  for (const ch of text) out += ch.charCodeAt(0) < 32 ? " " : ch;
  return out;
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

export function buildRepA(html: string): RepAResult {
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

export function buildRepB(html: string): string {
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
// contracts
// ---------------------------------------------------------------------------

export interface Contract {
  metric_id: string;
  [key: string]: unknown;
}

export interface ContractsFile {
  contracts: Contract[];
  /** sha256 of the contracts file as loaded — makes a stale parse detectable. */
  sha256: string;
  /** Period/issuer context safe to show the parser (never labeler commentary). */
  context: Record<string, string>;
}

/**
 * WHITELIST, not passthrough. Only these per-line fields reach the model. An
 * unexpected field on a contract row could carry the labeler's answer, and a
 * contract file is authored by the same agent that authors the gold — the
 * firewall has to hold at the field level too.
 */
const CONTRACT_FIELDS = [
  "label", "definition", "basis", "period", "currency",
  "unit", "kind", "segment", "aliases",
];

/**
 * Envelope-level fields that are safe context. `labeler_notes` is EXCLUDED on
 * purpose: on the real corpus it contains the cross-checked answers in prose
 * ("GAAP -0.10, non-GAAP basic 0.18, non-GAAP diluted 0.16"). Showing it to the
 * parser would be handing over the gold.
 */
const CONTEXT_FIELDS = [
  "issuer", "fiscal_period_label", "prior_year_period_label",
  "guidance_horizon_label",
];

function normalizeContract(raw: unknown): Contract | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = obj.metric_id ?? obj.metricId ?? obj.id;
  if (typeof id !== "string" || !id.trim()) return null;
  const out: Contract = { metric_id: id.trim() };
  for (const key of CONTRACT_FIELDS) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  }
  return out;
}

/**
 * FIREWALL: this loader refuses any path that looks like a gold file, and
 * whitelists the fields that reach the prompt. The parsers under test must
 * never see labels.
 */
export function loadContracts(path: string): ContractsFile {
  if (/gold/i.test(basename(path))) {
    throw new Error(
      `Refusing to load "${path}" — the bake-off firewall forbids gold files as parser input.`,
    );
  }
  const rawFile = readFileSync(path, "utf-8");
  const parsed: unknown = JSON.parse(rawFile);
  let list: unknown[] = [];
  const context: Record<string, string> = {};
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["contracts", "lines", "metrics", "bogeys"]) {
      if (Array.isArray(obj[key])) {
        list = obj[key] as unknown[];
        break;
      }
    }
    for (const key of CONTEXT_FIELDS) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) context[key] = v.trim();
    }
  }
  const contracts = list
    .map(normalizeContract)
    .filter((c): c is Contract => c !== null);
  if (contracts.length === 0) {
    throw new Error(`No usable contracts (metric_id) found in ${path}`);
  }
  return { contracts, context, sha256: sha256(rawFile) };
}

// ---------------------------------------------------------------------------
// prompt + tool
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a deterministic figure-extraction engine for an earnings "print watch". You read ONE earnings document and report, for a fixed list of contract lines, exactly what that document states — nothing more.

NON-NEGOTIABLE RULES

1. NEVER guess and NEVER compute. Report only figures the document prints. Do NOT derive EPS from net income and a share count. Do NOT compute a margin from two other numbers. Do NOT compute a growth rate from two columns. Do NOT convert a range into a midpoint or a midpoint into a range. If the figure is not printed, it is not disclosed.
2. A metric the document does not state -> return that metric_id with not_disclosed = true and no value. Abstention is a CORRECT answer. A wrong number is far worse than a missing one.
3. BASIS must match the contract exactly. GAAP and non-GAAP / adjusted figures are DIFFERENT metrics. If the contract asks for non-GAAP and the document prints only GAAP (or the reverse), that is not_disclosed — never substitute.
4. PERIOD must match the contract exactly. Documents carry prior-year comparatives, six-month / year-to-date columns, and forward guidance. Pick the column or row that matches the contract's period. If only a different period is printed, that is not_disclosed.
5. SEGMENT must match. A consolidated figure is not a segment figure, and a segment figure is not consolidated.
6. UNITS — "value" must be normalized to the contract's unit and currency:
   - absolute currency amount -> whole units. A table headed "in millions" printing 1,234.5 means 1234500000. A release sentence saying "$1.23 billion" means 1230000000.
   - per-share amount -> the per-share number as printed (1.23).
   - percent -> the percent as printed, NOT the decimal (12.3, never 0.123).
   - count (shares, customers, employees, stores) -> the whole count, expanding any "in millions/thousands" table scale.
   - basis points -> as printed.
7. SIGN: parentheses or a leading minus mean negative. A loss is negative.
8. RANGES (guidance): value = the LOW end, value_high = the HIGH end, both normalized. "at least X" / "approximately X" / "greater than X" -> value = X and no value_high. Never invent the missing end of a range.
9. raw_text = the figure exactly as printed, including $ signs, commas, %, parentheses, and any adjacent scale word.
10. snippet = at most 200 characters copied VERBATIM from the document text you were given, containing the figure. Copy it character for character. Never paraphrase and never reconstruct.
11. location_hint = where you found it. For the table representation use the table index plus the row label and column header, e.g. TABLE 3 | row "Total revenue" | col "Three Months Ended June 30, 2026". Otherwise use the nearest heading or section name.
12. Return EXACTLY ONE entry per contract metric_id — no extras, no duplicates, no invented metric ids. Use the metric_id string verbatim.

If two places in the document print the same metric and they disagree, report the one from the primary results table for the contract's period and say so in location_hint.`;

const TOOL_NAME = "emit_candidates";

// Every object node carries additionalProperties:false — Anthropic 400s without it.
const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    "Report one extraction candidate per contract metric_id, in the same order as the contract list.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        description: "Exactly one entry per contract metric_id.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            metric_id: {
              type: "string",
              description: "The contract metric_id, verbatim.",
            },
            not_disclosed: {
              type: "boolean",
              description:
                "true when this document does not state the metric on the contract's basis/period/segment.",
            },
            value: {
              type: "number",
              description:
                "Normalized to the contract unit (dollars not millions; percents as printed). Omit when not_disclosed.",
            },
            value_high: {
              type: "number",
              description: "High end of a printed range. Omit unless the document prints a range.",
            },
            raw_text: {
              type: "string",
              description: "The figure exactly as printed in the document.",
            },
            snippet: {
              type: "string",
              description:
                "Up to 200 characters copied verbatim from the document, containing the figure.",
            },
            location_hint: {
              type: "string",
              description:
                "Table index + row label + column header, or the nearest heading.",
            },
          },
          required: ["metric_id", "not_disclosed"],
        },
      },
    },
    required: ["candidates"],
  },
};

const REPR_LABEL: Record<ReprId, string> = {
  A: "repA-tables",
  B: "repB-rawtext",
  C: "repC-djtext",
};

const REPR_DESCRIPTION: Record<ReprId, string> = {
  A: "deterministic table normalization of the SEC EX-99.1 HTML exhibit (tables first as aligned pipe blocks with a TABLE index, then the non-table body text)",
  B: "naive tag-strip of the same SEC EX-99.1 HTML exhibit into flowing text (no table structure survives; numbers appear in reading order)",
  C: "the Dow Jones verbatim wire text of the press release, exactly as it crossed the wire",
};

function buildUserMessage(
  symbol: string,
  eventDate: string,
  repr: ReprId,
  contractsFile: ContractsFile,
  documentText: string,
): string {
  const contextLines = Object.entries(contractsFile.context).map(
    ([k, v]) => `${k}: ${v}`,
  );
  return [
    `SYMBOL: ${symbol}`,
    `EVENT DATE: ${eventDate}`,
    `REPRESENTATION: ${REPR_LABEL[repr]} — ${REPR_DESCRIPTION[repr]}`,
    ...(contextLines.length > 0 ? ["", "=== PERIOD CONTEXT ===", ...contextLines] : []),
    "",
    "=== CONTRACT LINES (extract exactly these, one candidate each) ===",
    JSON.stringify(contractsFile.contracts, null, 2),
    "",
    "=== DOCUMENT ===",
    documentText,
    "=== END OF DOCUMENT ===",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// model resolution — never a hardcoded id
// ---------------------------------------------------------------------------

function readCachedModelCatalog(): string[] {
  // Read-only peek at the settings-cached /v1/models list (lib/ai/model-catalog.ts
  // owns the write side). Absent DB -> [] -> static tier fallback.
  try {
    const dbPath = join(process.cwd(), "data", "vanguard.db");
    if (!existsSync(dbPath)) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DatabaseCtor = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'model_catalog'")
        .get() as { value?: string } | undefined;
      if (!row?.value) return [];
      const parsed: unknown = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function resolveWorkhorseModelId(): string {
  const catalog = readCachedModelCatalog();
  try {
    return resolveTier("workhorse", catalog);
  } catch {
    return SONNET_MODEL;
  }
}

/**
 * Spike-only cost estimate. Prices are per million tokens and exist ONLY to put
 * a dollar figure on the bake-off run; nothing in the app reads them.
 * Sonnet 5 carries a $2/$10 introductory rate through 2026-08-31, so this is an
 * upper bound while that promo runs.
 */
const SPIKE_PRICE_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
  opus: { in: 5, out: 25 },
  fable: { in: 10, out: 50 },
};

function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const family = /^claude-([a-z]+)/.exec(modelId)?.[1] ?? "sonnet";
  const price = SPIKE_PRICE_USD_PER_MTOK[family] ?? SPIKE_PRICE_USD_PER_MTOK.sonnet;
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

// ---------------------------------------------------------------------------
// candidate parsing (defensive)
// ---------------------------------------------------------------------------

export interface Candidate {
  metric_id: string;
  not_disclosed: boolean;
  value: number | null;
  value_high: number | null;
  raw_text: string | null;
  snippet: string | null;
  location_hint: string | null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
    const n = Number(cleaned);
    if (Number.isFinite(n) && cleaned.trim() !== "") return n;
  }
  return null;
}

function asText(v: unknown, cap: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

function normalizeCandidates(input: unknown): Candidate[] {
  if (!input || typeof input !== "object") return [];
  const rawList = (input as Record<string, unknown>).candidates;
  if (!Array.isArray(rawList)) return [];
  const out: Candidate[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const metricId = asText(obj.metric_id ?? obj.metricId, 200);
    if (!metricId) continue;
    const value = asNumber(obj.value);
    const notDisclosed =
      obj.not_disclosed === true || obj.not_disclosed === "true" ||
      (obj.not_disclosed === undefined && value === null);
    out.push({
      metric_id: metricId,
      not_disclosed: notDisclosed,
      value: notDisclosed ? null : value,
      value_high: notDisclosed ? null : asNumber(obj.value_high),
      raw_text: asText(obj.raw_text, 400),
      snippet: asText(obj.snippet, 600),
      location_hint: asText(obj.location_hint, 400),
    });
  }
  return out;
}

/** Fallback path when the model answered in prose instead of the forced tool. */
function candidatesFromText(text: string): Candidate[] {
  const stripped = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const attempt = (s: string): Candidate[] => {
    const parsed: unknown = JSON.parse(s);
    if (Array.isArray(parsed)) return normalizeCandidates({ candidates: parsed });
    return normalizeCandidates(parsed);
  };
  const objStart = stripped.indexOf("{");
  const objEnd = stripped.lastIndexOf("}");
  const arrStart = stripped.indexOf("[");
  const arrEnd = stripped.lastIndexOf("]");
  const slices: string[] = [];
  if (objStart !== -1 && objEnd > objStart) slices.push(stripped.slice(objStart, objEnd + 1));
  if (arrStart !== -1 && arrEnd > arrStart) slices.push(stripped.slice(arrStart, arrEnd + 1));
  for (const slice of slices) {
    try {
      return attempt(slice);
    } catch {
      // Frontier models intermittently emit raw C0 control characters inside
      // string literals ("Bad control character in string literal"). Same retry
      // precedent as lib/securities/verify-sector-tags.ts.
      try {
        return attempt(stripC0(slice));
      } catch {
        // try the next slice
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// one (event, representation) parse
// ---------------------------------------------------------------------------

interface ParseInput {
  symbol: string;
  eventDate: string;
  repr: ReprId;
  contractsFile: ContractsFile;
  documentText: string;
  sourceFile: string;
  sourceSha256: string;
  truncated: boolean;
  originalChars: number;
  diagnostics: Record<string, unknown>;
}

interface ParseOutcome {
  status: "ok" | "error" | "skipped";
  error: string | null;
  attempts: number;
  candidates: Candidate[];
  latencyMs: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  } | null;
  stopReason: string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModel(
  client: Anthropic,
  modelId: string,
  input: ParseInput,
): Promise<ParseOutcome> {
  const userMessage = buildUserMessage(
    input.symbol,
    input.eventDate,
    input.repr,
    input.contractsFile,
    input.documentText,
  );

  let lastError = "";
  let latencyMs = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    try {
      const stream = client.messages.stream({
        model: modelId,
        max_tokens: CLI.maxTokens,
        // No temperature: sampling parameters are rejected on the current
        // Sonnet tier. Thinking off by default = the production fast-parse.
        ...(CLI.thinking === "adaptive"
          ? { thinking: { type: "adaptive" as const } }
          : { thinking: { type: "disabled" as const } }),
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: userMessage }],
      });
      const response = await stream.finalMessage();
      latencyMs = Date.now() - startedAt;

      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      };

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      let candidates: Candidate[] = [];
      if (toolBlock && toolBlock.type === "tool_use") {
        candidates = normalizeCandidates(toolBlock.input);
      }
      if (candidates.length === 0) {
        const textBlock = response.content.find((b) => b.type === "text");
        if (textBlock && textBlock.type === "text") {
          candidates = candidatesFromText(textBlock.text);
        }
      }

      if (candidates.length === 0) {
        lastError = `no candidates parsed (stop_reason=${response.stop_reason ?? "null"})`;
        if (attempt === 1) {
          await sleep(1500);
          continue;
        }
        return {
          status: "error",
          error: lastError,
          attempts: attempt,
          candidates: [],
          latencyMs,
          usage,
          stopReason: response.stop_reason ?? null,
        };
      }

      return {
        status: "ok",
        error:
          response.stop_reason === "max_tokens"
            ? "truncated at max_tokens (candidates may be incomplete)"
            : null,
        attempts: attempt,
        candidates,
        latencyMs,
        usage,
        stopReason: response.stop_reason ?? null,
      };
    } catch (err) {
      latencyMs = Date.now() - startedAt;
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      lastError = `${err instanceof Error ? err.message : String(err)}${status ? ` (HTTP ${status})` : ""}`;
      if (attempt === 1) {
        await sleep(status === 429 || (status ?? 0) >= 500 ? 5000 : 1500);
        continue;
      }
    }
  }

  return {
    status: "error",
    error: lastError || "unknown failure",
    attempts: 2,
    candidates: [],
    latencyMs,
    usage: null,
    stopReason: null,
  };
}

// ---------------------------------------------------------------------------
// corpus discovery + representation building
// ---------------------------------------------------------------------------

interface MetaRelease {
  savedAs?: string;
  baseHeadline?: string;
  djTimeIso?: string;
  chars?: number;
}

interface EventMeta {
  symbol?: string;
  eventDate?: string;
  dj?: { releases?: MetaRelease[] };
}

interface EventDir {
  dirName: string;
  path: string;
  symbol: string;
  eventDate: string;
  meta: EventMeta | null;
}

function discoverEvents(root: string): EventDir[] {
  const out: EventDir[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const m = name.name.match(/^([A-Z.]+)-(\d{4}-\d{2}-\d{2})$/);
    if (!m) continue;
    const path = join(root, name.name);
    let meta: EventMeta | null = null;
    const metaPath = join(path, "meta.json");
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8")) as EventMeta;
      } catch {
        meta = null;
      }
    }
    out.push({
      dirName: name.name,
      path,
      symbol: meta?.symbol ?? m[1],
      eventDate: meta?.eventDate ?? m[2],
      meta,
    });
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/**
 * Which EX-99 exhibit is the press release. Default edgar-ex99-1.htm; several
 * events carry a second exhibit (CFO commentary / financial supplement) that is
 * NOT the release.
 */
function findEx99(dir: EventDir): string | null {
  const primary = join(dir.path, "edgar-ex99-1.htm");
  if (existsSync(primary)) return primary;
  const alt = readdirSync(dir.path).filter((f) => /^edgar-ex99-\d+\.htm$/.test(f)).sort();
  return alt.length > 0 ? join(dir.path, alt[0]) : null;
}

const RESULTS_HEADLINE_RE =
  /(financial\s+results|reports?\s+.*results|announces?\s+.*results|quarter.*results|results\s+for|earnings)/i;

/**
 * Which dj-release*.txt is the EARNINGS release. NOT always dj-release.txt:
 * HD 8/18 saved an unrelated "Express Delivery" PR as #1 and the earnings
 * release as #2; MELI saved a narrative PR as #1 and the results release as #2.
 * Score by headline, then prefer the longest matching body.
 */
function findDjRelease(dir: EventDir): { path: string; headline: string; reason: string } | null {
  const releases = dir.meta?.dj?.releases ?? [];
  const candidates: { file: string; headline: string; chars: number; scored: boolean }[] = [];
  for (const r of releases) {
    if (!r.savedAs) continue;
    const p = join(dir.path, r.savedAs);
    if (!existsSync(p)) continue;
    candidates.push({
      file: p,
      headline: r.baseHeadline ?? "",
      chars: r.chars ?? 0,
      scored: RESULTS_HEADLINE_RE.test(r.baseHeadline ?? ""),
    });
  }
  if (candidates.length === 0) {
    const fallback = join(dir.path, "dj-release.txt");
    if (existsSync(fallback)) {
      return { path: fallback, headline: "", reason: "fallback: dj-release.txt (no meta releases)" };
    }
    return null;
  }
  const matching = candidates.filter((c) => c.scored);
  const pool = matching.length > 0 ? matching : candidates;
  pool.sort((a, b) => b.chars - a.chars);
  const chosen = pool[0];
  const reason =
    matching.length > 0
      ? `headline matched results pattern (${matching.length}/${candidates.length} matched; longest body chosen)`
      : `no headline matched the results pattern — fell back to the longest of ${candidates.length}`;
  return { path: chosen.file, headline: chosen.headline, reason };
}

/**
 * Cap the document at maxInputChars. repA truncates its BODY text first so the
 * tables (the valuable part) survive; everything else truncates from the end.
 */
function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const marker = "\n\n[TRUNCATED FOR LENGTH]\n";
  const bodyMarker = "=== NON-TABLE BODY TEXT";
  const bodyAt = text.indexOf(bodyMarker);
  if (bodyAt !== -1 && bodyAt < max) {
    return { text: text.slice(0, max - marker.length) + marker, truncated: true };
  }
  return { text: text.slice(0, max - marker.length) + marker, truncated: true };
}

function buildInput(
  dir: EventDir,
  repr: ReprId,
  contractsFile: ContractsFile,
): { input: ParseInput } | { skip: string } {
  if (repr === "C") {
    const rel = findDjRelease(dir);
    if (!rel) return { skip: "no dj-release*.txt for this event" };
    const raw = readFileSync(rel.path, "utf-8");
    const capped = capText(raw, CLI.maxInputChars);
    return {
      input: {
        symbol: dir.symbol,
        eventDate: dir.eventDate,
        repr,
        contractsFile,
        documentText: capped.text,
        sourceFile: basename(rel.path),
        sourceSha256: sha256(raw),
        truncated: capped.truncated,
        originalChars: raw.length,
        diagnostics: { dj_headline: rel.headline, dj_selection: rel.reason },
      },
    };
  }

  const ex99 = findEx99(dir);
  if (!ex99) return { skip: "no edgar-ex99-*.htm for this event" };
  const html = readFileSync(ex99, "utf-8");
  const sourceHash = sha256(html);

  if (repr === "A") {
    const built = buildRepA(html);
    writeFileSync(join(dir.path, "parse-input-repA.txt"), built.text, "utf-8");
    const capped = capText(built.text, CLI.maxInputChars);
    return {
      input: {
        symbol: dir.symbol,
        eventDate: dir.eventDate,
        repr,
        contractsFile,
        documentText: capped.text,
        sourceFile: basename(ex99),
        sourceSha256: sourceHash,
        truncated: capped.truncated,
        originalChars: built.text.length,
        diagnostics: {
          tables_kept: built.tables.length,
          layout_tables_skipped: built.skippedLayoutTables,
          body_chars: built.bodyChars,
          tables_with_colspan: built.tables.filter((t) => t.colspans > 0).length,
          tables_with_rowspan: built.tables.filter((t) => t.rowspans > 0).length,
          nested_tables_flattened: built.tables.reduce((a, t) => a + t.nested, 0),
          empty_columns_pruned: built.tables.reduce((a, t) => a + t.droppedColumns, 0),
          empty_rows_pruned: built.tables.reduce((a, t) => a + t.droppedRows, 0),
        },
      },
    };
  }

  const text = buildRepB(html);
  writeFileSync(join(dir.path, "parse-input-repB.txt"), text, "utf-8");
  const capped = capText(text, CLI.maxInputChars);
  return {
    input: {
      symbol: dir.symbol,
      eventDate: dir.eventDate,
      repr,
      contractsFile,
      documentText: capped.text,
      sourceFile: basename(ex99),
      sourceSha256: sourceHash,
      truncated: capped.truncated,
      originalChars: text.length,
      diagnostics: {},
    },
  };
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

interface SummaryRow {
  event: string;
  symbol: string;
  event_date: string;
  representation: string;
  status: "ok" | "error" | "skipped" | "dry-run";
  error: string | null;
  candidate_count: number;
  not_disclosed_count: number;
  source_file: string | null;
  input_chars: number;
  input_truncated: boolean;
  input_sha256: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  est_cost_usd: number | null;
  attempts: number;
  ran_at: string;
}

function loadPriorSummaryRows(path: string): SummaryRow[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const rows = (parsed as { runs?: unknown })?.runs;
    return Array.isArray(rows) ? (rows as SummaryRow[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(CLI.corpusRoot)) {
    console.error(`Corpus root not found: ${CLI.corpusRoot}`);
    process.exit(1);
  }

  const allEvents = discoverEvents(CLI.corpusRoot);
  const selected = CLI.events
    ? allEvents.filter((e) => CLI.events!.includes(e.dirName) || CLI.events!.includes(e.symbol))
    : allEvents;

  if (selected.length === 0) {
    console.error(`No matching event dirs under ${CLI.corpusRoot}`);
    process.exit(1);
  }

  const modelId = resolveWorkhorseModelId();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!CLI.dryRun && !apiKey) {
    console.error("ANTHROPIC_API_KEY not found in environment or .env.local");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  console.log(`Corpus:       ${CLI.corpusRoot}`);
  console.log(`Events:       ${selected.length} (${selected.map((e) => e.dirName).join(", ")})`);
  console.log(`Reps:         ${CLI.repr.map((r) => REPR_LABEL[r]).join(", ")}`);
  console.log(`Model:        ${modelId} (workhorse tier)  thinking=${CLI.thinking}`);
  console.log(`Max input:    ${CLI.maxInputChars.toLocaleString()} chars   max output: ${CLI.maxTokens}`);
  if (CLI.contractsOverride) console.log(`Contracts:    OVERRIDE ${CLI.contractsOverride}`);
  if (CLI.dryRun) console.log("DRY RUN — representations built and saved, no model calls\n");
  else console.log("");

  const summaryPath = join(CLI.corpusRoot, "parse-run-summary.json");
  const rowsByKey = new Map<string, SummaryRow>();
  for (const row of loadPriorSummaryRows(summaryPath)) {
    rowsByKey.set(`${row.event}|${row.representation}`, row);
  }

  for (const dir of selected) {
    console.log(`── ${dir.dirName}`);

    let contractsFile: ContractsFile;
    const contractsPath = CLI.contractsOverride ?? join(dir.path, "contracts.json");
    try {
      if (!existsSync(contractsPath)) throw new Error(`contracts file not found: ${contractsPath}`);
      contractsFile = loadContracts(contractsPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`   SKIP all reps — ${message}`);
      for (const repr of CLI.repr) {
        rowsByKey.set(`${dir.dirName}|${REPR_LABEL[repr]}`, {
          event: dir.dirName,
          symbol: dir.symbol,
          event_date: dir.eventDate,
          representation: REPR_LABEL[repr],
          status: "skipped",
          error: message,
          candidate_count: 0,
          not_disclosed_count: 0,
          source_file: null,
          input_chars: 0,
          input_truncated: false,
          input_sha256: null,
          input_tokens: null,
          output_tokens: null,
          latency_ms: null,
          est_cost_usd: null,
          attempts: 0,
          ran_at: new Date().toISOString(),
        });
      }
      continue;
    }
    console.log(`   contracts: ${contractsFile.contracts.length} lines (${contractsPath})`);

    const jobs: { repr: ReprId; input: ParseInput }[] = [];
    for (const repr of CLI.repr) {
      const built = buildInput(dir, repr, contractsFile);
      if ("skip" in built) {
        console.log(`   ${REPR_LABEL[repr]}: SKIP — ${built.skip}`);
        rowsByKey.set(`${dir.dirName}|${REPR_LABEL[repr]}`, {
          event: dir.dirName,
          symbol: dir.symbol,
          event_date: dir.eventDate,
          representation: REPR_LABEL[repr],
          status: "skipped",
          error: built.skip,
          candidate_count: 0,
          not_disclosed_count: 0,
          source_file: null,
          input_chars: 0,
          input_truncated: false,
          input_sha256: null,
          input_tokens: null,
          output_tokens: null,
          latency_ms: null,
          est_cost_usd: null,
          attempts: 0,
          ran_at: new Date().toISOString(),
        });
        continue;
      }
      jobs.push({ repr, input: built.input });
    }

    if (CLI.dryRun) {
      for (const job of jobs) {
        console.log(
          `   ${REPR_LABEL[job.repr]}: ${job.input.documentText.length.toLocaleString()} chars` +
            `${job.input.truncated ? " (TRUNCATED)" : ""} from ${job.input.sourceFile}` +
            `${Object.keys(job.input.diagnostics).length > 0 ? ` ${JSON.stringify(job.input.diagnostics)}` : ""}`,
        );
        rowsByKey.set(`${dir.dirName}|${REPR_LABEL[job.repr]}`, {
          event: dir.dirName,
          symbol: dir.symbol,
          event_date: dir.eventDate,
          representation: REPR_LABEL[job.repr],
          status: "dry-run",
          error: null,
          candidate_count: 0,
          not_disclosed_count: 0,
          source_file: job.input.sourceFile,
          input_chars: job.input.documentText.length,
          input_truncated: job.input.truncated,
          input_sha256: sha256(job.input.documentText),
          input_tokens: null,
          output_tokens: null,
          latency_ms: null,
          est_cost_usd: null,
          attempts: 0,
          ran_at: new Date().toISOString(),
        });
      }
      continue;
    }

    // Reps within one event are independent — run them together (bounded).
    const results: { repr: ReprId; input: ParseInput; outcome: ParseOutcome }[] = [];
    for (let i = 0; i < jobs.length; i += CLI.concurrency) {
      const batch = jobs.slice(i, i + CLI.concurrency);
      const settled = await Promise.all(
        batch.map(async (job) => ({
          repr: job.repr,
          input: job.input,
          outcome: await callModel(client, modelId, job.input),
        })),
      );
      results.push(...settled);
    }

    for (const { repr, input, outcome } of results) {
      const inputSha = sha256(input.documentText);
      const startedAt = new Date(Date.now() - outcome.latencyMs).toISOString();
      const notDisclosed = outcome.candidates.filter((c) => c.not_disclosed).length;
      const cost = outcome.usage
        ? estimateCostUsd(modelId, outcome.usage.input_tokens, outcome.usage.output_tokens)
        : null;

      const payload = {
        representation: REPR_LABEL[repr],
        model_id: modelId,
        started_at: startedAt,
        input_sha256: inputSha,
        candidates: outcome.candidates,
        // diagnostics — deliberately after `candidates` so the contract fields
        // the scorer reads sit at the top of the file.
        run: {
          status: outcome.status,
          error: outcome.error,
          attempts: outcome.attempts,
          latency_ms: outcome.latencyMs,
          stop_reason: outcome.stopReason,
          thinking: CLI.thinking,
          max_tokens: CLI.maxTokens,
          usage: outcome.usage,
          est_cost_usd: cost,
        },
        document: {
          source_file: input.sourceFile,
          source_sha256: input.sourceSha256,
          representation_chars: input.originalChars,
          sent_chars: input.documentText.length,
          truncated: input.truncated,
          ...input.diagnostics,
        },
        contracts: {
          count: input.contractsFile.contracts.length,
          path: CLI.contractsOverride ?? "contracts.json",
          sha256: input.contractsFile.sha256,
          metric_ids: input.contractsFile.contracts.map((c) => c.metric_id),
        },
      };
      writeFileSync(
        join(dir.path, `parse-rep${repr}.json`),
        JSON.stringify(payload, null, 2),
        "utf-8",
      );

      const flag = outcome.status === "ok" ? "ok " : "ERR";
      console.log(
        `   ${REPR_LABEL[repr]}: ${flag} ${outcome.candidates.length} candidates ` +
          `(${notDisclosed} not_disclosed) · ${(outcome.latencyMs / 1000).toFixed(1)}s · ` +
          `${outcome.usage ? `${outcome.usage.input_tokens} in / ${outcome.usage.output_tokens} out` : "no usage"}` +
          `${cost !== null ? ` · $${cost.toFixed(4)}` : ""}` +
          `${outcome.error ? ` · ${outcome.error}` : ""}`,
      );

      rowsByKey.set(`${dir.dirName}|${REPR_LABEL[repr]}`, {
        event: dir.dirName,
        symbol: dir.symbol,
        event_date: dir.eventDate,
        representation: REPR_LABEL[repr],
        status: outcome.status === "skipped" ? "skipped" : outcome.status,
        error: outcome.error,
        candidate_count: outcome.candidates.length,
        not_disclosed_count: notDisclosed,
        source_file: input.sourceFile,
        input_chars: input.documentText.length,
        input_truncated: input.truncated,
        input_sha256: inputSha,
        input_tokens: outcome.usage?.input_tokens ?? null,
        output_tokens: outcome.usage?.output_tokens ?? null,
        latency_ms: outcome.latencyMs,
        est_cost_usd: cost,
        attempts: outcome.attempts,
        ran_at: new Date().toISOString(),
      });
    }
  }

  const runs = Array.from(rowsByKey.values()).sort((a, b) =>
    a.event === b.event
      ? a.representation.localeCompare(b.representation)
      : a.event.localeCompare(b.event),
  );
  const totals = runs.reduce(
    (acc, r) => {
      acc.calls += r.status === "ok" || r.status === "error" ? 1 : 0;
      acc.ok += r.status === "ok" ? 1 : 0;
      acc.error += r.status === "error" ? 1 : 0;
      acc.skipped += r.status === "skipped" ? 1 : 0;
      acc.candidates += r.candidate_count;
      acc.input_tokens += r.input_tokens ?? 0;
      acc.output_tokens += r.output_tokens ?? 0;
      acc.est_cost_usd += r.est_cost_usd ?? 0;
      acc.latency_ms += r.latency_ms ?? 0;
      return acc;
    },
    {
      calls: 0, ok: 0, error: 0, skipped: 0, candidates: 0,
      input_tokens: 0, output_tokens: 0, est_cost_usd: 0, latency_ms: 0,
    },
  );

  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        corpusRoot: CLI.corpusRoot,
        model_id: modelId,
        thinking: CLI.thinking,
        max_tokens: CLI.maxTokens,
        max_input_chars: CLI.maxInputChars,
        contracts_override: CLI.contractsOverride,
        dry_run: CLI.dryRun,
        totals,
        runs,
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(
    `\n${totals.ok} ok · ${totals.error} error · ${totals.skipped} skipped · ` +
      `${totals.candidates} candidates · ${totals.input_tokens.toLocaleString()} in / ` +
      `${totals.output_tokens.toLocaleString()} out tokens · ~$${totals.est_cost_usd.toFixed(3)}`,
  );
  console.log(`Summary: ${summaryPath}`);
}

/**
 * Only run when this file IS the entry script. buildRepA / buildRepB /
 * loadContracts are exported for the scoring pass and for ad-hoc inspection —
 * importing them must never fire a corpus-wide, billable run. (It did once,
 * during development, which is why this guard exists.)
 */
const entryScript = process.argv[1] ?? "";
if (/spike-bakeoff-parse(\.[cm]?[tj]s)?$/.test(entryScript)) {
  // mkdirSync is only needed when a caller points --corpus at a fresh dir
  if (!existsSync(CLI.corpusRoot)) mkdirSync(CLI.corpusRoot, { recursive: true });
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
