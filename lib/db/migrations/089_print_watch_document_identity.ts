// 089 (slice B, spec §4.2 "Identity and eligibility" + "Rebuild order"):
// documents dedupe on CONTENT (print_id, sha256); roads become provenance
// rows; lines gain `retired` and `audit_json`; a merged duplicate's candidates
// move onto the survivor, and one that would land on a reading the survivor
// already carries — the same (document, representation) slot — is archived
// instead, never silently dropped (R-B7b, shared with the event-merge handler
// through `print-watch/candidate-fate.ts`). Every affected line is then
// re-reconciled, so an `agreed` that rested on ONE content hash counted twice
// becomes an honest `single_source` while a real repA/repB pair stays green.
// A CODE migration because phases (5) and (11) need JSON and the reconciler.
// Runs inside the runner's transaction; every phase is a rollback point
// (tests inject a throw after each).
//
// RELATIVE imports on purpose: the rehearsal script loads this file under
// tsx, where the `@/` alias does not resolve for dynamic imports.
import type Database from "better-sqlite3";
import fs from "node:fs";
import { reconcile } from "../../print-watch/reconcile";
import { dedupeRemappedCandidates } from "../../print-watch/candidate-fate";
import { redactUrl } from "../../print-watch/hardened-fetch";
import type { ExpectedValue, LineContract, PrintWatchLine, TaggedCandidate } from "../../print-watch/types";

export interface RebuildHooks {
  afterPhase?: (phase: number) => void;
  log?: (line: string) => void;
  existsSync?: (p: string) => boolean;
}

export interface RebuildReport {
  documents: { before: number; after: number; merged: number };
  roads: number;
  candidates: { before: number; kept: number; archived: number };
  linesRechecked: number;
  linesChanged: Array<{ printId: number; metricId: string; from: string; to: string }>;
  missingBytes: string[];
  urlsSanitised: number;
  /** Lines whose candidates_json could not be parsed: copied verbatim, raw value archived (M7). */
  unparseableLines: number;
  /** Affected lines whose contract/expectation could not be read in phase (11):
   *  evidence moved, the reading left exactly as it was. */
  unreadableContracts: number;
}

const KINDS = "('dj-release','edgar-ex99','ir-page','user-drop','user-url')";
const REJECTED_PREFIX = "rejected:";
const FLASH_DOC_ID = 0;

interface OldDocRow {
  id: number; print_id: number; kind: string; source: string; url: string | null; sha256: string;
  bytes_path: string; parsed_at: string | null; first_seen_at: string;
}
interface OldLineRow {
  print_id: number; metric_id: string; contract_json: string; expected_json: string | null; state: string;
  value: number | null; value_high: number | null; snippet: string | null; source_doc_id: number | null;
  candidates_json: string; updated_at: string;
}

function countCandidates(db: Database.Database, table: string): number {
  let n = 0;
  for (const row of db.prepare(`SELECT candidates_json FROM ${table}`).all() as { candidates_json: string }[]) {
    try {
      const parsed: unknown = JSON.parse(row.candidates_json);
      if (Array.isArray(parsed)) n += parsed.length;
    } catch {
      // unreadable JSON contributes nothing, before and after alike
    }
  }
  return n;
}

/** The AUTOINCREMENT high-water mark of `name`, or undefined when the table
 *  has never held a row (or sqlite_sequence does not exist yet). */
function readSequence(db: Database.Database, name: string): number | undefined {
  const hasTable = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)
    .get() as { ok: number } | undefined;
  if (!hasTable) return undefined;
  const row = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(name) as { seq: number } | undefined;
  return row?.seq;
}

