import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { renderMacroThemesMarkdown } from "@/lib/digest/macro-themes-markdown";

describe("send-briefing macro-themes pre-gen smoke", () => {
  it("caches an empty themes row when no signal exists", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const { generateMacroThemes } = await import("@/lib/compute/macro-themes");
    const r = await generateMacroThemes(db, { scope: "all", weekOf: "2026-05-04" });
    expect(r.underThreshold).toBe(true);
    expect(r.themes).toEqual([]);
    const cached = getCachedMacroThemes(db, "all", "2026-05-04");
    expect(cached).not.toBeNull();
    expect(cached!.themesJson).toBe("[]");
  });
});

describe("send-briefing read-through to cache", () => {
  it("renders themes from the cache that the pre-gen step writes", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const themes = [{
      name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off" as const,
      summary: "Trade headlines pushed risk lower.", exposure_bucket: "high" as const,
      top_contributors: [{ symbol: "AAPL", weight: 0.04 }],
    }];
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: JSON.stringify(themes), sourceSummary: null, modelUsed: "v1",
    });
    const md = renderMacroThemesMarkdown(themes);
    expect(md).not.toBeNull();
    expect(md!).toContain("Tariff escalation");
  });
});
