/**
 * QA finding mobile-header--data-confidence-badge-hidden-below-md-no-mobile-surface:
 * the header badge is hidden below md, so the Data Health page itself shows the
 * confidence score, its level, the cap state and the cap reason at the TOP of
 * the page, above the summary cards (DataHealthView). Source pins: this repo
 * has no DOM harness.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { dataConfidenceLevelLabel } from "@/lib/ui/data-confidence-level";

const PAGE = readFileSync("app/dashboard/data-health/page.tsx", "utf8");

describe("Data Health page-top confidence summary", () => {
  it("renders the summary before DataHealthView (above the summary cards)", () => {
    const render = PAGE.slice(anchorIndex(PAGE, "export default function DataHealthPage("));
    const summary = anchorIndex(render, "<ConfidenceSummary");
    const view = anchorIndex(render, "<DataHealthView");
    expect(summary).toBeLessThan(view);
  });

  it("shows score, level, cap state and the cap reason from the same confidence read", () => {
    const fn = sliceBetween(PAGE, "function ConfidenceSummary(", "function IntegritySection(");
    expect(fn).toContain("confidence.overallScore");
    expect(fn).toContain("dataConfidenceLevelLabel(confidence.overallLevel)");
    expect(fn).toContain("<CapStatus confidence={confidence} />");
    expect(PAGE).toContain("const confidence = readConfidence();");
    expect(PAGE).toContain("<ConfidenceSummary confidence={confidence} />");
    // No second read and no restated cap rule.
    expect(PAGE.match(/getDataConfidence\(db\)/g)).toHaveLength(1);
    expect(PAGE).not.toMatch(/Math\.min\(/);
  });

  it("an unreadable confidence is said plainly, never shown as a clean score", () => {
    const fn = sliceBetween(PAGE, "function ConfidenceSummary(", "function IntegritySection(");
    expect(fn).toContain("confidence === null");
    expect(fn).toContain("could not be read");
  });

  it("the cap line is one component shared with the Integrity section; the reason stays masked", () => {
    const cap = sliceBetween(PAGE, "function CapStatus(", "function ConfidenceSummary(");
    expect(cap).toContain("<PrivateText>{confidence.capReason}</PrivateText>");
    expect(cap).toContain("not capped");
    const section = sliceBetween(PAGE, "function IntegritySection(", "function readConfidence(");
    expect(section).toContain("<CapStatus confidence={confidence} />");
    expect(section).not.toContain("confidence.capReason");
  });

  it("the score is the data-quality figure the header badge prints, not a portfolio amount", () => {
    const fn = sliceBetween(PAGE, "function ConfidenceSummary(", "function IntegritySection(");
    expect(fn).toMatch(/\{confidence\.overallScore\}%/);
  });
});

describe("dataConfidenceLevelLabel", () => {
  it("uses the badge's plain wording for every level", () => {
    expect(dataConfidenceLevelLabel("high")).toBe("Data reliable");
    expect(dataConfidenceLevelLabel("medium")).toBe("Some data stale");
    expect(dataConfidenceLevelLabel("low")).toBe("Data unreliable");
    expect(dataConfidenceLevelLabel("stale")).toBe("Data very stale");
    expect(dataConfidenceLevelLabel("unverified")).toBe("Verification incomplete");
  });
});

// Browser pass 2026-10-08: the page crashed because a server component called
// a function exported from a "use client" file. No Vitest test can render the
// page, so pin the import boundary itself.
describe("server page never imports a function from a client file", () => {
  it("the Data Health page takes the level wording from a plain module", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/dashboard/data-health/page.tsx", "utf8");
    const helper = readFileSync("lib/ui/data-confidence-level.ts", "utf8");
    expect(page).toContain('from "@/lib/ui/data-confidence-level"');
    expect(page).not.toMatch(/import \{[^}]*dataConfidenceLevelLabel[^}]*\} from "\.\.\/components\/DataHealthView"/);
    expect(/^\s*["']use client["']/m.test(helper)).toBe(false);
  });
});

