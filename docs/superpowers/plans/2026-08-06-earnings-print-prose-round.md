# Earnings Preview Print + Prose Round — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-physical-sheet, email-identical auto-printed earnings preview (tables + complete user notes, duplex overflow), a deterministic per-source sheet-bogeys table in the emails, and prompt rules that fix the prose — per spec `docs/superpowers/specs/2026-08-06-earnings-print-prose-round-design.md`.

**Architecture:** New pure HTML composer (`lib/earnings/print-sheet.ts`) reuses the email's own renderers + `briefingToHtml` so tables are pixel-identical; a thin spawn layer (`lib/earnings/print-pdf.ts`) drives headless Chrome `--print-to-pdf` and `lp` with duplex. `printWorksheetNow` tries the PDF road and falls back to the existing monospace sheet on any failure. `renderSheetBogeysBlock` is code-rendered from `earnings_bogeys` rows into both email phases.

**Tech Stack:** TypeScript, Vitest (in-memory SQLite + DI seams), headless Google Chrome (system app, runtime-detected — NOT an npm dependency), CUPS `lp`.

## Global Constraints

- **No new npm dependencies.** Chrome is spawned from `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; PDF page count is parsed from bytes in our own code.
- **Never-silent printing:** every failure on the PDF road degrades to the monospace road (`composeWorksheetForEvent` → `printViaLp`), never to no paper. `printed_at` stamps only after a successful `lp` queue on either road (existing semantics in `printArmedWorksheets` — do not change its stamp/retry logic).
- **Notes are sacred:** user notes never truncate on either print road. No `.slice()` on note content anywhere in the new code.
- **The AI never authors numbers the system has structured** — the sheet-bogeys table is 100% code-rendered.
- All tests use in-memory SQLite with DI (`db` parameter). Run suite with `npx vitest run` (4,373 green baseline). `npx tsc --noEmit` runs automatically on edits (PostToolUse hook) — heed its output.
- Commit messages via `git commit -F <tmpfile>` (never inline `-m`). Include the standard Co-Authored-By + Claude-Session trailer used by this session.
- Existing behavior pinned: arming stays opt-in; wait-for-preview gate; cloud-sent previews never auto-print; recaps never auto-print; no Worker changes.

---

### Task 1: Formatting-artifact diagnosis (exploratory, bounded)

**Files:**
- Create: `docs/superpowers/plans/2026-08-06-artifact-catalog.md`
- Possibly modify (only if evidence demands): `lib/calendar/briefing-html.ts` + `tests/calendar/briefing-html-inline.test.ts`

**Interfaces:**
- Consumes: live DB read-only (`data/vanguard.db`).
- Produces: the catalog doc. If it names additional prompt rules, Task 5 appends them. If it names a renderer bug, fix it TDD **in this task** (and mirror `workers/cron/src/html.ts` if the fix touches shared inline-format code — byte-parity pinned).

- [ ] **Step 1: Pull the last 6 preview `ai_output_md` rows (read-only)**

```bash
sqlite3 -readonly data/vanguard.db "SELECT ce.symbol, ee.sent_at, length(ee.ai_output_md)
  FROM earnings_emails ee JOIN calendar_events ce ON ce.id = ee.event_id
  WHERE ee.phase='preview' AND ee.ai_output_md IS NOT NULL AND ee.error IS NULL
  ORDER BY ee.sent_at DESC LIMIT 6"
```

Then dump each row's `ai_output_md` to `$CLAUDE_JOB_DIR/tmp/preview-<symbol>.md` and read them.

- [ ] **Step 2: Catalog artifacts** — for each of the six, note per section (Setup / Bull-bear / Watch / Position): bullet-wall vs paragraphs, orphan bold fragments, broken emphasis/links, stray table fragments, filler openers, section restarts. Write the catalog with verbatim examples (redact nothing — the doc is git-tracked but examples are market commentary, not portfolio data; **do not paste position-implication sentences containing user-position specifics** — summarize those).

- [ ] **Step 3: Classify each artifact**: `prompt` (Task 5 adds a rule — append the exact rule text to the catalog), `renderer` (fix here, TDD, both renderers if shared), or `cosmetic-accept`. Commit the catalog (+ any renderer fix).

```bash
git add docs/superpowers/plans/2026-08-06-artifact-catalog.md
git commit -F <tmpfile>   # "docs(earnings): catalog preview prose artifacts for the print/prose round"
```

---

### Task 2: `renderSheetBogeysBlock` — deterministic per-source table in both emails

**Files:**
- Modify: `lib/digest/send-earnings-email.ts` (new exported function near `renderBogeysBlock` ~line 1830; wiring at the markdown assembly ~lines 234-245)
- Test: `tests/digest/earnings-sheet-bogeys.test.ts` (create)

**Interfaces:**
- Consumes: `EarningsBogey` + `getBogeysForEvent(db, eventId)` from `lib/queries/earnings-bogeys.ts`; `formatLargeUSD` from `lib/format.ts`.
- Produces: `export function renderSheetBogeysBlock(bogeys: EarningsBogey[]): string` — returns `""` for empty input, else a markdown block starting `## Sheet bogeys — by source`. Task 3/7 pass its output into the print sheet; `composeEarningsEmail` inserts it between past-prints and AI markdown in BOTH phases.

