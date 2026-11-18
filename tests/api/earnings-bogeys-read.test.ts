/**
 * POST /api/earnings/bogeys/read (bogey intake 2026-11-18, Task B).
 *
 * Reads a file or pasted text for ONE print and returns the figures for the
 * edit box to show. It writes nothing: figures reach the database only through
 * the existing Save. Segments come back as watch lines, and every line is
 * aligned to the lines already on the sheet.
 *
 * The extractor is mocked (no real AI call). Synthetic tickers, invented
 * figures: the repo is public.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { APIError } from "@anthropic-ai/sdk";
import { runMigrations } from "@/lib/db/migrate";
import { watchMetricId } from "@/lib/earnings/watch-metrics";
import { aiUnavailableForClick } from "@/lib/earnings/ai-unavailable";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  bogeys: [] as unknown[],
  calls: [] as Array<{ input: unknown; context: unknown }>,
  throwErr: null as unknown,
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
    extractBogeys: vi.fn(async (input: unknown, context: unknown) => {
      hoisted.calls.push({ input, context });
      if (hoisted.throwErr) throw hoisted.throwErr;
      return { bogeys: hoisted.bogeys, modelId: "test-model", rawResponse: "[]" };
    }),
  };
});

const MANUAL_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
let db: Database.Database;

function entry(over: Record<string, unknown>) {
  return {
    symbol: "ACME",
    eps_consensus: null,
    eps_whisper: null,
    revenue_consensus_usd: null,
    revenue_whisper_usd: null,
    expected_move_pct: null,
    segment_breakdown: null,
    guidance_notes: null,
    notes: null,
    watch_metrics: [],
    ...over,
  };
}

function counts() {
  return {
    bogeys: (db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get() as { n: number }).n,
    scans: (db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogey_scans`).get() as { n: number }).n,
  };
}

async function post(fields: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const { POST } = await import("@/app/api/earnings/bogeys/read/route");
  const res = await POST(new Request("http://localhost/api/earnings/bogeys/read", { method: "POST", body: fd }));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  hoisted.bogeys = [];
  hoisted.calls = [];
  hoisted.throwErr = null;
  vi.resetModules();
  db.prepare(
    `INSERT INTO calendar_events (id, event_date, event_type, title, symbol, source, source_key)
     VALUES (7, '2026-11-20', 'earnings', 'ACME Q3', 'ACME', 'manual', 'manual:ACME:7')`,
  ).run();
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (7, 'manual', 'desk', ?)`,
  ).run(
    JSON.stringify([
      {
        id: MANUAL_ID,
        label: "Net new ARR",
        definition: "Net new ARR for the quarter.",
        unit: "usd",
        kind: "point",
        period: "Q",
        basis: "na",
        consensus: null,
        whisper: null,
      },
    ]),
  );
});

describe("POST /api/earnings/bogeys/read", () => {
  it("returns_values_for_event_symbol, aligned to the sheet's lines", async () => {
    hoisted.bogeys = [
      entry({ symbol: "BETA", eps_consensus: 9.99 }),
      entry({
        eps_consensus: 1.07,
        eps_whisper: 1.12,
        revenue_consensus_usd: 3_350_000_000,
        expected_move_pct: 6,
        guidance_notes: "FY guide in focus",
        watch_metrics: [
          {
            id: watchMetricId({ label: "Net new ARR", period: "Q", unit: "usd", basis: "na" }),
            label: "Net new ARR",
            definition: "Net new ARR for the quarter.",
            unit: "usd",
            kind: "point",
            period: "Q",
            basis: "na",
            consensus: 120_000_000,
            whisper: 130_000_000,
          },
        ],
      }),
    ];
    const before = counts();
    const { status, body } = await post({ eventId: "7", text: "ACME preview text" });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.found).toBe(true);
    expect(body.data.values).toEqual({
      eps_consensus: 1.07,
      eps_whisper: 1.12,
      revenue_consensus_usd: 3_350_000_000,
      revenue_whisper_usd: null,
      expected_move_pct: 6,
      guidance_notes: "FY guide in focus",
      notes: null,
    });
    expect(body.data.extraMetrics).toHaveLength(1);
    expect(body.data.extraMetrics[0]).toMatchObject({ id: MANUAL_ID, consensus: 120_000_000, whisper: 130_000_000 });
    expect(body.data.modelId).toBe("test-model");
    expect(typeof body.data.suggestedLabel).toBe("string");
    expect(body.data.suggestedLabel.length).toBeGreaterThan(0);

    // The extractor was told the one company and the sheet's existing lines.
    const ctx = hoisted.calls[0].context as { onlySymbol: string; existingLinesBySymbol: Record<string, string[]> };
    expect(ctx.onlySymbol).toBe("ACME");
    expect(ctx.existingLinesBySymbol.ACME).toEqual(['"Net new ARR" [usd, Q, na]']);
    expect(hoisted.calls[0].input).toEqual({ kind: "text", text: "ACME preview text" });

    // writes_nothing
    expect(counts()).toEqual(before);
  });

  it("turns segment_breakdown entries into watch lines", async () => {
    hoisted.bogeys = [
      entry({
        revenue_consensus_usd: 3_000_000_000,
        segment_breakdown: { Cloud: { consensus: 1_500_000_000, whisper: 1_600_000_000 } },
      }),
    ];
    const { body } = await post({ eventId: "7", text: "ACME preview" });
    const seg = body.data.extraMetrics.find((m: { label: string }) => m.label === "Cloud revenue");
    expect(seg).toMatchObject({
      id: watchMetricId({ label: "Cloud revenue", period: "Q", unit: "usd", basis: "na" }),
      unit: "usd",
      period: "Q",
      basis: "na",
      consensus: 1_500_000_000,
      whisper: 1_600_000_000,
    });
  });

  it("other_company_only_returns_found_false with empty values", async () => {
    hoisted.bogeys = [entry({ symbol: "BETA", eps_consensus: 2.5 })];
    const before = counts();
    const { status, body } = await post({ eventId: "7", text: "BETA preview" });
    expect(status).toBe(200);
    expect(body.data.found).toBe(false);
    expect(Object.values(body.data.values).every((v) => v === null)).toBe(true);
    expect(body.data.extraMetrics).toEqual([]);
    expect(body.data.message).toBe("No figures for ACME were found in this text.");
    expect(counts()).toEqual(before);
  });

  it("an entry for the company with no figure is found false", async () => {
    hoisted.bogeys = [entry({ notes: "Call topics only" })];
    const { body } = await post({ eventId: "7", text: "ACME preview" });
    expect(body.data.found).toBe(false);
  });

  it("reads a file upload", async () => {
    hoisted.bogeys = [entry({ eps_consensus: 1.07 })];
    const { status, body } = await post({
      eventId: "7",
      file: new File(["%PDF-fake"], "acme-preview.pdf", { type: "application/pdf" }),
    });
    expect(status).toBe(200);
    expect(body.data.found).toBe(true);
    expect((hoisted.calls[0].input as { kind: string; mediaType: string }).kind).toBe("file");
    expect((hoisted.calls[0].input as { mediaType: string }).mediaType).toBe("application/pdf");
    expect(body.data.suggestedLabel).toContain("acme-preview");
    // Day and Eastern time, so a second read never reuses an earlier sheet's label.
    expect(body.data.suggestedLabel).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("no_input_400", async () => {
    const { status, body } = await post({ eventId: "7" });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(hoisted.calls).toHaveLength(0);
  });

  it("both_inputs_400", async () => {
    const { status } = await post({
      eventId: "7",
      text: "ACME",
      file: new File(["%PDF-fake"], "a.pdf", { type: "application/pdf" }),
    });
    expect(status).toBe(400);
    expect(hoisted.calls).toHaveLength(0);
  });

  it("a bad event id is 400, an unknown event 404, neither calls the model", async () => {
    expect((await post({ eventId: "abc", text: "x" })).status).toBe(400);
    const r = await post({ eventId: "999", text: "ACME" });
    expect(r.status).toBe(404);
    expect(r.body.success).toBe(false);
    expect(hoisted.calls).toHaveLength(0);
  });

  it("an unsupported file type is 400", async () => {
    const { status } = await post({
      eventId: "7",
      file: new File(["x"], "notes.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    });
    expect(status).toBe(400);
  });

  it("an extraction error answers with its own status and message", async () => {
    const { BogeysExtractionError } = await import("@/lib/earnings/extract-bogeys");
    hoisted.throwErr = new BogeysExtractionError("Pasted text is too long.", 400, "too_long");
    const { status, body } = await post({ eventId: "7", text: "ACME" });
    expect(status).toBe(400);
    expect(body).toEqual({ success: false, error: "Pasted text is too long." });
  });

  it("an account outage (real-shaped SDK billing error on cause) answers 503", async () => {
    const { BogeysExtractionError } = await import("@/lib/earnings/extract-bogeys");
    const payload = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
      request_id: "req_testBILLING",
    };
    const sdkErr = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
    hoisted.throwErr = new BogeysExtractionError("Billing problem.", 502, "upstream", sdkErr);
    const before = counts();
    const { status, body } = await post({ eventId: "7", text: "ACME" });
    expect(status).toBe(503);
    expect(body).toEqual({ success: false, error: aiUnavailableForClick("billing") });
    expect(counts()).toEqual(before);
  });
});
