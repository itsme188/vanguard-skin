# Rich Preview-Based Worksheet Print — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The auto-printed earnings worksheet becomes the preview email's content (scoreboard → past prints → line-by-line bogies with blank ruled ACTUAL/Δ fill-in columns → commentary) rendered as multi-page 80-col monospace, waiting for the local preview email before printing; the existing deterministic sheet survives as the manual-print fallback.

**Architecture:** New pure module `lib/earnings/worksheet-rich.ts` (markdown parsing + monospace table rendering + page composition, zero DB/IO). `lib/earnings/worksheet.ts` gains a DB loader that assembles inputs from the stored preview (`earnings_emails.ai_output_md`) plus the exported email renderers (`renderHeadlineTable`, `renderPastPrintsBlock`, `loadIntelView`), gates the auto-print pass on local-preview existence, and gives manual print a deterministic fallback. `lib/calendar/email-sweep.ts` moves the auto-print pass after the send loop.

**Tech Stack:** TypeScript, better-sqlite3 (`:memory:` for tests), Vitest, `lp`/CUPS (unchanged plumbing).

**Spec:** `docs/superpowers/specs/2026-08-05-worksheet-rich-preview-print-design.md`

## Global Constraints

- Page geometry: `WIDTH = 80` printable columns, `MAX_LINES = 62` lines per page, hard cap `MAX_PAGES = 3`; pages separated by form feed `\f`.
- Bogies table layout: 79 cols incl. 3 `│` separators — Metric 16 | Consensus/Prior 41 | Actual 13 | Δ 6; Actual + Δ are fill-in columns.
- Fill-in blank rule: in a fill-in column, a cell that is exactly `—` (or empty) renders as blank space.
- Bogies table caps at 20 rows with a `(+N more rows — see email)` line; commentary is the flex section, truncating with `… (full text in the preview email)`.
- No new dependencies, no new AI calls, no migrations, no API/UI shape changes. `printViaLp` untouched.
- Auto-print gate: a *local completed* preview must exist — `getEmailAudit(db, eventId, "preview")` row with non-null `ai_output_md` (this excludes `in_progress` claims and `sent-by-cloud` rows). No preview → skip WITHOUT stamping (retries next tick).
- All new DB-touching functions take `db: Database.Database` as first param (project convention).
- Commit messages via temp file + `git commit -F` (never inline `-m`).
- Per-task commits run the task's targeted tests; Task 5 runs the FULL suite (`npx vitest run`) + `npx next build` before its commit.

---

### Task 1: Markdown extraction — `parseMarkdownTable`, `extractFirstTable`, `extractPreviewSections`

**Files:**
- Create: `lib/earnings/worksheet-rich.ts`
- Test: `tests/earnings/worksheet-rich.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Tasks 2–4):

```ts
export interface ParsedMarkdownTable {
  header: string[];
  rows: string[][]; // cells trimmed, ** stripped
}
export interface PreviewSections {
  bogiesTable: ParsedMarkdownTable | null;
  /** Markdown after the bogies table (or after its heading when the table is
   * malformed/absent, or from the start when no bogies heading exists),
   * up to but excluding `## Sources`. Trimmed. */
  commentary: string;
}
export function parseMarkdownTable(lines: string[]): ParsedMarkdownTable | null;
export function extractFirstTable(md: string): {
  table: ParsedMarkdownTable | null;
  /** Markdown lines after the table (or the whole input when no table). */
  after: string;
};
export function extractPreviewSections(aiOutputMd: string): PreviewSections;
```

- [ ] **Step 1: Write the failing tests**

Create `tests/earnings/worksheet-rich.test.ts`:

```ts
/**
 * Rich preview-based worksheet (2026-08-05 spec) — pure markdown extraction,
 * monospace table rendering, page composition. No DB, no IO.
 */
import { describe, it, expect } from "vitest";
import {
  parseMarkdownTable,
  extractFirstTable,
  extractPreviewSections,
} from "@/lib/earnings/worksheet-rich";

const PREVIEW_MD = `## Line-by-line bogies

| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Revenue | Street ~$196.9B vs. company guide $194–199B; Finnhub sync shows $200.3B (outlier — flag the gap) | — | — |
| **EPS (GAAP)** | $1.82–1.86 Street; Visible Alpha $1.99 | — | — |
| AWS revenue | $40.5B, implying ~31% y/y growth | — | — |

## The setup

AMZN goes into the print up 4% over 30 days. [BofA note](https://example.com/x) flags capex.

## Bull case / bear case

- **Bull:** AWS reacceleration above 31%
- **Bear:** FY26 capex guide above $218B

## Sources

- TMT Breakout 8/1 — [link](https://example.com/y)
`;

