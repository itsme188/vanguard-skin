import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { isLongTermHolding } from "@/lib/compute/tax-lots";
import { isLongTermSql, longTermDateSql } from "@/lib/queries/long-term-sql";
import { addDays } from "@/lib/calendar/date-utils";

/**
 * The long-term / short-term split the chat states (open-lot tool and the
 * portfolio summary) must be the engine's answer on every date. This pins
 * the shared SQL to `isLongTermHolding` around the boundary, including the
 * dates where a fixed day count disagrees (spans that cross a leap day).
 */

// Ordinary date, Feb 28, Feb 29, Mar 1, Dec 31, and dates in the year
// before a leap year (their one-year span crosses Feb 29).
const ACQUIRED = [
  "2025-06-17",
  "2025-02-28",
  "2024-02-28",
  "2024-02-29",
  "2024-03-01",
  "2023-03-01",
  "2025-12-31",
  "2023-12-31",
  "2023-06-17",
  "2023-02-28",
  "2024-01-01",
];

function anniversary(acquired: string): string {
  return `${String(Number(acquired.slice(0, 4)) + 1).padStart(4, "0")}${acquired.slice(4)}`;
}

/** The three days around the boundary; Feb 29 has no real anniversary date. */
function todaysAround(acquired: string): string[] {
  const boundary = acquired.endsWith("-02-29")
    ? `${Number(acquired.slice(0, 4)) + 1}-02-28`
    : anniversary(acquired);
  return [-2, -1, 0, 1, 2, 3].map((n) => addDays(boundary, n));
}

describe("long-term SQL matches the engine's isLongTermHolding", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tax_lots (id INTEGER PRIMARY KEY, acquisition_date TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO tax_lots (acquisition_date) VALUES (?)");
  for (const d of ACQUIRED) insert.run(d);

  const stmt = db.prepare(
    `SELECT ${isLongTermSql("tl.acquisition_date")} AS is_long_term,
            ${longTermDateSql("tl.acquisition_date")} AS long_term_date
     FROM tax_lots tl WHERE tl.acquisition_date = ?`
  );

  for (const acquired of ACQUIRED) {
    for (const today of todaysAround(acquired)) {
      it(`acquired ${acquired}, today ${today}`, () => {
        const row = stmt.get(today, acquired) as { is_long_term: number; long_term_date: string };
        const engine = isLongTermHolding(acquired, today);
        expect(row.is_long_term === 1).toBe(engine);
        // The stated long-term date is the first long-term day: on or after
        // it the engine says long-term, before it short-term.
        expect(today >= row.long_term_date).toBe(engine);
      });
    }
  }

  it("covers both sides of every boundary (the table is not vacuous)", () => {
    for (const acquired of ACQUIRED) {
      const answers = todaysAround(acquired).map((t) => isLongTermHolding(acquired, t));
      expect(answers).toContain(true);
      expect(answers).toContain(false);
    }
  });

  it("a Feb-29 lot turns long-term on Mar 1; a leap-spanning ordinary lot the day after its anniversary", () => {
    const get = (acquired: string) =>
      (stmt.get("2000-01-01", acquired) as { long_term_date: string }).long_term_date;
    expect(get("2024-02-29")).toBe("2025-03-01");
    expect(get("2023-06-17")).toBe("2024-06-18"); // a fixed +366 days says 2024-06-17
    expect(get("2025-06-17")).toBe("2026-06-18");
  });
});
