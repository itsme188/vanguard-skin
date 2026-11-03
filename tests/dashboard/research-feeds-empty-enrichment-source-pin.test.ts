import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");

describe("ResearchFeedsView empty enrichment", () => {
  it("uses the shared emptiness helper", () => {
    expect(src).toMatch(/emptyEnrichmentLabel[\s\S]*?from\s+"@\/lib\/research\/empty-enrichment"/);
  });
  it("shows no sentiment chip and no fake neutral border for an empty card", () => {
    // feedCardEmptyLabel wraps the shared helper and only swaps its words for
    // an article never summarised by design (owner ruling 2026-11-02).
    expect(src).toMatch(/const emptyLabel = feedCardEmptyLabel\(article\)/);
    expect(src).toMatch(/function feedCardEmptyLabel[\s\S]*?const label = emptyEnrichmentLabel\(article\)/);
    expect(src).toMatch(/\{!emptyLabel && <SentimentBadge sentiment=\{article\.sentiment\} \/>\}/);
    expect(src).toMatch(/emptyLabel \|\| !article\.sentiment/);
  });
  it("renders the label", () => {
    expect(src).toMatch(/\{emptyLabel &&/);
  });
});