describe("parseMarkdownTable", () => {
  it("parses header + rows, trims cells, strips bold markers", () => {
    const lines = PREVIEW_MD.split("\n").slice(2, 7);
    const t = parseMarkdownTable(lines);
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(["Metric", "Consensus / Prior", "Actual", "Δ"]);
    expect(t!.rows).toHaveLength(3);
    expect(t!.rows[1][0]).toBe("EPS (GAAP)"); // ** stripped
    expect(t!.rows[0][2]).toBe("—");
  });

  it("returns null when the first line is not a table row", () => {
    expect(parseMarkdownTable(["not a table"])).toBeNull();
  });

  it("tolerates a missing separator row and ragged column counts", () => {
    const t = parseMarkdownTable(["| A | B |", "| 1 |", "| 1 | 2 | 3 |"]);
    expect(t!.header).toEqual(["A", "B"]);
    expect(t!.rows).toEqual([["1"], ["1", "2", "3"]]);
  });
});

describe("extractFirstTable", () => {
  it("returns the table plus the markdown after it", () => {
    const { table, after } = extractFirstTable(PREVIEW_MD);
    expect(table!.rows).toHaveLength(3);
    expect(after).toContain("## The setup");
    expect(after).not.toContain("| Revenue |");
  });

  it("returns null table + full input when no table exists", () => {
    const { table, after } = extractFirstTable("just prose\n\nmore prose");
    expect(table).toBeNull();
    expect(after).toBe("just prose\n\nmore prose");
  });
});

