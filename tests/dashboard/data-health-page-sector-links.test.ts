/**
 * Data Health page: the sector check's rows with no sector tag are counted
 * on the page (they left the disagreements list), and both tables link their
 * symbol cell to the security page. Source pins (server page, no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/data-health/page.tsx", "utf8");

function section(heading: string): string {
  const at = anchorIndex(src, heading);
  const start = src.lastIndexOf("<section", at);
  const end = anchorIndex(src, "</section>", at);
  return src.slice(start, end);
}

describe("data-health page sector sections", () => {
  it("counts the sector check's rows with no sector tag, through <Count>", () => {
    expect(src).toMatch(/getSectorCheckMissingSector\(db\)/);
    const s = section("Sector disagreements");
    expect(s).toMatch(/<Count value=\{sectorMissingCount\} \/>/);
    expect(s).toContain("no sector tag");
    // the bare number never renders
    expect(s).not.toMatch(/>\s*\{sectorMissingCount\}/);
  });

  it("links the disagreement symbol to its security page", () => {
    const s = section("Sector disagreements");
    expect(s).toMatch(
      /<SymbolLink\s+securityId=\{d\.securityId\}\s+symbol=\{d\.symbol\}\s+className="text-blue font-mono"\s*\/>/,
    );
  });

  it("links an unmapped-ETF symbol only when a security id exists", () => {
    const s = section("Unmapped sector ETFs");
    expect(s).toMatch(/g\.securityId != null \?/);
    expect(s).toMatch(/<SymbolLink\s+securityId=\{g\.securityId\}\s+symbol=\{g\.symbol\}/);
    expect(s).toMatch(/\) : \(\s*g\.symbol\s*\)/);
  });
});
