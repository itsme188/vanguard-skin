import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { detectSourceType } from "@/lib/import/detect";
import { parseImport } from "@/lib/import/engine";
import {
  parseDafContributions,
  etDateFromUtcTimestamp,
} from "@/lib/import/parsers/daf-contributions";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { getSecurityBySymbolCI } from "@/lib/queries/securities";

const FIXTURE_PATH = join(
  process.cwd(),
  "tests/fixtures/daf-contributions-sample.csv"
);
const FIXTURE = readFileSync(FIXTURE_PATH, "utf-8");

describe("detectSourceType — daf-contributions", () => {
  it("detects the 9-column DAF contribution export header", () => {
    expect(detectSourceType(FIXTURE, "contributions-2026.csv")).toBe(
      "daf-contributions"
    );
  });
});

describe("parseDafContributions", () => {
  it("parses 3 donations, skipping the unknown Crypto row with a warning", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");

    expect(result.sourceType).toBe("daf-contributions");
    expect(result.errors).toHaveLength(0);
    expect(result.donations).toHaveLength(3);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Crypto");

    // Other families stay empty — this parser is donations-only.
    expect(result.transactions).toHaveLength(0);
    expect(result.securities).toHaveLength(0);
    expect(result.holdings).toHaveLength(0);
    expect(result.prices).toHaveLength(0);
    expect(result.snapshots).toHaveLength(0);
    expect(result.corporateActions).toHaveLength(0);
  });

  it("row 1 (stock, full data): fields + dates", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");
    const donations = result.donations!;
    const row1 = donations[0];

    expect(row1.kind).toBe("stock");
    expect(row1.symbolRaw).toBe("FAKE");
    expect(row1.quantity).toBe(10);
    expect(row1.fmvUsd).toBe(1234.5);
    expect(row1.unitValuation).toBe(123.45);
    expect(row1.createdDate).toBe("2026-03-01");
    expect(row1.receivedDate).toBe("2026-03-02");
    expect(row1.completedDate).toBe("2026-03-03");
  });

  it("row 2 (stock, blank valuation + blank completed at): nulls", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");
    const donations = result.donations!;
    const row2 = donations[1];

    expect(row2.kind).toBe("stock");
    expect(row2.symbolRaw).toBe("ZZZZ");
    expect(row2.quantity).toBe(5);
    expect(row2.unitValuation).toBeNull();
    expect(row2.completedDate).toBeNull();
  });

  it("row 3 (cash / bank transfer): kind cash, no symbol/quantity", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");
    const donations = result.donations!;
    const row3 = donations[2];

    expect(row3.kind).toBe("cash");
    expect(row3.symbolRaw).toBeNull();
    expect(row3.quantity).toBeNull();
    expect(row3.fmvUsd).toBe(2500);
  });

  it("trims leading whitespace from every cell (row 1 type)", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");
    // If trimming failed, "  Stock" wouldn't match "Stock" and the row would
    // be skipped with an "unrecognized type" warning instead of parsing.
    expect(result.donations![0].kind).toBe("stock");
  });
});

describe("etDateFromUtcTimestamp", () => {
  it("anchors a UTC timestamp to its ET calendar date, crossing midnight", () => {
    // 2026-04-10 01:30 UTC is 2026-04-09 21:30 EDT (UTC-4) — previous ET day.
    expect(etDateFromUtcTimestamp("2026-04-10 01:30:00 +0000")).toBe(
      "2026-04-09"
    );
  });

  it("returns null for an unparsable timestamp", () => {
    expect(etDateFromUtcTimestamp("not-a-date")).toBeNull();
    expect(etDateFromUtcTimestamp("")).toBeNull();
  });
});

describe("parseDafContributions — source keys", () => {
  it("row 1 source key matches the daf:contribution: format exactly", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");
    expect(result.donations![0].sourceKey).toBe(
      "daf:contribution:2026-03-02:FAKE:10:2026-03-01 20:00:00 +0000"
    );
  });

  it("cash row source key uses :USD:<amount>: shape", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");
    expect(result.donations![2].sourceKey).toContain(":USD:2500:");
  });

  it("all source keys are unique within the file", () => {
    const result = parseDafContributions(FIXTURE, "contributions-2026.csv");
    const keys = result.donations!.map((d) => d.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("flags identity-ambiguous rows (missing created-at, colliding date/symbol/qty) with a null-created marker + warning", () => {
    const collidingCsv = [
      "type,frequency,amount,currency,USD amount,currency valuation,created at,received at,completed at",
      "",
      "  Stock,One time,10.0,FAKE,1234.5,123.45,,2026-03-02 13:00:00 +0000,2026-03-03 17:00:00 +0000",
      "  Stock,One time,10.0,FAKE,1234.5,123.45,,2026-03-02 13:00:00 +0000,2026-03-03 17:00:00 +0000",
    ].join("\n");

    const result = parseDafContributions(collidingCsv, "colliding.csv");

    // Both rows are KEPT (not skipped) — the engine blocks them later.
    expect(result.donations).toHaveLength(2);
    for (const d of result.donations!) {
      expect(d.createdAtRaw).toBeNull();
      expect(d.sourceKey).toContain("null-created");
    }
    // Keys still stay unique even in the collision case.
    const keys = result.donations!.map((d) => d.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);

    expect(
      result.warnings.some((w) => w.toLowerCase().includes("identity"))
    ).toBe(true);
  });
});

describe("parseImport dispatch — daf-contributions", () => {
  it("routes the fixture through detectSourceType to parseDafContributions", async () => {
    const result = await parseImport(FIXTURE, "contributions-2026.csv");
    expect(result.sourceType).toBe("daf-contributions");
    expect(result.donations).toHaveLength(3);
  });
});

describe("getSecurityBySymbolCI", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("looks up a security case-insensitively", () => {
    upsertSecurity(db, "FaKe", "Fake Co");
    const found = getSecurityBySymbolCI(db, "fake");
    expect(found).not.toBeNull();
    expect(found!.symbol).toBe("FaKe");
  });

  it("returns null when no security matches", () => {
    expect(getSecurityBySymbolCI(db, "nope")).toBeNull();
  });
});
