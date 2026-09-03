import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { up, rebuildDocumentIdentity } from "@/lib/db/migrations/089_print_watch_document_identity";
import type { TaggedCandidate } from "@/lib/print-watch/types";

const NAME = "089_print_watch_document_identity.ts";

/** A DB at the 088 schema (every .sql, no code migration). */
function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, { codeMigrations: {} });
  return db;
}

function apply089(db: Database.Database): void {
  runMigrations(db, { codeMigrations: { [NAME]: up } });
}

function seedPrint(db: Database.Database, sourceKey = "finnhub:ACME:2026-08-26"): number {
  const eventId = Number(
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
       VALUES ('finnhub','earnings','2026-08-26','ACME earnings',?, 'ACME')`,
    ).run(sourceKey).lastInsertRowid,
  );
  return Number(
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, release_time_et, state)
       VALUES (?, 'ACME', '2026-08-26', '16:05', 'parsed')`,
    ).run(eventId).lastInsertRowid,
  );
}

function seedLegacyDoc(
  db: Database.Database,
  printId: number,
  kind: string,
  source: string,
  url: string | null,
  sha: string,
  bytesPath: string,
  parsed: boolean,
): number {
  return Number(
    db.prepare(
      `INSERT INTO print_watch_documents (print_id, kind, source, url, sha256, bytes_path, parsed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(printId, kind, source, url, sha, bytesPath, parsed ? "2026-08-26 20:10:00" : null).lastInsertRowid,
  );
}

function cand(metric: string, value: number, docId: number, rep: "repA" | "repB" | "flash"): TaggedCandidate {
  return {
    metric_id: metric, value, value_high: null, raw_text: String(value), snippet: `${metric} ${value}`,
    location_hint: null, not_disclosed: false, doc_id: docId, representation: rep, weak_pair: false,
  };
}

function seedLine(
  db: Database.Database, printId: number, metric: string, state: string, value: number | null,
  sourceDocId: number | null, candidates: TaggedCandidate[],
): void {
  db.prepare(
    `INSERT INTO print_watch_lines (print_id, metric_id, contract_json, expected_json, state, value, source_doc_id, candidates_json)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    printId, metric,
    JSON.stringify({ metric_id: metric, label: metric, definition: "t", basis: "gaap", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null }),
    state, value, sourceDocId, JSON.stringify(candidates),
  );
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m089-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("migration 089 — fresh database shape", () => {
  it("creates the sidecar tables, widens kind and state, and dedupes on (print_id, sha256)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["print_watch_document_roads", "print_watch_candidate_archive", "print_watch_sources", "print_watch_ir_seen", "print_watch_ir_baseline"]) {
      expect(names).toContain(t);
    }
    const docCols = (db.prepare("PRAGMA table_info(print_watch_documents)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["last_seen_at", "gate_verdict", "gate_reason", "gate_version", "gate_fingerprint", "parse_state", "parse_claim_token", "parse_claimed_at", "parse_attempts", "parse_last_error", "text_sha256"]) {
      expect(docCols).toContain(c);
    }
    expect((db.prepare("PRAGMA table_info(print_watch_lines)").all() as { name: string }[]).map((c) => c.name)).toContain("audit_json");
    const printId = seedPrint(db);
    db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict) VALUES (?, 'user-url', 'u', 'sha-1', '/x', 'accepted')`).run(printId);
    expect(() =>
      db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict) VALUES (?, 'edgar-ex99', 'e', 'sha-1', '/y', 'accepted')`).run(printId),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(`UPDATE print_watch_lines SET state = 'retired' WHERE 1 = 0`).run(),
    ).not.toThrow();
    expect((db.prepare("SELECT filename FROM schema_migrations WHERE filename = ?").get(NAME) as { filename: string }).filename).toBe(NAME);
  });
});

