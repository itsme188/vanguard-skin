import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  identifyOptionSymbol,
  identityKey,
  findDuplicateGroups,
  planSurvivor,
  planAndMergeGroup,
  type DuplicateGroup,
} from "@/scripts/repair-duplicate-option-securities";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertOption(
  db: Database.Database,
  symbol: string,
  overrides: Partial<{
    name: string | null;
    underlying_symbol: string | null;
    strike_price: number | null;
    expiration_date: string | null;
    option_type: string | null;
    multiplier: number | null;
    currency: string | null;
  }> = {},
): number {
  const result = db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency)
       VALUES (?, ?, 'Option', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      symbol,
      overrides.name ?? null,
      overrides.underlying_symbol ?? null,
      overrides.strike_price ?? null,
      overrides.expiration_date ?? null,
      overrides.option_type ?? null,
      overrides.multiplier ?? null,
      overrides.currency ?? "USD",
    );
  return result.lastInsertRowid as number;
}

function ensureAccount(db: Database.Database, name = "Test Account"): number {
  const existing = db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const result = db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name);
  return result.lastInsertRowid as number;
}

describe("identifyOptionSymbol", () => {
  it("identifies an OCC-form symbol", () => {
    expect(identifyOptionSymbol("NVDA  260618C00175000")).toEqual({
      root: "NVDA",
      expirationDate: "2026-06-18",
      optionType: "CALL",
      strike: 175,
    });
  });

  it("identifies the Vanguard-compact human form", () => {
    expect(identifyOptionSymbol("NVDA 260618 C 175.00")).toEqual({
      root: "NVDA",
      expirationDate: "2026-06-18",
      optionType: "CALL",
      strike: 175,
    });
  });

  it("identifies the IBKR DDMMMYY human form", () => {
    expect(identifyOptionSymbol("NVDA 18JUN26 175 C")).toEqual({
      root: "NVDA",
      expirationDate: "2026-06-18",
      optionType: "CALL",
      strike: 175,
    });
  });

  it("all three spellings of the same contract produce the same identity key", () => {
    const occ = identifyOptionSymbol("NVDA  260618C00175000")!;
    const vanguard = identifyOptionSymbol("NVDA 260618 C 175.00")!;
    const ibkr = identifyOptionSymbol("NVDA 18JUN26 175 C")!;
    expect(identityKey(occ)).toBe(identityKey(vanguard));
    expect(identityKey(occ)).toBe(identityKey(ibkr));
  });

  it("returns null for a plain equity ticker", () => {
    expect(identifyOptionSymbol("AAPL")).toBeNull();
  });

  it("never confuses two DIFFERENT contracts filled the same day (root distinguishes them)", () => {
    const googPut = identifyOptionSymbol("GOOG  260116P00150000")!;
    const spyPut = identifyOptionSymbol("SPY   260116P00150000")!;
    expect(identityKey(googPut)).not.toBe(identityKey(spyPut));
  });
});

describe("findDuplicateGroups", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("groups two spellings of the same contract, ignores singletons", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    insertOption(db, "TSLA  260320P00400000"); // singleton — not a duplicate

    const { groups, unparseable } = findDuplicateGroups(db);
    expect(groups).toHaveLength(1);
    expect(unparseable).toHaveLength(0);
    const ids = groups[0].members.map((m) => m.id).sort((a, b) => a - b);
    expect(ids).toEqual([occId, humanId].sort((a, b) => a - b));
  });

  it("does not merge two different underlyings' options struck the same day/strike", () => {
    insertOption(db, "GOOG  260116P00150000");
    insertOption(db, "SPY   260116P00150000");
    const { groups } = findDuplicateGroups(db);
    expect(groups).toHaveLength(0);
  });

  it("collects unparseable option symbols separately, never as a group", () => {
    insertOption(db, "GARBAGE-NOT-AN-OPTION");
    const { groups, unparseable } = findDuplicateGroups(db);
    expect(groups).toHaveLength(0);
    expect(unparseable).toHaveLength(1);
  });
});

