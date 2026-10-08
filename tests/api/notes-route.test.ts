/**
 * HTTP-boundary tests for /api/notes — the empty-string event_date coercion
 * shipped in aca3759:
 *   - POST falls back to todayET() on any falsy event_date ("", null,
 *     omitted) — a cleared date input submits "" and an empty-string
 *     event_date renders an "undefined NaN," date header and sorts last.
 *   - PUT maps "" to undefined so an edit can never blank a stored date
 *     (updateNote skips undefined fields).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { todayET } from "@/lib/calendar/date-utils";
import { createNote, updateNote } from "@/lib/mutations/notes";
import type { Note } from "@/lib/types";

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

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/notes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/notes", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function seedNote(eventDate: string): Note {
  return createNote(hoisted.db, {
    note_type: "journal",
    content: "Original content",
    event_date: eventDate,
  });
}

type Envelope = { success: boolean; data?: Note; error?: string };

describe("POST /api/notes — event_date coercion", () => {
  it("stores today's ET date when event_date is an empty string", async () => {
    const mod = await import("@/app/api/notes/route");
    const res = await mod.POST(
      postReq({ note_type: "journal", content: "Cleared date input", event_date: "" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data!.event_date).toBe(todayET());
    // Never persist the empty string itself
    expect(body.data!.event_date).not.toBe("");
  });

  it("stores today's ET date when event_date is omitted", async () => {
    const mod = await import("@/app/api/notes/route");
    const res = await mod.POST(
      postReq({ note_type: "journal", content: "No date field at all" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data!.event_date).toBe(todayET());
  });

  it("stores a real event_date as given", async () => {
    const mod = await import("@/app/api/notes/route");
    const res = await mod.POST(
      postReq({ note_type: "journal", content: "Backdated entry", event_date: "2026-03-10" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data!.event_date).toBe("2026-03-10");
  });
});

describe("PUT /api/notes — event_date coercion", () => {
  it("leaves the stored date unchanged when event_date is an empty string", async () => {
    const note = seedNote("2026-03-10");

    const mod = await import("@/app/api/notes/route");
    const res = await mod.PUT(
      putReq({ id: note.id, content: "Edited content", event_date: "" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    // The edit applies, the date survives
    expect(body.data!.content).toBe("Edited content");
    expect(body.data!.event_date).toBe("2026-03-10");
  });

  it("updates the stored date when a real event_date is given", async () => {
    const note = seedNote("2026-03-10");

    const mod = await import("@/app/api/notes/route");
    const res = await mod.PUT(
      putReq({ id: note.id, event_date: "2026-04-01" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data!.event_date).toBe("2026-04-01");
  });

  it("leaves the stored date unchanged when event_date is omitted", async () => {
    const note = seedNote("2026-03-10");

    const mod = await import("@/app/api/notes/route");
    const res = await mod.PUT(
      putReq({ id: note.id, content: "Only content changed" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data!.event_date).toBe("2026-03-10");
  });
});

describe("updateNote — undefined-skip seam the PUT coercion relies on", () => {
  it("skips event_date when undefined, updating only the given fields", () => {
    const note = seedNote("2026-03-10");

    const updated = updateNote(hoisted.db, note.id, {
      content: "New content",
      event_date: undefined,
    });

    expect(updated!.content).toBe("New content");
    expect(updated!.event_date).toBe("2026-03-10");
  });

  it("documents that a raw empty string WOULD blank the date — the route coercion is the guard", () => {
    // updateNote itself does not filter "": it only skips undefined. This is
    // why the route maps "" -> undefined before calling it. If this behavior
    // ever changes (mutation-level filtering), the route comment should move.
    const note = seedNote("2026-03-10");

    const updated = updateNote(hoisted.db, note.id, { event_date: "" });

    expect(updated!.event_date).toBe("");
  });
});

describe("PUT /api/notes — note_type and security_id persistence", () => {
  async function put(body: unknown) {
    const { PUT } = await import("@/app/api/notes/route");
    const res = await PUT(putReq(body));
    return { status: res.status, json: (await res.json()) as Envelope };
  }
  function seedSecurity(symbol: string): number {
    return Number(
      hoisted.db
        .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
        .run(symbol, symbol).lastInsertRowid
    );
  }
  function row(id: number) {
    return hoisted.db.prepare("SELECT note_type, security_id FROM notes WHERE id = ?").get(id) as {
      note_type: string;
      security_id: number | null;
    };
  }

  it("changes the type only", async () => {
    const aaa = seedSecurity("AAA");
    const n = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02", security_id: aaa });
    const r = await put({ id: n.id, note_type: "trade_thesis" });
    expect(r.status).toBe(200);
    expect(row(n.id)).toEqual({ note_type: "trade_thesis", security_id: aaa });
  });

  it("changes the security only", async () => {
    const aaa = seedSecurity("AAA");
    const zzz = seedSecurity("ZZZ");
    const n = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02", security_id: aaa });
    const r = await put({ id: n.id, security_id: zzz });
    expect(r.status).toBe(200);
    expect(row(n.id)).toEqual({ note_type: "journal", security_id: zzz });
  });

  it("clears the security with null", async () => {
    const aaa = seedSecurity("AAA");
    const n = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02", security_id: aaa });
    const r = await put({ id: n.id, security_id: null });
    expect(r.status).toBe(200);
    expect(row(n.id).security_id).toBeNull();
  });

  it("rejects an invalid type with 400 and writes nothing", async () => {
    const aaa = seedSecurity("AAA");
    const n = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02", security_id: aaa });
    const r = await put({ id: n.id, content: "changed", note_type: "bogus" });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(row(n.id)).toEqual({ note_type: "journal", security_id: aaa });
    expect(hoisted.db.prepare("SELECT content FROM notes WHERE id = ?").get(n.id)).toEqual({ content: "x" });
  });

  it("rejects a malformed security_id with 400", async () => {
    const n = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02" });
    for (const bad of [0, -3, 1.5, "7"]) {
      const r = await put({ id: n.id, security_id: bad });
      expect(r.status).toBe(400);
    }
  });

  it("answers 404 for an unknown security and writes nothing", async () => {
    const n = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02" });
    const r = await put({ id: n.id, content: "changed", security_id: 99999 });
    expect(r.status).toBe(404);
    expect(row(n.id)).toEqual({ note_type: "journal", security_id: null });
    expect(hoisted.db.prepare("SELECT content FROM notes WHERE id = ?").get(n.id)).toEqual({ content: "x" });
  });

  it("leaves both untouched when neither key is sent", async () => {
    const aaa = seedSecurity("AAA");
    const n = createNote(hoisted.db, { note_type: "earnings", content: "x", event_date: "2026-01-02", security_id: aaa });
    const r = await put({ id: n.id, content: "edited" });
    expect(r.status).toBe(200);
    expect(row(n.id)).toEqual({ note_type: "earnings", security_id: aaa });
  });
});