- [ ] **Step 1: Write failing tests** (`tests/digest/earnings-sheet-bogeys.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { renderSheetBogeysBlock } from "@/lib/digest/send-earnings-email";
import type { EarningsBogey } from "@/lib/queries/earnings-bogeys";

function bogey(over: Partial<EarningsBogey>): EarningsBogey {
  return {
    id: 1, event_id: 1, source: "pdf_upload", source_label: "TMT Breakout",
    source_url: null, raw_pdf_r2_key: null, eps_consensus: null, eps_whisper: null,
    revenue_consensus_usd: null, revenue_whisper_usd: null, expected_move_pct: null,
    segment_breakdown_json: null, guidance_notes: null, notes: null,
    uploaded_at: "2026-08-04 10:00:00", ...over,
  } as EarningsBogey;
}

describe("renderSheetBogeysBlock", () => {
  it("returns empty string with no bogeys", () => {
    expect(renderSheetBogeysBlock([])).toBe("");
  });

  it("renders one column per source, most recent first, whispers bolded with w-mark", () => {
    const md = renderSheetBogeysBlock([
      bogey({ source_label: "FundaAI", uploaded_at: "2026-08-05 09:00:00", eps_consensus: 4.28 }),
      bogey({ source_label: "TMT Breakout", uploaded_at: "2026-08-04 10:00:00", eps_consensus: 4.30, eps_whisper: 4.42, revenue_consensus_usd: 4_340_000_000 }),
    ]);
    expect(md).toContain("## Sheet bogeys — by source");
    const header = md.split("\n").find((l) => l.startsWith("| Metric"))!;
    // Most recent source first
    expect(header.indexOf("FundaAI")).toBeLessThan(header.indexOf("TMT Breakout"));
    expect(md).toContain("**w 4.42**");
    expect(md).toContain("$4.34B");
    // Metric rows only where >=1 source has a value: no Expected move row here
    expect(md).not.toContain("| Expected move");
  });

  it("unions segment rows across sources and skips malformed segment JSON", () => {
    const md = renderSheetBogeysBlock([
      bogey({ source_label: "A", segment_breakdown_json: JSON.stringify({ "Cloud rev": { consensus: 1_200_000_000 } }) }),
      bogey({ source_label: "B", uploaded_at: "2026-08-03 10:00:00", segment_breakdown_json: "{not json" }),
    ]);
    expect(md).toContain("Cloud rev (seg)");
    expect(md).toContain("$1.2B");
  });

  it("caps at 3 source columns with an older-sheets line", () => {
    const md = renderSheetBogeysBlock([
      bogey({ source_label: "S1", uploaded_at: "2026-08-05 09:00:00", eps_consensus: 1 }),
      bogey({ source_label: "S2", uploaded_at: "2026-08-04 09:00:00", eps_consensus: 1 }),
      bogey({ source_label: "S3", uploaded_at: "2026-08-03 09:00:00", eps_consensus: 1 }),
      bogey({ source_label: "S4", uploaded_at: "2026-08-02 09:00:00", eps_consensus: 1 }),
    ]);
    expect(md).not.toContain("S4");
    expect(md).toContain("(+1 older sheet");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/digest/earnings-sheet-bogeys.test.ts` → FAIL (`renderSheetBogeysBlock` not exported).

- [ ] **Step 3: Implement** in `send-earnings-email.ts` (place directly above `renderBogeysBlock`):

```ts
/**
 * Deterministic per-source bogeys table (user decision 2026-08-06): when
 * curated sheets disagree, each source's numbers must be visible — the AI's
 * single Consensus/Prior column merges them. Code-rendered from
 * earnings_bogeys rows; the AI is told this table is system-rendered.
 * Columns = sources (most recent first, cap 3); rows = EPS / Revenue /
 * Expected move (only when >=1 source carries the value) + unioned segments.
 * Whispers render bold with a `w` mark. Empty input → "" (email unchanged).
 */
export function renderSheetBogeysBlock(bogeys: EarningsBogey[]): string {
  if (bogeys.length === 0) return "";
  const sorted = [...bogeys].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  const shown = sorted.slice(0, 3);
  const older = sorted.length - shown.length;

  const cell = (cons: string | null, whisper: string | null): string => {
    const parts: string[] = [];
    if (cons) parts.push(cons);
    if (whisper) parts.push(`**w ${whisper}**`);
    return parts.length ? parts.join(" · ") : "—";
  };
  const segs = (b: EarningsBogey): Record<string, { consensus?: number; whisper?: number }> => {
    if (!b.segment_breakdown_json) return {};
    try { return JSON.parse(b.segment_breakdown_json); } catch { return {}; }
  };

  type Row = { label: string; cells: string[] };
  const rows: Row[] = [];
  const pushIfAny = (label: string, cells: string[]) => {
    if (cells.some((c) => c !== "—")) rows.push({ label, cells });
  };
  pushIfAny("EPS", shown.map((b) => cell(
    b.eps_consensus != null ? b.eps_consensus.toFixed(2) : null,
    b.eps_whisper != null ? b.eps_whisper.toFixed(2) : null)));
  pushIfAny("Revenue", shown.map((b) => cell(
    b.revenue_consensus_usd != null ? formatLargeUSD(b.revenue_consensus_usd) : null,
    b.revenue_whisper_usd != null ? formatLargeUSD(b.revenue_whisper_usd) : null)));
  pushIfAny("Expected move", shown.map((b) =>
    b.expected_move_pct != null ? `±${b.expected_move_pct.toFixed(1)}%` : "—"));

  const segNames = [...new Set(shown.flatMap((b) => Object.keys(segs(b))))];
  for (const name of segNames) {
    pushIfAny(`${name} (seg)`, shown.map((b) => {
      const v = segs(b)[name];
      return cell(
        v?.consensus != null ? formatLargeUSD(v.consensus) : null,
        v?.whisper != null ? formatLargeUSD(v.whisper) : null);
    }));
  }
  if (rows.length === 0) return "";

  const day = (b: EarningsBogey) => {
    const d = b.uploaded_at.slice(0, 10);
    return `${Number(d.slice(5, 7))}/${d.slice(8, 10)}`;
  };
  const header = `| Metric | ${shown.map((b) => `${b.source_label ?? b.source} (${day(b)})`).join(" | ")} |`;
  const sep = `|---|${shown.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${r.label} | ${r.cells.join(" | ")} |`).join("\n");
  const olderLine = older > 0 ? `\n\n*(+${older} older sheet${older > 1 ? "s" : ""} not shown)*` : "";
  return `## Sheet bogeys — by source\n\n${header}\n${sep}\n${body}${olderLine}`;
}
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Wire into `composeEarningsEmail`** — replace the markdown assembly (~lines 241-245):

```ts
  const sheetBogeysBlock = renderSheetBogeysBlock(getBogeysForEvent(db, event.id));
  const markdown = [headlineTable, pastPrintsBlock, sheetBogeysBlock, aiMarkdown]
    .filter(Boolean)
    .join("\n\n");
```

(`getBogeysForEvent` is already imported in this file for `buildPreviewContext` — verify; import if not.) Note the block renders in BOTH phases by design (recap shows actuals next to each source's bar).

- [ ] **Step 6: Add a wiring test** in the same test file: build a minimal in-memory DB the way `tests/digest/earnings-email-claims.test.ts` does (copy its schema-setup helper), insert one event + one bogey row, mock `callClaude`-adjacent seams as that file does, and assert the composed `markdown` contains `## Sheet bogeys` between the scoreboard and the AI output. If full compose mocking is disproportionate, instead assert order deterministically: unit-test a tiny extracted `assembleEmailMarkdown(parts)` helper — implementer's choice, but SOME test must pin block ORDER.

- [ ] **Step 7: Full-ish check** — `npx vitest run tests/digest` → green. Commit: `feat(earnings): deterministic per-source sheet-bogeys table in preview + recap emails`.

---

### Task 3: `lib/earnings/print-sheet.ts` — raw-table extractor + HTML composer

**Files:**
- Create: `lib/earnings/print-sheet.ts`
- Test: `tests/earnings/print-sheet.test.ts` (create)

**Interfaces:**
- Consumes: `briefingToHtml(markdown, title, footerNote?)` from `lib/calendar/briefing-html.ts`.
- Produces (Task 7 consumes):

```ts
export interface PrintSheetNote { date: string; noteType: string; symbol: string; content: string }
export interface PrintSheetInputs {
  symbol: string;            // upper-cased
  eventDate: string;         // YYYY-MM-DD
  eventTime: string | null;  // BMO/AMC
  scoreboardMd: string;      // renderHeadlineTable output
  sheetBogeysMd: string;     // renderSheetBogeysBlock output ("" ok)
  bogiesTableMd: string;     // verbatim from ai_output_md (heading + table)
  notes: PrintSheetNote[];   // complete content, newest first
  pastPrintsMd: string;      // "" ok
  sentAt: string;            // preview sent_at for the footer line
}
export function extractBogiesTableMarkdown(aiOutputMd: string): string | null
export function composePrintSheetHtml(inputs: PrintSheetInputs): string
export function composePrintSheetHtml(inputs: PrintSheetInputs, opts: { includePastPrints?: boolean }): string
```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { extractBogiesTableMarkdown, composePrintSheetHtml } from "@/lib/earnings/print-sheet";

const AI_MD = `## Line-by-line bogies

| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Revenue | $4.34B | — | — |
| Gross margin | 55% | — | — |

## The setup

Prose here.

## Sources

- ignored`;

describe("extractBogiesTableMarkdown", () => {
  it("returns heading + contiguous table lines verbatim", () => {
    const out = extractBogiesTableMarkdown(AI_MD)!;
    expect(out.startsWith("## Line-by-line bogies")).toBe(true);
    expect(out).toContain("| Revenue | $4.34B | — | — |");
    expect(out).not.toContain("The setup");
  });
  it("null when heading missing", () => {
    expect(extractBogiesTableMarkdown("## The setup\n\nProse.")).toBeNull();
  });
  it("null when no table before the next ## heading", () => {
    expect(extractBogiesTableMarkdown("## Line-by-line bogies\n\n## The setup\n\n| a | b |\n|---|---|")).toBeNull();
  });
});

function inputs(over: Partial<Parameters<typeof composePrintSheetHtml>[0]> = {}) {
  return {
    symbol: "APP", eventDate: "2026-08-06", eventTime: "AMC",
    scoreboardMd: "| Metric | Consensus | Actual | Δ |\n|---|---|---|---|\n| EPS | 4.30 | — | — |",
    sheetBogeysMd: "## Sheet bogeys — by source\n\n| Metric | TMTB (8/4) |\n|---|---|\n| EPS | 4.30 |",
    bogiesTableMd: extractBogiesTableMarkdown(AI_MD)!,
    notes: [{ date: "2026-08-01", noteType: "trade_thesis", symbol: "APP", content: "Long thesis ".repeat(300).trim() }],
    pastPrintsMd: "## Past prints\n\n| Reported | EPS act / est | Surprise | Next-day move |\n|---|---|---|---|\n| 2026-05-06 | 4.1 / 4.0 | +2.5% | +8% |",
    sentAt: "2026-08-06 14:02:00",
    ...over,
  };
}

describe("composePrintSheetHtml", () => {
  it("contains bogies table verbatim, complete notes, print CSS, section order", () => {
    const html = composePrintSheetHtml(inputs());
    expect(html).toContain("$4.34B");                    // bogies cell survived
    expect(html).toContain("Long thesis Long thesis");   // notes not truncated
    expect((html.match(/Long thesis/g) ?? []).length).toBeGreaterThanOrEqual(300);
    expect(html).toContain("@page");
    expect(html).toContain("break-inside");
    // order: scoreboard < sheet bogeys < bogies < notes < past prints
    const idx = (s: string) => html.indexOf(s);
    expect(idx("scoreboard")).toBeLessThan(idx("Sheet bogeys"));
    expect(idx("Sheet bogeys")).toBeLessThan(idx("Line-by-line bogies"));
    expect(idx("Line-by-line bogies")).toBeLessThan(idx("Your notes"));
    expect(idx("Your notes")).toBeLessThan(idx("Past prints"));
  });
  it("omits past prints when includePastPrints=false", () => {
    const html = composePrintSheetHtml(inputs(), { includePastPrints: false });
    expect(html).not.toContain("Past prints");
  });
  it("omits empty sheet-bogeys block cleanly", () => {
    const html = composePrintSheetHtml(inputs({ sheetBogeysMd: "" }));
    expect(html).not.toContain("Sheet bogeys");
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.** Extractor: find `BOGIES_HEADING = /^##\s+line.by.line/i` (same regex as `worksheet-rich.ts:67`); from the heading, collect the heading line + the FIRST contiguous run of `|`-prefixed lines; if the next `##` appears before any `|` line, return null. Return the raw lines joined verbatim (no re-parse, no re-wrap).

Composer: build the sheet markdown, render through `briefingToHtml`, then inject print CSS before `</body>`:

```ts
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
  ].filter(Boolean).join("\n\n");
  const title = `${inputs.symbol} earnings sheet — ${inputs.eventDate}${slot}`;
  const html = briefingToHtml(md, title, `from preview email sent ${inputs.sentAt} · fill-in sheet`);
  return html.replace("</body>", `${PRINT_CSS}\n</body>`);
}

const PRINT_CSS = `<style>
  @page { size: letter; margin: 12mm 14mm; }
  /* A table never splits across the sheet boundary; notes flow. */
  table { break-inside: avoid; page-break-inside: avoid; }
  h2 { break-after: avoid; page-break-after: avoid; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style>`;
```

(If `briefingToHtml`'s envelope constrains body width for email clients — a fixed `max-width` wrapper — ADD a print-CSS override widening it to the page: inspect the actual envelope at `lib/calendar/briefing-html.ts:75-127` and override the specific wrapper selector. Keep the email renderer itself untouched.)

- [ ] **Step 4: Run tests** → PASS. Also `npx vitest run tests/earnings` stays green.
- [ ] **Step 5: Commit** — `feat(earnings): print-sheet HTML composer + verbatim bogies-table extractor`.

---

### Task 4: `lib/earnings/print-pdf.ts` — Chrome render, page count, duplex lp

**Files:**
- Create: `lib/earnings/print-pdf.ts`
- Test: `tests/earnings/print-pdf.test.ts` (create)

**Interfaces:**
- Consumes: nothing project-internal (spawn + fs only).
- Produces (Task 7 consumes):

```ts
export function chromeBinaryPath(): string | null            // existence-checked default path
export function countPdfPages(pdf: Buffer): number           // parses /Type /Page objects
export function renderHtmlToPdf(html: string, opts?: {
  chromePath?: string; timeoutMs?: number;                   // default 30_000
}): Promise<Buffer>                                          // throws on any failure
export function printPdfViaLp(pdfPath: string, opts?: {
  printer?: string | null; title?: string;
}): Promise<void>                                            // duplex always requested
```

- [ ] **Step 1: Write failing tests** (pure parts + spawn-free behavior):

```ts
import { describe, it, expect } from "vitest";
import { countPdfPages, chromeBinaryPath, renderHtmlToPdf } from "@/lib/earnings/print-pdf";

describe("countPdfPages", () => {
  it("counts /Type /Page objects, not the /Pages root", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>\n%%EOF");
    expect(countPdfPages(pdf)).toBe(2);
  });
  it("returns 0 for garbage", () => {
    expect(countPdfPages(Buffer.from("not a pdf"))).toBe(0);
  });
});

describe("renderHtmlToPdf", () => {
  it("throws immediately when the chrome binary does not exist", async () => {
    await expect(
      renderHtmlToPdf("<html></html>", { chromePath: "/nonexistent/chrome" }),
    ).rejects.toThrow(/chrome/i);
  });
});

describe("chromeBinaryPath", () => {
  it("returns a string path or null, never throws", () => {
    const p = chromeBinaryPath();
    expect(p === null || typeof p === "string").toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Notes for the implementer:
  - `chromeBinaryPath()`: `existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")` → path or null.
  - `countPdfPages`: `pdf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0`.
  - `renderHtmlToPdf`: throw if `!existsSync(chromePath)` BEFORE spawning; write html to `mkdtempSync(join(tmpdir(), "vgs-print-"))/sheet.html`; spawn chrome with `["--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${dir}/profile`, "--no-pdf-header-footer", `--print-to-pdf=${dir}/sheet.pdf`, htmlPath]`; kill-timer at `timeoutMs` (default 30s) mirroring `printViaLp`'s settle pattern (`lib/earnings/worksheet.ts:315-354` — copy that promise/settle/timer shape); on exit 0, read the PDF; reject if missing or 0 bytes; `rmSync(dir, { recursive: true, force: true })` in a finally.
  - `printPdfViaLp`: same settle pattern as `printViaLp`, but the file is an ARG (no stdin): `spawn("lp", [...(printer ? ["-d", printer] : []), ...(title ? ["-t", title] : []), "-o", "sides=two-sided-long-edge", pdfPath])`, 20s timer, resolve on exit 0.
  - During implementation, run `lpoptions -p "$(lpstat -d | sed 's/.*: //')" -l | grep -i duplex` once and record in the commit message whether the default printer advertises duplex (informational — the option is harmless either way).

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: One real smoke (manual, not a vitest test):** `npx tsx -e` a tiny script that renders `<h1>hi</h1>` via `renderHtmlToPdf` and prints byte length + `countPdfPages` (expect 1). Do NOT send to `lp`. Paste the output in the commit message.
- [ ] **Step 6: Commit** — `feat(earnings): headless-Chrome PDF renderer + duplex lp road (DI-shaped)`.

---

### Task 5: Prompt updates — attribution + prose rules

**Files:**
- Modify: `lib/digest/send-earnings-email.ts` — `renderPreviewPrompt` (~1438-1510) and `renderRecapPrompt` (~1512-1612)
- Test: `tests/digest/earnings-prompt-prose-rules.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's catalog (append its `prompt`-classified rules verbatim).
- Produces: prompt text containing the pinned phrases below (tests grep the rendered prompt string — same pattern as `tests/digest/earnings-prompt-no-dollar-leak.test.ts`).

- [ ] **Step 1: Write failing tests** — build a minimal `PreviewContext` the way `earnings-prompt-no-dollar-leak.test.ts` does (copy its context fixture helper), then:

```ts
const prompt = renderPreviewPrompt(ctx);
// attribution rules
expect(prompt).toContain("Sheet bogeys — by source");        // system-rendered notice references the block
expect(prompt).toMatch(/cite the source label in-cell/i);
expect(prompt).toMatch(/never (silently )?merge/i);
// prose rules
expect(prompt).toMatch(/1[-–]3 flowing paragraphs/i);
expect(prompt).toMatch(/bullets only/i);
expect(prompt).toMatch(/no filler openers/i);
// recap carries the attribution rule too
expect(renderRecapPrompt(recapCtx)).toMatch(/cite the source label/i);
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `renderPreviewPrompt`'s output-structure block (after the bogies-table instruction at ~1495) add:

```
**Sheet-bogey attribution:** a deterministic "## Sheet bogeys — by source" table is rendered by the system between Past prints and your output — do NOT re-list its rows. In YOUR line-by-line table, when a row's Consensus / Prior number comes from a user-uploaded sheet, cite the source label in-cell — `4.42 (TMTB w)` — and when sources disagree on a metric, show both and never merge or average them: `$4.34B TMTB / $4.40B FundaAI`.
```

Replace the four section instructions' style guidance (Setup/Bull-bear/Watch/Position, ~1497-1503) with the same content PLUS a shared style rule appended after item 5:

```
**Section style (strict):** each prose section is 1-3 flowing paragraphs that read as one analyst's narrative — sections build on one another, never restart the story. Bullets ONLY for genuinely enumerable items (max 4 bullets, never a bulleted wall). No orphan bold-line fragments standing in for sentences. No filler openers ("Investors will be watching…", "It remains to be seen…") — start every section with a substantive claim.
```

Append any `prompt`-classified rules from Task 1's catalog verbatim. Mirror ONLY the attribution rule into `renderRecapPrompt` (its line-by-line guidance ~1593); recap prose structure is out of scope.

- [ ] **Step 4: Run tests** → PASS; run `npx vitest run tests/digest` → green (the no-dollar-leak pin must still pass).
- [ ] **Step 5: Commit** — `feat(earnings): prompt rules — per-source bogey attribution + section prose style`.

---

### Task 6: Notes un-chop on the monospace fallback road

**Files:**
- Modify: `lib/earnings/worksheet.ts:256-258` (`loadRichWorksheetInputs` note lines), `lib/earnings/worksheet-rich.ts:267-271` (NOTES section render)
- Test: extend `tests/earnings/worksheet-rich.test.ts`

**Interfaces:**
- Consumes: existing `RichWorksheetInputs.noteLines: string[]`.
- Produces: `RichWorksheetInputs.noteLines` now carries FULL note content (one entry per note, whitespace-collapsed, NOT sliced); `composeRichWorksheet` wraps each note across lines via the existing `wrapText` (exported from `worksheet-rich.ts`) at width 78 with the `  · ` prefix on the first line and 4-space hanging indent.

- [ ] **Step 1: Write failing test** in `tests/earnings/worksheet-rich.test.ts`:

```ts
it("renders full note text wrapped, never the 74-char chop", () => {
  const longNote = "thesis ".repeat(60).trim(); // ~420 chars
  const text = composeRichWorksheet(baseInputs({ noteLines: [longNote] }));
  const flat = text.replace(/\n\s*/g, " ");
  expect(flat).toContain("thesis thesis thesis thesis thesis thesis thesis thesis thesis thesis");
  const count = (text.match(/thesis/g) ?? []).length;
  expect(count).toBe(60);           // every word survived
});
```

(Reuse the file's existing inputs-builder helper; add `noteLines` override support if it lacks one.)

- [ ] **Step 2: Run to verify failure** (current code slices to 80 cols per note line).
- [ ] **Step 3: Implement.** In `loadRichWorksheetInputs`: drop `.slice(0, 4)` and `.slice(0, 74)` — keep whitespace collapse. In `composeRichWorksheet`'s notes block: for each note, `wrapText(note, 74)` and emit first line as `  · ${line}`, continuation lines as `    ${line}`; notes stay inside the existing page budget (they count against it as today — over-budget still ends at the 3-page hard cap, which is the fallback road's documented ceiling and acceptable for a degraded road).
- [ ] **Step 4: Run** `npx vitest run tests/earnings/worksheet-rich.test.ts tests/earnings/worksheet.test.ts` → green.
- [ ] **Step 5: Commit** — `fix(earnings): monospace worksheet renders full note text — 4x74 silent chop retired`.

---

### Task 7: Wire the PDF road into `printWorksheetNow`

**Files:**
- Modify: `lib/earnings/worksheet.ts` — new `loadPrintSheetInputs`, rework `printWorksheetNow`
- Test: extend `tests/earnings/worksheet.test.ts`

**Interfaces:**
- Consumes: `composePrintSheetHtml` + `extractBogiesTableMarkdown` (Task 3), `renderHtmlToPdf` + `countPdfPages` + `printPdfViaLp` + `chromeBinaryPath` (Task 4), `renderSheetBogeysBlock` + `renderHeadlineTable` + `renderPastPrintsBlock` + `loadIntelView` (already imported in this file), `getBogeysForEvent`, `getNotesForFamily`, `getEmailAudit`.
- Produces:

```ts
export function loadPrintSheetInputs(db, eventId): PrintSheetInputs | null
export async function printWorksheetNow(db, eventId, seams?: {
  renderPdf?: typeof renderHtmlToPdf;
  printPdf?: typeof printPdfViaLp;
  printText?: typeof printViaLp;
}): Promise<{ symbol: string; road: "pdf" | "monospace" }>
```

`printArmedWorksheets` is UNCHANGED (it calls `printWorksheetNow` through its existing `print` seam; its `loadRichWorksheetInputs` wait-gate stays — same audit-prose nullness the PDF road needs).

- [ ] **Step 1: Write failing tests** in `tests/earnings/worksheet.test.ts` (reuse its DB fixture helpers):

```ts
it("printWorksheetNow takes the PDF road when preview + chrome available", async () => {
  // seed event + preview audit row with ai_output_md containing a bogies table (fixture exists in this file's rich-road tests)
  const calls: string[] = [];
  const res = await printWorksheetNow(db, eventId, {
    renderPdf: async () => Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >>\n%%EOF"),
    printPdf: async () => { calls.push("pdf"); },
    printText: async () => { calls.push("text"); },
  });
  expect(res.road).toBe("pdf");
  expect(calls).toEqual(["pdf"]);
});

it("falls back to monospace when the PDF render throws", async () => {
  const calls: string[] = [];
  const res = await printWorksheetNow(db, eventId, {
    renderPdf: async () => { throw new Error("chrome missing"); },
    printPdf: async () => { calls.push("pdf"); },
    printText: async () => { calls.push("text"); },
  });
  expect(res.road).toBe("monospace");
  expect(calls).toEqual(["text"]);
});

it("re-renders without past prints when the PDF exceeds 2 pages, then prints", async () => {
  const seen: string[] = [];
  const threePager = Buffer.from("%PDF\n<</Type /Page>><</Type /Page>><</Type /Page>>");
  const onePager = Buffer.from("%PDF\n<</Type /Page>>");
  let call = 0;
  const res = await printWorksheetNow(db, eventId, {
    renderPdf: async (html) => { seen.push(html); return call++ === 0 ? threePager : onePager; },
    printPdf: async () => {},
    printText: async () => {},
  });
  expect(res.road).toBe("pdf");
  expect(seen).toHaveLength(2);
  expect(seen[0]).toContain("Past prints");
  expect(seen[1]).not.toContain("Past prints");
});

it("still prints when notes alone exceed 2 pages (notes never truncate)", async () => {
  // both renders return a 3-page PDF; expect printPdf still called once after the retry
});

it("uses the deterministic monospace road when no local preview exists (unchanged)", async () => {
  // event without an earnings_emails preview row → road "monospace", printText called
});
```

- [ ] **Step 2: Run to verify failure** (seams param doesn't exist yet).

- [ ] **Step 3: Implement.**

```ts
export function loadPrintSheetInputs(db: Database.Database, eventId: number): PrintSheetInputs | null {
  const event = db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(eventId) as CalendarEvent | undefined;
  if (!event?.symbol) return null;
  const audit = getEmailAudit(db, eventId, "preview");
  if (!audit?.ai_output_md) return null;
  const bogiesTableMd = extractBogiesTableMarkdown(audit.ai_output_md);
  if (!bogiesTableMd) return null;               // no verbatim table → PDF road unavailable
  const symbol = event.symbol.toUpperCase();
  const intelView = loadIntelView(db, eventId, symbol);
  const notes = getNotesForFamily(db, [...issuerSiblings(event.symbol)]).map((n) => ({
    date: n.event_date ?? n.created_at.slice(0, 10),   // match renderUserNotesBlock's date choice (send-earnings-email.ts:1783-1795)
    noteType: n.note_type,
    symbol: n.symbol,
    content: n.content,
  }));
  return {
    symbol,
    eventDate: event.event_date,
    eventTime: event.event_time,
    scoreboardMd: renderHeadlineTable(event, symbol, "preview", intelView),
    sheetBogeysMd: renderSheetBogeysBlock(getBogeysForEvent(db, eventId)),
    bogiesTableMd,
    notes,
    pastPrintsMd: renderPastPrintsBlock(intelView.history),
    sentAt: audit.sent_at,
  };
}
```

(Adjust the note field names to the actual `Note` row type in `lib/queries/notes.ts` — mirror exactly what `renderUserNotesBlock` reads.)

`printWorksheetNow` rework:

```ts
export async function printWorksheetNow(
  db: Database.Database,
  eventId: number,
  seams: {
    renderPdf?: typeof renderHtmlToPdf;
    printPdf?: typeof printPdfViaLp;
    printText?: typeof printViaLp;
  } = {},
): Promise<{ symbol: string; road: "pdf" | "monospace" }> {
  const renderPdf = seams.renderPdf ?? renderHtmlToPdf;
  const printPdf = seams.printPdf ?? printPdfViaLp;
  const printText = seams.printText ?? printViaLp;

  const sheet = loadPrintSheetInputs(db, eventId);
  if (sheet && (seams.renderPdf || chromeBinaryPath())) {
    try {
      let html = composePrintSheetHtml(sheet);
      let pdf = await renderPdf(html);
      if (countPdfPages(pdf) > 2) {
        // One-sheet rule: drop Past prints and try once more. If notes alone
        // still exceed the back, print anyway — notes never truncate.
        html = composePrintSheetHtml(sheet, { includePastPrints: false });
        pdf = await renderPdf(html);
      }
      const dir = mkdtempSync(join(tmpdir(), "vgs-sheet-"));
      const pdfPath = join(dir, `${sheet.symbol}-sheet.pdf`);
      try {
        writeFileSync(pdfPath, pdf);
        await printPdf(pdfPath, { printer: printerName(db), title: `${sheet.symbol} earnings sheet` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return { symbol: sheet.symbol, road: "pdf" };
    } catch (err) {
      console.warn(`[worksheet] PDF road failed for ${sheet.symbol} — falling back to monospace:`, err);
    }
  }

  const composed = composeWorksheetForEvent(db, eventId);
  if (!composed) throw new Error(`Event ${eventId} not found or symbol-less.`);
  await printText(composed.text, { printer: printerName(db), title: `${composed.symbol} earnings worksheet` });
  return { symbol: composed.symbol, road: "monospace" };
}
```

Note the guard `(seams.renderPdf || chromeBinaryPath())`: tests inject the seam; production requires the real binary. The API route's response shape (`app/api/earnings/worksheet/route.ts:51` print action) gains nothing mandatory — but include `road` in the JSON response and update the BogeysEditModal toast copy to say which road printed ("sent to printer queue (email-fidelity sheet)" vs "(plain text sheet)") per the honest-button-feedback convention. Grep the modal for the existing success string.

- [ ] **Step 4: Run tests** → PASS. Full `npx vitest run tests/earnings tests/digest` → green.
- [ ] **Step 5: Commit** — `feat(earnings): email-identical PDF print road with monospace fallback + duplex one-sheet rule`.

---

### Task 8: Full verification + live sample PDF for user approval

**Files:** none new (verification only; small fixes allowed).

- [ ] **Step 1:** `npx vitest run` — full suite green (report count vs the 4,373 baseline). `npx next build` compiles (or `npx tsc --noEmit` if the build's DB-open constraint bites — see CLAUDE.md Known issues).
- [ ] **Step 2: Live sample (read-only DB):** small `npx tsx` script: pick the most recent event with a preview audit row (`SELECT event_id FROM earnings_emails WHERE phase='preview' AND ai_output_md IS NOT NULL ORDER BY sent_at DESC LIMIT 1`), call `loadPrintSheetInputs` + `composePrintSheetHtml` + `renderHtmlToPdf`, write `$CLAUDE_JOB_DIR/tmp/sample-sheet.pdf` and report `countPdfPages`. Do NOT call lp.
- [ ] **Step 3:** Send the PDF to the user (SendUserFile) for visual approval — this is the user's fidelity gate before any real paper.
- [ ] **Step 4:** Reconcile `docs/plans/TODO.md`: mark items (a)–(c) of the 2026-08-06 earnings-workflow entry shipped (leave (d) open), note the deferred-minors list is now fallback-only. Commit docs.

## Self-review (done at planning time)

- Spec coverage: §1 print pipeline → Tasks 3/4/7; §2 sheet bogeys → Task 2; §3 prompts → Task 5; §4 diagnosis → Task 1; fallback notes → Task 6; error table → Tasks 4/7 tests; testing list → mapped 1:1. No gaps.
- Types: `PrintSheetInputs` defined in Task 3, consumed by Task 7 verbatim; `renderSheetBogeysBlock(bogeys: EarningsBogey[])` consistent across Tasks 2/7; seams typed `typeof` the Task-4 exports.
- Known soft spots flagged inline for implementers: note-row field names (Task 7 mirrors `renderUserNotesBlock`), `briefingToHtml` body-width override (Task 3), `getBogeysForEvent` import presence (Task 2).
