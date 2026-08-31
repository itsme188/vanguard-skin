import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  taxReportCardTitle,
  filingBannerHeading,
  resolveDownloadFilename,
  resolveTaxReportCardStatus,
  createFetchGuard,
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

  it("the card's own fetch (in the effect) stays scoped to the live year/account props", () => {
    // The effect is what decides what's ON SCREEN, so it should track the
    // live props (that's the whole point of the [year, accountParam] deps).
    const effectFetch = src.match(/fetch\(`\/api\/tax-report\?year=\$\{year\}\$\{accountParam\}`\)/);
    expect(effectFetch, "expected the effect's fetch to use the live year/accountParam").not.toBeNull();
  });

  it("Finding A (Critical follow-up): the download's fetched CONTENT and its FILENAME derive from the SAME report snapshot, never the live year/account props", () => {
    // Regression: the original fix only made the FILENAME read from
    // `report`. handleDownload's own fetch (the actual exported bytes)
    // still read the live `year`/`accountName` props via `accountParam`.
    // Finding B's fix deliberately keeps a stale `report` on screen (with
    // the download buttons still enabled) across a failed refetch — so an
    // account switch racing a failed refetch could download account B's
    // CONTENT under account A's filingReady/name in the FILENAME. Both must
    // now come from `report` itself, making that mispairing structurally
    // impossible.
    const downloadMatch = src.match(
      /async function handleDownload\(format: "csv" \| "txf"\) \{([\s\S]*?)\n {2}\}/
    );
    expect(downloadMatch, "expected to find handleDownload's body").not.toBeNull();
    const body = downloadMatch![1];

    // The fetch inside handleDownload is scoped off `report`, not the
    // outer `accountParam` (built from the live accountName prop) or the
    // bare `year` prop.
    expect(body).toMatch(/report\.year/);
    expect(body).toMatch(/report\.accountName/);
    expect(body).not.toMatch(/year=\$\{year\}/);
    expect(body).not.toMatch(/\$\{accountParam\}/);

    // The filename builder takes only (report, format) — no separate year
    // or accountName that could diverge from what was actually fetched.
    expect(body).toMatch(/resolveDownloadFilename\(\s*report,\s*format\s*\)/);
    expect(src).not.toMatch(/buildTaxReportFilename\(\s*format,\s*year,\s*report\.filingReady,\s*accountName/);
  });

  it("the Tax Lots page hands its ?account= filter to the card", () => {
    const page = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");
    expect(page).toMatch(/<TaxReportCard[^>]*accountName=/);
  });

  it("guards the report fetch against out-of-order stale responses, with the guard checked in the correct structural position in each branch", () => {
    // Regression (PR #59 review, Finding A): the fetch effect had no
    // cancelled/abort guard, so a slow response for a PREVIOUS account could
    // land after a newer account's response and overwrite `report` with
    // stale data. createFetchGuard() (behaviorally tested below with real
    // out-of-order Promise resolution — Important 2 follow-up) is the
    // codebase's own cancelled-flag cleanup idiom (see
    // app/dashboard/components/PlaidSection.tsx,
    // app/dashboard/components/LevelsPanel.tsx) extracted into a reusable,
    // testable primitive. This test pins that the component actually WIRES
    // it correctly: created before the fetch starts, checked FIRST inside
    // the success callback (before any setReport/setError), and cancelled
    // from the effect's cleanup.
    const effectMatch = src.match(
      /useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[year, accountParam\]\);/
    );
    expect(effectMatch, "expected the [year, accountParam] fetch effect to be present").not.toBeNull();
    const effectBody = effectMatch![1];

    // Guard created before the fetch call — no window where a resolution
    // could race ahead of a guard existing to check against.
    expect(effectBody).toMatch(/const guard = createFetchGuard\(\);[\s\S]*?fetch\(/);

    // The success/failure branch: `guard.isCancelled()` is the FIRST
    // statement in the .then((json) => {...}) callback, before either
    // setReport or setError runs.
    const successBranch = effectBody.match(/\.then\(\(json\) => \{([\s\S]*?)\n {6}\}\)/);
    expect(successBranch, "expected the json .then callback").not.toBeNull();
    expect(successBranch![1].trim().startsWith("if (guard.isCancelled()) return;")).toBe(true);

    // The network-error and loading-settle branches are guarded too.
    expect(effectBody).toMatch(/\.catch\(\(err\) => \{\s*if \(!guard\.isCancelled\(\)\) \{/);
    expect(effectBody).toMatch(/\.finally\(\(\) => \{\s*if \(!guard\.isCancelled\(\)\) setLoading\(false\);/);

    // Cleanup cancels THIS run's guard — React calls a previous effect's
    // cleanup before running the next one, so an account switch cancels
    // the old (possibly still in-flight) run's guard before the new fetch
    // even starts.
    expect(effectBody).toMatch(/return \(\) => \{\s*guard\.cancel\(\);\s*\};/);
  });

  it("never nulls the report on a failed refetch (Finding B: silent blanking)", () => {
    expect(src).not.toMatch(/setReport\(null\)/);
  });

  it("Important 1 follow-up: source-pins the error-state JSX branch so a first-load failure explains itself, not a blank card", () => {
    const errorBranchMatch = src.match(/if \(status\.kind === "error"\) \{([\s\S]*?)\n {2}\}/);
    expect(errorBranchMatch, 'expected the status.kind === "error" JSX branch').not.toBeNull();
    const errorBranch = errorBranchMatch![1];
    expect(errorBranch).toContain("Unable to load tax report");
    expect(errorBranch).toContain("{status.message}");
  });

  it("Important 1 follow-up: source-pins the stale-data notice JSX so a refetch failure over good data explains itself, not a silent revert", () => {
    expect(src).toContain("status.staleError && (");
    expect(src).toContain("Showing last-loaded data — refresh failed");
    expect(src).toContain("{status.staleError}");
  });
});

describe("createFetchGuard (Finding A / Important 2 follow-up: driving real out-of-order fetch resolution)", () => {
  it("keeps a NEWER run's result even when an OLDER run's fetch resolves LATER (true out-of-order interleaving)", async () => {
    // Mirrors exactly what the effect does across an account switch:
    //  - run A starts (e.g. account "Vanguard Taxable"); its fetch is slow.
    //  - the account switches to B before A resolves — React calls A's
    //    effect cleanup (guardA.cancel()) and starts a new run with a
    //    fresh guard (guardB) BEFORE A's fetch has resolved.
    //  - B's fetch is fast and resolves first, applying its result.
    //  - A's fetch FINALLY resolves late, out of order — its callback must
    //    see guardA.isCancelled() === true and skip applying its result.
    let applied: string | null = null;

    const guardA = createFetchGuard();
    let resolveA!: (value: string) => void;
    const fetchA = new Promise<string>((resolve) => {
      resolveA = resolve;
    });
    const runA = fetchA.then((value) => {
      if (guardA.isCancelled()) return;
      applied = value;
    });

    // The account switches: cleanup cancels A's guard, then B's run starts
    // with a fresh guard — before A's fetch has resolved.
    guardA.cancel();
    const guardB = createFetchGuard();
    const runB = Promise.resolve("B").then((value) => {
      if (guardB.isCancelled()) return;
      applied = value;
    });
    await runB;
    expect(applied).toBe("B");

    // NOW A's slow fetch resolves, out of order, after B already applied.
    resolveA("A");
    await runA;

    // The stale A response must NOT have overwritten B's result.
    expect(applied).toBe("B");
  });

  it("a guard that is never cancelled always applies its result", async () => {
    const guard = createFetchGuard();
    let applied: string | null = null;
    await Promise.resolve("X").then((value) => {
      if (!guard.isCancelled()) applied = value;
    });
    expect(applied).toBe("X");
    expect(guard.isCancelled()).toBe(false);
  });
});

describe("resolveDownloadFilename (Finding A: stale-fetch race)", () => {
  it("derives filingReady, the account scope, AND the year from the SAME report snapshot", () => {
    const readyRoth = { filingReady: true, accountName: "Vanguard Roth IRA", year: 2022 };
    expect(resolveDownloadFilename(readyRoth, "csv")).not.toContain("NOT-FOR-FILING");
    expect(resolveDownloadFilename(readyRoth, "csv")).toContain("vanguard-roth-ira");
    expect(resolveDownloadFilename(readyRoth, "csv")).toContain("2022");
  });

  it("marks a not-filingReady report NOT-FOR-FILING regardless of which account it's scoped to", () => {
    // This is the exact regression: a Roth-scoped, not-broker-accepted
    // report must never lose its marker because some OTHER account's
    // filingReady state leaked in from a stale response.
    const notReadyRoth = { filingReady: false, accountName: "Vanguard Roth IRA", year: 2022 };
    expect(resolveDownloadFilename(notReadyRoth, "csv")).toContain("NOT-FOR-FILING");
  });

  it("takes the year from `report.year` too, not a separately-passed year prop", () => {
    // Critical follow-up: if the filename's year could come from a
    // separate `year` prop while the content came from `report.year` (or
    // vice versa), the same class of bug reopens for the year dimension.
    const report2021 = { filingReady: true, accountName: null, year: 2021 };
    const report2022 = { filingReady: true, accountName: null, year: 2022 };
    expect(resolveDownloadFilename(report2021, "csv")).toContain("2021");
    expect(resolveDownloadFilename(report2022, "csv")).toContain("2022");
  });

  it("has no accountName or year parameter — the caller cannot pass a separately-sourced value even by mistake", () => {
    expect(resolveDownloadFilename.length).toBe(2);
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
