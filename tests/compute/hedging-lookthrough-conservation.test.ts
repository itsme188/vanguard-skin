import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { attributeProxies, computeDefenseAnalysis, conserveSectorParts } from "@/lib/compute/hedging";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Review round 2 (2026-11-15), Defense look-through:
//
// X3: a fund whose long CORE is held through call options put all of that
//     option exposure in the underlying's single sector, while the Tier-1
//     credit for a put on the same fund was spread by its look-through
//     weights, so credit landed in sectors with no long exposure. Both sides
//     now spread a fund the same way, keyed by the same family key.
// X4: look-through weights that do not sum to 100 lost the rest of the
//     exposure and of the credit. The remainder now goes to the fund's own
//     sector ("Unknown" when it has none).
//
// Synthetic: ZZE, round figures.

function build(opts: { coreCalls: boolean; weights: Array<[string, number]>; fundSector?: string | null }) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run();
  const acct = (db.prepare("SELECT id FROM accounts WHERE name='Taxable'").get() as { id: number }).id;
  const ins = (sym: string, type: string, sector: string | null) =>
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type, sector, source_key) VALUES (?,?,?,?,?)`)
      .run(sym, sym, type, sector, `t:${sym}`).lastInsertRowid as number;
  const fundSector = opts.fundSector === undefined ? "Technology" : opts.fundSector;
  const etf = ins("ZZE", "ETF", fundSector);
  for (const [s, w] of opts.weights) {
    db.prepare("INSERT INTO etf_sector_weights VALUES ('ZZE',?,?,'2026-06-08','manual')").run(s, w);
  }
  db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-07-01', 'test')").run(etf);
  const expiry = addDays(todayET(), 180);
  const tag = expiry.replace(/-/g, "").slice(2);
  const option = (kind: "C" | "P", strike: number, qty: number, price: number) => {
    const id = db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector)
         VALUES (?, ?, 'Option', 'ZZE', ?, ?, ?, 100, ?)`
      )
      .run(
        `ZZE   ${tag}${kind}${String(strike * 1000).padStart(8, "0")}`,
        `ZZE ${kind}`,
        kind === "C" ? "CALL" : "PUT",
        strike,
        expiry,
        fundSector
      ).lastInsertRowid;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-07-01')"
    ).run(acct, id, qty, qty * price * 100);
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-07-01', 'test')").run(id, price);
  };
  if (opts.coreCalls) option("C", 90, 2, 12);
  else
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 100, 10000, '2026-07-01')"
    ).run(acct, etf);
  option("P", 95, 1, 4);
  return computeDefenseAnalysis(db, [acct]);
}

const bySector = (r: ReturnType<typeof build>) => new Map(r.sectorCoverage.map((s) => [s.sector, s]));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("X3: a fund's call-option core is spread like its shares", () => {
  it("the long side lands in every look-through sector, so credit never lands where there is no long", () => {
    const r = build({ coreCalls: true, weights: [["Technology", 60], ["Financials", 40]] });
    const pair = r.pairs.find((p) => p.underlying === "ZZE")!;
    expect(pair.offsetCredited).toBeGreaterThan(0);
    const s = bySector(r);
    const tech = s.get("Technology")!;
    const fin = s.get("Financials")!;
    expect(fin.longExposure).toBeGreaterThan(0);
    expect(fin.longExposure / (tech.longExposure + fin.longExposure)).toBeCloseTo(0.4, 9);
    // Same weights on both sides: the two sectors are covered equally.
    expect(tech.coveragePct!).toBeCloseTo(fin.coveragePct!, 9);
    for (const row of r.sectorCoverage) {
      if (row.protected > 0) expect(row.longExposure).toBeGreaterThan(0);
    }
  });

  it("total long exposure and total credited protection are each conserved", () => {
    const r = build({ coreCalls: true, weights: [["Technology", 60], ["Financials", 40]] });
    const pair = r.pairs.find((p) => p.underlying === "ZZE")!;
    const longTotal = sum(r.sectorCoverage.map((x) => x.longExposure));
    expect(longTotal).toBeCloseTo(r.summary.longExposure, 6);
    expect(sum(r.sectorCoverage.map((x) => x.protected))).toBeCloseTo(pair.offsetCredited, 6);
  });
});

describe("X4: weights that do not sum to 100 lose nothing", () => {
  it("shares core, weights summing to 80: the 20 goes to the fund's own sector on both sides", () => {
    const r = build({ coreCalls: false, weights: [["Energy", 50], ["Financials", 30]] });
    const pair = r.pairs.find((p) => p.underlying === "ZZE")!;
    const s = bySector(r);
    expect(sum(r.sectorCoverage.map((x) => x.longExposure))).toBeCloseTo(r.summary.longExposure, 6);
    expect(sum(r.sectorCoverage.map((x) => x.protected))).toBeCloseTo(pair.offsetCredited, 6);
    const longTotal = r.summary.longExposure;
    expect(s.get("Technology")!.longExposure / longTotal).toBeCloseTo(0.2, 9);
    expect(s.get("Technology")!.protected / pair.offsetCredited).toBeCloseTo(0.2, 9);
  });

  it("a fund with no sector of its own puts the remainder in Unknown", () => {
    const r = build({ coreCalls: false, weights: [["Energy", 50], ["Financials", 30]], fundSector: null });
    const s = bySector(r);
    expect(s.get("Unknown")!.longExposure / r.summary.longExposure).toBeCloseTo(0.2, 9);
  });

  it("conserveSectorParts: under, exact and over 100", () => {
    expect(conserveSectorParts([{ sector: "A", value: 80 }], 100, "B")).toEqual([
      { sector: "A", value: 80 },
      { sector: "B", value: 20 },
    ]);
    expect(conserveSectorParts([{ sector: "A", value: 80 }], 100, null)).toEqual([
      { sector: "A", value: 80 },
      { sector: "Unknown", value: 20 },
    ]);
    const exact = [{ sector: "A", value: 60 }, { sector: "B", value: 40 }];
    expect(conserveSectorParts(exact, 100, "C")).toBe(exact);
    const over = conserveSectorParts([{ sector: "A", value: 60 }, { sector: "B", value: 60 }], 100, "C");
    expect(sum(over.map((p) => p.value))).toBeCloseTo(100, 9);
    expect(over.map((p) => p.sector)).toEqual(["A", "B"]);
  });

  it("a sector-route proxy credit with short weights is conserved too", () => {
    const { proxies, sectorCoverage } = attributeProxies(
      [{ underlying: "ZZP", protectiveNotional: 1000, instruments: [] } as never],
      {
        sectorWeights: new Map([["ZZP", [{ sector: "Energy", weight_pct: 70 }]]]),
        etfGeography: new Map(),
        longExposureBySector: new Map([["Energy", 5000]]),
        longExposureByGeography: new Map(),
        tier1CreditedBySector: new Map(),
        totalLongExposure: 5000,
        resolveBeta: () => ({ beta: 1, source: "assumed" }) as never,
        ownSectorByUnderlying: new Map([["ZZP", "Industrials"]]),
      }
    );
    expect(sum(proxies[0].creditedTo.map((c) => c.credited))).toBeCloseTo(1000, 9);
    expect(sectorCoverage.find((x) => x.sector === "Industrials")!.protected).toBeCloseTo(300, 9);
  });
});
