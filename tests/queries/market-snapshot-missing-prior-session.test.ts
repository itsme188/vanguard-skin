/**
 * QA finding dashboard-today-chat-rail-all-accounts-market-snapshot-answer-
 * chat-says-the-local-book-hasn-t-synced-monday-s (2026-10-13).
 *
 * The local book HAD the latest session; what was missing was the session
 * before it (a Friday close stored under the Sunday sync date). The chat
 * snapshot then told the owner the book was "behind" and had not synced the
 * session, which the Today line on the same data correctly described as the
 * previous session's price being missing.
 *
 * Synthetic tickers and round figures only. Thu 2026-06-04, Fri 2026-06-05,
 * Mon 2026-06-08 are ordinary trading days.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getMarketSnapshot, type QuoteFetcher } from "@/lib/queries/market-snapshot";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPrice(securityId: number, date: string, close: number): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(
    securityId,
    date,
    close,
  );
}

function seedHolding(accountId: number, securityId: number, date: string, qty: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, qty, date, `tws-${accountId}:${securityId}:${date}`);
}

const quotes: QuoteFetcher = async () => ({
  SPY: { price: 610, prior: 600, asOf: "2026-06-08" },
  ZZA: { price: 105, prior: 100, asOf: "2026-06-08" },
});

describe("market snapshot when the latest session is in the book but the prior close is missing", () => {
  it("says the previous session is missing, not that the book is behind", async () => {
    const spy = seedSecurity("SPY");
    seedPrice(spy, "2026-06-04", 600);
    seedPrice(spy, "2026-06-08", 610); // no 2026-06-05 row: the pair cannot form
    const zza = seedSecurity("ZZA");
    seedPrice(zza, "2026-06-04", 100);
    seedPrice(zza, "2026-06-08", 105);
    seedHolding(1, zza, "2026-06-08", 100);

    const snap = await getMarketSnapshot(db, { today: "2026-06-08", fetchQuotes: quotes });

    expect(snap.source).toBe("yahoo");
    expect(snap.note).not.toMatch(/behind/i);
    expect(snap.note).toMatch(/2026-06-08/);
    expect(snap.note).toMatch(/session before it|previous session/i);

    const row = snap.moves.find((m) => m.symbol === "ZZA" && m.position);
    expect(row).toBeDefined();
    expect(row?.day_effect).toBeNull();
    expect(row?.day_effect_reason).toMatch(/previous session|session before/i);
    expect(row?.day_effect_reason).not.toMatch(/behind/i);
  });

  it("still says the book is behind when its latest session is genuinely old", async () => {
    const spy = seedSecurity("SPY");
    seedPrice(spy, "2026-06-04", 600);
    seedPrice(spy, "2026-06-05", 605);
    const zza = seedSecurity("ZZA");
    seedPrice(zza, "2026-06-04", 100);
    seedPrice(zza, "2026-06-05", 101);
    seedHolding(1, zza, "2026-06-05", 100);

    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes: quotes });

    expect(snap.source).toBe("yahoo");
    expect(snap.note).toMatch(/behind/i);
    const row = snap.moves.find((m) => m.symbol === "ZZA" && m.position);
    expect(row?.day_effect_reason).toMatch(/behind/i);
  });

  it("says the book is behind when it lacks both the quotes' session and the one before", async () => {
    const spy = seedSecurity("SPY");
    seedPrice(spy, "2026-06-04", 600);
    seedPrice(spy, "2026-06-08", 610); // Mon; 06-09 and 06-10 are missing
    const zza = seedSecurity("ZZA");
    seedPrice(zza, "2026-06-04", 100);
    seedPrice(zza, "2026-06-08", 105);
    seedHolding(1, zza, "2026-06-08", 100);

    const behindQuotes: QuoteFetcher = async () => ({
      SPY: { price: 620, prior: 610, asOf: "2026-06-10" },
      ZZA: { price: 108, prior: 105, asOf: "2026-06-10" },
    });
    const snap = await getMarketSnapshot(db, {
      today: "2026-06-10",
      now: new Date("2026-06-10T21:00:00Z"),
      fetchQuotes: behindQuotes,
    });

    expect(snap.source).toBe("yahoo");
    expect(snap.note).toMatch(/behind/i);
    expect(snap.note).not.toMatch(/previous session's close is missing/i);
    const row = snap.moves.find((m) => m.symbol === "ZZA" && m.position);
    expect(row?.day_effect_reason).toMatch(/behind/i);
    expect(row?.day_effect_reason).not.toMatch(/previous session's close is missing/i);
  });
});
