/**
 * Cross-source duplicate dedup in findEmailCandidates.
 *
 * One print can carry TWO calendar_events rows — the Finnhub scan and the
 * Nasdaq scan each write their own (distinct source_key → distinct id).
 * reconcileEarningsDates marks the non-canonical row superseded=1, but it
 * only runs inside syncCalendarForWeek — in the window between row creation
 * and the next sync, both rows are live and the sweep sent one email per row
 * (2026-06-30: NKE preview ×2; same family as the 2026-07-14 Worker-side
 * JPM/BAC double-previews).
 *
 * The sweep must never emit two candidates for the same (issuer family,
 * event_date, phase) — finnhub row preferred.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";

function seedAccount(db: Database.Database, name: string): number {
  return (db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(name) as { id: number }).id;
}

function seedHeldSecurity(db: Database.Database, symbol: string): number {
  const accountId = seedAccount(db, `acct-${symbol}`);
  const securityId = (db
    .prepare(
      `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
       VALUES (?, 'stock', 'equity', 1) RETURNING id`,
    )
    .get(symbol) as { id: number }).id;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, 100);
  return securityId;
}

function seedEarningsEvent(
  db: Database.Database,
  opts: {
    symbol: string;
    securityId: number | null;
    eventDate: string;
    releaseTime: string;
    source: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, security_id, source_key, week_of
       ) VALUES (?,'earnings',?,?,?,?,?,?,?,?)`,
    )
    .run(
      opts.source,
      opts.eventDate,
      opts.releaseTime,
      opts.releaseTime,
      `${opts.symbol} earnings`,
      opts.symbol,
      opts.securityId,
      `${opts.source}:${opts.symbol}:${opts.eventDate}`,
      opts.eventDate,
    );
  return result.lastInsertRowid as number;
}

describe("findEmailCandidates — cross-source duplicate dedup", () => {
  let db: Database.Database;
  // 2h before the 16:30 ET release on 2026-06-01 — inside the preview window.
  const EVENT_DATE = "2026-06-01";
  const RELEASE_TIME = "16:30";
  const NOW = new Date("2026-06-01T18:30:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("emits ONE preview candidate when finnhub + nasdaq rows exist for the same print, preferring finnhub", () => {
    const securityId = seedHeldSecurity(db, "NKE");
    const finnhubId = seedEarningsEvent(db, {
      symbol: "NKE", securityId, eventDate: EVENT_DATE, releaseTime: RELEASE_TIME, source: "finnhub",
    });
    seedEarningsEvent(db, {
      symbol: "NKE", securityId, eventDate: EVENT_DATE, releaseTime: RELEASE_TIME, source: "nasdaq",
    });

    const candidates = findEmailCandidates(db, { now: NOW });
    const previews = candidates.filter((c) => c.phase === "preview");
    expect(previews).toHaveLength(1);
    expect(previews[0].eventId).toBe(finnhubId);
  });

  it("dedups across dual-class issuer siblings (GOOGL finnhub vs GOOG nasdaq)", () => {
    const securityId = seedHeldSecurity(db, "GOOG");
    const finnhubId = seedEarningsEvent(db, {
      symbol: "GOOGL", securityId: null, eventDate: EVENT_DATE, releaseTime: RELEASE_TIME, source: "finnhub",
    });
    seedEarningsEvent(db, {
      symbol: "GOOG", securityId, eventDate: EVENT_DATE, releaseTime: RELEASE_TIME, source: "nasdaq",
    });

    const candidates = findEmailCandidates(db, { now: NOW });
    const previews = candidates.filter((c) => c.phase === "preview");
    expect(previews).toHaveLength(1);
    expect(previews[0].eventId).toBe(finnhubId);
  });

  it("emits ONE recap candidate when both duplicate rows are enriched with actuals", () => {
    const securityId = seedHeldSecurity(db, "AAPL");
    const finnhubId = seedEarningsEvent(db, {
      symbol: "AAPL", securityId, eventDate: "2026-05-30", releaseTime: "16:05", source: "finnhub",
    });
    const nasdaqId = seedEarningsEvent(db, {
      symbol: "AAPL", securityId, eventDate: "2026-05-30", releaseTime: "16:05", source: "nasdaq",
    });
    db.prepare(
      "UPDATE calendar_events SET actual_value = 'EPS 1.00', enriched_at = datetime('now', '-1 hour') WHERE id IN (?, ?)",
    ).run(finnhubId, nasdaqId);

    const candidates = findEmailCandidates(db, { now: new Date() });
    const recaps = candidates.filter((c) => c.phase === "recap");
    expect(recaps).toHaveLength(1);
    expect(recaps[0].eventId).toBe(finnhubId);
  });

  it("does NOT dedup the same symbol on different dates", () => {
    const securityId = seedHeldSecurity(db, "TSLA");
    seedEarningsEvent(db, {
      symbol: "TSLA", securityId, eventDate: EVENT_DATE, releaseTime: RELEASE_TIME, source: "finnhub",
    });
    // Different quarter (out of the preview window for NOW, so use a recap shape)
    const q2Id = seedEarningsEvent(db, {
      symbol: "TSLA", securityId, eventDate: "2026-05-30", releaseTime: "16:05", source: "finnhub",
    });
    db.prepare(
      "UPDATE calendar_events SET actual_value = 'EPS 1.00', enriched_at = datetime('now', '-30 minutes') WHERE id = ?",
    ).run(q2Id);

    // NOW sits in the 6/01 preview window AND inside q2's recap window.
    const candidates = findEmailCandidates(db, { now: NOW });
    expect(candidates.filter((c) => c.phase === "preview")).toHaveLength(1);
    expect(candidates.filter((c) => c.phase === "recap")).toHaveLength(1);
  });
});
