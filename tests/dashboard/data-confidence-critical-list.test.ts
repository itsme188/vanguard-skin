import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression: qa:header-dataconfidence--capped-popover-lists-warnings-only-
// critical-lot-drift-hits-never-enumerated. The CAPPED state showed one cap
// line (the single worst critical hit) plus an expander that lists only
// integrity.warnings — every critical hit but the worst one was invisible
// everywhere in the product. Following the static-scan precedent in
// data-confidence-indicator-privacy.test.ts (no React render harness in this
// repo), this test scans the component source rather than rendering it.

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/DataConfidenceIndicator.tsx",
);

describe("DataConfidenceIndicator capped popover lists every critical integrity hit", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("still renders the single-hit cap line naming why the score is capped", () => {
    // Must not be dropped — it explains WHY the score is capped, distinct
    // from the full enumeration.
    expect(source).toMatch(/<PrivateText>\{confidence\.capReason\}<\/PrivateText>/);
  });

  it("defines the critical-hits list as a top-level sibling function component, not nested", () => {
    // Guard against the nested-component remount trap (memory:
    // feedback_nested_component_remount) — must be declared at module top
    // level like IntegrityWarningsRow, never inside another component's body.
    const topLevelMatch = source.match(/^function (\w*Critical\w*)\(/m);
    expect(
      topLevelMatch,
      "expected a top-level `function ...Critical...(` component for the critical hits list",
    ).not.toBeNull();
  });

  it("maps over confidence.integrity.critical to render every hit", () => {
    expect(source).toMatch(/confidence\.integrity\.critical/);
    expect(source).toMatch(/critical\.map\(/);
  });

  it("labels the critical block's count with the word \"critical\", rendered through <Count>", () => {
    expect(source).toMatch(/<Count value=\{critical\.length\}\s*\/>\s*critical/);
  });

  it("renders each critical hit's reason wrapped in <PrivateText> (portfolio-derived prose)", () => {
    const criticalFnMatch = source.match(/^function (\w*Critical\w*)\([\s\S]*?\n\}/m);
    expect(criticalFnMatch, "could not isolate the critical-list component body").not.toBeNull();
    const body = criticalFnMatch![0];
    expect(body).toMatch(/<PrivateText>\{?\w+\.reason\}?<\/PrivateText>/);
  });

  it("places the critical block above the warnings row in render order", () => {
    const criticalCallIdx = source.search(/<\w*Critical\w*[\s/>]/);
    const warningsCallIdx = source.indexOf("<IntegrityWarningsRow");
    expect(criticalCallIdx, "critical block JSX usage not found").toBeGreaterThan(-1);
    expect(warningsCallIdx, "IntegrityWarningsRow JSX usage not found").toBeGreaterThan(-1);
    expect(criticalCallIdx).toBeLessThan(warningsCallIdx);
  });

  it("does not change the warnings row's existing behaviour", () => {
    // The existing warnings-only mapping and its own <Count> label must
    // remain intact and unrelated to the critical fix.
    expect(source).toMatch(/warnings\.map\(/);
    expect(source).toMatch(/<Count value=\{warnings\.length\}\s*\/>\s*integrity note/);
  });
});
