import { describe, it, expect } from "vitest";
import {
  classifyBook,
  type DefenseInstrument,
  type UnderlyingGroup,
} from "@/lib/compute/hedging";

function inst(over: Partial<DefenseInstrument>): DefenseInstrument {
  return {
    securityId: 1,
    symbol: "TEST",
    underlying: "TEST",
    isOption: false,
    optionType: null,
    quantity: 100,
    exposure: 10000,
    marketValue: 10000,
    underlyingIsEtf: false,
    sector: "Technology",
    geography: "US",
    greeksAvailable: true,
    ...over,
  };
}

function group(underlying: string, isEtf: boolean, instruments: DefenseInstrument[]): [string, UnderlyingGroup] {
  return [underlying, { underlying, underlyingIsEtf: isEtf, instruments }];
}

describe("classifyBook — Tier 1 pairs", () => {
  it("classifies long stock + puts as hedged_long with capped coverage", () => {
    const r = classifyBook(new Map([group("MSFT", false, [
      inst({ securityId: 1, symbol: "MSFT", exposure: 20000 }),
      inst({ securityId: 2, symbol: "MSFT  270115P00400000", isOption: true, optionType: "PUT", quantity: 2, exposure: -8000, marketValue: 3000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "MSFT")!;
    expect(pair.classification).toBe("hedged_long");
    expect(pair.coreExposure).toBe(20000);
    expect(pair.offsetCredited).toBe(8000);
    expect(pair.coveragePct).toBeCloseTo(0.4);
    expect(pair.netExposure).toBe(12000);
  });

  it("classifies short stock + long call as hedged_short", () => {
    const r = classifyBook(new Map([group("PAYC", false, [
      inst({ securityId: 1, symbol: "PAYC", quantity: -80, exposure: -12000, marketValue: -12000 }),
      inst({ securityId: 2, symbol: "PAYC  260116C00200000", isOption: true, optionType: "CALL", quantity: 1, exposure: 4000, marketValue: 1500 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "PAYC")!;
    expect(pair.classification).toBe("hedged_short");
    expect(pair.offsetCredited).toBe(4000);
    expect(pair.coveragePct).toBeCloseTo(4000 / 12000);
  });

  it("flags same-sign options on a long core as amplifiers, not hedges", () => {
    const r = classifyBook(new Map([group("INTC", false, [
      inst({ securityId: 1, symbol: "INTC", exposure: 5000 }),
      inst({ securityId: 2, symbol: "INTC  260320C00030000", isOption: true, optionType: "CALL", quantity: 20, exposure: 15000, marketValue: 6000 }),
      inst({ securityId: 3, symbol: "INTC  260320P00045000", isOption: true, optionType: "PUT", quantity: 4, exposure: -3000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "INTC")!;
    expect(pair.classification).toBe("hedged_long"); // opposing puts exist
    expect(pair.amplifierExposure).toBe(15000);
    expect(pair.hasAmplifiers).toBe(true);
    expect(pair.netExposure).toBe(17000);
  });

  it("caps offset credit at |core| and spills ETF excess to proxy candidates", () => {
    const r = classifyBook(new Map([group("XLE", true, [
      inst({ securityId: 1, symbol: "XLE", exposure: 10000 }),
      inst({ securityId: 2, symbol: "XLE   260116P00080000", isOption: true, optionType: "PUT", quantity: 10, exposure: -16000, marketValue: 5000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "XLE")!;
    expect(pair.offsetCredited).toBe(10000);        // capped
    expect(pair.coveragePct).toBeCloseTo(1.0);
    const spill = r.proxyCandidates.find((c) => c.underlying === "XLE")!;
    expect(spill.protectiveNotional).toBe(6000);    // the excess
    expect(spill.source).toBe("tier1_spill");
  });

  it("routes a short ETF plus same-sign puts entirely to proxy candidates (MAGS case)", () => {
    const r = classifyBook(new Map([group("MAGS", true, [
      inst({ securityId: 1, symbol: "MAGS", quantity: -300, exposure: -15000, marketValue: -15000 }),
      inst({ securityId: 2, symbol: "MAGS  260116P00050000", isOption: true, optionType: "PUT", quantity: 10, exposure: -9000, marketValue: 4000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "MAGS")).toBeUndefined();
    const c = r.proxyCandidates.find((c) => c.underlying === "MAGS")!;
    expect(c.protectiveNotional).toBe(24000);       // short shares + puts
    expect(c.source).toBe("etf_negative_stack");
  });

  it("routes ETF puts with no core to proxy candidates", () => {
    const r = classifyBook(new Map([group("MTUM", true, [
      inst({ securityId: 2, symbol: "MTUM  260116P00200000", isOption: true, optionType: "PUT", quantity: 3, exposure: -12000, marketValue: 3500 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "MTUM")!.protectiveNotional).toBe(12000);
  });

  it("classifies single-name puts on non-held stock AND naked single-name shorts as standalone bets", () => {
    const r = classifyBook(new Map([
      group("RGTI", false, [
        inst({ securityId: 2, symbol: "RGTI  260116P00010000", isOption: true, optionType: "PUT", quantity: 20, exposure: -5000, marketValue: 2500 }),
      ]),
      group("AMD", false, [
        inst({ securityId: 3, symbol: "AMD", quantity: -20, exposure: -3000, marketValue: -3000 }),
      ]),
    ]));
    expect(r.standaloneBets).toHaveLength(2);
    expect(r.pairs.find((p) => p.underlying === "AMD")).toBeUndefined();
    expect(r.proxyCandidates).toHaveLength(0);
  });

  it("classifies naked long calls as speculative pairs (risk, never protection)", () => {
    const r = classifyBook(new Map([group("FROG", false, [
      inst({ securityId: 2, symbol: "FROG  260116C00040000", isOption: true, optionType: "CALL", quantity: 4, exposure: 7000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "FROG")!;
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(7000);
  });

  it("classifies plain long stock with no options as unhedged", () => {
    const r = classifyBook(new Map([group("XOM", false, [
      inst({ securityId: 1, symbol: "XOM", exposure: 11000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "XOM")!.classification).toBe("unhedged");
  });
});
