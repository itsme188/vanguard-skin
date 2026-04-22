import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getRecommendationHistory,
  getLatestRecommendation,
  getPriceTarget,
  getRatingChanges,
} from "@/lib/queries/analyst-estimates";
import {
  upsertRecommendation,
  upsertPriceTarget,
  upsertRatingChange,
} from "@/lib/mutations/analyst-estimates";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("analyst_recommendations", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("upsert dedupes on (symbol, period) and bumps counts", () => {
    upsertRecommendation(db, {
      symbol: "AAPL",
      period: "2026-04-01",
      strong_buy: 10,
      buy: 20,
      hold: 5,
      sell: 1,
      strong_sell: 0,
    });
    upsertRecommendation(db, {
      symbol: "aapl", // case normalized
      period: "2026-04-01",
      strong_buy: 12,
      buy: 18,
      hold: 5,
      sell: 1,
      strong_sell: 0,
    });
    const rows = getRecommendationHistory(db, "AAPL");
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("AAPL");
    expect(rows[0].strong_buy).toBe(12);
  });

  it("history orders by period DESC", () => {
    upsertRecommendation(db, {
      symbol: "AAPL",
      period: "2026-01-01",
      strong_buy: 1, buy: 1, hold: 1, sell: 0, strong_sell: 0,
    });
    upsertRecommendation(db, {
      symbol: "AAPL",
      period: "2026-03-01",
      strong_buy: 3, buy: 3, hold: 3, sell: 0, strong_sell: 0,
    });
    upsertRecommendation(db, {
      symbol: "AAPL",
      period: "2026-02-01",
      strong_buy: 2, buy: 2, hold: 2, sell: 0, strong_sell: 0,
    });
    const rows = getRecommendationHistory(db, "AAPL");
    expect(rows.map((r) => r.period)).toEqual([
      "2026-03-01",
      "2026-02-01",
      "2026-01-01",
    ]);
  });

  it("getLatestRecommendation returns the newest period", () => {
    upsertRecommendation(db, {
      symbol: "NVDA",
      period: "2026-01-01",
      strong_buy: 5, buy: 5, hold: 5, sell: 0, strong_sell: 0,
    });
    upsertRecommendation(db, {
      symbol: "NVDA",
      period: "2026-04-01",
      strong_buy: 9, buy: 9, hold: 9, sell: 0, strong_sell: 0,
    });
    expect(getLatestRecommendation(db, "NVDA")?.period).toBe("2026-04-01");
    expect(getLatestRecommendation(db, "unused")).toBeNull();
  });
});

describe("analyst_price_targets", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("upsert overwrites per symbol", () => {
    upsertPriceTarget(db, {
      symbol: "NVDA",
      target_high: 200,
      target_low: 100,
      target_mean: 150,
      target_median: 145,
      number_of_analysts: 30,
      last_updated: "2026-04-01 10:00:00",
    });
    upsertPriceTarget(db, {
      symbol: "nvda",
      target_high: 220,
      target_low: 110,
      target_mean: 165,
      target_median: 160,
      number_of_analysts: 32,
      last_updated: "2026-04-15 10:00:00",
    });
    const pt = getPriceTarget(db, "NVDA");
    expect(pt?.target_mean).toBe(165);
    expect(pt?.number_of_analysts).toBe(32);
  });

  it("returns null when missing", () => {
    expect(getPriceTarget(db, "UNKNOWN")).toBeNull();
  });
});

describe("analyst_rating_changes", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("upsert dedupes on (symbol, date, firm, to_grade)", () => {
    upsertRatingChange(db, {
      symbol: "TSLA",
      rating_date: "2026-04-10",
      firm: "Morgan Stanley",
      from_grade: "Equal-Weight",
      to_grade: "Overweight",
      action: "up",
    });
    upsertRatingChange(db, {
      symbol: "TSLA",
      rating_date: "2026-04-10",
      firm: "Morgan Stanley",
      from_grade: "Equal-Weight",
      to_grade: "Overweight",
      action: "up",
    });
    expect(getRatingChanges(db, "TSLA")).toHaveLength(1);
  });

  it("treats different to_grades on same day/firm as distinct events", () => {
    upsertRatingChange(db, {
      symbol: "TSLA",
      rating_date: "2026-04-10",
      firm: "Morgan Stanley",
      from_grade: null,
      to_grade: "Overweight",
      action: "init",
    });
    upsertRatingChange(db, {
      symbol: "TSLA",
      rating_date: "2026-04-10",
      firm: "Morgan Stanley",
      from_grade: "Overweight",
      to_grade: "Equal-Weight",
      action: "down",
    });
    expect(getRatingChanges(db, "TSLA")).toHaveLength(2);
  });

  it("orders by rating_date DESC", () => {
    upsertRatingChange(db, {
      symbol: "TSLA",
      rating_date: "2026-02-01",
      firm: "A",
      from_grade: null,
      to_grade: "Buy",
      action: "init",
    });
    upsertRatingChange(db, {
      symbol: "TSLA",
      rating_date: "2026-04-01",
      firm: "B",
      from_grade: null,
      to_grade: "Buy",
      action: "init",
    });
    upsertRatingChange(db, {
      symbol: "TSLA",
      rating_date: "2026-03-01",
      firm: "C",
      from_grade: null,
      to_grade: "Buy",
      action: "init",
    });
    const rows = getRatingChanges(db, "TSLA");
    expect(rows.map((r) => r.firm)).toEqual(["B", "C", "A"]);
  });

  it("respects limit", () => {
    for (let i = 1; i <= 5; i++) {
      upsertRatingChange(db, {
        symbol: "TSLA",
        rating_date: `2026-04-0${i}`,
        firm: `Firm${i}`,
        from_grade: null,
        to_grade: "Buy",
        action: "init",
      });
    }
    expect(getRatingChanges(db, "TSLA", 3)).toHaveLength(3);
  });
});