describe("migration 089 — rebuild of legacy rows", () => {
  it("merges same-hash documents into the lowest id, seeds one road per old row, remaps and archives candidates, and re-reconciles", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "release.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026 results");
    // Same bytes twice under two kinds (v1 UNIQUE was (print, kind, sha)), plus a distinct EDGAR doc.
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj:1", null, "sha-same", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "user-drop:acme.txt", "https://x.example/f?token=T", "sha-same", bytes, true);
    const d3 = seedLegacyDoc(db, printId, "edgar-ex99", "rejected:issuer not named (ACME)", "https://www.sec.gov/x", "sha-other", bytes, false);
    // Plain-text docs: one candidate each → the duplicate pair had greened `agreed`.
    seedLine(db, printId, "revenue_q", "agreed", 1000, d1, [cand("revenue_q", 1000, d1, "repB"), cand("revenue_q", 1000, d2, "repB")]);
    // A flash-only line keeps its sentinel doc_id 0.
    seedLine(db, printId, "eps_adj_q", "flash", 1.1, null, [cand("eps_adj_q", 1.1, 0, "flash")]);
    // An accepted line stays locked even though its candidates are pruned.
    seedLine(db, printId, "eps_gaap_q", "accepted", 0.5, d2, [cand("eps_gaap_q", 0.5, d1, "repB"), cand("eps_gaap_q", 0.5, d2, "repB")]);

    apply089(db);

    const docs = db.prepare("SELECT * FROM print_watch_documents ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(docs.map((d) => d.id)).toEqual([d1, d3]);
    expect(docs[0]).toMatchObject({ kind: "dj-release", gate_verdict: "accepted", parse_state: "parsed", gate_version: 1, gate_fingerprint: null });
    expect(docs[1]).toMatchObject({ source: "legacy-rejected", gate_verdict: "rejected", gate_reason: "issuer not named (ACME)", parse_state: "queued" });

    const roads = db.prepare("SELECT document_id, kind, source, url, road_verdict FROM print_watch_document_roads ORDER BY document_id, kind").all() as Array<Record<string, unknown>>;
    expect(roads).toEqual([
      { document_id: d1, kind: "dj-release", source: "dj:1", url: null, road_verdict: "accepted" },
      { document_id: d1, kind: "user-drop", source: "user-drop:acme.txt", url: "https://x.example/f", road_verdict: "accepted" },
      { document_id: d3, kind: "edgar-ex99", source: "legacy-rejected", url: "https://www.sec.gov/x", road_verdict: "rejected" },
    ]);

    const line = db.prepare("SELECT state, value, source_doc_id, candidates_json FROM print_watch_lines WHERE metric_id = 'revenue_q'").get() as { state: string; value: number; source_doc_id: number; candidates_json: string };
    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1000);
    expect(line.source_doc_id).toBe(d1);
    expect((JSON.parse(line.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([d1]);

    const archive = db.prepare("SELECT print_id, metric_id, candidate_json, reason FROM print_watch_candidate_archive ORDER BY id").all() as Array<{ print_id: number; metric_id: string; candidate_json: string; reason: string }>;
    expect(archive.map((a) => a.metric_id)).toEqual(["eps_gaap_q", "revenue_q"]);
    expect(archive.every((a) => (JSON.parse(a.candidate_json) as TaggedCandidate).doc_id === d2)).toBe(true);
    expect(archive[0].reason).toBe(`duplicate-of:${d1}`);

    const flash = db.prepare("SELECT state, candidates_json FROM print_watch_lines WHERE metric_id = 'eps_adj_q'").get() as { state: string; candidates_json: string };
    expect(flash.state).toBe("flash");
    expect((JSON.parse(flash.candidates_json) as TaggedCandidate[])[0].doc_id).toBe(0);

    const accepted = db.prepare("SELECT state, value, source_doc_id FROM print_watch_lines WHERE metric_id = 'eps_gaap_q'").get() as { state: string; value: number; source_doc_id: number };
    expect(accepted).toEqual({ state: "accepted", value: 0.5, source_doc_id: d1 });

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_new'").get() as { n: number }).n).toBe(0);
  });

  it("holds the candidate invariant: every original candidate is kept (remapped) or archived", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "s", bytes, true);
    const d3 = seedLegacyDoc(db, printId, "edgar-ex99", "e", null, "t", bytes, true);
    seedLine(db, printId, "m1", "agreed", 1, d1, [cand("m1", 1, d1, "repB"), cand("m1", 1, d2, "repB"), cand("m1", 1, d3, "repB")]);
    seedLine(db, printId, "m2", "single_source", 2, d2, [cand("m2", 2, d2, "repB")]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.candidates).toEqual({ before: 4, kept: 3, archived: 1 });
    expect(report.documents).toEqual({ before: 3, after: 2, merged: 1 });
    expect(report.roads).toBe(3);
    // m1 keeps d1 and d3 (independent pair across docs → still agreed); m2's only candidate is remapped d2→d1.
    const m1 = db.prepare("SELECT state FROM print_watch_lines WHERE metric_id='m1'").get() as { state: string };
    expect(m1.state).toBe("agreed");
    const m2 = db.prepare("SELECT source_doc_id, candidates_json FROM print_watch_lines WHERE metric_id='m2'").get() as { source_doc_id: number; candidates_json: string };
    expect(m2.source_doc_id).toBe(d1);
    expect((JSON.parse(m2.candidates_json) as TaggedCandidate[])[0].doc_id).toBe(d1);
    expect(report.linesChanged).toEqual([]);
  });

  it("a surviving document whose bytes are missing is rejected durably, its candidates archived, its lines re-reconciled (M7)", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const gone = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", path.join(tmp, "gone.txt"), true);
    seedLine(db, printId, "revenue_q", "single_source", 1000, gone, [cand("revenue_q", 1000, gone, "repB")]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.missingBytes).toEqual([path.join(tmp, "gone.txt")]);
    expect(db.prepare("SELECT gate_verdict, gate_reason FROM print_watch_documents WHERE id = ?").get(gone)).toEqual({ gate_verdict: "rejected", gate_reason: "bytes missing on disk" });
    const line = db.prepare("SELECT state, value, candidates_json FROM print_watch_lines WHERE metric_id = 'revenue_q'").get() as { state: string; value: number | null; candidates_json: string };
    expect(line).toEqual({ state: "pending", value: null, candidates_json: "[]" });
    expect((db.prepare("SELECT reason FROM print_watch_candidate_archive").all() as { reason: string }[]).map((a) => a.reason)).toEqual(["bytes-missing"]);
    expect(report.linesChanged).toEqual([{ printId, metricId: "revenue_q", from: "single_source", to: "pending" }]);
    expect(report.candidates).toEqual({ before: 1, kept: 0, archived: 1 });
  });

  it("copies malformed candidates_json verbatim and archives the raw value instead of rewriting it as [] (M7)", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", bytes, true);
    db.prepare(`INSERT INTO print_watch_lines (print_id, metric_id, contract_json, state, source_doc_id, candidates_json) VALUES (?, 'm', '{}', 'pending', ?, '{not json')`).run(printId, d1);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.unparseableLines).toBe(1);
    expect((db.prepare("SELECT candidates_json FROM print_watch_lines WHERE metric_id = 'm'").get() as { candidates_json: string }).candidates_json).toBe("{not json");
    expect(db.prepare("SELECT reason, candidate_json FROM print_watch_candidate_archive").get()).toEqual({ reason: "unparseable-json", candidate_json: "{not json" });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])("rolls back cleanly when phase %i throws", (phase) => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "s", bytes, true);
    seedLine(db, printId, "m1", "agreed", 1, d1, [cand("m1", 1, d1, "repB"), cand("m1", 1, d2, "repB")]);
    const before = {
      docs: db.prepare("SELECT * FROM print_watch_documents ORDER BY id").all(),
      lines: db.prepare("SELECT * FROM print_watch_lines ORDER BY metric_id").all(),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    };
    expect(() =>
      runMigrations(db, {
        codeMigrations: {
          [NAME]: (d) => rebuildDocumentIdentity(d, { log: () => {}, afterPhase: (p) => { if (p === phase) throw new Error(`boom@${phase}`); } }),
        },
      }),
    ).toThrow(`boom@${phase}`);
    expect(db.prepare("SELECT * FROM print_watch_documents ORDER BY id").all()).toEqual(before.docs);
    expect(db.prepare("SELECT * FROM print_watch_lines ORDER BY metric_id").all()).toEqual(before.lines);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(before.tables);
    expect(db.prepare("SELECT filename FROM schema_migrations WHERE filename = ?").get(NAME)).toBeUndefined();
  });

  it("sanitises legacy stored URLs on documents and roads", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    seedLegacyDoc(db, printId, "ir-page", "ir-rss:x", "https://ir.example/x?sig=S&id=1", "s", bytes, true);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();
    expect(report.urlsSanitised).toBe(2); // the document row and its road row
    expect((db.prepare("SELECT url FROM print_watch_documents").get() as { url: string }).url).toBe("https://ir.example/x?id=1");
    expect((db.prepare("SELECT url FROM print_watch_document_roads").get() as { url: string }).url).toBe("https://ir.example/x?id=1");
  });

  // Project table-rebuild rule (088 precedent): the AUTOINCREMENT counter has to
  // survive create-copy-drop-rename, or a merged-away id gets reissued to a
  // future document while roads/archive rows still name the old one.
  it("carries sqlite_sequence so a merged-away document id is never reissued", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "s", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "s", bytes, true); // merges into d1
    apply089(db);
    expect(db.prepare("SELECT id FROM print_watch_documents").all()).toEqual([{ id: d1 }]);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'print_watch_documents'").get()).toEqual({ seq: d2 });
    const fresh = Number(
      db.prepare(
        `INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path) VALUES (?, 'user-url', 'u2', 'sha-fresh', '/z')`,
      ).run(printId).lastInsertRowid,
    );
    expect(fresh).toBeGreaterThan(d2);
  });

  // Project table-rebuild rule: with nothing to merge, sanitise or retract, every
  // pre-089 column of every row is byte-identical after the rebuild.
  it("leaves every pre-089 column byte-identical when there is nothing to merge", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj:1", "https://ir.example/a?id=1", "sha-a", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "edgar-ex99", "edgar:2", null, "sha-b", bytes, false);
    seedLine(db, printId, "revenue_q", "agreed", 1000, d1, [cand("revenue_q", 1000, d1, "repB"), cand("revenue_q", 1000, d2, "repA")]);
    seedLine(db, printId, "eps_adj_q", "blank", null, null, []);
    const DOC_COLS = "id, print_id, kind, source, url, sha256, bytes_path, parsed_at, first_seen_at";
    const LINE_COLS =
      "print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, updated_at";
    const digest = (): string =>
      JSON.stringify([
        db.prepare(`SELECT ${DOC_COLS} FROM print_watch_documents ORDER BY id`).all(),
        db.prepare(`SELECT ${LINE_COLS} FROM print_watch_lines ORDER BY print_id, metric_id`).all(),
      ]);
    const before = digest();
    apply089(db);
    expect(digest()).toBe(before);
  });

  // Controller ruling R-B7. The pair below is NOT byte-identical — same value,
  // different `representation` — so a field-equality dedupe would keep both on
  // doc_id d1, where reconcile's independent() (differing representation, both
  // weak_pair false) reads them as an independent pair and greens `agreed`:
  // the exact false-green 089 exists to remove. One candidate per (survivor,
  // representation) — controller ruling R-B7b.
  it("archives a remapped candidate whenever the line already carries the SAME reading of that survivor", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "sha-same", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "sha-same", bytes, true);
    // The SAME reading (repA) of the same bytes, arriving down two roads: one
    // measurement counted twice, which is what the dedupe is for.
    seedLine(db, printId, "revenue_q", "agreed", 1000, d1, [
      cand("revenue_q", 1000, d1, "repA"),
      cand("revenue_q", 1000, d2, "repA"),
    ]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();

    expect(report.candidates).toEqual({ before: 2, kept: 1, archived: 1 });
    const line = db.prepare("SELECT state, candidates_json FROM print_watch_lines WHERE metric_id = 'revenue_q'").get() as { state: string; candidates_json: string };
    const kept = JSON.parse(line.candidates_json) as TaggedCandidate[];
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ doc_id: d1, representation: "repA" });
    expect(line.state).toBe("single_source");
    const archive = db.prepare("SELECT metric_id, candidate_json, reason FROM print_watch_candidate_archive").all() as Array<{ metric_id: string; candidate_json: string; reason: string }>;
    expect(archive).toHaveLength(1);
    expect(archive[0].metric_id).toBe("revenue_q");
    expect(archive[0].reason).toBe(`duplicate-of:${d1}`);
    expect((JSON.parse(archive[0].candidate_json) as TaggedCandidate)).toMatchObject({ doc_id: d2, representation: "repA" });
    expect(report.linesChanged).toEqual([{ printId, metricId: "revenue_q", from: "agreed", to: "single_source" }]);
  });

  // R-B7b, the other half. The merged twin carries v1's MEASURED PAIR (repA
  // tables + repB raw text of ONE document) and the survivor has nothing on
  // this line. Keyed on doc_id alone one reading would be archived and a
  // legitimate `agreed` would drop to `single_source`; keyed on (document,
  // representation) both survive on the survivor, exactly as reconcile's
  // independence rule has always read them.
  it("keeps BOTH readings when a merged twin carries a repA/repB pair the survivor has no candidate against", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "sha-same", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "sha-same", bytes, true);
    seedLine(db, printId, "revenue_q", "agreed", 1000, d2, [
      cand("revenue_q", 1000, d2, "repA"),
      cand("revenue_q", 1000, d2, "repB"),
    ]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();

    expect(report.candidates).toEqual({ before: 2, kept: 2, archived: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM print_watch_candidate_archive").get()).toEqual({ n: 0 });
    const line = db.prepare("SELECT state, value, source_doc_id, candidates_json FROM print_watch_lines WHERE metric_id = 'revenue_q'").get() as { state: string; value: number; source_doc_id: number; candidates_json: string };
    expect(line).toMatchObject({ state: "agreed", value: 1000, source_doc_id: d1 });
    expect((JSON.parse(line.candidates_json) as TaggedCandidate[]).map((c) => [c.doc_id, c.representation])).toEqual([
      [d1, "repA"],
      [d1, "repB"],
    ]);
  });

  // The survivor's own repA plus the twin's repB is still ONE document read
  // two ways: kept, and the line stays green.
  it("keeps a remapped reading the survivor does not already carry (survivor repA + twin repB)", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "sha-same", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "sha-same", bytes, true);
    seedLine(db, printId, "revenue_q", "agreed", 1000, d1, [
      cand("revenue_q", 1000, d1, "repA"),
      cand("revenue_q", 1000, d2, "repB"),
    ]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();

    expect(report.candidates).toEqual({ before: 2, kept: 2, archived: 0 });
    const line = db.prepare("SELECT state, candidates_json FROM print_watch_lines WHERE metric_id = 'revenue_q'").get() as { state: string; candidates_json: string };
    expect(line.state).toBe("agreed");
    expect((JSON.parse(line.candidates_json) as TaggedCandidate[]).map((c) => [c.doc_id, c.representation])).toEqual([
      [d1, "repA"],
      [d1, "repB"],
    ]);
    expect(report.linesChanged).toEqual([]);
  });

  it("keeps (remapped, never archived) a line whose ONLY evidence arrived through the merged twin", () => {
    const db = legacyDb();
    const printId = seedPrint(db);
    const bytes = path.join(tmp, "r.txt");
    fs.writeFileSync(bytes, "ACME Q2 2026");
    const d1 = seedLegacyDoc(db, printId, "dj-release", "dj", null, "sha-same", bytes, true);
    const d2 = seedLegacyDoc(db, printId, "user-drop", "u", null, "sha-same", bytes, true);
    // d1 (the survivor) contributed nothing to this metric; every candidate came from d2.
    seedLine(db, printId, "eps_adj_q", "single_source", 2, d2, [cand("eps_adj_q", 2, d2, "repB")]);
    const report = db.transaction(() => rebuildDocumentIdentity(db, { log: () => {} }))();

    expect(report.candidates).toEqual({ before: 1, kept: 1, archived: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM print_watch_candidate_archive").get()).toEqual({ n: 0 });
    const line = db.prepare("SELECT state, value, source_doc_id, candidates_json FROM print_watch_lines WHERE metric_id = 'eps_adj_q'").get() as { state: string; value: number; source_doc_id: number; candidates_json: string };
    expect(line).toMatchObject({ state: "single_source", value: 2, source_doc_id: d1 });
    expect((JSON.parse(line.candidates_json) as TaggedCandidate[])[0]).toMatchObject({ doc_id: d1, representation: "repB" });
    expect(report.linesChanged).toEqual([]);
  });
});
