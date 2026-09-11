import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import { getFxRateHealth, getDataHealthSummary } from "@/lib/queries/data-health";

let db: Database.Database;

/** Today's date in YYYY-MM-DD (ET, matching the production code under test). */
const today = todayET();

/** N days ago in YYYY-MM-DD. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function seedAccount(name: string): number {
  return (
    db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name),
    (
      db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
        id: number;
      }
    ).id
  );
}

function seedSecurity(
  symbol: string,
  currency: string = "USD",
  type: string | null = "Stock",
): number {
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name, security_type, currency) VALUES (?, ?, ?, ?)",
  ).run(symbol, `${symbol} Inc`, type, currency);
  return (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as {
      id: number;
    }
  ).id;
}

function seedHolding(
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
) {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    securityId,
    quantity,
    asOfDate,
    `test:h:${accountId}:${securityId}:${asOfDate}`,
  );
}

function seedFxRate(
  currency: string,
  usdPerUnit: number,
  asOf: string,
  source: string,
) {
  db.prepare(
    `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, ?, ?, ?)`,
  ).run(currency, usdPerUnit, asOf, source);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getFxRateHealth", () => {
  it("flags placeholder_parity AND derived_near_parity for a JPY rate pinned at 1.0 from a derived source", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZTOKYO", "JPY");
    seedHolding(acct, sec, 100, today);
    seedFxRate("JPY", 1.0, today, "tws_derived");

    const rows = getFxRateHealth(db, today);
    expect(rows.length).toBe(1);
    expect(rows[0].currency).toBe("JPY");
    expect(rows[0].flags.sort()).toEqual(
      ["derived_near_parity", "placeholder_parity"].sort(),
    );
    expect(rows[0].heldSymbols).toEqual(["ZZTOKYO"]);
    expect(rows[0].reason).toMatch(/placeholder/i);
  });

  it("does not flag a plausible non-parity rate from ibkr_ledger (fresh)", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZSEOUL", "KRW");
    seedHolding(acct, sec, 50, today);
    seedFxRate("KRW", 0.00066, today, "ibkr_ledger");

    const rows = getFxRateHealth(db, today);
    expect(rows.length).toBe(1);
    expect(rows[0].flags).toEqual([]);
    expect(rows[0].reason).toBe("ok");
  });

  it("flags 'missing' when a held non-USD currency carries no fx_rates row at all", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZLONDON", "GBP");
    seedHolding(acct, sec, 20, today);

    const rows = getFxRateHealth(db, today);
    expect(rows.length).toBe(1);
    expect(rows[0].flags).toEqual(["missing"]);
    expect(rows[0].usdPerUnit).toBeNull();
    expect(rows[0].asOf).toBeNull();
    expect(rows[0].source).toBeNull();
  });

  it("flags 'stale' when the fx rate is more than 7 days old", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZFRANKFURT", "EUR");
    seedHolding(acct, sec, 30, today);
    seedFxRate("EUR", 1.08, daysAgo(10), "ibkr_ledger");

    const rows = getFxRateHealth(db, today);
    expect(rows.length).toBe(1);
    expect(rows[0].flags).toContain("stale");
    expect(rows[0].reason).toMatch(/days old/);
  });

  it("does not flag a fresh rate exactly at the 7-day boundary", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZOSLO", "NOK");
    seedHolding(acct, sec, 15, today);
    seedFxRate("NOK", 0.095, daysAgo(7), "ibkr_ledger");

    const rows = getFxRateHealth(db, today);
    expect(rows[0].flags).not.toContain("stale");
  });

  it("does not list a currency held only by a tombstoned (quantity=0) position", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZCLOSED", "CHF");
    seedHolding(acct, sec, 10, daysAgo(30));
    seedHolding(acct, sec, 0, daysAgo(5)); // closed — latest row is the tombstone

    const rows = getFxRateHealth(db, today);
    expect(rows.length).toBe(0);
  });

  it("never lists USD", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZUS", "USD");
    seedHolding(acct, sec, 10, today);

    const rows = getFxRateHealth(db, today);
    expect(rows.length).toBe(0);
  });

  it("merges lower-case currency codes with their upper-case equivalent", () => {
    const acct = seedAccount("IBKR");
    const sec1 = seedSecurity("ZZLOW", "jpy");
    const sec2 = seedSecurity("ZZHIGH", "JPY");
    seedHolding(acct, sec1, 10, today);
    seedHolding(acct, sec2, 5, today);
    seedFxRate("JPY", 0.0067, today, "ibkr_ledger");

    const rows = getFxRateHealth(db, today);
    expect(rows.length).toBe(1);
    expect(rows[0].currency).toBe("JPY");
    expect(rows[0].heldSymbols).toEqual(["ZZHIGH", "ZZLOW"]);
  });

  it("sorts flagged rows first, then alphabetically by currency", () => {
    const acct = seedAccount("IBKR");
    const clean = seedSecurity("ZZAAA", "AUD");
    const missing = seedSecurity("ZZZZZ", "ZWL");
    seedHolding(acct, clean, 10, today);
    seedHolding(acct, missing, 10, today);
    seedFxRate("AUD", 0.65, today, "ibkr_ledger");
    // ZWL has no fx_rates row at all -> 'missing'

    const rows = getFxRateHealth(db, today);
    expect(rows.map((r) => r.currency)).toEqual(["ZWL", "AUD"]);
  });
});

describe("getDataHealthSummary — totalFxFlags", () => {
  it("counts only flagged fx rows", () => {
    const acct = seedAccount("IBKR");
    const good = seedSecurity("ZZGOOD", "KRW");
    const bad = seedSecurity("ZZBAD", "JPY");
    seedHolding(acct, good, 10, today);
    seedHolding(acct, bad, 10, today);
    seedFxRate("KRW", 0.00066, today, "ibkr_ledger");
    seedFxRate("JPY", 1.0, today, "tws_derived");

    const summary = getDataHealthSummary(db);
    expect(summary.totalFxFlags).toBe(1);
  });

  it("is zero when there are no non-USD holdings", () => {
    const acct = seedAccount("IBKR");
    const sec = seedSecurity("ZZUS2", "USD");
    seedHolding(acct, sec, 10, today);

    const summary = getDataHealthSummary(db);
    expect(summary.totalFxFlags).toBe(0);
  });
});
