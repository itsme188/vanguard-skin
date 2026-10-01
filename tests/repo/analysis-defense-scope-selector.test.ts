import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/analysis/page.tsx"),
  "utf8",
);

const start = src.indexOf('resolved.view === "defense"');
const end = src.indexOf("resolved.view ===", start + 1);
const branch = src.slice(start, end);

describe("Analysis Defense view scope selector", () => {
  it("finds the defense branch", () => {
    expect(start).toBeGreaterThan(-1);
    expect(branch).toContain("<DefenseView");
  });

  it("renders the shared scope pill component above DefenseView", () => {
    expect(branch).toContain("<DefenseScopePills");
    expect(branch.indexOf("<DefenseScopePills")).toBeLessThan(
      branch.indexOf("<DefenseView"),
    );
  });

  it("the component is an Account scope pill group that keeps view=defense", () => {
    const comp = src.slice(src.indexOf("function DefenseScopePills"));
    expect(comp).toContain('role="group"');
    expect(comp).toContain('aria-label="Account scope"');
    expect(comp).toContain("SCOPE_PILLS.map");
    expect(comp).toMatch(/view=defense&scope=\$\{s\.key\}/);
  });
});
