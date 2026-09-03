import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { recordDelivery, retractDocumentEvidence, sha256Hex, textIdentityHash } from "@/lib/print-watch/delivery";
import {
  upsertPrint,
  upsertLines,
  getSheet,
  listDocuments,
  listDocumentRoads,
  listParseQueue,
  claimDocumentParse,
  finalizeDocumentParse,
  getDocument,
} from "@/lib/print-watch/store";
import { GATE_VERSION, gateFingerprint } from "@/lib/print-watch/gate";
import type { LineContract } from "@/lib/print-watch/types";

function contractFor(metric: string): LineContract {
  return {
    metric_id: metric,
    label: metric,
    definition: "t",
    basis: "gaap",
    period: "Q",
    currency: "USD",
    unit: "usd",
    kind: "point",
    segment: null,
  };
}

const CTX = { symbol: "ACME", issuerName: "Acme Corp", eventDate: "2026-08-26" };
const THIS_Q = "ACME reports Q2 2026 results. Revenue $1.0 billion.";
const LAST_Q = "ACME reports first quarter fiscal 2027 results. Revenue $0.9 billion.";
const OTHER = "Globex reports Q2 2026 results.";

let db: Database.Database;
let printId: number;

function seedEvent(target: Database.Database): number {
  return Number(
    target
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings','2026-08-26','ACME','k','ACME')`,
      )
      .run().lastInsertRowid,
  );
}

