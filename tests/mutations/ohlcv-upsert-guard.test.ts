import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertOhlcvBars } from "@/lib/mutations/ohlcv";
import { getOhlcvBars } from "@/lib/queries/ohlcv";

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: { conId?: number },
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, ?, ?)",
    )
    .run(symbol, symbol + " Corp", "stock", opts?.conId ?? null);
  return result.lastInsertRowid as number;
}

describe("upsertOhlcvBars — write-side corrupt-bar guard", () => {
  let db: Database.Database;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("writes good bars and reports zero rejected when all bars are sane", () => {
    const id = seedSecurity(db, "AAPL", { conId: 265598 });
    const result = upsertOhlcvBars(db, id, "1 day", [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      { date: "2025-02-02", open: 193, high: 198, low: 192, close: 197.0, volume: 1200 },
    ]);
    expect(result.inserted).toBe(2);
    expect(result.rejected).toBe(0);
    expect(getOhlcvBars(db, id, "1 day")).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("accepts a bar with zero volume — thin names print zero volume", () => {
    const id = seedSecurity(db, "THIN", { conId: 1 });
    const result = upsertOhlcvBars(db, id, "1 day", [
      { date: "2025-02-01", open: 10, high: 11, low: 9, close: 10.5, volume: 0 },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it("rejects a bar with low = 0 and close = 0 (the observed live-DB defect)", () => {
    const id = seedSecurity(db, "AAPL", { conId: 265598 });
    const result = upsertOhlcvBars(db, id, "1 day", [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      { date: "2025-02-02", open: 193, high: 198, low: 0, close: 0, volume: 1200 },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.rejected).toBe(1);
    const stored = getOhlcvBars(db, id, "1 day");
    expect(stored).toHaveLength(1);
    expect(stored[0].date).toBe("2025-02-01");
  });

  it("rejects negative prices", () => {
    const id = seedSecurity(db, "NEG", { conId: 2 });
    const result = upsertOhlcvBars(db, id, "1 day", [
      { date: "2025-02-01", open: -190, high: 195, low: 189, close: 193.5, volume: 1000 },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(getOhlcvBars(db, id, "1 day")).toHaveLength(0);
  });

  it("rejects NaN prices", () => {
    const id = seedSecurity(db, "NANBAR", { conId: 3 });
    const result = upsertOhlcvBars(db, id, "1 day", [
      {
        date: "2025-02-01",
        open: 190,
        high: Number.NaN,
        low: 189,
        close: 193.5,
        volume: 1000,
      },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(1);
  });

  it("rejects non-finite (Infinity) prices", () => {
    const id = seedSecurity(db, "INFBAR", { conId: 4 });
    const result = upsertOhlcvBars(db, id, "1 day", [
      {
        date: "2025-02-01",
        open: 190,
        high: Number.POSITIVE_INFINITY,
        low: 189,
        close: 193.5,
        volume: 1000,
      },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(1);
  });

  it("rejects a bar where high < low", () => {
    const id = seedSecurity(db, "INVBAR", { conId: 5 });
    const result = upsertOhlcvBars(db, id, "1 day", [
      { date: "2025-02-01", open: 190, high: 185, low: 189, close: 187, volume: 1000 },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(1);
  });

  it("does not throw on a corrupt bar — one bad row must not abort a batch", () => {
    const id = seedSecurity(db, "BATCH", { conId: 6 });
    expect(() =>
      upsertOhlcvBars(db, id, "1 day", [
        { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
        { date: "2025-02-02", open: 0, high: 0, low: 0, close: 0, volume: 0 },
        { date: "2025-02-03", open: 197, high: 200, low: 196, close: 199.0, volume: 900 },
      ]),
    ).not.toThrow();
  });

  it("warns once per call, not once per rejected row", () => {
    const id = seedSecurity(db, "SPAM", { conId: 7 });
    upsertOhlcvBars(db, id, "1 day", [
      { date: "2025-02-01", open: 0, high: 0, low: 0, close: 0, volume: 0 },
      { date: "2025-02-02", open: 0, high: 0, low: 0, close: 0, volume: 0 },
      { date: "2025-02-03", open: 0, high: 0, low: 0, close: 0, volume: 0 },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns with the symbol/conId, the rejected count, and the first rejected bar's date", () => {
    const id = seedSecurity(db, "WARNSYM", { conId: 424242 });
    upsertOhlcvBars(db, id, "1 day", [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      { date: "2025-02-02", open: 193, high: 198, low: 0, close: 0, volume: 1200 },
      { date: "2025-02-03", open: 0, high: 0, low: 0, close: 0, volume: 0 },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0].join(" ");
    expect(message).toContain("WARNSYM");
    expect(message).toContain("424242");
    expect(message).toContain("2");
    expect(message).toContain("2025-02-02");
  });

  it("re-running the same batch is idempotent (no duplicate rows, same rejected count)", () => {
    const id = seedSecurity(db, "IDEMPOTENT", { conId: 8 });
    const bars = [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      { date: "2025-02-02", open: 193, high: 0, low: 0, close: 0, volume: 1200 },
      { date: "2025-02-03", open: 197, high: 200, low: 196, close: 199.0, volume: 900 },
    ];

    const first = upsertOhlcvBars(db, id, "1 day", bars);
    const second = upsertOhlcvBars(db, id, "1 day", bars);

    expect(first).toEqual(second);
    expect(second.inserted).toBe(2);
    expect(second.rejected).toBe(1);
    expect(getOhlcvBars(db, id, "1 day")).toHaveLength(2);
  });
});
