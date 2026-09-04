import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint } from "@/lib/print-watch/store";
import {
  claimRead, heartbeatRead, finalizeReadDone, finalizeReadFailed, markReadSuperseded, getLatestDoneRead, getActiveRead, listReads,
  canScheduleRead, listCallouts, acceptCallout, revokeCalloutsForIneligibleDocs, READ_HEARTBEAT_STALE_MS, READ_RETRY_BACKOFF_MS,
  type VerifiedCalloutInput,
} from "@/lib/print-watch/read-store";

let db: Database.Database;
let printId: number;
const T0 = Date.parse("2026-09-10T20:05:00Z");
const PROSE = { read: ["r1", "r2", "r3", "r4", "r5", "r6"], call_watch: ["a", "b", "c"], caveats: [] };

function seedDoc(sha = "s1", kind = "user-drop", verdict = "accepted"): number {
  const id = Number(db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict, gate_version, parse_state) VALUES (?, ?, 'x', ?, '/tmp/x.txt', ?, 2, 'parsed')`).run(printId, kind, sha, verdict).lastInsertRowid);
  db.prepare(`INSERT INTO print_watch_document_roads (document_id, kind, source, road_verdict) VALUES (?, ?, 'x', 'accepted')`).run(id, kind);
  return id;
}
function callout(docId: number, o: Partial<VerifiedCalloutInput> = {}): VerifiedCalloutInput {
  return { label: "ARR", label_norm: "arr", value: 3.74e9, value_high: null, unit: "usd", value_text: "$3.74B", snippet: "ARR reached $3.74 billion", doc_id: docId, doc_sha256: "s1", evidence_sha256: "ev1", verifier_version: 1, vs_bogey_text: "no bogey on file", ...o };
}
function claim(fp: string, nowMs = T0, extra: { regenerate?: boolean; recompute?: () => string | null } = {}) {
  return claimRead(db, printId, { fingerprint: fp, recompute: extra.recompute ?? (() => fp), nowMs, modelId: "m", regenerate: extra.regenerate });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
  printId = upsertPrint(db, eventId, "ACME", "2026-09-10", "16:05");
});

describe("claimRead", () => {
  it("claims nonce 0; a fresh second claim is already_generating (race → one call); a recompute mismatch is drifted and writes nothing", () => {
    expect(claim("fp1").kind).toBe("claimed");
    expect(claim("fp1", T0 + 1000).kind).toBe("already_generating");
    expect(claim("fp2", T0, { recompute: () => "fp3" })).toEqual({ kind: "drifted", fingerprint: "fp3" });
    expect(db.prepare(`SELECT count(*) AS c FROM print_watch_reads`).get()).toEqual({ c: 1 });
  });
  it("takes over a stale generating row by CAS (attempt counted); the old token can no longer finalize", () => {
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    const b = claim("fp1", T0 + READ_HEARTBEAT_STALE_MS + 1); if (b.kind !== "claimed") throw new Error();
    expect(b.row.attempts).toBe(2);
    // a live claim is not schedulable; the same row once its heartbeat goes stale again is
    expect(canScheduleRead(db, printId, "fp1", T0 + READ_HEARTBEAT_STALE_MS + 1)).toBe(false);
    expect(canScheduleRead(db, printId, "fp1", T0 + 2 * READ_HEARTBEAT_STALE_MS + 3)).toBe(true);
    expect(finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [], nowMs: T0 })).toEqual({ ok: false, reason: "claim_lost" });
    expect(finalizeReadFailed(db, { readId: b.row.id, token: b.token, error: "boom", errorCode: "model_error", nowMs: T0, retryable: true })).toBe(true);
    expect(getActiveRead(db, printId)).toMatchObject({ status: "failed", error_code: "model_error", next_retry_at: new Date(T0 + READ_RETRY_BACKOFF_MS).toISOString() });
  });
  it("a failed row inside its backoff is 'backoff'; after it, a new nonce is claimed; the third failure is the cap", () => {
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadFailed(db, { readId: a.row.id, token: a.token, error: "e", errorCode: "model_error", nowMs: T0, retryable: true });
    expect(claim("fp1", T0 + 1000).kind).toBe("backoff");
    expect(canScheduleRead(db, printId, "fp1", T0 + 1000)).toBe(false);
    expect(canScheduleRead(db, printId, "fp1", T0 + READ_RETRY_BACKOFF_MS + 1)).toBe(true);
    const b = claim("fp1", T0 + READ_RETRY_BACKOFF_MS + 1); if (b.kind !== "claimed") throw new Error();
    expect(b.row.nonce).toBe(1);
    finalizeReadFailed(db, { readId: b.row.id, token: b.token, error: "e", errorCode: "timeout", nowMs: T0 + 70_000, retryable: true });
    const c = claim("fp1", T0 + 140_000); if (c.kind !== "claimed") throw new Error();
    finalizeReadFailed(db, { readId: c.row.id, token: c.token, error: "e", errorCode: "model_error", nowMs: T0 + 150_000, retryable: true });
    expect(claim("fp1", T0 + 400_000).kind).toBe("failed_cap");
    expect(canScheduleRead(db, printId, "fp1", T0 + 400_000)).toBe(false);
    expect(getActiveRead(db, printId)?.error_code).toBe("attempt_cap");
  });
  it("a non-retryable failure (model_drift) schedules no retry", () => {
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadFailed(db, { readId: a.row.id, token: a.token, error: "drift", errorCode: "model_drift", nowMs: T0, retryable: false });
    expect(getActiveRead(db, printId)?.next_retry_at).toBeNull();
    expect(canScheduleRead(db, printId, "fp1", T0 + 999_999)).toBe(false);
  });
  it("done_exists for a done fingerprint; regenerate allocates the next nonce; the done read stays the page's read while the new one generates", () => {
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [], nowMs: T0 });
    expect(claim("fp1").kind).toBe("done_exists");
    expect(canScheduleRead(db, printId, "fp1", T0)).toBe(false);
    const r = claim("fp1", T0, { regenerate: true }); if (r.kind !== "claimed") throw new Error();
    expect(r.row.nonce).toBe(1);
    expect(getLatestDoneRead(db, printId)?.id).toBe(a.row.id);
    expect(getActiveRead(db, printId)?.id).toBe(r.row.id);
  });
  it("finalizeReadDone supersedes older generating rows in the same transaction; markReadSuperseded is token-guarded", () => {
    const old = claim("fp-old", T0); const neu = claim("fp-new", T0 + 10);
    if (old.kind !== "claimed" || neu.kind !== "claimed") throw new Error();
    expect(finalizeReadDone(db, { readId: neu.row.id, token: neu.token, facts: [], prose: PROSE, callouts: [], nowMs: T0 + 20 })).toMatchObject({ ok: true });
    expect(db.prepare(`SELECT status FROM print_watch_reads WHERE id = ?`).get(old.row.id)).toEqual({ status: "superseded" });
    const x = claim("fp-x", T0 + 30); if (x.kind !== "claimed") throw new Error();
    expect(markReadSuperseded(db, x.row.id, "wrong")).toBe(false);
    expect(markReadSuperseded(db, x.row.id, x.token)).toBe(true);
    expect(getActiveRead(db, printId)).toBeNull();
  });
  it("heartbeatRead is token-guarded", () => {
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    expect(heartbeatRead(db, a.row.id, a.token, T0 + 30_000)).toBe(true);
    expect(heartbeatRead(db, a.row.id, "wrong", T0 + 30_000)).toBe(false);
  });
});

describe("callouts", () => {
  it("finalizeReadDone upserts on the semantic key, associates the read, supersedes stale proposals, never an accepted one", () => {
    const docId = seedDoc();
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [callout(docId), callout(docId, { label: "RPO", label_norm: "rpo", value: 6.9e9, snippet: "RPO of $6.9 billion" })], nowMs: T0 });
    let rows = listCallouts(db, printId);
    expect(rows.map((c) => [c.label_norm, c.state, c.read_id])).toEqual([["arr", "proposed", a.row.id], ["rpo", "proposed", a.row.id]]);
    expect(acceptCallout(db, rows[0].id, true, { nowMs: T0, verifierVersion: 1 })).toMatchObject({ ok: true, callout: { state: "accepted" } });
    const b = claim("fp1", T0 + 1000, { regenerate: true }); if (b.kind !== "claimed") throw new Error();
    const r = finalizeReadDone(db, { readId: b.row.id, token: b.token, facts: [], prose: PROSE, callouts: [callout(docId, { value: 3.75e9, value_text: "$3.75B", vs_bogey_text: "vs guide $3.70B (+1.4%)" })], nowMs: T0 + 2000 });
    expect(r).toMatchObject({ ok: true, upserted: 1, superseded: 1 });
    rows = listCallouts(db, printId);
    const arr = rows.find((c) => c.label_norm === "arr")!;
    const rpo = rows.find((c) => c.label_norm === "rpo")!;
    expect(arr).toMatchObject({ state: "accepted", value: 3.75e9, vs_bogey_text: "vs guide $3.70B (+1.4%)", read_id: b.row.id });
    expect(rpo).toMatchObject({ state: "superseded", superseded_by_read_id: b.row.id, effective_state: "superseded" });
    expect(rows).toHaveLength(2);
  });
  it("callout writes outside a live claim are impossible: a lost claim writes nothing", () => {
    const docId = seedDoc();
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    const b = claim("fp1", T0 + READ_HEARTBEAT_STALE_MS + 1); if (b.kind !== "claimed") throw new Error();
    expect(finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [callout(docId)], nowMs: T0 })).toEqual({ ok: false, reason: "claim_lost" });
    expect(listCallouts(db, printId)).toEqual([]);
    void b;
  });
  it("acceptCallout is one transaction with an eligibility join: revoked-by-document, stale verifier, unknown", () => {
    const docId = seedDoc();
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [callout(docId)], nowMs: T0 });
    const [c] = listCallouts(db, printId);
    expect(acceptCallout(db, c.id, true, { nowMs: T0, verifierVersion: 2 })).toEqual({ ok: false, reason: "stale_verifier" });
    db.prepare(`UPDATE print_watch_documents SET gate_verdict = 'rejected' WHERE id = ?`).run(docId);
    expect(listCallouts(db, printId)[0].effective_state).toBe("revoked");
    expect(acceptCallout(db, c.id, true, { nowMs: T0, verifierVersion: 1 })).toEqual({ ok: false, reason: "revoked" });
    expect(revokeCalloutsForIneligibleDocs(db, printId, T0)).toBe(1);
    expect(acceptCallout(db, 424242, true, { nowMs: T0, verifierVersion: 1 })).toEqual({ ok: false, reason: "not_found" });
  });
  it("re-proposing a revoked callout clears revoked_at as well as the supersede pointer (M7)", () => {
    // The document came back (or a byte-twin of it did) and the read proposed
    // the same figure again: the row is live evidence once more, so the
    // revocation stamp must not linger on it.
    const docId = seedDoc();
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [callout(docId)], nowMs: T0 });
    db.prepare(`UPDATE print_watch_documents SET gate_verdict = 'rejected' WHERE id = ?`).run(docId);
    expect(revokeCalloutsForIneligibleDocs(db, printId, T0)).toBe(1);
    expect(listCallouts(db, printId)[0]).toMatchObject({ state: "revoked", revoked_at: new Date(T0).toISOString() });
    db.prepare(`UPDATE print_watch_documents SET gate_verdict = 'accepted' WHERE id = ?`).run(docId);
    const b = claim("fp2", T0 + 1000); if (b.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: b.row.id, token: b.token, facts: [], prose: PROSE, callouts: [callout(docId)], nowMs: T0 + 2000 });
    expect(listCallouts(db, printId)[0]).toMatchObject({ state: "proposed", effective_state: "proposed", revoked_at: null });
  });
  it("a callout whose document row was deleted resolves through documents.sha256 = doc_sha256 (B's identity)", () => {
    const d1 = seedDoc("shared", "user-drop");
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [callout(d1, { doc_sha256: "shared" })], nowMs: T0 });
    db.prepare(`DELETE FROM print_watch_documents WHERE id = ?`).run(d1);
    expect(listCallouts(db, printId)[0]).toMatchObject({ doc_id: null, effective_state: "revoked", doc_kind: null });
    seedDoc("shared", "edgar-ex99");
    expect(listCallouts(db, printId)[0]).toMatchObject({ doc_id: null, effective_state: "proposed", doc_kind: "edgar-ex99" });
  });
  it("listReads returns every read for the print in id order", () => {
    const a = claim("fp1"); if (a.kind !== "claimed") throw new Error();
    finalizeReadDone(db, { readId: a.row.id, token: a.token, facts: [], prose: PROSE, callouts: [], nowMs: T0 });
    const b = claim("fp2", T0 + 10); if (b.kind !== "claimed") throw new Error();
    expect(listReads(db, printId).map((r) => [r.id, r.fingerprint, r.status])).toEqual([[a.row.id, "fp1", "done"], [b.row.id, "fp2", "generating"]]);
  });
});