function deliver(
  kind: "dj-release" | "edgar-ex99" | "ir-page" | "user-drop" | "user-url",
  text: string,
  source = `${kind}:x`,
) {
  const bytes = Buffer.from(text, "utf8");
  return recordDelivery(db, printId, kind, source, null, bytes, {
    bytesPath: `/tmp/${sha256Hex(bytes)}.txt`,
    text,
    gateCtx: CTX,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  printId = upsertPrint(db, seedEvent(db), "ACME", "2026-08-26", "16:05");
});

describe("recordDelivery", () => {
  it("stores a new accepted document, one road, gate metadata, and asks for a parse", () => {
    const r = deliver("edgar-ex99", THIS_Q);
    expect(r).toMatchObject({ isNew: true, needsParse: true, eligible: true, parseState: "queued" });
    const [doc] = listDocuments(db, printId);
    expect(doc).toMatchObject({
      id: r.id,
      kind: "edgar-ex99",
      gate_verdict: "accepted",
      gate_reason: null,
      gate_version: GATE_VERSION,
      gate_fingerprint: gateFingerprint(CTX),
      sha256: sha256Hex(Buffer.from(THIS_Q)),
    });
    expect(listDocumentRoads(db, printId)).toEqual([
      expect.objectContaining({
        document_id: r.id,
        kind: "edgar-ex99",
        source: "edgar-ex99:x",
        seen_count: 1,
        road_verdict: "accepted",
      }),
    ]);
  });

  it("identical bytes through two roads yield ONE document with two roads and no second parse request", () => {
    const first = deliver("edgar-ex99", THIS_Q);
    const second = deliver("user-drop", THIS_Q, "user-drop:release.txt");
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ isNew: false, needsParse: false, eligible: true });
    expect(listDocuments(db, printId)).toHaveLength(1);
    expect(listDocumentRoads(db, printId).map((r) => r.kind).sort()).toEqual(["edgar-ex99", "user-drop"]);
    const third = deliver("user-drop", THIS_Q, "user-drop:release.txt");
    expect(third.needsParse).toBe(false);
    expect(listDocumentRoads(db, printId).find((r) => r.kind === "user-drop")?.seen_count).toBe(2);
  });

  it("content-plus-road eligibility: a stricter road first never blocks a later accepting road, and IR-only stays rejected", () => {
    const ir = deliver("ir-page", LAST_Q);
    expect(ir.contentVerdict.ok).toBe(true); // loose branch accepts the fiscal labels
    expect(ir.roadVerdict.ok).toBe(false); // strict ir-page period check refuses them
    expect(ir).toMatchObject({ eligible: false, needsParse: false });
    expect(listParseQueue(db, printId)).toEqual([]);

    const drop = deliver("user-drop", LAST_Q);
    expect(drop.id).toBe(ir.id);
    expect(drop).toMatchObject({ isNew: false, eligible: true, needsParse: true });
    expect(listParseQueue(db, printId).map((d) => d.id)).toEqual([ir.id]);
    const roads = listDocumentRoads(db, printId);
    expect(roads.find((r) => r.kind === "ir-page")?.road_verdict).toBe("rejected");
    expect(roads.find((r) => r.kind === "user-drop")?.road_verdict).toBe("accepted");
  });

  it("a content rejection is stored with its reason and is never eligible whatever the road", () => {
    const r = deliver("user-drop", OTHER);
    expect(r).toMatchObject({ eligible: false, needsParse: false });
    expect(r.contentVerdict).toEqual({ ok: false, reason: expect.stringMatching(/issuer not named/) });
    expect(getDocument(db, r.id)).toMatchObject({
      gate_verdict: "rejected",
      gate_reason: expect.stringMatching(/issuer/),
    });
  });

  it("re-evaluates the content gate when the fingerprint changes (issuer name learned later)", () => {
    const bytes = Buffer.from("Acme Corp reports Q2 2026 results.");
    const text = bytes.toString();
    const before = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath: "/tmp/a",
      text,
      gateCtx: { symbol: "ZZZ", issuerName: null, eventDate: "2026-08-26" },
    });
    expect(before.eligible).toBe(false);
    const after = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath: "/tmp/a",
      text,
      gateCtx: { symbol: "ZZZ", issuerName: "Acme Corp", eventDate: "2026-08-26" },
    });
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ eligible: true, needsParse: true });
    expect(getDocument(db, after.id)?.gate_fingerprint).toBe(
      gateFingerprint({ symbol: "ZZZ", issuerName: "Acme Corp", eventDate: "2026-08-26" }),
    );
  });

  it("is atomic: a road insert failure rolls back the document insert", () => {
    const bytes = Buffer.from(THIS_Q);
    expect(() =>
      recordDelivery(db, printId, "not-a-kind" as never, "x", null, bytes, {
        bytesPath: "/tmp/x",
        text: THIS_Q,
        gateCtx: CTX,
      }),
    ).toThrow();
    expect(listDocuments(db, printId)).toEqual([]);
    expect(listDocumentRoads(db, printId)).toEqual([]);
  });

  it("treats different bytes with the same normalised text as the SAME document (M13: resaved PDF / text wrapper)", () => {
    const a = recordDelivery(db, printId, "edgar-ex99", "e", null, Buffer.from(`<html><body>${THIS_Q}</body></html>`), {
      bytesPath: "/tmp/a",
      text: THIS_Q,
      gateCtx: CTX,
    });
    const b = recordDelivery(db, printId, "user-drop", "u", null, Buffer.from(`  ${THIS_Q.toUpperCase()}\n\n`), {
      bytesPath: "/tmp/b",
      text: `  ${THIS_Q.toUpperCase()}\n\n`,
      gateCtx: CTX,
    });
    expect(b).toMatchObject({ id: a.id, isNew: false, matchedBy: "text", needsParse: false });
    expect(listDocuments(db, printId)).toHaveLength(1);
    expect(listDocumentRoads(db, printId).map((r) => r.kind).sort()).toEqual(["edgar-ex99", "user-drop"]);
    expect(getDocument(db, a.id)?.text_sha256).toBe(textIdentityHash(THIS_Q));
  });

  it("retracts evidence when a re-evaluation flips the content verdict to rejected (M16)", () => {
    const bytes = Buffer.from("Acme Corp reports Q2 2026 results. Revenue $1.0 billion.");
    const text = bytes.toString();
    const first = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath: "/tmp/a",
      text,
      gateCtx: { symbol: "ZZZ", issuerName: "Acme Corp", eventDate: "2026-08-26" },
    });
    expect(first.eligible).toBe(true);
    upsertLines(db, printId, [
      {
        metric_id: "revenue_q",
        contract: contractFor("revenue_q"),
        expected: null,
        state: "single_source",
        value: 1e9,
        value_high: null,
        snippet: "s",
        source_doc_id: first.id,
        candidates_json: JSON.stringify([
          {
            metric_id: "revenue_q",
            value: 1e9,
            value_high: null,
            raw_text: "1.0",
            snippet: "s",
            location_hint: null,
            not_disclosed: false,
            doc_id: first.id,
            representation: "repB",
            weak_pair: false,
          },
        ]),
      },
    ]);
    // The issuer name is corrected: this document no longer names the issuer → rejected.
    const second = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath: "/tmp/a",
      text,
      gateCtx: { symbol: "ZZZ", issuerName: "Globex Inc", eventDate: "2026-08-26" },
    });
    expect(second).toMatchObject({ id: first.id, eligible: false });
    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    expect(line).toMatchObject({ state: "pending", value: null, source_doc_id: null, candidates_json: "[]" });
    expect(db.prepare("SELECT reason FROM print_watch_candidate_archive").all()).toEqual([{ reason: "gate-rejected" }]);
  });

  // R-B8 fix round 1. `reconcile()` reports `source_doc_id` straight off a
  // candidate's `doc_id`, and migration 089 deliberately PRESERVES candidates
  // whose `doc_id` names no document row ("not ours to rewrite"). Since
  // `print_watch_lines.source_doc_id` is a real FK, a retraction that leaves
  // such a candidate behind used to write a dangling id, throw, and roll back
  // the WHOLE delivery — wedging the one entry point every road uses, because
  // every retry re-entered the same branch. Retraction now resolves the id
  // through the store's `resolveSourceDocId`, exactly as un-accept does.
  it("retraction never writes a dangling source_doc_id: a surviving orphan candidate re-derives to a NULL document", () => {
    const bytes = Buffer.from("Acme Corp reports Q2 2026 results. Revenue $1.0 billion.");
    const text = bytes.toString();
    const first = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath: "/tmp/a",
      text,
      gateCtx: { symbol: "ZZZ", issuerName: "Acme Corp", eventDate: "2026-08-26" },
    });
    expect(first.eligible).toBe(true);

    const ORPHAN_DOC_ID = 999_999; // no such row — a 089-preserved legacy candidate
    expect(db.prepare(`SELECT 1 FROM print_watch_documents WHERE id = ?`).get(ORPHAN_DOC_ID)).toBeUndefined();
    const candidate = (docId: number) => ({
      metric_id: "revenue_q",
      value: 1e9,
      value_high: null,
      raw_text: "1.0",
      snippet: "s",
      location_hint: null,
      not_disclosed: false,
      doc_id: docId,
      representation: "repB",
      weak_pair: false,
    });
    upsertLines(db, printId, [
      {
        metric_id: "revenue_q",
        contract: contractFor("revenue_q"),
        expected: null,
        state: "agreed",
        value: 1e9,
        value_high: null,
        snippet: "s",
        source_doc_id: first.id,
        candidates_json: JSON.stringify([candidate(first.id), candidate(ORPHAN_DOC_ID)]),
      },
    ]);

    // The issuer name is corrected: this document no longer names the issuer.
    const second = recordDelivery(db, printId, "user-drop", "u", null, bytes, {
      bytesPath: "/tmp/a",
      text,
      gateCtx: { symbol: "ZZZ", issuerName: "Globex Inc", eventDate: "2026-08-26" },
    });

    // The gate flip is PERSISTED — the whole point is that nothing rolled back.
    expect(second).toMatchObject({ id: first.id, eligible: false });
    expect(getDocument(db, first.id)).toMatchObject({ gate_verdict: "rejected" });

    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    expect(line.state).toBe("single_source"); // the orphan candidate still stands alone
    expect(line.value).toBe(1e9);
    expect(line.source_doc_id).toBeNull(); // NOT 999999
    expect(JSON.parse(line.candidates_json)).toHaveLength(1);
    expect(db.prepare("SELECT reason FROM print_watch_candidate_archive").all()).toEqual([{ reason: "gate-rejected" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  // Whole-branch review (must-land minor). A `retired` line is the audit trail
  // of a contract that no longer applies to this print: it is never promoted
  // and never counted as coverage, so re-deriving it off a shrunken candidate
  // pool can only resurrect it into a live state. It gets the same carve-out
  // `accepted` gets — the evidence goes, the reading stays.
  it("a retired line loses the retracted candidates but is never re-derived (rule 6 carve-out)", () => {
    const { id } = deliver("user-drop", THIS_Q);
    const candidate = {
      metric_id: "revenue_q",
      value: 1e9,
      value_high: null,
      raw_text: "1.0",
      snippet: "s",
      location_hint: null,
      not_disclosed: false,
      doc_id: id,
      representation: "repB" as const,
      weak_pair: false,
    };
    upsertLines(db, printId, [
      {
        metric_id: "revenue_q",
        contract: contractFor("revenue_q"),
        expected: null,
        state: "retired",
        value: 1e9,
        value_high: null,
        snippet: "s",
        source_doc_id: id,
        candidates_json: JSON.stringify([candidate]),
      },
    ]);

    expect(retractDocumentEvidence(db, id, "gate-rejected")).toEqual({ archived: 1, linesChanged: 0 });

    const line = getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!;
    expect(line).toMatchObject({ state: "retired", value: 1e9, source_doc_id: id, candidates_json: "[]" });
    expect(db.prepare("SELECT reason FROM print_watch_candidate_archive").all()).toEqual([
      { reason: "gate-rejected" },
    ]);
  });

  it("never merges two documents on an EMPTY normalised text (image-only PDFs)", () => {
    const a = recordDelivery(db, printId, "user-drop", "a", null, Buffer.from([1, 2, 3]), {
      bytesPath: "/tmp/a.pdf",
      text: "   \n\n  ",
      gateCtx: CTX,
    });
    const b = recordDelivery(db, printId, "user-drop", "b", null, Buffer.from([4, 5, 6]), {
      bytesPath: "/tmp/b.pdf",
      text: "",
      gateCtx: CTX,
    });
    expect(b.id).not.toBe(a.id);
    expect(b.matchedBy).toBe("new");
    expect(listDocuments(db, printId)).toHaveLength(2);
  });

  it("an explicit user re-delivery re-queues a document that exhausted its attempts (M15); an automated road does not", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    for (let i = 1; i <= 5; i++) {
      claimDocumentParse(db, id, `t${i}`, i * 60_000);
      finalizeDocumentParse(db, id, `t${i}`, i === 5 ? "failed" : "queued", "model 529");
    }
    expect(getDocument(db, id)).toMatchObject({
      parse_state: "failed",
      parse_attempts: 5,
      parse_last_error: "model 529",
    });
    expect(deliver("edgar-ex99", THIS_Q)).toMatchObject({ id, needsParse: false, parseState: "failed" });
    const again = deliver("user-drop", THIS_Q, "user-drop:again.txt");
    expect(again).toMatchObject({ id, needsParse: true, parseState: "queued" });
    expect(getDocument(db, id)).toMatchObject({ parse_attempts: 0, parse_last_error: null });
  });
});

