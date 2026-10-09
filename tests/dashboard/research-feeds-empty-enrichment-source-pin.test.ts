import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");

describe("ResearchFeedsView empty enrichment", () => {
  it("uses the shared emptiness helper", () => {
    expect(src).toMatch(/emptyEnrichmentLabel[\s\S]*?from\s+"@\/lib\/research\/empty-enrichment"/);
  });
  it("shows no sentiment chip and no fake neutral border for an empty card", () => {
    expect(src).toMatch(/const emptyLabel = emptyEnrichmentLabel\(article\)/);
    expect(src).toMatch(/\{!emptyLabel && <SentimentBadge sentiment=\{article\.sentiment\} \/>\}/);
    expect(src).toMatch(/emptyLabel \|\| !article\.sentiment/);
  });
  it("renders the label", () => {
    expect(src).toMatch(/\{emptyLabel &&/);
  });
});
