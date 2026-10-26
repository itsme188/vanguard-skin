/**
 * Chat portfolio summary vs the side-aware pending read model (plan
 * 2026-10-26 Task 6, R8). A pending long, short or option lot is never a
 * harvesting candidate nor "approaching long-term", and the pending
 * disclosure never adds a cost basis to short-sale proceeds. Synthetic
 * fixtures only; expected states are written by hand.
 *
 * Each exclusion is proven against a POSITIVE CONTROL: the same fixture with
 * the pending index mocked empty must list the lot, so the fixture is shown
 * to be eligible before the real index removes it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { todayET } from "@/lib/calendar/date-utils";
import {
  createPendingTestDb,
  seedHold,
  seedLot,
  seedPx,
  seedSec,
} from "../setup/pending-statement-fixtures";

const hoisted = vi.hoisted(() => ({
  forceEmptyIndex: false,
  mapping: [
    {
      fromSymbol: "ZZRS  270115C00100000",
      toSymbol: "ZZRS  270115C00050000",
      tradeDate: "2026-05-01",
      type: "BUY_TO_OPEN",
      preQty: 1,
      ratio: 2,
    },
  ],
}));

vi.mock("@/lib/securities/option-resymbol-targets", () => ({
  OPTION_RESYMBOL_TARGETS: hoisted.mapping,
  resymbolTargetsFrom: (fromSymbol: string) => hoisted.mapping.filter((t) => t.fromSymbol === fromSymbol),
}));

// Control switch: with it on, the real index is replaced by an empty one.
vi.mock("@/lib/queries/pending-statement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/pending-statement")>();
  return {
    ...actual,
    getPendingStatementIndex: (...args: Parameters<typeof actual.getPendingStatementIndex>) => {
      if (!hoisted.forceEmptyIndex) return actual.getPendingStatementIndex(...args);
      return {
        pairs: [],
        reasonFor: () => null,
        pairReasons: () => [],
        sidesFor: () => [],
      };
    },
  };
});

const IBKR = 3;
let db: Database.Database;

function shift(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function seedOption(symbol: string, underlying: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES (?, ?, 'option', ?, 'CALL', 100, ?, 100)`
      )
      .run(symbol, `${symbol} call`, underlying, shift(90)).lastInsertRowid
  );
}

function section(summary: string, heading: string): string {
  return summary.split(heading)[1]?.split("\n###")[0] ?? "";
}

beforeEach(() => {
  hoisted.forceEmptyIndex = false;
  db = createPendingTestDb();
  const px = shift(-1);

  // Short stock, live data flat -> awaiting_statement. Sold short 10 at 50, now 80: a 300 loss.
  const shortStock = seedSec(db, "ZZSS");
  seedLot(db, IBKR, shortStock, { date: shift(-30), qty: 10, price: 50, isShort: 1 });
  seedHold(db, IBKR, shortStock, px, "live-zero");
  seedPx(db, shortStock, px, 80);

  // Short option, statement zero and no closing trade -> closing_entry_missing.
  // Wrote 2 contracts at 500 a contract (1000 proceeds), now 9 a share: 2 x 100 x 9 = 1800, an 800 loss.
  const shortOption = seedOption("ZZSO  270115C00100000", "ZZSO");
  seedLot(db, IBKR, shortOption, { date: shift(-30), qty: 2, price: 500, isShort: 1 });
  seedHold(db, IBKR, shortOption, px, "stmt-zero");
  seedPx(db, shortOption, px, 9);

  // Re-symbolled short option: flat under the old symbol, the replacement contract is held -> resymbol_repair_pending.
  const oldContract = seedOption("ZZRS  270115C00100000", "ZZRS");
  const newContract = seedOption("ZZRS  270115C00050000", "ZZRS");
  seedLot(db, IBKR, oldContract, { date: shift(-30), qty: 2, price: 500, isShort: 1 });
  seedHold(db, IBKR, oldContract, px, "stmt-zero");
  seedHold(db, IBKR, newContract, px, "tws", -4);
  seedPx(db, oldContract, px, 9);

  // Long stock acquired 340 days ago (inside the 60-day long-term window), 10 at 100, now 50: a 500 loss; live data flat.
  const longStock = seedSec(db, "ZZLA");
  seedLot(db, IBKR, longStock, { date: shift(-340), qty: 10, price: 100 });
  seedHold(db, IBKR, longStock, px, "live-zero");
  seedPx(db, longStock, px, 50);
});

describe("positive controls (the fixture is eligible)", () => {
  it("with the pending index empty, every lot is a harvesting candidate and the long one approaches long-term", () => {
    hoisted.forceEmptyIndex = true;
    const summary = getPortfolioSummaryForChat(db);
    const harvest = section(summary, "### Tax-Loss Harvesting Candidates");
    for (const sym of ["ZZSS", "ZZSO", "ZZRS", "ZZLA"]) expect(harvest).toContain(sym);
    expect(section(summary, "### Lots Approaching Long-Term Status")).toContain("ZZLA");
  });
});

describe("T-NO-HARVEST-SHORT: a pending lot is never harvested nor approaching long-term", () => {
  it("excludes the short stock, the short option, the re-symbolled option and the long stock", () => {
    const summary = getPortfolioSummaryForChat(db);
    const harvest = section(summary, "### Tax-Loss Harvesting Candidates");
    const lt = section(summary, "### Lots Approaching Long-Term Status");
    for (const sym of ["ZZSS", "ZZSO", "ZZRS", "ZZLA"]) {
      expect(harvest).not.toContain(sym);
      expect(lt).not.toContain(sym);
    }
  });
});

describe("pending disclosure lines", () => {
  it("prints one line per (reason, side) with the figure kind of that side", () => {
    const lines = getPortfolioSummaryForChat(db).split("\n");
    // Hand-written: long awaiting = 10 x 100 = 1000 cost; short awaiting = 10 x 50 = 500 proceeds;
    // closing entry missing (short option) = 1000 proceeds; re-symbolled (short option) = 1000 proceeds.
    expect(lines).toContain(
      "- Positions closed per live data, awaiting broker statement: 1 (1 lot, cost basis: $1,000) — not counted as open holdings or unrealized; realized gain unknown until the statement is imported"
    );
    expect(lines).toContain(
      "- Positions closed per live data, awaiting broker statement (short positions): 1 (1 lot, short-sale proceeds: $500) — not counted as open holdings or unrealized; realized gain unknown until the statement is imported"
    );
    expect(lines).toContain(
      "- Positions the broker statement shows closed but with no closing entry in the ledger (short positions): 1 (1 lot, short-sale proceeds: $1,000) — not counted as open holdings or unrealized; realized gain unknown until the closing entry is imported"
    );
    expect(lines).toContain(
      "- Option positions renamed to a new contract after a split, ledger entries not yet moved (short positions): 1 (1 lot, short-sale proceeds: $1,000) — not counted as open holdings or unrealized; realized gain unknown until the entries are moved to the new symbol"
    );
  });

  it("no line prints a long figure plus a short figure as one number", () => {
    const summary = getPortfolioSummaryForChat(db);
    // 1000 (long cost) + 500 (short proceeds) would be 1,500; no pending line may carry it.
    const pendingLines = summary.split("\n").filter((l) => /^- (Positions|Option positions)/.test(l));
    expect(pendingLines).toHaveLength(4);
    for (const l of pendingLines) expect(l).not.toContain("$1,500");
  });

  it("pending lots are not counted as open lots", () => {
    // All four lots are pending, so no ordinary open lot remains.
    expect(getPortfolioSummaryForChat(db)).toContain("- Open lots: 0 ");
  });
});
