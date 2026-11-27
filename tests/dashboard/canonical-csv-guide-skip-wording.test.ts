import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

const guide = read("app/dashboard/components/CanonicalCsvGuide.tsx");
const parser = read("lib/import/parsers/canonical-csv.ts");
const validate = read("lib/import/validate.ts");

/** The text of the line that holds `needle`. */
function lineWith(src: string, needle: string, from = 0): string {
  const i = anchorIndex(src, needle, from, "guide rule");
  const start = src.lastIndexOf("\n", i) + 1;
  const end = src.indexOf("\n", i);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("CanonicalCsvGuide skip wording (source pin)", () => {
  it("no longer claims rows are silently dropped or truncated", () => {
    expect(guide).not.toContain("silently dropped");
    expect(guide).not.toContain("silently truncate");
    expect(guide).not.toMatch(/Blank symbol drops the row/);
  });

  it("blank-symbol rule (screen and copy text) says the preview lists it", () => {
    const screen = lineWith(guide, "MUST use symbol 'CASH'");
    const copy = lineWith(guide, "MUST use symbol 'CASH'", guide.indexOf(screen) + screen.length);
    for (const line of [screen, copy]) {
      expect(line).toMatch(/preview/i);
      expect(line).toMatch(/skipped/i);
    }
  });

  it("comma rule (screen and copy text) says the row is skipped and listed in the preview", () => {
    const screen = lineWith(guide, "NO comma thousands separators");
    const copy = lineWith(guide, "NO comma thousands separators", guide.indexOf(screen) + screen.length);
    for (const line of [screen, copy]) {
      expect(line).toMatch(/preview/i);
      expect(line).toMatch(/skipped/i);
    }
  });

  it("stays honest against the importer", () => {
    expect(parser).toContain("Skipped transaction: blank symbol");
    expect(validate).toContain("not a number (check for comma separators");
  });
});
