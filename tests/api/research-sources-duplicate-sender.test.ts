/**
 * B32 — /api/research/sources refuses a sender_email that case-insensitively
 * matches another ACTIVE source (a silent duplicate double-fetches every
 * newsletter). Synthetic addresses only.
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

import { POST, PATCH } from "@/app/api/research/sources/route";

let db: Database.Database;

function req(method: string, body: unknown): Request {
  return new Request("http://localhost/api/research/sources", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seed(name: string, email: string | null, active = 1): number {
  const r = db
    .prepare(`INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, ?)`)
    .run(name, email, active);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.prepare(`DELETE FROM research_sources`).run();
  hoisted.db = db;
});

describe("POST duplicate sender_email", () => {
  it("rejects an exact match of an active source with 409 naming it", async () => {
    seed("Alpha Letter", "news@alpha.example");
    const res = await POST(req("POST", { name: "Alpha Two", sender_email: "news@alpha.example" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Alpha Letter");
    expect(db.prepare(`SELECT COUNT(*) c FROM research_sources`).get()).toEqual({ c: 1 });
  });

  it("matches case-insensitively and ignores surrounding whitespace", async () => {
    seed("Alpha Letter", "news@alpha.example");
    const res = await POST(req("POST", { name: "X", sender_email: "  News@Alpha.EXAMPLE " }));
    expect(res.status).toBe(409);
  });

  it("allows the address when the existing source is inactive", async () => {
    seed("Old Alpha", "news@alpha.example", 0);
    const res = await POST(req("POST", { name: "New Alpha", sender_email: "news@alpha.example" }));
    expect(res.status).toBe(200);
  });

  it("allows a different address", async () => {
    seed("Alpha Letter", "news@alpha.example");
    const res = await POST(req("POST", { name: "Beta", sender_email: "hello@beta.example" }));
    expect(res.status).toBe(200);
  });
});

describe("PATCH duplicate sender_email", () => {
  it("rejects changing a source to another active source's address", async () => {
    seed("Alpha Letter", "news@alpha.example");
    const b = seed("Beta", "hello@beta.example");
    const res = await PATCH(req("PATCH", { id: b, sender_email: "NEWS@alpha.example" }));
    expect(res.status).toBe(409);
    const row = db.prepare(`SELECT sender_email FROM research_sources WHERE id=?`).get(b);
    expect(row).toEqual({ sender_email: "hello@beta.example" });
  });

  it("allows re-saving a source's own address", async () => {
    const a = seed("Alpha Letter", "news@alpha.example");
    const res = await PATCH(req("PATCH", { id: a, sender_email: "news@alpha.example" }));
    expect(res.status).toBe(200);
  });

  it("allows moving an INACTIVE source onto an active address", async () => {
    seed("Alpha Letter", "news@alpha.example");
    const b = seed("Beta", "hello@beta.example", 0);
    const res = await PATCH(req("PATCH", { id: b, sender_email: "news@alpha.example" }));
    expect(res.status).toBe(200);
  });

  it("rejects reactivating a source whose address an active source now holds", async () => {
    seed("Alpha Letter", "news@alpha.example");
    const b = seed("Old Alpha", "news@alpha.example", 0);
    const res = await PATCH(req("PATCH", { id: b, is_active: 1 }));
    expect(res.status).toBe(409);
    expect(db.prepare(`SELECT is_active FROM research_sources WHERE id=?`).get(b)).toEqual({ is_active: 0 });
  });

  it("still deactivates freely", async () => {
    const a = seed("Alpha Letter", "news@alpha.example");
    const res = await PATCH(req("PATCH", { id: a, is_active: 0 }));
    expect(res.status).toBe(200);
  });
});
