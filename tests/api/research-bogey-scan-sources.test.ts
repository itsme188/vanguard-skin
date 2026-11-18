/**
 * GET / PUT /api/research/bogey-scan-sources: the per-source bogey-scan switch
 * (owner ruling 2026-11-18). Synthetic source names besides the defaults.
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

import { GET, PUT } from "@/app/api/research/bogey-scan-sources/route";

let db: Database.Database;

function put(body: unknown): Request {
  return new Request("http://localhost/api/research/bogey-scan-sources", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Listed = { id: number; name: string; is_active: number; mode: string };

async function list(): Promise<Listed[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.data.sources as Listed[];
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.prepare(`DELETE FROM research_sources`).run();
  db.prepare(
    `INSERT INTO research_sources (id, name, is_active) VALUES (21, 'TMT Breakout', 1), (22, 'FundaAI', 1), (23, 'Tape Letter', 0)`,
  ).run();
  hoisted.db = db;
});

describe("GET /api/research/bogey-scan-sources", () => {
  it("lists every source with its mode", async () => {
    const sources = await list();
    expect(sources).toHaveLength(3);
    const byId = new Map(sources.map((s) => [s.id, s]));
    expect(byId.get(21)).toMatchObject({ name: "TMT Breakout", is_active: 1, mode: "all" });
    expect(byId.get(22)).toMatchObject({ name: "FundaAI", mode: "previews" });
    expect(byId.get(23)).toMatchObject({ name: "Tape Letter", is_active: 0, mode: "off" });
  });
});

describe("PUT /api/research/bogey-scan-sources", () => {
  it("round-trips through GET", async () => {
    const res = await PUT(put({ sourceId: 23, mode: "previews" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { sourceId: 23, mode: "previews" } });
    const res2 = await PUT(put({ sourceId: 21, mode: "off" }));
    expect(res2.status).toBe(200);
    const byId = new Map((await list()).map((s) => [s.id, s.mode]));
    expect(byId.get(21)).toBe("off");
    expect(byId.get(22)).toBe("previews");
    expect(byId.get(23)).toBe("previews");
  });

  it("answers 400 for a mode outside the three, and stores nothing", async () => {
    const res = await PUT(put({ sourceId: 23, mode: "sometimes" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'bogey_scan_sources'`).get()).toEqual({ n: 0 });
  });

  it("answers 400 for a missing or non-integer source id and for unreadable JSON", async () => {
    for (const body of [{ mode: "all" }, { sourceId: "23", mode: "all" }, { sourceId: 2.5, mode: "all" }, { sourceId: -1, mode: "all" }, "{nope", null]) {
      const res = await PUT(put(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).success).toBe(false);
    }
  });

  it("answers 404 for an unknown source id", async () => {
    const res = await PUT(put({ sourceId: 999, mode: "all" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});
