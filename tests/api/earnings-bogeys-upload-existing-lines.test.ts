/**
 * POST /api/earnings/bogeys/upload shows the extractor the lines already on
 * each matched print's sheet and aligns the extracted lines to them (bogey
 * intake 2026-11-18, Task B / amendment A2). A re-upload under the same label
 * still OVERWRITES its row: that is how the owner corrects a sheet.
 *
 * The extractor is mocked (no real AI call). Synthetic tickers, invented
 * figures: the repo is public.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { watchMetricId } from "@/lib/earnings/watch-metrics";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  bogeys: [] as unknown[],
  contexts: [] as unknown[],
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
    extractBogeysFromUpload: vi.fn(async (_bytes: unknown, _mediaType: unknown, context: unknown) => {
      hoisted.contexts.push(context);
      return { bogeys: hoisted.bogeys, modelId: "test-model", rawResponse: "[]" };
    }),
  };
});

const MANUAL_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
let db: Database.Database;

function metric(label: string, consensus: number | null) {
  return {
    id: watchMetricId({ label, period: "Q", unit: "usd", basis: "na" }),
    label,
    definition: `${label} for the quarter.`,
    unit: "usd" as const,
    kind: "point" as const,
    period: "Q" as const,
    basis: "na" as const,
    consensus,
    whisper: null,
  };
}

function entry(symbol: string, watch_metrics: unknown[]) {
  return {
    symbol,
    eps_consensus: 1.5,
    eps_whisper: null,
    revenue_consensus_usd: null,
    revenue_whisper_usd: null,
    expected_move_pct: null,
    segment_breakdown: null,
    guidance_notes: null,
    notes: null,
    watch_metrics,
  };
}

async function upload(label = "ACME desk sheet") {
  const fd = new FormData();
  fd.append("file", new File(["%PDF-fake"], "sheet.pdf", { type: "application/pdf" }));
  fd.append("weekOf", "2026-11-16");
  fd.append("sourceLabel", label);
  const { POST } = await import("@/app/api/earnings/bogeys/upload/route");
  const res = await POST(new Request("http://localhost/api/earnings/bogeys/upload", { method: "POST", body: fd }));
  return { status: res.status, body: await res.json() };
}

function storedUploadMetrics(): Array<{ id: string; label: string; consensus: number | null }> {
  const rows = db
    .prepare(`SELECT extra_metrics_json FROM earnings_bogeys WHERE event_id = 7 AND source = 'pdf_upload'`)
    .all() as Array<{ extra_metrics_json: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].extra_metrics_json ? JSON.parse(rows[0].extra_metrics_json) : [];
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  hoisted.bogeys = [];
  hoisted.contexts = [];
  vi.resetModules();
  const ev = db.prepare(
    `INSERT INTO calendar_events (id, event_date, event_type, title, symbol, source, source_key)
     VALUES (?, ?, 'earnings', ?, ?, 'manual', ?)`,
  );
  ev.run(7, "2026-11-19", "ACME Q3", "ACME", "manual:ACME:7");
  ev.run(8, "2026-11-20", "BETA Q3", "BETA", "manual:BETA:8");
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (7, 'manual', 'desk', ?)`,
  ).run(JSON.stringify([{ ...metric("Net new ARR", null), id: MANUAL_ID }]));
});

describe("POST /api/earnings/bogeys/upload — existing sheet lines", () => {
  it("passes the matched prints' existing lines to the extractor, keyed by symbol", async () => {
    hoisted.bogeys = [entry("ACME", [])];
    await upload();
    const ctx = hoisted.contexts[0] as { existingLinesBySymbol: Record<string, string[]> };
    expect(ctx.existingLinesBySymbol).toEqual({ ACME: ['"Net new ARR" [usd, Q, na]'] });
  });

  it("existing_line_label_reused_gives_one_line (a hand-typed id is reused)", async () => {
    hoisted.bogeys = [entry("ACME", [metric("Net new ARR", 120_000_000)])];
    const { status } = await upload();
    expect(status).toBe(200);
    const stored = storedUploadMetrics();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: MANUAL_ID, consensus: 120_000_000 });
  });

  it("reupload_overwrites: the same label replaces the row's lines", async () => {
    hoisted.bogeys = [entry("ACME", [metric("Net new ARR", 120_000_000), metric("Cloud revenue", 900_000_000)])];
    await upload();
    expect(storedUploadMetrics()).toHaveLength(2);

    hoisted.bogeys = [entry("ACME", [metric("Net new ARR", 125_000_000)])];
    await upload();
    const stored = storedUploadMetrics();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: MANUAL_ID, consensus: 125_000_000 });
  });

  it("an extraction with no watch_metrics field still stores the row", async () => {
    const { watch_metrics: _drop, ...noMetrics } = entry("BETA", []);
    void _drop;
    hoisted.bogeys = [noMetrics];
    const { status, body } = await upload();
    expect(status).toBe(200);
    expect(body.eventsMatched).toBe(1);
  });
});
