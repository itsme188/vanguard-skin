import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { accountCoverageGrainNote } from "@/app/dashboard/components/DataHealthView";

// No DOM harness in this repo: the pure helper is tested directly and the
// wiring is pinned by a source scan.

const PAGE = readFileSync("app/dashboard/data-health/page.tsx", "utf8");
const VIEW = readFileSync("app/dashboard/components/DataHealthView.tsx", "utf8");

// QA findings data-health--full-audit-destination-never-mentions-the-integrity-cap-behind-the-badge
// and header-dataconfidence--full-audit-link-lands-on-page-without-integrity-notes
describe("Data Health has an Integrity section", () => {
  const section = sliceBetween(PAGE, "function IntegritySection(", "function readConfidence(");

  it("reads the same confidence state as the header badge — no second copy of the cap rule", () => {
    expect(PAGE).toContain('import { getDataConfidence, type DataConfidence } from "@/lib/queries/data-confidence";');
    expect(PAGE).toContain("return getDataConfidence(db);");
    expect(section).toContain("confidence.capReason");
    // The cap rule (which hit caps, and to what score) is not restated here.
    expect(PAGE).not.toMatch(/critical\[0\]/);
    expect(PAGE).not.toMatch(/Math\.min\(/);
  });

  it("has an anchor the Full audit link can target", () => {
    expect(section).toContain('<section id="integrity"');
    expect(section).toContain(">Integrity checks</h2>");
  });

  it("prints the cap reason, the criticals and the notes — reasons masked, counts through <Count>", () => {
    expect(section).toContain("<PrivateText>{confidence.capReason}</PrivateText>");
    expect(section).toContain("<IntegrityGroups hits={confidence.integrity.critical} />");
    expect(section).toContain("<IntegrityGroups hits={confidence.integrity.warnings} />");
    expect(section).toContain("<Count value={confidence.integrity.critical.length} />");
    expect(section).toContain("<Count value={confidence.integrity.warnings.length} />");
    const groups = sliceBetween(PAGE, "function IntegrityGroups(", "function IntegritySection(");
    expect(groups).toContain("groupIntegrityHits(hits)");
    expect(groups).toContain("<PrivateText>{hit.reason}</PrivateText>");
    expect(groups).toContain("<Count value={group.hits.length} />");
    // Every hit renders: the list is height-capped, never sliced.
    expect(groups).not.toMatch(/\.slice\(/);
  });

  it("never reads a skipped lot comparison or a failed read as clean", () => {
    expect(section).toContain("{!confidence.integrity.lotDriftChecked && (");
    expect(section).toMatch(/a\s+skipped check does not mean they agree/);
    expect(section).toContain("confidence === null ? (");
    expect(section).toMatch(/This is not a clean result/);
  });

  it("sits above the coverage panels, and still shows when the coverage read fails", () => {
    expect(PAGE).toContain("<DataHealthView integritySection={<IntegritySection confidence={confidence} />} />");
    const main = VIEW.slice(anchorIndex(VIEW, "{/* Summary cards */}"));
    expect(anchorIndex(main, "{integritySection}")).toBeLessThan(anchorIndex(main, "{/* Account Coverage */}"));
    const errorBranch = sliceBetween(VIEW, "if (error || !data) {", "const { summary, priceFreshness");
    expect(errorBranch).toContain("{integritySection}");
  });
});

// QA finding data-health--headline-distinct-securities-vs-account-rows-pairs-no-grain-label
describe("Data Health labels the grain of each coverage count", () => {
  it("the headline says distinct securities; the account rows say positions", () => {
    expect(VIEW).toContain("sub={`${summary.securitiesWithPrices}/${summary.totalSecurities} distinct securities priced within ${summary.priceWindowDays} days`}");
    expect(VIEW).toContain("{ac.pricedHoldings}/{ac.totalHoldings} positions priced");
  });

  it("the Account Coverage panel carries the note, fed by the summary's count", () => {
    const panel = sliceBetween(VIEW, "{/* Account Coverage */}", "{accountCoverage.map((ac) => (");
    expect(panel).toContain("{accountCoverageGrainNote(summary.securitiesHeldInMultipleAccounts)}");
  });

  it("the note names how many securities sit in more than one account", () => {
    expect(accountCoverageGrainNote(11)).toMatch(/^Each row counts positions/);
    expect(accountCoverageGrainNote(11)).toContain("11 securities are held in more than one account");
    expect(accountCoverageGrainNote(11)).toContain("add up to more than the Price Coverage headline");
    expect(accountCoverageGrainNote(1)).toContain("1 security is held in more than one account");
  });

  it("claims no gap when no security is shared, or when the count is missing", () => {
    for (const n of [0, Number.NaN, undefined as unknown as number]) {
      const note = accountCoverageGrainNote(n);
      expect(note).not.toMatch(/more than one account|add up to more/);
      expect(note).toContain("counts each security once");
      expect(note).not.toMatch(/undefined|NaN/);
    }
  });
});

// QA finding data-health-sector-disagreements--all-rows-unheld-and-untagged-regression-3
describe("Sector disagreements panel says whose stocks it covers", () => {
  it("names the held-or-watched scope in the intro and the empty state", () => {
    const panel = PAGE.slice(anchorIndex(PAGE, "Sector disagreements\n"));
    expect(panel).toMatch(/Stocks you hold or watch whose GICS sector tag disagrees/);
    expect(panel).toMatch(/No unverified sector disagreements among the stocks you hold\s+or watch\./);
  });
});
