/**
 * The quote's session label (Gains at risk step 2, Task S3, rulings R8 and P10).
 *
 * "regular-session" only between 09:30 and the day's close on an open NYSE
 * day; "market-closed" otherwise. Early closes come from NYSE_EARLY_CLOSES
 * (dates checked by the controller on nyse.com, 2026-11-24); a day next to a
 * full closure that the list does not name closes at 13:00 (the conservative
 * rule). isMarketClosed and previousTradingDay keep their behaviour.
 */
import { describe, it, expect } from "vitest";
import { quoteSessionLabel, quoteSessionLabelWith, sessionCloseET } from "@/lib/calendar/market-session";
import {
  NYSE_EARLY_CLOSES,
  NYSE_EARLY_CLOSE_YEARS,
  NYSE_FULL_CLOSURES,
  earlyCloseTime,
  isMarketClosed,
  previousTradingDay,
} from "@/lib/calendar/market-holidays";

describe("quoteSessionLabel", () => {
  it.each([
    ["2026-11-10T15:00:00Z", "regular-session"], // Tue 10:00 ET
    ["2026-11-10T13:00:00Z", "market-closed"], // pre-open 08:00 ET
    ["2026-11-10T21:30:00Z", "market-closed"], // after the close 16:30 ET
    ["2026-11-14T16:00:00Z", "market-closed"], // Saturday
    ["2026-11-26T16:00:00Z", "market-closed"], // Thanksgiving
    ["2026-11-27T17:00:00Z", "regular-session"], // day after a Thursday holiday, 12:00 ET
    ["2026-11-27T18:30:00Z", "market-closed"], // same day, 13:30 ET (early close or the conservative rule)
    ["2026-12-24T18:30:00Z", "market-closed"], // eve of a holiday, 13:30 ET
    ["2026-12-22T18:30:00Z", "regular-session"], // an ordinary Tuesday, 13:30 ET
  ])("%s → %s", (iso, label) => {
    expect(quoteSessionLabel(new Date(iso))).toBe(label);
  });

  it("the open and the close are exact: 09:30 is open, 16:00 is closed", () => {
    expect(quoteSessionLabel(new Date("2026-11-10T14:29:00Z"))).toBe("market-closed"); // 09:29
    expect(quoteSessionLabel(new Date("2026-11-10T14:30:00Z"))).toBe("regular-session"); // 09:30
    expect(quoteSessionLabel(new Date("2026-11-10T20:59:00Z"))).toBe("regular-session"); // 15:59
    expect(quoteSessionLabel(new Date("2026-11-10T21:00:00Z"))).toBe("market-closed"); // 16:00
  });

  it("a listed early close closes at its time: 12:59 open, 13:00 closed", () => {
    expect(quoteSessionLabel(new Date("2026-12-24T17:59:00Z"))).toBe("regular-session");
    expect(quoteSessionLabel(new Date("2026-12-24T18:00:00Z"))).toBe("market-closed");
    expect(quoteSessionLabel(new Date("2027-11-26T18:00:00Z"))).toBe("market-closed");
  });

  it("in a year the early-close map covers, an unlisted day next to a closure is a full session", () => {
    expect(NYSE_EARLY_CLOSE_YEARS).toEqual([2026, 2027]);
    // Wed 2026-11-25, the eve of Thanksgiving: not an early close. 14:00 Eastern is in session.
    expect(earlyCloseTime("2026-11-25")).toBeNull();
    expect(quoteSessionLabel(new Date("2026-11-25T19:00:00Z"))).toBe("regular-session");
    expect(quoteSessionLabel(new Date("2026-11-25T20:59:00Z"))).toBe("regular-session"); // 15:59
    expect(quoteSessionLabel(new Date("2026-11-25T21:00:00Z"))).toBe("market-closed"); // 16:00
    // Fri 2027-01-15, before MLK Day (Mon 2027-01-18): 14:00 Eastern is in session.
    expect(quoteSessionLabel(new Date("2027-01-15T19:00:00Z"))).toBe("regular-session");
    // Tue 2027-01-19, after MLK Day.
    expect(quoteSessionLabel(new Date("2027-01-19T19:00:00Z"))).toBe("regular-session");
  });

  it("a listed early close: Fri 2026-11-27 in session at 12:00, closed at 13:30; Thu 2026-12-24 closed at 13:30", () => {
    expect(quoteSessionLabel(new Date("2026-11-27T17:00:00Z"))).toBe("regular-session");
    expect(quoteSessionLabel(new Date("2026-11-27T18:30:00Z"))).toBe("market-closed");
    expect(quoteSessionLabel(new Date("2026-12-24T18:30:00Z"))).toBe("market-closed");
  });

  it("in a year the map does not cover, a day next to a full closure closes at 13:00 (the conservative rule)", () => {
    // The full-closure list stops at 2027 too, so a 2028 closure is supplied to the rule here
    // (a test calendar; the real list is never extended by a derived date).
    const calendar = {
      isFullClosure: (d: string) => d === "2028-01-17", // a Monday closure in a year the map does not cover
      earlyClose: () => null,
      coveredYears: [2026, 2027],
    };
    expect(sessionCloseET("2028-01-14", calendar)).toBe("13:00"); // Friday before
    expect(sessionCloseET("2028-01-18", calendar)).toBe("13:00"); // Tuesday after
    expect(sessionCloseET("2028-01-19", calendar)).toBe("16:00"); // not next to it
    expect(quoteSessionLabelWith(new Date("2028-01-14T18:30:00Z"), calendar)).toBe("market-closed"); // 13:30
    expect(quoteSessionLabelWith(new Date("2028-01-14T17:30:00Z"), calendar)).toBe("regular-session"); // 12:30
    // The same shape in a covered year takes 16:00.
    const covered = { ...calendar, isFullClosure: (d: string) => d === "2027-01-18" };
    expect(sessionCloseET("2027-01-15", covered)).toBe("16:00");
  });

  it("the real calendar: a 2028 weekday after 13:00 is in session (no 2028 closure is listed to sit next to)", () => {
    expect(quoteSessionLabel(new Date("2028-01-19T18:30:00Z"))).toBe("regular-session");
  });

  it("uses the Eastern clock across the daylight-saving change", () => {
    // Summer: 10:00 EDT is 14:00 UTC.
    expect(quoteSessionLabel(new Date("2026-07-14T14:00:00Z"))).toBe("regular-session");
    expect(quoteSessionLabel(new Date("2026-07-14T13:00:00Z"))).toBe("market-closed"); // 09:00 EDT
  });
});

