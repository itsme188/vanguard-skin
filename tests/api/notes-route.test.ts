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
