/**
 * B2 / QA-5: an expired option is not part of the live book.
 *
 * A statement-sourced holdings row for a call that expired yesterday stays in
 * the database (the statement is the audit trail and no purge deletes it), so
 * every live-book read must filter it by expiry. The holdings list already
 * did; the two allocation sections did not, and showed an "Option" bucket and
 * shrank every other percentage.
 *
 * Synthetic tickers, small round figures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3;
let db: Database.Database;

function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function section(summary: string, heading: string): string[] {
  const body = summary.split(heading)[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- "));
}

/** "$5,000" -> 5000 (the summary's own formatting, read back). */
function dollars(line: string): number {
  const m = line.match(/: (-?)\$([\d,]+(?:\.\d+)?)/);
  if (!m) throw new Error(`no dollar figure in ${line}`);
  return (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, ""));
}

beforeEach(() => {
  db = createPendingTestDb();
  const px = daysAgo(2);

  // Live stock: 50 shares at 100 = 5,000.
  const stock = seedSec(db, "ZZS");
  db.prepare("UPDATE securities SET sector = 'Technology' WHERE id = ?").run(stock);
  seedHold(db, IBKR, stock, px, "tws", 50);
  seedPx(db, stock, px, 100);

  // Expired call: 5 contracts at 3.00 x 100 = 1,500 if it were (wrongly) counted.
  const expired = Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price,
                                 expiration_date, multiplier, sector)
         VALUES ('ZZS 261016C00100000', 'ZZS 100 CALL', 'option', 'ZZS', 'CALL', 100, ?, 100, 'Energy')`
      )
      .run(daysAgo(1)).lastInsertRowid
  );
  seedHold(db, IBKR, expired, daysAgo(3), "stmt", 5);
  seedPx(db, expired, daysAgo(3), 3);
});

describe("B2: allocation reads the live book only", () => {
  it("an expired option row is left out of both allocation sections", () => {
    const s = getPortfolioSummaryForChat(db);
    const assets = section(s, "### Asset Allocation");
    expect(assets).toEqual(["- Stock: $5,000 (100.0% share, 1 positions)"]);
    expect(assets.some((l) => /option/i.test(l))).toBe(false);

    const sectors = section(s, "### Sector Allocation");
    expect(sectors).toEqual(["- Technology: $5,000 (100.0% share)"]);
  });

  it("asset allocation sums to the long holdings' market values within $1", () => {
    const s = getPortfolioSummaryForChat(db);
    const allocTotal = section(s, "### Asset Allocation").reduce((sum, l) => sum + dollars(l), 0);
    const holdingsTotal = section(s, "### Current Holdings")
      .map((l) => l.match(/; value \$([\d,]+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .reduce((sum, m) => sum + Number(m[1].replace(/,/g, "")), 0);
    expect(holdingsTotal).toBe(5000);
    expect(Math.abs(allocTotal - holdingsTotal)).toBeLessThanOrEqual(1);
  });
});