describe("extractPreviewSections", () => {
  it("extracts the bogies table and the commentary span, excluding Sources", () => {
    const s = extractPreviewSections(PREVIEW_MD);
    expect(s.bogiesTable!.rows).toHaveLength(3);
    expect(s.commentary).toContain("## The setup");
    expect(s.commentary).toContain("## Bull case / bear case");
    expect(s.commentary).not.toContain("## Sources");
    expect(s.commentary).not.toContain("TMT Breakout 8/1");
    expect(s.commentary).not.toContain("| Revenue |");
  });

  it("tolerates a drifted bogies heading (case/word variations)", () => {
    const md = PREVIEW_MD.replace("## Line-by-line bogies", "## Line-by-Line Bogeys");
    expect(extractPreviewSections(md).bogiesTable).not.toBeNull();
  });

  it("no bogies heading → null table, whole doc (minus Sources) is commentary", () => {
    const md = "## The setup\n\nprose here\n\n## Sources\n\n- x";
    const s = extractPreviewSections(md);
    expect(s.bogiesTable).toBeNull();
    expect(s.commentary).toContain("## The setup");
    expect(s.commentary).not.toContain("## Sources");
  });

  it("bogies heading present but table malformed → null table, commentary preserved", () => {
    const md = "## Line-by-line bogies\n\nno table came out\n\n## The setup\n\nprose";
    const s = extractPreviewSections(md);
    expect(s.bogiesTable).toBeNull();
    expect(s.commentary).toContain("## The setup");
  });

  it("never throws on empty input", () => {
    const s = extractPreviewSections("");
    expect(s.bogiesTable).toBeNull();
    expect(s.commentary).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/earnings/worksheet-rich.test.ts`
Expected: FAIL — module `@/lib/earnings/worksheet-rich` does not exist.

- [ ] **Step 3: Implement the module**

Create `lib/earnings/worksheet-rich.ts`:

```ts
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
  const { table, after } = extractFirstTable(fromHeading);
  return { bogiesTable: table, commentary: after.trim() };
}
```

Note the malformed-table nuance: when the bogies heading exists but `extractFirstTable` finds no table before the next content, `after` still carries the prose — but if a table exists *later* in the commentary (e.g. inside Bull/bear), `extractFirstTable` on `fromHeading` would wrongly grab it. Guard: only accept the table if it appears before the next `##` heading. Add to `extractPreviewSections` after computing `fromHeading`:

```ts
  const fhLines = fromHeading.split("\n");
  const nextHeading = fhLines.findIndex((l) => /^##\s/.test(l.trim()));
  const tableIdx = fhLines.findIndex(isTableRow);
  if (tableIdx === -1 || (nextHeading !== -1 && tableIdx > nextHeading)) {
    return { bogiesTable: null, commentary: fromHeading.trim() };
  }
  const { table, after } = extractFirstTable(fromHeading);
  return { bogiesTable: table, commentary: after.trim() };
```

(Replace the simpler two lines with this version; the "malformed table" test covers the `tableIdx > nextHeading` branch because the only table-ish content sits after `## The setup`... it has no table at all — `tableIdx === -1` branch. Both branches return the same shape.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/earnings/worksheet-rich.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

Write the message to a temp file, then:

```bash
git add lib/earnings/worksheet-rich.ts tests/earnings/worksheet-rich.test.ts
git commit -F <tempfile>   # "feat(worksheet): markdown extraction for rich preview-based print"
```

---

### Task 2: Monospace rendering — `wrapText`, `mdToPlainText`, `renderMonospaceTable`

**Files:**
- Modify: `lib/earnings/worksheet-rich.ts` (append)
- Test: `tests/earnings/worksheet-rich.test.ts` (append)

**Interfaces:**
- Consumes: `ParsedMarkdownTable` from Task 1.
- Produces (used by Task 3):

```ts
export function wrapText(text: string, width: number): string[];
/** Markdown → wrapped plain-text lines (width 78): ## headings become
 * blank line + UPPERCASE title, inline markers stripped, bullets kept with
 * 2-space hang indent, blank-line runs collapsed to one. */
export function mdToPlainText(md: string, width?: number): string[];
export interface TableLayout {
  widths: number[]; // per-column content widths
  /** Column indexes whose "—"/empty cells render as blank fill-in space. */
  fillIn?: number[];
}
/** Ruled table lines: header row, ─┼─ separator, then each row followed by a
 * separator line. Cells word-wrap; row height = max wrapped lines. Total
 * width = sum(widths) + (n−1) │ separators. Extra cells beyond layout.widths
 * are dropped; missing cells render blank. */
export function renderMonospaceTable(table: ParsedMarkdownTable, layout: TableLayout): string[];
```

- [ ] **Step 1: Write the failing tests** (append to `tests/earnings/worksheet-rich.test.ts`)

```ts
import {
  wrapText,
  mdToPlainText,
  renderMonospaceTable,
} from "@/lib/earnings/worksheet-rich";

describe("wrapText", () => {
  it("word-wraps at the width", () => {
    expect(wrapText("alpha beta gamma delta", 11)).toEqual(["alpha beta", "gamma delta"]);
  });
  it("hard-splits words longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("empty input → single empty line", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });
});

describe("mdToPlainText", () => {
  it("renders headings as uppercase titles and strips inline markers", () => {
    const lines = mdToPlainText("## The setup\n\nAMZN is **up** 4% ([note](https://x.com)).");
    expect(lines).toContain("THE SETUP");
    expect(lines.join("\n")).toContain("AMZN is up 4% (note).");
    expect(lines.join("\n")).not.toContain("**");
    expect(lines.join("\n")).not.toContain("https://x.com");
  });
  it("keeps bullets with hang indent on wrapped lines", () => {
    const lines = mdToPlainText("- " + "word ".repeat(30).trim(), 40);
    expect(lines[0].startsWith("- ")).toBe(true);
    expect(lines[1].startsWith("  ")).toBe(true);
  });
  it("collapses blank-line runs", () => {
    const lines = mdToPlainText("a\n\n\n\nb");
    expect(lines).toEqual(["a", "", "b"]);
  });
});

describe("renderMonospaceTable", () => {
  const TABLE = {
    header: ["Metric", "Consensus / Prior", "Actual", "Δ"],
    rows: [
      ["Revenue", "Street ~$196.9B vs. company guide $194–199B; Finnhub shows $200.3B", "—", "—"],
      ["EPS", "$1.82–1.86", "—", "—"],
    ],
  };
  const LAYOUT = { widths: [16, 41, 13, 6], fillIn: [2, 3] };

  it("every line is exactly the total table width", () => {
    const lines = renderMonospaceTable(TABLE, LAYOUT);
    const total = 16 + 41 + 13 + 6 + 3;
    for (const l of lines) expect(l.length).toBe(total);
  });

  it("wraps long cells across lines within their column", () => {
    const lines = renderMonospaceTable(TABLE, LAYOUT);
    const revenueLines = lines.filter((l) => l.includes("$196.9B") || l.includes("$200.3B"));
    expect(revenueLines.length).toBeGreaterThanOrEqual(2);
  });

  it("renders — as blank space in fill-in columns but keeps it elsewhere", () => {
    const t = {
      header: ["M", "C", "A", "D"],
      rows: [["x", "—", "—", "—"]],
    };
    const lines = renderMonospaceTable(t, LAYOUT);
    const rowLine = lines.find((l) => l.startsWith("x"))!;
    const cells = rowLine.split("│");
    expect(cells[1]).toContain("—"); // consensus col: not fill-in
    expect(cells[2].trim()).toBe(""); // actual: blank box
    expect(cells[3].trim()).toBe(""); // delta: blank box
  });

  it("draws a ruled separator between rows with ┼ at column joints", () => {
    const lines = renderMonospaceTable(TABLE, LAYOUT);
    const seps = lines.filter((l) => l.includes("┼"));
    // header separator + one after each row
    expect(seps.length).toBe(1 + TABLE.rows.length);
    expect(seps[0]).toBe("─".repeat(16) + "┼" + "─".repeat(41) + "┼" + "─".repeat(13) + "┼" + "─".repeat(6));
  });

  it("drops extra cells and blanks missing cells", () => {
    const t = { header: ["A", "B"], rows: [["1"], ["1", "2", "3"]] };
    const lines = renderMonospaceTable(t, { widths: [4, 4] });
    expect(lines.some((l) => l.includes("3"))).toBe(false);
    for (const l of lines) expect(l.length).toBe(9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/earnings/worksheet-rich.test.ts`
Expected: FAIL — `wrapText` not exported.

- [ ] **Step 3: Implement** (append to `lib/earnings/worksheet-rich.ts`)

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/earnings/worksheet-rich.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/earnings/worksheet-rich.ts tests/earnings/worksheet-rich.test.ts
git commit -F <tempfile>   # "feat(worksheet): monospace table + markdown-to-text renderers"
```

---

### Task 3: Page assembly — `composeRichWorksheet`

**Files:**
- Modify: `lib/earnings/worksheet-rich.ts` (append)
- Test: `tests/earnings/worksheet-rich.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 + Task 2 exports.
- Produces (used by Task 4):

```ts
export interface RichWorksheetInputs {
  event: {
    symbol: string | null;
    event_date: string; // YYYY-MM-DD
    event_time: string | null; // "BMO"/"AMC"/HH:MM/null
  };
  /** renderHeadlineTable(event, symbol, "preview", intelView) output. */
  scoreboardMd: string;
  /** renderPastPrintsBlock(intelView.history) output; "" when no history. */
  pastPrintsMd: string;
  sections: PreviewSections;
  noteLines: string[]; // already truncated by the loader, ≤4
  /** earnings_emails.sent_at of the preview audit row (footer provenance). */
  sentAt: string | null;
  /** e.g. "exp move ±6.0% (TMT Breakout weekly)" or "". */
  expectedMoveLabel: string;
}
export function composeRichWorksheet(inputs: RichWorksheetInputs): string;
```

Constants (module-level, exported for tests): `WIDTH = 80`, `MAX_LINES = 62`, `MAX_PAGES = 3`, `MAX_BOGIES_ROWS = 20`.

Layouts (module-level consts):
- `BOGIES_LAYOUT: TableLayout = { widths: [16, 41, 13, 6], fillIn: [2, 3] }`
- `SCOREBOARD_LAYOUT: TableLayout = { widths: [26, 22, 18, 10], fillIn: [2, 3] }`
- `PAST_PRINTS_LAYOUT: TableLayout = { widths: [12, 20, 12, 16] }`

- [ ] **Step 1: Write the failing tests** (append)

```ts
import {
  composeRichWorksheet,
  MAX_LINES,
  MAX_PAGES,
  type RichWorksheetInputs,
} from "@/lib/earnings/worksheet-rich";

const SCOREBOARD_MD = `## AMZN scoreboard — into the print

| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| **EPS** | 1.84 | — | — |
| **Revenue** | $196.9B | — | — |
| **Expected move** | ±6.0% | — | — |

*Empty cells in a preview are intentional — print this, fill them in live.*`;

const PAST_PRINTS_MD = `## Past prints

| Reported | EPS act / est | Surprise | Next-day move |
|---|---|---|---|
| 2026-05-01 | 1.59 / 1.36 | +16.9% | +3.2% |

*Next-day move is close-over-close around the print.*`;

function richInputs(overrides: Partial<RichWorksheetInputs> = {}): RichWorksheetInputs {
  return {
    event: { symbol: "AMZN", event_date: "2026-08-06", event_time: "AMC" },
    scoreboardMd: SCOREBOARD_MD,
    pastPrintsMd: PAST_PRINTS_MD,
    sections: extractPreviewSections(PREVIEW_MD),
    noteLines: ["Watching AWS margin."],
    sentAt: "2026-08-06 12:05:00",
    expectedMoveLabel: "exp move ±6.0% (TMT Breakout weekly)",
    ...overrides,
  };
}

describe("composeRichWorksheet", () => {
  it("orders sections: header, scoreboard, past prints, bogies, commentary, notes", () => {
    const text = composeRichWorksheet(richInputs());
    const idx = (s: string) => text.indexOf(s);
    expect(idx("AMZN — ")).toBe(0);
    expect(idx("SCOREBOARD")).toBeGreaterThan(0);
    expect(idx("PAST PRINTS")).toBeGreaterThan(idx("SCOREBOARD"));
    expect(idx("LINE-BY-LINE BOGIES")).toBeGreaterThan(idx("PAST PRINTS"));
    expect(idx("THE SETUP")).toBeGreaterThan(idx("LINE-BY-LINE BOGIES"));
    expect(idx("NOTES (YOURS)")).toBeGreaterThan(idx("THE SETUP"));
  });

  it("no line exceeds 80 chars and pages are ≤62 lines split by form feeds", () => {
    const text = composeRichWorksheet(richInputs());
    const pages = text.split("\f");
    expect(pages.length).toBeLessThanOrEqual(MAX_PAGES);
    for (const page of pages) {
      const lines = page.replace(/\n$/, "").split("\n");
      expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
    }
  });

  it("scoreboard preview dashes become blank fill-in boxes", () => {
    const text = composeRichWorksheet(richInputs());
    const epsLine = text.split("\n").find((l) => l.startsWith("EPS"));
    expect(epsLine).toBeDefined();
    expect(epsLine!).toContain("1.84");
    expect(epsLine!.split("│")[2].trim()).toBe("");
  });

  it("omits PAST PRINTS when history is empty", () => {
    const text = composeRichWorksheet(richInputs({ pastPrintsMd: "" }));
    expect(text).not.toContain("PAST PRINTS");
  });

  it("caps the bogies table at 20 rows with an overflow note", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`Metric ${i}`, "cons", "—", "—"]);
    const sections = {
      bogiesTable: { header: ["Metric", "Consensus / Prior", "Actual", "Δ"], rows },
      commentary: "## The setup\n\nprose",
    };
    const text = composeRichWorksheet(richInputs({ sections }));
    expect(text).toContain("Metric 19");
    expect(text).not.toContain("Metric 20");
    expect(text).toContain("(+10 more rows — see email)");
  });

  it("truncates commentary to fit 3 pages with an ellipsis note", () => {
    const commentary = "## The setup\n\n" + "word ".repeat(6000);
    const sections = { ...extractPreviewSections(PREVIEW_MD), commentary };
    const text = composeRichWorksheet(richInputs({ sections }));
    expect(text.split("\f").length).toBeLessThanOrEqual(MAX_PAGES);
    expect(text).toContain("… (full text in the preview email)");
  });

  it("footer carries the preview send timestamp on the last line", () => {
    const text = composeRichWorksheet(richInputs());
    const last = text.trimEnd().split("\n").pop()!;
    expect(last).toContain("2026-08-06 12:05:00");
  });

  it("skips the bogies section entirely when the table is null", () => {
    const sections = { bogiesTable: null, commentary: "## The setup\n\nprose" };
    const text = composeRichWorksheet(richInputs({ sections }));
    expect(text).not.toContain("LINE-BY-LINE BOGIES");
    expect(text).toContain("THE SETUP");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/earnings/worksheet-rich.test.ts`
Expected: FAIL — `composeRichWorksheet` not exported.

- [ ] **Step 3: Implement** (append to `lib/earnings/worksheet-rich.ts`)

```ts
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
    for (const n of noteLines.slice(0, 4)) notes.push(`  · ${n}`.slice(0, WIDTH));
  }

  const footer = `[from preview email sent ${inputs.sentAt ?? "—"} · fill-in worksheet]`;

  // Commentary flexes into whatever the 3-page budget leaves (1 line reserved
  // for the footer). Section titles inside the commentary are its own
  // uppercase headings (THE SETUP, BULL CASE / BEAR CASE, …).
  const budget = MAX_LINES * MAX_PAGES - 1 - fixed.length - notes.length - 1; // −1 leading blank
  let commentary = sections.commentary.trim() ? mdToPlainText(sections.commentary) : [];
  if (commentary.length > budget) {
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
  body.push(footer);

  // Deterministic pagination: form feed after every 62 lines.
  const pages: string[] = [];
  for (let i = 0; i < body.length; i += MAX_LINES) {
    pages.push(body.slice(i, i + MAX_LINES).join("\n"));
  }
  return pages.join("\f") + "\n";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/earnings/worksheet-rich.test.ts`
Expected: PASS. If the page-cap test fails on an off-by-one, adjust the `budget`/`free` arithmetic — the invariants that MUST hold are: ≤3 form-feed pages, ≤62 lines per page, footer last, ellipsis note present when truncated.

- [ ] **Step 5: Commit**

```bash
git add lib/earnings/worksheet-rich.ts tests/earnings/worksheet-rich.test.ts
git commit -F <tempfile>   # "feat(worksheet): rich worksheet page composer with 3-page budget"
```

---

### Task 4: DB loader + gating — `loadRichWorksheetInputs`, `composeWorksheetForEvent`, wait-for-preview auto pass

**Files:**
- Modify: `lib/earnings/worksheet.ts`
- Test: `tests/earnings/worksheet.test.ts` (append)

**Interfaces:**
- Consumes: `composeRichWorksheet`, `extractPreviewSections`, `RichWorksheetInputs` (Tasks 1–3); `getEmailAudit` (`lib/queries/earnings-emails.ts`, returns `{ sent_at, ai_output_md, error, … } | null`, already excludes `'in_progress'`); `loadIntelView(db, eventId, symbol)`, `renderHeadlineTable(event, symbol, "preview", intelView)`, `renderPastPrintsBlock(intelView.history)` from `@/lib/digest/send-earnings-email`.
- Produces:

```ts
/** null unless a LOCAL completed preview with usable content exists. */
export function loadRichWorksheetInputs(db: Database.Database, eventId: number): RichWorksheetInputs | null;
/** Rich text when available, deterministic fallback otherwise. */
export function composeWorksheetForEvent(
  db: Database.Database,
  eventId: number,
): { text: string; rich: boolean; symbol: string } | null;
```

`printWorksheetNow` refactors onto `composeWorksheetForEvent`. `printArmedWorksheets` gains the wait-gate: skip (no stamp) when `loadRichWorksheetInputs` returns null.

**Import-cycle check (verified during planning):** `lib/digest/send-earnings-email.ts` does not import `lib/earnings/worksheet.ts` — the new imports are acyclic.

- [ ] **Step 1: Write the failing tests** (append to `tests/earnings/worksheet.test.ts`)

Add imports at the top of the file:

```ts
import {
  loadRichWorksheetInputs,
  composeWorksheetForEvent,
} from "@/lib/earnings/worksheet";
```

Add a seed helper next to `seedEvent`:

```ts
const PREVIEW_AI_MD = `## Line-by-line bogies

| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Revenue | Street ~$196.9B vs. guide $194–199B | — | — |
| AWS revenue | $40.5B, ~31% y/y | — | — |

## The setup

Into the print up 4% over 30 days.

## Sources

- TMT Breakout 8/1
`;

function seedPreviewEmail(
  eventId: number,
  aiOutputMd: string | null,
  error: string | null = null,
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
     VALUES (?, 'preview', 'me@example.com', '2026-08-06 12:05:00', ?, ?)`,
  ).run(eventId, aiOutputMd, error);
}
```

New describe blocks:

```ts
describe("loadRichWorksheetInputs", () => {
  it("returns null when no preview email exists", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    expect(loadRichWorksheetInputs(db, id)).toBeNull();
  });

  it("returns null for a cloud-sent preview (no local prose)", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, null, "sent-by-cloud");
    expect(loadRichWorksheetInputs(db, id)).toBeNull();
  });

  it("returns null when ai_output_md yields neither table nor commentary", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, "## Sources\n\n- only sources");
    expect(loadRichWorksheetInputs(db, id)).toBeNull();
  });

  it("assembles inputs from a local preview", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, PREVIEW_AI_MD);
    const inputs = loadRichWorksheetInputs(db, id);
    expect(inputs).not.toBeNull();
    expect(inputs!.sections.bogiesTable!.rows).toHaveLength(2);
    expect(inputs!.scoreboardMd).toContain("scoreboard");
    expect(inputs!.sentAt).toBe("2026-08-06 12:05:00");
  });
});

