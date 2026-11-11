/**
 * The summary's two allocation sections group label variants as one
 * category, by the same rules as `query_allocation` (getAllocationBreakdown,
 * lib/queries/chat-tools.ts): security types fold on case, sectors go through
 * normalizeSector (fund-category fallback through normalizeFundCategory).
 * Before, "Option" / "option" / "OPTION" were three lines in the Portfolio
 * Context the model reads on every request.
 *
 * Account 3 (IBKR) from the migration seed. Synthetic tickers, small figures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { getAllocationBreakdown } from "@/lib/queries/chat-tools";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3;
let db: Database.Database;

function daysFrom(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function section(summary: string, heading: string): string[] {
  const body = summary.split(heading)[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- "));
}

/** "- Option: $600 (66.7% share, 3 positions)" -> ["Option", 600] */
function parse(line: string): [string, number] {
  const m = line.match(/^- (.+?): \$([\d,]+)/);
  if (!m) throw new Error(`unparsed: ${line}`);
  return [m[1], Number(m[2].replace(/,/g, ""))];
}

function seedSecurity(symbol: string, type: string, sector: string, opts: { option?: boolean } = {}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, sector, multiplier, expiration_date, currency)
         VALUES (?, ?, ?, ?, ?, ?, 'USD')`
      )
      .run(symbol, `${symbol} name`, type, sector, opts.option ? 100 : 1, opts.option ? daysFrom(60) : null)
      .lastInsertRowid
  );
}

beforeEach(() => {
  db = createPendingTestDb();
  const px = daysFrom(-1);
  // Three option spellings, 1 contract at 2.00 x 100 = 200 each -> Option $600.
  const optionTypes = ["Option", "option", "OPTION"];
  const energySpellings = ["Energy", "energy", "ENERGY"];
  optionTypes.forEach((type, i) => {
    const id = seedSecurity(`ZZO${i} 270115C00010000`, type, energySpellings[i], { option: true });
    seedHold(db, IBKR, id, px, "tws", 1);
    seedPx(db, id, px, 2);
  });
  // Two stock spellings: 10 at 10 = 100 and 10 at 20 = 200 -> Stock $300.
  // Two sector variants of one GICS sector -> Technology $300.
  const s1 = seedSecurity("ZZS1", "Stock", "Information Technology");
  seedHold(db, IBKR, s1, px, "tws", 10);
  seedPx(db, s1, px, 10);
  const s2 = seedSecurity("ZZS2", "stock", "technology");
  seedHold(db, IBKR, s2, px, "tws", 10);
  seedPx(db, s2, px, 20);
});

describe("allocation sections group label variants once", () => {
  it("gives one line per real category in both allocation sections", () => {
    const s = getPortfolioSummaryForChat(db);
    expect(section(s, "### Asset Allocation")).toEqual([
      "- Option: $600 (66.7% share, 3 positions)",
      "- Stock: $300 (33.3% share, 2 positions)",
    ]);
    expect(section(s, "### Sector Allocation")).toEqual(["- Energy: $600 (66.7% share)", "- Technology: $300 (33.3% share)"]);
  });

  it("section totals still equal the long holdings value", () => {
    const s = getPortfolioSummaryForChat(db);
    const holdings = section(s, "### Current Holdings")
      .map((l) => l.match(/; value \$([\d,]+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .reduce((sum, m) => sum + Number(m[1].replace(/,/g, "")), 0);
    expect(holdings).toBe(900);
    for (const heading of ["### Asset Allocation", "### Sector Allocation"]) {
      const total = section(s, heading).reduce((sum, l) => sum + parse(l)[1], 0);
      expect(Math.abs(total - holdings)).toBeLessThanOrEqual(1);
    }
  });

  it("labels and totals equal query_allocation's for the same scope and dimension", () => {
    const s = getPortfolioSummaryForChat(db, "IBKR");
    const pairs: Array<[string, string]> = [
      ["### Asset Allocation", "security_type"],
      ["### Sector Allocation", "sector"],
    ];
    for (const [heading, dimension] of pairs) {
      const summary = section(s, heading).map(parse);
      const tool = getAllocationBreakdown(db, dimension, "IBKR").map(
        (r) => [r.group_name, Math.round(r.total_market_value)] as [string, number]
      );
      expect(summary).toEqual(tool);
    }
  });
});
