/**
 * EOD wrap cluster logic (#17).
 * Spec: docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  WRAP_THRESHOLD,
  wrapSlotFor,
  getExpectedRecapCluster,
  slotDeadlinePassed,
} from "@/lib/earnings/wrap";
import { setMutedEarningsSymbols } from "@/lib/queries/earnings-settings";

const TODAY = "2026-07-16";
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHeld(symbol: string): number {
  const sec = Number(
    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  const acct = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-07-15', ?)`,
  ).run(acct, sec, `t:${symbol}`);
  return sec;
}

function seedEvent(opts: {
  symbol: string;
  releaseTime?: string | null;
  eventTime?: string | null;
  actual?: string | null;
  enrichedAt?: string | null;
  date?: string;
  superseded?: number;
}): number {
  return Number(
    db.prepare(
      `INSERT INTO calendar_events
        (source, event_type, event_date, event_time, release_time, title, symbol,
         actual_value, enriched_at, source_key, week_of, superseded)
       VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, '2026-07-13', ?)`,
    ).run(
      opts.date ?? TODAY,
      opts.eventTime ?? null,
      opts.releaseTime === undefined ? "16:15" : opts.releaseTime,
      `${opts.symbol} earnings`,
      opts.symbol,
      opts.actual ?? null,
      opts.enrichedAt ?? null,
      `finnhub:${opts.symbol}:${opts.date ?? TODAY}`,
      opts.superseded ?? 0,
    ).lastInsertRowid,
  );
}

describe("wrapSlotFor", () => {
  it("BMO/AMC from event_time marker, title phrase, then release_time; TBD → null", () => {
    expect(wrapSlotFor({ event_time: "bmo", title: null, release_time: null })).toBe("BMO");
    expect(wrapSlotFor({ event_time: null, title: "X earnings (After Market Close)", release_time: null })).toBe("AMC");
    expect(wrapSlotFor({ event_time: null, title: null, release_time: "08:00" })).toBe("BMO");
    expect(wrapSlotFor({ event_time: null, title: null, release_time: "16:15" })).toBe("AMC");
    expect(wrapSlotFor({ event_time: null, title: null, release_time: null })).toBeNull();
  });

  it("does not classify a ticker mentioned in the title as its own slot marker", () => {
    // Bank of Montreal (BMO) reporting after market close — the ticker
    // substring "BMO" must not win over the actual "After Market Close"
    // phrase in the title.
    expect(
      wrapSlotFor({ event_time: null, title: "BMO earnings (After Market Close)", release_time: null }),
    ).toBe("AMC");
  });
});

describe("getExpectedRecapCluster", () => {
  it("counts held AMC reporters with readiness flags", () => {
    for (const s of ["AAA", "BBB", "CCC"]) seedHeld(s);
    seedEvent({ symbol: "AAA", actual: "EPS 1.00", enrichedAt: "2026-07-16 18:20:00" });
    seedEvent({ symbol: "BBB" }); // not ready
    seedEvent({ symbol: "CCC", actual: "EPS 2.00" }); // actual but not enriched → not ready

    const cluster = getExpectedRecapCluster(db, TODAY, "AMC");
    expect(cluster).toHaveLength(3);
    expect(cluster.find((m) => m.symbol === "AAA")!.ready).toBe(true);
    expect(cluster.find((m) => m.symbol === "BBB")!.ready).toBe(false);
    expect(cluster.find((m) => m.symbol === "CCC")!.ready).toBe(false);
  });

  it("excludes: non-held, other slot, skipped, muted, recap-sent, superseded; in_progress claims stay members", () => {
    for (const s of ["HELD1", "HELD2", "SKIP1", "MUTED", "SENT1", "CLAIM"]) seedHeld(s);
    seedEvent({ symbol: "HELD1" });
    seedEvent({ symbol: "HELD2", releaseTime: "08:00" }); // BMO — other slot
    seedEvent({ symbol: "NOPOS" }); // not held
    seedEvent({ symbol: "GONE", superseded: 1 });
    const skipId = seedEvent({ symbol: "SKIP1" });
    db.prepare(`INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')`).run(skipId);
    seedEvent({ symbol: "MUTED" });
    setMutedEarningsSymbols(db, ["MUTED"]);
    const sentId = seedEvent({ symbol: "SENT1" });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at) VALUES (?, 'recap', 'x', datetime('now'))`,
    ).run(sentId);
    const claimId = seedEvent({ symbol: "CLAIM" });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
       VALUES (?, 'recap', 'x', datetime('now'), 'in_progress', 'tok')`,
    ).run(claimId);

    const cluster = getExpectedRecapCluster(db, TODAY, "AMC");
    expect(cluster.map((m) => m.symbol).sort()).toEqual(["CLAIM", "HELD1"]);
  });

  it("family-dedupes cross-source, cross-symbol rows for the same print (GOOG vs GOOGL)", () => {
    seedHeld("GOOG");
    const finnhubId = seedEvent({ symbol: "GOOGL" }); // source 'finnhub' via helper, AMC (16:15)
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, release_time, title, symbol, source_key, week_of)
       VALUES ('nasdaq', 'earnings', ?, '16:15', 'GOOG earnings', 'GOOG', 'nasdaq:GOOG:2026-07-16', '2026-07-13')`,
    ).run(TODAY);

    const cluster = getExpectedRecapCluster(db, TODAY, "AMC");
    expect(cluster).toHaveLength(1);
    expect(cluster[0].eventId).toBe(finnhubId);
  });
});

describe("slotDeadlinePassed", () => {
  // 2026-07-16 is EDT (UTC-4): 12:00 ET = 16:00Z, 20:00 ET = 00:00Z next day.
  it("BMO deadline is 12:00 ET", () => {
    expect(slotDeadlinePassed("BMO", new Date("2026-07-16T15:59:00Z"))).toBe(false);
    expect(slotDeadlinePassed("BMO", new Date("2026-07-16T16:00:00Z"))).toBe(true);
  });
  it("AMC deadline is 20:00 ET", () => {
    expect(slotDeadlinePassed("AMC", new Date("2026-07-16T23:59:00Z"))).toBe(false);
    expect(slotDeadlinePassed("AMC", new Date("2026-07-17T00:00:00Z"))).toBe(true);
  });
  it("normalizes ET midnight ('24:00' from Intl) to '00:00', which is before the 20:00 AMC deadline", () => {
    // 2026-07-17T04:00:00Z is exactly ET midnight (EDT, UTC-4). Without the
    // "24:00" → "00:00" normalization this would compare "24:00" >= "20:00"
    // (true) and wrongly report the deadline as passed.
    expect(slotDeadlinePassed("AMC", new Date("2026-07-17T04:00:00Z"))).toBe(false);
  });
});

describe("WRAP_THRESHOLD", () => {
  it("is 3", () => expect(WRAP_THRESHOLD).toBe(3));
});
