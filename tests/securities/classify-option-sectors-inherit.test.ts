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
  opts: { sector?: string | null; sectorSource?: string | null; held?: boolean; strike?: number } = {},
): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, sector, sector_source, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'Options', ?, ?, ?, 'CALL', ?, ?, 100)`,
    )
    .run(symbol, symbol, opts.sector ?? null, opts.sectorSource ?? null, underlying, opts.strike ?? 90, EXPIRY)
    .lastInsertRowid as number;
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
    expect(res).toEqual({ classified: 1, inherited: 1, errors: [] });
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
    expect(res).toEqual({ classified: 1, inherited: 0, errors: [] });
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
    expect(resolveUnderlyingSector(db, "GOOGL")).toEqual({ securityId: googl, sector: "Technology" });
    db.prepare("UPDATE securities SET sector = NULL WHERE id = ?").run(googl);
    expect(resolveUnderlyingSector(db, "googl")).toEqual({ securityId: goog, sector: "Communication Services" });
  });

  it("the underlying is matched case-insensitively and ignoring padding, and never against another option row", () => {
    const etf = seedSecurity("ZZIX", "ETF", "Diversified");
    seedOption("ZZOP", "ZZIX", { sector: "Technology", held: false }); // an option whose symbol is a bare ticker
    expect(resolveUnderlyingSector(db, " zzix ")).toEqual({ securityId: etf, sector: "Diversified" });
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
    expect(res).toEqual({ classified: 4, inherited: 2, errors: [] });
    expect([row(a).sector, row(b).sector]).toEqual(["Diversified", "Diversified"]);
    expect([row(c).sector, row(d).sector]).toEqual(["Energy", "Energy"]);
  });

  it("never overwrites a sector already stored on an option row, whatever its source", async () => {
    seedSecurity("ZZIX", "ETF", "Diversified");
    const manual = seedOption("ZZIX  990115C00090000", "ZZIX", { sector: "Energy", sectorSource: "csv_import" });
    const legacy = seedOption("ZZIX  990115C00095000", "ZZIX", { sector: "Technology", strike: 95 });
    const blank = seedOption("ZZIX  990115C00100000", "ZZIX", { strike: 100 });

    const res = await classifyOptionSectors(db);

    expect(res.inherited).toBe(1);
    expect(row(manual)).toMatchObject({ sector: "Energy", sector_source: "csv_import" });
    expect(row(legacy)).toMatchObject({ sector: "Technology", sector_source: null });
    expect(row(blank).sector).toBe("Diversified");
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
    expect(await classifyOptionSectors(db)).toEqual({ classified: 0, inherited: 0, errors: [] });
    expect(generateTextMock).not.toHaveBeenCalled();
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

    // Technology holds only its stock: exposure equals market value.
    expect(technology.total_market_value).toBeCloseTo(1_000);
    expect(technology.net_exposure).toBeCloseTo(1_000);
    // Diversified holds the fund plus the call's premium, and the call's
    // (positive, long-call) exposure on top of the fund's own.
    expect(diversified.total_market_value).toBeCloseTo(3_000);
    expect(diversified.net_exposure).toBeGreaterThan(1_000);
    expect(diversified.position_count).toBe(2);
    expect(rows.map((r) => r.group_name).sort()).toEqual(["Diversified", "Technology"]);
  });
});
