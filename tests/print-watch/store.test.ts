import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertPrint,
  setPrintState,
  getPrintByEventId,
  listActivePrints,
  upsertLines,
  getSheet,
  markLineAccepted,
  clearLineAccepted,
  acquireWatcherLease,
  upsertPrintWatchSource,
  getPrintWatchSource,
  deletePrintWatchSource,
  listIrSeenLinks,
  recordIrSeenLinks,
  recordIrBaseline,
  getIrBaseline,
  hasIrBaseline,
} from "@/lib/print-watch/store";
import { recordDelivery } from "@/lib/print-watch/delivery";
import type {
  PrintWatchLine,
  PrintWatchDocKind,
  LineContract,
  ExpectedValue,
  TaggedCandidate,
} from "@/lib/print-watch/types";

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

/**
 * A real document row for tests that need a live `source_doc_id` FK.
 *
 * The old hand-insert entry point retired with migration 089: documents are
 * now recorded by CONTENT through the one delivery entry, so the seed text has
 * to pass the gate for this print (issuer named + a plausible quarter for the
 * event date). `marker` makes each seeded document a distinct sha256 AND a
 * distinct normalised text, so two calls yield two documents rather than one
 * merged one.
 */
function seedDoc(
  db: Database.Database,
  printId: number,
  kind: PrintWatchDocKind,
  source: string,
  marker: string,
  eventDate = "2026-08-20",
): number {
  const text = `ACME reports Q2 2026 results. ${marker}`;
  const bytes = Buffer.from(text, "utf8");
  return recordDelivery(db, printId, kind, source, null, bytes, {
    bytesPath: `/tmp/${marker}`,
    text,
    gateCtx: { symbol: "ACME", issuerName: "Acme Corp", eventDate },
  }).id;
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

  // 089 (slice B) adds the five sidecar tables to 085's three; the list is
  // exhaustive on purpose, so a new print_watch_% table has to be declared here.
  it("applies migrations 085 + 089 fresh with every print_watch table + index", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'print_watch_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "print_watch_callouts",
      "print_watch_candidate_archive",
      "print_watch_document_roads",
      "print_watch_documents",
      "print_watch_ir_baseline",
      "print_watch_ir_seen",
      "print_watch_lines",
      "print_watch_prints",
      "print_watch_reads",
      "print_watch_sources",
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

  it("upsertPrintWatchSource / getPrintWatchSource / deletePrintWatchSource round-trip, keyed by upper-cased symbol", () => {
    const row = upsertPrintWatchSource(db, {
      symbol: "acme",
      irPageUrl: "https://ir.acme.example/news",
      linkMustContain: "Results",
    });
    expect(row).toMatchObject({
      symbol: "ACME",
      ir_page_url: "https://ir.acme.example/news",
      link_must_contain: "Results",
    });
    expect(getPrintWatchSource(db, "ACME")?.ir_page_url).toBe("https://ir.acme.example/news");
    upsertPrintWatchSource(db, {
      symbol: "ACME",
      irPageUrl: "https://ir.acme.example/press",
      linkMustContain: null,
    });
    expect(getPrintWatchSource(db, "acme")).toMatchObject({
      ir_page_url: "https://ir.acme.example/press",
      link_must_contain: null,
    });
    expect(deletePrintWatchSource(db, "ACME")).toBe(true);
    expect(getPrintWatchSource(db, "ACME")).toBeNull();
  });

  it("IR baseline is atomic and versioned by the source fingerprint; later links persist per event (M5)", () => {
    const eventId = insertCalendarEvent(db, "k-ir");
    expect(hasIrBaseline(db, eventId, "fp-1")).toBe(false);
    expect(recordIrBaseline(db, eventId, "fp-1", ["https://ir.x/a", "https://ir.x/b"])).toBe(2);
    expect(hasIrBaseline(db, eventId, "fp-1")).toBe(true);
    expect(hasIrBaseline(db, eventId, "fp-2")).toBe(false); // a changed IR URL is a new baseline
    expect(getIrBaseline(db, eventId)).toMatchObject({ source_fingerprint: "fp-1", link_count: 2 });
    expect(recordIrSeenLinks(db, eventId, ["https://ir.x/a", "https://ir.x/c"], false)).toBe(1);
    expect(listIrSeenLinks(db, eventId)).toEqual([
      { link: "https://ir.x/a", baseline: true },
      { link: "https://ir.x/b", baseline: true },
      { link: "https://ir.x/c", baseline: false },
    ]);
    // An empty page is still a completed baseline.
    const empty = insertCalendarEvent(db, "k-ir-empty");
    expect(recordIrBaseline(db, empty, "fp-1", [])).toBe(0);
    expect(hasIrBaseline(db, empty, "fp-1")).toBe(true);
  });

  it("a baseline whose link insert fails leaves NO marker (one transaction)", () => {
    const eventId = insertCalendarEvent(db, "k-ir-atomic");
    expect(() => recordIrBaseline(db, eventId, "fp-1", ["https://ir.x/a", null as unknown as string])).toThrow();
    expect(getIrBaseline(db, eventId)).toBeNull();
    expect(listIrSeenLinks(db, eventId)).toEqual([]);
  });

  it("upsertLines preserves audit_json unless the caller supplies one", () => {
    const eventId = insertCalendarEvent(db, "k-audit");
    const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", "16:05");
    upsertLines(db, printId, [makeLine("m", 1, { audit_json: JSON.stringify({ acceptances: [1] }) })]);
    upsertLines(db, printId, [makeLine("m", 2)]);
    expect(getSheet(db, printId)[0].audit_json).toBe(JSON.stringify({ acceptances: [1] }));
    upsertLines(db, printId, [makeLine("m", 3, { audit_json: null })]);
    expect(getSheet(db, printId)[0].audit_json).toBe(JSON.stringify({ acceptances: [1] })); // null = "not supplied"
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

  // QA finding `today-print-watch--unaccept-after-supersede-keeps-old-value-
  // hides-newer-candidate` (HIGH, money-critical): un-accept used to be a
  // one-column UPDATE (state → 'pending') that left value / value_high /
  // snippet / source_doc_id frozen at the superseded document's figures, and
  // nothing reconciled the line afterwards (reconcile.ts rule 6 skips accepted
  // lines, so the pass that would have fixed it never ran while the line was
  // locked). The desk un-accepted a line the panel had flagged "⟳ superseded —
  // re-verify" and kept looking at the OLD number with the OLD snippet, while
  // the disagreeing newer figure sat unseen inside candidates_json.
  //
  // User ruling 2026-09-02, option 1: un-accept RE-DERIVES the line through
  // the pure reconciler over its own candidate pool.
  describe("clearLineAccepted re-derivation (QA: unaccept-after-supersede)", () => {
    function makeCandidate(overrides: Partial<TaggedCandidate> = {}): TaggedCandidate {
      return {
        metric_id: "eps_adj_q",
        value: 1.42,
        value_high: null,
        raw_text: "1.42",
        snippet: "adjusted EPS of $1.42",
        location_hint: null,
        not_disclosed: false,
        doc_id: 1,
        representation: "repA",
        weak_pair: false,
        ...overrides,
      };
    }

    function seedAcceptedLine(candidates: TaggedCandidate[], value: number | null = 1.42) {
      const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
      const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);
      const docA = seedDoc(db, printId, "dj-release", "dj", "seed-a");
      const docB = seedDoc(db, printId, "edgar-ex99", "edgar", "seed-b");
      upsertLines(db, printId, [
        makeLine("eps_adj_q", value, {
          state: "agreed",
          snippet: "adjusted EPS of $1.42",
          source_doc_id: docA,
          candidates_json: JSON.stringify(candidates),
        }),
      ]);
      markLineAccepted(db, printId, "eps_adj_q");
      return { printId, docA, docB };
    }

    it("re-derives an AGREEING pool back to 'agreed' with the number intact", () => {
      const seeded = seedAcceptedLine([]);
      const candidates = [
        makeCandidate({ doc_id: seeded.docA }),
        makeCandidate({ doc_id: seeded.docB, snippet: "second document, same figure" }),
      ];
      upsertLines(db, seeded.printId, [
        makeLine("eps_adj_q", 9.99, { candidates_json: JSON.stringify(candidates) }),
      ]);

      clearLineAccepted(db, seeded.printId, "eps_adj_q");

      const line = getSheet(db, seeded.printId)[0];
      expect(line.state).toBe("agreed");
      expect(line.value).toBe(1.42); // the verified number survives
      expect(line.source_doc_id).toBe(seeded.docA);
      expect(JSON.parse(line.candidates_json)).toHaveLength(2); // nothing deleted
    });

    it("re-derives a ONE-CANDIDATE pool to 'single_source' with the number intact", () => {
      const seeded = seedAcceptedLine([]);
      upsertLines(db, seeded.printId, [
        makeLine("eps_adj_q", 9.99, {
          candidates_json: JSON.stringify([makeCandidate({ doc_id: seeded.docA })]),
        }),
      ]);

      clearLineAccepted(db, seeded.printId, "eps_adj_q");

      const line = getSheet(db, seeded.printId)[0];
      expect(line.state).toBe("single_source");
      expect(line.value).toBe(1.42);
      expect(line.source_doc_id).toBe(seeded.docA);
    });

    it("re-derives a DISAGREEING pool to 'conflict', dropping the stale figure while every rival survives", () => {
      const seeded = seedAcceptedLine([]);
      const candidates = [
        makeCandidate({ doc_id: seeded.docA }),
        makeCandidate({
          doc_id: seeded.docB,
          value: 1.24,
          raw_text: "1.24",
          snippet: "adjusted EPS of $1.24",
        }),
      ];
      const candidatesJson = JSON.stringify(candidates);
      upsertLines(db, seeded.printId, [
        makeLine("eps_adj_q", 9.99, { candidates_json: candidatesJson }),
      ]);

      clearLineAccepted(db, seeded.printId, "eps_adj_q");

      const line = getSheet(db, seeded.printId)[0];
      expect(line.state).toBe("conflict");
      // The superseded figure and its snippet are GONE — the whole finding was
      // that they kept rendering as if still verified.
      expect(line.value).toBeNull();
      expect(line.value_high).toBeNull();
      expect(line.snippet).toBeNull();
      expect(line.source_doc_id).toBeNull();
      // Every rival stays visible for the desk to pick from (per-candidate
      // accept), byte-for-byte — un-accept never edits the evidence.
      expect(line.candidates_json).toBe(candidatesJson);
      const rivals = JSON.parse(line.candidates_json) as TaggedCandidate[];
      expect(rivals.map((c) => c.value).sort()).toEqual([1.24, 1.42]);
    });

    it("keeps the residue when the line has NO candidates — an un-accept must stay recoverable", () => {
      // A line with an empty pool has nothing to re-derive from; wiping its
      // number would make an accidental un-accept unrecoverable (the accept
      // route only admits a 'pending' line that still carries a value).
      const seeded = seedAcceptedLine([]);

      clearLineAccepted(db, seeded.printId, "eps_adj_q");

      const line = getSheet(db, seeded.printId)[0];
      expect(line.state).toBe("pending");
      expect(line.value).toBe(1.42);
      expect(line.snippet).toBe("adjusted EPS of $1.42");
    });

    it("never writes the flash sentinel doc id into source_doc_id (real FK)", () => {
      const seeded = seedAcceptedLine([]);
      upsertLines(db, seeded.printId, [
        makeLine("eps_adj_q", 9.99, {
          candidates_json: JSON.stringify([
            makeCandidate({ doc_id: 0, representation: "flash", value: 1.4 }),
          ]),
        }),
      ]);

      clearLineAccepted(db, seeded.printId, "eps_adj_q");

      const line = getSheet(db, seeded.printId)[0];
      expect(line.state).toBe("flash");
      expect(line.value).toBe(1.4);
      expect(line.source_doc_id).toBeNull();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it("leaves a non-accepted line untouched even when its pool disagrees", () => {
      const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
      const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);
      upsertLines(db, printId, [
        makeLine("eps_adj_q", 1.42, {
          state: "single_source",
          candidates_json: JSON.stringify([
            makeCandidate({ doc_id: 0, representation: "flash" }),
            makeCandidate({ doc_id: 0, representation: "flash", value: 1.24 }),
          ]),
        }),
      ]);

      clearLineAccepted(db, printId, "eps_adj_q");

      const line = getSheet(db, printId)[0];
      expect(line.state).toBe("single_source");
      expect(line.value).toBe(1.42);
    });

    // Latent defect: the "keep the residue" carve-out only fired on
    // `candidates.length === 0 || contract === null` (unreadable JSON). If
    // `contract_json` parses fine but its `metric_id` names a DIFFERENT
    // metric than this row's own `metric_id` — a drifted/corrupted contract —
    // `reconcile([contract], {}, candidates, [])` buckets candidates by THEIR
    // OWN metric_id and looks the bucket up by `contract.metric_id`. The
    // mismatch means the lookup finds nothing, so `reconcileMetric` returns
    // `{state: 'pending', value: null, ...}` for an EMPTY pool — and the old
    // code wrote that straight over the row (keyed by the outer `metricId`
    // param, not `rederived.metric_id`), clearing a verified figure even
    // though real evidence for THIS metric was sitting right there under a
    // different key in the same candidates array.
    it("keeps the residue when contract_json names a DIFFERENT metric than this row (drifted contract)", () => {
      const eventId = insertCalendarEvent(db, "finnhub:ACME:2026-08-20");
      const printId = upsertPrint(db, eventId, "ACME", "2026-08-20", null);
      const docA = seedDoc(db, printId, "dj-release", "dj", "seed-mismatch-a");

      // Carries the ROW's real metric_id ("eps_adj_q") — real evidence, just
      // invisible to reconcile() once contract.metric_id has drifted.
      const candidates: TaggedCandidate[] = [
        {
          metric_id: "eps_adj_q",
          value: 1.24,
          value_high: null,
          raw_text: "1.24",
          snippet: "adjusted EPS of $1.24",
          location_hint: null,
          not_disclosed: false,
          doc_id: docA,
          representation: "repA",
          weak_pair: false,
        },
      ];

      upsertLines(db, printId, [
        makeLine("eps_adj_q", 1.42, {
          state: "agreed",
          snippet: "adjusted EPS of $1.42",
          source_doc_id: docA,
          contract: makeContract("revenue_q"), // corrupted: should be "eps_adj_q"
          candidates_json: JSON.stringify(candidates),
        }),
      ]);
      markLineAccepted(db, printId, "eps_adj_q");
      expect(getSheet(db, printId)[0].state).toBe("accepted");

      clearLineAccepted(db, printId, "eps_adj_q");

      const line = getSheet(db, printId)[0];
      expect(line.state).toBe("pending");
      expect(line.value).toBe(1.42); // UNCHANGED — the residue survives
      expect(line.snippet).toBe("adjusted EPS of $1.42");
    });
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

    // The lease is compare-and-swap, not read-then-write (fix wave, finding
    // D): ownership is decided by the write's own predicate, evaluated against
    // the row it locks, never by a SELECT that may already be stale.
    it("a loser whose view of the world says 'expired' cannot clobber the fresh winner", () => {
      acquireWatcherLease(db, "mac-main", 1_000_000, 60_000); // expires at 1_060_000

      // Both processes wake at 1_070_000 and both see an expired lease. The
      // winner's write lands first...
      expect(acquireWatcherLease(db, "sweep-tick", 1_070_000, 60_000)).toBe(true);
      // ...and the loser, running with the SAME stale view, is refused rather
      // than overwriting a lease that is now live.
      expect(acquireWatcherLease(db, "mac-main", 1_070_000, 60_000)).toBe(false);

      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("print_watch_lease") as {
        value: string;
      };
      const lease = JSON.parse(row.value);
      expect(lease.holder).toBe("sweep-tick");
      expect(lease.expiresAt).toBe(1_130_000);
    });

    it("takes over a corrupt (unparseable) lease value instead of throwing", () => {
      db.prepare(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      ).run("print_watch_lease", "not json at all");

      expect(acquireWatcherLease(db, "mac-main", 1_000_000, 60_000)).toBe(true);
      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("print_watch_lease") as {
        value: string;
      };
      expect(JSON.parse(row.value).holder).toBe("mac-main");
    });

    it("seeds a missing row with INSERT OR IGNORE — the first caller wins outright", () => {
      const missing = db
        .prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = ?`)
        .get("print_watch_lease") as { n: number };
      expect(missing.n).toBe(0);

      expect(acquireWatcherLease(db, "first", 1_000_000, 60_000)).toBe(true);
      // A different holder arriving one millisecond later loses: the seed is
      // already there and still live.
      expect(acquireWatcherLease(db, "second", 1_000_001, 60_000)).toBe(false);
    });
  });
});
