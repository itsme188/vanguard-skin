import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { currentThemeWeek, themeWeeksToRead } from "@/lib/compute/theme-week";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";

// Sunday 2026-10-11 21:30 ET = Monday 2026-10-12 01:30 UTC
const SUN_2130_ET = new Date("2026-10-12T01:30:00Z");
const SUN_2200_ET = new Date("2026-10-12T02:00:00Z");
const NEXT_SAT = new Date("2026-10-17T16:00:00Z");

describe("currentThemeWeek", () => {
  it("returns the Monday of the Eastern week, not the UTC week", () => {
    expect(currentThemeWeek(SUN_2130_ET)).toBe("2026-10-05");
    expect(new Date(SUN_2130_ET).toISOString().slice(0, 10)).toBe("2026-10-12");
  });
  it("rolls to the new week on Monday Eastern", () => {
    expect(currentThemeWeek(new Date("2026-10-12T14:00:00Z"))).toBe("2026-10-12");
  });
  it("a theme written Sunday 21:30 ET is found at 22:00 ET and the next Saturday", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(analysis_macro_themes)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    expect(cols.length).toBeGreaterThan(0);
    const week = currentThemeWeek(SUN_2130_ET);
    const row: Record<string, unknown> = { scope: "all", week_of: week, themes_json: "[]" };
    for (const c of cols) {
      if (c.notnull && c.dflt_value == null && !(c.name in row) && c.name !== "id") row[c.name] = c.name.includes("count") ? 0 : "x";
    }
    const names = Object.keys(row);
    db.prepare(`INSERT INTO analysis_macro_themes (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((n) => row[n]));
    expect(getCachedMacroThemes(db, "all", currentThemeWeek(SUN_2200_ET))).not.toBeNull();
    // Saturday of the NEXT Eastern week is a different key (Monday 10-12 week)
    expect(currentThemeWeek(NEXT_SAT)).toBe("2026-10-12");
    // Same-week Saturday finds it
    expect(getCachedMacroThemes(db, "all", currentThemeWeek(new Date("2026-10-10T16:00:00Z")))).not.toBeNull();
  });
});

describe("themeWeeksToRead", () => {
  it("on a weekday is just the current week", () => {
    expect(themeWeeksToRead(new Date("2026-10-07T16:00:00Z"))).toEqual(["2026-10-05"]);
  });
  it("on a Saturday or Sunday prefers the upcoming week, then the one ending", () => {
    expect(themeWeeksToRead(new Date("2026-10-10T16:00:00Z"))).toEqual(["2026-10-12", "2026-10-05"]);
    expect(themeWeeksToRead(SUN_2130_ET)).toEqual(["2026-10-12", "2026-10-05"]);
  });
  it("Monday 00:30 ET reads the new week only", () => {
    expect(themeWeeksToRead(new Date("2026-10-12T04:30:00Z"))).toEqual(["2026-10-12"]);
  });
});

