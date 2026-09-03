/**
 * B's event-merge handler (spec §4.2 "B's merge handler").
 *
 * Runs INSIDE slice A's `mergeEarningsEventState`, inside the calendar
 * transaction, BEFORE the donor `calendar_events` row is deleted. SQL only,
 * SYNCHRONOUS — no awaits, no network, no model calls. The one piece of I/O is
 * a synchronous read of a document's already-stored text, so a surviving
 * document's verdict can be recomputed for the TARGET event's identity; a
 * missing file is a rejection with a reason, never a throw (M7) — a throw here
 * would roll back the caller's whole date correction.
 *
 * ORDER MATTERS with foreign keys ON (Codex #1). `print_watch_lines.source_doc_id`
 * is a plain (non-deferrable) FK to `print_watch_documents(id)`, so a donor
 * document cannot be deleted while any line still points at it:
 *
 *   phase 0  IR-seen rows + the IR baseline marker union onto the target event
 *   phase 1  DECIDE the donor-document → surviving-document map; union roads
 *            onto the twins. Nothing is deleted yet.
 *   phase 2  lines move or merge by metric_id, LOSSLESSLY, with every doc id
 *            remapped; the donor's line rows are deleted at the end of it.
 *   phase 3  now nothing references the twins: delete them, move the rest onto
 *            the target print, and recompute every surviving document's
 *            content/road verdicts for the target event's identity.
 *   phase 4  the donor print row goes LAST (its children are all gone).
 *
 * LOSSLESS is the rule for lines: evidence is appended, never dropped. Two
 * candidates that came from the SAME surviving document are still only one
 * reading of one content hash, so the second is ARCHIVED with its provenance
 * (R-B7) rather than kept — keeping it would let `reconcile()`'s `independent()`
 * read one document as two and green a line on a single source. And two
 * DIFFERING acceptances never pick a winner: the surviving line becomes a
 * `conflict` and `audit_json` carries both acceptances for the desk to resolve.
 */
import fs from "node:fs";
import type Database from "better-sqlite3";
import type { EventMergeContext, EventMergeTableResult } from "@/lib/earnings/event-merge";
import { reconcile } from "./reconcile";
import { contentVerdict, roadVerdict, gateFingerprint, GATE_VERSION } from "./gate";
import { textPathFor } from "./pdf";
import { retractDocumentEvidence } from "./delivery";
import { resolveSourceDocId } from "./store";
import type {
  DocumentRow,
  DocumentRoadRow,
  ExpectedValue,
  LineContract,
  PrintWatchLine,
  TaggedCandidate,
} from "./types";

export const PRINT_WATCH_MERGE_HANDLER_NAME = "print-watch";

/** Flash candidates carry doc_id 0 — a sentinel, never a row (parity with the
 *  store's own constant and migration 089's). It is never remapped. */
const FLASH_DOC_ID = 0;

interface PrintRowLite {
  id: number;
  event_id: number;
  symbol: string;
  event_date: string;
}

interface LineRow {
  print_id: number;
  metric_id: string;
  contract_json: string;
  expected_json: string | null;
  state: string;
  value: number | null;
  value_high: number | null;
  snippet: string | null;
  source_doc_id: number | null;
  candidates_json: string;
  audit_json: string | null;
}

/** The identity a document's verdicts are judged against after the merge. */
interface TargetIdentity {
  symbol: string;
  issuerName: string | null;
  eventDate: string;
}

function result(table: string, partial: Partial<EventMergeTableResult> = {}): EventMergeTableResult {
  return { table, moved: 0, merged: 0, deleted: 0, notes: [], ...partial };
}

/** The text the gate reads: the persisted poppler text for a PDF, the bytes
 *  themselves for HTML/text. Null means the file is gone (M7). */
