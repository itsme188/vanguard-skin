/**
 * /api/analysis/macro-themes after the shared-week change (2026-11-15, I1):
 * the paid-call limits are per theme week (one call writes every scope), a
 * reuse of the week's reply is not limited, and GET recomputes the exposure
 * figures without writing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { getCachedMacroThemes, upsertMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { currentThemeWeek } from "@/lib/compute/theme-week";
import { themesGeneratedLabel } from "@/app/dashboard/components/analysis/MacroOverlayCard";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));
vi.mock("@/lib/compute/factors", () => ({ computeFactorAnalysis: vi.fn() }));
import { computeFactorAnalysis } from "@/lib/compute/factors";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.mocked(computeFactorAnalysis).mockReset();
  vi.mocked(computeFactorAnalysis).mockReturnValue({ tilts: [] } as never);
});

const THEME = {
  name: "Shared theme", factor_label: "ai_exposure", direction: "risk-on",
  summary: "Synthetic summary of a theme for the week.", exposure_bucket: "low",
  exposure_pct: 5, exposure_rank: null, top_contributors: [],
};

function post(scope: string) {
  return new Request("http://localhost/api/analysis/macro-themes", {
    method: "POST",
    body: JSON.stringify({ scope }),
    headers: { "Content-Type": "application/json" },
  }) as unknown as NextRequest;
}

const OK = { themes: [], sourceSummary: null, fromCache: false, generatedAt: "2026-05-04 12:00:00", underThreshold: true };

describe("POST limits are per theme week", () => {
  it("a paid generation for one scope 429s a paid generation for another scope the same day", async () => {
    const macroThemes = await import("@/lib/compute/macro-themes");
    const spy = vi.spyOn(macroThemes, "generateMacroThemes").mockResolvedValue(OK);
    try {
      const { POST, __resetMacroRegenLimitForTests } = await import("@/app/api/analysis/macro-themes/route");
      __resetMacroRegenLimitForTests();
      expect((await POST(post("all"))).status).toBe(200);
      const res = await POST(post("ibkr"));
      expect(res.status).toBe(429);
      expect((await res.json()).reason).toBe("daily");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a scope with no row reuses the week's reply with no AI call, even inside the daily window", async () => {
    const { POST, __resetMacroRegenLimitForTests } = await import("@/app/api/analysis/macro-themes/route");
    const ai = await import("@/lib/ai/generate");
    const aiSpy = vi.spyOn(ai, "generateTextForFeature");
    try {
      __resetMacroRegenLimitForTests();
      const week = currentThemeWeek();
      upsertMacroThemes(hoisted.db, {
        scope: "all", weekOf: week, themesJson: JSON.stringify([THEME]), sourceSummary: null, modelUsed: "m",
      });
      const macroThemes = await import("@/lib/compute/macro-themes");
      // Burn the week's paid window with a mocked generation for "all".
      const genSpy = vi.spyOn(macroThemes, "generateMacroThemes").mockResolvedValueOnce(OK);
      expect((await POST(post("all"))).status).toBe(200);
      genSpy.mockRestore();

      const res = await POST(post("roth"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.themes.map((t: { name: string }) => t.name)).toEqual(["Shared theme"]);
      expect(getCachedMacroThemes(hoisted.db, "roth", week)).not.toBeNull();
      expect(aiSpy).not.toHaveBeenCalled();
    } finally {
      aiSpy.mockRestore();
    }
  });
});

describe("GET recomputes exposure from current holdings and writes nothing", () => {
  it("returns today's figure, not the stored one, plus generatedAt", async () => {
    const { GET } = await import("@/app/api/analysis/macro-themes/route");
    upsertMacroThemes(hoisted.db, {
      scope: "all", weekOf: "2026-05-04", themesJson: JSON.stringify([THEME]), sourceSummary: null, modelUsed: "m",
    });
    const before = getCachedMacroThemes(hoisted.db, "all", "2026-05-04");
    vi.mocked(computeFactorAnalysis).mockReturnValue({
      tilts: [{ factor: "ai_exposure", exposurePct: 40, topContributors: [{ symbol: "ZZA", weight: 3 }] }],
    } as never);
    const res = await GET(new Request("http://localhost/api/analysis/macro-themes?scope=all&week=2026-05-04") as unknown as NextRequest);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.themes[0].exposure_pct).toBe(40);
    expect(body.themes[0].top_contributors).toEqual([{ symbol: "ZZA", weight: 3 }]);
    expect(body.generatedAt).toBe(before!.generatedAt);
    expect(getCachedMacroThemes(hoisted.db, "all", "2026-05-04")).toEqual(before);
  });
});

describe("the card shows when the themes were generated", () => {
  it("formats the stored UTC time as the Eastern day", () => {
    // 2026-05-05 02:30 UTC is still 2026-05-04 in New York.
    expect(themesGeneratedLabel("2026-05-05 02:30:00")).toBe("themes generated 2026-05-04");
    expect(themesGeneratedLabel("2026-05-05T15:00:00.000Z")).toBe("themes generated 2026-05-05");
    expect(themesGeneratedLabel(undefined)).toBeNull();
    expect(themesGeneratedLabel("not a date")).toBeNull();
  });

  it("the header renders the label instead of cached / fresh", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/dashboard/components/analysis/MacroOverlayCard.tsx"), "utf8");
    const header = src.slice(anchorIndex(src, "<h3 className=\"text-sm font-medium text-ink\">Macro this week</h3>"));
    const end = header.indexOf("</header>");
    expect(header.slice(0, end)).toContain("themesGeneratedLabel(data?.generatedAt)");
    expect(header.slice(0, end)).not.toMatch(/"cached"|"fresh"/);
  });
});
