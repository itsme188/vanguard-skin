/**
 * GET /api/notes — ?type= and ?sentiment= filter coercion.
 *
 * Landing-review follow-up on PR #64 (f023761b): the research page fixed
 * this exact defect ("all" being cast straight through a `NoteType` filter
 * and matching zero rows), but the notes API route still did the untrusted
 * cast (`params.get("type") as NoteType | null`). GET /api/notes?type=all
 * therefore returned an empty list over a full notebook. Both params now go
 * through the shared coerceNoteType/coerceNoteSentiment helpers.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { createNote } from "@/lib/mutations/notes";
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

function getReq(query: string): NextRequest {
  return new NextRequest(`http://test/api/notes${query}`);
}

type Envelope = { success: boolean; data?: Note[]; error?: string };

describe("GET /api/notes — type filter coercion", () => {
  it("returns the full notebook (not an empty list) for ?type=all", async () => {
    createNote(hoisted.db, { note_type: "journal", content: "Journal entry", event_date: "2026-03-10" });
    createNote(hoisted.db, { note_type: "earnings", content: "Earnings note", event_date: "2026-03-11" });

    const mod = await import("@/app/api/notes/route");
    const res = await mod.GET(getReq("?type=all"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it("filters to a real note_type", async () => {
    createNote(hoisted.db, { note_type: "journal", content: "Journal entry", event_date: "2026-03-10" });
    createNote(hoisted.db, { note_type: "earnings", content: "Earnings note", event_date: "2026-03-11" });

    const mod = await import("@/app/api/notes/route");
    const res = await mod.GET(getReq("?type=journal"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data![0].note_type).toBe("journal");
  });

  it("returns the full notebook for an unrecognized type value", async () => {
    createNote(hoisted.db, { note_type: "journal", content: "Journal entry", event_date: "2026-03-10" });

    const mod = await import("@/app/api/notes/route");
    const res = await mod.GET(getReq("?type=bogus"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it("returns the full notebook when type is omitted", async () => {
    createNote(hoisted.db, { note_type: "journal", content: "Journal entry", event_date: "2026-03-10" });
    createNote(hoisted.db, { note_type: "earnings", content: "Earnings note", event_date: "2026-03-11" });

    const mod = await import("@/app/api/notes/route");
    const res = await mod.GET(getReq(""));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });
});

describe("GET /api/notes — sentiment filter coercion", () => {
  it("returns the full notebook (not an empty list) for ?sentiment=all", async () => {
    createNote(hoisted.db, {
      note_type: "journal",
      content: "Bullish take",
      event_date: "2026-03-10",
      sentiment: "bullish",
    });
    createNote(hoisted.db, {
      note_type: "journal",
      content: "Bearish take",
      event_date: "2026-03-11",
      sentiment: "bearish",
    });

    const mod = await import("@/app/api/notes/route");
    const res = await mod.GET(getReq("?sentiment=all"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it("filters to a real sentiment", async () => {
    createNote(hoisted.db, {
      note_type: "journal",
      content: "Bullish take",
      event_date: "2026-03-10",
      sentiment: "bullish",
    });
    createNote(hoisted.db, {
      note_type: "journal",
      content: "Bearish take",
      event_date: "2026-03-11",
      sentiment: "bearish",
    });

    const mod = await import("@/app/api/notes/route");
    const res = await mod.GET(getReq("?sentiment=bullish"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data![0].sentiment).toBe("bullish");
  });
});
