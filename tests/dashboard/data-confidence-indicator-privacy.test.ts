import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts). Following the static-scan
// precedent in tests/api/no-state-changing-get.test.ts and
// tests/calendar/reaction-snapshot-core.test.ts, this test scans the component
// source for the masking idiom instead of rendering it.
//
// Regression covered: an earlier fix wrapped DimensionBar's `detail`/`guidance`
// (portfolio-derived prose) in <PrivateText>, but the Actions section's
// ActionRow — which renders `action.message`/`action.fix` from
// getDataActions() in lib/queries/data-confidence.ts (held-security counts,
// tickers, account names) — was missed and stayed unmasked in privacy mode.

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/DataConfidenceIndicator.tsx",
);

function actionRowBody(source: string): string {
  const start = source.indexOf("function ActionRow(");
  expect(start, "ActionRow function not found in DataConfidenceIndicator.tsx").toBeGreaterThan(-1);
  // ActionRow is the last function in the file — read to EOF.
  return source.slice(start);
}

describe("DataConfidenceIndicator ActionRow masks portfolio-derived text (privacy mode)", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("imports PrivateText from the privacy components module", () => {
    expect(source).toMatch(/import\s*\{[^}]*PrivateText[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/);
  });

  it("wraps action.message in <PrivateText> (held-security counts / account names)", () => {
    const body = actionRowBody(source);
    expect(body).toMatch(/<PrivateText>\s*\{action\.message\}\s*<\/PrivateText>/);
  });

  it("wraps action.fix in <PrivateText> (held tickers embedded in the fix instructions)", () => {
    const body = actionRowBody(source);
    expect(body).toMatch(/<PrivateText>\s*\{action\.fix\}\s*<\/PrivateText>/);
  });

  it("does not render action.message or action.fix as bare, unwrapped JSX expressions", () => {
    const body = actionRowBody(source);
    // A bare {action.message} or {action.fix} NOT immediately preceded by
    // <PrivateText> would mean the value renders in the clear.
    const bareMessage = /(?<!<PrivateText>\s*)\{action\.message\}/;
    const bareFix = /(?<!<PrivateText>\s*)\{action\.fix\}/;
    expect(bareMessage.test(body)).toBe(false);
    expect(bareFix.test(body)).toBe(false);
  });
});
