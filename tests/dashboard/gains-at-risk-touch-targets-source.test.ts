import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

// The page's jump links and the driver choice are small text; on a touch
// screen each gets the hit-area extension the move rows already carry.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const EXTENSION = [
  "relative",
  "pointer-coarse:after:absolute",
  "pointer-coarse:after:content-['']",
  "pointer-coarse:after:-inset-y-1",
];

describe("Gains at risk: touch hit areas", () => {
  it("the three section jump links carry the extension and touch spacing", () => {
    const src = read("app/dashboard/components/gains-at-risk/GainsAtRiskView.tsx");
    const start = anchorIndex(src, "pageGuideLines(kind).map");
    const link = src.slice(start, anchorIndex(src, "</a>", start));
    for (const cls of EXTENSION) expect(link).toContain(cls);
    const list = src.slice(anchorIndex(src, "<ul", start - 200), start);
    expect(list).toContain("pointer-coarse:space-y-2");
  });

  it("both driver radio labels carry the extension", () => {
    const src = read("app/dashboard/components/gains-at-risk/DriverControl.tsx");
    const labels = src.match(/<label className="[^"]*"/g) ?? [];
    const radios = labels.filter((l) => l.includes("inline-flex items-center gap-1.5"));
    expect(radios).toHaveLength(2);
    for (const l of radios) for (const cls of EXTENSION) expect(l).toContain(cls);
  });
});
