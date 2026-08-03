/**
 * Printable earnings worksheet (feedback #6) — composer layout, flag CRUD +
 * once-only auto-print semantics, window gating, best-effort isolation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  composeWorksheet,
  loadWorksheetInputs,
  printArmedWorksheets,
  type WorksheetInputs,
} from "@/lib/earnings/worksheet";
import {
  armWorksheet,
  disarmWorksheet,
} from "@/lib/mutations/earnings-worksheet-flags";
import { getWorksheetFlagsForEvents } from "@/lib/queries/earnings-worksheet-flags";
import type { EarningsBogey } from "@/lib/queries/earnings-bogeys";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedEvent(symbol: string, date: string, releaseTime: string | null = "16:15"): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key, week_of, consensus_estimate
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?,?)`,
    )
    .run(
      date,
      "AMC",
      releaseTime,
      `${symbol} earnings`,
      symbol,
      `finnhub:${symbol}:${date}`,
      date,
      "EPS 1.35 · Rev 750,000,000",
    ).lastInsertRowid as number;
}

function bogey(overrides: Partial<EarningsBogey>): EarningsBogey {
  return {
    id: 1,
    event_id: 1,
    source: "pdf_upload",
    source_label: "TMT Breakout weekly",
    source_url: null,
    raw_pdf_r2_key: null,
    research_document_id: null,
    research_article_id: null,
    eps_consensus: 1.35,
    eps_whisper: 1.42,
    revenue_consensus_usd: 750_000_000,
    revenue_whisper_usd: 760_000_000,
    expected_move_pct: null,
    segment_breakdown_json: null,
    guidance_notes: null,
    notes: null,
    uploaded_at: "2026-08-01 12:00:00",
    ai_extraction_model: null,
    ...overrides,
  };
}

const BASE_INPUTS: WorksheetInputs = {
  event: {
    symbol: "AAPL",
    event_date: "2026-08-06",
    event_time: "AMC",
    release_time: "16:15",
    consensus_estimate: "EPS 1.35 · Rev 750,000,000",
    consensus_value: null,
  },
  bogeys: [bogey({})],
  expectedMove: { pct: 6, method: "sheet", sourceLabel: "TMT Breakout weekly" },
  noteLines: ["Watching services margin inflection."],
};

describe("composeWorksheet", () => {
  it("renders header, aligned scoreboard columns, notes, scratch, and stays one page", () => {
    const text = composeWorksheet(BASE_INPUTS);
    const lines = text.trimEnd().split("\n");

    expect(lines[0]).toContain("AAPL — Thu, Aug 6 (AMC)");
    expect(lines[0]).toContain("exp move ±6.0% (TMT Breakout weekly)");
    expect(text).toContain("METRIC");
    expect(text).toContain("EPS");
    expect(text).toMatch(/1\.42/); // whisper visible
    expect(text).toContain("__________"); // blank ACTUAL columns
    expect(text).toContain("NOTES (yours)");
    expect(text).toContain("Watching services margin inflection.");
    expect(text).toContain("SCRATCH");
    // One page: hard cap.
    expect(lines.length).toBeLessThanOrEqual(62);
    // No line wider than 80 columns (printer wrap would break alignment).
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
  });

  it("renders segment splits and guidance fill-ins when present", () => {
    const text = composeWorksheet({
      ...BASE_INPUTS,
      bogeys: [
        bogey({
          segment_breakdown_json: JSON.stringify({ Services: { consensus: 26_000_000_000 } }),
          guidance_notes: "FY26 revenue guide $19.5–20.0B",
        }),
      ],
    });
    expect(text).toContain("  Services");
    expect(text).toContain("GUIDANCE");
    expect(text).toContain("FY26 revenue guide $19.5–20.0B");
    expect(text).toMatch(/→ _+/);
  });

  it("degrades without bogeys: Finnhub consensus fills CONS, whisper renders —", () => {
    const text = composeWorksheet({ ...BASE_INPUTS, bogeys: [], expectedMove: null, noteLines: [] });
    expect(text).toContain("1.35"); // effectiveConsensus EPS
    expect(text).toContain("750.0M"); // formatLargeUSD revenue
    expect(text).not.toContain("NOTES (yours)");
    expect(text).not.toContain("exp move");
  });
});

describe("loadWorksheetInputs", () => {
  it("assembles event + bogeys + notes from the DB (null for missing events)", () => {
    const eventId = seedEvent("AAPL", "2026-08-06");
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_whisper, expected_move_pct)
       VALUES (?, 'manual', 'me', 1.42, 5.5)`,
    ).run(eventId);
    const inputs = loadWorksheetInputs(db, eventId)!;
    expect(inputs.event.symbol).toBe("AAPL");
    expect(inputs.bogeys).toHaveLength(1);
    expect(inputs.expectedMove).toEqual({ pct: 5.5, method: "sheet", sourceLabel: "me" });
    expect(loadWorksheetInputs(db, 99999)).toBeNull();
  });
});

describe("worksheet flags + auto-print pass", () => {
  const NOW = new Date("2026-08-06T18:30:00Z"); // 14:30 ET — 105m before a 16:15 AMC release

  it("arm/disarm are idempotent and disarm clears the printed stamp", () => {
    const eventId = seedEvent("AAPL", "2026-08-06");
    expect(armWorksheet(db, eventId)).toBe(true);
    expect(armWorksheet(db, eventId)).toBe(false); // idempotent
    expect(getWorksheetFlagsForEvents(db, [eventId]).get(eventId)).toEqual({
      armed: true,
      printedAt: null,
    });
    expect(disarmWorksheet(db, eventId)).toBe(true);
    expect(getWorksheetFlagsForEvents(db, [eventId]).size).toBe(0);
  });

  it("prints an armed event inside the window exactly once (stamp blocks the second tick)", async () => {
    const eventId = seedEvent("AAPL", "2026-08-06");
    armWorksheet(db, eventId);
    const print = vi.fn(async () => ({}));

    const first = await printArmedWorksheets(db, { now: NOW, print });
    expect(first.printed).toBe(1);
    expect(print).toHaveBeenCalledWith(db, eventId);

    const second = await printArmedWorksheets(db, { now: NOW, print });
    expect(second.printed).toBe(0);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("holds outside the window: too early stays armed, prints when the window opens", async () => {
    const eventId = seedEvent("AAPL", "2026-08-06");
    armWorksheet(db, eventId);
    const print = vi.fn(async () => ({}));

    // 09:00 ET — release is 7h+ away, outside [−30m, +135m].
    const early = await printArmedWorksheets(db, { now: new Date("2026-08-06T13:00:00Z"), print });
    expect(early.printed).toBe(0);

    const inWindow = await printArmedWorksheets(db, { now: NOW, print });
    expect(inWindow.printed).toBe(1);
  });

  it("a failed print does NOT stamp — retries the next tick; other events still print", async () => {
    const bad = seedEvent("AAPL", "2026-08-06");
    const good = seedEvent("MSFT", "2026-08-06");
    armWorksheet(db, bad);
    armWorksheet(db, good);
    const print = vi.fn(async (_db: Database.Database, id: number) => {
      if (id === bad) throw new Error("printer offline");
      return {};
    });

    const r = await printArmedWorksheets(db, { now: NOW, print });
    expect(r.printed).toBe(1); // MSFT printed, AAPL failed
    expect(getWorksheetFlagsForEvents(db, [bad]).get(bad)!.printedAt).toBeNull();
    expect(getWorksheetFlagsForEvents(db, [good]).get(good)!.printedAt).not.toBeNull();

    const retry = await printArmedWorksheets(db, { now: NOW, print: vi.fn(async () => ({})) });
    expect(retry.printed).toBe(1); // AAPL retried
  });

  it("events with no computable release instant are left to Print-now (never auto-printed)", async () => {
    const eventId = seedEvent("AAPL", "2026-08-06", null);
    armWorksheet(db, eventId);
    const print = vi.fn(async () => ({}));
    const r = await printArmedWorksheets(db, { now: NOW, print });
    expect(r.printed).toBe(0);
    expect(print).not.toHaveBeenCalled();
  });
});
