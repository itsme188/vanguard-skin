import { describe, it, expect, vi } from "vitest";
import { upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";

describe("/api/analysis/macro-themes", () => {
  it("GET returns cache hit shape when present", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    const { db } = await import("@/lib/db");
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify([{
        name: "X", factor_label: "ai_exposure", direction: "risk-on",
        summary: "y".repeat(20), exposure_bucket: "low", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const req = new Request("http://localhost/api/analysis/macro-themes?scope=all&week=2026-05-04");
    const res = await GET(req as any);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.themes).toHaveLength(1);
  });

  it("GET returns 400 when scope missing", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    const req = new Request("http://localhost/api/analysis/macro-themes");
    const res = await GET(req as any);
    expect(res.status).toBe(400);
  });

  it("POST rate-limits to once per day per scope", async () => {
    // Mock generateMacroThemes so the first POST doesn't invoke a real Sonnet
    // call when ANTHROPIC_API_KEY is loaded into the test env. The test only
    // cares about the rate-limit semantics, not the AI output.
    const macroThemes = await import("@/lib/compute/macro-themes");
    const spy = vi
      .spyOn(macroThemes, "generateMacroThemes")
      .mockResolvedValue({
        themes: [],
        sourceSummary: null,
        fromCache: false,
        generatedAt: new Date().toISOString(),
        underThreshold: true,
      });
    try {
      const { POST, __resetMacroRegenLimitForTests } = await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      const make = () => new Request("http://localhost/api/analysis/macro-themes", {
        method: "POST",
        body: JSON.stringify({ scope: "all" }),
        headers: { "Content-Type": "application/json" },
      });
      await POST(make() as any);
      const res2 = await POST(make() as any);
      expect(res2.status).toBe(429);
    } finally {
      spy.mockRestore();
    }
  });
});
