// Data Health lists the held options whose underlying has no usable sector.
// Such an option cannot take its underlying's sector, so it is either blank
// or sits in a sector the AI picked. The list is a read: it writes nothing.
//
// All tickers are synthetic (ZZ*) except the GOOG / GOOGL pair, which is the
// repo's own share-class family table entry. All quantities are invented.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getOptionsWithUnsectoredUnderlying } from "@/lib/queries/data-health";

const LIVE = "2099-01-15";
const TODAY = "2026-06-10";
let db: Database.Database;
let acct: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acct = db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
});

function seedSecurity(symbol: string, type: string, sector: string | null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, sector, multiplier) VALUES (?, ?, ?, ?, 1)")
    .run(symbol, symbol, type, sector).lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string | null,
  opts: {
    sector?: string | null;
    sectorSource?: string | null;
    verifiedAt?: string;
    held?: boolean;
    quantity?: number;
    expiry?: string;
  } = {},
): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, sector, sector_source, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'Options', ?, ?, ?, 'CALL', 90, ?, 100)`,
    )
    .run(symbol, symbol, opts.sector ?? null, opts.sectorSource ?? null, underlying, opts.expiry ?? LIVE)
    .lastInsertRowid as number;
  if (opts.verifiedAt) db.prepare("UPDATE securities SET sector_verified_at = ? WHERE id = ?").run(opts.verifiedAt, id);
  if (opts.held !== false) {
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)",
    ).run(acct, id, opts.quantity ?? 1, id);
  }
  return id;
}

function dump() {
  return JSON.stringify({
    securities: db.prepare("SELECT * FROM securities ORDER BY id").all(),
    settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
  });
}

describe("getOptionsWithUnsectoredUnderlying", () => {
  it("is empty when every held option's underlying has a sector", () => {
    seedSecurity("ZZA", "Stock", "Energy");
    seedOption("ZZA 990115C00090000", "ZZA");
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY)).toEqual([]);
  });

  it("lists an option whose underlying is a known security with no sector", () => {
    const fund = seedSecurity("ZZKF", "ETF", null);
    const opt = seedOption("ZZKF 990115C00090000", "ZZKF", { sector: "Technology", sectorSource: "ai_classify" });

    expect(getOptionsWithUnsectoredUnderlying(db, TODAY)).toEqual([
      {
        securityId: opt,
        symbol: "ZZKF 990115C00090000",
        underlyingSymbol: "ZZKF",
        underlyingSecurityId: fund,
        reason: "underlying_no_sector",
        optionSector: "Technology",
        optionSectorOrigin: "ai",
      },
    ]);
  });

  it("lists an option whose underlying is not a security the app knows", () => {
    const opt = seedOption("ZZNO 990115C00090000", "ZZNO");
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY)).toEqual([
      {
        securityId: opt,
        symbol: "ZZNO 990115C00090000",
        underlyingSymbol: "ZZNO",
        underlyingSecurityId: null,
        reason: "underlying_unknown",
        optionSector: null,
        optionSectorOrigin: "blank",
      },
    ]);
  });

  it("lists an option that records no underlying at all", () => {
    seedOption("ZZQ 990115C00090000", null);
    seedOption("ZZR 990115C00090000", "   ");
    const rows = getOptionsWithUnsectoredUnderlying(db, TODAY);
    expect(rows.map((r) => [r.symbol, r.reason, r.underlyingSymbol])).toEqual([
      ["ZZQ 990115C00090000", "no_underlying_recorded", null],
      ["ZZR 990115C00090000", "no_underlying_recorded", null],
    ]);
  });

  it("treats a sector spelling the app rejects as no sector", () => {
    seedSecurity("ZZJ", "Stock", "not-a-sector");
    seedOption("ZZJ 990115C00090000", "ZZJ");
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY).map((r) => r.reason)).toEqual(["underlying_no_sector"]);
  });

  it("does not list an option whose share-class sibling carries the sector", () => {
    seedSecurity("GOOGL", "Stock", null);
    seedSecurity("GOOG", "Stock", "Communication Services");
    seedOption("GOOGL 990115C00090000", "googl");
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY)).toEqual([]);
  });

  it("never treats another option row as the underlying", () => {
    seedOption("ZZOP", "ZZX", { sector: "Energy", held: false });
    seedOption("ZZOP 990115C00090000", "ZZOP");
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY).map((r) => [r.reason, r.underlyingSecurityId])).toEqual([
      ["underlying_unknown", null],
    ]);
  });

  it("leaves out options that are not held, closed, or expired", () => {
    seedOption("ZZNO 990115C00090000", "ZZNO", { held: false });
    seedOption("ZZNO 990115C00095000", "ZZNO", { quantity: 0 });
    seedOption("ZZNO 260515C00090000", "ZZNO", { expiry: "2026-05-15" });
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY)).toEqual([]);
  });

  it("lists a short option, and one held in two accounts once", () => {
    const other = db.prepare("INSERT INTO accounts (name) VALUES ('Other')").run().lastInsertRowid as number;
    const opt = seedOption("ZZNO 990115C00090000", "ZZNO", { quantity: -2 });
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 3, '2026-06-01', 'test:other')",
    ).run(other, opt);
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY).map((r) => r.securityId)).toEqual([opt]);
  });

  it("names how the option got the sector it carries", () => {
    seedOption("ZZNO 990115C00080000", "ZZNO", { sector: "Energy", sectorSource: "underlying_inherited" });
    seedOption("ZZNO 990115C00085000", "ZZNO", { sector: "Energy", sectorSource: "csv_import" });
    seedOption("ZZNO 990115C00090000", "ZZNO", { sector: "Energy", sectorSource: null });
    seedOption("ZZNO 990115C00095000", "ZZNO", {
      sector: "Energy",
      sectorSource: "ai_classify",
      verifiedAt: "2026-05-01 00:00:00",
    });
    seedOption("ZZNO 990115C00099000", "ZZNO", { sector: "  ", sectorSource: "ai_classify" });
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY).map((r) => [r.optionSector, r.optionSectorOrigin])).toEqual([
      ["Energy", "inherited"],
      ["Energy", "protected"],
      ["Energy", "protected"],
      ["Energy", "protected"],
      [null, "blank"],
    ]);
  });

  it("writes nothing: not a sector, not a setting, not on a protected row", () => {
    seedSecurity("ZZKF", "ETF", null);
    seedOption("ZZKF 990115C00090000", "ZZKF", { sector: "Technology", sectorSource: "ai_classify" });
    seedOption("ZZKF 990115C00095000", "ZZKF", { sector: "Energy", sectorSource: "gics_verified" });
    seedOption("ZZNO 990115C00090000", "ZZNO");
    const before = dump();
    expect(getOptionsWithUnsectoredUnderlying(db, TODAY)).toHaveLength(3);
    expect(dump()).toBe(before);
  });
});
