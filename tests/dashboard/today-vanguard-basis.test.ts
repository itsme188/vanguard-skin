/**
 * Plan v4 (Plaid session dating), unit U3: the Today page's Vanguard wording.
 * `olderVanguardBasisNote` names the close the positions are from, and
 * `accountValueCaption` names the positions' session and the valuation date
 * separately, never calling a value a Plaid close for a date with no Plaid
 * anchor. Pure helpers plus source pins (the repo has no DOM harness).
 * Invented dates only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  accountValueCaption,
  olderVanguardBasisNote,
  type AccountValueCaptionInput,
} from "@/app/dashboard/today/basis-labels";
import { anchorIndex } from "../helpers/source-anchor";

const TODAY = "2026-03-18";

function input(over: Partial<AccountValueCaptionInput> = {}): AccountValueCaptionInput {
  return {
    sourceKind: "daily",
    asOfDate: "2026-03-18",
    valuationDate: "2026-03-18",
    holdingsSession: "2026-03-17",
    holdingsSource: "plaid",
    anchorSession: "2026-03-17",
    anchorSource: "plaid",
    ...over,
  };
}

describe("olderVanguardBasisNote", () => {
  it("names the close the Vanguard positions are from", () => {
    expect(olderVanguardBasisNote("2026-03-17", "2026-03-18", TODAY)).toBe(
      "Vanguard positions from the Mar 17 close",
    );
  });
  it("adds the year when it differs from today's", () => {
    expect(olderVanguardBasisNote("2025-12-31", "2026-01-02", TODAY)).toBe(
      "Vanguard positions from the Dec 31, 2025 close",
    );
  });
  it("is silent when the positions are not older than the headline date", () => {
    expect(olderVanguardBasisNote("2026-03-18", "2026-03-18", TODAY)).toBeNull();
  });
});

describe("accountValueCaption", () => {
  it("Plaid positions with a Plaid anchor on their date, valued later at the latest prices", () => {
    expect(accountValueCaption(input(), TODAY)).toBe(
      "Positions from the Mar 17 close (Plaid). Valued Mar 18 at the latest prices.",
    );
  });

  it("a valuation dated after the Plaid anchor is never called a Plaid close", () => {
    const caption = accountValueCaption(input(), TODAY)!;
    expect(caption).not.toMatch(/Mar 18 close/);
    expect(caption).not.toMatch(/Valued .*\(Plaid\)/);
  });

  it("a valuation on the Plaid anchor's own date reads as that close", () => {
    expect(accountValueCaption(input({ asOfDate: "2026-03-17", valuationDate: "2026-03-17" }), TODAY)).toBe(
      "Positions from the Mar 17 close (Plaid). Valued at the Mar 17 close (Plaid).",
    );
  });

  it("A8: a valuation older than the anchor says the value is not yet updated", () => {
    expect(accountValueCaption(input({ asOfDate: "2026-03-16", valuationDate: "2026-03-16" }), TODAY)).toBe(
      "Positions from the Mar 17 close (Plaid). Value not yet updated for the Mar 17 close.",
    );
  });

  it("Plaid positions with no Plaid anchor on their date are never called a Plaid close", () => {
    const noAnchor = accountValueCaption(
      input({ anchorSession: "2026-02-27", anchorSource: "statement" }),
      TODAY,
    )!;
    expect(noAnchor).toBe("Positions from Plaid, dated Mar 17. Valued Mar 18 at the latest prices.");
    expect(noAnchor).not.toContain("close");
    const otherDate = accountValueCaption(input({ anchorSession: "2026-03-16" }), TODAY)!;
    expect(otherDate.startsWith("Positions from Plaid, dated Mar 17.")).toBe(true);
  });

  it("statement positions name the statement", () => {
    expect(
      accountValueCaption(
        input({
          holdingsSession: "2026-02-27",
          holdingsSource: "statement",
          anchorSession: "2026-02-27",
          anchorSource: "statement",
        }),
        TODAY,
      ),
    ).toBe("Positions from the Feb 27 statement. Valued Mar 18 at the latest prices.");
  });

  it("a value read from the statement row names the statement", () => {
    expect(
      accountValueCaption(
        input({
          sourceKind: "statement",
          asOfDate: "2026-02-27",
          valuationDate: "2026-02-27",
          holdingsSession: "2026-02-27",
          holdingsSource: "statement",
          anchorSession: "2026-02-27",
          anchorSource: "statement",
        }),
        TODAY,
      ),
    ).toBe("Positions from the Feb 27 statement. Valued at the Feb 27 statement.");
  });

  it("says nothing when nothing is on record", () => {
    expect(
      accountValueCaption(
        {
          sourceKind: null,
          asOfDate: null,
          valuationDate: null,
          holdingsSession: null,
          holdingsSource: null,
          anchorSession: null,
          anchorSource: null,
        },
        TODAY,
      ),
    ).toBeNull();
  });
});

describe("Today page wiring (source pins)", () => {
  const page = readFileSync("app/dashboard/today/page.tsx", "utf8");

  it("the Vanguard holdings-date query keeps its MIN-over-accounts rule and leaves out recon tombstones", () => {
    const query = page.slice(anchorIndex(page, "SELECT MIN(latest) AS earliest"));
    const end = query.indexOf("`");
    const sql = query.slice(0, end);
    expect(sql).toContain("MAX(h.as_of_date) AS latest");
    expect(sql).toContain("GROUP BY h.account_id");
    expect(sql).toContain("NOT LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'");
  });

  it("each Vanguard account's caption comes from the pure helper, over the strip's own reader", () => {
    expect(page).toContain("accountValueCaption(a, todayET())");
    expect(page).toContain("portfolio.accounts");
    expect(page).toContain("{c.accountName}: {c.caption}");
  });
});
