/**
 * QA unit C25 — an earnings note needs a security
 * (research-notes-earnings--security-less-note-saves-but-never-renders-on-tab-regression-1).
 *
 * The Earnings tab groups notes under per-security headers
 * (`groupEarningsTimeline` skips a NULL security_id), so an earnings note
 * with no security was saved "successfully" and then shown nowhere on the
 * tab that created it. The route now refuses it with a 400; the composer
 * and the editor refuse it before the request is sent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { createNote } from "@/lib/mutations/notes";
import {
  EARNINGS_NOTE_NEEDS_SECURITY,
  noteDraftBlocker,
} from "@/app/dashboard/components/NotesView";
import { sliceBetween } from "@/tests/helpers/source-anchor";

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

type Envelope = { success: boolean; data?: { id: number }; error?: string };

async function call(method: "POST" | "PUT", body: unknown) {
  const mod = await import("@/app/api/notes/route");
  const res = await mod[method](
    new NextRequest("http://test/api/notes", { method, body: JSON.stringify(body) }),
  );
  return { status: res.status, json: (await res.json()) as Envelope };
}

function seedSecurity(symbol: string): number {
  return Number(
    hoisted.db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
      .run(symbol, symbol).lastInsertRowid,
  );
}

function noteCount(): number {
  return (hoisted.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
}

function row(id: number) {
  return hoisted.db
    .prepare("SELECT note_type, security_id, content FROM notes WHERE id = ?")
    .get(id) as { note_type: string; security_id: number | null; content: string };
}

describe("POST /api/notes — an earnings note needs a security", () => {
  it("refuses an earnings note with no security and writes nothing", async () => {
    const r = await call("POST", { note_type: "earnings", content: "Guide raised." });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(r.json.error).toMatch(/earnings note needs a security/i);
    expect(noteCount()).toBe(0);
  });

  it("refuses an earnings note whose symbol matches no security", async () => {
    const r = await call("POST", { note_type: "earnings", content: "x", symbol: "NOPE" });
    expect(r.status).toBe(400);
    expect(noteCount()).toBe(0);
  });

  it("saves an earnings note that names a security, by symbol or by id", async () => {
    const aaa = seedSecurity("AAA");
    const bySymbol = await call("POST", { note_type: "earnings", content: "x", symbol: "AAA" });
    expect(bySymbol.status).toBe(200);
    expect(row(bySymbol.json.data!.id).security_id).toBe(aaa);
    const byId = await call("POST", { note_type: "earnings", content: "y", security_id: aaa });
    expect(byId.status).toBe(200);
    expect(row(byId.json.data!.id).security_id).toBe(aaa);
  });

  it("leaves journal and stock notes free to carry no security", async () => {
    for (const note_type of ["journal", "trade_thesis"]) {
      const r = await call("POST", { note_type, content: "x" });
      expect(r.status).toBe(200);
    }
    expect(noteCount()).toBe(2);
  });
});

describe("PUT /api/notes — an edit cannot leave an earnings note without a security", () => {
  it("refuses clearing the security of an earnings note and writes nothing", async () => {
    const aaa = seedSecurity("AAA");
    const n = createNote(hoisted.db, { note_type: "earnings", content: "x", event_date: "2026-01-02", security_id: aaa });
    const r = await call("PUT", { id: n.id, content: "changed", security_id: null });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/earnings note needs a security/i);
    expect(row(n.id)).toEqual({ note_type: "earnings", security_id: aaa, content: "x" });
  });

  it("refuses turning a security-less note into an earnings note", async () => {
    const n = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02" });
    const r = await call("PUT", { id: n.id, content: "changed", note_type: "earnings" });
    expect(r.status).toBe(400);
    expect(row(n.id)).toEqual({ note_type: "journal", security_id: null, content: "x" });
  });

  it("accepts a switch to earnings that brings or keeps a security", async () => {
    const aaa = seedSecurity("AAA");
    const bare = createNote(hoisted.db, { note_type: "journal", content: "x", event_date: "2026-01-02" });
    const withBoth = await call("PUT", { id: bare.id, note_type: "earnings", security_id: aaa });
    expect(withBoth.status).toBe(200);
    expect(row(bare.id)).toMatchObject({ note_type: "earnings", security_id: aaa });

    const linked = createNote(hoisted.db, { note_type: "trade_thesis", content: "x", event_date: "2026-01-02", security_id: aaa });
    const typeOnly = await call("PUT", { id: linked.id, note_type: "earnings" });
    expect(typeOnly.status).toBe(200);
    expect(row(linked.id)).toMatchObject({ note_type: "earnings", security_id: aaa });
  });

  it("still lets the text of an older security-less earnings note be edited", async () => {
    // Rows saved before the rule exist; their text must stay editable and
    // they must stay movable to a type or a security that fixes them.
    const old = createNote(hoisted.db, { note_type: "earnings", content: "x", event_date: "2026-01-02" });
    const text = await call("PUT", { id: old.id, content: "edited" });
    expect(text.status).toBe(200);
    expect(row(old.id).content).toBe("edited");
    const sameType = await call("PUT", { id: old.id, content: "again", note_type: "earnings" });
    expect(sameType.status).toBe(200);
    const toJournal = await call("PUT", { id: old.id, note_type: "journal" });
    expect(toJournal.status).toBe(200);
    expect(row(old.id).note_type).toBe("journal");
  });

  it("answers 404, not 400, for a note that does not exist", async () => {
    const r = await call("PUT", { id: 4242, note_type: "earnings" });
    expect(r.status).toBe(404);
  });
});

describe("composer and editor refuse before sending", () => {
  it("an earnings draft with no security is blocked with a plain message", () => {
    expect(noteDraftBlocker({ type: "earnings", symbol: "" })).toBe(EARNINGS_NOTE_NEEDS_SECURITY);
    expect(EARNINGS_NOTE_NEEDS_SECURITY).toMatch(/earnings note needs a security/i);
  });

  it("an earnings draft with a security, and every other type, is not blocked", () => {
    expect(noteDraftBlocker({ type: "earnings", symbol: "AAA" })).toBeNull();
    expect(noteDraftBlocker({ type: "journal", symbol: "" })).toBeNull();
    expect(noteDraftBlocker({ type: "trade_thesis", symbol: "" })).toBeNull();
  });

  it("the editor blocks a change INTO that state, never an older note's text edit", () => {
    const draft = { type: "earnings" as const, symbol: "" };
    // Clearing the security of an earnings note, or retyping a bare note.
    expect(noteDraftBlocker(draft, { note_type: "earnings", security_id: 11 })).toBe(
      EARNINGS_NOTE_NEEDS_SECURITY,
    );
    expect(noteDraftBlocker(draft, { note_type: "journal", security_id: null })).toBe(
      EARNINGS_NOTE_NEEDS_SECURITY,
    );
    // An older earnings note that never had a security: the edit changes neither.
    expect(noteDraftBlocker(draft, { note_type: "earnings", security_id: null })).toBeNull();
  });

  it("both handlers ask the blocker before any request is made", () => {
    const src = readFileSync("app/dashboard/components/NotesView.tsx", "utf8");
    const create = sliceBetween(src, "async function handleCreate", "// ─── Update note ───");
    expect(create).toContain("noteDraftBlocker({ type: formType, symbol: formSymbol })");
    expect(create.indexOf("noteDraftBlocker(")).toBeLessThan(create.indexOf("apiFetch("));
    const update = sliceBetween(src, "async function handleUpdate", "// ─── Delete note ───");
    expect(update).toContain("noteDraftBlocker(editDraft, note)");
    expect(update.indexOf("noteDraftBlocker(")).toBeLessThan(update.indexOf("apiFetch("));
  });
});
