/**
 * scripts/repair-option-sectors.ts: reset an option row's stored sector to
 * its underlying's.
 * [qa:analysis-sector-breakdown--spy-index-options-bucketed-technology-inflates-net-exposure]
 *
 * All tickers are synthetic (ZZ*) except the GOOG / GOOGL pair from the
 * repo's own share-class table; prices and quantities are invented.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { planOptionSectorRepair, runOptionSectorRepair, formatPlan } from "@/scripts/repair-option-sectors";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getOptionExposureMap } from "@/lib/compute/exposure";

const EXPIRY = "2099-01-15";
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, type: string, sector: string | null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, sector, multiplier) VALUES (?, ?, ?, ?, 1)")
    .run(symbol, symbol, type, sector).lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string | null,
  sector: string | null,
  opts: { source?: string | null; verifiedAt?: string | null } = {},
): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, sector, sector_source, sector_verified_at, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'Options', ?, ?, ?, ?, 'CALL', 90, ?, 100)`,
    )
    .run(symbol, symbol, sector, opts.source ?? null, opts.verifiedAt ?? null, underlying, EXPIRY)
    .lastInsertRowid as number;
}

function row(id: number) {
  return db.prepare("SELECT sector, sector_source, sector_verified_at FROM securities WHERE id = ?").get(id) as {
    sector: string | null;
    sector_source: string | null;
    sector_verified_at: string | null;
  };
}

/** Every column of every securities row, to prove nothing else moved. */
function snapshot(exceptIds: number[] = []) {
  const rows = db.prepare("SELECT * FROM securities ORDER BY id").all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    exceptIds.includes(r.id as number) ? { ...r, sector: "*", sector_source: "*" } : r,
  );
}

