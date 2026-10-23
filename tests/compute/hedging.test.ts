import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyBook,
  computeGapGuardedBeta,
  resolveProxyBeta,
  attributeProxies,
  scoreHedges,
  pairHedgeInstruments,
  proxyHedgeInstruments,
  type DefenseInstrument,
  type UnderlyingGroup,
  type AttributionContext,
  type ProxyCandidate,
} from "@/lib/compute/hedging";
import { runMigrations } from "@/lib/db/migrate";

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
    const r = classifyBook(new Map([group("ZZA", false, [
      inst({ securityId: 1, symbol: "ZZA", exposure: 20000 }),
      inst({ securityId: 2, symbol: "ZZA   270115P00400000", isOption: true, optionType: "PUT", quantity: 2, exposure: -8000, marketValue: 3000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "ZZA")!;
    expect(pair.classification).toBe("hedged_long");
    expect(pair.coreExposure).toBe(20000);
    expect(pair.offsetCredited).toBe(8000);
    expect(pair.coveragePct).toBeCloseTo(0.4);
    expect(pair.netExposure).toBe(12000);
  });

  it("classifies short stock + long call as hedged_short", () => {
    const r = classifyBook(new Map([group("ZZB", false, [
      inst({ securityId: 1, symbol: "ZZB", quantity: -60, exposure: -12000, marketValue: -12000 }),
      inst({ securityId: 2, symbol: "ZZB   260116C00200000", isOption: true, optionType: "CALL", quantity: 1, exposure: 4000, marketValue: 1500 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "ZZB")!;
    expect(pair.classification).toBe("hedged_short");
    expect(pair.offsetCredited).toBe(4000);
    expect(pair.coveragePct).toBeCloseTo(4000 / 12000);
  });

  it("a written put against a short stock is income, not a hedge: the short stays naked", () => {
    const writtenPut = inst({ securityId: 2, symbol: "ZZC   260116P00200000", isOption: true, optionType: "PUT", quantity: -3, exposure: 4000, marketValue: -900, thetaPerDay: 300 });
    const r = classifyBook(new Map([group("ZZC", false, [
      inst({ securityId: 1, symbol: "ZZC", underlying: "ZZC", quantity: -30, exposure: -12000, marketValue: -12000 }),
      writtenPut,
    ])]));
    expect(r.pairs.find((p) => p.underlying === "ZZC")).toBeUndefined();
    expect(r.pairs.some((p) => p.classification === "hedged_short")).toBe(false);
    const bet = r.standaloneBets.find((b) => b.underlying === "ZZC")!;
    expect(bet.kind).toBe("naked_short");
    // The put still shows in the instrument list, and netExposure sums everything.
    expect(bet.instruments).toContain(writtenPut);
    expect(bet.exposure).toBe(-8000);
    // Summary protective notional = sum of pair offsetCredited + proxy credit: nothing here.
    expect(r.proxyCandidates).toHaveLength(0);
  });

  it("a written put beside a long call on a short: only the long call is credited and scored", () => {
    const longCall = inst({ securityId: 2, symbol: "ZZC   260116C00200000", isOption: true, optionType: "CALL", quantity: 1, exposure: 4000, marketValue: 1500, thetaPerDay: -20 });
    const writtenPut = inst({ securityId: 3, symbol: "ZZC   260116P00150000", isOption: true, optionType: "PUT", quantity: -3, exposure: 4000, marketValue: -900, thetaPerDay: 300 });
    const r = classifyBook(new Map([group("ZZC", false, [
      inst({ securityId: 1, symbol: "ZZC", quantity: -30, exposure: -12000, marketValue: -12000 }),
      longCall,
      writtenPut,
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "ZZC")!;
    expect(pair.classification).toBe("hedged_short");
    expect(pair.offsetExposure).toBe(4000);
    expect(pair.offsetCredited).toBe(4000);
    expect(pair.hasAmplifiers).toBe(false);
    expect(pair.instruments).toContain(writtenPut);
    // Hedge-book scoring picks only the long call.
    expect(pairHedgeInstruments(pair)).toEqual([longCall]);
  });

  // Short ETF stacks are judged in a crash: the short shares and any LONG
  // puts gain, a WRITTEN put loses as prices fall, and calls (long or
  // written) neither add nor take away crash protection.
  it("a written put is subtracted from a short ETF stack: it loses in a crash", () => {
    const r = classifyBook(new Map([group("ZZF", true, [
      inst({ securityId: 1, symbol: "ZZF", quantity: -100, exposure: -10000, marketValue: -10000 }),
      inst({ securityId: 2, symbol: "ZZF   260116P00050000", isOption: true, optionType: "PUT", quantity: -2, exposure: 4000, marketValue: -900, thetaPerDay: 300 }),
    ])]));
    const c = r.proxyCandidates.find((c) => c.underlying === "ZZF")!;
    expect(c.source).toBe("etf_negative_stack");
    expect(c.protectiveNotional).toBe(6000);
  });

  it("a written put larger than the short ETF core leaves no protection", () => {
    const r = classifyBook(new Map([group("ZZF", true, [
      inst({ securityId: 1, symbol: "ZZF", quantity: -100, exposure: -10000, marketValue: -10000 }),
      inst({ securityId: 2, symbol: "ZZF   260116P00050000", isOption: true, optionType: "PUT", quantity: -10, exposure: 15000, marketValue: -4000, thetaPerDay: 900 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "ZZF")).toBeUndefined();
    expect(r.pairs.some((p) => p.underlying === "ZZF" && p.offsetCredited > 0)).toBe(false);
  });

  it("a long call does not reduce a short ETF stack's crash protection", () => {
    const r = classifyBook(new Map([group("ZZF", true, [
      inst({ securityId: 1, symbol: "ZZF", quantity: -100, exposure: -10000, marketValue: -10000 }),
      inst({ securityId: 2, symbol: "ZZF   260116C00060000", isOption: true, optionType: "CALL", quantity: 2, exposure: 4000, marketValue: 800 }),
    ])]));
    const c = r.proxyCandidates.find((c) => c.underlying === "ZZF")!;
    expect(c.source).toBe("etf_negative_stack");
    expect(c.protectiveNotional).toBe(10000);
  });

  it("a written call is not credited as protection on a short ETF stack and earns no hedge-book row", () => {
    const writtenCall = inst({ securityId: 2, symbol: "ZZF   260116C00060000", isOption: true, optionType: "CALL", quantity: -2, exposure: -4000, marketValue: -800, thetaPerDay: 40 });
    const longPut = inst({ securityId: 3, symbol: "ZZF   260116P00040000", isOption: true, optionType: "PUT", quantity: 1, exposure: -2000, marketValue: 300, thetaPerDay: -10 });
    const shortShares = inst({ securityId: 1, symbol: "ZZF", quantity: -100, exposure: -10000, marketValue: -10000 });
    const r = classifyBook(new Map([group("ZZF", true, [shortShares, writtenCall, longPut])]));
    const c = r.proxyCandidates.find((c) => c.underlying === "ZZF")!;
    expect(c.source).toBe("etf_negative_stack");
    expect(c.protectiveNotional).toBe(12000); // short shares + long put only
    expect(proxyHedgeInstruments(c)).toEqual([shortShares, longPut]);
  });

  it("a short ETF stack nets long puts and written puts and ignores calls", () => {
    const r = classifyBook(new Map([group("ZZF", true, [
      inst({ securityId: 1, symbol: "ZZF", quantity: -100, exposure: -10000, marketValue: -10000 }),
      inst({ securityId: 2, symbol: "ZZF   260116P00040000", isOption: true, optionType: "PUT", quantity: 3, exposure: -6000, marketValue: 900 }),
      inst({ securityId: 3, symbol: "ZZF   260116P00030000", isOption: true, optionType: "PUT", quantity: -1, exposure: 1000, marketValue: -200 }),
      inst({ securityId: 4, symbol: "ZZF   260116C00060000", isOption: true, optionType: "CALL", quantity: 2, exposure: 4000, marketValue: 800 }),
      inst({ securityId: 5, symbol: "ZZF   260116C00070000", isOption: true, optionType: "CALL", quantity: -1, exposure: -2000, marketValue: -300 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "ZZF")!.protectiveNotional).toBe(15000);
  });

  it("flags same-sign options on a long core as amplifiers, not hedges", () => {
    const r = classifyBook(new Map([group("ZZC", false, [
      inst({ securityId: 1, symbol: "ZZC", exposure: 5000 }),
      inst({ securityId: 2, symbol: "ZZC   260320C00030000", isOption: true, optionType: "CALL", quantity: 10, exposure: 15000, marketValue: 6000 }),
      inst({ securityId: 3, symbol: "ZZC   260320P00045000", isOption: true, optionType: "PUT", quantity: 2, exposure: -3000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "ZZC")!;
    expect(pair.classification).toBe("hedged_long"); // opposing puts exist
    expect(pair.amplifierExposure).toBe(15000);
    expect(pair.hasAmplifiers).toBe(true);
    expect(pair.netExposure).toBe(17000);
  });

  it("classifies long stock + only same-sign calls (no opposing puts) as amplified", () => {
    const r = classifyBook(new Map([group("ZZD", false, [
      inst({ securityId: 1, symbol: "ZZD", exposure: 10000 }),
      inst({ securityId: 2, symbol: "ZZD   260320C00100000", isOption: true, optionType: "CALL", quantity: 5, exposure: 6000, marketValue: 2500 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "ZZD")!;
    expect(pair.classification).toBe("amplified");
    expect(pair.hasAmplifiers).toBe(true);
    expect(pair.offsetCredited).toBe(0);
    expect(pair.netExposure).toBe(16000);
  });

  it("caps offset credit at |core| and spills ETF excess to proxy candidates", () => {
    const r = classifyBook(new Map([group("ZZE", true, [
      inst({ securityId: 1, symbol: "ZZE", exposure: 10000 }),
      inst({ securityId: 2, symbol: "ZZE   260116P00080000", isOption: true, optionType: "PUT", quantity: 10, exposure: -16000, marketValue: 5000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "ZZE")!;
    expect(pair.offsetCredited).toBe(10000);        // capped
    expect(pair.coveragePct).toBeCloseTo(1.0);
    const spill = r.proxyCandidates.find((c) => c.underlying === "ZZE")!;
    expect(spill.protectiveNotional).toBe(6000);    // the excess
    expect(spill.source).toBe("tier1_spill");
  });

  it("routes a short ETF plus same-sign puts entirely to proxy candidates (short-ETF stack case)", () => {
    const r = classifyBook(new Map([group("ZZF", true, [
      inst({ securityId: 1, symbol: "ZZF", quantity: -200, exposure: -15000, marketValue: -15000 }),
      inst({ securityId: 2, symbol: "ZZF   260116P00050000", isOption: true, optionType: "PUT", quantity: 5, exposure: -9000, marketValue: 4000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "ZZF")).toBeUndefined();
    const c = r.proxyCandidates.find((c) => c.underlying === "ZZF")!;
    expect(c.protectiveNotional).toBe(24000);       // short shares + puts
    expect(c.source).toBe("etf_negative_stack");
  });

  it("an ETF written call with no core is not portfolio protection and earns no hedge-book row", () => {
    const longPut = inst({ securityId: 2, symbol: "ZZG   260116P00200000", isOption: true, optionType: "PUT", quantity: 3, exposure: -6000, marketValue: 1500 });
    const writtenCall = inst({ securityId: 3, symbol: "ZZG   260116C00260000", isOption: true, optionType: "CALL", quantity: -2, exposure: -4000, marketValue: -700, thetaPerDay: 30 });
    const r = classifyBook(new Map([group("ZZG", true, [longPut, writtenCall])]));
    const c = r.proxyCandidates.find((c) => c.underlying === "ZZG")!;
    expect(c.source).toBe("no_core_etf");
    expect(c.protectiveNotional).toBe(6000); // long put only
    expect(proxyHedgeInstruments(c)).toEqual([longPut]);
  });

  it("an ETF written call alone with no core credits no protection", () => {
    const r = classifyBook(new Map([group("ZZG", true, [
      inst({ securityId: 3, symbol: "ZZG   260116C00260000", isOption: true, optionType: "CALL", quantity: -2, exposure: -4000, marketValue: -700 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "ZZG")).toBeUndefined();
    // Open-ended risk in a rally: it is a bearish bet, not a vanished leg.
    const bet = r.standaloneBets.find((b) => b.underlying === "ZZG")!;
    expect(bet.kind).toBe("etf_bearish_options");
    expect(bet.exposure).toBe(-4000);
  });

  it("an ETF written call beside a long put with no core is its own bearish bet", () => {
    const writtenCall = inst({ securityId: 3, symbol: "ZZG   260116C00260000", isOption: true, optionType: "CALL", quantity: -1, exposure: -2000, marketValue: -400 });
    const r = classifyBook(new Map([group("ZZG", true, [
      inst({ securityId: 2, symbol: "ZZG   260116P00200000", isOption: true, optionType: "PUT", quantity: 2, exposure: -3000, marketValue: 900 }),
      writtenCall,
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "ZZG")!.protectiveNotional).toBe(3000);
    const bet = r.standaloneBets.find((b) => b.underlying === "ZZG")!;
    expect(bet.kind).toBe("etf_bearish_options");
    expect(bet.instruments).toEqual([writtenCall]);
  });

  it("an ETF written put with no core is subtracted from the long puts' protection", () => {
    const writtenPut = inst({ securityId: 3, symbol: "ZZG   260116P00150000", isOption: true, optionType: "PUT", quantity: -1, exposure: 2000, marketValue: -300 });
    const r = classifyBook(new Map([group("ZZG", true, [
      inst({ securityId: 2, symbol: "ZZG   260116P00200000", isOption: true, optionType: "PUT", quantity: 3, exposure: -6000, marketValue: 1500 }),
      writtenPut,
    ])]));
    const c = r.proxyCandidates.find((c) => c.underlying === "ZZG")!;
    expect(c.protectiveNotional).toBe(4000);
    expect(proxyHedgeInstruments(c)).not.toContain(writtenPut);
    // The written put is netted into the protection row, never a second row.
    expect(c.instruments).toContain(writtenPut);
    expect(r.pairs.find((p) => p.underlying === "ZZG")).toBeUndefined();
  });

  it("an ETF written put larger than the long puts with no core leaves no protection", () => {
    const r = classifyBook(new Map([group("ZZG", true, [
      inst({ securityId: 2, symbol: "ZZG   260116P00200000", isOption: true, optionType: "PUT", quantity: 1, exposure: -2000, marketValue: 500 }),
      inst({ securityId: 3, symbol: "ZZG   260116P00150000", isOption: true, optionType: "PUT", quantity: -3, exposure: 6000, marketValue: -900 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "ZZG")).toBeUndefined();
    // The net-long remainder shows in the speculative row.
    const pair = r.pairs.find((p) => p.underlying === "ZZG")!;
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(4000);
    expect(pair.instruments).toHaveLength(2);
  });

  it("a short ETF stack outweighed by written puts shows its net-long remainder in a row", () => {
    const r = classifyBook(new Map([group("ZZF", true, [
      inst({ securityId: 1, symbol: "ZZF", quantity: -100, exposure: -10000, marketValue: -10000 }),
      inst({ securityId: 2, symbol: "ZZF   260116P00050000", isOption: true, optionType: "PUT", quantity: -10, exposure: 15000, marketValue: -4000 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "ZZF")).toBeUndefined();
    const pair = r.pairs.find((p) => p.underlying === "ZZF")!;
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(5000);
    expect(pair.offsetCredited).toBe(0);
  });

  it("routes ETF puts with no core to proxy candidates", () => {
    const r = classifyBook(new Map([group("ZZG", true, [
      inst({ securityId: 2, symbol: "ZZG   260116P00200000", isOption: true, optionType: "PUT", quantity: 6, exposure: -12000, marketValue: 3500 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "ZZG")!.protectiveNotional).toBe(12000);
  });

  it("classifies single-name puts on non-held stock AND naked single-name shorts as standalone bets", () => {
    const r = classifyBook(new Map([
      group("ZZH", false, [
        inst({ securityId: 2, symbol: "ZZH   260116P00010000", isOption: true, optionType: "PUT", quantity: 10, exposure: -5000, marketValue: 2500 }),
      ]),
      group("ZZI", false, [
        inst({ securityId: 3, symbol: "ZZI", quantity: -30, exposure: -3000, marketValue: -3000 }),
      ]),
    ]));
    expect(r.standaloneBets).toHaveLength(2);
    expect(r.pairs.find((p) => p.underlying === "ZZI")).toBeUndefined();
    expect(r.proxyCandidates).toHaveLength(0);
  });

  it("classifies naked long calls as speculative pairs (risk, never protection)", () => {
    const r = classifyBook(new Map([group("ZZJ", false, [
      inst({ securityId: 2, symbol: "ZZJ   260116C00040000", isOption: true, optionType: "CALL", quantity: 2, exposure: 7000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "ZZJ")!;
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(7000);
  });

  it("classifies plain long stock with no options as unhedged", () => {
    const r = classifyBook(new Map([group("ZZK", false, [
      inst({ securityId: 1, symbol: "ZZK", exposure: 11000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "ZZK")!.classification).toBe("unhedged");
  });
});

function dailySeries(start: string, closes: number[]): Array<{ date: string; close: number }> {
  const out: Array<{ date: string; close: number }> = [];
  const d = new Date(start + "T00:00:00Z");
  for (const close of closes) {
    out.push({ date: d.toISOString().slice(0, 10), close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("classifyBook — every instrument lands in exactly one row", () => {
  // Invariant: for every underlying, the rows classifyBook emits (pairs,
  // standalone bets, proxy candidates) list instruments whose exposure sums
  // to the group's net exposure, no instrument is listed twice, and every
  // standalone bet is net negative.
  // tier1_spill is left out on purpose: it is the excess of a long-core
  // pair's own puts (the same instruments), scored as a fraction of them.
  function rng(seed: number) {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  }

  it("a single-name short outweighed by a written put is net long, not a naked short", () => {
    const r = classifyBook(new Map([group("ZZC", false, [
      inst({ securityId: 1, symbol: "ZZC", quantity: -100, exposure: -10000, marketValue: -10000 }),
      inst({ securityId: 2, symbol: "ZZC   260116P00200000", isOption: true, optionType: "PUT", quantity: -10, exposure: 15000, marketValue: -3000 }),
    ])]));
    expect(r.standaloneBets).toHaveLength(0);
    const pair = r.pairs.find((p) => p.underlying === "ZZC")!;
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(5000);
    expect(pair.offsetCredited).toBe(0);
  });

  it("holds over many generated books", () => {
    const rand = rng(7);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    for (let n = 0; n < 2000; n++) {
      const isEtf = rand() < 0.6;
      const instruments: DefenseInstrument[] = [];
      let id = 1;
      const shares = pick([0, 0, 1]);
      if (shares) {
        const e = pick([-1, 1]) * pick([2000, 5000, 10000, 20000]);
        instruments.push(inst({ securityId: id++, symbol: "ZZX", quantity: Math.sign(e) * 100, exposure: e, marketValue: e }));
      }
      const legs = pick([0, 1, 2, 3, 4]);
      for (let k = 0; k < legs; k++) {
        const type = pick(["PUT", "CALL"] as const);
        const long = rand() < 0.5;
        const size = pick([500, 1000, 2500, 4000, 6000, 15000]);
        // Long put / written call: negative exposure; long call / written put: positive.
        const sign = (type === "PUT") === long ? -1 : 1;
        const deep = type === "CALL" && long && rand() < 0.2;
        instruments.push(inst({
          securityId: id++, symbol: `ZZX OPT${k}`, isOption: true, optionType: type,
          quantity: long ? 1 : -1, exposure: sign * size, marketValue: sign * size,
          ...(deep ? { delta: 0.9, ivSource: "computed" as const } : {}),
        }));
      }
      if (instruments.length === 0) continue;
      const r = classifyBook(new Map([group("ZZX", isEtf, instruments)]));
      const rows = [
        ...r.pairs,
        ...r.standaloneBets,
        ...r.proxyCandidates.filter((c) => c.source !== "tier1_spill"),
      ].filter((row) => row.underlying === "ZZX");
      const listed = rows.flatMap((row) => row.instruments);
      const label = JSON.stringify({ isEtf, legs: instruments.map((i) => [i.optionType, i.quantity, i.exposure]) });
      expect(new Set(listed.map((i) => i.securityId)).size, label).toBe(listed.length);
      expect(sum(listed.map((i) => i.exposure)), label).toBeCloseTo(sum(instruments.map((i) => i.exposure)), 6);
      // A standalone bet is a bearish row: its exposure is always negative.
      for (const bet of r.standaloneBets) expect(bet.exposure, label).toBeLessThan(0);
    }
  });
});

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

describe("computeGapGuardedBeta", () => {
  it("computes ~2.0 beta for a 2x levered series", () => {
    const bench = dailySeries("2026-06-01", [100, 101, 99.9, 101.5, 100.8, 102, 101.2, 103, 102.1, 104]);
    const sec = dailySeries("2026-06-01", bench.map((b, i) => 100 * Math.pow(b.close / 100, 2)));
    const beta = computeGapGuardedBeta(sec, bench.slice());
    expect(beta).not.toBeNull();
    expect(beta!).toBeGreaterThan(1.6);
    expect(beta!).toBeLessThan(2.4);
  });

  it("drops return pairs spanning a >7 calendar-day gap", () => {
    // Two dense clusters separated by a 9-month hole; the cross-gap pair
    // would inject a giant fake return (the NFLX β=-14.31 failure mode).
    const a = dailySeries("2025-06-01", [100, 101, 100.5, 101.2, 100.9, 101.8]);
    const b = dailySeries("2026-03-27", [50, 50.4, 50.1, 50.8, 50.5, 51]).map((r) => ({ ...r }));
    const bench = [...dailySeries("2025-06-01", [400, 402, 401, 403, 402, 404]), ...dailySeries("2026-03-27", [500, 502, 501, 504, 502, 505])];
    const beta = computeGapGuardedBeta([...a, ...b], bench);
    expect(beta).not.toBeNull();
    expect(Math.abs(beta!)).toBeLessThan(5); // sane despite the -50% "day"
  });

  it("returns null with fewer than 6 usable return pairs", () => {
    expect(computeGapGuardedBeta(dailySeries("2026-06-01", [100, 101, 102]), dailySeries("2026-06-01", [400, 401, 402]))).toBeNull();
  });
});

describe("resolveProxyBeta", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("prefers the cached security_betas row", () => {
    db.prepare(`INSERT INTO securities (symbol, name, security_type, source_key) VALUES ('MTUM','MTUM','ETF','t:MTUM')`).run();
    const sid = (db.prepare(`SELECT id FROM securities WHERE symbol='MTUM'`).get() as { id: number }).id;
    db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, 1.42, datetime('now'))`).run(sid);
    expect(resolveProxyBeta(db, "MTUM")).toEqual({ beta: 1.42, source: "cached" });
  });

  it("falls back to assumed 1.0 when nothing is available", () => {
    expect(resolveProxyBeta(db, "ZZZQ")).toEqual({ beta: 1.0, source: "assumed" });
  });

  const SPY_CLOSES = [100, 101, 99.9, 101.5, 100.8, 102, 101.2, 103, 102.1, 104];

  function seedSpyBenchmark() {
    for (const row of dailySeries("2026-06-01", SPY_CLOSES)) {
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`
      ).run(row.date, row.close);
    }
  }

  function insertSecurity(symbol: string): number {
    db.prepare(
      `INSERT INTO securities (symbol, name, security_type, source_key) VALUES (?, ?, 'ETF', ?)`
    ).run(symbol, symbol, `t:${symbol}`);
    return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
  }

  it("computes beta from prices + benchmark_prices when there is no cached row (computed tier)", () => {
    seedSpyBenchmark();
    const sid = insertSecurity("XLE");
    // 2x-levered mover vs SPY (same construction as computeGapGuardedBeta's 2x test).
    const sec = dailySeries("2026-06-01", SPY_CLOSES.map((c) => 100 * Math.pow(c / 100, 2)));
    for (const row of sec) {
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
        sid,
        row.date,
        row.close
      );
    }
    const result = resolveProxyBeta(db, "XLE");
    expect(result.source).toBe("computed");
    expect(result.beta).toBeGreaterThan(1.6);
    expect(result.beta).toBeLessThan(2.4);
  });

  it("prefers the prices-table close over a near-identical (~3bp offset) benchmark_prices duplicate on the same date", () => {
    seedSpyBenchmark();
    const sid = insertSecurity("DIA");
    const clean = dailySeries("2026-06-01", SPY_CLOSES); // clean 1x mover vs SPY
    for (const row of clean) {
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
        sid,
        row.date,
        row.close
      );
    }
    // Same symbol, same dates, near-identical closes (few-bp source discrepancy) in benchmark_prices too.
    for (const row of clean) {
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('DIA', ?, ?, 'tws')`
      ).run(row.date, row.close * 1.0003);
    }
    const result = resolveProxyBeta(db, "DIA");
    expect(result.source).toBe("computed");
    expect(Number.isFinite(result.beta)).toBe(true);
    expect(result.beta).toBeGreaterThan(0.5);
    expect(result.beta).toBeLessThan(1.5);
  });

  it("prefers the prices-table close over a byte-identical benchmark_prices duplicate on the same date", () => {
    seedSpyBenchmark();
    const sid = insertSecurity("DIA");
    const clean = dailySeries("2026-06-01", SPY_CLOSES); // clean 1x mover vs SPY
    for (const row of clean) {
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
        sid,
        row.date,
        row.close
      );
    }
    // Same symbol, same dates, byte-identical closes duplicated into benchmark_prices.
    for (const row of clean) {
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('DIA', ?, ?, 'tws')`
      ).run(row.date, row.close);
    }
    const result = resolveProxyBeta(db, "DIA");
    expect(result.source).toBe("computed");
    expect(Number.isFinite(result.beta)).toBe(true);
    expect(result.beta).toBeGreaterThan(0.5);
    expect(result.beta).toBeLessThan(1.5);
  });
});

function ctx(over: Partial<AttributionContext> = {}): AttributionContext {
  return {
    sectorWeights: new Map(),
    etfGeography: new Map(),
    longExposureBySector: new Map([["Technology", 100000], ["Financials", 40000]]),
    longExposureByGeography: new Map([["Europe", 20000]]),
    tier1CreditedBySector: new Map(),
    totalLongExposure: 200000,
    resolveBeta: () => ({ beta: 1.0, source: "assumed" as const }),
    ...over,
  };
}

function cand(underlying: string, notional: number): ProxyCandidate {
  return { underlying, protectiveNotional: notional, source: "no_core_etf", instruments: [] };
}

describe("attributeProxies — Tier 2 cascade", () => {
  it("routes via cached sector weights and builds sector coverage", () => {
    const r = attributeProxies([cand("IGV", 10000)], ctx({
      sectorWeights: new Map([["IGV", [{ sector: "Technology", weight_pct: 90 }, { sector: "Communication Services", weight_pct: 10 }]]]),
    }));
    expect(r.proxies[0].route).toBe("sector");
    expect(r.proxies[0].creditedTo).toEqual([
      { bucket: "Technology", credited: 9000 },
      { bucket: "Communication Services", credited: 1000 },
    ]);
    const tech = r.sectorCoverage.find((s) => s.sector === "Technology")!;
    expect(tech.longExposure).toBe(100000);
    expect(tech.protected).toBe(9000);
    expect(tech.coveragePct).toBeCloseTo(0.09);
  });

  it("routes country ETFs via geography when no sector weights", () => {
    const r = attributeProxies([cand("EWG", 5000)], ctx({
      etfGeography: new Map([["EWG", "Europe"]]),
    }));
    expect(r.proxies[0].route).toBe("geography");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "Europe", credited: 5000 }]);
  });

  it("falls through to beta route when the ETF's geography isn't held anywhere in the book", () => {
    const r = attributeProxies([cand("EWJ", 5000)], ctx({
      // ctx()'s default longExposureByGeography only has "Europe" — "Japan"
      // is a real geography match on the ETF row, but the book holds none of it.
      etfGeography: new Map([["EWJ", "Japan"]]),
      resolveBeta: () => ({ beta: 0.9, source: "cached" as const }),
    }));
    expect(r.proxies[0].route).toBe("beta");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "book", credited: 4500 }]);
    expect(r.proxies[0].betaSource).toBe("cached");
  });

  it("falls back to beta-weighted broad-book credit and carries the beta source", () => {
    const r = attributeProxies([cand("MTUM", 10000)], ctx({
      resolveBeta: () => ({ beta: 1.2, source: "cached" as const }),
    }));
    expect(r.proxies[0].route).toBe("beta");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "book", credited: 12000 }]);
    expect(r.proxies[0].betaSource).toBe("cached");
  });

  it("includes tier-1 credits in sector coverage", () => {
    const r = attributeProxies([], ctx({
      tier1CreditedBySector: new Map([["Financials", 8000]]),
    }));
    const fin = r.sectorCoverage.find((s) => s.sector === "Financials")!;
    expect(fin.protected).toBe(8000);
    expect(fin.coveragePct).toBeCloseTo(0.2);
  });

  it("surfaces protection credited to a sector the book does not hold (conservation)", () => {
    const r = attributeProxies([cand("IGV", 10000)], ctx({
      sectorWeights: new Map([["IGV", [{ sector: "Technology", weight_pct: 90 }, { sector: "Communication Services", weight_pct: 10 }]]]),
      // ctx()'s default longExposureBySector has Technology + Financials, NOT Communication Services
    }));
    const comm = r.sectorCoverage.find((s) => s.sector === "Communication Services")!;
    expect(comm).toBeDefined();
    expect(comm.longExposure).toBe(0);
    expect(comm.protected).toBe(1000);
    expect(comm.coveragePct).toBeNull();
    const totalShown = r.sectorCoverage.reduce((a, s) => a + s.protected, 0);
    expect(totalShown).toBeCloseTo(10000); // nothing vanished
  });
});

function hedgeInput(over: Partial<DefenseInstrument>, protects = "MSFT", protectedNotional = 10000) {
  return {
    instrument: inst({
      isOption: true,
      optionType: "PUT" as const,
      exposure: -protectedNotional,
      strike: 400,
      underlyingPrice: 500,
      daysToExpiry: 180,
      thetaPerDay: -10,
      delta: -0.3,
      greeksAvailable: true,
      ...over,
    }),
    protects,
    protectedNotional,
  };
}

describe("scoreHedges", () => {
  it("computes bleed, runway, moneyness, efficiency", () => {
    const [s] = scoreHedges([hedgeInput({})]);
    expect(s.monthlyBleedPct).toBeCloseTo((10 * 30) / 10000); // 3%/mo
    expect(s.runwayDays).toBe(180);
    expect(s.moneynessPct).toBeCloseTo((400 - 500) / 500); // -20% = 20% OTM put
    expect(s.efficiency).toBeCloseTo(10000 / 300);
  });

  it("badges: expiring under 30d", () => {
    expect(scoreHedges([hedgeInput({ daysToExpiry: 20 })])[0].badges).toContain("expiring");
  });

  it("badges: decayed when >20% OTM and runway <45d", () => {
    const [s] = scoreHedges([hedgeInput({ daysToExpiry: 40, strike: 350, underlyingPrice: 500 })]);
    expect(s.badges).toContain("decayed");
  });

  it("badges: CALL-side decayed uses unflipped otmPct (strike 30% above spot, runway <45d)", () => {
    const [s] = scoreHedges([
      hedgeInput({ optionType: "CALL", strike: 130, underlyingPrice: 100, daysToExpiry: 30 }),
    ]);
    expect(s.moneynessPct).toBeCloseTo(0.3);
    expect(s.badges).toContain("decayed");
  });

  it("badges: expensive above 3%/mo bleed; deep_itm at |delta| >= 0.8", () => {
    expect(scoreHedges([hedgeInput({ thetaPerDay: -15 })])[0].badges).toContain("expensive");
    expect(scoreHedges([hedgeInput({ delta: -0.85 })])[0].badges).toContain("deep_itm");
  });

  it("excludes fake numbers when Greeks unavailable (share-short proxies score with null carry)", () => {
    const [s] = scoreHedges([hedgeInput({ isOption: false, optionType: null, thetaPerDay: undefined, daysToExpiry: undefined, strike: undefined, delta: undefined, greeksAvailable: false })]);
    expect(s.monthlyBleedPct).toBeNull();
    expect(s.efficiency).toBeNull();
    expect(s.runwayDays).toBeNull();
    expect(s.badges).toEqual([]);
  });

  it("sorts by efficiency ascending with nulls last (close-first candidates on top)", () => {
    const scores = scoreHedges([
      hedgeInput({ thetaPerDay: -30, securityId: 1 }),  // eff ≈ 11.1
      hedgeInput({ thetaPerDay: -5, securityId: 2 }),   // eff ≈ 66.7
      hedgeInput({ isOption: false, optionType: null, thetaPerDay: undefined, greeksAvailable: false, securityId: 3 }),
    ]);
    expect(scores.map((s) => s.securityId)).toEqual([1, 2, 3]);
  });

  it("short-option hedge (positive theta) reports negative bleed = income; no expensive badge; null efficiency", () => {
    const [s] = scoreHedges([hedgeInput({ thetaPerDay: 12 })]);
    expect(s.monthlyBleedPct).not.toBeNull();
    expect(s.monthlyBleedPct!).toBeLessThan(0); // collecting theta, not bleeding it
    expect(s.badges).not.toContain("expensive");
    expect(s.efficiency).toBeNull();
  });

  it("long-option bleed is unchanged by the sign convention (theta −10 → positive cost)", () => {
    const [s] = scoreHedges([hedgeInput({ thetaPerDay: -10 })]);
    expect(s.monthlyBleedPct!).toBeGreaterThan(0);
  });
});
