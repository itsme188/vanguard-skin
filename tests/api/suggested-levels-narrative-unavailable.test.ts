/**
 * QA finding security-detail-suggested-levels--narrative-ai-failure-swallowed-
 * no-marker-regression-1: when the narrative AI call fails (the live case was
 * an account out of credit), POST /api/suggested-levels answered 200 with
 * `narrative: null` on every level and nothing to tell a failure from "not
 * generated yet". The cards then showed a chip and a blank.
 *
 * The POST is the generation path, so a null narrative AFTER it is a failed
 * (or empty) generation: the route marks that level `narrativeUnavailable`.
 * GET stays a cache read and never sets the marker — a null there only means
 * the POST has not run yet.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  generate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("ai", () => ({
  jsonSchema: (s: unknown) => s,
}));

// The throwing AI seam.
vi.mock("@/lib/ai/generate", () => ({
  generateObjectForFeature: hoisted.generate,
}));

import { GET, POST } from "@/app/api/suggested-levels/route";

type Level = { price: number; narrative?: string | null; narrativeUnavailable?: boolean };

/** Pivot highs at 110 and lows at 90 around a price of 100. */
function seedSecurity(db: Database.Database): number {
  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, currency)
     VALUES ('AAA', 'AAA test', 'Stock', 'USD')`,
  ).run();
  const secId = (db.prepare("SELECT id FROM securities WHERE symbol = 'AAA'").get() as { id: number }).id;
  const insBar = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  for (let i = 0; i < 60; i++) {
    const phase = i % 10;
    const date = new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10);
    insBar.run(secId, date, 100, phase === 4 ? 110 : 103, phase === 9 ? 90 : 97, 100);
  }
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2025-03-01', 100, 'tws')",
  ).run(secId);
  return secId;
}

function request(secId: number) {
  return new Request(`http://localhost/api/suggested-levels?securityId=${secId}&narratives=1`) as never;
}

describe("POST /api/suggested-levels marks a failed narrative", () => {
  let secId: number;

  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("journal_mode = WAL");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    secId = seedSecurity(hoisted.db);
    hoisted.generate.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("flags every level when the AI call throws", async () => {
    hoisted.generate.mockRejectedValue(new Error("credit balance is too low"));
    const body = await (await POST(request(secId))).json();
    const levels = body.levels as Level[];

    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(level.narrative).toBeNull();
      expect(level.narrativeUnavailable).toBe(true);
    }
    expect(hoisted.generate).toHaveBeenCalledTimes(levels.length);
  });

  it("does not flag a level whose narrative was generated", async () => {
    hoisted.generate.mockResolvedValue({ object: { narrative: "Coincides with a prior gap." } });
    const body = await (await POST(request(secId))).json();
    const levels = body.levels as Level[];

    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(level.narrative).toBe("Coincides with a prior gap.");
      expect(level.narrativeUnavailable).toBe(false);
    }
  });

  it("flags only the levels that failed", async () => {
    hoisted.generate
      .mockRejectedValueOnce(new Error("upstream 500"))
      .mockResolvedValue({ object: { narrative: "Coincides with a prior gap." } });
    const body = await (await POST(request(secId))).json();
    const levels = body.levels as Level[];

    expect(levels.length).toBeGreaterThan(1);
    expect(levels.filter((l) => l.narrativeUnavailable).length).toBe(1);
    expect(levels.filter((l) => l.narrativeUnavailable).every((l) => l.narrative === null)).toBe(true);
  });

  it("GET never sets the marker: a null there means not generated yet", async () => {
    const body = await (await GET(request(secId))).json();
    const levels = body.levels as Level[];

    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(level.narrative).toBeNull();
      expect(level.narrativeUnavailable).toBeUndefined();
    }
    expect(hoisted.generate).not.toHaveBeenCalled();
  });
});
