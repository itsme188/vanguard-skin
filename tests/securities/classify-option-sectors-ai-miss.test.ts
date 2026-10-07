// An option whose underlying has no usable stored sector is put to the AI. When
// the AI answers and still gives no canonical sector, the question used to be
// paid for again on every sync. The miss is now remembered in the settings
// table; it suppresses only the AI question, never inheritance.
//
// All tickers are synthetic (ZZ*). All quantities are invented. Dates are
// passed in: the real clock is never read.
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
  OPTION_SECTOR_AI_MISSES_KEY,
  OPTION_SECTOR_AI_MISS_RETRY_DAYS,
  OPTION_SECTOR_SOURCE_AI,
  OPTION_SECTOR_SOURCE_INHERITED,
} from "@/lib/securities/classify-option-sectors";

const DAY1 = "2026-03-02";
const DAY2 = "2026-03-03";
let db: Database.Database;
let acct: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acct = db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
});
afterEach(() => generateTextMock.mockReset());

function seedSecurity(symbol: string, sector: string | null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, sector, multiplier) VALUES (?, ?, 'ETF', ?, 1)")
    .run(symbol, symbol, sector).lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  opts: { sector?: string | null; sectorSource?: string | null; verifiedAt?: string } = {},
): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, sector, sector_source, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'Options', ?, ?, ?, 'CALL', 90, '2099-01-15', 100)`,
    )
    .run(symbol, symbol, opts.sector ?? null, opts.sectorSource ?? null, underlying).lastInsertRowid as number;
  if (opts.verifiedAt) db.prepare("UPDATE securities SET sector_verified_at = ? WHERE id = ?").run(opts.verifiedAt, id);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 1, '2026-03-01', 'test:' || ?)",
  ).run(acct, id, id);
  return id;
}

function row(id: number) {
  return db.prepare("SELECT sector, sector_source FROM securities WHERE id = ?").get(id) as {
    sector: string | null;
    sector_source: string | null;
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

function storedMisses(): Record<string, string> | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(OPTION_SECTOR_AI_MISSES_KEY) as
    | { value: string }
    | undefined;
  return r ? (JSON.parse(r.value) as Record<string, string>) : null;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("classifyOptionSectors: a remembered AI miss", () => {
  it("an underlying the AI gave no sector for is asked once, not on every run", async () => {
    aiReplies({}); // the AI answers, with nothing usable for ZZNO
    const opt = seedOption("ZZNO  990115C00090000", "ZZNO");

    await classifyOptionSectors(db, DAY1);
    expect(askedTickers()).toEqual(["ZZNO"]);
    expect(storedMisses()).toEqual({ ZZNO: DAY1 });
    expect(row(opt).sector).toBeNull();

    generateTextMock.mockClear();
    expect(getUnsectoredOptionUnderlyings(db, DAY2)).toEqual([]); // the sync's pre-check finds no work
    expect(await classifyOptionSectors(db, DAY2)).toEqual({ classified: 0, inherited: 0, resynced: 0, errors: [] });
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(storedMisses()).toEqual({ ZZNO: DAY1 }); // the date is not pushed forward
  });

  it("a junk (non-GICS) answer is a miss too", async () => {
    aiReplies({ ZZNO: "Klingon" });
    seedOption("ZZNO  990115C00090000", "ZZNO");

    await classifyOptionSectors(db, DAY1);
    generateTextMock.mockClear();
    await classifyOptionSectors(db, DAY2);

    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("the option takes its underlying's sector, with no AI call, once the underlying has one", async () => {
    aiReplies({});
    const opt = seedOption("ZZNO  990115C00090000", "ZZNO");
    await classifyOptionSectors(db, DAY1);
    generateTextMock.mockClear();

    seedSecurity("ZZNO", "Utilities");

    expect(getUnsectoredOptionUnderlyings(db, DAY2)).toEqual(["ZZNO"]);
    const res = await classifyOptionSectors(db, DAY2);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(res).toEqual({ classified: 1, inherited: 1, resynced: 0, errors: [] });
    expect(row(opt)).toEqual({ sector: "Utilities", sector_source: OPTION_SECTOR_SOURCE_INHERITED });
    expect(storedMisses()).toBeNull(); // finished business is dropped
  });

  it("an underlying that has a row but still no sector stays held back; the sector arriving later is inherited", async () => {
    aiReplies({});
    const opt = seedOption("ZZNO  990115C00090000", "ZZNO");
    const under = seedSecurity("ZZNO", null);
    await classifyOptionSectors(db, DAY1);
    generateTextMock.mockClear();

    await classifyOptionSectors(db, DAY2);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(row(opt).sector).toBeNull();

    db.prepare("UPDATE securities SET sector = 'Energy' WHERE id = ?").run(under);
    await classifyOptionSectors(db, DAY2);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(row(opt).sector).toBe("Energy");
  });

  it("a failed call is not remembered: the next run asks again", async () => {
    generateTextMock.mockRejectedValue(new Error("gateway down"));
    seedOption("ZZNO  990115C00090000", "ZZNO");

    const res = await classifyOptionSectors(db, DAY1);
    expect(res.errors).toEqual(["Batch 1: gateway down"]);
    expect(storedMisses()).toBeNull();

    generateTextMock.mockReset();
    aiReplies({ ZZNO: "Energy" });
    expect(getUnsectoredOptionUnderlyings(db, DAY2)).toEqual(["ZZNO"]);
    await classifyOptionSectors(db, DAY2);
    expect(askedTickers()).toEqual(["ZZNO"]);
  });

  it("a prose reply that cannot be parsed is not remembered", async () => {
    generateTextMock.mockResolvedValue({ text: "I am not able to help with that." });
    seedOption("ZZNO  990115C00090000", "ZZNO");

    const res = await classifyOptionSectors(db, DAY1);

    expect(res.errors).toHaveLength(1);
    expect(storedMisses()).toBeNull();
  });

  it("only the missed ticker is held back: one answered and a new one are handled normally", async () => {
    aiReplies({ ZZOK: "Energy" });
    const ok = seedOption("ZZOK  990115C00090000", "ZZOK");
    seedOption("ZZNO  990115C00090000", "ZZNO");
    await classifyOptionSectors(db, DAY1);
    expect(row(ok)).toEqual({ sector: "Energy", sector_source: OPTION_SECTOR_SOURCE_AI });
    expect(storedMisses()).toEqual({ ZZNO: DAY1 });

    generateTextMock.mockClear();
    aiReplies({ ZZNW: "Materials" });
    const fresh = seedOption("ZZNW  990115C00090000", "ZZNW");
    await classifyOptionSectors(db, DAY2);

    expect(askedTickers()).toEqual(["ZZNW"]);
    expect(row(fresh).sector).toBe("Materials");
    expect(storedMisses()).toEqual({ ZZNO: DAY1 });
  });

  it(`the AI is asked again after ${OPTION_SECTOR_AI_MISS_RETRY_DAYS} days, not before`, async () => {
    aiReplies({});
    const opt = seedOption("ZZNO  990115C00090000", "ZZNO");
    await classifyOptionSectors(db, DAY1);
    generateTextMock.mockClear();

    const lastQuietDay = addDays(DAY1, OPTION_SECTOR_AI_MISS_RETRY_DAYS - 1);
    expect(getUnsectoredOptionUnderlyings(db, lastQuietDay)).toEqual([]);
    await classifyOptionSectors(db, lastQuietDay);
    expect(generateTextMock).not.toHaveBeenCalled();

    aiReplies({ ZZNO: "Energy" });
    const retryDay = addDays(DAY1, OPTION_SECTOR_AI_MISS_RETRY_DAYS);
    expect(getUnsectoredOptionUnderlyings(db, retryDay)).toEqual(["ZZNO"]);
    await classifyOptionSectors(db, retryDay);
    expect(askedTickers()).toEqual(["ZZNO"]);
    expect(row(opt).sector).toBe("Energy");
    expect(storedMisses()).toBeNull();
  });

  it("an unreadable or wrongly shaped memory is treated as no memory", async () => {
    aiReplies({ ZZNO: "Energy" });
    seedOption("ZZNO  990115C00090000", "ZZNO");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(OPTION_SECTOR_AI_MISSES_KEY, "{not json");
    expect(getUnsectoredOptionUnderlyings(db, DAY2)).toEqual(["ZZNO"]);

    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify({ ZZNO: "yesterday", ZZXX: 5 }),
      OPTION_SECTOR_AI_MISSES_KEY,
    );
    expect(getUnsectoredOptionUnderlyings(db, DAY2)).toEqual(["ZZNO"]);

    // A date after "today" is not trusted either.
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify({ ZZNO: "2026-03-09" }),
      OPTION_SECTOR_AI_MISSES_KEY,
    );
    expect(getUnsectoredOptionUnderlyings(db, DAY2)).toEqual(["ZZNO"]);

    await classifyOptionSectors(db, DAY2);
    expect(askedTickers()).toEqual(["ZZNO"]);
  });

  it("a remembered miss never causes a protected or unstamped option sector to be written", async () => {
    aiReplies({});
    const blank = seedOption("ZZNO  990115C00090000", "ZZNO");
    const imported = seedOption("ZZNO  990115C00095000", "ZZNO", { sector: "Financials", sectorSource: "csv_import" });
    const gics = seedOption("ZZNO  990115C00100000", "ZZNO", { sector: "Financials", sectorSource: "gics_verified" });
    const broker = seedOption("ZZNO  990115C00105000", "ZZNO", { sector: "Financials", sectorSource: "tws_bloomberg" });
    const unstamped = seedOption("ZZNO  990115C00110000", "ZZNO", { sector: "Financials" });
    const verified = seedOption("ZZNO  990115C00115000", "ZZNO", {
      sector: "Financials",
      sectorSource: OPTION_SECTOR_SOURCE_AI,
      verifiedAt: "2026-02-01 00:00:00",
    });
    await classifyOptionSectors(db, DAY1);

    seedSecurity("ZZNO", "Utilities");
    await classifyOptionSectors(db, DAY2);

    expect(row(blank).sector).toBe("Utilities");
    for (const id of [imported, gics, broker, unstamped, verified]) expect(row(id).sector).toBe("Financials");
  });
});
