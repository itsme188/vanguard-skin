/**
 * Source pins and static renders for the print-row filing summary panel and
 * the per-print model choice (Task 13). The repo has no DOM harness, so the
 * interactive parts are pinned in the source and the presentational body is
 * rendered with react-dom/server.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilingSummaryPanelBody } from "@/app/dashboard/today/FilingSummaryPanel";
import type { PanelView, RunSummary, ViewClaim } from "@/lib/filing-summary/view";
import type { StatusCounts } from "@/lib/filing-summary/types";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const row = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
const panel = readFileSync("app/dashboard/today/FilingSummaryPanel.tsx", "utf8");
const choice = readFileSync("app/dashboard/today/FilingSummaryChoice.tsx", "utf8");
const text = readFileSync("app/dashboard/today/filing-summary-text.ts", "utf8");
const chips = readFileSync("app/dashboard/today/EarningsRowChips.tsx", "utf8");
const models = readFileSync("app/dashboard/components/AiModelsSection.tsx", "utf8");

describe("where the panel and the choice mount", () => {
  it("the live row renders the panel after the first-pass read", () => {
    const first = anchorIndex(row, "<FirstPassRead");
    const after = anchorIndex(row, "<FilingSummaryPanel", first);
    expect(after).toBeGreaterThan(first);
  });

  it("the read-only record renders the panel read-only, above its table", () => {
    const view = row.slice(anchorIndex(row, "export function PrintRecordView"));
    const mounts = view.match(/<FilingSummaryPanel\b[^>]*\/>/g) ?? [];
    // One for a record with a print, one for a record without one.
    expect(mounts).toHaveLength(2);
    for (const m of mounts) expect(m).toMatch(/\breadOnly\b/);
    const withPrint = anchorIndex(view, "<FilingSummaryPanel", anchorIndex(view, "Read-only record."));
    expect(withPrint).toBeLessThan(anchorIndex(view, "<ScrollFade"));
  });

  it("the armed row shows the choice beside the worksheet chip, only when armed", () => {
    const at = anchorIndex(chips, "<FilingSummaryChoice");
    const before = chips.slice(Math.max(0, at - 200), at);
    expect(before).toMatch(/worksheetArmed/);
    expect(at).toBeGreaterThan(anchorIndex(chips, "onClick={toggleWorksheet}"));
  });

  it("Settings says the summary model is set per print and offers no override for it", () => {
    expect(models).toContain("Set per print in the Earnings Hub");
    expect(models).toContain("printFilingSummary");
  });
});

describe("UI rules in the new files", () => {
  it("the panel reads mutations through the shared reader and asks through the app dialog", () => {
    expect(panel).toContain("readMutationResult");
    expect(panel).toContain("networkFailureMessage");
    expect(panel).toContain("useConfirmPrompt");
    expect(panel).toContain("prompt.dialog");
    for (const src of [panel, choice]) {
      expect(src).not.toMatch(/(^|[^\w.])confirm\(/m);
      expect(src).not.toMatch(/window\.(confirm|alert|prompt)\(/);
    }
  });

  it("the choice is a native select with no caret glyph", () => {
    expect(choice).toContain("<select");
    expect(choice).toContain("readMutationResult");
    for (const caret of ["▾", "▼", "⌄"]) {
      expect(choice).not.toContain(caret);
      expect(panel).not.toContain(caret);
    }
  });

  it("client files import nothing from the server side of lib/filing-summary", () => {
    for (const src of [panel, choice, text]) {
      const imports = src.match(/^import[^;]*from "@\/lib\/filing-summary\/[^"]+";/gm) ?? [];
      for (const line of imports) {
        if (/^import type /.test(line)) continue;
        expect(line).toMatch(/"@\/lib\/filing-summary\/(choice|types)"/);
      }
    }
  });

  it("the panel never renders through the privacy mask (public filing text)", () => {
    expect(panel).not.toContain("<PrivateText");
    expect(panel).not.toContain("<Money");
  });

  it("polls every 30 s through a ref, never a callback that changes each render", () => {
    expect(text).toContain("FILING_SUMMARY_POLL_MS = 30_000");
    expect(panel).toContain("setTimeout(tick, FILING_SUMMARY_POLL_MS)");
    expect(panel).toContain("needsPolling(");
    // The loop decides on the last view through a ref; its effect depends on
    // the event and the reload nonce only.
    expect(panel).toContain("viewRef.current");
    expect(panel).toContain("}, [eventId, reloadNonce]);");
  });

  it("Run and Retry carry a fresh request key held in a ref", () => {
    expect(panel).toContain("newRequestKey()");
    expect(panel).toMatch(/requestKeyRef/);
  });
});

// ---------------------------------------------------------------- renders

const ZERO: StatusCounts = { claims: 0, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0 };

function claim(id: string, o: Partial<ViewClaim> = {}): ViewClaim {
  return {
    claimId: id,
    renderedText: `Claim ${id} text`,
    status: "checked",
    top: true,
    routine: false,
    footnotes: [
      {
        citationId: `${id}-c1`,
        document: "ex99.htm",
        status: "found",
        page: 1,
        para: 3,
        sentence: "Revenue was $1.2 billion.",
        url: `https://www.sec.gov/Archives/edgar/data/1/000000000126000001/ex99.htm#:~:text=${id}`,
      },
    ],
    figureChecks: [],
    comparisonChecks: [],
    reasons: [],
    correction: null,
    correctedBy: null,
    ...o,
  };
}

function run(o: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 7,
    runNo: 1,
    status: "done",
    trigger: "auto",
    modelLabel: "Opus 5.5",
    effort: "high",
    fallbackNote: null,
    counts: { ...ZERO, claims: 3, checked: 2, contradicted: 1 },
    incomplete: false,
    top: [
      claim("a", { status: "contradicted" }),
      claim("b", {
        footnotes: [
          {
            citationId: "b-c1",
            document: "ex99.htm",
            status: "not_found",
            page: null,
            para: null,
            sentence: null,
            url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/ex99.htm",
          },
        ],
        status: "quote_not_found",
      }),
      claim("c"),
    ],
    sectionStates: [{ form: "8-K", acceptedAtEt: "4:05 pm", status: "done", errorClass: null }],
    excludesAfterEt: null,
    ...o,
  };
}

function view(o: Partial<PanelView> = {}): PanelView {
  return {
    eventId: 42,
    choice: { family: "opus", effort: "high" },
    choiceLabel: "Opus · high",
    isDefault: true,
    locked: true,
    nowLabel: "Opus · now 5.5",
    pollState: "found",
    pollDetail: null,
    shown: run(),
    inProgress: null,
    runSummaryAvailable: false,
    ...o,
  };
}

const render = (props: Partial<Parameters<typeof FilingSummaryPanelBody>[0]> & { view: PanelView }) =>
  renderToStaticMarkup(
    createElement(FilingSummaryPanelBody, {
      reading: null,
      readOnly: false,
      busy: null,
      error: null,
      note: null,
      onRun: () => undefined,
      onRetry: () => undefined,
      ...props,
    }),
  );

describe("FilingSummaryPanelBody", () => {
  it("shows the status, counts, Top 3 with chips and sec.gov footnotes, and the full-summary link", () => {
    const html = render({ view: view() });
    expect(html).toContain("Summary ready · Opus 5.5 high");
    expect(html).toContain("3 claims · 2 checked · 1 contradicted");
    expect(html).toContain("Contradicted");
    expect(html).toContain("Quote not found");
    expect(html).toContain("Checked");
    expect(html).toContain("Claim a text");
    expect(html).toContain('href="https://www.sec.gov/Archives/edgar/data/1/000000000126000001/ex99.htm#:~:text=a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("[1]");
    expect(html).toContain('href="/dashboard/print/42/filings"');
    expect(html).toContain("Open full summary");
    expect(html).toContain("[overflow-wrap:anywhere]");
  });

  it("calls out a contradicted Top 3 claim at the top", () => {
    const html = render({ view: view() });
    const callout = html.indexOf("contradicted by the filing");
    expect(callout).toBeGreaterThan(-1);
    expect(callout).toBeLessThan(html.indexOf("Claim a text"));
  });

  it("a footnote whose quote was not found is marked and explained", () => {
    const html = render({ view: view() });
    expect(html).toMatch(/title="[^"]*not found[^"]*"/i);
  });

  it("the fallback note shows in the model line", () => {
    const html = render({
      view: view({ shown: run({ fallbackNote: "Fable unavailable — Opus 5.5 ran instead" }) }),
    });
    expect(html).toContain("Fable unavailable — Opus 5.5 ran instead");
  });

  it("offers Run summary when money waits on a click, never when read-only", () => {
    const v = view({ shown: null, pollState: "manual_only", runSummaryAvailable: true, locked: false });
    expect(render({ view: v })).toContain("Run summary");
    expect(render({ view: v, readOnly: true })).not.toMatch(/<button/);
  });

  it("offers Retry on a failed run, never when read-only", () => {
    const failed = run({
      status: "failed",
      top: [],
      counts: ZERO,
      sectionStates: [{ form: "8-K", acceptedAtEt: "4:05 pm", status: "failed", errorClass: "timeout" }],
    });
    const html = render({ view: view({ shown: failed }) });
    expect(html).toContain("Summary failed — the model call timed out");
    expect(html).toContain("Retry");
    expect(render({ view: view({ shown: failed }), readOnly: true })).not.toMatch(/<button/);
  });

  it("a failed or running run never presents its claims as a finished summary", () => {
    const html = render({
      view: view({
        shown: run({
          status: "running",
          sectionStates: [
            { form: "8-K", acceptedAtEt: "4:05 pm", status: "done", errorClass: null },
            { form: "10-Q", acceptedAtEt: "5:10 pm", status: "running", errorClass: null },
          ],
        }),
      }),
    });
    expect(html).toMatch(/10-Q · 5:10 pm: being read/);
  });
});
