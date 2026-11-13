/**
 * The IBKR Web API fallback (writeIbkrHoldings) runs the closed-position
 * reconciler after a real write, as the TWS sync does (auto-refresh Step 1.8).
 * Without it a stock closed while TWS is disconnected keeps its older
 * non-zero row as the latest holding. Synthetic symbols and figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { writeIbkrHoldings } from "@/lib/ibkr/refresh";
import type { MappedPosition } from "@/lib/ibkr/map-positions";
import { todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function stock(symbol: string, conid: number): MappedPosition {
  return {
    symbol,
    securityType: "Stock",
    assetClass: "STK",
    conid,
    quantity: 10,
    avgCost: 20,
    costBasis: 200,
    mktPrice: 25,
    mktValue: 250,
    currency: "USD",
  };
}

function snapshot(positions: MappedPosition[]) {
  return { accountCode: "U1", netLiq: 1000, cash: 100, positions };
}

function rowOn(symbol: string, day: string): { quantity: number } | undefined {
  return db
    .prepare(
      `SELECT h.quantity FROM holdings h JOIN securities s ON s.id = h.security_id
        WHERE s.symbol = ? AND h.as_of_date = ?`,
    )
    .get(symbol, day) as { quantity: number } | undefined;
}

function taxGeneration(): string | undefined {
  return (
    db.prepare("SELECT value FROM settings WHERE key = 'tax_input_generation'").get() as
      | { value: string }
      | undefined
  )?.value;
}

const DAY1 = "2026-03-12"; // Thursday
const DAY2 = "2026-03-13"; // Friday
const SATURDAY = "2026-03-14";

describe("writeIbkrHoldings runs the closed-position reconciler", () => {
  it("marks a stock missing from the new snapshot flat on the new date", () => {
    writeIbkrHoldings(db, snapshot([stock("ZQA", 5101), stock("ZQB", 5102), stock("ZQC", 5103)]), {
      asOfDate: DAY1,
    });
    const genBefore = taxGeneration();
    const res = writeIbkrHoldings(db, snapshot([stock("ZQA", 5101), stock("ZQB", 5102)]), {
      asOfDate: DAY2,
    });

    expect(res.skippedReason).toBeNull();
    expect(res.positionsWritten).toBe(2);
    expect(rowOn("ZQC", DAY2)).toEqual({ quantity: 0 });
    expect(rowOn("ZQA", DAY2)).toEqual({ quantity: 10 });
    expect(rowOn("ZQB", DAY2)).toEqual({ quantity: 10 });
    // A live-pass tombstone is not a tax input: no generation bump.
    expect(taxGeneration()).toBe(genBefore);
  });

  it("works when the as-of day is today (Eastern)", () => {
    const today = todayET();
    if (isMarketClosed(today)) return; // the closed-day case is covered below
    const prior = "2026-03-12";
    writeIbkrHoldings(db, snapshot([stock("ZQA", 5101), stock("ZQB", 5102), stock("ZQC", 5103)]), {
      asOfDate: prior,
    });
    writeIbkrHoldings(db, snapshot([stock("ZQA", 5101), stock("ZQB", 5102)]));
    expect(rowOn("ZQC", today)).toEqual({ quantity: 0 });
  });

  it("mints nothing on a closed market day", () => {
    writeIbkrHoldings(db, snapshot([stock("ZQA", 5101), stock("ZQB", 5102), stock("ZQC", 5103)]), {
      asOfDate: DAY2,
    });
    const res = writeIbkrHoldings(db, snapshot([stock("ZQA", 5101), stock("ZQB", 5102)]), {
      asOfDate: SATURDAY,
    });
    expect(res.skippedReason).toBe("market_closed");
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM holdings WHERE quantity = 0").get() as { c: number }).c,
    ).toBe(0);
    expect(rowOn("ZQC", DAY2)).toEqual({ quantity: 10 });
  });

  it("mints nothing when the snapshot shrinks past the reconciler's guard", () => {
    writeIbkrHoldings(
      db,
      snapshot([stock("ZQA", 5101), stock("ZQB", 5102), stock("ZQC", 5103), stock("ZQD", 5104)]),
      { asOfDate: DAY1 },
    );
    writeIbkrHoldings(db, snapshot([stock("ZQA", 5101)]), { asOfDate: DAY2 });
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM holdings WHERE quantity = 0").get() as { c: number }).c,
    ).toBe(0);
  });
});
