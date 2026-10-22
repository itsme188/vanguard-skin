/**
 * Source pins for the filing-summary browser-pass fixes (2026-10-22). The repo
 * has no DOM harness, so focus and the compact select are pinned in source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { rerunPrompt, retryPrompt } from "@/app/dashboard/print/[eventId]/filings/page-text";
import type { ChoiceOption, FullRun } from "@/lib/filing-summary/view";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const dialog = readFileSync("app/dashboard/components/ConfirmDialog.tsx", "utf8");
const promptHook = readFileSync("app/dashboard/components/useConfirmPrompt.tsx", "utf8");
const panel = readFileSync("app/dashboard/today/FilingSummaryPanel.tsx", "utf8");
const choice = readFileSync("app/dashboard/today/FilingSummaryChoice.tsx", "utf8");
const fullView = readFileSync("app/dashboard/print/[eventId]/filings/FilingSummaryView.tsx", "utf8");

describe("paid confirmations focus Cancel (Run summary, Retry, Re-run)", () => {
  it("ConfirmDialog takes an initialFocus option whose default keeps the confirm button focused", () => {
    expect(dialog).toContain('initialFocus = "confirm"');
    expect(dialog).toContain("ref={cancelRef}");
    expect(dialog).toContain('(initialFocus === "cancel" ? cancelRef : confirmRef).current?.focus()');
    expect(promptHook).toContain("initialFocus={request.initialFocus}");
  });

  it("the panel's Run summary and Retry questions ask with Cancel focused", () => {
    for (const label of ['confirmLabel: "Run summary"', 'confirmLabel: "Retry"']) {
      const at = anchorIndex(panel, label);
      const call = panel.slice(panel.lastIndexOf("prompt.ask(", at), panel.indexOf("});", at));
      expect(call, label).toContain('initialFocus: "cancel"');
    }
  });

  it("the full page's Re-run and Retry questions ask with Cancel focused", () => {
    const opt: ChoiceOption = {
      choice: { family: "opus", effort: "high" }, value: "opus·high", label: "Opus · high", nowLabel: "Opus · now 5.5",
    };
    expect(rerunPrompt(opt, 1).initialFocus).toBe("cancel");
    const run = { runNo: 1, family: "opus", effort: "high", modelLabel: "Opus 5.5", sections: [] } as unknown as FullRun;
    expect(retryPrompt(run).initialFocus).toBe("cancel");
    expect(fullView).toContain("prompt.ask(rerunPrompt(");
    expect(fullView).toContain("prompt.ask(retryPrompt(");
  });
});

describe("the compact model select on Today", () => {
  it("shows the choice label only; the options and the title keep the now-label", () => {
    expect(choice).toContain('<span aria-hidden="true">{choiceLabel(state.current)}</span>');
    // The options still carry "— now 5.5".
    const select = choice.slice(anchorIndex(choice, "<select"), anchorIndex(choice, "</select>"));
    expect(select).toContain("{optionText(o)}");
    expect(select).toContain("title={selectTitle}");
    expect(select).toContain("opacity-0");
    expect(choice).toMatch(/const currentText = currentOption \? optionText\(currentOption\)/);
    // The visible label never shrinks or truncates (the clipping at 1600 px with the rail open).
    expect(choice).toContain("relative inline-flex shrink-0 items-center whitespace-nowrap");
  });

  it("is disabled for an earlier day's print with no summary", () => {
    expect(choice).toContain("past: v.pastWithoutSummary");
    expect(choice).toContain("const disabled = state.locked || state.past || saving;");
    expect(choice).toContain("disabled={disabled}");
  });
});

describe("the full page's footnote line", () => {
  it("puts a space before open on sec.gov", () => {
    const at = anchorIndex(fullView, "open on sec.gov");
    const before = fullView.slice(fullView.lastIndexOf("{f.url && (", at) - 40, at);
    expect(before).toContain('{f.url && " "}');
  });
});