export function rebuildDocumentIdentity(db: Database.Database, hooks: RebuildHooks = {}): RebuildReport {
  const log = hooks.log ?? ((line: string) => console.log(`[089] ${line}`));
  const after = (phase: number) => hooks.afterPhase?.(phase);
  const existsSync = hooks.existsSync ?? fs.existsSync;
  const report: RebuildReport = {
    documents: { before: 0, after: 0, merged: 0 },
    roads: 0,
    candidates: { before: 0, kept: 0, archived: 0 },
    linesRechecked: 0,
    linesChanged: [],
    missingBytes: [],
    urlsSanitised: 0,
    unparseableLines: 0,
    unreadableContracts: 0,
  };

  // (0) sidecar tables that reference nothing being rebuilt
  db.exec(`
    CREATE TABLE print_watch_candidate_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      print_id INTEGER NOT NULL,
      metric_id TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE print_watch_sources (
      symbol TEXT PRIMARY KEY,
      ir_page_url TEXT NOT NULL,
      link_must_contain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE print_watch_ir_seen (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      link TEXT NOT NULL,
      seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      baseline INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, link)
    );
    CREATE TABLE print_watch_ir_baseline (
      event_id INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
      source_fingerprint TEXT NOT NULL,
      link_count INTEGER NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  report.candidates.before = countCandidates(db, "print_watch_lines");
  const oldDocs = db.prepare(`SELECT * FROM print_watch_documents ORDER BY id`).all() as OldDocRow[];
  report.documents.before = oldDocs.length;

  // (1) the new parent
  db.exec(`
    CREATE TABLE print_watch_documents_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
      kind TEXT NOT NULL CHECK (kind IN ${KINDS}),
      source TEXT NOT NULL,
      url TEXT,
      sha256 TEXT NOT NULL,
      bytes_path TEXT NOT NULL,
      parsed_at TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      gate_verdict TEXT NOT NULL DEFAULT 'rejected' CHECK (gate_verdict IN ('accepted','rejected')),
      gate_reason TEXT,
      gate_version INTEGER NOT NULL DEFAULT 0,
      gate_fingerprint TEXT,
      parse_state TEXT NOT NULL DEFAULT 'queued' CHECK (parse_state IN ('queued','claimed','parsed','failed')),
      parse_claim_token TEXT,
      parse_claimed_at TEXT,
      parse_attempts INTEGER NOT NULL DEFAULT 0,
      parse_last_error TEXT,
      text_sha256 TEXT,
      UNIQUE(print_id, sha256)
    );
  `);
  after(1);

  // (2) copy, deduping same-hash rows per print into the lowest id; keep an old→survivor map
  const remap = new Map<number, number>();
  /** Survivors whose bytes are gone: rejected durably in (10a), candidates archived in (5) (M7). */
  const missingDocIds = new Set<number>();
  const groups = new Map<string, OldDocRow[]>();
  for (const d of oldDocs) {
    const key = `${d.print_id}|${d.sha256}`;
    const g = groups.get(key);
    if (g) g.push(d);
    else groups.set(key, [d]);
  }
  const insertDoc = db.prepare(`
    INSERT INTO print_watch_documents_new
      (id, print_id, kind, source, url, sha256, bytes_path, parsed_at, first_seen_at, last_seen_at,
       gate_verdict, gate_reason, gate_version, gate_fingerprint, parse_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`);
  for (const members of groups.values()) {
    const survivor = members[0]; // ORDER BY id → lowest id first
    const rejectedReasons = members
      .filter((m) => m.source.startsWith(REJECTED_PREFIX))
      .map((m) => m.source.slice(REJECTED_PREFIX.length));
    const anyAccepted = rejectedReasons.length < members.length;
    const parsedAt = members.map((m) => m.parsed_at).find((p) => p !== null) ?? null;
    const survivorRejected = survivor.source.startsWith(REJECTED_PREFIX);
    insertDoc.run(
      survivor.id, survivor.print_id, survivor.kind,
      survivorRejected ? "legacy-rejected" : survivor.source,
      survivor.url, survivor.sha256, survivor.bytes_path, parsedAt, survivor.first_seen_at,
      members.map((m) => m.first_seen_at).sort().at(-1) ?? survivor.first_seen_at,
      anyAccepted ? "accepted" : "rejected",
      anyAccepted ? null : rejectedReasons[0] ?? null,
      parsedAt ? "parsed" : "queued",
    );
    for (const m of members) remap.set(m.id, survivor.id);
    if (members.length > 1) report.documents.merged += members.length - 1;
    if (!existsSync(survivor.bytes_path)) {
      report.missingBytes.push(survivor.bytes_path);
      missingDocIds.add(survivor.id);
      log(`WARNING document ${survivor.id} bytes missing on disk: ${survivor.bytes_path} — rejected, evidence archived`);
    }
  }
  report.documents.after = groups.size;

  // Carry the AUTOINCREMENT high-water mark across the rebuild (088
  // precedent, project rule): _new's counter only reflects MAX(id) of the
  // rows just copied, which is LOWER than the pre-rebuild counter whenever
  // the highest-id document was merged away or previously deleted — without
  // this a later insert would REISSUE a retired document id.
  const oldDocSeq = readSequence(db, "print_watch_documents");
  if (oldDocSeq !== undefined) {
    const newDocSeq = readSequence(db, "print_watch_documents_new");
    if (newDocSeq === undefined) {
      db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('print_watch_documents_new', ?)`).run(oldDocSeq);
    } else if (newDocSeq < oldDocSeq) {
      db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'print_watch_documents_new'`).run(oldDocSeq);
    }
  }
  after(2);

  // (3) roads — one per old row, on the survivor (FK text says _new; the rename in (8) rewrites it)
  db.exec(`
    CREATE TABLE print_watch_document_roads (
      document_id INTEGER NOT NULL REFERENCES print_watch_documents_new(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ${KINDS}),
      source TEXT NOT NULL,
      url TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      seen_count INTEGER NOT NULL DEFAULT 1,
      road_verdict TEXT NOT NULL CHECK (road_verdict IN ('accepted','rejected')),
      road_reason TEXT,
      PRIMARY KEY (document_id, kind, source)
    );
  `);
  const insertRoad = db.prepare(`
    INSERT OR IGNORE INTO print_watch_document_roads
      (document_id, kind, source, url, first_seen_at, last_seen_at, seen_count, road_verdict, road_reason)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  for (const d of oldDocs) {
    const rejected = d.source.startsWith(REJECTED_PREFIX);
    const r = insertRoad.run(
      remap.get(d.id)!, d.kind, rejected ? "legacy-rejected" : d.source, d.url, d.first_seen_at, d.first_seen_at,
      rejected ? "rejected" : "accepted", rejected ? d.source.slice(REJECTED_PREFIX.length) : null,
    );
    report.roads += r.changes;
  }
  after(3);

  // (4) the new lines table
  db.exec(`
    CREATE TABLE print_watch_lines_new (
      print_id INTEGER NOT NULL REFERENCES print_watch_prints(id),
      metric_id TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      expected_json TEXT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','flash','single_source','agreed','conflict','blank','accepted','retired')),
      value REAL, value_high REAL, snippet TEXT,
      source_doc_id INTEGER REFERENCES print_watch_documents_new(id),
      candidates_json TEXT NOT NULL DEFAULT '[]',
      audit_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (print_id, metric_id)
    );
  `);
  after(4);

  // (5) copy lines, remapping source_doc_id and candidates; archive duplicates' candidates
  const oldLines = db.prepare(`SELECT * FROM print_watch_lines ORDER BY print_id, metric_id`).all() as OldLineRow[];
  const insertLine = db.prepare(`
    INSERT INTO print_watch_lines_new
      (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, audit_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
  const archive = db.prepare(`
    INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, ?, ?, ?)`);
  const affected: Array<{ printId: number; metricId: string }> = [];

  /** The document a candidate's evidence belongs to after the rebuild. The
   *  flash sentinel (0) is not a row, and a doc_id we never saw is not ours to
   *  rewrite — both pass through exactly as stored. */
  const survivorOf = (docId: number): number | null =>
    docId === FLASH_DOC_ID ? null : remap.get(docId) ?? null;

  for (const line of oldLines) {
    const sourceDocId =
      line.source_doc_id !== null && remap.has(line.source_doc_id) ? remap.get(line.source_doc_id)! : line.source_doc_id;
    let parsed: unknown;
    let malformed = false;
    try {
      parsed = JSON.parse(line.candidates_json);
    } catch {
      malformed = true;
    }
    if (malformed || !Array.isArray(parsed)) {
      // M7: an unreadable value is NEVER rewritten as [] — copy it verbatim and
      // archive the raw text durably, so a human can recover it later.
      archive.run(line.print_id, line.metric_id, line.candidates_json, "unparseable-json");
      report.unparseableLines += 1;
      insertLine.run(
        line.print_id, line.metric_id, line.contract_json, line.expected_json, line.state, line.value, line.value_high,
        line.snippet, sourceDocId, line.candidates_json, line.updated_at,
      );
      log(`line print=${line.print_id} metric=${line.metric_id}: candidates_json unparseable — copied verbatim, raw value archived`);
      // Deliberately NOT added to `affected`: phase (11) would have to
      // JSON.parse this same unreadable text to re-reconcile it, and a throw
      // there would roll back the whole migration over one corrupt row.
      continue;
    }
    const all = parsed as TaggedCandidate[];
    // Controller ruling R-B7b: no line may carry two candidates that are the
    // SAME READING of one surviving document. The whole decision — remap,
    // archive as a duplicate, retract as unreadable — lives in
    // `dedupeRemappedCandidates`, the one helper the event-merge handler uses
    // too, so the rebuild and the merge can never drift apart on it.
    const { kept, archived, touched: candidatesTouched } = dedupeRemappedCandidates(all, {
      survivorOf,
      bytesMissing: (survivor) => missingDocIds.has(survivor),
    });
    let touched = candidatesTouched;
    for (const a of archived) {
      archive.run(line.print_id, line.metric_id, JSON.stringify(a.candidate), a.reason);
      report.candidates.archived += 1;
    }
    report.candidates.kept += kept.length;
    if (sourceDocId !== line.source_doc_id) touched = true;
    insertLine.run(
      line.print_id, line.metric_id, line.contract_json, line.expected_json, line.state, line.value, line.value_high,
      line.snippet, sourceDocId, JSON.stringify(kept), line.updated_at,
    );
    if (touched) affected.push({ printId: line.print_id, metricId: line.metric_id });
  }
  after(5);

  // (6)–(8) swap
  db.exec(`DROP TABLE print_watch_lines`);
  after(6);
  db.exec(`DROP TABLE print_watch_documents`);
  after(7);
  db.exec(`ALTER TABLE print_watch_documents_new RENAME TO print_watch_documents`);
  db.exec(`ALTER TABLE print_watch_lines_new RENAME TO print_watch_lines`);
  after(8);

  // (9) indexes — the one 085 had, plus the two the new columns need
  db.exec(`
    CREATE INDEX idx_pw_documents_print ON print_watch_documents(print_id);
    CREATE INDEX idx_pw_documents_parse ON print_watch_documents(print_id, parse_state);
    CREATE INDEX idx_pw_documents_text ON print_watch_documents(print_id, text_sha256);
  `);
  after(9);

  // (10a) documents with no bytes on disk are rejected durably (M7): their
  // candidates were archived in (5); the row stays as the record of what was lost.
  const rejectMissing = db.prepare(
    `UPDATE print_watch_documents SET gate_verdict = 'rejected', gate_reason = 'bytes missing on disk', gate_fingerprint = NULL WHERE id = ?`,
  );
  for (const id of missingDocIds) rejectMissing.run(id);

  // (10) referential integrity must be clean before any line is re-read
  const fkProblems = db.prepare(`PRAGMA foreign_key_check`).all();
  if (fkProblems.length > 0) {
    throw new Error(`089: foreign_key_check reported ${fkProblems.length} problem(s): ${JSON.stringify(fkProblems.slice(0, 5))}`);
  }
  after(10);

  // (11) re-run the reconciler over every affected, non-accepted line
  const readLine = db.prepare(`SELECT * FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`);
  const writeLine = db.prepare(`
    UPDATE print_watch_lines SET state = ?, value = ?, value_high = ?, snippet = ?, source_doc_id = ?, updated_at = datetime('now')
     WHERE print_id = ? AND metric_id = ?`);
  for (const { printId, metricId } of affected) {
    const row = readLine.get(printId, metricId) as OldLineRow & { audit_json: string | null };
    report.linesRechecked += 1;
    if (row.state === "accepted") continue; // rule 6: an acceptance is never recomputed here
    // ONE corrupt row must never abort an all-or-nothing rebuild, and a
    // contract we cannot read must never be RECONCILED past: `reconcile()`
    // buckets candidates by their own metric_id and looks the bucket up by
    // `contract.metric_id`, so an unreadable or drifted contract resolves to an
    // EMPTY pool and would clear a figure real evidence still supports. Exactly
    // the carve-out `retractDocumentEvidence` and the merge handler carry: the
    // evidence has already moved, the reading is left alone, and a human sees
    // the mismatch in the log.
    let contract: LineContract | null = null;
    const expected: Record<string, ExpectedValue> = {};
    let candidates: TaggedCandidate[] | null = null;
    try {
      contract = JSON.parse(row.contract_json) as LineContract;
      if (row.expected_json) expected[metricId] = JSON.parse(row.expected_json) as ExpectedValue;
      const parsedCands: unknown = JSON.parse(row.candidates_json);
      candidates = Array.isArray(parsedCands) ? (parsedCands as TaggedCandidate[]) : null;
    } catch {
      contract = null;
    }
    if (contract === null || candidates === null || contract.metric_id !== metricId) {
      report.unreadableContracts += 1;
      log(`line print=${printId} metric=${metricId}: contract/expectation could not be read — evidence moved, reading left alone`);
      continue;
    }
    const [next] = reconcile([contract], expected, candidates, []) as PrintWatchLine[];
    const nextSource = next.source_doc_id === FLASH_DOC_ID ? null : next.source_doc_id;
    if (next.state !== row.state || next.value !== row.value || nextSource !== row.source_doc_id) {
      writeLine.run(next.state, next.value, next.value_high, next.snippet, nextSource, printId, metricId);
      report.linesChanged.push({ printId, metricId, from: row.state, to: next.state });
      log(`line print=${printId} metric=${metricId}: ${row.state} → ${next.state}`);
    }
  }
  after(11);

  // legacy URL sanitisation (spec §4.2 "URL": B's migration sanitises stored URLs)
  for (const table of ["print_watch_documents", "print_watch_document_roads"]) {
    const rows = db.prepare(`SELECT rowid AS rid, url FROM ${table} WHERE url IS NOT NULL`).all() as { rid: number; url: string }[];
    const update = db.prepare(`UPDATE ${table} SET url = ? WHERE rowid = ?`);
    for (const r of rows) {
      const clean = redactUrl(r.url);
      if (clean !== r.url) {
        update.run(clean, r.rid);
        report.urlsSanitised += 1;
      }
    }
  }

  // invariant AFTER
  const afterCount = countCandidates(db, "print_watch_lines") + report.candidates.archived;
  if (afterCount !== report.candidates.before) {
    throw new Error(`089: candidate invariant broken — before=${report.candidates.before} kept+archived=${afterCount}`);
  }
  // Silent on a database that had nothing to rebuild (a fresh install, and
  // every in-memory test DB) — the summary is for the real migration only.
  if (report.documents.before > 0 || report.candidates.before > 0 || report.unparseableLines > 0) {
    log(
      `documents ${report.documents.before}→${report.documents.after} (merged ${report.documents.merged}), roads ${report.roads}, ` +
        `candidates kept ${report.candidates.kept} archived ${report.candidates.archived}, lines rechecked ${report.linesRechecked} changed ${report.linesChanged.length}, ` +
        `urls sanitised ${report.urlsSanitised}, missing bytes ${report.missingBytes.length}, unreadable contracts ${report.unreadableContracts}`,
    );
  }
  return report;
}

export function up(db: Database.Database): void {
  rebuildDocumentIdentity(db, {});
}
