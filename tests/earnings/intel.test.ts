import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { ensureIntelForEvents, __resetIntelTtlForTests } from "@/lib/earnings/intel";
import { getIntelForEvents } from "@/lib/queries/earnings-intel";

let db: Database.Database;

function seed(symbol: string, opts: { conid?: number | null; spot?: number; iv?: number | null } = {}) {
  const secId = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, source_key, ib_con_id) VALUES (?, ?, 'Stock', ?, ?)"
  ).run(symbol, symbol, `t:${symbol}`, opts.conid ?? 111).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-13', ?, 'tws')")
    .run(secId, opts.spot ?? 128.9);
  if (opts.iv !== null) {
    db.prepare(
      "INSERT INTO security_quotes (security_id, as_of_date, iv_underlying) VALUES (?, '2026-07-13', ?)"
    ).run(secId, opts.iv ?? 0.43);
  }
  const eventId = db.prepare(
    `INSERT INTO calendar_events (source, source_key, event_type, event_date, event_time, week_of, title)
     VALUES ('finnhub', 'finnhub:${symbol}:2026-07-14', 'earnings', '2026-07-14', 'AMC', '2026-07-13', '${symbol} earnings')`
  ).run().lastInsertRowid as number;
  return { secId, eventId };
}

const EV = (id: number, symbol: string) =>
  ({ id, symbol, event_date: "2026-07-14", event_time: "AMC" });

function mkDeps(over: Record<string, unknown> = {}) {
  return {
    loadConfig: vi.fn(() => ({}) as never),
    openSession: vi.fn(async () => "lst"),
    resolveChain: vi.fn(async () => ({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 })),
    snapshot: vi.fn(async () => [
      { conid: 9003, last: 3.2, bid: 3.0, ask: 3.4, ivUnderlying: null, hv30d: null, week52High: null, week52Low: null },
      { conid: 9004, last: 3.0, bid: 2.8, ask: 3.2, ivUnderlying: null, hv30d: null, week52High: null, week52Low: null },
    ]),
    refreshHistory: vi.fn(async () => true),
    historyStale: vi.fn(() => true),
    now: () => Date.parse("2026-07-14T14:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  __resetIntelTtlForTests();
});

describe("ensureIntelForEvents", () => {
  it("straddle road: writes implied move from ATM mids", async () => {
    const { eventId } = seed("TER");
    const deps = mkDeps();
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMethod).toBe("straddle");
    expect(intel.impliedMovePct).toBeCloseTo(((3.2 + 3.0) / 128.9) * 100, 2);
    expect(intel.expiryUsed).toBe("2026-07-18");
  });

  it("falls back to IV approximation when the chain fails", async () => {
    const { eventId } = seed("TER", { iv: 0.43 });
    const deps = mkDeps({ resolveChain: vi.fn(async () => null) });
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMethod).toBe("iv_approx");
    expect(intel.impliedMovePct).toBeGreaterThan(0);
  });

  it("corrupt straddle (>60%) falls to IV road", async () => {
    const { eventId } = seed("TER", { iv: 0.43, spot: 10 }); // straddle 6.2/10 = 62%
    const deps = mkDeps();
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    expect(getIntelForEvents(db, [eventId]).get(eventId)!.impliedMethod).toBe("iv_approx");
  });

  it("no chain + no IV → null-method row still recorded", async () => {
    const { eventId } = seed("TER", { iv: null });
    const deps = mkDeps({ resolveChain: vi.fn(async () => null) });
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBeNull();
    expect(intel.impliedMethod).toBeNull();
  });

  it("TTL: second call within 30 min is a no-op; forceFresh bypasses", async () => {
    const { eventId } = seed("TER");
    const deps = mkDeps();
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    expect(deps.resolveChain).toHaveBeenCalledTimes(1);
    await ensureIntelForEvents(db, [EV(eventId, "TER")], { forceFresh: true }, deps as never);
    expect(deps.resolveChain).toHaveBeenCalledTimes(2);
  });

  it("caps history refreshes at 5 per run, family-deduped", async () => {
    const events = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((s) => {
      const { eventId } = seed(s, { conid: null });
      return EV(eventId, s);
    });
    const deps = mkDeps({ resolveChain: vi.fn(async () => null) });
    await ensureIntelForEvents(db, events, {}, deps as never);
    expect(deps.refreshHistory).toHaveBeenCalledTimes(5);
  });

  it("never throws when everything explodes", async () => {
    const { eventId } = seed("TER");
    const deps = mkDeps({
      openSession: vi.fn(async () => { throw new Error("oauth down"); }),
      refreshHistory: vi.fn(async () => { throw new Error("av down"); }),
    });
    await expect(
      ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never)
    ).resolves.toBeUndefined();
  });
});