describe("planSurvivor", () => {
  it("picks the already-canonical OCC-spelled member as survivor", () => {
    const group: DuplicateGroup = {
      identity: { root: "AMSC", expirationDate: "2026-01-16", optionType: "CALL", strike: 35 },
      canonicalSymbol: "AMSC  260116C00035000",
      members: [
        {
          id: 10,
          symbol: "AMSC 260116 C 35.00",
          name: null,
          underlying_symbol: null,
          strike_price: null,
          expiration_date: null,
          option_type: null,
          multiplier: null,
          currency: null,
        },
        {
          id: 20,
          symbol: "AMSC  260116C00035000",
          name: null,
          underlying_symbol: null,
          strike_price: null,
          expiration_date: null,
          option_type: null,
          multiplier: null,
          currency: null,
        },
      ],
    };
    const plan = planSurvivor(group);
    expect(plan.survivor.id).toBe(20);
    expect(plan.wouldRename).toBe(false);
    expect(plan.duplicates.map((d) => d.id)).toEqual([10]);
  });

  it("picks the lowest id and flags a rename when no member is canonical", () => {
    const group: DuplicateGroup = {
      identity: { root: "AMSC", expirationDate: "2026-01-16", optionType: "CALL", strike: 35 },
      canonicalSymbol: "AMSC  260116C00035000",
      members: [
        {
          id: 30,
          symbol: "AMSC 260116 C 35.00",
          name: null,
          underlying_symbol: null,
          strike_price: null,
          expiration_date: null,
          option_type: null,
          multiplier: null,
          currency: null,
        },
        {
          id: 15,
          symbol: "AMSC 16JAN26 35 C",
          name: null,
          underlying_symbol: null,
          strike_price: null,
          expiration_date: null,
          option_type: null,
          multiplier: null,
          currency: null,
        },
      ],
    };
    const plan = planSurvivor(group);
    expect(plan.survivor.id).toBe(15);
    expect(plan.wouldRename).toBe(true);
    expect(plan.duplicates.map((d) => d.id)).toEqual([30]);
  });
});

