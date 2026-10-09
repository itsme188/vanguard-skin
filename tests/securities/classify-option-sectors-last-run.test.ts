// The sector run leaves a time behind, so the Analysis trust strip can say
// when option sectors were last CHECKED: found in line with their
// underlyings, or brought in line. classifyOptionSectors writes it on any run
// that finished without an error; markOptionSectorsChecked writes the same
// key for a caller whose pre-check found nothing to do. An AI error never
// moves it.
//
// All tickers are synthetic (ZZ*). All quantities are invented.
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
  getLastSectorClassifyRun,
  getUnsectoredOptionUnderlyings,
  markOptionSectorsChecked,
  SECTOR_CLASSIFY_LAST_RUN_KEY,
} from "@/lib/securities/classify-option-sectors";

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

function seedSecurity(symbol: string, type: string, sector: string | null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, sector, multiplier) VALUES (?, ?, ?, ?, 1)")
    .run(symbol, symbol, type, sector).lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  opts: { sector?: string | null; sectorSource?: string | null } = {},
): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, sector, sector_source, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'Options', ?, ?, ?, 'CALL', 90, ?, 100)`,
    )
    .run(symbol, symbol, opts.sector ?? null, opts.sectorSource ?? null, underlying, EXPIRY)
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 1, '2026-06-01', 'test:' || ?)",
  ).run(acct, id, id);
  return id;
}

function stampRow() {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(SECTOR_CLASSIFY_LAST_RUN_KEY) as
    | { value: string }
    | undefined;
}

describe("classifyOptionSectors: the last-run time", () => {
  it("is absent before any run", () => {
    expect(getLastSectorClassifyRun(db)).toBeNull();
  });

  it("is written when a run with work finished without an error", async () => {
    seedSecurity("ZZA", "Stock", "Energy");
    seedOption("ZZA 990115C00090000", "ZZA");

    const res = await classifyOptionSectors(db);
    expect(res.classified).toBe(1);
    expect(res.errors).toEqual([]);

    const at = getLastSectorClassifyRun(db);
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Stored the way SQLite prints a time, so datetime() reads it back unchanged.
    const same = db.prepare("SELECT datetime(?) = ? AS same").get(at, at) as { same: number };
    expect(same.same).toBe(1);
  });

  it("is written by a run that finds nothing to do: that is a clean check", async () => {
    seedSecurity("ZZA", "Stock", "Energy");
    const opt = seedOption("ZZA 990115C00090000", "ZZA", { sector: "Energy", sectorSource: "underlying_inherited" });

    const res = await classifyOptionSectors(db);
    expect(res).toEqual({ classified: 0, inherited: 0, resynced: 0, errors: [] });
    expect(getLastSectorClassifyRun(db)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The check wrote the time and nothing else.
    expect(db.prepare("SELECT sector, sector_source FROM securities WHERE id = ?").get(opt)).toEqual({
      sector: "Energy",
      sector_source: "underlying_inherited",
    });
    expect(db.prepare("SELECT key FROM settings WHERE key LIKE '%sector%' ORDER BY key").all()).toEqual([
      { key: SECTOR_CLASSIFY_LAST_RUN_KEY },
    ]);
  });

  it("is written with no options at all in the book", async () => {
    await classifyOptionSectors(db);
    expect(stampRow()).toBeDefined();
  });

  it("moves forward when a later run finds nothing to do", async () => {
    seedSecurity("ZZA", "Stock", "Energy");
    seedOption("ZZA 990115C00090000", "ZZA");
    await classifyOptionSectors(db);
    // Pretend the first run was a while ago.
    db.prepare("UPDATE settings SET value = '2026-01-05 10:00:00' WHERE key = ?").run(SECTOR_CLASSIFY_LAST_RUN_KEY);

    await classifyOptionSectors(db);
    const at = getLastSectorClassifyRun(db) as string;
    const later = db.prepare("SELECT datetime(?) > datetime('2026-01-05 10:00:00') AS later").get(at) as {
      later: number;
    };
    expect(later.later).toBe(1);
  });

  it("is not written when the AI call fails: the run did not finish", async () => {
    seedOption("ZZB 990115C00090000", "ZZB"); // unknown underlying: the AI is asked
    generateTextMock.mockRejectedValue(new Error("network down"));

    const res = await classifyOptionSectors(db);
    expect(res.errors).toHaveLength(1);
    expect(stampRow()).toBeUndefined();
  });

  it("does not move when a later run hits an AI error", async () => {
    seedSecurity("ZZA", "Stock", "Energy");
    seedOption("ZZA 990115C00090000", "ZZA");
    await classifyOptionSectors(db);
    db.prepare("UPDATE settings SET value = '2026-01-05 10:00:00' WHERE key = ?").run(SECTOR_CLASSIFY_LAST_RUN_KEY);

    seedOption("ZZB 990115C00090000", "ZZB");
    generateTextMock.mockRejectedValue(new Error("network down"));
    const res = await classifyOptionSectors(db);
    expect(res.errors).toHaveLength(1);
    expect(getLastSectorClassifyRun(db)).toBe("2026-01-05 10:00:00");
  });

  it("is written while the only open question is a remembered AI miss: the check still ran clean", async () => {
    seedOption("ZZB 990115C00090000", "ZZB");
    generateTextMock.mockResolvedValue({ text: "[]" }); // the AI answers, with no sector

    await classifyOptionSectors(db, "2026-06-01");
    expect(stampRow()).toBeDefined();
    db.prepare("UPDATE settings SET value = '2026-01-05 10:00:00' WHERE key = ?").run(SECTOR_CLASSIFY_LAST_RUN_KEY);

    // Next day: the miss is remembered, nothing is asked. The callers'
    // pre-check sees no work here, and both paths record the check.
    generateTextMock.mockClear();
    expect(getUnsectoredOptionUnderlyings(db, "2026-06-02")).toEqual([]);
    await classifyOptionSectors(db, "2026-06-02");
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(getLastSectorClassifyRun(db)).not.toBe("2026-01-05 10:00:00");
  });

  it("markOptionSectorsChecked writes the same key, and only the time", () => {
    seedSecurity("ZZA", "Stock", null);
    const blank = seedOption("ZZA 990115C00090000", "ZZA");
    const kept = seedOption("ZZA 990115C00095000", "ZZA", { sector: "Energy", sectorSource: "gics_verified" });
    const before = JSON.stringify(db.prepare("SELECT * FROM securities ORDER BY id").all());

    expect(getLastSectorClassifyRun(db)).toBeNull();
    markOptionSectorsChecked(db);
    expect(getLastSectorClassifyRun(db)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(JSON.stringify(db.prepare("SELECT * FROM securities ORDER BY id").all())).toBe(before);
    expect(blank).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);

    // A second call replaces the one row; it never adds another.
    db.prepare("UPDATE settings SET value = '2026-01-05 10:00:00' WHERE key = ?").run(SECTOR_CLASSIFY_LAST_RUN_KEY);
    markOptionSectorsChecked(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = ?").get(SECTOR_CLASSIFY_LAST_RUN_KEY)).toEqual({ n: 1 });
    expect(getLastSectorClassifyRun(db)).not.toBe("2026-01-05 10:00:00");
  });

  it("reads an unparseable stored value as no time at all", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, 'not a time')").run(SECTOR_CLASSIFY_LAST_RUN_KEY);
    expect(getLastSectorClassifyRun(db)).toBeNull();
  });

  it("normalizes a T-separated stored value through datetime()", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, '2026-01-05T10:00:00Z')").run(
      SECTOR_CLASSIFY_LAST_RUN_KEY,
    );
    expect(getLastSectorClassifyRun(db)).toBe("2026-01-05 10:00:00");
  });
});
