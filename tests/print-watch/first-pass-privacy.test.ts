import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines } from "@/lib/print-watch/store";
import { claimRead, finalizeReadDone } from "@/lib/print-watch/read-store";
import { buildFirstPassPrompt } from "@/lib/print-watch/first-pass-prompt";
import { directionSafeFacts } from "@/lib/print-watch/read-facts";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import { buildSnapshot } from "@/scripts/snapshot-state-to-r2";
import type { PrintWatchLine } from "@/lib/print-watch/types";

vi.mock("@/lib/ai/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/models")>();
  return { ...actual, resolveFeatureModel: () => ({ provider: "anthropic", modelId: "test-model-1" }) };
});

// Unique canaries — one per field that must NEVER leave the Mac.
const C = {
  prose: "canary-prose-4d1e",
  callout: "canary-callout-9b7c",
  callNote: "canary-callnote-2f8a",
  deskNote: "canary-desknote-c3e5",       // earnings_bogeys.notes — never sent anywhere by D
  docText: "canary-doctext-77a1",
  guidance: "canary-guidance-5e02",       // earnings_bogeys.guidance_notes — sent to Anthropic ONLY (spec list), never R2/KV by D
};
let db: Database.Database; let dir: string; let eventId: number; let printId: number;
const T0 = Date.parse("2026-09-10T20:06:00Z");

function line(): PrintWatchLine {
  return { metric_id: "revenue_q", contract: { metric_id: "revenue_q", label: "Revenue", definition: "d", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null }, expected: { value: 877.3e6, value_high: null, whisper: null, source_label: "VK" }, state: "accepted", value: 898.2e6, value_high: null, snippet: null, source_doc_id: 1, candidates_json: JSON.stringify([{ metric_id: "revenue_q", value: 898.2e6, value_high: null, raw_text: null, snippet: `revenue of $898.2 million ${C.docText}`, location_hint: null, not_disclosed: false, doc_id: 1, representation: "repA", weak_pair: false }]) };
}

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fpp-priv-"));
  eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
  printId = upsertPrint(db, eventId, "ACME", "2026-09-10", "16:05");
  db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label, revenue_consensus_usd, guidance_notes, notes) VALUES (?, 'manual', 'VK', 877300000, ?, ?)`).run(eventId, `Watch ARR ${C.guidance}`, C.deskNote);
  db.prepare(`INSERT INTO earnings_call_notes (event_id, symbol, guidance, tone, surprises, follow_ups) VALUES (?, 'ACME', 'inline', ?, NULL, NULL)`).run(eventId, C.callNote);
  const p = path.join(dir, "d1.txt"); fs.writeFileSync(p, `Acme reported revenue of $898.2 million ${C.docText}. ARR reached $3.74 billion.`);
  db.prepare(`INSERT INTO print_watch_documents (id, print_id, kind, source, sha256, bytes_path, gate_verdict, gate_version, parse_state) VALUES (1, ?, 'user-drop', 'drop', 'docsha1', ?, 'accepted', 2, 'parsed')`).run(printId, p);
  db.prepare(`INSERT INTO print_watch_document_roads (document_id, kind, source, road_verdict) VALUES (1, 'user-drop', 'drop', 'accepted')`).run();
  upsertLines(db, printId, [line()]);
  const c = claimRead(db, printId, { fingerprint: "fp", recompute: () => "fp", nowMs: T0, modelId: "m" }); if (c.kind !== "claimed") throw new Error();
  finalizeReadDone(db, { readId: c.row.id, token: c.token, facts: [], prose: { read: [C.prose, "2", "3", "4", "5", "6"], call_watch: ["a", "b", "c"], caveats: [] }, nowMs: T0, callouts: [{ label: C.callout, label_norm: C.callout, value: 3.74e9, value_high: null, unit: "usd", value_text: "$3.74B", snippet: "ARR reached $3.74 billion", doc_id: 1, doc_sha256: "docsha1", evidence_sha256: "ev", verifier_version: 1, vs_bogey_text: null }] });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("data-flow contract (spec §4.4) — executed payloads with canaries (#21)", () => {
  it("buildFirstPassPrompt sends the spec list and nothing else: guidance, call note and document snippets yes; desk note, stored prose and stored callouts no", async () => {
    const built = (await buildFirstPassPrompt(db, printId))!;
    const wire = built.system + "\n" + built.user + "\n" + JSON.stringify(built.dto);
    expect(wire).toContain(C.guidance);
    expect(wire).toContain(C.callNote);
    expect(wire).toContain(C.docText);
    expect(wire).not.toContain(C.deskNote);
    expect(wire).not.toContain(C.prose);
    expect(wire).not.toContain(C.callout);
  });
  it("the R2 snapshot builder, executed, carries no read, callout, call-note or document text", () => {
    const snap = JSON.stringify(buildSnapshot(db));
    for (const canary of [C.prose, C.callout, C.callNote, C.docText]) expect(snap).not.toContain(canary);
    expect(snap).not.toMatch(/print_watch_reads|print_watch_callouts|prose_json|facts_json/);
  });
  it("the outbox writer, executed, carries only the armed projection keys", () => {
    db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(eventId);
    const r = db.transaction(() => writeArmedEventsOutboxRow(db, { today: "2026-09-10", nowMs: T0 }))();
    expect(r.written).toBe(true);
    const payload = (db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY id DESC LIMIT 1`).get() as { payload_json: string }).payload_json;
    for (const canary of Object.values(C)) expect(payload).not.toContain(canary);
    expect(payload).not.toMatch(/read|callout|prose|snippet|document/i);
  });
  it("the recap composer is untouched by this slice, and the only cross-slice view is direction-safe", () => {
    const src = fs.readFileSync("lib/digest/send-earnings-email.ts", "utf8");
    expect(src).not.toMatch(/print_watch_reads|print_watch_callouts|first-pass|read-store|read-facts/);
    const safe = directionSafeFacts([{ metric_id: "m", label: "L", state: "accepted", unit: "usd", period: "Q", kind: "point", actual: 12345, actual_high: null, expected_consensus: 12000, expected_whisper: null, expected_source: "s", expected_consensus_vendor: null, expected_basis: "specified", delta_pct: 2.88, verdict: "beat" }]);
    expect(JSON.stringify(safe)).not.toMatch(/12345|12000|2\.88/);
    expect(Object.keys(safe[0]).sort()).toEqual(["label", "metric_id", "verdict"]);
  });
  it("no Worker file mentions the first-pass read (nothing to mirror, #14 of the mechanics)", () => {
    expect(fs.readFileSync("workers/cron/test/model-tiers.test.ts", "utf8")).not.toMatch(/FEATURE_MODELS/);
  });
});