describe("NYSE_EARLY_CLOSES", () => {
  it("holds exactly the three dates checked on nyse.com, all at 13:00", () => {
    expect({ ...NYSE_EARLY_CLOSES }).toEqual({
      "2026-11-27": "13:00",
      "2026-12-24": "13:00",
      "2027-11-26": "13:00",
    });
    expect(earlyCloseTime("2026-11-27")).toBe("13:00");
    expect(earlyCloseTime("2026-11-10")).toBeNull();
  });

  it("never lists the unconfirmed 2026-07-02, and no early close is a full closure", () => {
    expect(earlyCloseTime("2026-07-02")).toBeNull();
    for (const d of Object.keys(NYSE_EARLY_CLOSES)) {
      expect(NYSE_FULL_CLOSURES).not.toContain(d);
      expect(NYSE_EARLY_CLOSE_YEARS).toContain(Number(d.slice(0, 4)));
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(NYSE_EARLY_CLOSES)).toBe(true);
  });
});

describe("isMarketClosed and previousTradingDay are unchanged by the early-close list", () => {
  it("isMarketClosed is unchanged by the early-close list", () => {
    expect(isMarketClosed("2026-11-27")).toBe(false);
    expect(isMarketClosed("2026-12-24")).toBe(false);
    expect(isMarketClosed("2027-11-26")).toBe(false);
    expect(isMarketClosed("2026-11-26")).toBe(true);
    expect(isMarketClosed("2026-11-28")).toBe(true);
  });

  it("previousTradingDay counts an early-close day as a full session", () => {
    expect(previousTradingDay("2026-11-30")).toBe("2026-11-27");
    expect(previousTradingDay("2026-12-28")).toBe("2026-12-24");
    expect(previousTradingDay("2026-11-27")).toBe("2026-11-25");
  });
});
