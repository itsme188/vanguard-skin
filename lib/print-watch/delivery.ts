// The ONE delivery entry (spec §4.2 "Identity and eligibility"). Every road —
// wire, EDGAR, IR page, drop, pasted URL — records its bytes here, in one
// immediate transaction: upsert the document by content, upsert the road with
// its own verdict, (re-)evaluate the content gate when the identity fingerprint
// changed, and decide whether a parse is now owed.
//
// The byte write and any text extraction happen BEFORE this call (they are not
// transactional); the caller passes what it wrote (plan M4). That split is
// deliberate — a rolled-back transaction must never leave the caller believing
// bytes it never wrote are on disk, and file I/O inside an immediate
// transaction would hold the write lock across a slow syscall.
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import {
  GATE_VERSION,
  gateFingerprint,
  contentVerdict,
  roadVerdict,
  type DocGateContext,
  type DocGateVerdict,
} from "./gate";
import { reconcile } from "./reconcile";
import { anyRoadAccepted } from "./store";
import type {
  ExpectedValue,
  LineContract,
  ParseState,
  PrintWatchDocKind,
  PrintWatchLine,
  TaggedCandidate,
} from "./types";

export interface DeliveryInput {
  bytesPath: string;
  /** The text the gate reads: utf8 for HTML/text, the poppler text for a PDF. */
  text: string;
  gateCtx: DocGateContext;
}

export interface DeliveryResult {
  id: number;
  isNew: boolean;
  needsParse: boolean;
  eligible: boolean;
  contentVerdict: DocGateVerdict;
  roadVerdict: DocGateVerdict;
  parseState: ParseState;
  /** "bytes" = same sha256 existed; "text" = only the normalised text matched (M13); "new" otherwise. */
  matchedBy: "new" | "bytes" | "text";
}

export function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Normalised-text identity (M13): whitespace collapsed, trimmed, lower-cased —
 *  a resaved PDF or a text wrapper of one release is the SAME document. */
export function textIdentityHash(text: string): string {
  return sha256Hex(text.replace(/\s+/g, " ").trim().toLowerCase());
}

/** Roads a person drives. Only these may re-queue a document that exhausted its attempts (M15). */
const USER_ROADS: ReadonlySet<PrintWatchDocKind> = new Set<PrintWatchDocKind>(["user-drop", "user-url"]);

interface ExistingRow {
  id: number;
  gate_verdict: "accepted" | "rejected";
  gate_reason: string | null;
  gate_fingerprint: string | null;
  parse_state: ParseState;
}

interface LineRow {
  metric_id: string;
  contract_json: string;
  expected_json: string | null;
  state: string;
  value: number | null;
  value_high: number | null;
  source_doc_id: number | null;
  candidates_json: string;
}

/**
 * Evidence retraction (M16): archive every candidate that came from `docId` and
 * re-reconcile each affected NON-accepted line from its stored contract/expected.
 * An accepted line only loses the retracted candidates from its audit trail
 * (rule 6). Synchronous; runs inside the caller's transaction.
 */
export function retractDocumentEvidence(
  db: Database.Database,
  docId: number,
  reason: string,
): { archived: number; linesChanged: number } {
  const owner = db.prepare(`SELECT print_id FROM print_watch_documents WHERE id = ?`).get(docId) as
    | { print_id: number }
    | undefined;
  if (!owner) return { archived: 0, linesChanged: 0 };
  const printId = owner.print_id;
  const lines = db
    .prepare(
      `SELECT metric_id, contract_json, expected_json, state, value, value_high, source_doc_id, candidates_json
         FROM print_watch_lines WHERE print_id = ?`,
    )
    .all(printId) as LineRow[];
  const archive = db.prepare(
    `INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, ?, ?, ?)`,
  );
  const writeLine = db.prepare(
    `UPDATE print_watch_lines
        SET state = ?, value = ?, value_high = ?, snippet = ?, source_doc_id = ?, candidates_json = ?, updated_at = datetime('now')
      WHERE print_id = ? AND metric_id = ?`,
  );
  const writeAudit = db.prepare(
    `UPDATE print_watch_lines SET candidates_json = ?, updated_at = datetime('now') WHERE print_id = ? AND metric_id = ?`,
  );
  let archived = 0;
  let linesChanged = 0;
  for (const line of lines) {
    let candidates: TaggedCandidate[];
    try {
      const parsed: unknown = JSON.parse(line.candidates_json);
      candidates = Array.isArray(parsed) ? (parsed as TaggedCandidate[]) : [];
    } catch {
      continue; // unreadable JSON is left exactly as it is (M7)
    }
    const kept = candidates.filter((c) => c.doc_id !== docId);
    if (kept.length === candidates.length) continue;
    for (const c of candidates) {
      if (c.doc_id !== docId) continue;
      archive.run(printId, line.metric_id, JSON.stringify(c), reason);
      archived += 1;
    }
    if (line.state === "accepted") {
      writeAudit.run(JSON.stringify(kept), printId, line.metric_id);
      continue;
    }

    // Same carve-out `clearLineAccepted` carries: `reconcile` buckets
    // candidates by their OWN metric_id and looks the bucket up by
    // `contract.metric_id`, so a drifted/unreadable contract resolves to an
    // EMPTY pool and would clear a figure that real evidence — from a
    // DIFFERENT document — still supports. Retract the evidence, leave the
    // reading alone, and let a human see the mismatch.
    let contract: LineContract | null = null;
    let expected: Record<string, ExpectedValue> = {};
    try {
      contract = JSON.parse(line.contract_json) as LineContract;
      if (line.expected_json) expected = { [line.metric_id]: JSON.parse(line.expected_json) as ExpectedValue };
    } catch {
      contract = null;
    }
    if (contract === null || contract.metric_id !== line.metric_id) {
      writeAudit.run(JSON.stringify(kept), printId, line.metric_id);
      continue;
    }

    const [next] = reconcile([contract], expected, kept, []) as PrintWatchLine[];
    const nextSource = next.source_doc_id === 0 ? null : next.source_doc_id;
    writeLine.run(
      next.state,
      next.value,
      next.value_high,
      next.snippet,
      nextSource,
      JSON.stringify(kept),
      printId,
      line.metric_id,
    );
    if (next.state !== line.state || next.value !== line.value || nextSource !== line.source_doc_id) linesChanged += 1;
  }
  return { archived, linesChanged };
}

