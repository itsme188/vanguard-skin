import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/analysis/page.tsx"),
  "utf8",
);

const start = anchorIndex(src, 'resolved.view === "defense"');
const end = anchorIndex(src, "resolved.view ===", start + 1);
const branch = src.slice(start, end);

describe("Analysis Defense view scope selector", () => {
  it("finds the defense branch", () => {
    expect(start).toBeGreaterThan(-1);
    expect(branch).toContain("<DefenseView");
  });

  it("renders the shared scope pill component above DefenseView", () => {
    expect(branch).toContain("<DefenseScopePills");
    expect(anchorIndex(branch, "<DefenseScopePills")).toBeLessThan(
      anchorIndex(branch, "<DefenseView"),
    );
  });

  it("the component is an Account scope pill group that keeps view=defense", () => {
    const comp = src.slice(anchorIndex(src, "function DefenseScopePills"));
    expect(comp).toContain('role="group"');
    expect(comp).toContain('aria-label="Account scope"');
    expect(comp).toContain("SCOPE_PILLS.map");
    expect(comp).toMatch(/view=defense&scope=\$\{s\.key\}/);
  });
});
