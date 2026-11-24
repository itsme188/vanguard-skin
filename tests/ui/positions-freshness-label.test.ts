/**
 * Words for the trust strip's "Positions as of" cell (2026-11-23). Pure
 * helper; synthetic data only.
 */
import { describe, it, expect } from "vitest";
import {
  formatPositionsDate,
  positionsFreshnessCell,
} from "@/lib/ui/positions-freshness-label";
import type {
  AccountPositionsFreshness,
  PositionsFreshness,
} from "@/lib/queries/positions-freshness";

function account(over: Partial<AccountPositionsFreshness>): AccountPositionsFreshness {
  return {
    accountId: 3,
    accountName: "Broker",
    newestLiveDate: "2026-11-23",
    liveRowCount: 2,
    leftover: { count: 0, oldestDate: null, symbols: [], items: [] },
    statementRows: { count: 0, oldestDate: null, newestDate: null, symbols: [], items: [] },
    liveSource: "broker sync",
    level: "good",
    ...over,
  };
}

function freshness(over: Partial<PositionsFreshness>): PositionsFreshness {
  return {
    accounts: [account({})],
    newestDate: "2026-11-23",
    oldestCountedLiveDate: "2026-11-23",
    leftoverCount: 0,
    statementRowCount: 0,
    level: "good",
    ...over,
  };
}

describe("formatPositionsDate", () => {
  it("prints month and day", () => {
    expect(formatPositionsDate("2026-11-23")).toBe("Nov 23");
    expect(formatPositionsDate("2026-01-05")).toBe("Jan 5");
  });
  it("passes an unreadable value through", () => {
    expect(formatPositionsDate("soon")).toBe("soon");
  });
});

describe("positionsFreshnessCell", () => {
  it("all rows on one date: that date, good", () => {
    const c = positionsFreshnessCell(freshness({}));
    expect(c.dateText).toBe("Nov 23");
    expect(c.countText).toBeNull();
    expect(c.tone).toBe("good");
  });

  it("statement rows beside a clean live sync: the cell names them", () => {
    const c = positionsFreshnessCell(
      freshness({
        accounts: [
          account({
            liveSource: "Plaid",
            statementRows: {
              count: 3,
              oldestDate: "2026-10-31",
              newestDate: "2026-10-31",
              symbols: ["AAA", "BBB", "CCC"],
              items: [],
            },
          }),
        ],
        statementRowCount: 3,
      }),
    );
    expect(c.dateText).toBe("Nov 23");
    expect(c.countText).toBe("3 from Oct 31 statement");
    expect(c.tone).toBe("good");
    expect(c.hint).toContain("last statement");
  });

  it("leftovers: the date range and the count, bad", () => {
    const c = positionsFreshnessCell(
      freshness({
        accounts: [
          account({
            leftover: {
              count: 12,
              oldestDate: "2026-11-20",
              symbols: [],
              items: [],
            },
            level: "bad",
          }),
        ],
        oldestCountedLiveDate: "2026-11-20",
        leftoverCount: 12,
        level: "bad",
      }),
    );
    expect(c.dateText).toBe("Nov 20 – Nov 23");
    expect(c.countText).toBe("12 not in latest sync");
    expect(c.tone).toBe("bad");
  });

  it("accounts synced on different days: a range, tone from the level", () => {
    const c = positionsFreshnessCell(
      freshness({
        accounts: [
          account({ accountId: 1, newestLiveDate: "2026-11-18", level: "warn" }),
          account({ accountId: 3 }),
        ],
        oldestCountedLiveDate: "2026-11-18",
        level: "warn",
      }),
    );
    expect(c.dateText).toBe("Nov 18 – Nov 23");
    expect(c.tone).toBe("warn");
  });

  it("statement rows only: the statement date, warn", () => {
    const c = positionsFreshnessCell(
      freshness({
        accounts: [
          account({
            newestLiveDate: null,
            liveRowCount: 0,
            liveSource: null,
            statementRows: {
              count: 1,
              oldestDate: "2026-10-31",
              newestDate: "2026-10-31",
              symbols: ["BND1"],
              items: [],
            },
          }),
        ],
        newestDate: "2026-10-31",
        oldestCountedLiveDate: null,
        statementRowCount: 1,
        level: "warn",
      }),
    );
    expect(c.dateText).toBe("Oct 31 statement");
    expect(c.tone).toBe("warn");
  });

  it("no positions in scope: neutral", () => {
    const c = positionsFreshnessCell(
      freshness({ accounts: [], newestDate: null, oldestCountedLiveDate: null }),
    );
    expect(c.dateText).toBe("No positions");
    expect(c.tone).toBe("neutral");
  });
});