describe("recordDelivery across two connections (file-backed)", () => {
  /** The only test here that touches the disk — its temp dir used to leak. */
  let twoConnDir: string | null = null;
  afterEach(() => {
    if (twoConnDir) fs.rmSync(twoConnDir, { recursive: true, force: true });
    twoConnDir = null;
  });

  it("two processes delivering the same bytes see one document, two roads, and one parse claim", () => {
    twoConnDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-2conn-"));
    const file = path.join(twoConnDir, "t.db");
    const a = new Database(file);
    a.pragma("journal_mode = WAL");
    a.pragma("foreign_keys = ON");
    runMigrations(a);
    const b = new Database(file);
    b.pragma("foreign_keys = ON");
    const eventId = seedEvent(a);
    const pid = upsertPrint(a, eventId, "ACME", "2026-08-26", "16:05");
    const bytes = Buffer.from(THIS_Q);
    const ra = recordDelivery(a, pid, "edgar-ex99", "e", null, bytes, {
      bytesPath: "/tmp/x",
      text: THIS_Q,
      gateCtx: CTX,
    });
    const rb = recordDelivery(b, pid, "user-drop", "u", null, bytes, {
      bytesPath: "/tmp/x",
      text: THIS_Q,
      gateCtx: CTX,
    });
    expect(rb).toMatchObject({ id: ra.id, isNew: false, matchedBy: "bytes" });
    expect(listDocuments(b, pid)).toHaveLength(1);
    expect(listDocumentRoads(a, pid)).toHaveLength(2);
    expect(claimDocumentParse(a, ra.id, "proc-a", 1_000)).toBe(true);
    expect(claimDocumentParse(b, ra.id, "proc-b", 2_000)).toBe(false);
    expect(finalizeDocumentParse(b, ra.id, "proc-b", "parsed")).toBe(false);
    expect(finalizeDocumentParse(a, ra.id, "proc-a", "parsed")).toBe(true);
    a.close();
    b.close();
  });
});

