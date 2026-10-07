// An option takes the stored sector of its underlying; the AI is asked only
// for an option whose underlying is unknown or has no usable sector.
// [qa:analysis-sector-breakdown--spy-index-options-bucketed-technology-inflates-net-exposure]
//
// All tickers are synthetic (ZZ*) except the GOOG / GOOGL pair, which is the
// repo's own share-class family table entry (lib/securities/issuer-family.ts)
// and carries public information only. All prices and quantities are invented.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));

import { runMigrations } from "@/lib/db/migrate";
import {
  classifyOptionSectors,
  getUnsectoredOptionUnderlyings,
  resolveUnderlyingSector,
  OPTION_SECTOR_SOURCE_INHERITED,
  OPTION_SECTOR_SOURCE_AI,
} from "@/lib/securities/classify-option-sectors";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getOptionExposureMap } from "@/lib/compute/exposure";

const EXPIRY = "2099-01-15"; // fixed far-future date: never read the real clock
let db: Database.Database;
let acct: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acct = db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
});
afterEach(() => generateTextMock.mockReset());

function seedSecurity(
  symbol: string,
  type: string,
  sector: string | null,
  extra: { sectorSource?: string | null; fundCategory?: string | null } = {},
): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, sector, sector_source, fund_category, multiplier) VALUES (?, ?, ?, ?, ?, ?, 1)",
    )
    .run(symbol, symbol, type, sector, extra.sectorSource ?? null, extra.fundCategory ?? null)
    .lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  opts: { sector?: string | null; sectorSource?: string | null; held?: boolean; strike?: number; verifiedAt?: string } = {},
): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, sector, sector_source, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'Options', ?, ?, ?, 'CALL', ?, ?, 100)`,
    )
    .run(symbol, symbol, opts.sector ?? null, opts.sectorSource ?? null, underlying, opts.strike ?? 90, EXPIRY)
    .lastInsertRowid as number;
  if (opts.verifiedAt) db.prepare("UPDATE securities SET sector_verified_at = ? WHERE id = ?").run(opts.verifiedAt, id);
  if (opts.held !== false) seedHolding(id, 1);
  return id;
}

function seedHolding(securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)",
  ).run(acct, securityId, quantity, securityId);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')",
  ).run(securityId, price);
}

function row(id: number) {
  return db.prepare("SELECT sector, sector_source, sector_verified_at FROM securities WHERE id = ?").get(id) as {
    sector: string | null;
    sector_source: string | null;
    sector_verified_at: string | null;
  };
}

function aiReplies(map: Record<string, string>) {
  generateTextMock.mockImplementation(async (_feature: string, args: { prompt: string }) => {
    const asked = args.prompt
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2));
    return { text: JSON.stringify(asked.filter((s) => map[s]).map((s) => ({ symbol: s, sector: map[s] }))) };
  });
}

function askedTickers(): string[] {
  return generateTextMock.mock.calls.flatMap((c) =>
    (c[1] as { prompt: string }).prompt
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2)),
  );
}

describe("classifyOptionSectors: an option takes its underlying's sector", () => {
  it("an option on a fund whose sector is Diversified gets Diversified with no AI call", async () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const opt = seedOption("ZZIX  990115C00090000", "ZZIX");

    const res = await classifyOptionSectors(db);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(res).toEqual({ classified: 1, inherited: 1, resynced: 0, errors: [] });
    expect(row(opt)).toEqual({
      sector: "Diversified",
      sector_source: OPTION_SECTOR_SOURCE_INHERITED,
      sector_verified_at: null,
    });
  });

  it("an option whose underlying matches no security row still goes to the AI, stamped as AI-sourced", async () => {
    aiReplies({ ZZNO: "Energy" });
    const opt = seedOption("ZZNO  990115C00090000", "ZZNO");

    const res = await classifyOptionSectors(db);

    expect(askedTickers()).toEqual(["ZZNO"]);
    expect(res).toEqual({ classified: 1, inherited: 0, resynced: 0, errors: [] });
    expect(row(opt)).toMatchObject({ sector: "Energy", sector_source: OPTION_SECTOR_SOURCE_AI });
  });

  it("an underlying that exists but has no sector (NULL or blank) goes to the AI", async () => {
    aiReplies({ ZZNS: "Utilities", ZZBL: "Materials" });
    seedSecurity("ZZNS", "ETF", null);
    seedSecurity("ZZBL", "Stock", "   ");
    const a = seedOption("ZZNS  990115C00090000", "ZZNS");
    const b = seedOption("ZZBL  990115C00090000", "ZZBL");

    const res = await classifyOptionSectors(db);

    expect(askedTickers().sort()).toEqual(["ZZBL", "ZZNS"]);
    expect(res.inherited).toBe(0);
    expect(row(a).sector).toBe("Utilities");
    expect(row(b).sector).toBe("Materials");
  });

  it("an underlying whose sector is a vendor spelling is inherited in its normalized form", async () => {
    seedSecurity("ZZHC", "Stock", "Health Care");
    seedSecurity("ZZIT", "Stock", " information technology ");
    const a = seedOption("ZZHC  990115C00090000", "ZZHC");
    const b = seedOption("ZZIT  990115C00090000", "ZZIT");

    await classifyOptionSectors(db);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(row(a).sector).toBe("Healthcare");
    expect(row(b).sector).toBe("Technology");
  });

  it("an underlying whose sector the normalizer rejects (a demoted vendor bucket) counts as no sector: the AI is asked", async () => {
    aiReplies({ ZZDM: "Consumer Discretionary" });
    seedSecurity("ZZDM", "Stock", "Communications");
    const opt = seedOption("ZZDM  990115C00090000", "ZZDM");

    await classifyOptionSectors(db);

    expect(askedTickers()).toEqual(["ZZDM"]);
    expect(row(opt)).toMatchObject({ sector: "Consumer Discretionary", sector_source: OPTION_SECTOR_SOURCE_AI });
  });

  it("an option on a share-class sibling inherits from the family member that has a sector", async () => {
    seedSecurity("GOOG", "Stock", "Communication Services");
    const opt = seedOption("GOOGL 990115C00090000", "GOOGL");

    await classifyOptionSectors(db);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(row(opt)).toMatchObject({
      sector: "Communication Services",
      sector_source: OPTION_SECTOR_SOURCE_INHERITED,
    });
  });

  it("the exactly matching underlying wins over a sibling, and a sectorless exact match falls through to the sibling", () => {
    const goog = seedSecurity("GOOG", "Stock", "Communication Services");
    const googl = seedSecurity("GOOGL", "Stock", "Technology");
    expect(resolveUnderlyingSector(db, "GOOGL")).toEqual({ securityId: googl, symbol: "GOOGL", sector: "Technology" });
    db.prepare("UPDATE securities SET sector = NULL WHERE id = ?").run(googl);
    expect(resolveUnderlyingSector(db, "googl")).toEqual({ securityId: goog, symbol: "GOOG", sector: "Communication Services" });
  });

  it("the underlying is matched case-insensitively and ignoring padding, and never against another option row", () => {
    const etf = seedSecurity("ZZIX", "ETF", "Diversified");
    seedOption("ZZOP", "ZZIX", { sector: "Technology", held: false }); // an option whose symbol is a bare ticker
    expect(resolveUnderlyingSector(db, " zzix ")).toEqual({ securityId: etf, symbol: "ZZIX", sector: "Diversified" });
    expect(resolveUnderlyingSector(db, "ZZOP")).toBeNull();
    expect(resolveUnderlyingSector(db, "")).toBeNull();
    expect(resolveUnderlyingSector(db, "ZZNO")).toBeNull();
  });

  it("two options on one underlying both inherit; two on an unknown underlying cost one AI question", async () => {
    aiReplies({ ZZNO: "Energy" });
    seedSecurity("ZZIX", "ETF", "Diversified");
    const a = seedOption("ZZIX  990115C00090000", "ZZIX");
    const b = seedOption("ZZIX  990115C00095000", "ZZIX", { strike: 95 });
    const c = seedOption("ZZNO  990115C00090000", "ZZNO");
    const d = seedOption("ZZNO  990115C00095000", "ZZNO", { strike: 95 });

    const res = await classifyOptionSectors(db);

    expect(askedTickers()).toEqual(["ZZNO"]); // the known underlying is never sent
    expect(res).toEqual({ classified: 4, inherited: 2, resynced: 0, errors: [] });
    expect([row(a).sector, row(b).sector]).toEqual(["Diversified", "Diversified"]);
    expect([row(c).sector, row(d).sector]).toEqual(["Energy", "Energy"]);
  });

  it("never overwrites a deliberate or unstamped sector on an option row: every provenance value", async () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const protectedRows: Array<[number, string | null]> = [];
    let strike = 100;
    for (const source of ["csv_import", "gics_verified", "tws_bloomberg", "something_new", null]) {
      strike += 5;
      protectedRows.push([
        seedOption(`ZZIX  990115C00${strike}000`, "ZZIX", { sector: "Energy", sectorSource: source, strike }),
        source,
      ]);
    }
    // A derived stamp is still protected once the row carries a verification stamp.
    const verifiedAi = seedOption("ZZIX  990115C00200000", "ZZIX", {
      sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_AI, verifiedAt: "2026-07-28 12:00:00", strike: 200,
    });
    const verifiedInherited = seedOption("ZZIX  990115C00205000", "ZZIX", {
      sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_INHERITED, verifiedAt: "2026-07-28 12:00:00", strike: 205,
    });
    // The two derived values, unverified, ARE maintained; a blank is filled.
    const ai = seedOption("ZZIX  990115C00210000", "ZZIX", { sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_AI, strike: 210 });
    const inh = seedOption("ZZIX  990115C00215000", "ZZIX", { sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_INHERITED, strike: 215 });
    const blank = seedOption("ZZIX  990115C00220000", "ZZIX", { strike: 220 });

    const res = await classifyOptionSectors(db);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(res).toEqual({ classified: 3, inherited: 1, resynced: 2, errors: [] });
    for (const [id, source] of protectedRows) {
      expect(row(id)).toEqual({ sector: "Energy", sector_source: source, sector_verified_at: null });
    }
    expect(row(verifiedAi)).toMatchObject({ sector: "Energy", sector_source: OPTION_SECTOR_SOURCE_AI });
    expect(row(verifiedInherited)).toMatchObject({ sector: "Energy", sector_source: OPTION_SECTOR_SOURCE_INHERITED });
    for (const id of [ai, inh, blank]) {
      expect(row(id)).toEqual({ sector: "Diversified", sector_source: OPTION_SECTOR_SOURCE_INHERITED, sector_verified_at: null });
    }
  });

  it("inheriting still happens when the AI fails for the unknown underlyings", async () => {
    generateTextMock.mockRejectedValue(new Error("gateway down"));
    seedSecurity("ZZIX", "ETF", "Diversified");
    const known = seedOption("ZZIX  990115C00090000", "ZZIX");
    const unknown = seedOption("ZZNO  990115C00090000", "ZZNO");

    const res = await classifyOptionSectors(db);

    expect(res.inherited).toBe(1);
    expect(res.classified).toBe(1);
    expect(res.errors).toEqual(["Batch 1: gateway down"]);
    expect(row(known).sector).toBe("Diversified");
    expect(row(unknown).sector).toBeNull();
  });

  it("ignores an AI answer for a ticker it was not asked about", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify([
        { symbol: "ZZNO", sector: "Energy" },
        { symbol: "ZZOT", sector: "Utilities" },
      ]),
    });
    const asked = seedOption("ZZNO  990115C00090000", "ZZNO");
    const unheld = seedOption("ZZOT  990115C00090000", "ZZOT", { held: false });

    await classifyOptionSectors(db);

    expect(row(asked).sector).toBe("Energy");
    expect(row(unheld).sector).toBeNull();
  });

  it("is a no-op on a second run and leaves nothing for the sync's pre-check", async () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    seedOption("ZZIX  990115C00090000", "ZZIX");
    await classifyOptionSectors(db);

    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);
    expect(await classifyOptionSectors(db)).toEqual({ classified: 0, inherited: 0, resynced: 0, errors: [] });
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("classifyOptionSectors: a stored derived sector follows its underlying", () => {
  it("a new option sectored by the AI is corrected, with no AI call, once its underlying gets a sector", async () => {
    aiReplies({ ZZNW: "Technology" });
    const opt = seedOption("ZZNW  990115C00090000", "ZZNW");

    // Run 1: the underlying has no row yet, so the AI is asked.
    expect(await classifyOptionSectors(db)).toEqual({ classified: 1, inherited: 0, resynced: 0, errors: [] });
    expect(row(opt)).toMatchObject({ sector: "Technology", sector_source: OPTION_SECTOR_SOURCE_AI });
    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);

    // The underlying's row arrives without a sector: still nothing to do.
    const under = seedSecurity("ZZNW", "Stock", null);
    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);

    // It is then sectored: the pre-check fires and the next run follows it.
    db.prepare("UPDATE securities SET sector = 'Financials' WHERE id = ?").run(under);
    generateTextMock.mockClear();
    expect(getUnsectoredOptionUnderlyings(db)).toEqual(["ZZNW"]);
    expect(await classifyOptionSectors(db)).toEqual({ classified: 1, inherited: 0, resynced: 1, errors: [] });
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(row(opt)).toEqual({
      sector: "Financials",
      sector_source: OPTION_SECTOR_SOURCE_INHERITED,
      sector_verified_at: null,
    });

    // And a further run is a no-op.
    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);
    expect(await classifyOptionSectors(db)).toEqual({ classified: 0, inherited: 0, resynced: 0, errors: [] });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("when the underlying's sector changes, the next run follows it (vendor spelling normalized)", async () => {
    const etf = seedSecurity("ZZIX", "ETF", "Diversified");
    const opt = seedOption("ZZIX  990115C00090000", "ZZIX");
    await classifyOptionSectors(db);
    expect(row(opt).sector).toBe("Diversified");

    db.prepare("UPDATE securities SET sector = 'Health Care' WHERE id = ?").run(etf);

    expect(getUnsectoredOptionUnderlyings(db)).toEqual(["ZZIX"]);
    expect(await classifyOptionSectors(db)).toEqual({ classified: 1, inherited: 0, resynced: 1, errors: [] });
    expect(row(opt)).toMatchObject({ sector: "Healthcare", sector_source: OPTION_SECTOR_SOURCE_INHERITED });
    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("an underlying that loses its sector, or whose sector becomes unnormalizable, does not blank or change the option", async () => {
    const etf = seedSecurity("ZZIX", "ETF", "Diversified");
    const opt = seedOption("ZZIX  990115C00090000", "ZZIX");
    await classifyOptionSectors(db);

    for (const lost of [null, "", "Communications"]) {
      db.prepare("UPDATE securities SET sector = ? WHERE id = ?").run(lost, etf);
      expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);
      expect(await classifyOptionSectors(db)).toEqual({ classified: 0, inherited: 0, resynced: 0, errors: [] });
      expect(row(opt)).toMatchObject({ sector: "Diversified", sector_source: OPTION_SECTOR_SOURCE_INHERITED });
    }
    db.prepare("DELETE FROM securities WHERE id = ?").run(etf);
    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);
    expect(row(opt).sector).toBe("Diversified");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("the pre-check ignores a stale row that is protected, verified or unstamped", () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    let strike = 100;
    for (const source of ["csv_import", "gics_verified", "tws_bloomberg", "something_new", null]) {
      strike += 5;
      seedOption(`ZZIX  990115C00${strike}000`, "ZZIX", { sector: "Energy", sectorSource: source, strike });
    }
    seedOption("ZZIX  990115C00200000", "ZZIX", {
      sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_INHERITED, verifiedAt: "2026-07-28 12:00:00", strike: 200,
    });
    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);
  });

  it("held drives the work list; every option row on a listed underlying is written, held or not", async () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    seedSecurity("ZZOT", "ETF", "Fixed Income");
    // Not held, stale, and no held option on ZZOT needs work: not visited.
    const lonely = seedOption("ZZOT  990115C00090000", "ZZOT", {
      sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_AI, held: false,
    });
    expect(getUnsectoredOptionUnderlyings(db)).toEqual([]);
    expect((await classifyOptionSectors(db)).classified).toBe(0);
    expect(row(lonely).sector).toBe("Energy");

    // A held stale option on ZZIX puts ZZIX on the list; its not-held sibling
    // rows (stale and blank) are written with it.
    const heldStale = seedOption("ZZIX  990115C00090000", "ZZIX", { sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_AI });
    const unheldStale = seedOption("ZZIX  990115C00095000", "ZZIX", {
      sector: "Energy", sectorSource: OPTION_SECTOR_SOURCE_INHERITED, held: false, strike: 95,
    });
    const unheldBlank = seedOption("ZZIX  990115C00100000", "ZZIX", { held: false, strike: 100 });

    expect(getUnsectoredOptionUnderlyings(db)).toEqual(["ZZIX"]);
    expect(await classifyOptionSectors(db)).toEqual({ classified: 3, inherited: 1, resynced: 2, errors: [] });
    for (const id of [heldStale, unheldStale, unheldBlank]) expect(row(id).sector).toBe("Diversified");
    expect(row(lonely).sector).toBe("Energy");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("a resync through a share-class sibling, alongside an unknown underlying that still needs the AI", async () => {
    aiReplies({ ZZNO: "Energy" });
    seedSecurity("GOOG", "Stock", "Communication Services");
    const stale = seedOption("GOOGL 990115C00090000", "GOOGL", { sector: "Technology", sectorSource: OPTION_SECTOR_SOURCE_AI });
    const unknown = seedOption("ZZNO  990115C00090000", "ZZNO");

    expect(getUnsectoredOptionUnderlyings(db)).toEqual(["ZZNO", "GOOGL"]); // blanks first
    expect(await classifyOptionSectors(db)).toEqual({ classified: 2, inherited: 0, resynced: 1, errors: [] });
    expect(askedTickers()).toEqual(["ZZNO"]);
    expect(row(stale)).toMatchObject({ sector: "Communication Services", sector_source: OPTION_SECTOR_SOURCE_INHERITED });
    expect(row(unknown)).toMatchObject({ sector: "Energy", sector_source: OPTION_SECTOR_SOURCE_AI });
  });
});

describe("sector breakdown after classification", () => {
  it("puts an index-fund option's value and delta exposure in the fund's own bucket, not Technology", async () => {
    const etf = seedSecurity("ZZIX", "ETF", "Diversified");
    seedHolding(etf, 10);
    seedPrice(etf, 100); // 1,000 of fund
    const tech = seedSecurity("ZZTK", "Stock", "Technology");
    seedHolding(tech, 10);
    seedPrice(tech, 100); // 1,000 of a technology stock
    const call = seedOption("ZZIX  990115C00090000", "ZZIX");
    seedPrice(call, 20); // 2,000 of premium

    await classifyOptionSectors(db);
    expect(generateTextMock).not.toHaveBeenCalled();

    const rows = getAllocationByDimension(db, "sector");
    const diversified = rows.find((r) => r.group_name === "Diversified")!;
    const technology = rows.find((r) => r.group_name === "Technology")!;

    // The call's delta exposure, from the single-source exposure engine:
    // one contract on a 100-priced fund is at most 10,000 of notional.
    const callExposure = getOptionExposureMap(db).get(call)!;
    expect(callExposure).toBeGreaterThan(5_000);
    expect(callExposure).toBeLessThanOrEqual(10_000);

    // Book: 1,000 fund + 1,000 stock + 2,000 premium = 4,000.
    // Technology holds only its stock: exposure equals market value.
    expect(technology.total_market_value).toBeCloseTo(1_000);
    expect(technology.percentage).toBeCloseTo(25);
    expect(technology.net_exposure).toBeCloseTo(1_000);
    expect(technology.exposure_pct).toBeCloseTo(25);
    expect(technology.position_count).toBe(1);
    // Diversified holds the fund plus the call's premium, and exactly the
    // fund's own exposure plus the call's.
    expect(diversified.total_market_value).toBeCloseTo(3_000);
    expect(diversified.percentage).toBeCloseTo(75);
    expect(diversified.net_exposure).toBeCloseTo(1_000 + callExposure);
    expect(diversified.exposure_pct).toBeCloseTo(((1_000 + callExposure) * 100) / 4_000);
    expect(diversified.position_count).toBe(2);
    expect(rows.map((r) => r.group_name).sort()).toEqual(["Diversified", "Technology"]);
  });
});
