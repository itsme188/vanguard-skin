import { describe, it, expect } from "vitest";
import { deriveLeverageFactor, LEVERAGE_FACTOR_SEEDS } from "@/lib/securities/leverage-factor";

/**
 * The acceptance set: every leveraged or inverse fund the owner holds, with
 * the factor he hand-checked and approved on 2026-11-07, and the stored
 * fields each row really carries in the live database (read off a VACUUM
 * copy, verbatim — TBT's name really is blank there).
 */
const ACCEPTANCE_SET: Array<{
  symbol: string;
  approved: number;
  security_type: string;
  fund_category: string | null;
  name: string | null;
}> = [
  { symbol: "SOXS", approved: -3, security_type: "ETF", fund_category: null, name: "DIREX DAI SEMI BE 3X ETF-USD" },
  { symbol: "SOXL", approved: 3, security_type: "Stock", fund_category: null, name: "DIREX DAIL SEMI BU 3X ET-USD" },
  { symbol: "UCO", approved: 2, security_type: "ETF", fund_category: "Leveraged/Inverse (Commodities)", name: "PROSHARES ULTRA BLOOMBERG CR" },
  { symbol: "TQQQ", approved: 3, security_type: "Stock", fund_category: "Leveraged/Inverse", name: "PROSHARES ULTRAPRO QQQ" },
  { symbol: "UDOW", approved: 3, security_type: "Stock", fund_category: "Leveraged/Inverse", name: "PROSHARES ULTRAPRO DOW30" },
  { symbol: "MSTZ", approved: -2, security_type: "ETF", fund_category: null, name: "T-REX 2X INVERSE MSTR DT ETF" },
  { symbol: "NVDL", approved: 2, security_type: "Stock", fund_category: "Leveraged Equity", name: "GRANITESH 2X LNG NVDA ETF" },
  { symbol: "UVIX", approved: 2, security_type: "Stock", fund_category: null, name: "2X LONG VIX FUTURES ETF" },
  // TBT's name is blank in the live table, so no multiple and no direction can
  // be read off the row: it comes from the seed table, by ticker identity.
  { symbol: "TBT", approved: -2, security_type: "Stock", fund_category: "Leveraged/Inverse", name: null },
];

describe("deriveLeverageFactor — the acceptance set (owner-approved 2026-11-07)", () => {
  for (const row of ACCEPTANCE_SET) {
    it(`${row.symbol} resolves to ${row.approved > 0 ? "+" : ""}${row.approved}`, () => {
      const result = deriveLeverageFactor(row);
      expect(result.factor).toBe(row.approved);
    });
  }

  it("derives eight of the nine from the stored fields alone; only TBT is seeded", () => {
    const seeded = ACCEPTANCE_SET.filter((r) => deriveLeverageFactor(r).source === "seed").map((r) => r.symbol);
    expect(seeded).toEqual(["TBT"]);
  });

  it("every seed is an owner-approved factor, and the table holds nothing else", () => {
    expect(LEVERAGE_FACTOR_SEEDS).toEqual({ TBT: -2 });
  });
});

describe("deriveLeverageFactor — magnitude and sign", () => {
  const fund = (name: string | null, extra: Partial<{ fund_category: string | null; security_type: string }> = {}) => ({
    symbol: "TEST",
    security_type: extra.security_type ?? "ETF",
    fund_category: extra.fund_category ?? null,
    name,
  });

  it("reads the magnitude off a standalone leverage token", () => {
    expect(deriveLeverageFactor(fund("SOMETHING 2X LONG ETF")).factor).toBe(2);
    expect(deriveLeverageFactor(fund("SOMETHING 3X BULL ETF")).factor).toBe(3);
  });

  it("reads ProShares house words: Ultra is 2x, UltraPro is 3x", () => {
    expect(deriveLeverageFactor(fund("PROSHARES ULTRA SOMETHING")).factor).toBe(2);
    expect(deriveLeverageFactor(fund("PROSHARES ULTRAPRO SOMETHING")).factor).toBe(3);
    expect(deriveLeverageFactor(fund("PROSHARES ULTRASHORT SOMETHING")).factor).toBe(-2);
    expect(deriveLeverageFactor(fund("PROSHARES ULTRAPRO SHORT SOMETHING")).factor).toBe(-3);
  });

  it("signs the factor negative on any inverse marker", () => {
    for (const name of [
      "X 3X INVERSE SOMETHING",
      "X 3X SHORT SOMETHING",
      "DIREX DAIL SOMETHING BEAR 3X",
      "DIREX DAI SOMETHING BE 3X",
      "SOMETHING -3X DAILY",
    ]) {
      expect(deriveLeverageFactor(fund(name)).factor, name).toBe(-3);
    }
  });

  it("is positive when a multiple is stated and no inverse marker is", () => {
    expect(deriveLeverageFactor(fund("GRANITESH 2X NVDA ETF")).factor).toBe(2);
  });

  it("refuses a row the flag rule does not match", () => {
    const plain = deriveLeverageFactor({ symbol: "AAPL", security_type: "Stock", fund_category: null, name: "APPLE INC" });
    expect(plain.factor).toBeNull();
    expect(plain.reason).toBe("not_flagged");
  });

  it("refuses a bond row even with a leverage token in its name", () => {
    const bond = deriveLeverageFactor({ symbol: "B", security_type: "Bond", fund_category: null, name: "SOMETHING 3X BEAR" });
    expect(bond.factor).toBeNull();
    expect(bond.reason).toBe("not_flagged");
  });

  it("leaves a flagged row with no readable multiple at NULL", () => {
    const flagged = deriveLeverageFactor({
      symbol: "ZZZZ",
      security_type: "ETF",
      fund_category: "Leveraged/Inverse",
      name: "A FUND WITH NO STATED MULTIPLE",
    });
    expect(flagged.factor).toBeNull();
    expect(flagged.reason).toBe("no_multiple");
  });

  it("never reads a two-digit figure as a leverage token", () => {
    // "DOW30" must not read as a 30x fund, and ULTRAPRO must still give 3.
    expect(deriveLeverageFactor(fund("PROSHARES ULTRAPRO DOW30")).factor).toBe(3);
  });
});
