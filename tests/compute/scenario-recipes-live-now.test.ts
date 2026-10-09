/**
 * Tests for matchScenariosToThemes + GET /api/compute/scenarios' active-themes wiring.
 *
 * The theme-matching logic is pure and needs no DB. The route-level test uses
 * an in-memory SQLite database to avoid touching the real data/vanguard.db —
 * the route module uses `import { db } from "@/lib/db"`, so we mock that
 * module before importing the route handler (pattern: tests/api/settings-email-recipients.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { matchScenariosToThemes, SCENARIO_RECIPES } from "@/lib/compute/scenario-recipes";

// ── Shared mock — replace the `db` singleton with an in-memory DB ──────────
// Only used by the route-level describe block below; the pure-function
// tests above never touch @/lib/db.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

describe("matchScenariosToThemes", () => {
  it("returns scenarios unchanged when themes is empty", () => {
    const r = matchScenariosToThemes(SCENARIO_RECIPES, []);
    expect(r.every((s) => s.liveNowReason === undefined)).toBe(true);
  });

  it("decorates Tariff scenario when a tariff_exposure risk-off theme is active", () => {
    const r = matchScenariosToThemes(SCENARIO_RECIPES, [
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const tariffScenarios = r.filter((s) => s.primaryFactor === "tariff_exposure");
    expect(tariffScenarios.length).toBeGreaterThan(0);
    expect(tariffScenarios[0].liveNowReason).toMatch(/Tariff escalation/);
  });

  it("does not decorate scenarios whose factor doesn't match any active theme", () => {
    const r = matchScenariosToThemes(SCENARIO_RECIPES, [
      { name: "AI mania cooling", factor_label: "ai_exposure", direction: "risk-off",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const ratesScenarios = r.filter((s) => s.primaryFactor === "interest_rate_sensitive");
    expect(ratesScenarios.every((s) => s.liveNowReason === undefined)).toBe(true);
  });
});

describe("matchScenariosToThemes direction compatibility", () => {
  const theme = (name: string, factor_label: string, direction: string) => ({
    name, factor_label, direction, summary: "x", exposure_bucket: "moderate", top_contributors: [],
  });
  const downside = SCENARIO_RECIPES.filter((s) => s.shockMagnitude < 0);
  const upside = SCENARIO_RECIPES.filter((s) => s.shockMagnitude > 0);

  it("covers both an upside and a downside recipe", () => {
    expect(downside.length).toBeGreaterThan(0);
    expect(upside.length).toBeGreaterThan(0);
  });

  it("a risk-on (rally) theme never marks a downside scenario live", () => {
    const factors = new Set(downside.map((s) => s.primaryFactor));
    const themes = [...factors].map((f) => theme("Rally " + f, f, "risk-on"));
    const r = matchScenariosToThemes(SCENARIO_RECIPES, themes);
    for (const s of r.filter((x) => x.shockMagnitude < 0)) expect(s.liveNowReason).toBeUndefined();
  });

  it("a risk-off theme never marks an upside scenario live", () => {
    const themes = upside.map((s) => theme("Selloff " + s.primaryFactor, s.primaryFactor, "risk-off"));
    const r = matchScenariosToThemes(SCENARIO_RECIPES, themes);
    for (const s of r.filter((x) => x.shockMagnitude > 0)) expect(s.liveNowReason).toBeUndefined();
  });

  it("risk-on marks a matching upside scenario; risk-off marks a matching downside one", () => {
    const up = upside[0];
    const down = downside[0];
    const r = matchScenariosToThemes(SCENARIO_RECIPES, [
      theme("Up theme", up.primaryFactor, "risk-on"),
      theme("Down theme", down.primaryFactor, "risk-off"),
    ]);
    expect(r.find((s) => s.id === up.id)?.liveNowReason).toMatch(/Up theme/);
    expect(r.find((s) => s.id === down.id)?.liveNowReason).toMatch(/Down theme/);
  });

  it("a neutral theme matches both directions", () => {
    for (const rec of [upside[0], downside[0]]) {
      const r = matchScenariosToThemes(SCENARIO_RECIPES, [theme("Flat view", rec.primaryFactor, "neutral")]);
      expect(r.find((s) => s.id === rec.id)?.liveNowReason).toMatch(/Flat view/);
    }
  });

  it("names every matching theme", () => {
    const rec = downside[0];
    const r = matchScenariosToThemes(SCENARIO_RECIPES, [
      theme("First theme", rec.primaryFactor, "risk-off"),
      theme("Rally theme", rec.primaryFactor, "risk-on"),
      theme("Second theme", rec.primaryFactor, "neutral"),
    ]);
    const reason = r.find((s) => s.id === rec.id)?.liveNowReason ?? "";
    expect(reason).toContain("First theme");
    expect(reason).toContain("Second theme");
    expect(reason).not.toContain("Rally theme");
  });
});

describe("/api/compute/scenarios decorates recipes when themes are cached", () => {
  it("attaches liveNowReason to scenarios matching an active theme's factor_label", async () => {
    const { db } = await import("@/lib/db");
    const { upsertMacroThemes } = await import("@/lib/queries/analysis-macro-themes");
    const { mondayOf } = await import("@/lib/calendar/date-utils");

    const today = new Date().toISOString().slice(0, 10);
    const weekOf = mondayOf(today);
    upsertMacroThemes(db, {
      scope: "all",
      weekOf,
      themesJson: JSON.stringify([{
        name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x".repeat(20), exposure_bucket: "moderate", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });

    const { GET } = await import("@/app/api/compute/scenarios/route");
    const req = new Request("http://localhost/api/compute/scenarios?accountId=1");
    const res = await GET(req as any);
    const body = await res.json();

    const tariffScenario = body.data?.find((s: any) => s.scenario?.primaryFactor === "tariff_exposure");
    expect(tariffScenario?.liveNowReason).toMatch(/Tariff escalation/);
  });
});

describe("/api/compute/scenarios live-now badge is scope independent", () => {
  it("shows the same badge for every scope, reading the 'all' themes", async () => {
    const { db } = await import("@/lib/db");
    const { upsertMacroThemes } = await import("@/lib/queries/analysis-macro-themes");
    const { mondayOf, todayET } = await import("@/lib/calendar/date-utils");
    upsertMacroThemes(db, {
      scope: "all",
      weekOf: mondayOf(todayET()),
      themesJson: JSON.stringify([{
        name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x".repeat(20), exposure_bucket: "moderate", top_contributors: [],
      }]),
      sourceSummary: null, modelUsed: "v1",
    });
    const { GET } = await import("@/app/api/compute/scenarios/route");
    const badges: Array<Array<string | undefined>> = [];
    for (const q of ["scope=all", "scope=vanguard", "scope=ibkr", "accountId=1"]) {
      const res = await GET(new Request("http://localhost/api/compute/scenarios?" + q) as any);
      const body = await res.json();
      badges.push(body.data.map((s: any) => s.liveNowReason));
    }
    expect(badges[0].some((b) => b)).toBe(true);
    for (const b of badges) expect(b).toEqual(badges[0]);
  });

  it("shows no badge when no 'all' themes are cached", async () => {
    const { GET } = await import("@/app/api/compute/scenarios/route");
    const res = await GET(new Request("http://localhost/api/compute/scenarios?scope=ibkr") as any);
    const body = await res.json();
    expect(body.data.every((s: any) => !s.liveNowReason)).toBe(true);
  });
});
