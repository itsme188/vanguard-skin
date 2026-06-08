import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeMomentumPulse } from "@/lib/compute/momentum-spread";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'test',
      UNIQUE(symbol, date)
    );
  `);
  return db;
}

interface SeedSpec {
  symbol: string;
  startPrice: number;
  dailyReturn: number; // applied to start, generating a smooth series
  finalDate?: string; // YYYY-MM-DD; default = today
}

function seedSeries(db: Database.Database, spec: SeedSpec, days = 35): void {
  const stmt = db.prepare(
    "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)",
  );
  const final = spec.finalDate
    ? new Date(spec.finalDate + "T00:00:00")
    : (() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
      })();

  for (let i = days; i >= 0; i--) {
    const d = new Date(final);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const price = spec.startPrice * Math.pow(1 + spec.dailyReturn, days - i);
    stmt.run(spec.symbol, date, price);
  }
}

describe("computeMomentumPulse", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns null when benchmark history is too short", () => {
    seedSeries(db, { symbol: "SPY", startPrice: 500, dailyReturn: 0.0005 }, 10);
    seedSeries(db, { symbol: "MTUM", startPrice: 200, dailyReturn: 0.0008 }, 10);
    seedSeries(db, { symbol: "SPMO", startPrice: 100, dailyReturn: 0.0008 }, 10);
    seedSeries(db, { symbol: "USMV", startPrice: 90, dailyReturn: 0.0003 }, 10);

    expect(computeMomentumPulse(db)).toBeNull();
  });

  it("returns null when latest data is stale (>4 days old)", () => {
    const stale = new Date();
    stale.setDate(stale.getDate() - 10);
    const finalDate = stale.toISOString().slice(0, 10);
    seedSeries(db, { symbol: "SPY", startPrice: 500, dailyReturn: 0.0005, finalDate });
    seedSeries(db, { symbol: "MTUM", startPrice: 200, dailyReturn: 0.0008, finalDate });
    seedSeries(db, { symbol: "SPMO", startPrice: 100, dailyReturn: 0.0008, finalDate });
    seedSeries(db, { symbol: "USMV", startPrice: 90, dailyReturn: 0.0003, finalDate });

    expect(computeMomentumPulse(db)).toBeNull();
  });

  it("classifies a calm market as neutral", () => {
    seedSeries(db, { symbol: "SPY", startPrice: 500, dailyReturn: 0.0005 });
    seedSeries(db, { symbol: "MTUM", startPrice: 200, dailyReturn: 0.0005 });
    seedSeries(db, { symbol: "SPMO", startPrice: 100, dailyReturn: 0.0005 });
    seedSeries(db, { symbol: "USMV", startPrice: 90, dailyReturn: 0.0005 });

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("neutral");
  });

  it("classifies momentum leadership when MTUM beats SPY by >1% / 30d", () => {
    seedSeries(db, { symbol: "SPY", startPrice: 500, dailyReturn: 0.0003 });
    seedSeries(db, { symbol: "MTUM", startPrice: 200, dailyReturn: 0.0015 });
    seedSeries(db, { symbol: "SPMO", startPrice: 100, dailyReturn: 0.0012 });
    seedSeries(db, { symbol: "USMV", startPrice: 90, dailyReturn: 0.0002 });

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("leading");
    expect(result!.trigger).toBe("30d");
    expect(result!.reason).toContain("over 30d");
    expect(result!.spreads.mtum_vs_spy.return30d).toBeGreaterThan(0.01);
  });

  it("classifies a momentum sell-off when MTUM lags SPY by >3% / 30d", () => {
    seedSeries(db, { symbol: "SPY", startPrice: 500, dailyReturn: 0.0008 });
    seedSeries(db, { symbol: "MTUM", startPrice: 200, dailyReturn: -0.0015 });
    seedSeries(db, { symbol: "SPMO", startPrice: 100, dailyReturn: -0.0012 });
    seedSeries(db, { symbol: "USMV", startPrice: 90, dailyReturn: 0.0006 });

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("sell_off");
    expect(result!.spreads.mtum_vs_spy.return30d).toBeLessThan(-0.03);
  });

  it("classifies weakening when 5d MTUM lags but 30d still positive", () => {
    // MTUM rallies +0.3%/day for 30 days, then sells off -0.4%/day for last 5.
    // Net: 30d return ≈ +5.7%, 5d return ≈ -2.0%. Pulls below -1.5% sell-off
    // line on the 5-day axis but the monthly axis is still strongly positive.
    const stmt = db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)",
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 35; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);

      stmt.run("SPY", date, 500 * Math.pow(1.0003, 35 - i));
      stmt.run("SPMO", date, 100 * Math.pow(1.0005, 35 - i));
      stmt.run("USMV", date, 90 * Math.pow(1.0001, 35 - i));

      const mtumPrice =
        i > 5
          ? 200 * Math.pow(1.003, 35 - i)
          : 200 * Math.pow(1.003, 30) * Math.pow(0.996, 5 - i);
      stmt.run("MTUM", date, mtumPrice);
    }

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    expect(result!.spreads.mtum_vs_spy.return5d).toBeLessThan(-0.015);
    expect(result!.spreads.mtum_vs_spy.return30d).toBeGreaterThan(0);
    expect(result!.status).toBe("weakening");
    expect(result!.trigger).toBe("5d");
    expect(result!.reason).toContain("this week");
  });

  it("leads with a 1-day momentum shock (sell-off) even when 30d is still positive", () => {
    // Strong 30d uptrend in MTUM/SPMO, then a sharp single-day crack on the
    // final day: MTUM ≈ −4.7% vs SPY ≈ −2% → 1d spread ≈ −2.7% (≤ −2% shock
    // gate). The 30-day spread is still strongly positive — the headline must
    // still flip to sell_off because the most recent window broke.
    const stmt = db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)",
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 35; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const grown = 35 - i;
      const shock = i === 0 ? 1 : 0; // final day only

      stmt.run("SPY", date, 500 * Math.pow(1.0003, grown) * (shock ? 0.98 : 1));
      stmt.run("MTUM", date, 200 * Math.pow(1.003, grown) * (shock ? 0.95 : 1));
      stmt.run("SPMO", date, 100 * Math.pow(1.003, grown) * (shock ? 0.952 : 1));
      stmt.run("USMV", date, 90 * Math.pow(1.0001, grown) * (shock ? 1.0 : 1));
    }

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    expect(result!.spreads.mtum_vs_spy.return1d).toBeLessThan(-0.02);
    expect(result!.spreads.mtum_vs_spy.return30d).toBeGreaterThan(0);
    expect(result!.status).toBe("sell_off");
    expect(result!.trigger).toBe("1d");
    // Subtitle leads with the 1-day move and carries the disagreeing 30d trend.
    expect(result!.reason).toContain("today");
    expect(result!.reason).toContain("30d trend still");
  });

  it("leads with a 1-day momentum surge (leading) when no longer window qualifies", () => {
    // Mildly negative 30d trend in MTUM, then a sharp +1-day surge. 30d and 5d
    // stay below their leading thresholds, so the OLD 30d-first classifier
    // returns neutral; the new ladder must read the 1d gate and call it leading.
    const stmt = db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)",
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 35; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const grown = 35 - i;
      const shock = i === 0 ? 1 : 0;

      stmt.run("SPY", date, 500 * Math.pow(1.0005, grown));
      stmt.run("MTUM", date, 200 * Math.pow(0.999, grown) * (shock ? 1.03 : 1));
      stmt.run("SPMO", date, 100 * Math.pow(0.999, grown) * (shock ? 1.028 : 1));
      stmt.run("USMV", date, 90 * Math.pow(1.0003, grown));
    }

    const result = computeMomentumPulse(db);
    expect(result).not.toBeNull();
    expect(result!.spreads.mtum_vs_spy.return1d).toBeGreaterThan(0.02);
    expect(result!.spreads.mtum_vs_spy.return30d).toBeLessThan(0.01);
    expect(result!.status).toBe("leading");
    expect(result!.trigger).toBe("1d");
    expect(result!.reason).toContain("today");
  });

  it("returns null when one of the four series is missing", () => {
    seedSeries(db, { symbol: "SPY", startPrice: 500, dailyReturn: 0.0005 });
    seedSeries(db, { symbol: "MTUM", startPrice: 200, dailyReturn: 0.0008 });
    // SPMO missing
    seedSeries(db, { symbol: "USMV", startPrice: 90, dailyReturn: 0.0003 });

    expect(computeMomentumPulse(db)).toBeNull();
  });
});