describe("repair-option-sectors", () => {
  it("a dry run reports the change and writes nothing", () => {
    const etf = seedSecurity("ZZIX", "ETF", "Diversified");
    const opt = seedOption("ZZIX  990115C00090000", "ZZIX", "Technology");
    const before = snapshot();

    const { plan, applied, written } = runOptionSectorRepair(db, {});

    expect(applied).toBe(false);
    expect(written).toBe(0);
    expect(plan.changes).toEqual([
      {
        optionId: opt,
        optionSymbol: "ZZIX  990115C00090000",
        underlyingId: etf,
        underlyingSymbol: "ZZIX",
        fromSector: "Technology",
        toSector: "Diversified",
        fromSource: null,
        toSource: "underlying_inherited",
      },
    ]);
    expect(snapshot()).toEqual(before);
  });

  it("apply corrects a stored wrong sector, and a second run changes nothing", () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const opt = seedOption("ZZIX  990115C00090000", "ZZIX", "Technology");
    const beforeOthers = snapshot([opt]);

    const first = runOptionSectorRepair(db, { apply: true });
    expect(first.applied).toBe(true);
    expect(first.written).toBe(1);
    expect(row(opt)).toEqual({
      sector: "Diversified",
      sector_source: "underlying_inherited",
      sector_verified_at: null,
    });
    // Only the option row's two sector fields moved.
    expect(snapshot([opt])).toEqual(beforeOthers);

    const after = snapshot();
    const second = runOptionSectorRepair(db, { apply: true });
    expect(second.plan.changes).toEqual([]);
    expect(second.plan.alreadyCorrect).toBe(1);
    expect(second.written).toBe(0);
    expect(snapshot()).toEqual(after);
  });

  it("corrects every option on the underlying, including an AI-stamped one and a blank one", () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const legacy = seedOption("ZZIX  990115C00090000", "ZZIX", "Technology");
    const ai = seedOption("ZZIX  990115C00095000", "ZZIX", "Financials", { source: "ai_classify" });
    const blank = seedOption("ZZIX  990115C00100000", "ZZIX", null);
    const right = seedOption("ZZIX  990115C00105000", "ZZIX", "Diversified");

    const { plan, written } = runOptionSectorRepair(db, { apply: true });

    expect(plan.changes.map((c) => c.optionId)).toEqual([legacy, ai, blank]);
    expect(written).toBe(3);
    expect(plan.alreadyCorrect).toBe(1);
    for (const id of [legacy, ai, blank]) expect(row(id).sector).toBe("Diversified");
    // A row that was already right is not touched, not even to stamp a source.
    expect(row(right)).toMatchObject({ sector: "Diversified", sector_source: null });
  });

  it("every provenance value: deliberate and verified rows are skipped with the reason, derived rows are reset", () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const csv = seedOption("ZZIX  990115C00090000", "ZZIX", "Energy", { source: "csv_import" });
    const verified = seedOption("ZZIX  990115C00095000", "ZZIX", "Energy", { source: "gics_verified" });
    const broker = seedOption("ZZIX  990115C00100000", "ZZIX", "Energy", { source: "tws_bloomberg" });
    const unknownSource = seedOption("ZZIX  990115C00105000", "ZZIX", "Energy", { source: "something_new" });
    const stampedOnly = seedOption("ZZIX  990115C00110000", "ZZIX", "Energy", { verifiedAt: "2026-07-28 12:00:00" });
    const stampedAi = seedOption("ZZIX  990115C00115000", "ZZIX", "Energy", {
      source: "ai_classify", verifiedAt: "2026-07-28 12:00:00",
    });
    const ai = seedOption("ZZIX  990115C00120000", "ZZIX", "Energy", { source: "ai_classify" });
    const inherited = seedOption("ZZIX  990115C00125000", "ZZIX", "Energy", { source: "underlying_inherited" });
    const unstamped = seedOption("ZZIX  990115C00130000", "ZZIX", "Energy");
    const protectedIds = [csv, verified, broker, unknownSource, stampedOnly, stampedAi];
    const beforeProtected = protectedIds.map(row);

    const { plan, written } = runOptionSectorRepair(db, { apply: true });

    expect(written).toBe(3);
    expect(plan.changes.map((c) => c.optionId)).toEqual([ai, inherited, unstamped]);
    expect(plan.skippedProtected.map((s) => [s.optionId, s.reason, s.source])).toEqual([
      [csv, "deliberate_source", "csv_import"],
      [verified, "deliberate_source", "gics_verified"],
      [broker, "deliberate_source", "tws_bloomberg"],
      [unknownSource, "deliberate_source", "something_new"],
      [stampedOnly, "verified_stamp", null],
      [stampedAi, "verified_stamp", "ai_classify"],
    ]);
    expect(plan.skippedProtected[0]).toMatchObject({ optionSymbol: "ZZIX  990115C00090000", underlyingSymbol: "ZZIX" });
    expect(protectedIds.map(row)).toEqual(beforeProtected);
    for (const id of [ai, inherited, unstamped]) {
      expect(row(id)).toEqual({ sector: "Diversified", sector_source: "underlying_inherited", sector_verified_at: null });
    }
  });

  it("a failure part-way through an apply leaves no row changed", () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const first = seedOption("ZZIX  990115C00090000", "ZZIX", "Technology");
    const second = seedOption("ZZIX  990115C00095000", "ZZIX", "Technology");
    const third = seedOption("ZZIX  990115C00100000", "ZZIX", "Technology");
    // The database itself refuses the SECOND row's update, after the first was written.
    db.exec(
      `CREATE TRIGGER refuse_second BEFORE UPDATE ON securities WHEN OLD.id = ${second}
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
    );
    const before = snapshot();

    expect(() => runOptionSectorRepair(db, { apply: true })).toThrow(/refused for the test/);

    expect(snapshot()).toEqual(before);
    for (const id of [first, second, third]) expect(row(id)).toMatchObject({ sector: "Technology", sector_source: null });

    // With the obstacle gone the same run completes.
    db.exec("DROP TRIGGER refuse_second");
    expect(runOptionSectorRepair(db, { apply: true }).written).toBe(3);
  });

  it("--include-broker also resets a broker-stamped option sector, and still nothing else", () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const csv = seedOption("ZZIX  990115C00090000", "ZZIX", "Energy", { source: "csv_import" });
    const broker = seedOption("ZZIX  990115C00105000", "ZZIX", "Energy", { source: "tws_bloomberg" });

    const { plan, written } = runOptionSectorRepair(db, { apply: true, includeBroker: true });

    expect(written).toBe(1);
    expect(plan.changes.map((c) => [c.optionId, c.fromSource])).toEqual([[broker, "tws_bloomberg"]]);
    expect(row(broker)).toMatchObject({ sector: "Diversified", sector_source: "underlying_inherited" });
    expect(row(csv)).toMatchObject({ sector: "Energy", sector_source: "csv_import" });
  });

  it("leaves an option alone when its underlying is unknown, sectorless, unnormalizable, or not named", () => {
    seedSecurity("ZZNS", "ETF", null);
    seedSecurity("ZZDM", "Stock", "Communications"); // a demoted vendor bucket: the normalizer returns null
    const unknown = seedOption("ZZNO  990115C00090000", "ZZNO", "Technology");
    const sectorless = seedOption("ZZNS  990115C00090000", "ZZNS", "Technology");
    const demoted = seedOption("ZZDM  990115C00090000", "ZZDM", "Technology");
    const unnamed = seedOption("ZZXX  990115C00090000", null, "Technology");
    const blankName = seedOption("ZZYY  990115C00090000", "  ", "Technology");
    const before = snapshot();

    const { plan, written } = runOptionSectorRepair(db, { apply: true });

    expect(written).toBe(0);
    expect(plan.optionRows).toBe(5);
    expect(plan.underlyingWithoutSector).toBe(3);
    expect(plan.noUnderlyingSymbol).toBe(2);
    expect(snapshot()).toEqual(before);
    for (const id of [unknown, sectorless, demoted, unnamed, blankName]) expect(row(id).sector).toBe("Technology");
  });

  it("inherits the normalized spelling, and from a share-class sibling", () => {
    seedSecurity("ZZHC", "Stock", "Health Care");
    seedSecurity("GOOG", "Stock", "Communication Services");
    const a = seedOption("ZZHC  990115C00090000", "zzhc", "Industrials");
    const b = seedOption("GOOGL 990115C00090000", "GOOGL", "Technology");
    // Already equal to the NORMALIZED underlying sector: nothing to do.
    const c = seedOption("ZZHC  990115C00095000", "ZZHC", "Healthcare");

    const { plan } = runOptionSectorRepair(db, { apply: true });

    expect(plan.changes.map((ch) => ch.optionId)).toEqual([a, b]);
    expect(row(a).sector).toBe("Healthcare");
    expect(row(b).sector).toBe("Communication Services");
    expect(row(c)).toMatchObject({ sector: "Healthcare", sector_source: null });
  });

  it("never changes a row that is not an option, even one that names an underlying", () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const stock = seedSecurity("ZZST", "Stock", "Technology");
    db.prepare("UPDATE securities SET underlying_symbol = 'ZZIX' WHERE id = ?").run(stock);

    const { plan, written } = runOptionSectorRepair(db, { apply: true });

    expect(plan.optionRows).toBe(0);
    expect(written).toBe(0);
    expect(row(stock).sector).toBe("Technology");
  });

  it("the printed plan names each contract and its underlying, and says why a row was skipped", () => {
    seedSecurity("GOOG", "Stock", "Communication Services");
    seedSecurity("ZZIX", "ETF", "Diversified");
    const opt = seedOption("GOOGL 990115C00090000", "GOOGL", "Technology");
    const csv = seedOption("ZZIX  990115C00095000", "ZZIX", "Energy", { source: "csv_import" });
    const broker = seedOption("ZZIX  990115C00100000", "ZZIX", "Energy", { source: "tws_bloomberg" });
    const stamped = seedOption("ZZIX  990115C00105000", "ZZIX", "Energy", { verifiedAt: "2026-07-28 12:00:00" });

    const lines = formatPlan(planOptionSectorRepair(db, {}));
    const line = (needle: string) => lines.find((l) => l.includes(needle))!;

    expect(lines).toContain("would change: 1");
    // The option's own symbol, and the sibling row the sector really comes from.
    expect(line(`option id ${opt} `)).toContain("[GOOGL 990115C00090000]");
    expect(line(`option id ${opt} `)).toContain('"Technology" -> "Communication Services"');
    expect(line(`option id ${opt} `)).toMatch(/underlying id \d+ \[GOOG\]\)/);
    expect(line(`option id ${csv} `)).toMatch(/\[ZZIX {2}990115C00095000\] on \[ZZIX\]: skipped because its sector was set deliberately \(source "csv_import"\)/);
    expect(line(`option id ${broker} `)).toMatch(/stamped by the broker sync .*--include-broker/);
    expect(line(`option id ${stamped} `)).toMatch(/skipped because it carries a sector verification stamp \(source <none>\)/);
  });

  it("after the repair the sector breakdown counts the option in its underlying's bucket", () => {
    const acct = db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
    const hold = (id: number, qty: number, price: number) => {
      db.prepare(
        "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)",
      ).run(acct, id, qty, id);
      db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')").run(id, price);
    };
    hold(seedSecurity("ZZIX", "ETF", "Diversified"), 10, 100); // 1,000
    hold(seedSecurity("ZZTK", "Stock", "Technology"), 10, 100); // 1,000
    const call = seedOption("ZZIX  990115C00090000", "ZZIX", "Technology");
    hold(call, 1, 20); // 2,000 premium

    const bucket = (name: string) => getAllocationByDimension(db, "sector").find((r) => r.group_name === name)!;

    // Before: the stored sector puts the call's premium and exposure in Technology.
    const callExposure = getOptionExposureMap(db).get(call)!;
    expect(callExposure).toBeGreaterThan(5_000); // one contract on a 100-priced fund:
    expect(callExposure).toBeLessThanOrEqual(10_000); // at most 10,000 of notional
    expect(bucket("Technology").total_market_value).toBeCloseTo(3_000);
    expect(bucket("Technology").net_exposure).toBeCloseTo(1_000 + callExposure);
    expect(bucket("Diversified").total_market_value).toBeCloseTo(1_000);
    expect(bucket("Diversified").net_exposure).toBeCloseTo(1_000);

    runOptionSectorRepair(db, { apply: true });

    // After: the same exposure, moved whole into the fund's bucket.
    expect(bucket("Technology").total_market_value).toBeCloseTo(1_000);
    expect(bucket("Technology").percentage).toBeCloseTo(25);
    expect(bucket("Technology").net_exposure).toBeCloseTo(1_000);
    expect(bucket("Diversified").total_market_value).toBeCloseTo(3_000);
    expect(bucket("Diversified").percentage).toBeCloseTo(75);
    expect(bucket("Diversified").net_exposure).toBeCloseTo(1_000 + callExposure);
  });
});
