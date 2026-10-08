import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(`app/dashboard/components/${f}`, "utf8");

describe("U15 small UI sweep (source pins)", () => {
  it("ImportFlow failure copy lists every importer format", () => {
    const t = read("ImportFlow.tsx");
    const line = t.slice(t.indexOf("Supported formats:"), t.indexOf("(see format guide below)"));
    for (const word of ["activity", "holdings", "cost basis", "Canonical", "monthly values", "factor", "DAF"]) {
      expect(line).toContain(word);
    }
  });

  it("allocation pie tooltip renders full dollars through <Money>", () => {
    const t = read("AnalysisView.tsx");
    const i = t.indexOf("<Tooltip");
    const block = t.slice(i, t.indexOf("itemStyle", i));
    expect(block).toMatch(/<Money\s+key="v"\s+value=\{Number\(value\)\}\s*\/>/);
    expect(block).not.toContain("formatMoney");
  });

  it("DigestEmailViewer title heading wraps (no truncate / nowrap)", () => {
    const t = read("DigestEmailViewer.tsx");
    const h = t.slice(t.indexOf("<h2"), t.indexOf("</h2>"));
    expect(h).not.toMatch(/truncate|whitespace-nowrap/);
  });
});
