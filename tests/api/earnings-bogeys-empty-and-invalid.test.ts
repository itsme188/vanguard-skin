/**
 * POST /api/earnings/bogeys refuses a save that would store nothing, and a
 * figure that is not a number (qa: empty-manual-bogey-saved-flips-chip,
 * unparseable-values-silently-dropped). Both used to answer 200 and leave an
 * all-empty row behind, which every "has bogeys" reader counted as coverage.
 *
 * Synthetic identifiers and round invented figures only: the repo is public.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;
let eventId: number;

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/earnings/bogeys/route");
  const res = await POST(
    new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const rows = () => db.prepare(`SELECT * FROM earnings_bogeys`).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  vi.resetModules();
  const info = db
    .prepare(
      `INSERT INTO calendar_events (event_date, event_type, title, symbol, source, source_key)
       VALUES ('2026-09-10','earnings','AAA Q3','AAA','manual','manual:AAA:earnings:2026-09-10')`,
    )
    .run();
  eventId = Number(info.lastInsertRowid);
});

describe("POST /api/earnings/bogeys — nothing to save", () => {
  it("refuses a body with no figure, guidance, note or metric, and stores nothing", async () => {
    const r = await post({ event_id: eventId });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(String(r.json.error)).toMatch(/^Nothing to save/);
    expect(rows()).toHaveLength(0);
  });

  it("a source label alone is still nothing to save", async () => {
    const r = await post({
      event_id: eventId,
      source_label: "desk sheet",
      eps_consensus: null,
      guidance_notes: "   ",
      notes: "",
      extra_metrics_json: null,
    });
    expect(r.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("refuses to blank a stored sheet through save, and leaves it as it was", async () => {
    expect((await post({ event_id: eventId, source_label: "desk sheet", eps_consensus: 1.5 })).status).toBe(200);
    const r = await post({ event_id: eventId, source_label: "desk sheet" });
    expect(r.status).toBe(400);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].eps_consensus).toBe(1.5);
  });

  it.each([
    ["a note alone", { notes: "watch the guide" }],
    ["guidance alone", { guidance_notes: "FY guide above the street" }],
    ["one figure", { revenue_consensus_usd: 2_000_000_000 }],
    ["a zero EPS", { eps_consensus: 0 }],
  ])("accepts %s", async (_name, fields) => {
    const r = await post({ event_id: eventId, ...fields });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(rows()).toHaveLength(1);
  });
});

describe("POST /api/earnings/bogeys — a figure that is not a number", () => {
  it.each([
    ["eps_consensus", "abc", /^EPS consensus must be a number/],
    ["eps_whisper", "0.50", /^EPS whisper must be a number/],
    ["revenue_consensus_usd", "3.85 billion", /^Revenue consensus must be a number/],
    ["revenue_whisper_usd", true, /^Revenue whisper must be a number/],
    ["expected_move_pct", "6%", /^Expected move must be a number/],
    ["expected_move_pct", 0, /^Expected move must be a percent above zero/],
    ["expected_move_pct", -6, /^Expected move must be a percent above zero/],
  ])("refuses %s = %j by name and stores nothing, even beside a valid note", async (key, value, message) => {
    const r = await post({ event_id: eventId, notes: "a real note", [key]: value });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(String(r.json.error)).toMatch(message);
    expect(rows()).toHaveLength(0);
  });

  it("refuses a non-string note", async () => {
    const r = await post({ event_id: eventId, eps_consensus: 1.5, notes: 7 });
    expect(r.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("still stores a valid expected move as typed", async () => {
    const r = await post({ event_id: eventId, expected_move_pct: 6 });
    expect(r.status).toBe(200);
    expect(rows()[0].expected_move_pct).toBe(6);
  });
});
