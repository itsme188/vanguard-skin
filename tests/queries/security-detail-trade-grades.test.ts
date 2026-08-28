/**
 * lib/queries/security-detail.ts — getTradeGradesBySecurity grouping.
 *
 * QA finding security-detail-trade-grades--identical-assessment-across-trades:
 * the trade-review generator writes ONE AI grade per (symbol, exit_date) and
 * the storage step copies the grade letter plus all three prose fields onto
 * EVERY trade_roundtrips row sharing that key. Rendering each copy as its own
 * card graded a +$62 / +1.0% QCOM winner an "F" captioned "Worst trade of the
 * month … trim at -22.3%". The query now folds the copies into one card.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTradeGradesBySecurity } from "@/lib/queries/security-detail";

const ACCOUNT_ID = 1;

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedReview(db: Database.Database, periodStart: string, periodEnd: string): number {
  return db
    .prepare(
      `INSERT INTO trade_reviews
         (account_id, period_start, period_end, total_trades, winning_trades,
          losing_trades, win_rate, total_realized_pnl, review_markdown)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, '')`
    )
    .run(ACCOUNT_ID, periodStart, periodEnd).lastInsertRowid as number;
}

interface RoundtripSeed {
  reviewId: number;
  securityId: number;
  symbol?: string;
  entryDate: string;
  exitDate: string;
  entryCost: number;
  realizedPnl: number;
  holdingDays: number;
  grade?: string | null;
  assessment?: string | null;
  wentWell?: string | null;
  wentWrong?: string | null;
}

function seedRoundtrip(db: Database.Database, s: RoundtripSeed): void {
  // return_pct as the generator computes it (lib/compute/trade-roundtrips.ts):
  // realized_pnl / entry_cost * 100.
  const returnPct = s.entryCost !== 0 ? (s.realizedPnl / s.entryCost) * 100 : 0;
  db.prepare(
    `INSERT INTO trade_roundtrips
       (review_id, account_id, security_id, symbol,
        entry_date, entry_price, entry_quantity, entry_cost,
        exit_date, exit_price, exit_quantity, exit_proceeds,
        holding_days, realized_pnl, return_pct,
        grade, assessment, what_went_well, what_went_wrong)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    s.reviewId,
    ACCOUNT_ID,
    s.securityId,
    s.symbol ?? "QCOM",
    s.entryDate,
    s.entryCost,
    s.exitDate,
    s.entryCost + s.realizedPnl,
    s.holdingDays,
    s.realizedPnl,
    returnPct,
    s.grade ?? null,
    s.assessment ?? null,
    s.wentWell ?? null,
    s.wentWrong ?? null
  );
}

describe("getTradeGradesBySecurity — one card per AI assessment", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // Migrations may already seed account 1.
    db.exec(`INSERT OR IGNORE INTO accounts (id, name) VALUES (${ACCOUNT_ID}, 'IBKR')`);
  });

  it("folds roundtrips sharing (review, exit_date, verdict) into one card", () => {
    const securityId = seedSecurity(db, "QCOM");
    const reviewId = seedReview(db, "2026-05-01", "2026-05-31");
    const verdict = {
      grade: "F",
      assessment: "Worst trade of the month — should have trimmed at -22.3%.",
      wentWell: "Position sizing kept the loss survivable.",
      wentWrong: "Averaged down into a broken tape.",
    };
    // The winner that was mislabeled "F" in the QA finding.
    seedRoundtrip(db, {
      reviewId, securityId, entryDate: "2026-05-01", exitDate: "2026-05-31",
      entryCost: 6200, realizedPnl: 62, holdingDays: 30, ...verdict,
    });
    seedRoundtrip(db, {
      reviewId, securityId, entryDate: "2026-04-15", exitDate: "2026-05-31",
      entryCost: 2000, realizedPnl: -500, holdingDays: 46, ...verdict,
    });
    seedRoundtrip(db, {
      reviewId, securityId, entryDate: "2026-04-01", exitDate: "2026-05-31",
      entryCost: 1500, realizedPnl: -300, holdingDays: 60, ...verdict,
    });

    const grades = getTradeGradesBySecurity(db, securityId);

    expect(grades).toHaveLength(1);
    const card = grades[0];
    expect(card.coversRoundtrips).toBe(3);
    expect(card.realized_pnl).toBeCloseTo(-738, 6);
    // Cost-weighted blend: -738 / 9700 = -7.608%.
    expect(card.return_pct).toBeCloseTo((-738 / 9700) * 100, 6);
    expect(card.entry_date).toBe("2026-04-01");
    expect(card.holding_days).toBe(60);
    expect(card.exit_date).toBe("2026-05-31");
    expect(card.grade).toBe("F");
    expect(card.assessment).toBe(verdict.assessment);
    expect(card.what_went_well).toBe(verdict.wentWell);
    expect(card.what_went_wrong).toBe(verdict.wentWrong);
    expect(card.review_period).toBe("2026-05-01");
  });

  it("keeps distinct assessments on the same exit date as separate cards", () => {
    const securityId = seedSecurity(db, "QCOM");
    const reviewId = seedReview(db, "2026-05-01", "2026-05-31");
    seedRoundtrip(db, {
      reviewId, securityId, entryDate: "2026-05-01", exitDate: "2026-05-31",
      entryCost: 6200, realizedPnl: 62, holdingDays: 30,
      grade: "B", assessment: "Small scalp, thesis intact.",
    });
    seedRoundtrip(db, {
      reviewId, securityId, entryDate: "2026-04-01", exitDate: "2026-05-31",
      entryCost: 1500, realizedPnl: -300, holdingDays: 60,
      grade: "F", assessment: "Held a loser too long.",
    });

    const grades = getTradeGradesBySecurity(db, securityId);

    expect(grades).toHaveLength(2);
    expect(grades.every((g) => g.coversRoundtrips === 1)).toBe(true);
    expect(grades.map((g) => g.assessment).sort()).toEqual([
      "Held a loser too long.",
      "Small scalp, thesis intact.",
    ]);
    // Ungrouped cards keep the stored per-leg return unchanged.
    const winner = grades.find((g) => g.grade === "B")!;
    expect(winner.return_pct).toBeCloseTo(1.0, 6);
    expect(winner.realized_pnl).toBe(62);
  });

  it("applies the 10-card limit AFTER grouping, newest exit first", () => {
    const securityId = seedSecurity(db, "QCOM");
    const reviewId = seedReview(db, "2026-01-01", "2026-12-31");
    // 12 distinct groups (distinct exit dates), 2 copied legs each.
    for (let i = 1; i <= 12; i++) {
      const exitDate = `2026-06-${String(i).padStart(2, "0")}`;
      for (const leg of [0, 1]) {
        seedRoundtrip(db, {
          reviewId, securityId,
          entryDate: `2026-05-${String(i + leg).padStart(2, "0")}`,
          exitDate,
          entryCost: 1000, realizedPnl: 100, holdingDays: 30 - leg,
          grade: "A", assessment: `verdict ${i}`,
        });
      }
    }

    const grades = getTradeGradesBySecurity(db, securityId);

    expect(grades).toHaveLength(10);
    expect(grades.every((g) => g.coversRoundtrips === 2)).toBe(true);
    expect(grades[0].exit_date).toBe("2026-06-12");
    expect(grades[9].exit_date).toBe("2026-06-03");
    const exits = grades.map((g) => g.exit_date);
    expect([...exits].sort().reverse()).toEqual(exits);
  });

  it("returns a zero blended return when the group's entry cost nets to zero", () => {
    const securityId = seedSecurity(db, "QCOM");
    const reviewId = seedReview(db, "2026-05-01", "2026-05-31");
    for (const entryCost of [1000, -1000]) {
      seedRoundtrip(db, {
        reviewId, securityId, entryDate: "2026-05-01", exitDate: "2026-05-31",
        entryCost, realizedPnl: 50, holdingDays: 10,
        grade: "C", assessment: "flat basis",
      });
    }

    const grades = getTradeGradesBySecurity(db, securityId);

    expect(grades).toHaveLength(1);
    expect(grades[0].realized_pnl).toBe(100);
    expect(grades[0].return_pct).toBe(0);
  });
});
