import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/DataConfidenceIndicator.tsx"),
  "utf8",
);

describe("DataConfidenceIndicator actions overflow", () => {
  it("keeps the 4-row cap", () => {
    expect(src).toContain("actions.slice(0, 4)");
  });

  it("shows a +N more line when actions exceed the cap", () => {
    expect(src).toMatch(/actions\.length > 4/);
    expect(src).toMatch(/\+\{confidence\.actions\.length - 4\} more/);
  });
});