describe("composeWorksheetForEvent", () => {
  it("falls back to the deterministic sheet without a preview", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    const r = composeWorksheetForEvent(db, id);
    expect(r).not.toBeNull();
    expect(r!.rich).toBe(false);
    expect(r!.text).toContain("SCRATCH");
    expect(r!.text).toContain("WHISPER"); // deterministic layout marker
  });

  it("composes the rich sheet when a local preview exists", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, PREVIEW_AI_MD);
    const r = composeWorksheetForEvent(db, id);
    expect(r!.rich).toBe(true);
    expect(r!.text).toContain("LINE-BY-LINE BOGIES");
    expect(r!.text).toContain("AWS revenue");
    expect(r!.text).toContain("THE SETUP");
  });

  it("returns null for a missing or symbol-less event", () => {
    expect(composeWorksheetForEvent(db, 9999)).toBeNull();
  });
});
```

And in the existing auto-print describe (reuse its `NOW`/arm/DI-print idioms — the file already has `printArmedWorksheets(db, { now: NOW, print })` tests):

```ts
describe("printArmedWorksheets wait-for-preview gate", () => {
  it("skips without stamping when no local preview exists, prints once it lands", async () => {
    const id = seedEvent("AAPL", "2026-08-06", "16:15");
    armWorksheet(db, id);
    const print = vi.fn(async () => {});
    const NOW = new Date("2026-08-06T19:00:00Z"); // 16:15 ET release ≈ 75 min out

    const before = await printArmedWorksheets(db, { now: NOW, print });
    expect(before.printed).toBe(0);
    expect(print).not.toHaveBeenCalled();

    seedPreviewEmail(id, PREVIEW_AI_MD);
    const after = await printArmedWorksheets(db, { now: NOW, print });
    expect(after.printed).toBe(1);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("never prints for a cloud-sent preview", async () => {
    const id = seedEvent("AAPL", "2026-08-06", "16:15");
    armWorksheet(db, id);
    seedPreviewEmail(id, null, "sent-by-cloud");
    const print = vi.fn(async () => {});
    const r = await printArmedWorksheets(db, { now: new Date("2026-08-06T19:00:00Z"), print });
    expect(r.printed).toBe(0);
    expect(print).not.toHaveBeenCalled();
  });
});
```

**NOTE for the implementer:** existing auto-print tests in this file seed NO preview email — under the new gate they would print nothing. Update them: add `seedPreviewEmail(id, PREVIEW_AI_MD)` after arming in each pre-existing auto-print test (`prints once and stamps`, window-gating, best-effort isolation tests). The deterministic-composer tests (`composeWorksheet`) are untouched.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/earnings/worksheet.test.ts`
Expected: FAIL — `loadRichWorksheetInputs` not exported.

- [ ] **Step 3: Implement in `lib/earnings/worksheet.ts`**

New imports:

```ts
import {
  composeRichWorksheet,
  extractPreviewSections,
  type RichWorksheetInputs,
} from "@/lib/earnings/worksheet-rich";
import { getEmailAudit } from "@/lib/queries/earnings-emails";
import {
  loadIntelView,
  renderHeadlineTable,
  renderPastPrintsBlock,
} from "@/lib/digest/send-earnings-email";
```

Loader (place after `loadWorksheetInputs`):

```ts
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

  const sections = extractPreviewSections(audit.ai_output_md);
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
    .slice(0, 4)
    .map((n) => n.content.replace(/\s+/g, " ").trim().slice(0, 74));

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
```

Refactor `printWorksheetNow` body:

```ts
export async function printWorksheetNow(
  db: Database.Database,
  eventId: number,
): Promise<{ symbol: string }> {
  const composed = composeWorksheetForEvent(db, eventId);
  if (!composed) throw new Error(`Event ${eventId} not found or symbol-less.`);
  await printViaLp(composed.text, {
    printer: printerName(db),
    title: `${composed.symbol} earnings worksheet`,
  });
  return { symbol: composed.symbol };
}
```

Add the wait-gate inside `printArmedWorksheets`'s loop, after the window check (`if (until < AUTO_PRINT_MIN_MS || until > AUTO_PRINT_MAX_MS) continue;`):

```ts
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
```

Also update the module doc comment (lines 1–17): the sheet is now the preview-derived rich worksheet with deterministic fallback; auto-print waits for the local preview.

- [ ] **Step 4: Update pre-existing auto-print tests for the gate**

In `tests/earnings/worksheet.test.ts`, every existing test that expects `printArmedWorksheets` to PRINT must now seed a preview first: add `seedPreviewEmail(id, PREVIEW_AI_MD);` after its `armWorksheet(db, id)` call. Tests that expect NO print (window gating "too early" cases) can stay as-is but adding the seed makes them stricter — add it there too so the no-print assertion tests the window, not the gate.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/earnings/worksheet.test.ts tests/earnings/worksheet-rich.test.ts`
Expected: PASS (all, including updated pre-existing tests).

- [ ] **Step 6: Commit**

```bash
git add lib/earnings/worksheet.ts tests/earnings/worksheet.test.ts
git commit -F <tempfile>   # "feat(worksheet): rich preview-derived sheet with wait-for-preview auto-print gate"
```

---

### Task 5: Sweep ordering + full-suite gate

**Files:**
- Modify: `lib/calendar/email-sweep.ts` (move the `printArmedWorksheets` call)
- Test: `tests/calendar/email-sweep.test.ts` (append ordering test)

**Interfaces:**
- Consumes: `printArmedWorksheets` (unchanged signature).
- Produces: nothing new — behavioral ordering only.

- [ ] **Step 1: Write the failing ordering test**

In `tests/calendar/email-sweep.test.ts`, add a module mock next to the existing `vi.mock` blocks (top of file). Use `vi.hoisted` for the spy so the mock factory can reference it:

```ts
const printArmed = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ printed: 0 })),
);
vi.mock("@/lib/earnings/worksheet", () => ({
  printArmedWorksheets: (...a: unknown[]) => printArmed(...a),
}));
```

Then the test (reuse the file's existing `seedHeldPreviewCandidate` helper and `sendPreview` hoisted mock; place near the other preview-send tests):

```ts
it("runs the worksheet auto-print pass AFTER the send loop so the tick that sends a preview can print it", async () => {
  const eventId = seedHeldPreviewCandidate(db, "AAPL");
  await runEarningsEmailSweep(db, { now: NOW });
  expect(sendPreview).toHaveBeenCalled();
  expect(printArmed).toHaveBeenCalledTimes(1);
  // vitest global invocation ordering: send must precede print.
  expect(printArmed.mock.invocationCallOrder[0]).toBeGreaterThan(
    sendPreview.mock.invocationCallOrder[0],
  );
});
```

(Adapt `NOW` and the exact seed/run invocation to the file's existing conventions — copy whatever the nearest passing preview-send test does; only the ordering assertion is new. If `sendPreview` is not the hoisted mock's name in the current file, use the actual name from the `vi.mock("@/lib/digest/send-earnings-email", …)` factory.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: the new test FAILS on the ordering assertion (print currently runs before the loop). Pre-existing tests must still PASS (the `printArmedWorksheets` mock returns `{printed: 0}`, matching the real no-armed-flags behavior).

- [ ] **Step 3: Move the call in `lib/calendar/email-sweep.ts`**

Delete the current block (just after the debrief pass):

```ts
  // ── Worksheet auto-print pass (feedback #6) ───────────────────────────
  // Armed events print their monospace desk sheet when the release instant
  // enters [now−30m, now+135m] — deliberately independent of the email
  // candidate set (a preview already sent, skipped, or AI-failed must not
  // block the deterministic paper). printArmedWorksheets never throws.
  await printArmedWorksheets(db, { now: opts.now });
