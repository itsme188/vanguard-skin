import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  taxReportCardTitle,
  filingBannerHeading,
  resolveDownloadFilename,
  resolveTaxReportCardStatus,
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

  it("derives the download filename from the report snapshot, not a separately-sourced prop", () => {
    // Regression (PR #59 review, Finding A): the call used to read
    // `report.filingReady` alongside the bare `accountName` PROP, which can
    // have moved on to a different account by the time this stale-fetch-race
    // response lands. resolveDownloadFilename takes no accountName param at
    // all, so the bug is structurally impossible at the call site.
    expect(src).toMatch(/resolveDownloadFilename\(\s*report,\s*format,\s*year\s*\)/);
    expect(src).not.toMatch(/buildTaxReportFilename\(\s*format,\s*year,\s*report\.filingReady,\s*accountName/);
  });

  it("the Tax Lots page hands its ?account= filter to the card", () => {
    const page = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");
    expect(page).toMatch(/<TaxReportCard[^>]*accountName=/);
  });

  it("guards the report fetch against out-of-order stale responses across account switches", () => {
    // Regression (PR #59 review, Finding A): the fetch effect had no
    // cancelled/abort guard, so a slow response for a PREVIOUS account could
    // land after a newer account's response and overwrite `report` with
    // stale data — the codebase's own `let cancelled = false` cleanup
    // pattern (see e.g. app/dashboard/components/PlaidSection.tsx,
    // app/dashboard/components/LevelsPanel.tsx) is required here too.
    const effectMatch = src.match(
      /useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[year, accountParam\]\);/
    );
    expect(effectMatch, "expected the [year, accountParam] fetch effect to be present").not.toBeNull();
    const effectBody = effectMatch![1];
    expect(effectBody).toMatch(/let cancelled = false;/);
    expect(effectBody).toMatch(/cancelled = true;/);
    // Every state setter reachable from the fetch's resolution must be
    // guarded by the flag — otherwise a stale response still clobbers state
    // even with the flag declared but unused.
    expect(effectBody).toMatch(/if \(cancelled\) return;/);
    expect(effectBody).toMatch(/if \(!cancelled\) setLoading\(false\);/);
  });

  it("never nulls the report on a failed refetch (Finding B: silent blanking)", () => {
    expect(src).not.toMatch(/setReport\(null\)/);
  });
});

describe("resolveDownloadFilename (Finding A: stale-fetch race)", () => {
  it("derives BOTH filingReady and the account scope from the SAME report snapshot", () => {
    const readyRoth = { filingReady: true, accountName: "Vanguard Roth IRA" };
    expect(resolveDownloadFilename(readyRoth, "csv", 2022)).not.toContain("NOT-FOR-FILING");
    expect(resolveDownloadFilename(readyRoth, "csv", 2022)).toContain("vanguard-roth-ira");
  });

  it("marks a not-filingReady report NOT-FOR-FILING regardless of which account it's scoped to", () => {
    // This is the exact regression: a Roth-scoped, not-broker-accepted
    // report must never lose its marker because some OTHER account's
    // filingReady state leaked in from a stale response.
    const notReadyRoth = { filingReady: false, accountName: "Vanguard Roth IRA" };
    expect(resolveDownloadFilename(notReadyRoth, "csv", 2022)).toContain("NOT-FOR-FILING");
  });

  it("has no accountName parameter — the caller cannot pass a separately-sourced name even by mistake", () => {
    expect(resolveDownloadFilename.length).toBe(3);
  });
});

describe("resolveTaxReportCardStatus (Finding B: silent blanking)", () => {
  const goodReport = {
    year: 2022,
    accountName: null,
    filingReady: true,
    washSaleAdvisory: "",
    shortTermTotal: { proceeds: 0, costBasis: 0, adjustments: 0, gainLoss: 0 },
    longTermTotal: { proceeds: 0, costBasis: 0, adjustments: 0, gainLoss: 0 },
    shortTermRows: [{ length: 1 }],
    longTermRows: [],
    washSaleWarnings: [],
  };

  it("shows loading first regardless of report/error state", () => {
    expect(resolveTaxReportCardStatus(true, null, "some error")).toEqual({ kind: "loading" });
    expect(resolveTaxReportCardStatus(true, goodReport, "some error")).toEqual({ kind: "loading" });
  });

  it("renders an explicit error state instead of silently unmounting when the FIRST load fails", () => {
    // Old behavior: `else setReport(null)` then `if (!report) return null` —
    // the card vanished with no explanation. A transient SQLITE_BUSY while
    // Recompute writes must explain itself in domain language, not blank.
    expect(resolveTaxReportCardStatus(false, null, "SQLITE_BUSY: database is locked")).toEqual({
      kind: "error",
      message: "SQLITE_BUSY: database is locked",
    });
  });

  it("keeps a previously-good report visible with a stale/error notice on a transient refetch failure", () => {
    // The card must NOT regress to unmounted just because a later refetch
    // (e.g. after an account switch, or a periodic refresh) failed.
    expect(resolveTaxReportCardStatus(false, goodReport, "SQLITE_BUSY: database is locked")).toEqual({
      kind: "ready",
      staleError: "SQLITE_BUSY: database is locked",
    });
  });

  it("renders nothing when there is genuinely no report and no error (legitimately empty scope)", () => {
    expect(resolveTaxReportCardStatus(false, null, null)).toEqual({ kind: "empty" });
  });

  it("renders ready with no stale notice when the report loaded cleanly", () => {
    expect(resolveTaxReportCardStatus(false, goodReport, null)).toEqual({
      kind: "ready",
      staleError: null,
    });
  });
});
