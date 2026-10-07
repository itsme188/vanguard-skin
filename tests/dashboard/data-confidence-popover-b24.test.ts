import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Unit B24 — source pins for the data-confidence popover. This repo has no
// DOM test harness (see data-confidence-indicator-privacy.test.ts), so these
// scan the component source; the copy runs themselves are tested against a
// database in tests/queries/data-confidence-copy-parts.test.ts.

const source = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/DataConfidenceIndicator.tsx"),
  "utf8",
);

/** Source between two anchors; throws when either anchor is gone. */
function between(start: string, end: string): string {
  const from = anchorIndex(source, start);
  return source.slice(from, anchorIndex(source, end, from + start.length));
}

describe("popover dismissal (qa:header-dataconfidence--popover-ignores-escape-blocks-heading-regression-1)", () => {
  const effect = between("// Escape and an outside press close the popover", "// Pick which edge the popover hangs off of");

  it("closes on Escape through a document keydown listener, added and removed together", () => {
    expect(effect).toMatch(/e\.key !== "Escape"/);
    expect(effect).toContain('document.addEventListener("keydown", handleKey)');
    expect(effect).toContain('document.removeEventListener("keydown", handleKey)');
    expect(effect).toContain("setShowPopover(false)");
  });

  it("leaves an Escape another overlay already claimed, and claims its own", () => {
    expect(effect).toContain("e.defaultPrevented");
    expect(effect).toContain("e.preventDefault()");
  });

  it("closes on an outside pointerdown, which a touch on plain text also fires", () => {
    expect(effect).toContain('document.addEventListener("pointerdown", handlePress)');
    expect(effect).toContain('document.removeEventListener("pointerdown", handlePress)');
    expect(effect).not.toContain('"mousedown"');
  });

  it("only listens while the popover is open", () => {
    expect(effect).toContain("if (!showPopover) return;");
  });

  it("opens from a click on a real button, never from hover", () => {
    expect(source).toContain("onClick={() => setShowPopover(!showPopover)}");
    expect(source).not.toMatch(/onMouseEnter|onMouseOver/);
  });
});

describe("capped by lot drift → a route to Tax Lots (qa:global-header-dataconfidence-popover-in-the-capped-state-capped-by-lot-drift-popover-offers-no-route-to-the-ta)", () => {
  it("shows a Tax Lots link when a critical lot-drift hit exists", () => {
    const block = between("{lotDriftCapped && (", "{/* Dimension bars */}");
    expect(block).toContain('href="/dashboard/tax-lots"');
    expect(block).toContain("Review Tax Lots");
    expect(block).toContain("Positions and tax lots disagree");
  });

  it("reads the count the query reports, and only once the scan has run", () => {
    expect(source).toMatch(
      /const lotDriftCapped = !verificationIncomplete && confidence\.lotDriftCriticalCount > 0;/,
    );
  });

  it("keeps the unchecked-scan block and its own link", () => {
    const block = between("{verificationIncomplete && (", "{lotDriftCapped && (");
    expect(block).toContain("Verification incomplete");
    expect(block).toContain('href="/dashboard/tax-lots"');
  });
});

describe("cap badge and cap line contrast (qa:header-dataconfidence--capped-badge-and-cap-reason-below-contrast-floor)", () => {
  it("the CAPPED chip keeps its red tint but sets its text in ink", () => {
    expect(source).toMatch(/<Chip tone="down" size="xs" uppercase className="text-ink!">Capped<\/Chip>/);
  });

  it("the cap-reason line is ink on the tint, with the red dot as the lead-in", () => {
    const box = between("{confidence.capReason && (\n            <div", "{verificationIncomplete && (");
    expect(box).toContain("bg-down shrink-0");
    expect(box).toMatch(/<p className="[^"]*\btext-ink\b[^"]*">/);
    expect(box).not.toMatch(/<p className="[^"]*text-down/);
  });
});

describe("Hide amounts masks figures, not sentences (qa:header-dataconfidence--privacy-mode-overmasks-guidance-counts-and-fix-button-label)", () => {
  it("renders runs through CopyRuns: plain text for public runs, <PrivateText> for private ones", () => {
    const fn = between("function CopyRuns(", "function DimensionBar(");
    expect(fn).toMatch(/typeof part === "string"/);
    expect(fn).toMatch(/<PrivateText key=\{i\}>\{part\.private\}<\/PrivateText>/);
  });

  it("dimension detail and guidance use their runs, and mask whole when runs are absent", () => {
    const fn = between("function DimensionBar(", "function IntegrityCriticalRow(");
    expect(fn).toMatch(/detailParts \? <CopyRuns parts=\{detailParts\} \/> : <PrivateText>\{detail\}<\/PrivateText>/);
    expect(fn).toMatch(/guidanceParts \? <CopyRuns parts=\{guidanceParts\} \/> : <PrivateText>\{guidance\}<\/PrivateText>/);
  });

  it("action title and fix text use their runs, and mask whole when runs are absent", () => {
    const fn = source.slice(anchorIndex(source, "function ActionRow("));
    expect(fn).toMatch(/action\.messageParts \? <CopyRuns parts=\{action\.messageParts\} \/> : <PrivateText>\{action\.message\}<\/PrivateText>/);
    expect(fn).toMatch(/action\.fixParts \? <CopyRuns parts=\{action\.fixParts\} \/> : <PrivateText>\{action\.fix\}<\/PrivateText>/);
  });

  it("the timing-residual note masks only its dollar amount", () => {
    const note = between("{confidence.cashAccuracy.timingResidual && (", "{/* Actions */}");
    expect(note).toContain("<Money value={confidence.cashAccuracy.timingResidual.amount} />");
    expect(note).not.toContain("<PrivateText>");
  });

  it("the cap line says in the clear that the score is capped; the reason itself stays masked", () => {
    const box = between("{confidence.capReason && (\n            <div", "{verificationIncomplete && (");
    expect(box).toContain("Capped by an integrity check:");
    expect(box).toContain("<PrivateText>{confidence.capReason}</PrivateText>");
  });
});
