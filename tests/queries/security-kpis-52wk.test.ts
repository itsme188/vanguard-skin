import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurityQuote } from "@/lib/mutations/security-quotes";
import { getKpisForSecurity } from "@/lib/queries/security-detail";

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

/** Seed n consecutive daily bars ending at endDate, flat OHLC around `level`. */
function seedBars(
  db: Database.Database,
  securityId: number,
  endDate: string,
  n: number,
  level: number,
  opts: { lowOverrideFirstBar?: number } = {}
): void {
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`
  );
  const end = new Date(`${endDate}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const low = i === n - 1 && opts.lowOverrideFirstBar != null ? opts.lowOverrideFirstBar : level - 1;
    stmt.run(securityId, iso, level, level + 1, low, level);
  }
}

describe("getKpisForSecurity 52-week range source arbitration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("uses the IBKR quote range when the quote is fresher than the latest bar (HOOD repro)", () => {
    const id = seedSecurity(db, "HOOD");
    // Bars go stale 2026-04-23; their window back-shifts and includes an
    // old $44.27 low that has rolled out of the true 52-week window.
    seedBars(db, id, "2026-04-23", 20, 100, { lowOverrideFirstBar: 44.27 });
    upsertSecurityQuote(db, {
      securityId: id,
      asOfDate: "2026-07-21",
      ivUnderlying: null,
      hv30d: null,
      week52High: 153.86,
      week52Low: 63.51,
      dividendYield: null,
    });

    const kpis = getKpisForSecurity(db, id);
    expect(kpis?.week52Low).toBe(63.51);
    expect(kpis?.week52High).toBe(153.86);
    expect(kpis?.week52AsOf).toBe("2026-07-21");
  });

  it("keeps the bars-derived range when bars are fresher than the quote", () => {
    const id = seedSecurity(db, "FRSH");
    seedBars(db, id, "2026-07-25", 20, 100, { lowOverrideFirstBar: 80 });
    upsertSecurityQuote(db, {
      securityId: id,
      asOfDate: "2026-07-01",
      ivUnderlying: null,
      hv30d: null,
      week52High: 999,
      week52Low: 1,
      dividendYield: null,
    });

    const kpis = getKpisForSecurity(db, id);
    expect(kpis?.week52Low).toBe(80);
    expect(kpis?.week52High).toBe(101);
    expect(kpis?.week52AsOf).toBe("2026-07-25");
  });

  it("falls back to bars when no quote row exists, stamping the bars as-of", () => {
    const id = seedSecurity(db, "NOQT");
    seedBars(db, id, "2026-07-25", 20, 50);

    const kpis = getKpisForSecurity(db, id);
    expect(kpis?.week52Low).toBe(49);
    expect(kpis?.week52AsOf).toBe("2026-07-25");
  });

  it("ignores a fresher quote whose 52wk fields are null (price-only tier)", () => {
    const id = seedSecurity(db, "NULQ");
    seedBars(db, id, "2026-07-01", 20, 50);
    upsertSecurityQuote(db, {
      securityId: id,
      asOfDate: "2026-07-25",
      ivUnderlying: 0.3,
      hv30d: null,
      week52High: null,
      week52Low: null,
      dividendYield: null,
    });

    const kpis = getKpisForSecurity(db, id);
    expect(kpis?.week52Low).toBe(49);
    expect(kpis?.week52AsOf).toBe("2026-07-01");
  });
});
