/**
 * QA 2026-10-02: a commit whose every row named an unknown account returned
 * 0 records plus `skippedRows`, but the done panel showed a green "Import
 * Complete" / "0 records" and never rendered `skippedRows`, so the reason
 * the rows were excluded vanished. The done panel now lists the excluded
 * rows with the same block preview uses, says "Nothing imported" for a file
 * that wrote nothing, and swaps the green heading for the warning treatment
 * when nothing was imported at all.
 *
 * No DOM test harness in this repo — source-pin (same precedent as
 * import-flow-warnings-map-privacy.test.ts); the card itself is verified in
 * a browser.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const source = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ImportFlow.tsx"),
  "utf8",
);

// The done panel is everything from the `status === "done"` branch to the
// error fallback below it.
const doneStart = anchorIndex(source, 'if (state.status === "done")');
const doneEnd = anchorIndex(source, "// Error", doneStart);
const donePanel = source.slice(doneStart, doneEnd);

describe("ImportFlow done panel reports excluded rows", () => {
  it("locates the done panel", () => {
    expect(doneStart).toBeGreaterThan(0);
    expect(doneEnd).toBeGreaterThan(doneStart);
  });

  it("renders skippedRows through the same block the preview uses", () => {
    expect(donePanel).toMatch(/<SkippedRowsDetails[\s\S]*?result\.skippedRows/);
    const previewPanel = source.slice(
      anchorIndex(source, 'if (state.status === "preview")'),
      anchorIndex(source, 'if (state.status === "importing")'),
    );
    expect(previewPanel).toContain("<SkippedRowsDetails");
  });

  it("says nothing was imported instead of a bare 0 records for an all-excluded file", () => {
    expect(donePanel).toContain("Nothing imported");
  });

  it("keys 'nothing imported' on batchId === null, not on a zero record count", () => {
    expect(donePanel).toMatch(/r\.batchId === null && \(r\.skippedRows\?\.length \?\? 0\) > 0/);
    expect(donePanel).toMatch(/state\.results\.every\(\(r\) => r\.batchId === null\)/);
    expect(donePanel).not.toMatch(/totalRecords \?\? 0\) === 0/);
  });

  it("does not show the green Import Complete heading when nothing was imported", () => {
    expect(donePanel).toMatch(/nothingImported\s*\?/);
    expect(donePanel).toContain("Nothing Imported");
    expect(donePanel).toContain("Import Complete");
  });
});
