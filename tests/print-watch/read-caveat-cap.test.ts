/**
 * runFirstPassRead — the caveat cap boundary (slice D minor (c)).
 *
 * The stored read carries at most six caveats. When no call-watch line
 * survives validation, the explaining caveat must always be present, so it
 * takes the LAST slot: the model's sixth caveat is dropped on purpose. This
 * pins both sides of that boundary, with and without call-watch survivors.
 * Every identifier and figure is synthetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines } from "@/lib/print-watch/store";
import { listReads } from "@/lib/print-watch/read-store";
import { runFirstPassRead, _setReadSeams, NO_CALL_WATCH_CAVEAT } from "@/lib/print-watch/read";
import type { PrintWatchLine } from "@/lib/print-watch/types";

vi.mock("@/lib/ai/generate", () => ({ generateObjectForFeature: vi.fn(async () => { throw new Error("SDK must never be reached from tests"); }) }));
vi.mock("@/lib/ai/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/models")>();
  return { ...actual, resolveFeatureModel: () => ({ provider: "anthropic", modelId: "test-model-1" }) };
});

/** The cap `lib/print-watch/read.ts` applies (its constant is not exported). */
const CAP = 6;

let db: Database.Database; let printId: number; let dir: string;
const T0 = Date.parse("2026-09-10T20:06:00Z");
const DOC = "Acme reported revenue of $800 million.";
const READ = Array.from({ length: 6 }, (_, i) => ({ text: `Revenue of $800M is validated fact ${"abcdef"[i]}.`, cites: ["revenue_q"] }));
const WATCH_KEPT = [{ text: "What changes the sales-cycle commentary?", cites: [] }, { text: "Is pricing holding?", cites: [] }, { text: "Any change in hiring plans?", cites: [] }];
// Each cites a number the evidence does not carry, so none survives.
const WATCH_DROPPED = [{ text: "Does revenue reach $950M next quarter?", cites: ["revenue_q"] }, { text: "Does revenue reach $960M next quarter?", cites: ["revenue_q"] }, { text: "Does revenue reach $970M next quarter?", cites: ["revenue_q"] }];
const caveats = (n: number) => Array.from({ length: n }, (_, i) => `Caveat ${"abcdefgh"[i]} stands.`);

function line(): PrintWatchLine {
  return { metric_id: "revenue_q", contract: { metric_id: "revenue_q", label: "Revenue", definition: "d", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null }, expected: { value: 700e6, value_high: null, whisper: null, source_label: "VK" }, state: "accepted", value: 800e6, value_high: null, snippet: null, source_doc_id: 1, candidates_json: JSON.stringify([{ metric_id: "revenue_q", value: 800e6, value_high: null, raw_text: null, snippet: "revenue of $800 million", location_hint: null, not_disclosed: false, doc_id: 1, representation: "repA", weak_pair: false }]) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fpr-cap-"));
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db);
  const eventId = Number(db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-10','ACME','k','ACME')`).run().lastInsertRowid);
  printId = upsertPrint(db, eventId, "ACME", "2026-09-10", "16:05");
  db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label, revenue_consensus_usd) VALUES (?, 'manual', 'VK', 700000000)`).run(eventId);
  const p = path.join(dir, "d1.txt"); fs.writeFileSync(p, DOC);
  db.prepare(`INSERT INTO print_watch_documents (id, print_id, kind, source, sha256, bytes_path, gate_verdict, gate_version, parse_state) VALUES (1, ?, 'user-drop', 'drop', 'docsha1', ?, 'accepted', 2, 'parsed')`).run(printId, p);
  db.prepare(`INSERT INTO print_watch_document_roads (document_id, kind, source, road_verdict) VALUES (1, 'user-drop', 'drop', 'accepted')`).run();
  upsertLines(db, printId, [line()]);
});
afterEach(() => { _setReadSeams(null); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function storedProse(callWatch: unknown[], modelCaveats: string[]) {
  _setReadSeams({
    now: () => T0,
    generate: async () => ({ object: { read: READ, call_watch: callWatch, caveats: modelCaveats, callouts: [] }, modelId: "test-model-1" }),
    setInterval: (() => 0) as never, clearInterval: (() => undefined) as never, setTimeout: (() => 0) as never, clearTimeout: (() => undefined) as never,
  });
  const out = await runFirstPassRead(db, printId);
  expect(out.kind).toBe("done");
  return JSON.parse(listReads(db, printId).at(-1)!.prose_json!) as { call_watch: string[]; caveats: string[] };
}

describe("runFirstPassRead — caveat cap boundary", () => {
  it("call-watch survives: exactly the cap is kept whole", async () => {
    const prose = await storedProse(WATCH_KEPT, caveats(CAP));
    expect(prose.call_watch).toHaveLength(3);
    expect(prose.caveats).toEqual(caveats(CAP));
  });

  it("call-watch survives: one over the cap drops the last model caveat", async () => {
    const prose = await storedProse(WATCH_KEPT, caveats(CAP + 1));
    expect(prose.caveats).toEqual(caveats(CAP));
  });

  it("no call-watch survivor, one UNDER the cap: every model caveat is kept and the explaining caveat fills the last slot", async () => {
    const prose = await storedProse(WATCH_DROPPED, caveats(CAP - 1));
    expect(prose.call_watch).toEqual([]);
    expect(prose.caveats).toEqual([...caveats(CAP - 1), NO_CALL_WATCH_CAVEAT]);
    expect(prose.caveats).toHaveLength(CAP);
  });

  it("no call-watch survivor, exactly AT the cap: the model's sixth caveat is dropped for the explaining one", async () => {
    const prose = await storedProse(WATCH_DROPPED, caveats(CAP));
    expect(prose.caveats).toEqual([...caveats(CAP - 1), NO_CALL_WATCH_CAVEAT]);
    expect(prose.caveats).toHaveLength(CAP);
    expect(prose.caveats).not.toContain(caveats(CAP)[CAP - 1]);
  });

  it("no call-watch survivor, one OVER the cap: still the first five plus the explaining caveat", async () => {
    const prose = await storedProse(WATCH_DROPPED, caveats(CAP + 1));
    expect(prose.caveats).toEqual([...caveats(CAP - 1), NO_CALL_WATCH_CAVEAT]);
    expect(prose.caveats).toHaveLength(CAP);
  });
});
