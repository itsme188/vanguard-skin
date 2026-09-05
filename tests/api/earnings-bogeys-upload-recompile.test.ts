/**
 * Whole-branch review M1 (= R-F27) — POST /api/earnings/bogeys/upload wrote
 * through `upsertBogey` directly, so a sheet uploaded mid-afternoon did not
 * gain its line until the next document parse. The fix swaps the call to
 * `saveBogeyWithRecompile`, which re-derives the event's live print sheet in
 * the SAME transaction as the bogey write.
 *
 * The counter-argument on record ("the watcher self-heals `expected` on the
 * next parse") is true and irrelevant: a desk that uploads a sheet at 15:50
 * wants the line on the sheet before 16:05, not after the first document
 * lands. These tests assert exactly that — the line is there AFTER THE
 * WRITE, with no parse involved at all.
 *
 * Every identifier here is synthetic (XMPL1..XMPL5, fixed uuids): the repo
 * is public.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  bogeys: [] as Array<{
    symbol: string;
    eps_consensus: number | null;
    eps_whisper: number | null;
    revenue_consensus_usd: number | null;
    revenue_whisper_usd: number | null;
    expected_move_pct: number | null;
    segment_breakdown: null;
    guidance_notes: string | null;
    notes: string | null;
  }>,
}));

// The route module does `import { db } from "@/lib/db"`; the getter keeps
// that live binding pointed at whatever in-memory DB this test just built.
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// The route calls out to Claude for extraction — mocked so the test is
// hermetic and controls exactly which symbol/numbers "the PDF" contained.
// `resolveBogeysUploadMediaType` and `BogeysExtractionError` stay real.
vi.mock("@/lib/earnings/extract-bogeys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/earnings/extract-bogeys")>();
  return {
    ...original,
    extractBogeysFromUpload: vi.fn(async () => ({
      bogeys: hoisted.bogeys,
      modelId: "test-model",
      rawResponse: "[]",
    })),
  };
});

let db: Database.Database;
let seq = 0;

/** `calendar_events.source_key` is UNIQUE NOT NULL (migration 013), so it is
 *  supplied rather than defaulted; the counter keeps it unique per seed. */
function seedEvent(symbol: string, eventDate: string): number {
  seq += 1;
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source, source_key)
     VALUES (?, 'earnings', ?, ?, 'manual', ?)`,
  ).run(eventDate, `${symbol} Q3`, symbol, `manual:${symbol}:earnings:${eventDate}:${seq}`);
  return Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
}

function seedPrint(eventId: number, symbol: string, eventDate: string, state: string): number {
  db.prepare(
    `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, ?, ?, ?)`,
  ).run(eventId, symbol, eventDate, state);
  return Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
}

function uploadRequest(weekOf: string): Request {
  const fd = new FormData();
  fd.append("file", new File(["%PDF-fake"], "sheet.pdf", { type: "application/pdf" }));
  fd.append("weekOf", weekOf);
  fd.append("sourceLabel", "XMPL desk sheet");
  return new Request("http://localhost/api/earnings/bogeys/upload", { method: "POST", body: fd });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  hoisted.bogeys = [];
  vi.resetModules();
});

describe("POST /api/earnings/bogeys/upload — recompiles the live print's sheet (M1)", () => {
  it("a live print's sheet gains the eps_adj_q expected value right after the write, before any parse", async () => {
    const eventId = seedEvent("XMPL1", "2026-09-10");
    const printId = seedPrint(eventId, "XMPL1", "2026-09-10", "window_open");
    // No sheet compiled yet — an armed print with an empty print_watch_lines
    // table, exactly as it looks the instant before the first parse.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });

    hoisted.bogeys = [{
      symbol: "XMPL1",
      eps_consensus: 0.42,
      eps_whisper: null,
      revenue_consensus_usd: null,
      revenue_whisper_usd: null,
      expected_move_pct: null,
      segment_breakdown: null,
      guidance_notes: null,
      notes: null,
    }];

    const { POST } = await import("@/app/api/earnings/bogeys/upload/route");
    const res = await POST(uploadRequest("2026-09-07"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventsMatched).toBe(1);
    expect(body.results[0]).toMatchObject({ symbol: "XMPL1", eventId });

    const bogeyRow = db
      .prepare(`SELECT eps_consensus FROM earnings_bogeys WHERE event_id = ? AND source = 'pdf_upload'`)
      .get(eventId) as { eps_consensus: number };
    expect(bogeyRow.eps_consensus).toBe(0.42);

    // The line — with the consensus number attached — is on the sheet NOW,
    // with zero documents parsed and zero watcher ticks.
    const line = db
      .prepare(`SELECT state, expected_json FROM print_watch_lines WHERE print_id = ? AND metric_id = 'eps_adj_q'`)
      .get(printId) as { state: string; expected_json: string } | undefined;
    expect(line).toBeDefined();
    expect(line!.state).toBe("pending");
    expect(JSON.parse(line!.expected_json)).toMatchObject({ value: 0.42 });
  });

  it("with NO live print for the matched event, the write still succeeds and nothing throws", async () => {
    const eventId = seedEvent("XMPL2", "2026-09-11");
    // Deliberately no seedPrint call: the ordinary case (most events never arm).

    hoisted.bogeys = [{
      symbol: "XMPL2",
      eps_consensus: 1.1,
      eps_whisper: null,
      revenue_consensus_usd: null,
      revenue_whisper_usd: null,
      expected_move_pct: null,
      segment_breakdown: null,
      guidance_notes: null,
      notes: null,
    }];

    const { POST } = await import("@/app/api/earnings/bogeys/upload/route");
    const res = await POST(uploadRequest("2026-09-07"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventsMatched).toBe(1);
    expect(body.results[0]).toMatchObject({ symbol: "XMPL2", eventId });
    expect(body.results[0].bogeyId).toBeTypeOf("number");

    const bogeyRow = db
      .prepare(`SELECT eps_consensus FROM earnings_bogeys WHERE event_id = ? AND source = 'pdf_upload'`)
      .get(eventId) as { eps_consensus: number };
    expect(bogeyRow.eps_consensus).toBe(1.1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });
  });
});
