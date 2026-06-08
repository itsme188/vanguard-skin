import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  parseNasdaqEps,
  mapNasdaqTime,
  fetchNasdaqEarningsForSymbols,
  type NasdaqApiRow,
} from "@/lib/calendar/nasdaq";

describe("parseNasdaqEps", () => {
  it("parses parenthesised negatives and plain positives", () => {
    expect(parseNasdaqEps("($0.44)")).toBeCloseTo(-0.44);
    expect(parseNasdaqEps("$0.12")).toBeCloseTo(0.12);
    expect(parseNasdaqEps("1.50")).toBeCloseTo(1.5);
  });
  it("returns null for empty / non-numeric", () => {
    expect(parseNasdaqEps("")).toBeNull();
    expect(parseNasdaqEps("N/A")).toBeNull();
    expect(parseNasdaqEps(undefined)).toBeNull();
  });
});

describe("mapNasdaqTime", () => {
  it("maps Nasdaq time tokens to bmo/amc/null", () => {
    expect(mapNasdaqTime("time-pre-market")).toBe("bmo");
    expect(mapNasdaqTime("time-after-hours")).toBe("amc");
    expect(mapNasdaqTime("time-not-supplied")).toBeNull();
    expect(mapNasdaqTime(undefined)).toBeNull();
  });
});

describe("fetchNasdaqEarningsForSymbols", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('RBRK','Rubrik','stock','equity',1)",
    ).run();
  });

  function dayStub(byDate: Record<string, NasdaqApiRow[]>) {
    return async (date: string) => byDate[date] ?? [];
  }

  it("returns only held/watchlist symbols, as earnings CalendarEventInput", async () => {
    const stub = dayStub({
      "2026-06-04": [
        { symbol: "RBRK", time: "time-after-hours", epsForecast: "($0.44)", eps: "($0.19)" },
        { symbol: "ZZZZ", time: "time-pre-market", epsForecast: "$1.00", eps: "" }, // not held
      ],
    });

    const events = await fetchNasdaqEarningsForSymbols(
      db,
      ["RBRK"],
      "2026-06-04",
      "2026-06-04",
      "2026-06-01",
      { fetchDay: stub },
    );

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.source).toBe("nasdaq");
    expect(e.event_type).toBe("earnings");
    expect(e.symbol).toBe("RBRK");
    expect(e.event_date).toBe("2026-06-04");
    expect(e.source_key).toBe("nasdaq:RBRK:2026-06-04");
    expect(e.consensus_estimate).toContain("EPS -0.44");
    expect(e.security_id).not.toBeNull(); // linked to the seeded RBRK security
    // hour rides in raw_json.entry.hour so resolveReleaseTime can map it (AMC).
    expect(JSON.parse(e.raw_json!).entry.hour).toBe("amc");
  });

  it("scans every trading day in the window (skips weekends)", async () => {
    const seen: string[] = [];
    const stub = async (date: string) => {
      seen.push(date);
      return [] as NasdaqApiRow[];
    };
    // Thu 2026-06-04 .. Wed 2026-06-10 → skips Sat 6/6 + Sun 6/7.
    await fetchNasdaqEarningsForSymbols(db, ["RBRK"], "2026-06-04", "2026-06-10", "2026-06-08", {
      fetchDay: stub,
    });
    expect(seen).toEqual([
      "2026-06-04",
      "2026-06-05",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
    ]);
  });

  it("degrades gracefully when a day fetch fails (null)", async () => {
    const stub = async (date: string) =>
      date === "2026-06-04"
        ? null // simulated fetch failure
        : [{ symbol: "RBRK", time: "time-after-hours", epsForecast: "$0.10", eps: "" }];
    const events = await fetchNasdaqEarningsForSymbols(
      db,
      ["RBRK"],
      "2026-06-04",
      "2026-06-05",
      "2026-06-01",
      { fetchDay: stub },
    );
    expect(events).toHaveLength(1);
    expect(events[0].event_date).toBe("2026-06-05");
  });

  it("returns [] when no symbols are requested", async () => {
    const events = await fetchNasdaqEarningsForSymbols(db, [], "2026-06-04", "2026-06-04", "2026-06-01", {
      fetchDay: dayStub({}),
    });
    expect(events).toEqual([]);
  });
});
