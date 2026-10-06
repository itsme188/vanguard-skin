import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.resolve(__dirname, "../../app/dashboard/components/CanonicalCsvGuide.tsx"),
  "utf8",
);

describe("CanonicalCsvGuide BUY-sign era caveat (source pin)", () => {
  it("warns that BUY rows before 2026-04-01 keep the positive convention", () => {
    expect(src).toContain("BUY rows dated before 2026-04-01");
    expect(src).toContain("BUY amount POSITIVE");
    expect(src).toMatch(/Do not flip the sign when re-importing an older file/);
    expect(src).toMatch(/duplicates/);
  });
  it("appears in both the on-screen rules and the copied prompt", () => {
    expect(src.match(/OLDER-FILE CAVEAT/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
