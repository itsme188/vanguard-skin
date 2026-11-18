import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { ensureIntelForEvents, __resetIntelTtlForTests } from "@/lib/earnings/intel";
import { upsertEarningsIntel } from "@/lib/mutations/earnings-intel";
import { getIntelForEvents } from "@/lib/queries/earnings-intel";

/**
 * QA finding: opening Today with TWS down (no Web API config, no stored IV)
 * overwrote every stored pre-print implied move with NULLs. A refresh that
 * could not price a straddle must keep the last good implied move.
 */
let db: Database.Database;

function seed(symbol: string) {
  const secId = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, source_key, ib_con_id) VALUES (?, ?, 'Stock', ?, ?)",
  ).run(symbol, symbol, `t:${symbol}`, 111).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-13', ?, 'tws')")
    .run(secId, 100);
  const eventId = db.prepare(
    `INSERT INTO calendar_events (source, source_key, event_type, event_date, event_time, week_of, title)
     VALUES ('finnhub', 'finnhub:${symbol}:2026-07-14', 'earnings', '2026-07-14', 'AMC', '2026-07-13', '${symbol} earnings')`,
  ).run().lastInsertRowid as number;
  return { secId, eventId };
}

function depsWithNoRoad() {
  return {
    loadConfig: vi.fn(() => { throw new Error("not configured"); }),
    openSession: vi.fn(async () => "lst"),
    resolveChain: vi.fn(async () => null),
    snapshot: vi.fn(async () => []),
    refreshHistory: vi.fn(async () => true),
    historyStale: vi.fn(() => false),
    now: () => Date.parse("2026-07-14T14:00:00Z"),
    twsConnected: vi.fn(() => false),
    twsStraddle: vi.fn(async () => null),
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  __resetIntelTtlForTests();
});

describe("upsertEarningsIntel", () => {
  it("keeps the stored straddle columns and their computed_at when the new row has no implied move", () => {
    const { eventId } = seed("AAA");
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 6.5, impliedMethod: "straddle", expiryUsed: "2026-07-18",
      straddleMid: 6.5, spot: 100, computedAt: "2026-07-13 20:00:00",
    });
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: null, impliedMethod: null, expiryUsed: null,
      straddleMid: null, spot: 101, computedAt: "2026-07-14 14:00:00",
    });
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBe(6.5);
    expect(intel.impliedMethod).toBe("straddle");
    expect(intel.expiryUsed).toBe("2026-07-18");
    expect(intel.straddleMid).toBe(6.5);
    expect(intel.computedAt).toBe("2026-07-13 20:00:00");
    expect(intel.spot).toBe(101);
  });

  it("a new straddle replaces a stored straddle", () => {
    const { eventId } = seed("BBB");
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 6.5, impliedMethod: "straddle", expiryUsed: "2026-07-18",
      straddleMid: 6.5, spot: 100, computedAt: "2026-07-13 20:00:00",
    });
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 7.0, impliedMethod: "straddle", expiryUsed: "2026-07-18",
      straddleMid: 7.14, spot: 102, computedAt: "2026-07-14 14:00:00",
    });
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBe(7.0);
    expect(intel.impliedMethod).toBe("straddle");
    expect(intel.straddleMid).toBe(7.14);
    expect(intel.computedAt).toBe("2026-07-14 14:00:00");
    expect(intel.spot).toBe(102);
  });

  // QA finding (downgrade variant): with TWS down the only road left is the
  // IV approximation. It is the weaker method, so it must not replace a
  // straddle already stored for the same print.
  it("an IV approximation never replaces a stored straddle; the straddle keeps its date", () => {
    const { eventId } = seed("EEE");
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 6.5, impliedMethod: "straddle", expiryUsed: "2026-07-18",
      straddleMid: 6.5, spot: 100, computedAt: "2026-07-13 20:00:00",
    });
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 4.0, impliedMethod: "iv_approx", expiryUsed: "2026-07-17",
      straddleMid: null, spot: 102, computedAt: "2026-07-14 14:00:00",
    });
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBe(6.5);
    expect(intel.impliedMethod).toBe("straddle");
    expect(intel.expiryUsed).toBe("2026-07-18");
    expect(intel.straddleMid).toBe(6.5);
    expect(intel.computedAt).toBe("2026-07-13 20:00:00");
    expect(intel.spot).toBe(102);
  });

  it("an IV approximation replaces a stored IV approximation, and a straddle replaces it too", () => {
    const { eventId } = seed("FFF");
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 3.0, impliedMethod: "iv_approx", expiryUsed: "2026-07-17",
      straddleMid: null, spot: 100, computedAt: "2026-07-13 20:00:00",
    });
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 4.0, impliedMethod: "iv_approx", expiryUsed: "2026-07-17",
      straddleMid: null, spot: 101, computedAt: "2026-07-14 14:00:00",
    });
    let intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBe(4.0);
    expect(intel.computedAt).toBe("2026-07-14 14:00:00");
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 6.5, impliedMethod: "straddle", expiryUsed: "2026-07-18",
      straddleMid: 6.5, spot: 101, computedAt: "2026-07-14 15:00:00",
    });
    intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBe(6.5);
    expect(intel.impliedMethod).toBe("straddle");
    expect(intel.computedAt).toBe("2026-07-14 15:00:00");
  });

  it("a first write with no implied move still creates the row", () => {
    const { eventId } = seed("CCC");
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: null, impliedMethod: null, expiryUsed: null,
      straddleMid: null, spot: 50, computedAt: "2026-07-14 14:00:00",
    });
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBeNull();
    expect(intel.computedAt).toBe("2026-07-14 14:00:00");
  });
});

describe("ensureIntelForEvents with every pricing road down", () => {
  it("does not erase a stored implied move", async () => {
    const { eventId } = seed("DDD");
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 24.5, impliedMethod: "straddle", expiryUsed: "2026-07-18",
      straddleMid: 24.5, spot: 100, computedAt: "2026-07-13 20:00:00",
    });
    await ensureIntelForEvents(
      db,
      [{ id: eventId, symbol: "DDD", event_date: "2026-07-14", event_time: "AMC" }],
      { forceFresh: true },
      depsWithNoRoad() as never,
    );
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBe(24.5);
    expect(intel.impliedMethod).toBe("straddle");
  });
});

describe("ensureIntelForEvents with only the IV approximation road left", () => {
  it("does not downgrade a stored straddle to the approximation", async () => {
    const { secId, eventId } = seed("GGG");
    db.prepare(
      "INSERT INTO security_quotes (security_id, as_of_date, iv_underlying) VALUES (?, '2026-07-13', ?)",
    ).run(secId, 0.4);
    upsertEarningsIntel(db, {
      eventId, impliedMovePct: 9.0, impliedMethod: "straddle", expiryUsed: "2026-07-18",
      straddleMid: 9.0, spot: 100, computedAt: "2026-07-13 20:00:00",
    });
    await ensureIntelForEvents(
      db,
      [{ id: eventId, symbol: "GGG", event_date: "2026-07-14", event_time: "AMC" }],
      { forceFresh: true },
      depsWithNoRoad() as never,
    );
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBe(9.0);
    expect(intel.impliedMethod).toBe("straddle");
    expect(intel.computedAt).toBe("2026-07-13 20:00:00");
  });
});
