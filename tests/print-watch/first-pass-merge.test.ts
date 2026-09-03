/**
 * Slice D Task 9 — D's event-merge handler, registered BEFORE slice B's.
 *
 * D's reads and callouts reference `print_watch_prints`, which B's handler
 * deletes LAST (plan M-D12), so D has to re-home its rows first. Everything
 * asserted here runs SQL-only and synchronously inside the caller's
 * transaction, exactly as `mergeEarningsEventState` demands.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { listEventMergeHandlers, mergeEarningsEventState, __resetEventMergeHandlersForTests } from "@/lib/earnings/event-merge";
import { __resetPrepareStepsForTests } from "@/lib/earnings/prepare-armed-event";
import { registerPrintWatch, __resetRegisterForTests } from "@/lib/print-watch/register";
import { __resetFirstPassRegisterForTests } from "@/lib/print-watch/first-pass-register";
import { upsertPrint, getPrintByEventId } from "@/lib/print-watch/store";
import { claimRead, finalizeReadDone, listCallouts, listReads } from "@/lib/print-watch/read-store";
import { FIRST_PASS_MERGE_HANDLER_NAME } from "@/lib/print-watch/first-pass-merge";
import { PRINT_WATCH_MERGE_HANDLER_NAME } from "@/lib/print-watch/merge-handler";

let db: Database.Database; let donor: number; let target: number; let donorPrint: number; let targetPrint: number;
let tmp: string;
const T0 = Date.parse("2026-09-10T20:06:00Z");
const PROSE = { read: ["1", "2", "3", "4", "5", "6"], call_watch: ["a", "b", "c"], caveats: [] };
/** Names the issuer and the event date's quarter, so slice B's post-merge
 *  re-verdict (which re-reads the bytes for the TARGET event's identity)
 *  keeps the surviving document accepted. */
const GATE_TEXT = "ACME reports Q3 2026 results";

function event(date: string, key: string): number {
  return Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings',?,'ACME',?,'ACME')`).run(date, key).lastInsertRowid);
}
function doc(printId: number, sha: string): number {
  const bytesPath = path.join(tmp, `${printId}-${sha}.txt`);
  fs.writeFileSync(bytesPath, GATE_TEXT, "utf8");
  const id = Number(db.prepare(`INSERT INTO print_watch_documents (print_id, kind, source, sha256, bytes_path, gate_verdict, gate_version, parse_state) VALUES (?, 'user-drop', 'drop', ?, ?, 'accepted', 2, 'parsed')`).run(printId, sha, bytesPath).lastInsertRowid);
  db.prepare(`INSERT INTO print_watch_document_roads (document_id, kind, source, road_verdict) VALUES (?, 'user-drop', 'drop', 'accepted')`).run(id);
  return id;
}
function doneRead(printId: number, fp: string, callouts: Array<{ label: string; docId: number; sha: string; unit?: "count" | "usd" }> = []): number {
  const c = claimRead(db, printId, { fingerprint: fp, recompute: () => fp, nowMs: T0, modelId: "m" }); if (c.kind !== "claimed") throw new Error();
  finalizeReadDone(db, { readId: c.row.id, token: c.token, facts: [], prose: PROSE, nowMs: T0, callouts: callouts.map((x) => ({ label: x.label, label_norm: x.label.toLowerCase(), value: 1, value_high: null, unit: x.unit ?? "count", value_text: "1", snippet: `${x.label} 1`, doc_id: x.docId, doc_sha256: x.sha, evidence_sha256: "ev", verifier_version: 1, vs_bogey_text: null })) });
  return c.row.id;
}

