import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const selector = readFileSync(
  join(process.cwd(), "app/dashboard/components/YearSelector.tsx"),
  "utf8",
);
const page = readFileSync(
  join(process.cwd(), "app/dashboard/tax-lots/page.tsx"),
  "utf8",
);

describe("tax-lots filter pill rows wrap on narrow viewports", () => {
  it("the shared pill group container wraps", () => {
    const m = selector.match(/<div className="([^"]*)" role="group"/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("flex-wrap");
  });

  it("the page's outer filter row (year + account selectors) wraps", () => {
    const idx = anchorIndex(page, "<YearSelector");
    expect(idx).toBeGreaterThan(-1);
    const before = page.slice(0, idx);
    const m = [...before.matchAll(/<div className="([^"]*)">/g)].pop();
    expect(m![1]).toContain("flex-wrap");
  });
});
