import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ReconciliationTable.tsx"),
  "utf8",
);

describe("ReconciliationTable Computed fallback display", () => {
  it("captions the fallback figure with its source date", () => {
    expect(src).toContain("cp.computed_from_date");
    expect(src).toMatch(/from \{cp\.computed_from_date\}/);
  });
  it("explains a missing value instead of a bare dash", () => {
    expect(src).toContain("cp.computed_missing_reason");
    expect(src).toContain("sr-only");
  });
});
