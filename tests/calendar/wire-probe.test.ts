import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findProbeCandidates, runWireProbePass } from "@/lib/calendar/wire-probe";
import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import * as enrichActuals from "@/lib/calendar/enrich-actuals";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// 2026-06-01 is EDT (UTC-4). Release 08:00 ET = 12:00Z.
const RELEASE_DATE = "2026-06-01";
const NOW_IN_WINDOW = new Date("2026-06-01T11:00:00.000Z"); // 07:00 ET, T-60m

function seedHeldEarnings(symbol: string, releaseTime = "08:00"): number {
  const acct = db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(`a-${symbol}`) as { id: number };
  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
       VALUES (?, 'stock', 'equity', 1) RETURNING id`,
    )
    .get(symbol) as { id: number };
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 100, date('now'))`,
  ).run(acct.id, sec.id);
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings',?,?,?,?,?,?,?)`,
    )
    .run(RELEASE_DATE, "BMO", releaseTime, symbol, `${symbol} earnings`, `finnhub:${symbol}:${RELEASE_DATE}`, RELEASE_DATE)
    .lastInsertRowid as number;
}

describe("findProbeCandidates", () => {
  it("selects a held reporter inside [release-90m, release)", () => {
    const id = seedHeldEarnings("XMTR");
    const c = findProbeCandidates(db, NOW_IN_WINDOW);
    expect(c.map((x) => x.id)).toEqual([id]);
  });

  it("excludes: outside window, actual already captured, non-held, macro rows", () => {
    seedHeldEarnings("XMTR");
    // outside window (T-3h)
    expect(findProbeCandidates(db, new Date("2026-06-01T09:00:00.000Z"))).toHaveLength(0);
    // at/after release the normal road owns it
    expect(findProbeCandidates(db, new Date("2026-06-01T12:00:00.000Z"))).toHaveLength(0);
    // actual captured
    db.prepare("UPDATE calendar_events SET actual_value = 'EPS 1' WHERE symbol = 'XMTR'").run();
    expect(findProbeCandidates(db, NOW_IN_WINDOW)).toHaveLength(0);
    // non-held symbol
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings',?,?,?,?,?,?,?)`,
    ).run(RELEASE_DATE, "BMO", "08:00", "ZZZZ", "ZZZZ earnings", `finnhub:ZZZZ:${RELEASE_DATE}`, RELEASE_DATE);
    // macro row with release_time in window
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, release_time, title, source_key, week_of)
       VALUES ('fred:10','cpi',?, '07:30', 'CPI', 'fred:10:x', ?)`,
    ).run(RELEASE_DATE, RELEASE_DATE);
    expect(findProbeCandidates(db, NOW_IN_WINDOW)).toHaveLength(0);
  });

  it("caps at 6, nearest release first", () => {
    for (let i = 0; i < 8; i++) {
      seedHeldEarnings(`SY${i}`, i < 4 ? "08:00" : "07:30");
    }
    const c = findProbeCandidates(db, new Date("2026-06-01T10:45:00.000Z")); // 06:45 ET
    expect(c).toHaveLength(6);
    expect(c.slice(0, 4).every((x) => x.release_time === "07:30")).toBe(true);
  });
});

describe("runWireProbePass", () => {
  it("empty probe stamps wire_probe_empty_at, no observation row", async () => {
    const id = seedHeldEarnings("XMTR");
    const probe = vi.fn(async () => false);
    const r = await runWireProbePass(db, { now: NOW_IN_WINDOW, probe });
    expect(r.printedEventIds).toEqual([]);
    expect(probe).toHaveBeenCalledWith("XMTR", RELEASE_DATE);
    const row = db.prepare("SELECT wire_probe_empty_at FROM calendar_events WHERE id = ?").get(id) as { wire_probe_empty_at: string | null };
    expect(row.wire_probe_empty_at).toBe(NOW_IN_WINDOW.toISOString());
    expect(db.prepare("SELECT COUNT(*) n FROM earnings_wire_observations").get()).toEqual({ n: 0 });
  });

  it("positive probe pulls release_time EARLIER and returns the event id", async () => {
    const id = seedHeldEarnings("XMTR"); // recorded 08:00
    const probe = vi.fn(async () => true);
    const r = await runWireProbePass(db, { now: NOW_IN_WINDOW, probe }); // 07:00 ET
    expect(r.printedEventIds).toEqual([id]);
    const row = db.prepare("SELECT release_time FROM calendar_events WHERE id = ?").get(id) as { release_time: string };
    expect(row.release_time).toBe("07:00");
  });

  it("a probe failure is swallowed (best-effort) and the pass continues", async () => {
    seedHeldEarnings("XMTR");
    seedHeldEarnings("WIX");
    const probe = vi
      .fn(async (sym: string) => {
        if (sym === "XMTR") throw new Error("finnhub 500");
        return false;
      });
    const r = await runWireProbePass(db, { now: NOW_IN_WINDOW, probe });
    expect(r.printedEventIds).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("runEnrichment wire-probe integration", () => {
  it("an early print is captured THIS tick with a bounded observation", async () => {
    const id = seedHeldEarnings("XMTR"); // 08:00 slot
    // Prior tick stamped an empty probe at 06:45 ET.
    db.prepare("UPDATE calendar_events SET wire_probe_empty_at = ? WHERE id = ?")
      .run("2026-06-01T10:45:00.000Z", id);
    vi.spyOn(enrichActuals, "probeFinnhubActualExists").mockResolvedValue(true);
    vi.spyOn(enrichActuals, "fetchActualForEvent").mockResolvedValue({
      actual: "EPS 0.10 · Rev 120000000",
      consensus: null,
      source: "finnhub",
    });

    const results = await runEnrichment(db, { now: NOW_IN_WINDOW }); // 07:00 ET

    const mine = results.find((r) => r.eventId === id);
    expect(mine?.actual).toBe("EPS 0.10 · Rev 120000000");
    const row = db
      .prepare("SELECT release_time, actual_value FROM calendar_events WHERE id = ?")
      .get(id) as { release_time: string; actual_value: string };
    expect(row.release_time).toBe("07:00"); // pulled earlier
    expect(row.actual_value).toBe("EPS 0.10 · Rev 120000000");
    const obs = db.prepare("SELECT * FROM earnings_wire_observations").all() as Array<Record<string, unknown>>;
    expect(obs).toHaveLength(1);
    expect(obs[0].last_empty_probe_at).toBe("2026-06-01T10:45:00.000Z"); // bounded
  });
});