function readText(doc: DocumentRow): string | null {
  const p = doc.bytes_path.endsWith(".pdf") ? textPathFor(doc.bytes_path) : doc.bytes_path;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Recompute one surviving document's content verdict and EVERY road verdict
 * for the TARGET event's identity.
 *
 * This is not optional bookkeeping. `gateFingerprint` is (symbol, issuerName,
 * eventDate): a re-homed print answers to a different event date, and a road
 * verdict copied off the donor was decided against the donor's date. Leaving
 * either in place is how last quarter's numbers get greened as tonight's
 * print. A document whose bytes are gone is rejected durably with the same
 * reason migration 089 uses, and its evidence is retracted by the caller.
 */
function reevaluate(
  db: Database.Database,
  doc: DocumentRow,
  identity: TargetIdentity,
  notes: string[],
): void {
  const text = readText(doc);
  const ctx = {
    symbol: identity.symbol,
    issuerName: identity.issuerName,
    eventDate: identity.eventDate,
  };
  if (text === null) {
    // M7: the bytes can no longer be re-read, so nothing may rest on them.
    db.prepare(
      `UPDATE print_watch_documents
          SET gate_verdict = 'rejected', gate_reason = 'bytes missing on disk', gate_fingerprint = NULL
        WHERE id = ?`,
    ).run(doc.id);
    notes.push(`doc ${doc.id}: bytes missing on disk — rejected`);
    return;
  }
  const content = contentVerdict(text, ctx);
  db.prepare(
    `UPDATE print_watch_documents SET gate_verdict = ?, gate_reason = ?, gate_version = ?, gate_fingerprint = ? WHERE id = ?`,
  ).run(
    content.ok ? "accepted" : "rejected",
    content.ok ? null : content.reason,
    GATE_VERSION,
    gateFingerprint(ctx),
    doc.id,
  );
  const roads = db
    .prepare(`SELECT * FROM print_watch_document_roads WHERE document_id = ?`)
    .all(doc.id) as DocumentRoadRow[];
  const update = db.prepare(
    `UPDATE print_watch_document_roads SET road_verdict = ?, road_reason = ?
      WHERE document_id = ? AND kind = ? AND source = ?`,
  );
  for (const r of roads) {
    const v = roadVerdict(r.kind, text, ctx);
    update.run(v.ok ? "accepted" : "rejected", v.ok ? null : v.reason, r.document_id, r.kind, r.source);
  }
}

/** Re-verdict a set of surviving documents; a document that LOSES its content
 *  acceptance has its evidence retracted (M16), never left green on the sheet. */
function reevaluateAll(
  db: Database.Database,
  docIds: Iterable<number>,
  identity: TargetIdentity,
  notes: string[],
): void {
  const read = db.prepare(`SELECT * FROM print_watch_documents WHERE id = ?`);
  for (const id of docIds) {
    const doc = read.get(id) as DocumentRow | undefined;
    if (!doc) continue;
    const before = doc.gate_verdict;
    reevaluate(db, doc, identity, notes);
    const after = (read.get(id) as DocumentRow).gate_verdict;
    if (before === "accepted" && after === "rejected") retractDocumentEvidence(db, id, "gate-rejected");
  }
}

function parseCands(json: string): TaggedCandidate[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as TaggedCandidate[]) : null;
  } catch {
    return null;
  }
}

