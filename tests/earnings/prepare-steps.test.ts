/**
 * Live print v2 slice A, Task 10 — concrete prepare steps `consensus_row`,
 * `intel`, `con_id`. See task-10-brief.md and lib/earnings/prepare-armed-event.ts
 * for the runner contract these steps plug into.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { __resetPrepareStepsForTests } from "@/lib/earnings/prepare-armed-event";
import { consensusRowStep, readVendorConsensus, FINNHUB_BOGEY_LABEL } from "@/lib/earnings/prepare-steps/consensus-row";
import { makeIntelStep } from "@/lib/earnings/prepare-steps/intel";
import { makeConIdStep } from "@/lib/earnings/prepare-steps/con-id";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); __resetPrepareStepsForTests(); });
afterEach(() => __resetPrepareStepsForTests());
const ctx = { now: () => Date.now(), signal: new AbortController().signal };
const RAW = JSON.stringify({ entry: { symbol: "GAMMA", date: "2026-09-03", hour: "", quarter: 2, year: 2027, epsEstimate: 4.75, epsActual: null, revenueEstimate: 45000000000, revenueActual: null }, history: [], finnhub_symbol: "GAMMA" });
const seed = (source: "finnhub" | "manual", rawJson: string | null, securityId: number | null = null) => Number(db.prepare(
  `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol, raw_json, security_id) VALUES (?,'earnings','2026-09-03','AMC','GAMMA','k','GAMMA',?,?)`).run(source, rawJson, securityId).lastInsertRowid);

describe("consensus_row step (spec §4.1 step 2, D1)", () => {
  it("reads the Finnhub estimate pair from raw_json only when the echoed symbol is in the event's issuer family [C-2]", () => {
    expect(readVendorConsensus(RAW, "GAMMA")).toEqual({ eps: 4.75, revenue: 45000000000 });
    expect(readVendorConsensus(null, "GAMMA")).toBeNull();
    expect(readVendorConsensus("{}", "GAMMA")).toBeNull();
    expect(readVendorConsensus(RAW.replace('"symbol":"GAMMA"', '"symbol":"GAMMA.MX"'), "GAMMA")).toBeNull();   // foreign-listing echo
    expect(readVendorConsensus(RAW, "BETA")).toBeNull();                                                      // wrong event
  });
  it("[C-2] withdrawal: when the vendor estimate disappears, the engine-owned finnhub row is deleted", async () => {
    const id = seed("finnhub", RAW);
    await consensusRowStep.run(db, id, ctx);
    db.prepare(`UPDATE calendar_events SET raw_json = ? WHERE id = ?`).run(JSON.stringify({ entry: { symbol: "GAMMA", epsEstimate: null, revenueEstimate: null }, finnhub_symbol: "GAMMA" }), id);
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done", note: "vendor consensus withdrawn; finnhub row removed" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE event_id = ?`).get(id)).toEqual({ n: 0 });
  });
  it("upserts ONE finnhub bogey row with the EPS in eps_consensus_vendor and eps_consensus NULL; revenue in revenue_consensus_usd", async () => {
    const id = seed("finnhub", RAW);
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done" });
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done" });
    const rows = db.prepare(`SELECT source, source_label, eps_consensus, eps_consensus_vendor, revenue_consensus_usd FROM earnings_bogeys WHERE event_id = ?`).all(id);
    expect(rows).toEqual([{ source: "finnhub", source_label: FINNHUB_BOGEY_LABEL, eps_consensus: null, eps_consensus_vendor: 4.75, revenue_consensus_usd: 45000000000 }]);
  });
  it("a manual event with no vendor consensus is done with a note and writes nothing", async () => {
    const id = seed("manual", null);
    expect(await consensusRowStep.run(db, id, ctx)).toEqual({ status: "done", note: "no vendor consensus on the event" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 0 });
  });
  it("fingerprint tracks the consensus fields", () => {
    const id = seed("finnhub", RAW);
    const a = consensusRowStep.fingerprint(db, id);
    db.prepare(`UPDATE calendar_events SET consensus_value = 'EPS 5.01 · Rev 45B' WHERE id = ?`).run(id);
    expect(consensusRowStep.fingerprint(db, id)).not.toBe(a);
  });
});

describe("intel step (D4)", () => {
  it("calls ensureIntelForEvents with the event's IntelEvent shape and is done", async () => {
    const ensure = vi.fn(async () => {});
    const id = seed("finnhub", RAW);
    const step = makeIntelStep({ ensure });
    expect(await step.run(db, id, ctx)).toEqual({ status: "done" });
    expect(ensure).toHaveBeenCalledWith(db, [{ id, symbol: "GAMMA", event_date: "2026-09-03", event_time: "AMC" }], { forceFresh: false });
  });
  it("a thrown ensure is a failed outcome (runner counts the attempt)", async () => {
    const id = seed("finnhub", RAW);
    const step = makeIntelStep({ ensure: vi.fn(async () => { throw new Error("IBKR 503"); }) });
    expect(await step.run(db, id, ctx)).toEqual({ status: "failed", error: "IBKR 503" });
  });
});

describe("con_id step (spec §4.1 step 4)", () => {
  const seedSecurity = (conId: number | null) => Number(db.prepare(`INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, ib_con_id) VALUES ('GAMMA','Gamma Inc','stock','equity',1,?)`).run(conId).lastInsertRowid);
  it("TWS down → pending (not an attempt), nothing called", async () => {
    const sec = seedSecurity(null); const id = seed("finnhub", RAW, sec);
    const enrich = vi.fn();
    expect(await makeConIdStep({ twsUp: () => false, enrich }).run(db, id, ctx)).toEqual({ status: "pending", reason: "TWS offline" });
    expect(enrich).not.toHaveBeenCalled();
  });
  it("conId already present → done without a TWS call", async () => {
    const sec = seedSecurity(123456); const id = seed("finnhub", RAW, sec);
    const enrich = vi.fn();
    expect(await makeConIdStep({ twsUp: () => true, enrich }).run(db, id, ctx)).toEqual({ status: "done", note: "already resolved" });
    expect(enrich).not.toHaveBeenCalled();
  });
  it("TWS up + null conId → enrichSecurities(db, [securityId]); done when the row now has a conId, failed when it still does not", async () => {
    const sec = seedSecurity(null); const id = seed("finnhub", RAW, sec);
    const enrichOk = vi.fn(async (d: Database.Database, ids: number[] = []) => { d.prepare(`UPDATE securities SET ib_con_id = 1 WHERE id = ?`).run(ids[0]); return []; });
    expect(await makeConIdStep({ twsUp: () => true, enrich: enrichOk }).run(db, id, ctx)).toEqual({ status: "done" });
    db.prepare(`UPDATE securities SET ib_con_id = NULL`).run();
    const enrichNo = vi.fn(async () => [{ symbol: "GAMMA", securityId: sec, enriched: false, error: "No security definition has been found for the request" }]);
    expect(await makeConIdStep({ twsUp: () => true, enrich: enrichNo }).run(db, id, ctx)).toEqual({ status: "failed", error: "No security definition has been found for the request" });
  });
  it("an event with no security row resolves the symbol first, and is done with a note when no row exists", async () => {
    const id = seed("manual", null, null);
    expect(await makeConIdStep({ twsUp: () => true, enrich: vi.fn() }).run(db, id, ctx)).toEqual({ status: "done", note: "no securities row for GAMMA" });
  });
});
