/**
 * The Documents filters (search box, symbol box, type select) had only a
 * placeholder, which is not an accessible name
 * (qa:dashboard-research-view-documents-document-filters-documents-type-filter-select-has-no-accessible-name).
 * Source pin: each control carries an aria-label.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ResearchDocumentsView.tsx", "utf8");

function controlRegion(placeholderOrValue: string): string {
  const at = anchorIndex(src, placeholderOrValue, 0, `filter control ${placeholderOrValue}`);
  return src.slice(Math.max(0, at - 200), at + 200);
}

describe("Documents filter controls carry accessible names", () => {
  it("search box", () => {
    expect(controlRegion('placeholder="Search documents…"')).toContain('aria-label="Search documents"');
  });
  it("symbol box", () => {
    expect(controlRegion('placeholder="Symbol"')).toContain('aria-label="Symbol"');
  });
  it("document type select", () => {
    expect(controlRegion("value={documentType}")).toContain('aria-label="Document type"');
  });
});