export function mergePrintWatchState(ctx: EventMergeContext): EventMergeTableResult[] {
  const { db, donorEventId, targetEventId } = ctx;
  const out: EventMergeTableResult[] = [];

  // ── phase 0: event-keyed rows (plan M5). They cascade with the donor event,
  //    so they union first, whether or not either side has a print. ──
  const irMoved = db
    .prepare(
      `INSERT OR IGNORE INTO print_watch_ir_seen (event_id, link, seen_at, baseline)
         SELECT ?, link, seen_at, baseline FROM print_watch_ir_seen WHERE event_id = ?`,
    )
    .run(targetEventId, donorEventId).changes;
  const irDeleted = db
    .prepare(`DELETE FROM print_watch_ir_seen WHERE event_id = ?`)
    .run(donorEventId).changes;
  if (irMoved || irDeleted) out.push(result("print_watch_ir_seen", { moved: irMoved, deleted: irDeleted }));

  const baselineMoved = db
    .prepare(
      `INSERT OR IGNORE INTO print_watch_ir_baseline (event_id, source_fingerprint, link_count, completed_at)
         SELECT ?, source_fingerprint, link_count, completed_at FROM print_watch_ir_baseline WHERE event_id = ?`,
    )
    .run(targetEventId, donorEventId).changes;
  const baselineDeleted = db
    .prepare(`DELETE FROM print_watch_ir_baseline WHERE event_id = ?`)
    .run(donorEventId).changes;
  if (baselineMoved || baselineDeleted) {
    out.push(result("print_watch_ir_baseline", { moved: baselineMoved, deleted: baselineDeleted }));
  }

  const donor = db
    .prepare(`SELECT id, event_id, symbol, event_date FROM print_watch_prints WHERE event_id = ?`)
    .get(donorEventId) as PrintRowLite | undefined;
  if (!donor) return out;
  const target = db
    .prepare(`SELECT id, event_id, symbol, event_date FROM print_watch_prints WHERE event_id = ?`)
    .get(targetEventId) as PrintRowLite | undefined;

  const targetEvent = db
    .prepare(`SELECT symbol, event_date, release_time FROM calendar_events WHERE id = ?`)
    .get(targetEventId) as
    | { symbol: string | null; event_date: string; release_time: string | null }
    | undefined;

  const identity: TargetIdentity = {
    symbol: targetEvent?.symbol ?? target?.symbol ?? donor.symbol,
    issuerName: null,
    eventDate: targetEvent?.event_date ?? target?.event_date ?? donor.event_date,
  };
  identity.issuerName =
    (
      db
        .prepare(`SELECT name FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1`)
        .get(identity.symbol) as { name: string | null } | undefined
    )?.name ?? null;

  if (!target) {
    // ── re-home: the donor print IS the surviving print. It carries the
    //    TARGET's whole identity (Codex #3), not just the event id. ──
    const releaseTimeEt =
      targetEvent?.release_time && /^\d{2}:\d{2}$/.test(targetEvent.release_time)
        ? targetEvent.release_time
        : null;
    db.prepare(
      `UPDATE print_watch_prints
          SET event_id = ?, symbol = ?, event_date = ?, release_time_et = COALESCE(?, release_time_et),
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(targetEventId, identity.symbol, identity.eventDate, releaseTimeEt, donor.id);
    // Byte paths are IMMUTABLE on a re-home: the files stay under the directory
    // named for the print that FIRST delivered them, and `bytes_path` is copied
    // verbatim. The row, not the path, is the authority on who owns a document.
    const notes = ["re-homed with the target event's symbol, date, and release time"];
    // The gate fingerprint is (symbol, issuerName, eventDate) — all three just
    // moved, so every stored verdict is stale until it is recomputed.
    const docNotes: string[] = [];
    const docIds = (
      db.prepare(`SELECT id FROM print_watch_documents WHERE print_id = ? ORDER BY id`).all(donor.id) as {
        id: number;
      }[]
    ).map((r) => r.id);
    reevaluateAll(db, docIds, identity, docNotes);
    out.push(result("print_watch_prints", { moved: 1, notes }));
    if (docNotes.length > 0) out.push(result("print_watch_documents", { notes: docNotes }));
    return out;
  }

  // ── phase 1: decide the document map WITHOUT deleting anything (Codex #1:
  //    lines still reference donor documents through a non-deferrable FK) ──
  const docs = result("print_watch_documents");
  const docMap = new Map<number, number>(); // donor doc id → surviving doc id
  const donorDocs = db
    .prepare(`SELECT * FROM print_watch_documents WHERE print_id = ? ORDER BY id`)
    .all(donor.id) as DocumentRow[];
  const findTwin = db.prepare(
    `SELECT * FROM print_watch_documents
      WHERE print_id = ? AND (sha256 = ? OR (text_sha256 IS NOT NULL AND text_sha256 = ?))
      ORDER BY id LIMIT 1`,
  );
  const copyRoad = db.prepare(
    `INSERT INTO print_watch_document_roads
       (document_id, kind, source, url, first_seen_at, last_seen_at, seen_count, road_verdict, road_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id, kind, source) DO UPDATE SET
       seen_count = print_watch_document_roads.seen_count + excluded.seen_count,
       first_seen_at = MIN(print_watch_document_roads.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(print_watch_document_roads.last_seen_at, excluded.last_seen_at)`,
  );
  for (const d of donorDocs) {
    const twin = findTwin.get(target.id, d.sha256, d.text_sha256) as DocumentRow | undefined;
    if (!twin) {
      docMap.set(d.id, d.id);
      docs.moved += 1;
      continue;
    }
    const roads = db
      .prepare(`SELECT * FROM print_watch_document_roads WHERE document_id = ?`)
      .all(d.id) as DocumentRoadRow[];
    for (const r of roads) {
      copyRoad.run(
        twin.id,
        r.kind,
        r.source,
        r.url,
        r.first_seen_at,
        r.last_seen_at,
        r.seen_count,
        r.road_verdict,
        r.road_reason,
      );
    }
    // A parse that already succeeded on either copy is a fact about the BYTES.
    db.prepare(
      `UPDATE print_watch_documents
          SET parsed_at = COALESCE(parsed_at, ?),
              parse_state = CASE WHEN parse_state = 'parsed' OR ? = 'parsed' THEN 'parsed' ELSE parse_state END
        WHERE id = ?`,
    ).run(d.parsed_at, d.parse_state, twin.id);
    docMap.set(d.id, twin.id);
    docs.merged += 1;
  }

  // ── phase 2: lines — move or merge by metric_id, losslessly, doc ids remapped ──
  const lines = result("print_watch_lines");
  const donorLines = db
    .prepare(`SELECT * FROM print_watch_lines WHERE print_id = ?`)
    .all(donor.id) as LineRow[];
  const archive = db.prepare(
    `INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, ?, ?, ?)`,
  );
  const readTargetLine = db.prepare(`SELECT * FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`);
  /** Metrics this merge turned into a `conflict` because two DIFFERING
   *  acceptances met. Phase 3 can unmake them (see the re-assert below), so
   *  they are remembered here rather than re-derived afterwards. */
  const mintedConflicts: string[] = [];

  /** Which surviving document a candidate now belongs to (itself, unless its
   *  document was merged into a twin). The flash sentinel and a doc_id we never
   *  saw are NOT ours to rewrite — migration 089 preserves those on purpose. */
  const survivorOf = (docId: number): number | null => {
    if (docId === FLASH_DOC_ID) return null;
    const s = docMap.get(docId);
    return s === undefined || s === docId ? null : s;
  };

  /**
   * R-B7: no line may carry TWO candidates from ONE surviving document. The
   * doc ids that keep their own id are pre-registered by the caller so the
   * decision is order-independent — a remapped twin is archived whether it sits
   * before or after the survivor's own candidate. Anything archived keeps its
   * full provenance in `print_watch_candidate_archive`; nothing is dropped.
   */
  const remapCandidates = (
    cands: TaggedCandidate[],
    metric: string,
    docIdsKept: Set<number>,
  ): { kept: TaggedCandidate[]; touched: boolean } => {
    const kept: TaggedCandidate[] = [];
    let touched = false;
    for (const c of cands) {
      const survivor = survivorOf(c.doc_id);
      if (survivor === null) {
        kept.push(c);
        docIdsKept.add(c.doc_id);
        continue;
      }
      touched = true;
      if (docIdsKept.has(survivor)) {
        // The SAME reason prefix migration 089 phase (5) writes, so one audit
        // query covers duplicates collapsed by the rebuild and by a merge.
        archive.run(target.id, metric, JSON.stringify(c), `duplicate-of:${survivor}`);
        continue;
      }
      docIdsKept.add(survivor);
      kept.push({ ...c, doc_id: survivor });
    }
    return { kept, touched };
  };

  /**
   * Union two append-only audit trails, plus any acceptances this merge is
   * itself recording. LOSSLESS in both directions: `acceptances` stays exactly
   * the list of acceptances (nothing else is shoehorned into it, or a reader
   * counting acceptances would count noise), and anything else either trail
   * carried — an unrecognised key, or text that is not JSON at all — is kept
   * under `other` rather than dropped on the floor.
   */
  const unionAudit = (a: string | null, b: string | null, extra: unknown[] = []): string | null => {
    const acceptances: unknown[] = [];
    const other: unknown[] = [];
    const read = (s: string | null): void => {
      if (!s) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(s);
      } catch {
        other.push({ unparseable: s });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        other.push(parsed);
        return;
      }
      const rest = { ...(parsed as Record<string, unknown>) };
      if (Array.isArray(rest.acceptances)) acceptances.push(...(rest.acceptances as unknown[]));
      delete rest.acceptances;
      if (Object.keys(rest).length > 0) other.push(rest);
    };
    read(a);
    read(b);
    acceptances.push(...extra);
    if (acceptances.length === 0 && other.length === 0) return null;
    return JSON.stringify(other.length > 0 ? { acceptances, other } : { acceptances });
  };

  const reconcileLine = (
    metric: string,
    contractJson: string,
    expectedJson: string | null,
    cands: TaggedCandidate[],
    audit: string | null,
  ) => {
    let contract: LineContract | null = null;
    try {
      contract = JSON.parse(contractJson) as LineContract;
    } catch {
      contract = null;
    }
    // The same carve-out `clearLineAccepted` and `retractDocumentEvidence`
    // carry: `reconcile()` buckets candidates by their OWN metric_id and looks
    // the bucket up by `contract.metric_id`, so a drifted contract resolves to
    // an EMPTY pool and would clear a figure real evidence still supports.
    if (contract === null || contract.metric_id !== metric) {
      db.prepare(
        `UPDATE print_watch_lines SET candidates_json = ?, audit_json = ?, updated_at = datetime('now')
          WHERE print_id = ? AND metric_id = ?`,
      ).run(JSON.stringify(cands), audit, target.id, metric);
      lines.notes.push(`${metric}: contract drifted — evidence merged, reading left alone`);
      return;
    }
    const expected: Record<string, ExpectedValue> = {};
    if (expectedJson) {
      try {
        expected[metric] = JSON.parse(expectedJson) as ExpectedValue;
      } catch {
        /* an unreadable expectation simply does not participate */
      }
    }
    const [next] = reconcile([contract], expected, cands, []) as PrintWatchLine[];
    db.prepare(
      `UPDATE print_watch_lines
          SET state = ?, value = ?, value_high = ?, snippet = ?, source_doc_id = ?, candidates_json = ?,
              audit_json = ?, updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    ).run(
      next.state,
      next.value,
      next.value_high,
      next.snippet,
      resolveSourceDocId(db, next.source_doc_id),
      JSON.stringify(cands),
      audit,
      target.id,
      metric,
    );
  };

  for (const dl of donorLines) {
    const tl = readTargetLine.get(target.id, dl.metric_id) as LineRow | undefined;
    const targetRaw = tl ? parseCands(tl.candidates_json) : null;
    const targetCands = targetRaw ?? [];
    const donorRaw = parseCands(dl.candidates_json);
    if (donorRaw === null) {
      // M7: an unreadable value is never rewritten as [] — archive it verbatim.
      archive.run(target.id, dl.metric_id, dl.candidates_json, "unparseable-json");
      lines.notes.push(`${dl.metric_id}: donor candidates_json unparseable — raw value archived`);
    }
    const docIdsKept = new Set<number>(targetCands.map((c) => c.doc_id));
    for (const c of donorRaw ?? []) if (survivorOf(c.doc_id) === null) docIdsKept.add(c.doc_id);
    const { kept: donorCands, touched } =
      donorRaw === null
        ? { kept: [] as TaggedCandidate[], touched: false }
        : remapCandidates(donorRaw, dl.metric_id, docIdsKept);
    const donorSource =
      dl.source_doc_id === null
        ? null
        : resolveSourceDocId(db, survivorOf(dl.source_doc_id) ?? dl.source_doc_id);

    if (!tl) {
      db.prepare(
        `INSERT INTO print_watch_lines
           (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, audit_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        target.id,
        dl.metric_id,
        dl.contract_json,
        dl.expected_json,
        dl.state,
        dl.value,
        dl.value_high,
        dl.snippet,
        donorSource,
        // M7: an unreadable value is copied VERBATIM (its raw text is already
        // archived above) — never rewritten as the empty array `donorCands`
        // stands in for, which would silently delete evidence a human can
        // still recover by hand.
        donorRaw === null ? dl.candidates_json : JSON.stringify(donorCands),
        dl.audit_json,
      );
      // A moved line whose candidates were remapped/archived (or whose source
      // document changed hands) is re-reconciled, so its state never rests on
      // evidence it no longer carries (Codex #3). An ACCEPTED line is never
      // recomputed — the acceptance is the user's, not the reconciler's — and
      // neither is a line whose candidates could not be read: re-reconciling
      // THAT would resolve an empty pool and clear a figure over a bug in a
      // different column (the same carve-out 089 phase (11) makes).
      if (dl.state !== "accepted" && donorRaw !== null && (touched || donorSource !== dl.source_doc_id)) {
        reconcileLine(dl.metric_id, dl.contract_json, dl.expected_json, donorCands, dl.audit_json);
      }
      lines.moved += 1;
      continue;
    }

    const merged = [...targetCands, ...donorCands];
    // M7 on the TARGET side: a line whose own candidates_json cannot be read is
    // never rewritten as an array — its stored text is the only record of what
    // was measured, and a human may still recover it. The donor's readable
    // evidence is archived instead of being merged into something unreadable,
    // and every UPDATE below leaves candidates_json alone (COALESCE on null).
    let mergedJson: string | null;
    if (targetRaw === null) {
      for (const c of donorCands) {
        archive.run(target.id, dl.metric_id, JSON.stringify(c), "target-candidates-unreadable");
      }
      mergedJson = null;
      lines.notes.push(
        `${dl.metric_id}: target candidates_json unreadable — donor evidence archived, reading left alone`,
      );
    } else {
      mergedJson = JSON.stringify(merged);
    }
    const tAccepted = tl.state === "accepted";
    const dAccepted = dl.state === "accepted";
    if (tAccepted && dAccepted && (tl.value !== dl.value || tl.value_high !== dl.value_high)) {
      // Two people (or one person, twice) verified two DIFFERENT figures for
      // one metric. Neither is dropped: the line becomes a conflict the desk
      // must resolve, and both acceptances stay in the audit trail.
      const audit = unionAudit(tl.audit_json, dl.audit_json, [
        {
          event_id: targetEventId,
          value: tl.value,
          value_high: tl.value_high,
          snippet: tl.snippet,
          source_doc_id: tl.source_doc_id,
        },
        {
          event_id: donorEventId,
          value: dl.value,
          value_high: dl.value_high,
          snippet: dl.snippet,
          source_doc_id: donorSource,
        },
      ]);
      db.prepare(
        `UPDATE print_watch_lines
            SET state = 'conflict', value = NULL, value_high = NULL, snippet = NULL, source_doc_id = NULL,
                candidates_json = COALESCE(?, candidates_json), audit_json = ?, updated_at = datetime('now')
          WHERE print_id = ? AND metric_id = ?`,
      ).run(mergedJson, audit, target.id, tl.metric_id);
      mintedConflicts.push(tl.metric_id);
      lines.notes.push(`${tl.metric_id}: two differing acceptances → conflict, both kept in audit_json`);
    } else if (tAccepted) {
      db.prepare(
        `UPDATE print_watch_lines
            SET candidates_json = COALESCE(?, candidates_json), audit_json = ?, updated_at = datetime('now')
          WHERE print_id = ? AND metric_id = ?`,
      ).run(mergedJson, unionAudit(tl.audit_json, dl.audit_json), target.id, tl.metric_id);
    } else if (dAccepted) {
      db.prepare(
        `UPDATE print_watch_lines
            SET state = 'accepted', value = ?, value_high = ?, snippet = ?, source_doc_id = ?,
                candidates_json = COALESCE(?, candidates_json), audit_json = ?, updated_at = datetime('now')
          WHERE print_id = ? AND metric_id = ?`,
      ).run(
        dl.value,
        dl.value_high,
        dl.snippet,
        donorSource,
        mergedJson,
        unionAudit(tl.audit_json, dl.audit_json),
        target.id,
        tl.metric_id,
      );
    } else if (mergedJson === null) {
      // Nothing may be recomputed off evidence that could not be read (M7):
      // only the audit trails union.
      db.prepare(
        `UPDATE print_watch_lines SET audit_json = ?, updated_at = datetime('now')
          WHERE print_id = ? AND metric_id = ?`,
      ).run(unionAudit(tl.audit_json, dl.audit_json), target.id, tl.metric_id);
    } else {
      reconcileLine(
        tl.metric_id,
        tl.contract_json,
        tl.expected_json,
        merged,
        unionAudit(tl.audit_json, dl.audit_json),
      );
    }
    lines.merged += 1;
  }
  lines.deleted = db.prepare(`DELETE FROM print_watch_lines WHERE print_id = ?`).run(donor.id).changes;
  out.push(lines);

  // ── phase 3: documents. Nothing references the twins now — delete them, move
  //    the rest, and recompute every surviving verdict for the TARGET identity ──
  const twinSurvivors = new Set<number>();
  const dropTwin = db.prepare(`DELETE FROM print_watch_documents WHERE id = ?`); // roads cascade (already copied)
  const moveDoc = db.prepare(`UPDATE print_watch_documents SET print_id = ? WHERE id = ?`);
  for (const d of donorDocs) {
    const survivor = docMap.get(d.id)!;
    if (survivor === d.id) continue;
    twinSurvivors.add(survivor);
    dropTwin.run(d.id);
    docs.deleted += 1;
  }
  const movedDocIds: number[] = [];
  for (const d of donorDocs) {
    if (docMap.get(d.id) !== d.id) continue;
    moveDoc.run(target.id, d.id);
    movedDocIds.push(d.id);
  }
  // The twins absorbed the donor's roads, whose verdicts were decided against
  // the DONOR's date — they are re-judged here alongside the moved documents.
  reevaluateAll(db, new Set<number>([...movedDocIds, ...twinSurvivors]), identity, docs.notes);
  out.push(docs);

  // ── phase 3b: re-assert the conflicts phase 2 minted ──
  //
  // A document that loses its acceptance in the re-verdict above takes its
  // candidates with it (`retractDocumentEvidence`), and that re-reconciles
  // every NON-accepted line those candidates touched — which now includes the
  // `conflict` this very merge just minted. Recomputing it off whatever
  // evidence survives can land on `single_source`/`agreed` WITH a value: one
  // verified number on a line where two people accepted DIFFERENT ones. The
  // conflict is a fact about the two acceptances, not about the candidate
  // pool, so the reconciler does not get to overrule it. `candidates_json`
  // keeps whatever the retraction left (that part IS about the pool), and
  // `audit_json` is untouched by retraction, so both acceptances survive.
  if (mintedConflicts.length > 0) {
    const reassert = db.prepare(
      `UPDATE print_watch_lines
          SET state = 'conflict', value = NULL, value_high = NULL, snippet = NULL, source_doc_id = NULL,
              updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ? AND state != 'conflict'`,
    );
    for (const metric of mintedConflicts) {
      if (reassert.run(target.id, metric).changes > 0) {
        lines.notes.push(`${metric}: conflict re-asserted after the document re-verdict`);
      }
    }
  }

  // ── phase 3c: archived candidates follow the surviving print ──
  //
  // `print_watch_candidate_archive` carries NO foreign key (089), so deleting
  // the donor print below would strand every candidate ever archived for it
  // behind a print id that no longer exists — unreachable from the surviving
  // print, which is the opposite of "evidence is appended, never dropped".
  // Rows this merge archived are already keyed to the target; these are the
  // donor's older ones.
  const archiveMoved = db
    .prepare(`UPDATE print_watch_candidate_archive SET print_id = ? WHERE print_id = ?`)
    .run(target.id, donor.id).changes;
  if (archiveMoved > 0) {
    out.push(result("print_watch_candidate_archive", { moved: archiveMoved }));
  }

  // ── phase 4: the donor print row goes LAST ──
  db.prepare(`DELETE FROM print_watch_prints WHERE id = ?`).run(donor.id);
  out.push(result("print_watch_prints", { deleted: 1 }));
  return out;
}
