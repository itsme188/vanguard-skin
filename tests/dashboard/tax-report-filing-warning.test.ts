import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FILING_WARNING_COPY } from "@/app/dashboard/components/TaxReportCard";

describe("tax report filing warning", () => {
  it("names both defect classes and the audit date", () => {
    expect(FILING_WARNING_COPY).toContain("100×");
    expect(FILING_WARNING_COPY).toContain("short-sale");
    expect(FILING_WARNING_COPY).toContain("2026-08-21");
  });

  it("is rendered in the card JSX and stamps the download filename", () => {
    const src = readFileSync("app/dashboard/components/TaxReportCard.tsx", "utf8");
    expect(src).toMatch(/\{FILING_WARNING_COPY\}/);
    expect(src).toContain("Export not ready for filing");
    expect(src).toContain("NOT-FOR-FILING");
  });

  it("the API route stamps both export filenames", () => {
    const src = readFileSync("app/api/tax-report/route.ts", "utf8");
    const hits = src.match(/NOT-FOR-FILING/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});
