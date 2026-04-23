/**
 * Unit tests for lib/queries/level-performance.ts
 *
 * Seeds levels + alerts + price history and verifies the P&L attribution
 * math, the <3-sample null rule, and the release-reactions lookup.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSourcePerformance,
  getRecentReleaseReactions,
  getSectorEtfGaps,
} from "@/lib/queries/level-performance";

function seedSecurity(db: Database.Database, id: number, symbol: string) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, asset_class, multiplier)
     VALUES (?, ?, ?, 'stock', 'equity', 1)`,
  ).run(id, symbol, `${symbol} Corp`);
}

function insertLevel(
  db: Database.Database,
  opts: {
    id: number;
    securityId: number;
    source: string;
    source_author: string | null;
    price: number;
  },
) {
  db.prepare(
    `INSERT INTO security_levels
       (id, security_id, level_type, price, source, source_author)
     VALUES (?, ?, 'support', ?, ?, ?)`,
  ).run(opts.id, opts.securityId, opts.price, opts.source, opts.source_author);
}

function insertAlert(
  db: Database.Database,
  opts: {
    levelId: number;
    securityId: number;
    triggeredAt: string;
    triggeredPrice: number;
    response: "acted" | "ignored" | "dismissed" | "pending";
  },
) {
  db.prepare(
    `INSERT INTO level_alerts
       (level_id, security_id, triggered_at, triggered_price, user_response)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.levelId,
    opts.securityId,
    opts.triggeredAt,
    opts.triggeredPrice,
    opts.response,
  );
}

function insertPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  price: number,
) {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source)
     VALUES (?, ?, ?, 'tws')`,
  ).run(securityId, date, price);
}

describe("getSourcePerformance", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns empty array when no alerts fired", () => {
    seedSecurity(db, 1, "AAPL");
    insertLevel(db, {
      id: 1,
      securityId: 1,
      source: "user",
      source_author: "Me",
      price: 150,
    });
    expect(getSourcePerformance(db)).toEqual([]);
  });

  it("computes hit_rate and response counts per source", () => {
    seedSecurity(db, 1, "AAPL");
    insertLevel(db, {
      id: 1,
      securityId: 1,
      source: "newsletter",
      source_author: "Eliant",
      price: 150,
    });
    insertLevel(db, {
      id: 2,
      securityId: 1,
      source: "newsletter",
      source_author: "Eliant",
      price: 160,
    });
    insertAlert(db, {
      levelId: 1,
      securityId: 1,
      triggeredAt: "2026-01-15T12:00:00Z",
      triggeredPrice: 150,
      response: "acted",
    });
    insertAlert(db, {
      levelId: 2,
      securityId: 1,
      triggeredAt: "2026-02-15T12:00:00Z",
      triggeredPrice: 160,
      response: "ignored",
    });

    const rows = getSourcePerformance(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_author).toBe("Eliant");
    expect(rows[0].alerts_fired).toBe(2);
    expect(rows[0].levels_created).toBe(2);
    expect(rows[0].hit_rate).toBe(100);
    expect(rows[0].responses).toEqual({
      acted: 1,
      ignored: 1,
      dismissed: 0,
      pending: 0,
    });
  });

  it("returns null P&L when fewer than 3 acted samples", () => {
    seedSecurity(db, 1, "AAPL");
    insertLevel(db, {
      id: 1,
      securityId: 1,
      source: "newsletter",
      source_author: "Purple Drink",
      price: 150,
    });
    insertAlert(db, {
      levelId: 1,
      securityId: 1,
      triggeredAt: "2026-01-15T12:00:00Z",
      triggeredPrice: 150,
      response: "acted",
    });
    insertPrice(db, 1, "2026-02-14", 165);

    const rows = getSourcePerformance(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].pnl_acted_30d).toBeNull();
  });

  it("computes forward P&L when >=3 acted samples exist", () => {
    seedSecurity(db, 1, "AAPL");
    // 3 levels, 3 alerts, all acted
    for (let i = 1; i <= 3; i++) {
      insertLevel(db, {
        id: i,
        securityId: 1,
        source: "newsletter",
        source_author: "Purple Drink",
        price: 100 + i,
      });
      insertAlert(db, {
        levelId: i,
        securityId: 1,
        triggeredAt: `2026-01-1${i}T12:00:00Z`,
        triggeredPrice: 100 + i,
        response: "acted",
      });
    }
    // Forward prices 30d out: +5% each
    insertPrice(db, 1, "2026-02-10", 106.05);
    insertPrice(db, 1, "2026-02-11", 107.1);
    insertPrice(db, 1, "2026-02-12", 108.15);

    const rows = getSourcePerformance(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].pnl_acted_30d).not.toBeNull();
    expect(rows[0].pnl_acted_30d!).toBeCloseTo(5, 0);
  });
});

describe("getRecentReleaseReactions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function insertEnrichedEvent(opts: {
    event_type: string;
    event_date: string;
    symbol?: string | null;
    actual: string;
    consensus?: string | null;
    snapshot?: object | null;
    source_key: string;
  }) {
    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol,
          source_key, week_of, release_time,
          actual_value, consensus_value, reaction_snapshot, enriched_at)
       VALUES ('claude_macro', ?, ?, ?, ?, ?, ?, '08:30',
               ?, ?, ?, datetime('now'))`,
    ).run(
      opts.event_type,
      opts.event_date,
      `${opts.event_type} on ${opts.event_date}`,
      opts.symbol ?? null,
      opts.source_key,
      opts.event_date,
      opts.actual,
      opts.consensus ?? null,
      opts.snapshot ? JSON.stringify(opts.snapshot) : null,
    );
  }

  it("returns empty list when no enriched events", () => {
    expect(getRecentReleaseReactions(db)).toEqual([]);
  });

  it("filters by event_type", () => {
    insertEnrichedEvent({
      event_type: "cpi",
      event_date: "2026-04-11",
      actual: "3.2%",
      source_key: "fred:10:2026-04-11",
    });
    insertEnrichedEvent({
      event_type: "fomc",
      event_date: "2026-04-29",
      actual: "4.50%",
      source_key: "fomc:2026-04-29",
    });

    const cpi = getRecentReleaseReactions(db, { eventType: "cpi" });
    expect(cpi).toHaveLength(1);
    expect(cpi[0].event_type).toBe("cpi");
  });

  it("parses earnings_TICKER shortcut", () => {
    insertEnrichedEvent({
      event_type: "earnings",
      event_date: "2026-05-21",
      symbol: "NVDA",
      actual: "EPS 0.65",
      source_key: "finnhub:NVDA:2026-05-21",
    });
    insertEnrichedEvent({
      event_type: "earnings",
      event_date: "2026-04-23",
      symbol: "INTC",
      actual: "EPS 0.25",
      source_key: "finnhub:INTC:2026-04-23",
    });

    const rows = getRecentReleaseReactions(db, { eventType: "earnings_NVDA" });
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("NVDA");
  });

  it("respects since_date bound", () => {
    insertEnrichedEvent({
      event_type: "cpi",
      event_date: "2026-01-11",
      actual: "3.0%",
      source_key: "fred:10:2026-01-11",
    });
    insertEnrichedEvent({
      event_type: "cpi",
      event_date: "2026-04-11",
      actual: "3.2%",
      source_key: "fred:10:2026-04-11",
    });

    const rows = getRecentReleaseReactions(db, { sinceDate: "2026-03-01" });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_date).toBe("2026-04-11");
  });

  it("sorts most recent first", () => {
    insertEnrichedEvent({
      event_type: "cpi",
      event_date: "2026-01-11",
      actual: "3.0%",
      source_key: "fred:10:2026-01-11",
    });
    insertEnrichedEvent({
      event_type: "cpi",
      event_date: "2026-04-11",
      actual: "3.2%",
      source_key: "fred:10:2026-04-11",
    });

    const rows = getRecentReleaseReactions(db);
    expect(rows[0].event_date).toBe("2026-04-11");
    expect(rows[1].event_date).toBe("2026-01-11");
  });
});

describe("getSectorEtfGaps", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns [] when empty", () => {
    expect(getSectorEtfGaps(db)).toEqual([]);
  });

  it("sorts by count desc, then last_seen_at desc", () => {
    db.prepare(
      `INSERT INTO sector_etf_gaps (symbol, sector, count, last_seen_at)
       VALUES ('ACME', 'X', 3, '2026-04-24 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO sector_etf_gaps (symbol, sector, count, last_seen_at)
       VALUES ('BETA', 'Y', 5, '2026-04-20 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO sector_etf_gaps (symbol, sector, count, last_seen_at)
       VALUES ('GAMMA', null, 3, '2026-04-25 10:00:00')`,
    ).run();

    const rows = getSectorEtfGaps(db);
    expect(rows.map((r) => r.symbol)).toEqual(["BETA", "GAMMA", "ACME"]);
  });
});
