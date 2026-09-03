import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts). Following the static-scan
// precedent in tests/dashboard/data-confidence-indicator-privacy.test.ts, this
// test scans the component source for the fix idiom instead of rendering it.
//
// QA finding `research-digest-preview-modal--title-truncated-mobile-regression-2`:
// at 390px the modal header's title <h2> ("Morning Research Digest") measured
// clientWidth 53 of scrollWidth 159 with a null `title` attribute — the
// Structured / By publication / By company chip row (all `shrink-0`) squeezed
// it down to 5 visible characters ("Morni…") with no way to read the rest.
// The header row also lacked `flex-wrap`, so the chip row could never drop
// to a second line to give the title breathing room.

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/DigestEmailViewer.tsx",
);

describe("DigestEmailViewer modal title survives narrow viewports", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("carries a title attribute with the full heading text", () => {
    expect(source).toMatch(
      /<h2[^>]*\btitle="Morning Research Digest"[^>]*>\s*Morning Research Digest\s*<\/h2>/
    );
  });

  it("lets the header row wrap so the chip row can drop below the title on narrow viewports", () => {
    const headerRowMatch = source.match(
      /className="sticky top-0 z-10 flex ([^"]*)"/
    );
    expect(headerRowMatch, "header row div not found").not.toBeNull();
    expect(headerRowMatch![1]).toMatch(/\bflex-wrap\b/);
  });
});