export function recordDelivery(
  db: Database.Database,
  printId: number,
  kind: PrintWatchDocKind,
  source: string,
  url: string | null,
  bytes: Buffer,
  input: DeliveryInput,
): DeliveryResult {
  const sha = sha256Hex(bytes);
  const textSha = textIdentityHash(input.text);
  const fingerprint = gateFingerprint(input.gateCtx);
  const selectExisting = `SELECT id, gate_verdict, gate_reason, gate_fingerprint, parse_state FROM print_watch_documents`;

  const txn = db.transaction((): DeliveryResult => {
    const bySha = db.prepare(`${selectExisting} WHERE print_id = ? AND sha256 = ?`).get(printId, sha) as
      | ExistingRow
      | undefined;
    const byText = bySha
      ? undefined
      : (db
          .prepare(`${selectExisting} WHERE print_id = ? AND text_sha256 = ? ORDER BY id LIMIT 1`)
          .get(printId, textSha) as ExistingRow | undefined);
    const existing = bySha ?? byText;
    const matchedBy: DeliveryResult["matchedBy"] = bySha ? "bytes" : byText ? "text" : "new";

    let id: number;
    let isNew: boolean;
    let content: DocGateVerdict;
    let eligibleBefore = false;

    if (!existing) {
      content = contentVerdict(input.text, input.gateCtx);
      const r = db
        .prepare(
          `INSERT INTO print_watch_documents
             (print_id, kind, source, url, sha256, bytes_path, gate_verdict, gate_reason, gate_version, gate_fingerprint, parse_state, text_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          printId,
          kind,
          source,
          url,
          sha,
          input.bytesPath,
          content.ok ? "accepted" : "rejected",
          content.ok ? null : content.reason,
          GATE_VERSION,
          fingerprint,
          textSha,
        );
      id = Number(r.lastInsertRowid);
      isNew = true;
    } else {
      id = existing.id;
      isNew = false;
      eligibleBefore = existing.gate_verdict === "accepted" && anyRoadAccepted(db, id);
      db.prepare(
        `UPDATE print_watch_documents SET last_seen_at = datetime('now'), text_sha256 = COALESCE(text_sha256, ?) WHERE id = ?`,
      ).run(textSha, id);
      if (existing.gate_fingerprint !== fingerprint) {
        content = contentVerdict(input.text, input.gateCtx);
        db.prepare(
          `UPDATE print_watch_documents SET gate_verdict = ?, gate_reason = ?, gate_version = ?, gate_fingerprint = ? WHERE id = ?`,
        ).run(
          content.ok ? "accepted" : "rejected",
          content.ok ? null : content.reason,
          GATE_VERSION,
          fingerprint,
          id,
        );
        // M16: evidence from a document the gate no longer accepts is retracted, not left green.
        if (existing.gate_verdict === "accepted" && !content.ok) retractDocumentEvidence(db, id, "gate-rejected");
      } else {
        content = existing.gate_verdict === "accepted" ? { ok: true } : { ok: false, reason: existing.gate_reason ?? "rejected" };
      }
      // M15: a person re-delivering the same bytes gets a fresh attempt budget; an automated road never does.
      if (existing.parse_state === "failed" && USER_ROADS.has(kind)) {
        db.prepare(
          `UPDATE print_watch_documents SET parse_state = 'queued', parse_attempts = 0, parse_last_error = NULL WHERE id = ?`,
        ).run(id);
      }
    }

    const road = roadVerdict(kind, input.text, input.gateCtx);
    db.prepare(
      `INSERT INTO print_watch_document_roads (document_id, kind, source, url, road_verdict, road_reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id, kind, source) DO UPDATE SET
         last_seen_at = datetime('now'),
         seen_count = print_watch_document_roads.seen_count + 1,
         url = COALESCE(excluded.url, print_watch_document_roads.url),
         road_verdict = excluded.road_verdict,
         road_reason = excluded.road_reason`,
    ).run(id, kind, source, url, road.ok ? "accepted" : "rejected", road.ok ? null : road.reason);

    const eligible = content.ok && anyRoadAccepted(db, id);
    // M16, second trigger: the last accepting road was withdrawn (a road verdict re-evaluated to rejected).
    if (existing && eligibleBefore && !eligible && content.ok) retractDocumentEvidence(db, id, "road-rejected");

    const parseState = (db.prepare(`SELECT parse_state FROM print_watch_documents WHERE id = ?`).get(id) as {
      parse_state: ParseState;
    }).parse_state;
    const requeued = existing?.parse_state === "failed" && parseState === "queued";
    const needsParse = eligible && parseState === "queued" && (isNew || !eligibleBefore || requeued);
    return { id, isNew, needsParse, eligible, contentVerdict: content, roadVerdict: road, parseState, matchedBy };
  });

  return txn.immediate();
}
