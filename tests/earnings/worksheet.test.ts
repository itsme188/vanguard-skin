/**
 * Printable earnings worksheet (feedback #6) — composer layout, flag CRUD +
 * once-only auto-print semantics, window gating, best-effort isolation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  composeWorksheet,
  loadWorksheetInputs,
  printArmedWorksheets,
  loadRichWorksheetInputs,
  composeWorksheetForEvent,
  loadPrintSheetInputs,
  printWorksheetNow,
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

const PREVIEW_AI_MD = `## Line-by-line bogies

| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Revenue | Street ~$196.9B vs. guide $194–199B | — | — |
| AWS revenue | $40.5B, ~31% y/y | — | — |

## The setup

Into the print up 4% over 30 days.

## Sources

- TMT Breakout 8/1
`;

function seedPreviewEmail(
  eventId: number,
  aiOutputMd: string | null,
  error: string | null = null,
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
     VALUES (?, 'preview', 'me@example.com', '2026-08-06 12:05:00', ?, ?)`,
  ).run(eventId, aiOutputMd, error);
}

function seedReportHistory(symbol: string, reportedDate: string): void {
  db.prepare(
    `INSERT INTO earnings_report_history
       (symbol, reported_date, eps_actual, eps_estimate, surprise_pct, post_print_move_pct)
     VALUES (?, ?, 1.30, 1.25, 4.0, 2.1)`,
  ).run(symbol, reportedDate);
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

  it("renders full note text wrapped, never the 74-char chop", () => {
    const longNote = "thesis ".repeat(60).trim(); // ~420 chars
    const text = composeWorksheet({ ...BASE_INPUTS, noteLines: [longNote] });
    const count = (text.match(/thesis/g) ?? []).length;
    expect(count).toBe(60); // every word survived — no 74-char slice, no 6-note cap
    const lines = text.trimEnd().split("\n");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
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

describe("loadRichWorksheetInputs", () => {
  it("returns null when no preview email exists", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    expect(loadRichWorksheetInputs(db, id)).toBeNull();
  });

  it("returns null for a cloud-sent preview (no local prose)", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, null, "sent-by-cloud");
    expect(loadRichWorksheetInputs(db, id)).toBeNull();
  });

  it("returns null when ai_output_md yields neither table nor commentary", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, "## Sources\n\n- only sources");
    expect(loadRichWorksheetInputs(db, id)).toBeNull();
  });

  it("assembles inputs from a local preview", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, PREVIEW_AI_MD);
    const inputs = loadRichWorksheetInputs(db, id);
    expect(inputs).not.toBeNull();
    expect(inputs!.sections.bogiesTable!.rows).toHaveLength(2);
    expect(inputs!.scoreboardMd).toContain("scoreboard");
    expect(inputs!.sentAt).toBe("2026-08-06 12:05:00");
  });
});

describe("composeWorksheetForEvent", () => {
  it("falls back to the deterministic sheet without a preview", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    const r = composeWorksheetForEvent(db, id);
    expect(r).not.toBeNull();
    expect(r!.rich).toBe(false);
    expect(r!.text).toContain("SCRATCH");
    expect(r!.text).toContain("WHISPER"); // deterministic layout marker
  });

  it("composes the rich sheet when a local preview exists", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, PREVIEW_AI_MD);
    const r = composeWorksheetForEvent(db, id);
    expect(r!.rich).toBe(true);
    expect(r!.text).toContain("LINE-BY-LINE BOGIES");
    expect(r!.text).toContain("AWS revenue");
    expect(r!.text).toContain("THE SETUP");
  });

  it("returns null for a missing or symbol-less event", () => {
    expect(composeWorksheetForEvent(db, 9999)).toBeNull();
  });
});

describe("loadPrintSheetInputs", () => {
  it("returns null when no preview email exists", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    expect(loadPrintSheetInputs(db, id)).toBeNull();
  });

  it("returns null for a cloud-sent preview (no local prose)", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, null, "sent-by-cloud");
    expect(loadPrintSheetInputs(db, id)).toBeNull();
  });

  it("returns null when the preview prose has no bogies table", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, "## The setup\n\nNo table under this heading.");
    expect(loadPrintSheetInputs(db, id)).toBeNull();
  });

  it("assembles print-sheet inputs from a local preview", () => {
    const id = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(id, PREVIEW_AI_MD);
    const inputs = loadPrintSheetInputs(db, id);
    expect(inputs).not.toBeNull();
    expect(inputs!.symbol).toBe("AAPL");
    expect(inputs!.eventDate).toBe("2026-08-06");
    expect(inputs!.bogiesTableMd).toContain("Line-by-line bogies");
    expect(inputs!.bogiesTableMd).toContain("AWS revenue");
    expect(inputs!.scoreboardMd).toContain("scoreboard");
    expect(inputs!.sentAt).toBe("2026-08-06 12:05:00");
  });
});

describe("printWorksheetNow", () => {
  let eventId: number;

  beforeEach(() => {
    eventId = seedEvent("AAPL", "2026-08-06");
    seedPreviewEmail(eventId, PREVIEW_AI_MD);
  });

  it("takes the PDF road when preview + chrome available", async () => {
    const calls: string[] = [];
    const res = await printWorksheetNow(db, eventId, {
      renderPdf: async () => Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >>\n%%EOF"),
      printPdf: async () => { calls.push("pdf"); },
      printText: async () => { calls.push("text"); },
    });
    expect(res.road).toBe("pdf");
    expect(res.symbol).toBe("AAPL");
    expect(calls).toEqual(["pdf"]);
  });

  it("falls back to monospace when the PDF render throws", async () => {
    const calls: string[] = [];
    const res = await printWorksheetNow(db, eventId, {
      renderPdf: async () => { throw new Error("chrome missing"); },
      printPdf: async () => { calls.push("pdf"); },
      printText: async () => { calls.push("text"); },
    });
    expect(res.road).toBe("monospace");
    expect(calls).toEqual(["text"]);
  });

  it("falls back to monospace when the rendered PDF is unparseable (0 pages)", async () => {
    const calls: string[] = [];
    const res = await printWorksheetNow(db, eventId, {
      renderPdf: async () => Buffer.from("not a pdf at all — garbage bytes"),
      printPdf: async () => { calls.push("pdf"); },
      printText: async () => { calls.push("text"); },
    });
    expect(res.road).toBe("monospace");
    expect(calls).toEqual(["text"]);
  });

  it("re-renders without past prints when the PDF exceeds 2 pages, then prints", async () => {
    seedReportHistory("AAPL", "2026-05-01");
    const seen: string[] = [];
    const threePager = Buffer.from("%PDF\n<</Type /Page>><</Type /Page>><</Type /Page>>");
    const onePager = Buffer.from("%PDF\n<</Type /Page>>");
    let call = 0;
    let printedBytes: Buffer | null = null;
    const res = await printWorksheetNow(db, eventId, {
      renderPdf: async (html) => { seen.push(html); return call++ === 0 ? threePager : onePager; },
      // Read the file back WHILE it still exists — printWorksheetNow cleans
      // up its temp dir right after this resolves, so reading from the test
      // body afterward would race the rmSync.
      printPdf: async (path) => { printedBytes = readFileSync(path); },
      printText: async () => {},
    });
    expect(res.road).toBe("pdf");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("Past prints");
    expect(seen[1]).not.toContain("Past prints");
    // The file actually sent to lp is the SECOND (one-pager) render, not the
    // first, oversized one.
    expect(printedBytes).toEqual(onePager);
  });

  it("still prints when notes alone exceed 2 pages (notes never truncate)", async () => {
    const threePager = Buffer.from("%PDF\n<</Type /Page>><</Type /Page>><</Type /Page>>");
    const printPdf = vi.fn(async () => {});
    const res = await printWorksheetNow(db, eventId, {
      renderPdf: async () => threePager,
      printPdf,
      printText: async () => {},
    });
    expect(res.road).toBe("pdf");
    expect(printPdf).toHaveBeenCalledTimes(1);
  });

  it("uses the deterministic monospace road when no local preview exists (unchanged)", async () => {
    const bareId = seedEvent("MSFT", "2026-08-06");
    const calls: string[] = [];
    const res = await printWorksheetNow(db, bareId, {
      renderPdf: async () => Buffer.from("%PDF\n<</Type /Page>>"),
      printPdf: async () => { calls.push("pdf"); },
      printText: async () => { calls.push("text"); },
    });
    expect(res.road).toBe("monospace");
    expect(res.symbol).toBe("MSFT");
    expect(calls).toEqual(["text"]);
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
    seedPreviewEmail(eventId, PREVIEW_AI_MD);
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
    seedPreviewEmail(eventId, PREVIEW_AI_MD);
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
    seedPreviewEmail(bad, PREVIEW_AI_MD);
    seedPreviewEmail(good, PREVIEW_AI_MD);
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

describe("printArmedWorksheets wait-for-preview gate", () => {
  it("skips without stamping when no local preview exists, prints once it lands", async () => {
    const id = seedEvent("AAPL", "2026-08-06", "16:15");
    armWorksheet(db, id);
    const print = vi.fn(async () => {});
    const NOW = new Date("2026-08-06T19:00:00Z"); // 16:15 ET release ≈ 75 min out

    const before = await printArmedWorksheets(db, { now: NOW, print });
    expect(before.printed).toBe(0);
    expect(print).not.toHaveBeenCalled();

    seedPreviewEmail(id, PREVIEW_AI_MD);
    const after = await printArmedWorksheets(db, { now: NOW, print });
    expect(after.printed).toBe(1);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("never prints for a cloud-sent preview", async () => {
    const id = seedEvent("AAPL", "2026-08-06", "16:15");
    armWorksheet(db, id);
    seedPreviewEmail(id, null, "sent-by-cloud");
    const print = vi.fn(async () => {});
    const r = await printArmedWorksheets(db, { now: new Date("2026-08-06T19:00:00Z"), print });
    expect(r.printed).toBe(0);
    expect(print).not.toHaveBeenCalled();
  });
});

describe("printArmedWorksheets — real printWorksheetNow seam (PDF road integration)", () => {
  // The auto-print sweep's default `print` seam IS printWorksheetNow — these
  // tests wire printArmedWorksheets to the REAL function (with DI seams for
  // renderPdf/printPdf/printText) to prove the PDF road's stamp/retry
  // semantics hold end-to-end, not just in isolation.
  const NOW = new Date("2026-08-06T18:30:00Z"); // 14:30 ET — 105m before a 16:15 AMC release

  it("PDF road success stamps printed_at", async () => {
    const eventId = seedEvent("AAPL", "2026-08-06");
    armWorksheet(db, eventId);
    seedPreviewEmail(eventId, PREVIEW_AI_MD);
    const printPdf = vi.fn(async () => {});
    const printText = vi.fn(async () => {});
    const seams = {
      renderPdf: async () => Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >>\n%%EOF"),
      printPdf,
      printText,
    };

    const r = await printArmedWorksheets(db, {
      now: NOW,
      print: (d, id) => printWorksheetNow(d, id, seams),
    });
    expect(r.printed).toBe(1);
    expect(printPdf).toHaveBeenCalledTimes(1);
    expect(printText).not.toHaveBeenCalled();
    expect(getWorksheetFlagsForEvents(db, [eventId]).get(eventId)!.printedAt).not.toBeNull();
  });

  it("PDF render failure falls back to monospace and STILL stamps", async () => {
    const eventId = seedEvent("AAPL", "2026-08-06");
    armWorksheet(db, eventId);
    seedPreviewEmail(eventId, PREVIEW_AI_MD);
    const printPdf = vi.fn(async () => {});
    const printText = vi.fn(async () => {});
    const seams = {
      renderPdf: async () => { throw new Error("chrome missing"); },
      printPdf,
      printText,
    };

    const r = await printArmedWorksheets(db, {
      now: NOW,
      print: (d, id) => printWorksheetNow(d, id, seams),
    });
    expect(r.printed).toBe(1);
    expect(printPdf).not.toHaveBeenCalled();
    expect(printText).toHaveBeenCalledTimes(1);
    expect(getWorksheetFlagsForEvents(db, [eventId]).get(eventId)!.printedAt).not.toBeNull();
  });

  it("both roads failing leaves the flag unstamped for the next tick's retry", async () => {
    const eventId = seedEvent("AAPL", "2026-08-06");
    armWorksheet(db, eventId);
    seedPreviewEmail(eventId, PREVIEW_AI_MD);
    const seams = {
      renderPdf: async () => { throw new Error("chrome missing"); },
      printPdf: async () => {},
      printText: async () => { throw new Error("printer offline"); },
    };

    const r = await printArmedWorksheets(db, {
      now: NOW,
      print: (d, id) => printWorksheetNow(d, id, seams),
    });
    expect(r.printed).toBe(0);
    expect(getWorksheetFlagsForEvents(db, [eventId]).get(eventId)!.printedAt).toBeNull();
  });
});

describe("composeWorksheet — adversarial layout invariants (review probes)", () => {
  it("a runaway source_label never pushes the header past 80 cols", () => {
    const text = composeWorksheet({
      ...BASE_INPUTS,
      expectedMove: {
        pct: 6,
        method: "sheet",
        sourceLabel: "TMT Breakout weekly earnings preview special edition August 2026 extended",
      },
    });
    for (const l of text.trimEnd().split("\n")) expect(l.length).toBeLessThanOrEqual(80);
  });

  it("a 60-segment JSON stays one page WITH the footer + scratch surviving", () => {
    const segs: Record<string, { consensus: number }> = {};
    for (let i = 0; i < 60; i++) segs[`Segment ${i}`] = { consensus: 1_000_000 };
    const text = composeWorksheet({
      ...BASE_INPUTS,
      bogeys: [
        bogey({
          segment_breakdown_json: JSON.stringify(segs),
          guidance_notes: "FY26 guide",
        }),
      ],
    });
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(62);
    expect(text).toContain("GUIDANCE");
    expect(text).toContain("SCRATCH");
    expect(lines[lines.length - 1]).toContain("deterministic worksheet");
    // Segments are capped, not dumped.
    expect(text).not.toContain("Segment 9 "); // slice(0,8) keeps 0-7 only
  });
});
