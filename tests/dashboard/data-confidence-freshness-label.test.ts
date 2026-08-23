import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Data Confidence badge reframed as freshness hint", () => {
  const src = () => readFileSync("app/dashboard/components/DataConfidenceIndicator.tsx", "utf8");
  it("tooltip and header say freshness", () => {
    expect(src()).toContain("Data freshness:");
    expect(src()).toContain("Data Freshness:");
  });
  it("carries the not-a-certification caption", () => {
    expect(src()).toContain("does not certify");
  });
});
