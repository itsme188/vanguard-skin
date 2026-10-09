/**
 * A reaction captured in the cloud goes through the SAME validity rule as one
 * captured on the Mac before it is stored (lib/calendar/reaction-validity.ts).
 *
 * The Worker used to capture a macro reaction minutes after the release and
 * the Mac stored it as-is, so with the Mac asleep a 5-minute move was shown
 * as the two-hour reaction. The actual is always kept; only the reaction is
 * refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/alerts/print-push", () => ({
  sendEarningsPrintPush: vi.fn(),
}));
import { sendEarningsPrintPush } from "@/lib/alerts/print-push";
import { admitCloudReaction, reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";

const T0 = "2026-07-14T12:30:00.000Z"; // 08:30 ET release
const T0_MS = Date.parse(T0);
const at = (minutes: number) => new Date(T0_MS + minutes * 60_000).toISOString();

/** The shape workers/cron/src/yahoo.ts::captureReactionFromYahoo produces. */
function yahooSnapshot(extra: Record<string, unknown> = {}) {
  return {
    t0_utc: T0,
    window_min: 120,
    source: "yahoo",
    spy: { t_pre: 500, t_post: 502, delta_pct: 0.4 },
    qqq: { t_pre: 400, t_post: 402, delta_pct: 0.5 },
    tlt: { t_pre: 90, t_post: 89.1, delta_pct: -1 },
    ...extra,
  };
}

