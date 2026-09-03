import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { setMutedEarningsSymbols } from "@/lib/queries/earnings-settings";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { todayET, addDays, mondayOf } from "@/lib/calendar/date-utils";

vi.mock("@/lib/alerts/print-push", () => ({
  sendEarningsPrintPush: vi.fn(),
}));
import { sendEarningsPrintPush } from "@/lib/alerts/print-push";
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";

const mockSendEarningsPrintPush = vi.mocked(sendEarningsPrintPush);

// Always fresh relative to the wall clock — the push-at-print hook suppresses
// payloads whose fetchedAt is >24h old, so a hardcoded date here silently
// rots the "fires" assertions the day after it ages out (bit us 2026-07-29).
const FRESH_FETCHED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function mockWorker(payloads: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ payloads }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("reconcileCloudEnrichment data-preservation guards", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    const r = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol, actual_value, enriched_at)
       VALUES ('finnhub', 'finnhub:T:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'T', 'T', 'EPS 1.42 · Rev 775,000,000', datetime('now'))`,
      )
      .run();
    eventId = Number(r.lastInsertRowid);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WORKER_MARKER_URL;
  });

  it("skips deferred payloads entirely", async () => {
    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:T:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        deferred: true,
        reaction: null,
        fetchedAt: FRESH_FETCHED_AT,
      },
    });
    const res = await reconcileCloudEnrichment(db, "secret");
    expect(res.skipped_deferred).toBe(1);
    const row = db
      .prepare("SELECT actual_value FROM calendar_events WHERE id = ?")
      .get(eventId) as { actual_value: string };
    expect(row.actual_value).toBe("EPS 1.42 · Rev 775,000,000");
  });

  it("null actual in payload never clears an existing actual", async () => {
    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:T:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } },
        fetchedAt: FRESH_FETCHED_AT,
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db
      .prepare("SELECT actual_value, reaction_snapshot FROM calendar_events WHERE id = ?")
      .get(eventId) as { actual_value: string; reaction_snapshot: string | null };
    expect(row.actual_value).toBe("EPS 1.42 · Rev 775,000,000"); // preserved
    expect(row.reaction_snapshot).toContain("yahoo"); // reaction still added
  });

  it("reaction-only payload on a row with no actual does NOT stamp enriched_at", async () => {
    const r2 = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol)
       VALUES ('finnhub', 'finnhub:U:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'U', 'U')`,
      )
      .run();
    const id2 = Number(r2.lastInsertRowid);
    mockWorker({
      [String(id2)]: {
        eventId: id2,
        source_key: "finnhub:U:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } },
        fetchedAt: FRESH_FETCHED_AT,
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db
      .prepare("SELECT enriched_at, reaction_snapshot FROM calendar_events WHERE id = ?")
      .get(id2) as { enriched_at: string | null; reaction_snapshot: string | null };
    expect(row.reaction_snapshot).toContain("yahoo");
    expect(row.enriched_at).toBeNull(); // Mac retry (Task 6) can still fetch the actual
  });

  it("TWS-wins branch does NOT stamp enriched_at when the row still lacks an actual (Task 6)", async () => {
    // A row that already has a TWS-sourced reaction (e.g. captured via the
    // Mac's own reaction-snapshot path) but no actual yet — enriched_at is
    // still NULL because Task 6's runner only stamps on completion.
    const r3 = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol, reaction_snapshot)
       VALUES ('finnhub', 'finnhub:V:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'V', 'V', ?)`,
      )
      .run(JSON.stringify({ source: "tws", spy: { delta_pct: 0.1 } }));
    const id3 = Number(r3.lastInsertRowid);
    mockWorker({
      [String(id3)]: {
        eventId: id3,
        source_key: "finnhub:V:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } },
        fetchedAt: FRESH_FETCHED_AT,
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db
      .prepare("SELECT enriched_at, actual_value, reaction_snapshot FROM calendar_events WHERE id = ?")
      .get(id3) as { enriched_at: string | null; actual_value: string | null; reaction_snapshot: string | null };
    expect(row.enriched_at).toBeNull(); // TWS wins, but no actual → Mac retry keeps going
    expect(row.actual_value).toBeNull();
    // TWS reaction is preserved — the cloud payload's Yahoo reaction is discarded (TWS wins).
    expect(row.reaction_snapshot).toContain("tws");
  });
});

describe("push-at-print hook (Wave 1 §2, cloud reconcile path)", () => {
  let db: Database.Database;

  function seedAccount(name: string): number {
    return (
      db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(name) as {
        id: number;
      }
    ).id;
  }

  function seedHeldSecurity(symbol: string): void {
    const securityId = (
      db
        .prepare(
          `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
           VALUES (?, 'stock', 'equity', 1) RETURNING id`,
        )
        .get(symbol) as { id: number }
    ).id;
    const accountId = seedAccount(`acct-${symbol}`);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, date('now'), ?)`,
    ).run(accountId, securityId, `test:${accountId}:${securityId}`);
  }

  function insertCalendarEvent(opts: {
    symbol: string;
    event_type?: string;
    actual_value?: string | null;
    consensus_value?: string | null;
    /** Defaults to the fixed '2026-07-28' fixture date every other test in
     * this file relies on. Override ONLY when the test cares about the
     * symbol's real-wall-clock ARMED status (getSymbolStatus's 14-day
     * horizon is anchored on todayET(), not on any `now` passed elsewhere
     * in the test) — a hardcoded past date would silently resolve
     * "neither" instead of "armed" regardless of arming. */
    event_date?: string;
  }): number {
    const eventDate = opts.event_date ?? "2026-07-28";
    const weekOf = opts.event_date ? mondayOf(eventDate) : "2026-07-27";
    const r = db
      .prepare(
        `INSERT INTO calendar_events
           (source, source_key, event_type, event_date, week_of, title, symbol, actual_value, consensus_value)
         VALUES ('finnhub', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `finnhub:${opts.symbol}:${eventDate}`,
        opts.event_type ?? "earnings",
        eventDate,
        weekOf,
        opts.symbol,
        opts.symbol,
        opts.actual_value ?? null,
        opts.consensus_value ?? null,
      );
    return Number(r.lastInsertRowid);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    mockSendEarningsPrintPush.mockClear();
    mockSendEarningsPrintPush.mockResolvedValue({ pushed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WORKER_MARKER_URL;
  });

  it("fires once for a held earnings row transitioning from no actual, with reactionJson from the payload", async () => {
    seedHeldSecurity("PUSH");
    const eventId = insertCalendarEvent({ symbol: "PUSH", actual_value: null });

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:PUSH:2026-07-28",
        actual: "EPS 1.42 · Rev 775,000,000",
        consensus: "EPS 1.35 · Rev 762,000,000",
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } },
        fetchedAt: FRESH_FETCHED_AT,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
    expect(mockSendEarningsPrintPush).toHaveBeenCalledWith({
      eventId,
      symbol: "PUSH",
      actualValue: "EPS 1.42 · Rev 775,000,000",
      consensusValue: "EPS 1.35 · Rev 762,000,000",
      reactionJson: JSON.stringify({ source: "yahoo", spy: { delta_pct: 0.4 } }),
      readThroughs: [],
      readThroughOnly: false,
    });
  });

  it("does NOT fire when the payload is stale (fetchedAt > 24h old)", async () => {
    seedHeldSecurity("STALE");
    const eventId = insertCalendarEvent({ symbol: "STALE", actual_value: null });
    const staleFetchedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:STALE:2026-07-28",
        actual: "EPS 1.10 · Rev 400,000,000",
        consensus: null,
        source: "cloud",
        reaction: null,
        fetchedAt: staleFetchedAt,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  it("fires when the payload is fresh (fetchedAt well within 24h)", async () => {
    seedHeldSecurity("FRESH");
    const eventId = insertCalendarEvent({ symbol: "FRESH", actual_value: null });
    const freshFetchedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:FRESH:2026-07-28",
        actual: "EPS 1.20 · Rev 410,000,000",
        consensus: null,
        source: "cloud",
        reaction: null,
        fetchedAt: freshFetchedAt,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
  });

  it("fires when the payload has NO fetchedAt (old Worker payload) — treated as fresh", async () => {
    seedHeldSecurity("OLDW");
    const eventId = insertCalendarEvent({ symbol: "OLDW", actual_value: null });

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:OLDW:2026-07-28",
        actual: "EPS 0.95 · Rev 210,000,000",
        consensus: null,
        source: "cloud",
        reaction: null,
        // fetchedAt deliberately absent — pre-Wave-1 Worker payload shape
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
  });

  it("push consensus falls back to consensus_estimate when neither the payload nor consensus_value has it", async () => {
    seedHeldSecurity("EST");
    const eventId = insertCalendarEvent({ symbol: "EST", actual_value: null });
    db.prepare(`UPDATE calendar_events SET consensus_estimate = ? WHERE id = ?`).run(
      "EPS 0.75 · Rev 250,000,000",
      eventId,
    );

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:EST:2026-07-28",
        actual: "EPS 0.90 · Rev 260,000,000",
        consensus: null,
        source: "cloud",
        reaction: null,
        fetchedAt: FRESH_FETCHED_AT,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).toHaveBeenCalledWith(
      expect.objectContaining({ consensusValue: "EPS 0.75 · Rev 250,000,000" }),
    );
  });

  it("does NOT fire when the row already had an actual", async () => {
    seedHeldSecurity("OLD");
    const eventId = insertCalendarEvent({
      symbol: "OLD",
      actual_value: "EPS 1.00 · Rev 500,000,000",
    });

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:OLD:2026-07-28",
        actual: "EPS 2.00 · Rev 600,000,000",
        consensus: null,
        source: "cloud",
        reaction: null,
        fetchedAt: FRESH_FETCHED_AT,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  // NOTE: a "deferred payload → no push" case was here previously, but it
  // was vacuous — deferred payloads `continue` before this hook is ever
  // reached (see the `if (payload.deferred)` branch above), so the
  // assertion could never fail. Replaced with the novel untested path: the
  // TWS-wins branch (existing row has a TWS-sourced reaction but no actual
  // yet) still falls through to the push hook once the cloud payload
  // delivers the first actual.
  it("fires when the TWS-wins branch delivers the first actual (existing TWS reaction, no actual yet)", async () => {
    seedHeldSecurity("TWSWIN");
    const eventId = insertCalendarEvent({ symbol: "TWSWIN", actual_value: null });
    db.prepare(`UPDATE calendar_events SET reaction_snapshot = ? WHERE id = ?`).run(
      JSON.stringify({ source: "tws", spy: { delta_pct: 0.2 } }),
      eventId,
    );

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:TWSWIN:2026-07-28",
        actual: "EPS 0.88 · Rev 300,000,000",
        consensus: "EPS 0.80 · Rev 290,000,000",
        source: "cloud",
        reaction: null,
        fetchedAt: FRESH_FETCHED_AT,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
    expect(mockSendEarningsPrintPush).toHaveBeenCalledWith({
      eventId,
      symbol: "TWSWIN",
      actualValue: "EPS 0.88 · Rev 300,000,000",
      consensusValue: "EPS 0.80 · Rev 290,000,000",
      // TWS reaction preserved (existing.reaction_snapshot) since the cloud
      // payload carried no reaction of its own.
      reactionJson: JSON.stringify({ source: "tws", spy: { delta_pct: 0.2 } }),
      readThroughs: [],
      readThroughOnly: false,
    });
  });

  it("does NOT fire for a macro row even when it carries an actual + a held symbol", async () => {
    seedHeldSecurity("MACRO");
    const eventId = insertCalendarEvent({
      symbol: "MACRO",
      event_type: "cpi",
      actual_value: null,
    });

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:MACRO:2026-07-28",
        actual: "3.2%",
        consensus: "3.1%",
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.1 } },
        fetchedAt: FRESH_FETCHED_AT,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  it("does NOT fire for a muted symbol", async () => {
    seedHeldSecurity("MUTE");
    setMutedEarningsSymbols(db, ["MUTE"]);
    const eventId = insertCalendarEvent({ symbol: "MUTE", actual_value: null });

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:MUTE:2026-07-28",
        actual: "EPS 0.50 · Rev 100,000,000",
        consensus: null,
        source: "cloud",
        reaction: null,
        fetchedAt: FRESH_FETCHED_AT,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  // [C-17 / v2 slice A §4.1] Selection consumers switched to coveredForEvents
  // (armed events get what held names get) — the push gate is explicitly
  // NOT one of them and must keep reading getSymbolStatus's held/watchlist
  // union only, through the cloud-reconcile path too. An armed-only, unheld,
  // unwatched reporter's null→non-null transition must not fire the push.
  //
  // The fixture MUST be dated inside getSymbolStatus's real-wall-clock
  // 14-day armed horizon (getSymbolStatus takes no `today` override here —
  // it always resolves against todayET()), or the symbol resolves
  // "neither" regardless of arming and this test would pass even after an
  // erroneous future widening of the gate to `status === "armed"` (fix
  // round 1, Important finding #1).
  it("does NOT fire for an armed-only reporter (not held, not watchlisted)", async () => {
    const eventDate = addDays(todayET(), 1); // inside the 14-day armed horizon
    // No seedHeldSecurity — no holding, no watchlist row. Armed only.
    const eventId = insertCalendarEvent({ symbol: "ARMED2", actual_value: null, event_date: eventDate });
    armWorksheet(db, eventId);

    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: `finnhub:ARMED2:${eventDate}`,
        actual: "EPS 0.62 · Rev 100,000,000",
        consensus: "EPS 0.55 · Rev 90,000,000",
        source: "cloud",
        reaction: null,
        fetchedAt: FRESH_FETCHED_AT,
      },
    });

    await reconcileCloudEnrichment(db, "secret");

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });
});
