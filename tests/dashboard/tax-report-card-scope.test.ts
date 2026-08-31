import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  taxReportCardTitle,
  filingBannerHeading,
} from "@/app/dashboard/components/TaxReportCard";

/**
 * QA finding tax-lots--account-filter-ignored-by-tax-report-card-and-exports:
 * with ?account=<name> active the card showed another account's totals under
 * a full-report heading. The card must NAME its scope, fetch the scoped
 * report, and stamp the scoped download name.
 *
 * TaxReportCard is "use client" with fetch-in-useEffect (no jsdom harness in
 * this suite), so the label logic lives in pure exported helpers and the
 * wiring is pinned with a source scan — same pattern as
 * tests/dashboard/tax-report-wash-sale-disclosure.test.ts.
 */

describe("TaxReportCard scope labelling (pure helpers)", () => {
  it("names the account in the card title when a filter is active", () => {
    expect(taxReportCardTitle(2022, "Vanguard Roth IRA")).toBe(
      "Tax Report — 2022 · Vanguard Roth IRA"
    );
  });

  it("keeps the all-accounts title unchanged with no filter", () => {
    expect(taxReportCardTitle(2022)).toBe("Tax Report — 2022");
    expect(taxReportCardTitle(2022, "")).toBe("Tax Report — 2022");
    expect(taxReportCardTitle(2022, null)).toBe("Tax Report — 2022");
  });

  it("names the account in the not-ready banner so a partial file can't pass for the full report", () => {
    const heading = filingBannerHeading("Vanguard Roth IRA");
    expect(heading).toContain("Export not ready for filing");
    expect(heading).toContain("Vanguard Roth IRA");
    expect(heading.toLowerCase()).toContain("partial");
  });

  it("leaves the banner heading unchanged with no filter", () => {
    expect(filingBannerHeading()).toBe("Export not ready for filing");
    expect(filingBannerHeading(null)).toBe("Export not ready for filing");
  });
});

describe("TaxReportCard scope wiring (source pin)", () => {
  const src = readFileSync("app/dashboard/components/TaxReportCard.tsx", "utf8");

  it("fetches the account-scoped report for both the card and the downloads", () => {
    // Every /api/tax-report fetch in the card threads the account param.
    const fetches = src.match(/\/api\/tax-report\?[^`]*/g) ?? [];
    expect(fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of fetches) {
      expect(f).toContain("accountParam");
    }
  });

  it("passes the account name into the single-sourced filename builder", () => {
    expect(src).toMatch(/buildTaxReportFilename\(\s*format,\s*year,\s*report\.filingReady,\s*accountName/);
  });

  it("the Tax Lots page hands its ?account= filter to the card", () => {
    const page = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");
    expect(page).toMatch(/<TaxReportCard[^>]*accountName=/);
  });
});
