import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts). Following the static-scan
// precedent in tests/dashboard/data-confidence-indicator-privacy.test.ts, this
// test scans the component source for the masking idiom instead of rendering it.
//
// Regression covered: the "previously-imported donations are absent" warning
// and the identity-conflict block in the import preview both render the raw
// daf-contributions source key verbatim — e.g.
// "daf:contribution:2026-08-13:USD:10000:2026-08-12 21:30:45 +0000" — which
// embeds a dollar amount and a share/unit count. Privacy mode masks nothing
// here today because neither block goes through <PrivateText>/<Money>/<Shares>.

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ImportFlow.tsx",
);

describe("ImportFlow donation reversal/identity-conflict warnings mask under privacy mode", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("imports PrivateText from the privacy components module", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*PrivateText[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/
    );
  });

  it("wraps the absent-prior-row source key in <PrivateText>", () => {
    expect(source).toMatch(
      /<PrivateText>\s*\{key\}\s*<\/PrivateText>/
    );
  });

  it("wraps the identity-conflict source key + field in <PrivateText>", () => {
    expect(source).toMatch(
      /<PrivateText>\s*\{c\.sourceKey\}\s*—\s*\{c\.field\}\s*<\/PrivateText>/
    );
  });

  it("does not render either key as a bare, unwrapped JSX expression", () => {
    const bareAbsentKey = /(?<!<PrivateText>\s*)\{key\}(?!\s*<\/PrivateText>)/;
    const bareConflictKey = /(?<!<PrivateText>\s*)\{c\.sourceKey\}/;
    expect(bareAbsentKey.test(source)).toBe(false);
    expect(bareConflictKey.test(source)).toBe(false);
  });
});