```

Re-insert it AFTER the per-candidate `for` loop closes, BEFORE the transcripts step (`const transcripts = await fetchSameDayTranscripts(db, { now: opts.now });`), with an updated comment:

```ts
  // ── Worksheet auto-print pass (feedback #6; rich rework 2026-08-05) ──
  // Runs AFTER the send loop: the rich worksheet is composed from the LOCAL
  // preview email's stored prose (wait-for-preview gate in
  // printArmedWorksheets), so the tick that sends a preview must print it in
  // the same pass. The auto-print window ([−30m, +135m] around release) has
  // ample slack for the loop's 60–180s sends. printArmedWorksheets never
  // throws.
  await printArmedWorksheets(db, { now: opts.now });
```

- [ ] **Step 4: Run the sweep tests**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: PASS (new ordering test + all pre-existing).

- [ ] **Step 5: Full suite + build gate**

Run: `npx vitest run`
Expected: full suite green (~4,263+ tests). Investigate ANY failure — check first whether a failing path is under `.claude/worktrees/` (stale-worktree phantom-failure convention).

Run: `npx next build`
Expected: compiles clean.

- [ ] **Step 6: Commit**

```bash
git add lib/calendar/email-sweep.ts tests/calendar/email-sweep.test.ts
git commit -F <tempfile>   # "feat(worksheet): auto-print pass moves after send loop (wait-for-preview)"
```

---

## Self-Review Notes (done at plan time)

- **Spec coverage:** extraction (T1), rendering + blank-cell rule + layouts (T2/T3), pagination/caps/footer (T3), loader + tri-state gate + fallback + auto-pass wait (T4), sweep move + ordering test (T5). Cloud-sent consequence covered by T4 tests. No migrations/API/UI changes — none planned.
- **Type consistency:** `RichWorksheetInputs.event` uses a narrow inline shape (symbol/event_date/event_time) — worksheet-rich stays CalendarEvent-import-free (pure module, mirrors the zero-import discipline of siblings). `loadRichWorksheetInputs` returns exactly that shape.
- **Known judgment calls for implementers:** exact `budget`/`free` arithmetic in T3 may need ±1 adjustment against the invariant tests; T5's test adapts to the sweep test file's existing helper names (`seedHeldPreviewCandidate`, hoisted send mocks) — verify names in-file before writing.
