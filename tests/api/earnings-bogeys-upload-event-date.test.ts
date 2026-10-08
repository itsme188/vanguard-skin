/**
 * POST /api/earnings/bogeys/upload names the event it wrote to (TODO f11).
 *
 * The route matches each uploaded symbol through `issuerSiblings`, inside a
 * window wider than the week the hub shows, and used to return only the event
 * id. The button could not say which print it matched, so it guessed from the
 * rows on screen. Each matched result now carries the event's own date, and
 * the event's own symbol when that is a share-class sibling of the uploaded
 * one. What is stored and which event is matched are unchanged.
 *
 * Symbols are public share-class pairs or synthetic (XMPL*); every figure is
 * invented.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  symbols: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/earnings/extract-bogeys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/earnings/extract-bogeys")>();
  return {
    ...original,
    extractBogeysFromUpload: vi.fn(async () => ({
      bogeys: hoisted.symbols.map((symbol) => ({
        symbol,
        eps_consensus: 1.5,
        eps_whisper: null,
        revenue_consensus_usd: null,
        revenue_whisper_usd: null,
        expected_move_pct: null,
        segment_breakdown: null,
        guidance_notes: null,
        notes: null,
      })),
      modelId: "test-model",
      rawResponse: "[]",
    })),
  };
});

let db: Database.Database;
let seq = 0;

function seedEvent(symbol: string, eventDate: string): number {
  seq += 1;
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source, source_key)
     VALUES (?, 'earnings', ?, ?, 'manual', ?)`,
  ).run(eventDate, `${symbol} Q3`, symbol, `manual:${symbol}:earnings:${eventDate}:${seq}`);
  return Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
}

function uploadRequest(weekOf: string): Request {
  const fd = new FormData();
  fd.append("file", new File(["%PDF-fake"], "sheet.pdf", { type: "application/pdf" }));
  fd.append("weekOf", weekOf);
  fd.append("sourceLabel", "XMPL desk sheet");
  return new Request("http://localhost/api/earnings/bogeys/upload", { method: "POST", body: fd });
}

async function upload(weekOf: string) {
  const { POST } = await import("@/app/api/earnings/bogeys/upload/route");
  const res = await POST(uploadRequest(weekOf));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  hoisted.symbols = [];
  vi.resetModules();
});

describe("POST /api/earnings/bogeys/upload — the matched event's date", () => {
  it("returns the event's own date for a same-symbol match, with no sibling symbol", async () => {
    const eventId = seedEvent("XMPL1", "2026-09-10");
    hoisted.symbols = ["XMPL1"];

    const { status, body } = await upload("2026-09-07");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.results[0]).toMatchObject({ symbol: "XMPL1", eventId, eventDate: "2026-09-10" });
    expect(body.results[0].eventSymbol).toBeUndefined();
  });

  it("returns the date of a match outside the week shown (the window is wider)", async () => {
    // weekOf Monday 2026-09-07; the match window runs to weekOf + 10 days.
    const eventId = seedEvent("XMPL2", "2026-09-15");
    hoisted.symbols = ["XMPL2"];

    const { body } = await upload("2026-09-07");
    expect(body.results[0]).toMatchObject({ symbol: "XMPL2", eventId, eventDate: "2026-09-15" });
  });

  it("names the sibling share class the event is filed under", async () => {
    const eventId = seedEvent("GOOGL", "2026-09-09");
    hoisted.symbols = ["GOOG"];

    const { body } = await upload("2026-09-07");
    expect(body.results[0]).toMatchObject({
      symbol: "GOOG",
      eventId,
      eventDate: "2026-09-09",
      eventSymbol: "GOOGL",
    });
    // Still stored on the same event as before.
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE event_id = ?`).get(eventId),
    ).toEqual({ n: 1 });
  });

  it("a case-only difference is not reported as a sibling", async () => {
    seedEvent("XMPL3", "2026-09-10");
    hoisted.symbols = ["xmpl3"];

    const { body } = await upload("2026-09-07");
    expect(body.results[0].eventDate).toBe("2026-09-10");
    expect(body.results[0].eventSymbol).toBeUndefined();
  });

  it("an unmatched symbol carries no date", async () => {
    hoisted.symbols = ["XMPL4"];

    const { body } = await upload("2026-09-07");
    expect(body.eventsUnmatched).toEqual(["XMPL4"]);
    expect(body.results[0]).toEqual({ symbol: "XMPL4", eventId: null });
  });

  it("a rejected upload answers success false with its reason", async () => {
    const fd = new FormData();
    fd.append("file", new File(["x"], "sheet.pdf", { type: "application/pdf" }));
    fd.append("weekOf", "next week");
    const { POST } = await import("@/app/api/earnings/bogeys/upload/route");
    const res = await POST(
      new Request("http://localhost/api/earnings/bogeys/upload", { method: "POST", body: fd }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("weekOf");
  });
});