describe("parse claims (compare-and-set)", () => {
  it("claims a queued document once, refuses a second claim, and takes over a stale claim", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    const t0 = Date.parse("2026-08-26T20:10:00Z");
    expect(claimDocumentParse(db, id, "tok-1", t0)).toBe(true);
    expect(claimDocumentParse(db, id, "tok-2", t0 + 1000)).toBe(false);
    expect(getDocument(db, id)).toMatchObject({ parse_state: "claimed", parse_claim_token: "tok-1" });
    expect(claimDocumentParse(db, id, "tok-3", t0 + 6 * 60_000)).toBe(true); // > PARSE_CLAIM_STALE_MS
    expect(getDocument(db, id)?.parse_claim_token).toBe("tok-3");
  });

  it("finalises only with the live token; a timed-out worker's finalisation is a no-op", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    const t0 = Date.parse("2026-08-26T20:10:00Z");
    claimDocumentParse(db, id, "tok-1", t0);
    claimDocumentParse(db, id, "tok-2", t0 + 6 * 60_000);
    expect(finalizeDocumentParse(db, id, "tok-1", "parsed")).toBe(false);
    expect(getDocument(db, id)?.parse_state).toBe("claimed");
    expect(finalizeDocumentParse(db, id, "tok-2", "parsed")).toBe(true);
    expect(getDocument(db, id)).toMatchObject({
      parse_state: "parsed",
      parse_claim_token: null,
      parsed_at: expect.any(String),
    });
    expect(listParseQueue(db, printId)).toEqual([]);
  });

  it("finalising back to queued keeps the document in the queue; failed removes it", () => {
    const { id } = deliver("edgar-ex99", THIS_Q);
    claimDocumentParse(db, id, "t", 1);
    finalizeDocumentParse(db, id, "t", "queued");
    expect(listParseQueue(db, printId).map((d) => d.id)).toEqual([id]);
    claimDocumentParse(db, id, "t2", 2);
    finalizeDocumentParse(db, id, "t2", "failed");
    expect(listParseQueue(db, printId)).toEqual([]);
  });
});
