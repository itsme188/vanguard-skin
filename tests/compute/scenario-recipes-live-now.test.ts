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