function mockWorker(payloads: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ payloads }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("cloud reaction validity at reconcile", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    const r = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, release_time)
         VALUES ('fred', 'fred:10:2026-07-14', 'cpi', '2026-07-14', '2026-07-13', 'CPI', '08:30')`,
      )
      .run();
    eventId = Number(r.lastInsertRowid);
    vi.mocked(sendEarningsPrintPush).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WORKER_MARKER_URL;
  });

  function payload(reaction: unknown, extra: Record<string, unknown> = {}) {
    return {
      [String(eventId)]: {
        eventId,
        source_key: "fred:10:2026-07-14",
        actual: "3.2%",
        consensus: "3.1%",
        source: "fred",
        reaction,
        ...extra,
      },
    };
  }

  function readRow() {
    return db
      .prepare("SELECT actual_value, reaction_snapshot, enriched_at FROM calendar_events WHERE id = ?")
      .get(eventId) as { actual_value: string | null; reaction_snapshot: string | null; enriched_at: string | null };
  }

  it("a snapshot stamped 5 minutes after release is NOT stored; the actual is", async () => {
    mockWorker(payload(yahooSnapshot({ captured_at: at(5) }), { fetchedAt: at(5) }));
    const res = await reconcileCloudEnrichment(db, "secret");
    expect(res.reconciled).toBe(1);
    const row = readRow();
    expect(row.actual_value).toBe("3.2%");
    expect(row.enriched_at).not.toBeNull();
    expect(row.reaction_snapshot).toBeNull();
  });

  it("a snapshot stamped at release + 120 minutes is stored with its stamp", async () => {
    mockWorker(payload(yahooSnapshot({ captured_at: at(120) }), { fetchedAt: at(120) }));
    await reconcileCloudEnrichment(db, "secret");
    const snap = JSON.parse(readRow().reaction_snapshot!);
    expect(snap.spy.delta_pct).toBe(0.4);
    expect(snap.captured_at).toBe(at(120));
  });

  it("the snapshot's own stamp wins over a later payload fetchedAt", async () => {
    // An earnings payload is re-written on later ticks (fetchedAt moves), the
    // reaction inside it is not re-captured.
    mockWorker(payload(yahooSnapshot({ captured_at: at(5) }), { fetchedAt: at(180) }));
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow().reaction_snapshot).toBeNull();
  });

  it("no stamp: payload.fetchedAt is the capture time — early is refused", async () => {
    mockWorker(payload(yahooSnapshot(), { fetchedAt: at(5) }));
    await reconcileCloudEnrichment(db, "secret");
    const row = readRow();
    expect(row.actual_value).toBe("3.2%");
    expect(row.reaction_snapshot).toBeNull();
  });

  it("no stamp: payload.fetchedAt is the capture time — after the window it is stored and stamped", async () => {
    mockWorker(payload(yahooSnapshot(), { fetchedAt: at(125) }));
    await reconcileCloudEnrichment(db, "secret");
    const snap = JSON.parse(readRow().reaction_snapshot!);
    expect(snap.tlt.delta_pct).toBe(-1);
    expect(snap.captured_at).toBe(at(125));
  });

  it("a dead-quote leg is dropped from an otherwise valid snapshot", async () => {
    mockWorker(
      payload(yahooSnapshot({ qqq: { t_pre: 0, t_post: 0, delta_pct: 0 } }), { fetchedAt: at(125) }),
    );
    await reconcileCloudEnrichment(db, "secret");
    const snap = JSON.parse(readRow().reaction_snapshot!);
    expect(snap.qqq).toBeUndefined();
    expect(snap.spy.delta_pct).toBe(0.4);
  });

  describe("legacy payload (no captured_at, no fetchedAt)", () => {
    it("legs that look like a real move are stored, without an invented stamp", async () => {
      mockWorker(payload(yahooSnapshot()));
      await reconcileCloudEnrichment(db, "secret");
      const snap = JSON.parse(readRow().reaction_snapshot!);
      expect(snap.spy.delta_pct).toBe(0.4);
      expect(snap.captured_at).toBeUndefined();
    });

    it("a leg whose pre and post price are identical is dropped; the rest is stored", async () => {
      mockWorker(payload(yahooSnapshot({ spy: { t_pre: 500, t_post: 500, delta_pct: 0 } })));
      await reconcileCloudEnrichment(db, "secret");
      const snap = JSON.parse(readRow().reaction_snapshot!);
      expect(snap.spy).toBeUndefined();
      expect(snap.qqq.delta_pct).toBe(0.5);
    });

    it("when every benchmark leg is an identical pre/post pair nothing is stored; the actual is", async () => {
      mockWorker(
        payload(
          yahooSnapshot({
            spy: { t_pre: 500, t_post: 500, delta_pct: 0 },
            qqq: { t_pre: 400, t_post: 400, delta_pct: 0 },
            tlt: { t_pre: 90, t_post: 90, delta_pct: 0 },
          }),
        ),
      );
      await reconcileCloudEnrichment(db, "secret");
      const row = readRow();
      expect(row.actual_value).toBe("3.2%");
      expect(row.reaction_snapshot).toBeNull();
    });

    it("a move that rounds to zero on a row enriched before the window could be measured is dropped", async () => {
      db.prepare("UPDATE calendar_events SET enriched_at = ? WHERE id = ?").run(
        at(10).replace("T", " ").slice(0, 19),
        eventId,
      );
      mockWorker(payload(yahooSnapshot({ spy: { t_pre: 500, t_post: 500.01, delta_pct: 0 } })));
      await reconcileCloudEnrichment(db, "secret");
      const snap = JSON.parse(readRow().reaction_snapshot!);
      expect(snap.spy).toBeUndefined();
      expect(snap.tlt.delta_pct).toBe(-1);
    });
  });

  it("a refused reaction never overwrites a reaction the row already has", async () => {
    const existing = JSON.stringify(yahooSnapshot({ source: "polygon", captured_at: at(130) }));
    db.prepare("UPDATE calendar_events SET reaction_snapshot = ? WHERE id = ?").run(existing, eventId);
    mockWorker(payload(yahooSnapshot({ captured_at: at(5) }), { fetchedAt: at(5) }));
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow().reaction_snapshot).toBe(existing);
  });

  it("the print push never carries a refused reaction", async () => {
    const fresh = Date.now();
    const t0 = new Date(fresh - 10 * 60_000).toISOString();
    const r = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol)
         VALUES ('finnhub', 'finnhub:AAPL:2026-07-14', 'earnings', '2026-07-14', '2026-07-13', 'AAPL', 'AAPL')`,
      )
      .run();
    const id = Number(r.lastInsertRowid);
    const securityId = (
      db
        .prepare(
          `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
           VALUES ('AAPL', 'stock', 'equity', 1) RETURNING id`,
        )
        .get() as { id: number }
    ).id;
    const accountId = (
      db.prepare("INSERT INTO accounts (name) VALUES ('acct') RETURNING id").get() as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, date('now'), 'test:held')`,
    ).run(accountId, securityId);
    mockWorker({
      [String(id)]: {
        eventId: id,
        source_key: "finnhub:AAPL:2026-07-14",
        actual: "EPS 1.60",
        consensus: null,
        source: "finnhub",
        reaction: yahooSnapshot({ t0_utc: t0 }),
        fetchedAt: new Date(fresh - 5 * 60_000).toISOString(),
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(vi.mocked(sendEarningsPrintPush)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEarningsPrintPush).mock.calls[0][0].reactionJson).toBeNull();
  });
});

describe("admitCloudReaction", () => {
  it("returns null for anything that is not a snapshot object", () => {
    expect(admitCloudReaction(null, { fetchedAt: at(125) })).toBeNull();
    expect(admitCloudReaction("yahoo", { fetchedAt: at(125) })).toBeNull();
    expect(admitCloudReaction([1, 2], { fetchedAt: at(125) })).toBeNull();
  });

  it("a stamped snapshot with an unreadable release time fails closed", () => {
    expect(
      admitCloudReaction(yahooSnapshot({ t0_utc: "not a date", captured_at: at(125) }), {}),
    ).toBeNull();
  });

  it("an unreadable fetchedAt falls back to the legacy rule", () => {
    const out = admitCloudReaction(yahooSnapshot(), { fetchedAt: "soon" });
    expect(out?.spy?.delta_pct).toBe(0.4);
    expect(out?.captured_at).toBeUndefined();
  });
});
