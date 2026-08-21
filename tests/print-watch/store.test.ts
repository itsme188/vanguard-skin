import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertPrint,
  setPrintState,
  getPrintByEventId,
  listActivePrints,
  insertDocument,
  markDocumentParsed,
  listUnparsedDocuments,
  listDocuments,
  upsertLines,
  getSheet,
  markLineAccepted,
  clearLineAccepted,
  acquireWatcherLease,
} from "@/lib/print-watch/store";
import type { PrintWatchLine, LineContract, ExpectedValue } from "@/lib/print-watch/types";

function insertCalendarEvent(db: Database.Database, sourceKey: string, eventDate = "2026-08-20"): number {
  const result = db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key)
       VALUES ('finnhub', 'earnings', ?, 'ACME earnings', ?)`,
    )
    .run(eventDate, sourceKey);
  return Number(result.lastInsertRowid);
}

function makeContract(metricId: string): LineContract {
  return {
    metric_id: metricId,
    label: "EPS (Adj.)",
    definition: "Adjusted diluted EPS",
    basis: "non_gaap",
    period: "Q",
    currency: "USD",
    unit: "per_share",
    kind: "point",
    segment: null,
  };
}

function makeExpected(value: number): ExpectedValue {
  return { value, value_high: null, whisper: null, source_label: "consensus" };
}

function makeLine(metricId: string, value: number | null, opts: Partial<PrintWatchLine> = {}): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: makeContract(metricId),
    expected: makeExpected(1.5),
    state: "single_source",
    value,
    value_high: null,
    snippet: `snippet for ${metricId}`,
    source_doc_id: null,
    candidates_json: "[]",
    ...opts,
  };
}

describe("print-watch store (migration 085)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("applies migration 085 fresh with the three tables + index", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'print_watch_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "print_watch_documents",
      "print_watch_lines",
      "print_watch_prints",
    ]);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pw_documents_print'`)
      .all();
    expect(indexes).toHaveLength(1);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("upsertPrint is idempotent by eventId (UNIQUE(event_id))", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");

    const id1 = upsertPrint(db, eventId, "ACME", "2026-08-20", "16:05");
    const id2 = upsertPrint(db, eventId, "ACME", "2026-08-20", "16:10");

    expect(id2).toBe(id1);
    const rows = db.prepare(`SELECT * FROM print_watch_prints WHERE event_id = ?`).all(eventId);
    expect(rows).toHaveLength(1);

    const print = getPrintByEventId(db, eventId);
    expect(print).not.toBeNull();
    expect(print?.release_time_et).toBe("16:10"); // second call updates in place
  });

  it("getPrintByEventId returns null when no print exists", () => {
    expect(getPrintByEventId(db, 999999)).toBeNull();
  });

  it("listActivePrints returns only scheduled/window_open/acquired/parsed states", () => {
    const e1 = insertCalendarEvent(db, "finnhub:AAA:2026-08-20");
    const e2 = insertCalendarEvent(db, "finnhub:BBB:2026-08-20");
    const e3 = insertCalendarEvent(db, "finnhub:CCC:2026-08-20");
    const e4 = insertCalendarEvent(db, "finnhub:DDD:2026-08-20");

    const p1 = upsertPrint(db, e1, "AAA", "2026-08-20", null); // stays 'scheduled'
    const p2 = upsertPrint(db, e2, "BBB", "2026-08-20", null);
    setPrintState(db, p2, "window_open");
    const p3 = upsertPrint(db, e3, "CCC", "2026-08-20", null);
    setPrintState(db, p3, "expired");
    const p4 = upsertPrint(db, e4, "DDD", "2026-08-20", null);
    setPrintState(db, p4, "disarmed");

    const active = listActivePrints(db);
    const ids = active.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([p1, p2].sort((a, b) => a - b));
  });

  it("insertDocument dedupes on (print_id, kind, sha256): second insert is not new, no duplicate row", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    const first = insertDocument(db, printId, "dj-release", "dj", "https://example.com/1", "sha-abc", "/path/1");
    expect(first.isNew).toBe(true);

    const second = insertDocument(db, printId, "dj-release", "dj", "https://example.com/1-dup", "sha-abc", "/path/1-dup");
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = db
      .prepare(`SELECT * FROM print_watch_documents WHERE print_id = ? AND sha256 = ?`)
      .all(printId, "sha-abc");
    expect(rows).toHaveLength(1);
  });

  it("listUnparsedDocuments returns only parsed_at IS NULL; markDocumentParsed removes it from the list", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    const docA = insertDocument(db, printId, "dj-release", "dj", null, "sha-a", "/a");
    const docB = insertDocument(db, printId, "edgar-ex99", "edgar", null, "sha-b", "/b");

    let unparsed = listUnparsedDocuments(db, printId);
    expect(unparsed.map((d) => d.id).sort()).toEqual([docA.id, docB.id].sort());

    markDocumentParsed(db, docA.id);

    unparsed = listUnparsedDocuments(db, printId);
    expect(unparsed.map((d) => d.id)).toEqual([docB.id]);

    const parsedRow = db.prepare(`SELECT parsed_at FROM print_watch_documents WHERE id = ?`).get(docA.id) as {
      parsed_at: string | null;
    };
    expect(parsedRow.parsed_at).not.toBeNull();

    const all = listDocuments(db, printId);
    expect(all.map((d) => d.id).sort()).toEqual([docA.id, docB.id].sort());
  });

  it("upsertLines/getSheet round-trip including expected_json", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    const line = makeLine("eps_adj_q", 1.42);
    upsertLines(db, printId, [line]);

    const sheet = getSheet(db, printId);
    expect(sheet).toHaveLength(1);
    expect(sheet[0].metric_id).toBe("eps_adj_q");
    expect(sheet[0].contract).toEqual(line.contract);
    expect(sheet[0].expected).toEqual(line.expected);
    expect(sheet[0].state).toBe("single_source");
    expect(sheet[0].value).toBe(1.42);
    expect(sheet[0].snippet).toBe("snippet for eps_adj_q");
  });

  it("upsertLines with expected: null round-trips expected_json as null", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    upsertLines(db, printId, [makeLine("revenue_q", 100, { expected: null })]);

    const sheet = getSheet(db, printId);
    expect(sheet[0].expected).toBeNull();
  });

  it("an accepted row survives upsertLines: only candidates_json refreshes, everything else (incl. contract/expected) stays locked", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    const originalContract = makeContract("eps_adj_q");
    const originalExpected = makeExpected(1.5);

    upsertLines(db, printId, [
      makeLine("eps_adj_q", 1.42, {
        contract: originalContract,
        expected: originalExpected,
        state: "agreed",
        snippet: "original snippet",
        candidates_json: "[1]",
      }),
    ]);
    markLineAccepted(db, printId, "eps_adj_q");

    let sheet = getSheet(db, printId);
    expect(sheet[0].state).toBe("accepted");
    expect(sheet[0].value).toBe(1.42);

    // A later reconcile pass tries to overwrite with a conflicting candidate,
    // AND a revised contract/expected (e.g. bogeys or contract compilation
    // re-ran) — none of it should touch the accepted row.
    const revisedContract = { ...originalContract, label: "EPS (Adj.) REVISED", definition: "revised definition" };
    const revisedExpected = { value: 4.2, value_high: null, whisper: 4.1, source_label: "revised consensus" };
    upsertLines(db, printId, [
      makeLine("eps_adj_q", 9.99, {
        contract: revisedContract,
        expected: revisedExpected,
        state: "conflict",
        snippet: "new conflicting snippet",
        value_high: 10.5,
        candidates_json: "[1,2]",
        source_doc_id: null,
      }),
    ]);

    sheet = getSheet(db, printId);
    expect(sheet[0].state).toBe("accepted"); // never downgraded
    expect(sheet[0].value).toBe(1.42); // locked
    expect(sheet[0].value_high).toBeNull(); // locked
    expect(sheet[0].snippet).toBe("original snippet"); // locked
    expect(sheet[0].contract).toEqual(originalContract); // locked (Codex Critical fix)
    expect(sheet[0].expected).toEqual(originalExpected); // locked (Codex Critical fix)
    expect(sheet[0].candidates_json).toBe("[1,2]"); // refreshed
  });

  it("clearLineAccepted resets state off 'accepted'", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    upsertLines(db, printId, [makeLine("eps_adj_q", 1.42)]);
    markLineAccepted(db, printId, "eps_adj_q");
    expect(getSheet(db, printId)[0].state).toBe("accepted");

    clearLineAccepted(db, printId, "eps_adj_q");

    const sheet = getSheet(db, printId);
    expect(sheet[0].state).not.toBe("accepted");
  });

  it("clearLineAccepted is a no-op on a line that is not accepted", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    upsertLines(db, printId, [makeLine("eps_adj_q", 1.42, { state: "conflict" })]);
    clearLineAccepted(db, printId, "eps_adj_q");

    expect(getSheet(db, printId)[0].state).toBe("conflict");
  });

  it("deleting the calendar_events row does NOT delete the print (evidence survives event correction)", () => {
    const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);

    db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(eventId);

    const row = db.prepare(`SELECT * FROM print_watch_prints WHERE id = ?`).get(printId);
    expect(row).toBeDefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  describe("acquireWatcherLease", () => {
    it("fresh acquire returns true and stores the lease in settings", () => {
      const acquired = acquireWatcherLease(db, "mac-main", 1_000_000, 60_000);
      expect(acquired).toBe(true);

      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("print_watch_lease") as {
        value: string;
      };
      const lease = JSON.parse(row.value);
      expect(lease.holder).toBe("mac-main");
      expect(lease.expiresAt).toBe(1_060_000);
    });

    it("a second holder is refused while the lease is still live", () => {
      acquireWatcherLease(db, "mac-main", 1_000_000, 60_000);
      const acquired = acquireWatcherLease(db, "worker-fallback", 1_010_000, 60_000);
      expect(acquired).toBe(false);
    });

    it("a second holder succeeds once the lease has expired", () => {
      acquireWatcherLease(db, "mac-main", 1_000_000, 60_000);
      const acquired = acquireWatcherLease(db, "worker-fallback", 1_070_000, 60_000); // 70s later, ttl 60s
      expect(acquired).toBe(true);

      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("print_watch_lease") as {
        value: string;
      };
      expect(JSON.parse(row.value).holder).toBe("worker-fallback");
    });

    it("the same holder renews its own lease before expiry", () => {
      acquireWatcherLease(db, "mac-main", 1_000_000, 60_000);
      const renewed = acquireWatcherLease(db, "mac-main", 1_030_000, 60_000);
      expect(renewed).toBe(true);

      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("print_watch_lease") as {
        value: string;
      };
      const lease = JSON.parse(row.value);
      expect(lease.holder).toBe("mac-main");
      expect(lease.expiresAt).toBe(1_090_000); // renewed from the second call's nowMs
    });
  });
});
