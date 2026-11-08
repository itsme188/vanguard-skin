import { describe, it, expect } from "vitest";
import {
  titleFromUserText,
  conversationTitleFromMessages,
  maskTitleFigures,
} from "@/lib/chat/conversation-title";

describe("titleFromUserText", () => {
  it("keeps a short message whole", () => {
    expect(titleFromUserText("How is ZZA doing today?")).toBe("How is ZZA doing today?");
  });
  it("truncates at a word boundary with an ellipsis", () => {
    const t = titleFromUserText(
      "Please explain why the technology sector underperformed the broader market last quarter in detail",
    );
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(61);
    const body = t.slice(0, -1);
    expect(
      "Please explain why the technology sector underperformed the broader market last quarter in detail".startsWith(body),
    ).toBe(true);
    expect(body.endsWith(" ")).toBe(false);
    expect(body.endsWith("underperfor")).toBe(false);
  });
  it("hard-cuts one very long word", () => {
    const t = titleFromUserText("x".repeat(200));
    expect(t).toBe("x".repeat(60) + "…");
  });
  it("returns empty for empty or whitespace input", () => {
    expect(titleFromUserText("")).toBe("");
    expect(titleFromUserText("  \n\t ")).toBe("");
  });
  it("uses only the first non-empty line of a multi-line message", () => {
    expect(titleFromUserText("\n\nWhat is ZZB?\nSecond line here")).toBe("What is ZZB?");
  });
  it("strips markdown noise", () => {
    expect(titleFromUserText("## **Trim** `ZZA`")).toBe("Trim ZZA");
  });
});

describe("conversationTitleFromMessages", () => {
  it("reads the first user message text parts", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "Compare ZZA " }, { type: "text", text: "and ZZB" }] },
      { role: "assistant", parts: [{ type: "text", text: "Sure." }] },
    ];
    expect(conversationTitleFromMessages(msgs)).toBe("Compare ZZA and ZZB");
  });
  it("returns empty when there is no user text", () => {
    expect(conversationTitleFromMessages([])).toBe("");
    expect(conversationTitleFromMessages([{ role: "user", parts: [{ type: "file" }] }])).toBe("");
  });
});

describe("maskTitleFigures", () => {
  const M = "•••";
  it("masks currency amounts", () => {
    expect(maskTitleFigures("Why did $12,500.50 change")).toBe(`Why did ${M} change`);
    expect(maskTitleFigures("Sell $2k of ZZA")).toBe(`Sell ${M} of ZZA`);
    expect(maskTitleFigures("worth 3.5M USD")).not.toMatch(/3\.5M/);
  });
  it("shows percentages (owner ruling 2026-11-07)", () => {
    expect(maskTitleFigures("ZZA is up 12.5% today")).toBe("ZZA is up 12.5% today");
  });
  it("masks share counts", () => {
    expect(maskTitleFigures("I own 150 shares of ZZB")).toBe(`I own ${M} of ZZB`);
    expect(maskTitleFigures("sold 1,200 sh")).toBe(`sold ${M}`);
  });
  it("keeps tickers, words and dates", () => {
    const s = "Outlook for ZZA vs ZZB on 2026-07-15 and FY26";
    expect(maskTitleFigures(s)).toBe(s);
  });
});

describe("maskTitleFigures: every standalone number", () => {
  const masked: Array<[string, RegExp]> = [
    ["My account is 412,000 now", /412|000/],
    ["Portfolio hit 1.2M", /1\.2/],
    ["Why did I lose 2.5k", /2\.5/],
    ["Down -4,500 on TSLA today", /4,?500/],
    ["Should I buy 500 AAPL", /500/],
    ["Roll my 10 contracts of SPY 450C", /\b10\b/],
    ["VTI at 1,234,567 total", /1,?234/],
    ["1.2 million in bonds", /1\.2/],
    ["€5,000 in EUR fund", /5,?000/],
    ["Is $412k enough", /412/],
    ["3M", /3/],
    ["Portfolio hit 3M", /3/],
    ["lost 5M", /5/],
    ["300 shares", /300/],
    ["lost -$4,500", /4,?500/],
    ["sold 1200 sh", /1200/],
  ];
  for (const [input, leak] of masked) {
    it(`masks: ${input}`, () => {
      expect(maskTitleFigures(input)).not.toMatch(leak);
    });
  }
  it("keeps 450C when masking its neighbour", () => {
    expect(maskTitleFigures("Roll my 10 contracts of SPY 450C")).toContain("450C");
  });
  for (const keep of ["450C", "Q3", "8-K", "10-K", "BRK.B"]) {
    it(`keeps ${keep}`, () => {
      expect(maskTitleFigures(keep)).toBe(keep);
    });
  }
});

/**
 * Owner ruling 2026-11-07 (decision #52, Option 2): in a privacy-masked chat
 * title, DATE shapes and PERCENT / BASIS-POINT tokens render as written.
 * Currency amounts, share counts and every other standalone number stay
 * masked exactly as before. Amends the 2026-10-26 ruling (mask every
 * standalone number, ISO dates kept).
 */
describe("maskTitleFigures: dates and percentages show (ruling 2026-11-07)", () => {
  const M = "•••";

  const shown = [
    // Percent / basis points
    "ZZA is up 3.2% today",
    "Why is ZZB down -1.75%",
    "Spreads widened +25bp",
    "Curve moved down 40 bps",
    "A 12 percent drawdown",
    "Hedge is 8 pct of the book",
    // Full dates
    "What happened on 2026-11-05",
    "Recap for 11/05/2026",
    "Recap for 2026/11/05",
    "Notes from Nov 5, 2026",
    "Notes from 5 November 2026",
    // Partial dates
    "What moved on Nov 5",
    "What moved on 11/5",
    "What moved on November 5th",
    "What moved on 5 Nov",
  ];
  for (const title of shown) {
    it(`shows: ${title}`, () => {
      expect(maskTitleFigures(title)).toBe(title);
    });
  }

  const stillMasked: Array<[string, RegExp]> = [
    ["Why did $12,500.50 change", /12|500/],
    ["Is $412k enough", /412/],
    ["Portfolio hit 1.2M", /1\.2/],
    ["I own 150 shares of ZZB", /150/],
    ["Roll my 10 contracts of SPY 450C", /\b10\b/],
    ["Should I buy 500 ZZA", /500/],
  ];
  for (const [title, leak] of stillMasked) {
    it(`still masks: ${title}`, () => {
      expect(maskTitleFigures(title)).not.toMatch(leak);
    });
  }

  it("shows the date and the percent but masks the dollar amount in one title", () => {
    expect(maskTitleFigures("On Nov 5 ZZA fell 3.2% costing me $4,500")).toBe(
      `On Nov 5 ZZA fell 3.2% costing me ${M}`,
    );
  });

  it("keeps a bare year masked — a 4-digit number is not a date shape", () => {
    expect(maskTitleFigures("Balance of 2026 dollars")).toBe(`Balance of ${M} dollars`);
  });

  it("does not let a currency sign ride along on a percent token", () => {
    expect(maskTitleFigures("Fees of $3 and a 2% load")).toBe(`Fees of ${M} and a 2% load`);
  });
});
