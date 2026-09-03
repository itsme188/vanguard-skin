/**
 * bceac5a added import-preview warnings that can embed raw CSV field values
 * (amounts, source keys, etc — same privacy class as the donation
 * reversal/identity-conflict warnings fixed in 0964871, see
 * import-flow-donation-warning-privacy.test.ts). ImportFlow.tsx renders
 * three separate `warnings.map((w, j) => ...)` sites (preview-summary
 * warnings x2, tax-lot replay warnings x1) that print the raw warning
 * string `{w}` directly inside a bare <p>, bypassing privacy masking
 * entirely.
 *
 * This scans the source (same no-render-harness precedent as the sibling
 * test) and asserts every `warnings.map((w, j)` render site wraps its item
 * in <PrivateText>, so privacy mode can mask it like every other
 * portfolio-derived surface.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ImportFlow.tsx",
);

describe("ImportFlow warnings.map(...) render sites mask under privacy mode", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");
  const lines = source.split("\n");

  // Find every `warnings.map((w, j)` call site (there should be several —
  // this test fails if there are none, so it can't silently pass on a
  // renamed/removed pattern).
  const siteLineIndexes: number[] = [];
  lines.forEach((line, i) => {
    if (line.includes("warnings.map((w, j)")) siteLineIndexes.push(i);
  });

  it("finds at least one warnings.map((w, j) render site", () => {
    expect(siteLineIndexes.length).toBeGreaterThan(0);
  });

  it("every warnings.map((w, j) render site wraps {w} in <PrivateText>", () => {
    for (const idx of siteLineIndexes) {
      const window = lines.slice(idx, idx + 5).join("\n");
      expect(window).toMatch(/<PrivateText>\s*\{w\}\s*<\/PrivateText>/);
    }
  });

  it("does not render a bare unwrapped {w} anywhere in the component", () => {
    const bareW = /(?<!<PrivateText>\s*)\{w\}(?!\s*<\/PrivateText>)/;
    expect(bareW.test(source)).toBe(false);
  });
});
