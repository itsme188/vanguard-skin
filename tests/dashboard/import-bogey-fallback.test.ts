import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ImportFlow.tsx", "utf8");
const classify = readFileSync("lib/import/error-classify.ts", "utf8");
const button = readFileSync("app/dashboard/components/ReadAsBogeysButton.tsx", "utf8");
const constant = readFileSync("lib/import/not-a-statement.ts", "utf8");

describe("Import tab bogey fallback (source pin)", () => {
  it("accepts images in the file input and the drop filter", () => {
    expect(src).toMatch(/accept="[^"]*\.png[^"]*"/);
    expect(src).toMatch(/accept="[^"]*image\/png/);
    const drop = src.slice(anchorIndex(src, "const handleDrop"));
    expect(drop.slice(0, 600)).toMatch(/png|IMAGE/i);
  });

  it("never sends an image to /api/import", () => {
    const fn = src.slice(anchorIndex(src, "const handleFiles"), anchorIndex(src, "const handleImport"));
    expect(fn).toMatch(/isImageFile/);
    expect(fn).toMatch(/runPreview\(statementFiles\)/);
    expect(fn).not.toMatch(/runPreview\(selectedFiles\)/);
  });

  it("posts the file to the bogey upload route with the Hub's label convention", () => {
    expect(button).toContain('"/api/earnings/bogeys/upload"');
    expect(button).toContain("currentMondayET()");
    expect(button).toContain('fd.append("sourceLabel"');
    expect(button).toContain("readMutationResult");
    expect(button).toContain("describeUploadOutcome");
    expect(button).toContain("Read it as earnings bogeys");
    expect(src).toContain("ReadAsBogeysButton");
    expect(src).toContain("Images can't be imported as statements");
  });

  it("shows the button on a PDF error only for the classifier's prefix", () => {
    expect(constant).toContain("export const NOT_A_STATEMENT_PREFIX");
    expect(classify).toContain("${NOT_A_STATEMENT_PREFIX} ${truncated}");
    expect(src).not.toContain("error-classify");
    expect(src).toContain("NOT_A_STATEMENT_PREFIX");
    expect(src).toMatch(/error\?\.startsWith\(NOT_A_STATEMENT_PREFIX\)/);
  });

  // A single preview PDF fails every file, so the route answers with one
  // whole-request error and the screen shows "Import Failed", not the
  // per-file list. The button must be offered there too, for the same
  // classification only, and only for a preview-phase failure.
  it("offers the button on the whole-request error view for the classifier's prefix", () => {
    const errorView = src.slice(anchorIndex(src, "Import Failed"));
    expect(errorView).toMatch(/state\.phase === "preview" && state\.message\.startsWith\(NOT_A_STATEMENT_PREFIX\)/);
    expect(errorView).toContain("<ReadAsBogeysButton file={f} />");
  });
});
