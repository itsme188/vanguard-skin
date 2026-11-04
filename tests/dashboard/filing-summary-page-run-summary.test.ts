/**
 * The full filing page offers Run summary itself (owner ruling 2026-11-01,
 * option 1): a print that was never read gets the button on the page, gated
 * on `view.runSummaryAvailable`, and it posts the same action the Today
 * panel posts. The question it asks comes from the one copy in labels.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import {
  NO_SUMMARY_YET_TEXT,
  RUN_SUMMARY_DETAIL_ACTION,
  RUN_SUMMARY_LABEL,
  runSummaryPrompt,
} from "@/lib/filing-summary/labels";
import { MANUAL_ONLY_DETAIL } from "@/lib/filing-summary/poller";
import { runConfirmMessage } from "@/app/dashboard/today/filing-summary-text";

const PAGE = readFileSync("app/dashboard/print/[eventId]/filings/FilingSummaryView.tsx", "utf8");
const PANEL = readFileSync("app/dashboard/today/FilingSummaryPanel.tsx", "utf8");
const POLLER = readFileSync("lib/filing-summary/poller.ts", "utf8");

/** The body of `async function <name>(` up to the next top-level `async function` or `const title`. */
function fnBody(src: string, name: string): string {
  const start = anchorIndex(src, `async function ${name}(`, 0, name);
  const next = src.indexOf("\n  async function ", start + 10);
  const end = next === -1 ? anchorIndex(src, "\n  const title", start, "end") : next;
  return src.slice(start, end);
}

describe("full filing page: Run summary for a print never read", () => {
  it("the old pointer to Today is gone", () => {
    expect(PAGE).not.toContain("Use Run summary on Today");
    expect(PAGE).toContain("NO_SUMMARY_YET_TEXT");
  });

  it("renders a Run summary button gated on view.runSummaryAvailable", () => {
    const gate = anchorIndex(PAGE, "view.runSummaryAvailable &&", 0, "gate");
    const button = anchorIndex(PAGE, "onClick={runSummary}", gate, "button");
    expect(button - gate).toBeLessThan(2000);
    const label = anchorIndex(PAGE, "RUN_SUMMARY_LABEL", button, "label");
    expect(label - button).toBeLessThan(400);
  });

  it("offers the model choice before the first run", () => {
    const gate = anchorIndex(PAGE, "view.runSummaryAvailable &&", 0, "gate");
    const select = anchorIndex(PAGE, 'id="run-choice"', gate, "select");
    expect(select - gate).toBeLessThan(1500);
  });

  it("posts the same action the Today panel posts, with the picked choice and a fresh key", () => {
    const panelRun = fnBody(PANEL, "onRun");
    expect(panelRun).toContain('action: "run"');
    const body = fnBody(PAGE, "runSummary");
    expect(body).toContain('action: "run"');
    expect(body).toContain("option.choice.family");
    expect(body).toContain("option.choice.effort");
    expect(body).toContain("newRequestKey()");
    expect(body).toContain("readMutationResult");
    expect(body).toContain("networkFailureMessage(");
    expect(body).toContain("router.refresh()");
    expect(body).toMatch(/if \(!\(await prompt\.ask\(runSummaryPrompt\(/);
    expect(body).toContain("RUN_SUMMARY_STARTED_PAGE_TEXT");
  });

  it("both surfaces ask the one question from labels.ts", () => {
    expect(fnBody(PANEL, "onRun")).toContain("runSummaryPrompt(");
    expect(PANEL).not.toContain('"Run the filing summary?"');
    const p = runSummaryPrompt("Opus · high", { family: "opus", effort: "high" }, "Opus · now 5.5");
    expect(p.title).toBe("Run the filing summary?");
    expect(p.confirmLabel).toBe(RUN_SUMMARY_LABEL);
    expect(p.initialFocus).toBe("cancel");
    expect(p.message).toBe(runConfirmMessage({ family: "opus", effort: "high" }, "Opus · now 5.5"));
    expect(NO_SUMMARY_YET_TEXT).toBe("No summary has run for this print yet.");
  });
});

describe("poll detail lines end in a whole sentence", () => {
  it("the Run summary detail says what to press and what it does", () => {
    expect(RUN_SUMMARY_DETAIL_ACTION).toBe("press Run summary to read the filings now");
    expect(MANUAL_ONLY_DETAIL).toBe(`armed after 9 pm — ${RUN_SUMMARY_DETAIL_ACTION}`);
    expect(POLLER).not.toContain("Run summary to spend");
  });
});