beforeEach(() => {
  __resetEventMergeHandlersForTests(); __resetPrepareStepsForTests(); __resetRegisterForTests(); __resetFirstPassRegisterForTests();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pw-first-pass-merge-"));
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db);
  registerPrintWatch();
  donor = event("2026-09-10", "d"); target = event("2026-09-11", "t");
  donorPrint = upsertPrint(db, donor, "ACME", "2026-09-10", "16:05"); targetPrint = upsertPrint(db, target, "ACME", "2026-09-11", "16:05");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("mergeFirstPassState", () => {
  it("is registered BEFORE slice B's handler", () => {
    const names = listEventMergeHandlers();
    expect(names.indexOf(FIRST_PASS_MERGE_HANDLER_NAME)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(FIRST_PASS_MERGE_HANDLER_NAME)).toBeLessThan(names.indexOf(PRINT_WATCH_MERGE_HANDLER_NAME));
  });

  it("moves done rows, supersedes donor generating rows (a live worker's finalise then fails), drops (fingerprint, nonce) collisions", () => {
    doneRead(donorPrint, "fpA");
    const live = claimRead(db, donorPrint, { fingerprint: "fpB", recompute: () => "fpB", nowMs: T0, modelId: "m" }); if (live.kind !== "claimed") throw new Error();
    const keep = doneRead(targetPrint, "fpA");
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();
    const mine = report.handlers.find((h) => h.name === FIRST_PASS_MERGE_HANDLER_NAME)!;
    expect(mine.tables.find((t) => t.table === "print_watch_reads")).toMatchObject({ moved: 1, merged: 1, deleted: 1 });
    // listReads orders by id: the moved donor row (fpB, id 2) precedes the target's kept fpA (id 3).
    const reads = listReads(db, targetPrint);
    expect(reads.map((r) => [r.fingerprint, r.status])).toEqual([["fpB", "superseded"], ["fpA", "done"]]);
    expect(reads[1].id).toBe(keep);
    expect(finalizeReadDone(db, { readId: live.row.id, token: live.token, facts: [], prose: PROSE, callouts: [], nowMs: T0 })).toEqual({ ok: false, reason: "claim_lost" });
    expect(listCallouts(db, targetPrint)).toEqual([]);
    expect(getPrintByEventId(db, donor)).toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("re-homes callouts on the semantic key; a collision keeps the target row and carries an accepted state; a byte-twin delete resolves through documents.sha256", () => {
    const dDoc = doc(donorPrint, "twin"); const tDoc = doc(targetPrint, "twin");
    doneRead(donorPrint, "fpD", [{ label: "ARR", docId: dDoc, sha: "twin" }, { label: "RPO", docId: dDoc, sha: "twin" }]);
    db.prepare(`UPDATE print_watch_callouts SET state = 'accepted', accepted_at = '2026-09-10T20:10:00.000Z' WHERE print_id = ? AND label_norm = 'arr'`).run(donorPrint);
    doneRead(targetPrint, "fpT", [{ label: "ARR", docId: tDoc, sha: "twin" }]);
    const targetArrId = (db.prepare(`SELECT id FROM print_watch_callouts WHERE print_id = ? AND label_norm = 'arr'`).get(targetPrint) as { id: number }).id;
    db.transaction(() => mergeEarningsEventState(db, donor, target))();
    const after = listCallouts(db, targetPrint);
    expect(after.map((c) => c.label_norm).sort()).toEqual(["arr", "rpo"]);
    const arr = after.find((c) => c.label_norm === "arr")!; const rpo = after.find((c) => c.label_norm === "rpo")!;
    expect(arr).toMatchObject({ id: targetArrId, state: "accepted" });
    expect(rpo).toMatchObject({ doc_sha256: "twin", effective_state: "proposed", doc_kind: "user-drop" }); // B deleted the donor twin; the callout resolves through the surviving document
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("when only the donor has a print, its rows follow the print B re-homes (nothing to do here)", () => {
    db.prepare(`DELETE FROM print_watch_prints WHERE id = ?`).run(targetPrint);
    doneRead(donorPrint, "fpA");
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();
    const mine = report.handlers.find((h) => h.name === FIRST_PASS_MERGE_HANDLER_NAME)!;
    expect(mine.tables.every((t) => t.moved + t.merged + t.deleted === 0)).toBe(true);
    expect(listReads(db, getPrintByEventId(db, target)!.id)).toHaveLength(1);
  });
});
