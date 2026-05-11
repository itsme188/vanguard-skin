import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";

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