describe("planAndMergeGroup", () => {
  let db: Database.Database;
  let accountId: number;

  beforeEach(() => {
    db = createTestDb();
    accountId = ensureAccount(db);
  });

  function group(occId: number, humanId: number, canonicalSymbol: string): DuplicateGroup {
    const rows = db
      .prepare(
        `SELECT id, symbol, name, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency
         FROM securities WHERE id IN (?, ?)`,
      )
      .all(occId, humanId) as DuplicateGroup["members"];
    return {
      identity: { root: "AMSC", expirationDate: "2026-01-16", optionType: "CALL", strike: 35 },
      canonicalSymbol,
      members: rows,
    };
  }

  it("dry-run reports the plan and writes nothing", () => {
    const occId = insertOption(db, "AMSC  260116C00035000", { name: "OCC name" });
    const humanId = insertOption(db, "AMSC 260116 C 35.00", { name: "Human name" });
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 1, '2026-08-01')",
    ).run(accountId, humanId);

    const g = group(occId, humanId, "AMSC  260116C00035000");
    const report = planAndMergeGroup(db, g, false);

    expect(report.survivorId).toBe(occId);
    expect(report.mergedIds).toEqual([humanId]);

    // Nothing written: duplicate security row and its holding still exist.
    const stillThere = db.prepare("SELECT id FROM securities WHERE id = ?").get(humanId);
    expect(stillThere).toBeDefined();
    const holdingStillPointsAtDup = db
      .prepare("SELECT security_id FROM holdings WHERE account_id = ?")
      .get(accountId) as { security_id: number };
    expect(holdingStillPointsAtDup.security_id).toBe(humanId);
  });

  it("apply: repoints a blanket table (tax_lots) and deletes the duplicate security", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, '2026-01-01', 5, 1, 1, 500)`,
    ).run(accountId, humanId);

    const g = group(occId, humanId, "AMSC  260116C00035000");
    planAndMergeGroup(db, g, true);

    const lot = db.prepare("SELECT security_id FROM tax_lots WHERE account_id = ?").get(accountId) as {
      security_id: number;
    };
    expect(lot.security_id).toBe(occId);
    const dupRow = db.prepare("SELECT id FROM securities WHERE id = ?").get(humanId);
    expect(dupRow).toBeUndefined();
  });

  it("apply: collision-checked table (prices) — no collision repoints normally", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-08-01', 5.5)").run(
      humanId,
    );

    const g = group(occId, humanId, "AMSC  260116C00035000");
    const report = planAndMergeGroup(db, g, true);

    const priceRow = db
      .prepare("SELECT security_id FROM prices WHERE date = '2026-08-01'")
      .get() as { security_id: number };
    expect(priceRow.security_id).toBe(occId);
    const pricesResult = report.tableResults.find((t) => t.table === "prices")!;
    expect(pricesResult.repointed).toBe(1);
    expect(pricesResult.collisions).toBe(0);
  });

  it("apply: collision-checked table (prices) — survivor's row wins, duplicate's colliding row is discarded", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    // Both rows have a price for the SAME date — a genuine collision on
    // the (security_id, date) UNIQUE constraint after repoint.
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-08-01', 5.5)").run(
      occId,
    );
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-08-01', 5.4)").run(
      humanId,
    );

    const g = group(occId, humanId, "AMSC  260116C00035000");
    const report = planAndMergeGroup(db, g, true);

    const allPrices = db.prepare("SELECT security_id, close_price FROM prices").all() as Array<{
      security_id: number;
      close_price: number;
    }>;
    // Only the survivor's original price row remains — duplicate's was discarded.
    expect(allPrices).toHaveLength(1);
    expect(allPrices[0]).toEqual({ security_id: occId, close_price: 5.5 });

    const pricesResult = report.tableResults.find((t) => t.table === "prices")!;
    expect(pricesResult.repointed).toBe(0);
    expect(pricesResult.collisions).toBe(1);
  });

  it("apply: 1:1 table (watchlist) — collision when both survivor and duplicate are already watchlisted", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(occId);
    db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(humanId);

    const g = group(occId, humanId, "AMSC  260116C00035000");
    const report = planAndMergeGroup(db, g, true);

    const rows = db.prepare("SELECT security_id FROM watchlist").all() as Array<{
      security_id: number;
    }>;
    expect(rows).toEqual([{ security_id: occId }]);
    const watchlistResult = report.tableResults.find((t) => t.table === "watchlist")!;
    expect(watchlistResult.collisions).toBe(1);
  });

  it("apply: security_factors — security_id IS the SQLite rowid alias (INTEGER PRIMARY KEY), no separate surrogate id column; repoint still targets the correct row", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    db.prepare(
      "INSERT INTO security_factors (security_id, growth_vs_value) VALUES (?, 'growth')",
    ).run(humanId);

    const g = group(occId, humanId, "AMSC  260116C00035000");
    const report = planAndMergeGroup(db, g, true);

    const rows = db
      .prepare("SELECT security_id, growth_vs_value FROM security_factors")
      .all() as Array<{ security_id: number; growth_vs_value: string }>;
    expect(rows).toEqual([{ security_id: occId, growth_vs_value: "growth" }]);
    const factorsResult = report.tableResults.find((t) => t.table === "security_factors")!;
    expect(factorsResult.repointed).toBe(1);
    expect(factorsResult.collisions).toBe(0);
  });

  it("apply: security_factors — collision when both survivor and duplicate already have a factors row (1:1 PK)", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    db.prepare(
      "INSERT INTO security_factors (security_id, growth_vs_value) VALUES (?, 'value')",
    ).run(occId);
    db.prepare(
      "INSERT INTO security_factors (security_id, growth_vs_value) VALUES (?, 'growth')",
    ).run(humanId);

    const g = group(occId, humanId, "AMSC  260116C00035000");
    const report = planAndMergeGroup(db, g, true);

    const rows = db
      .prepare("SELECT security_id, growth_vs_value FROM security_factors")
      .all() as Array<{ security_id: number; growth_vs_value: string }>;
    // Survivor's own row wins; duplicate's row is discarded, not merged in.
    expect(rows).toEqual([{ security_id: occId, growth_vs_value: "value" }]);
    const factorsResult = report.tableResults.find((t) => t.table === "security_factors")!;
    expect(factorsResult.repointed).toBe(0);
    expect(factorsResult.collisions).toBe(1);
  });

  it("apply: backfills survivor metadata from the duplicate when survivor's field is NULL", () => {
    const occId = insertOption(db, "AMSC  260116C00035000", { multiplier: null, currency: "USD" });
    const humanId = insertOption(db, "AMSC 260116 C 35.00", {
      name: "CALL AMERICAN SUPERCONDUCTOR $35 EXP 01/16/26",
      multiplier: 100,
    });

    const g = group(occId, humanId, "AMSC  260116C00035000");
    planAndMergeGroup(db, g, true);

    const survivor = db
      .prepare("SELECT name, multiplier FROM securities WHERE id = ?")
      .get(occId) as { name: string | null; multiplier: number | null };
    expect(survivor.name).toBe("CALL AMERICAN SUPERCONDUCTOR $35 EXP 01/16/26");
    expect(survivor.multiplier).toBe(100);
  });

  it("apply: renames the survivor to canonical OCC when no member was already canonical", () => {
    const vanguardId = insertOption(db, "AMSC 260116 C 35.00");
    const ibkrId = insertOption(db, "AMSC 16JAN26 35 C");

    const rows = db
      .prepare(
        `SELECT id, symbol, name, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency
         FROM securities WHERE id IN (?, ?) ORDER BY id`,
      )
      .all(vanguardId, ibkrId) as DuplicateGroup["members"];
    const g: DuplicateGroup = {
      identity: { root: "AMSC", expirationDate: "2026-01-16", optionType: "CALL", strike: 35 },
      canonicalSymbol: "AMSC  260116C00035000",
      members: rows,
    };

    const report = planAndMergeGroup(db, g, true);
    expect(report.wouldRename).toBe(true);
    const survivorRow = db
      .prepare("SELECT symbol FROM securities WHERE id = ?")
      .get(report.survivorId) as { symbol: string };
    expect(survivorRow.symbol).toBe("AMSC  260116C00035000");
  });

  it("is idempotent — after apply, a second findDuplicateGroups pass finds nothing for this group", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    const g = group(occId, humanId, "AMSC  260116C00035000");
    planAndMergeGroup(db, g, true);

    const { groups } = findDuplicateGroups(db);
    expect(groups).toHaveLength(0);
  });

  it("apply: updates the denormalized symbol column on trade_roundtrips alongside the FK repoint", () => {
    const occId = insertOption(db, "AMSC  260116C00035000");
    const humanId = insertOption(db, "AMSC 260116 C 35.00");
    const reviewResult = db
      .prepare(
        `INSERT INTO trade_reviews
          (account_id, period_start, period_end, total_trades, winning_trades, losing_trades,
           win_rate, total_realized_pnl, review_markdown)
         VALUES (?, '2026-01-01', '2026-01-31', 1, 1, 0, 1.0, 100, 'test review')`,
      )
      .run(accountId);
    db.prepare(
      `INSERT INTO trade_roundtrips
        (review_id, account_id, security_id, symbol, entry_date, entry_price, entry_quantity, entry_cost,
         exit_date, exit_price, exit_quantity, exit_proceeds, holding_days, realized_pnl, return_pct)
       VALUES (?, ?, ?, ?, '2026-01-01', 5, 1, 500, '2026-01-05', 6, 1, 600, 4, 100, 0.2)`,
    ).run(reviewResult.lastInsertRowid, accountId, humanId, "AMSC 260116 C 35.00");

    const g = group(occId, humanId, "AMSC  260116C00035000");
    planAndMergeGroup(db, g, true);

    const rt = db
      .prepare("SELECT security_id, symbol FROM trade_roundtrips")
      .get() as { security_id: number; symbol: string };
    expect(rt.security_id).toBe(occId);
    expect(rt.symbol).toBe("AMSC  260116C00035000");
  });
});
