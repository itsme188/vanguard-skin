import { describe, it, expect } from "vitest";
import { isEmptyEnrichment, emptyEnrichmentLabel } from "@/lib/research/empty-enrichment";

describe("isEmptyEnrichment", () => {
  it("is empty for blank summary and no themes", () => {
    expect(isEmptyEnrichment("", [])).toBe(true);
    expect(isEmptyEnrichment("  ", "[]")).toBe(true);
    expect(isEmptyEnrichment(null, null)).toBe(true);
  });
  it("is not empty with a summary or a theme", () => {
    expect(isEmptyEnrichment("Real text", [])).toBe(false);
    expect(isEmptyEnrichment("", '["fed"]')).toBe(false);
    expect(isEmptyEnrichment("", ["fed"])).toBe(false);
  });
  it("does not treat malformed theme JSON as empty", () => {
    expect(isEmptyEnrichment("", "{oops")).toBe(false);
  });
});

describe("emptyEnrichmentLabel", () => {
  it("labels by processed state and is null when enriched", () => {
    expect(emptyEnrichmentLabel({ summary: "", key_themes: "[]", processed_at: null })).toBe("Enrichment pending");
    expect(emptyEnrichmentLabel({ summary: "", key_themes: "[]", processed_at: "2026-10-01" })).toBe("No summary yet");
    expect(emptyEnrichmentLabel({ summary: "x", key_themes: "[]", processed_at: null })).toBeNull();
  });
});
