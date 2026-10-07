import { describe, it, expect } from "vitest";
import {
  FILING_WARNING_COPY,
  filingBannerHeading,
  resolveDownloadFilename,
} from "@/app/dashboard/components/TaxReportCard";
import { buildTaxReportFilename } from "@/lib/compute/tax-report";

describe("tax report filing warning", () => {
  it("names both defect classes and the audit date", () => {
    expect(FILING_WARNING_COPY).toContain("100\u00d7");
    expect(FILING_WARNING_COPY).toContain("short-sale");
    expect(FILING_WARNING_COPY).toContain("2026-08-21");
  });

  it("the not-ready banner heading says the export is not ready, and names a partial account", () => {
    expect(filingBannerHeading()).toBe("Export not ready for filing");
    const partial = filingBannerHeading("Account A");
    expect(partial).toContain("Export not ready for filing");
    expect(partial).toContain("PARTIAL EXPORT: Account A only");
  });

  it.each(["csv", "txf"] as const)(
    "the %s download filename is stamped NOT-FOR-FILING until the report is filing-ready",
    (format) => {
      const notReady = resolveDownloadFilename(
        { year: 2024, filingReady: false, accountName: null },
        format,
      );
      expect(notReady).toContain("NOT-FOR-FILING");
      expect(notReady.endsWith(`.${format}`)).toBe(true);

      const ready = resolveDownloadFilename(
        { year: 2024, filingReady: true, accountName: null },
        format,
      );
      expect(ready).not.toContain("NOT-FOR-FILING");
      expect(ready.endsWith(`.${format}`)).toBe(true);
    },
  );

  it("the card filename and the API route's filename builder agree", () => {
    // The route (app/api/tax-report/route.ts) builds its Content-Disposition
    // name with buildTaxReportFilename; tests/api/number-trust-contracts.test.ts
    // exercises the real GET handler end to end.
    for (const format of ["csv", "txf"] as const) {
      for (const filingReady of [false, true]) {
        expect(
          resolveDownloadFilename({ year: 2023, filingReady, accountName: "Account A" }, format),
        ).toBe(buildTaxReportFilename(format, 2023, filingReady, "Account A"));
      }
    }
  });
});
