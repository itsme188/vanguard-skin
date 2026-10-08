/**
 * lib/queries/security-detail.ts — reversed stored round trips.
 *
 * QA finding security-detail-trade-grades--negative-holding-period-regression-1:
 * a stored trade_roundtrips row whose entry date is AFTER its exit date is a
 * pairing artefact. The hub printed it as a card with its two dates backwards.
 * Such rows are now left out of the cards and counted, so the section can say
 * how many were excluded. The decision is on the DATES — a legacy stored short
 * carries a negative holding_days with its dates in order and must stay.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getTradeGradesBySecurity,
  getTradeGradesWithExclusions,
} from "@/lib/queries/security-detail";
import { anchorIndex } from "../helpers/source-anchor";

const ACCOUNT_ID = 1;

interface Seed {
  entryDate: string;
  exitDate: string;
  holdingDays: number;
  grade: string;
  assessment: string;
}

describe("getTradeGradesWithExclusions — reversed pairs are dropped and counted", () => {
  let db: Database.Database;
  let securityId: number;
  let reviewId: number;

  function seed(s: Seed): void {
    db.prepare(
      `INSERT INTO trade_roundtrips
         (review_id, account_id, security_id, symbol,
          entry_date, entry_price, entry_quantity, entry_cost,
          exit_date, exit_price, exit_quantity, exit_proceeds,
          holding_days, realized_pnl, return_pct,
          grade, assessment)
       VALUES (?, ?, ?, 'AAA', ?, 1, 1, 1000, ?, 1, 1, 1100, ?, 100, 10, ?, ?)`
    ).run(reviewId, ACCOUNT_ID, securityId, s.entryDate, s.exitDate, s.holdingDays, s.grade, s.assessment);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.exec(`INSERT OR IGNORE INTO accounts (id, name) VALUES (${ACCOUNT_ID}, 'IBKR')`);
    securityId = db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Corp', 'Stock')")
      .run().lastInsertRowid as number;
    reviewId = db
      .prepare(
        `INSERT INTO trade_reviews
           (account_id, period_start, period_end, total_trades, winning_trades,
            losing_trades, win_rate, total_realized_pnl, review_markdown)
         VALUES (?, '2026-03-01', '2026-03-31', 0, 0, 0, 0, 0, '')`
      )
      .run(ACCOUNT_ID).lastInsertRowid as number;
  });

  const LONG: Seed = { entryDate: "2026-03-02", exitDate: "2026-03-10", holdingDays: 8, grade: "A", assessment: "long" };
  // A legacy stored short: dates in order, day count negative.
  const SHORT: Seed = { entryDate: "2026-03-12", exitDate: "2026-03-16", holdingDays: -4, grade: "B", assessment: "short" };
  const REVERSED: Seed = { entryDate: "2026-03-27", exitDate: "2026-03-24", holdingDays: -3, grade: "C", assessment: "reversed" };

  it("keeps the long and the real short, drops the reversed pair and counts it", () => {
    seed(LONG);
    seed(SHORT);
    seed(REVERSED);

    const { cards, excludedReversed } = getTradeGradesWithExclusions(db, securityId);

    expect(cards.map((c) => c.assessment)).toEqual(["short", "long"]);
    expect(cards.find((c) => c.assessment === "short")?.holding_days).toBe(-4);
    expect(excludedReversed).toBe(1);
    for (const card of cards) expect(card.entry_date <= card.exit_date).toBe(true);
    // The array-returning reader agrees with the cards.
    expect(getTradeGradesBySecurity(db, securityId)).toEqual(cards);
  });

  it("reports the count when every stored trip is reversed", () => {
    seed(REVERSED);
    seed({ ...REVERSED, entryDate: "2026-03-20", exitDate: "2026-03-19", assessment: "reversed 2" });

    expect(getTradeGradesWithExclusions(db, securityId)).toEqual({ cards: [], excludedReversed: 2 });
  });

  it("a same-day trip is not reversed, even with a timestamp on the entry", () => {
    seed({ entryDate: "2026-03-05T14:30:00", exitDate: "2026-03-05", holdingDays: 0, grade: "A", assessment: "same day" });

    const { cards, excludedReversed } = getTradeGradesWithExclusions(db, securityId);
    expect(cards).toHaveLength(1);
    expect(excludedReversed).toBe(0);
  });

  it("a reversed leg does not pull a group's entry date past its exit", () => {
    // Two legs share one verdict and one exit date; one of them is reversed.
    seed({ entryDate: "2026-03-02", exitDate: "2026-03-10", holdingDays: 8, grade: "A", assessment: "group" });
    seed({ entryDate: "2026-03-11", exitDate: "2026-03-10", holdingDays: -1, grade: "A", assessment: "group" });

    const { cards, excludedReversed } = getTradeGradesWithExclusions(db, securityId);
    expect(cards).toHaveLength(1);
    expect(cards[0].coversRoundtrips).toBe(1);
    expect(cards[0].realized_pnl).toBe(100);
    expect(excludedReversed).toBe(1);
  });

  it("never rewrites the stored rows", () => {
    seed(REVERSED);
    getTradeGradesWithExclusions(db, securityId);
    const row = db
      .prepare("SELECT entry_date, exit_date, holding_days, assessment FROM trade_roundtrips")
      .get();
    expect(row).toEqual({ entry_date: "2026-03-27", exit_date: "2026-03-24", holding_days: -3, assessment: "reversed" });
  });
});

describe("security hub — AI Trade Grades section (source pin)", () => {
  const source = readFileSync(
    join(process.cwd(), "app/dashboard/security/[id]/page.tsx"),
    "utf8"
  );

  it("shows the section when only excluded trips exist and prints the count through <Count>", () => {
    const start = anchorIndex(source, "(tradeGrades.length > 0 || tradeGradesExcluded > 0) && (");
    const section = source.slice(start, start + 1400);
    anchorIndex(section, "title={`AI Trade Grades · ${tradeGrades.length}`}");
    anchorIndex(section, "<Count value={tradeGradesExcluded} />");
    anchorIndex(section, "excluded — pairing under review");
  });
});
