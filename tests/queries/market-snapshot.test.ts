import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getMarketSnapshot, type QuoteFetcher } from "@/lib/queries/market-snapshot";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── Seed helpers (mirror tests/digest/anomalies.test.ts) ───────────────────────

function seedSecurity(symbol: string, name?: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name ?? `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedHolding(accountId: number, securityId: number, date: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, ?, ?)`
  ).run(accountId, securityId, date, `test:${accountId}:${securityId}:${date}`);
}

function seedPrice(securityId: number, date: string, closePrice: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')"
  ).run(securityId, date, closePrice);
}

/**
 * Seed a fresh, consecutive trading-day pair (Thu 6/4 → Fri 6/5 2026):
 * SPY benchmark (not held) + GS held in a Vanguard account.
 */
function seedFreshPair(): void {
  const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
  seedPrice(spyId, "2026-06-04", 600);
  seedPrice(spyId, "2026-06-05", 585); // -2.5%

  const acctId = seedAccount("Vanguard Taxable");
  const gsId = seedSecurity("GS", "Goldman Sachs");
  seedHolding(acctId, gsId, "2026-06-05");
  seedPrice(gsId, "2026-06-04", 1092);
  seedPrice(gsId, "2026-06-05", 1038); // -4.945%
}

describe("getMarketSnapshot", () => {
  it("uses local closes when the local book is fresh, without calling Yahoo", async () => {
    seedFreshPair();
    let yahooCalled = false;
    const fetchQuotes: QuoteFetcher = async () => {
      yahooCalled = true;
      return null;
    };

    const snap = await getMarketSnapshot(db, { today: "2026-06-05", fetchQuotes });

    expect(snap.source).toBe("local");
    expect(snap.asOf).toBe("2026-06-05");
    expect(snap.stale).toBe(false);
    expect(yahooCalled).toBe(false); // local-first: fresh local skips Yahoo

    const spy = snap.moves.find((m) => m.symbol === "SPY");
    const gs = snap.moves.find((m) => m.symbol === "GS");
    expect(spy?.kind).toBe("benchmark");
    expect(spy?.pct).toBeCloseTo(-2.5, 1);
    expect(gs?.kind).toBe("holding");
    expect(gs?.pct).toBeCloseTo(-4.95, 1);
  });

  it("falls back to Yahoo when the local book is stale", async () => {
    seedFreshPair(); // latest local = 2026-06-05
    const fetchQuotes: QuoteFetcher = async (symbols) => {
      expect(symbols).toContain("SPY");
      expect(symbols).toContain("GS");
      return {
        SPY: { price: 590, prior: 600 }, // -1.667%
        GS: { price: 1050, prior: 1092 }, // -3.846%
      };
    };

    // today is 7 calendar days after the latest local close → stale
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });

    expect(snap.source).toBe("yahoo");
    expect(snap.asOf).toBe("2026-06-12");
    expect(snap.stale).toBe(false);
    expect(snap.moves.find((m) => m.symbol === "SPY")?.pct).toBeCloseTo(-1.67, 1);
    expect(snap.moves.find((m) => m.symbol === "GS")?.pct).toBeCloseTo(-3.85, 1);
  });

  it("returns stale local data (flagged) when local is stale AND Yahoo fails", async () => {
    seedFreshPair();
    const fetchQuotes: QuoteFetcher = async () => null; // Yahoo down

    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });

    expect(snap.source).toBe("local");
    expect(snap.stale).toBe(true);
    expect(snap.staleDays).toBe(7);
    expect(snap.moves.find((m) => m.symbol === "SPY")).toBeDefined();
    expect(snap.note.toLowerCase()).toContain("stale");
  });

  it("returns source 'none' when there is no local pair and no Yahoo", async () => {
    // Only one SPY price → resolveTradingDayPair returns null
    const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
    seedPrice(spyId, "2026-06-05", 585);

    const snap = await getMarketSnapshot(db, { today: "2026-06-05" });

    expect(snap.source).toBe("none");
    expect(snap.moves).toEqual([]);
    expect(snap.note.toLowerCase()).toContain("unavailable");
  });
});
