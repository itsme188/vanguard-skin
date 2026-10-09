/**
 * The read-only record of a finished print (owner ruling, sprint 2 unit B2).
 *
 * `getWatchStatus` drops a finished print dated before today on purpose, so an
 * armed Hub row expanded the next morning had nothing to show. The record is a
 * scoped read for ONE event with no state filter.
 *
 * Rows are seeded through the real writers (`upsertPrint`, `upsertLines`,
 * `markLineAccepted`, `setPrintState`, `recordDelivery`). Figures are invented.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPrintRecord } from "@/lib/earnings/print-record";
import { recordDelivery, sha256Hex } from "@/lib/print-watch/delivery";
import { markLineAccepted, setPrintState, upsertLines, upsertPrint } from "@/lib/print-watch/store";
import { getWatchStatus } from "@/lib/print-watch/watcher";
import { PRINT_SHEET_DISABLED } from "@/lib/earnings/print-outputs";
import { todayET } from "@/lib/calendar/date-utils";
import type { LineStateKind, PrintWatchLine } from "@/lib/print-watch/types";

let db: Database.Database;

/** A date safely before today in ET, so the fixture never goes stale. */
function daysAgo(n: number): string {
  return todayET(new Date(Date.now() - n * 86_400_000));
}

function seedEvent(symbol: string, date: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,?,?,?)`,
      )
      .run(date, `${symbol} earnings`, symbol, `k-${symbol}-${date}`).lastInsertRowid,
  );
}

function line(
  metricId: string,
  state: LineStateKind,
  value: number | null,
  sourceDocId: number | null,
  snippet: string | null = null,
): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: metricId === "revenue_q" ? "Revenue" : "EPS (adj)",
      definition: "d",
      basis: metricId === "revenue_q" ? "gaap" : "non_gaap",
      period: "Q",
      currency: "USD",
      unit: metricId === "revenue_q" ? "usd" : "per_share",
      kind: "point",
      segment: null,
    },
    expected: null,
    state,
    value,
    value_high: null,
    snippet,
    source_doc_id: sourceDocId,
    candidates_json: "[]",
  };
}

function deliver(printId: number, symbol: string, eventDate: string): number {
  const text = `${symbol} reports quarterly results. Revenue $2.0 billion.`;
  const bytes = Buffer.from(text, "utf8");
  return recordDelivery(db, printId, "edgar-ex99", "edgar-ex99:x", null, bytes, {
    bytesPath: `/tmp/${sha256Hex(bytes)}.txt`,
    text,
    gateCtx: { symbol, issuerName: `${symbol} Corp`, eventDate },
  }).id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe("getPrintRecord", () => {
  it("returns an expired, past-dated print with its accepted lines, though status has dropped it", () => {
    const date = daysAgo(3);
    const eventId = seedEvent("ZZA", date);
    const printId = upsertPrint(db, eventId, "ZZA", date, "16:05");
    const docId = deliver(printId, "ZZA", date);
    upsertLines(db, printId, [
      line("revenue_q", "agreed", 2_000_000_000, docId, "Revenue $2.0 billion"),
      line("eps_adj_q", "agreed", 1.5, docId, "adjusted EPS of $1.50"),
    ]);
    markLineAccepted(db, printId, "revenue_q");
    setPrintState(db, printId, "expired");

    // The live feed no longer carries it: that is the gap the record fills.
    expect(getWatchStatus(db).find((p) => p.printId === printId)).toBeUndefined();

    const record = getPrintRecord(db, eventId);
    expect(record.eventId).toBe(eventId);
    expect(record.print).toEqual({ printId, symbol: "ZZA", eventDate: date, state: "expired" });
    const byMetric = Object.fromEntries(record.lines.map((l) => [l.metric_id, l]));
    expect(byMetric.revenue_q.state).toBe("accepted");
    expect(byMetric.revenue_q.value).toBe(2_000_000_000);
    expect(byMetric.revenue_q.snippet).toBe("Revenue $2.0 billion");
    expect(byMetric.revenue_q.source_doc_id).toBe(docId);
    expect(byMetric.eps_adj_q.state).toBe("agreed");
    // The document kind map lets the table name the source of each figure.
    expect(record.documents).toEqual({ [docId]: "edgar-ex99" });
    // The outputs block is the same evaluation the live status route sends.
    expect(record.outputs?.printSheet).toEqual({ enabled: true, reason: null });
    expect(record.outputs?.sendRecap.state).toBe("unsent");
  });

  it("returns a print that has no accepted line, with the sheet as stored", () => {
    const date = daysAgo(2);
    const eventId = seedEvent("ZZB", date);
    const printId = upsertPrint(db, eventId, "ZZB", date, "07:00");
    upsertLines(db, printId, [line("revenue_q", "pending", null, null)]);
    setPrintState(db, printId, "expired");

    const record = getPrintRecord(db, eventId);
    expect(record.print?.state).toBe("expired");
    expect(record.lines.map((l) => l.state)).toEqual(["pending"]);
    expect(record.documents).toEqual({});
    expect(record.outputs?.printSheet).toEqual({ enabled: false, reason: PRINT_SHEET_DISABLED });
    expect(record.outputs?.sendRecap.enabled).toBe(false);
  });

  it("returns an empty record when no print was ever captured for the event", () => {
    const eventId = seedEvent("ZZC", daysAgo(1));
    expect(getPrintRecord(db, eventId)).toEqual({
      eventId,
      print: null,
      lines: [],
      documents: {},
      outputs: null,
    });
  });

  it("writes nothing", () => {
    const date = daysAgo(3);
    const eventId = seedEvent("ZZA", date);
    const printId = upsertPrint(db, eventId, "ZZA", date, "16:05");
    upsertLines(db, printId, [line("revenue_q", "agreed", 2_000_000_000, null)]);
    setPrintState(db, printId, "expired");
    const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    getPrintRecord(db, eventId);
    getPrintRecord(db, eventId);
    const after = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
