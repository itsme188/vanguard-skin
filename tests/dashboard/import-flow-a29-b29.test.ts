/**
 * Import flow QA units A29 + B29 (2026-10-07). UI only: nothing under
 * lib/import or app/api/import changes, and the two requests the component
 * sends keep their URL, mode and body.
 *
 * - A29: "Try Again" re-posts the same files for the step that failed
 *   (ruled 2026-09-14); "Start over" is the control that clears the selection.
 * - B29: privacy mode masks the figures inside a warning, not the sentence;
 *   the excluded-row count is distinct rows, not failed checks; a card with
 *   nothing to import says so and the button reads "Import 2 of 4 files".
 * - The post-import trade review prompt counts round trips.
 *
 * No DOM harness in this repo: the behaviour lives in pure functions exported
 * from the component, and the wiring is source-pinned.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import {
  retryTransition,
  startOverTransition,
  maskFigureSegments,
  countExcludedRows,
  groupExcludedRows,
  isImportablePreview,
  importButtonLabel,
  sumReviewableRoundTrips,
  type ImportState,
} from "@/app/dashboard/components/ImportFlow";

const source = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ImportFlow.tsx"),
  "utf8",
);

describe("A29: Try Again re-posts the same files", () => {
  const previewError: ImportState = { status: "error", message: "bad pdf", phase: "preview" };
  const commitError: ImportState = { status: "error", message: "db locked", phase: "commit" };

  it("a failed preview goes back to parsing, re-requests the preview and keeps the files", () => {
    expect(retryTransition(previewError, 2)).toEqual({
      next: { status: "parsing" },
      request: "preview",
      clearFiles: false,
    });
  });

  it("a failed commit goes back to importing, re-requests the commit and keeps the files", () => {
    expect(retryTransition(commitError, 3)).toEqual({
      next: { status: "importing" },
      request: "commit",
      clearFiles: false,
    });
  });

  it("with no files left to re-post it returns to the empty drop zone and sends nothing", () => {
    expect(retryTransition(previewError, 0)).toEqual({
      next: { status: "idle" },
      request: null,
      clearFiles: true,
    });
    expect(retryTransition(commitError, 0).request).toBeNull();
  });

  it("is a no-op outside the error state", () => {
    const states: ImportState[] = [
      { status: "idle" },
      { status: "parsing" },
      { status: "preview", results: [] },
      { status: "importing" },
      { status: "done", results: [] },
    ];
    for (const s of states) {
      const t = retryTransition(s, 2);
      expect(t.next).toBe(s);
      expect(t.request).toBeNull();
      expect(t.clearFiles).toBe(false);
    }
  });

  it("Start over is the transition that clears the selection", () => {
    expect(startOverTransition()).toEqual({
      next: { status: "idle" },
      request: null,
      clearFiles: true,
    });
  });

  it("the error panel wires Try Again to the retry and offers Start over separately", () => {
    const panel = source.slice(anchorIndex(source, "// Error\n"));
    expect(panel).toMatch(/onClick=\{handleRetry\}[\s\S]*?Try Again/);
    expect(panel).toMatch(/onClick=\{reset\}[\s\S]*?Start over/);
    // Try Again must not be the reset handler any more.
    expect(panel).not.toMatch(/onClick=\{reset\}[^<]*>\s*Try Again/);
  });

  it("the retry sends the same two requests the first attempt sends", () => {
    // One call site per mode: the retry reuses the same functions.
    expect(source.split('apiFetch("/api/import?mode=preview"').length - 1).toBe(1);
    expect(source.split('apiFetch("/api/import?mode=commit"').length - 1).toBe(1);
    const retry = sliceBetween(source, "const handleRetry", "const handleDrop");
    anchorIndex(retry, "retryTransition(state, files.length)");
    anchorIndex(retry, "runPreview(files)");
    anchorIndex(retry, "runCommit(files)");
  });

  it("every failure records which step failed", () => {
    const preview = sliceBetween(source, "const runPreview", "const runCommit");
    const commit = sliceBetween(source, "const runCommit", "const handleFiles");
    expect(preview).not.toMatch(/phase: "commit"/);
    expect(commit).not.toMatch(/phase: "preview"/);
    expect(preview.match(/status: "error"/g)?.length).toBe(preview.match(/phase: "preview"/g)?.length);
    expect(commit.match(/status: "error"/g)?.length).toBe(commit.match(/phase: "commit"/g)?.length);
  });

  it("both handlers read the response through the shared mutation reader", () => {
    expect(source.match(/readMutationResult</g)?.length).toBe(2);
    expect(source.match(/networkFailureMessage\(/g)?.length).toBe(2);
    expect(source).not.toContain("if (!res.ok)");
    expect(source).not.toContain("err.message");
  });
});

describe("B29: privacy masks the figures in a warning, not the sentence", () => {
  const visible = (text: string) =>
    maskFigureSegments(text)
      .map((s) => (s.masked ? "#" : s.text))
      .join("");

  it("keeps symbol, date, type and reason; masks the amounts", () => {
    expect(
      visible("Transaction ZQWARN1 2026-09-04 BUY: amount 550 normalized to -550 (post-2026-04 signed-cash-effect convention)"),
    ).toBe("Transaction ZQWARN1 2026-09-04 BUY: amount # normalized to -# (post-2026-04 signed-cash-effect convention)");
  });

  it("masks quantities and grouped or decimal figures", () => {
    expect(visible("SELL: negative quantity -4 normalized to 4")).toBe(
      "SELL: negative quantity -# normalized to #",
    );
    expect(visible("amount $1,250.75 vs 12.5%")).toBe("amount $# vs #");
  });

  it("masks a figure embedded in a colon-separated source key", () => {
    expect(visible("daf:contribution:2026-08-13:USD:10000:2026-08-12 21:30:45 +0000")).toBe(
      "daf:contribution:2026-08-13:USD:#:2026-08-12 #:#:# +#",
    );
  });

  it("never lets a digit-led token through, date-shaped or not", () => {
    // Not a calendar date: month 25 / year 5000.
    expect(visible("range 5000-25")).toBe("range #-#");
    expect(visible("2026-04-015")).not.toMatch(/\d/);
    expect(visible("12026-04-01")).not.toMatch(/\d/);
    expect(visible("4sh 100x")).toBe("#sh #x");
  });

  it("round-trips the text when nothing is masked and joins back exactly", () => {
    const text = "Skipped transaction: blank symbol";
    expect(maskFigureSegments(text)).toEqual([{ text, masked: false }]);
    const mixed = "amount 550 normalized to -550";
    expect(maskFigureSegments(mixed).map((s) => s.text).join("")).toBe(mixed);
    expect(maskFigureSegments("")).toEqual([]);
  });

  it("every warning list renders through the figure masker, never bare", () => {
    const lines = source.split("\n");
    const sites = lines
      .map((line, i) => (line.includes("warnings.map((w, j)") ? i : -1))
      .filter((i) => i >= 0);
    expect(sites.length).toBe(3);
    for (const i of sites) {
      expect(lines.slice(i, i + 5).join("\n")).toContain("<FigureMaskedText text={w} />");
    }
    // The masker hands each figure to the shared privacy component.
    const masker = sliceBetween(source, "function FigureMaskedText", "type ReplayResult");
    anchorIndex(masker, "<PrivateText key={i}>{s.text}</PrivateText>");
  });
});

describe("B29: excluded rows are counted as rows", () => {
  const rows = [
    { category: "transaction", index: 1, reason: "Invalid quantity", symbol: "ZZZ" },
    { category: "transaction", index: 1, reason: "Invalid amount", symbol: "ZZZ" },
    { category: "price", index: 1, reason: "Invalid price", symbol: "AAA" },
  ];

  it("one row with two bad cells is one row; kinds do not collide on index", () => {
    expect(countExcludedRows(rows.slice(0, 2))).toBe(1);
    expect(countExcludedRows(rows)).toBe(2);
    expect(countExcludedRows(undefined)).toBe(0);
    expect(countExcludedRows([])).toBe(0);
  });

  it("every reason still lists under its row, in first-seen order", () => {
    expect(groupExcludedRows(rows)).toEqual([
      { category: "transaction", index: 1, symbol: "ZZZ", reasons: ["Invalid quantity", "Invalid amount"] },
      { category: "price", index: 1, symbol: "AAA", reasons: ["Invalid price"] },
    ]);
  });

  it("no excluded-row count on screen is the raw entry count", () => {
    expect(source).not.toMatch(/skippedRows!?\.length\} skipped/);
    expect(source).not.toMatch(/\$\{result\.skippedRows\.length\} row/);
    expect(source).not.toMatch(/\{result\.skippedRows\?\.length \?\? 0\} row/);
  });
});

describe("B29: a card with nothing to import says so", () => {
  const preview = (over: { transactionCount?: number; securityCount?: number } = {}) => ({
    transactionCount: 0,
    securityCount: 0,
    holdingCount: 0,
    priceCount: 0,
    snapshotCount: 0,
    corporateActions: { count: 0, sample: [] },
    ...over,
  });

  it("classifies the four shapes from the finding", () => {
    // header-only file
    expect(isImportablePreview({ filename: "a.csv", success: true, preview: preview() })).toBe(false);
    // one clean row
    expect(
      isImportablePreview({ filename: "b.csv", success: true, preview: preview({ transactionCount: 1, securityCount: 1 }) }),
    ).toBe(true);
    // every row excluded, only the by-product security count left
    expect(
      isImportablePreview({
        filename: "c.csv",
        success: true,
        preview: preview({ securityCount: 1 }),
        skippedRows: [{ category: "price", index: 0, reason: "Invalid price" }],
      }),
    ).toBe(false);
    // unknown format
    expect(isImportablePreview({ filename: "d.csv", success: false, error: "Unknown file format" })).toBe(false);
  });

  it("the button names how many of the dropped files will import", () => {
    expect(importButtonLabel(2, 4)).toBe("Import 2 of 4 files");
    expect(importButtonLabel(1, 3)).toBe("Import 1 of 3 files");
    expect(importButtonLabel(4, 4)).toBe("Import 4 files");
    expect(importButtonLabel(1, 1)).toBe("Import 1 file");
    expect(importButtonLabel(0, 2)).toBe("Import 0 files");
  });

  it("the card badge and the button count use the one predicate", () => {
    const panel = sliceBetween(source, 'if (state.status === "preview")', 'if (state.status === "importing")');
    anchorIndex(panel, "state.results.filter(isImportablePreview).length");
    anchorIndex(panel, "!isImportablePreview(result)");
    anchorIndex(panel, "Nothing to import");
    anchorIndex(panel, "importButtonLabel(importableCount, state.results.length)");
  });
});

describe("trade review prompt counts round trips", () => {
  it("sums reviewableCount, not closing legs", () => {
    expect(
      sumReviewableRoundTrips([
        { periodStart: "2026-08-01", periodEnd: "2026-08-31", tradeCount: 9, reviewableCount: 4 },
        { periodStart: "2026-09-01", periodEnd: "2026-09-30", tradeCount: 5, reviewableCount: 3 },
      ]),
    ).toBe(7);
  });

  it("gives no count when a period does not carry one", () => {
    expect(
      sumReviewableRoundTrips([
        { periodStart: "2026-08-01", periodEnd: "2026-08-31", tradeCount: 9 },
      ]),
    ).toBeNull();
    expect(sumReviewableRoundTrips([])).toBeNull();
  });

  it("the prompt no longer says unreviewed trades", () => {
    expect(source).not.toContain("unreviewed trades");
    expect(source).not.toMatch(/s \+ p\.tradeCount/);
    anchorIndex(source, "sumReviewableRoundTrips(state.newTradePeriods ?? [])");
  });
});
