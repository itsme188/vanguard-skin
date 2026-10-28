/**
 * The chat tax-lot tool (query_tax_lots, open lots) over the pending read
 * model for OPTIONS and SHORTS (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 7; rulings R1, R7; spec
 * docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md §6).
 *
 * Every expected lot state is written by hand next to its fixture (F6); the
 * test first checks the tool agrees with it. Lots are minted by the real
 * engine from ledger rows. Synthetic symbols and small round figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  CLOSING_ENTRY_MISSING_CHAT_NOTE,
  getTaxLotsForChat,
  PENDING_STATEMENT_CHAT_NOTE,
  RESYMBOL_REPAIR_PENDING_CHAT_NOTE,
  SHORT_LOT_CHAT_NOTE,
  SHORT_PENDING_FIGURE_CHAT_NOTE,
  pendingReasonChatNote,
  type TaxLotResult,
} from "@/lib/queries/chat-tools";
import { CHAT_TOOLS } from "@/lib/chat/tools";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";
import { createPendingTestDb, seedHold, seedPx, seedSec } from "../setup/pending-statement-fixtures";

// A synthetic re-symbol mapping replaces the real constant for this file.
const MAPPING = vi.hoisted(() => [
  {
    fromSymbol: "ZQRS  270115C00100000",
    toSymbol: "ZQRS  270115C00050000",
    tradeDate: "2026-05-01",
    type: "BUY_TO_OPEN",
    preQty: 1,
    ratio: 2,
  },
]);
vi.mock("@/lib/securities/option-resymbol-targets", () => ({
  OPTION_RESYMBOL_TARGETS: MAPPING,
  resymbolTargetsFrom: (fromSymbol: string) => MAPPING.filter((t) => t.fromSymbol === fromSymbol),
}));

const ACCT = 3; // IBKR, seeded by the migrations

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createPendingTestDb();
  // Every case runs on a fixed Eastern day (only Date is faked).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T16:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function seedOpt(symbol: string, expiration: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date, currency)
         VALUES (?, ?, 'option', 100, ?, 'USD')`
      )
      .run(symbol, `${symbol} contract`, expiration).lastInsertRowid
  );
}

/** A ledger row with amount NULL, so the engine's dollars are qty x price (x 100 for an option). */
function txn(sec: number, date: string, type: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)`
  ).run(ACCT, sec, date, type, qty, price, `ctpos-${seq++}`);
}

function lot(symbol: string): TaxLotResult {
  const rows = getTaxLotsForChat(db, { symbol });
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("each pending reason has its own note", () => {
  it("awaiting_statement: a long option under a live zero keeps today's note", () => {
    const sec = seedOpt("ZQAW  270115C00010000", "2027-01-15");
    txn(sec, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, ACCT, sec, "2026-10-20", "live-zero");
    seedPx(db, sec, "2026-10-23", 4);
    computeTaxLots(db);
    // Hand: one long lot, 2 contracts, basis 600, pending awaiting_statement.
    expect(lot("ZQAW  270115C00010000")).toMatchObject({
      quantity_remaining: 2,
      cost_basis: 600,
      // No mark for a lot that carries no value (R1); the chat multiplied a
      // shipped mark back into a value (QA finding, 2026-10-28).
      current_price: null,
      current_value: null,
      unrealized_gain: null,
      position_side: "long",
      pending_statement: true,
      pending_statement_reason: "awaiting_statement",
      figure_kind: "cost_basis",
      status_note: PENDING_STATEMENT_CHAT_NOTE,
    });
  });

  it("closing_entry_missing: a short stock under a statement zero", () => {
    const sec = seedSec(db, "ZQCS");
    txn(sec, "2026-05-01", "SHORT_SELL", 10, 100);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    seedPx(db, sec, "2026-10-23", 80);
    computeTaxLots(db);
    // Hand: one short lot, 10 shares, 1000 of short-sale proceeds still open,
    // pending closing_entry_missing; no synthetic close was minted.
    const r = lot("ZQCS");
    expect(r).toMatchObject({
      quantity_remaining: 10,
      cost_basis: 1000,
      current_value: null,
      unrealized_gain: null,
      position_side: "short",
      is_long_term: false,
      long_term_date: null,
      pending_statement: true,
      pending_statement_reason: "closing_entry_missing",
      figure_kind: "short_sale_proceeds",
    });
    expect(r.status_note).toBe(
      `${CLOSING_ENTRY_MISSING_CHAT_NOTE} ${SHORT_PENDING_FIGURE_CHAT_NOTE} ${SHORT_LOT_CHAT_NOTE}`
    );
    expect(r.status_note).not.toMatch(/awaiting the broker statement/i);
  });

  it("resymbol_repair_pending: an old-symbol option whose replacement is held in the same account", () => {
    const old = seedOpt("ZQRS  270115C00100000", "2027-01-15");
    const repl = seedOpt("ZQRS  270115C00050000", "2027-01-15");
    txn(old, "2026-05-01", "BUY_TO_OPEN", 1, 6);
    seedHold(db, ACCT, old, "2026-07-10", "live-zero");
    seedHold(db, ACCT, repl, "2026-07-10", "tws", 2);
    seedPx(db, old, "2026-10-23", 9);
    computeTaxLots(db);
    // Hand: one long lot on the old symbol, basis 600, pending resymbol.
    const r = lot("ZQRS  270115C00100000");
    expect(r).toMatchObject({
      quantity_remaining: 1,
      cost_basis: 600,
      current_value: null,
      unrealized_gain: null,
      pending_statement: true,
      pending_statement_reason: "resymbol_repair_pending",
      figure_kind: "cost_basis",
      status_note: RESYMBOL_REPAIR_PENDING_CHAT_NOTE,
    });
    expect(RESYMBOL_REPAIR_PENDING_CHAT_NOTE).toMatch(/still held under the new contract/i);
    expect(RESYMBOL_REPAIR_PENDING_CHAT_NOTE).toMatch(/do not describe it as closed/i);
    expect(RESYMBOL_REPAIR_PENDING_CHAT_NOTE).not.toMatch(/script/i);
  });

  it("the note function maps every reason, and the awaiting note is unchanged", () => {
    expect(pendingReasonChatNote("awaiting_statement")).toBe(PENDING_STATEMENT_CHAT_NOTE);
    expect(pendingReasonChatNote("closing_entry_missing")).toBe(CLOSING_ENTRY_MISSING_CHAT_NOTE);
    expect(pendingReasonChatNote("resymbol_repair_pending")).toBe(RESYMBOL_REPAIR_PENDING_CHAT_NOTE);
    expect(PENDING_STATEMENT_CHAT_NOTE).toBe(
      "Pending statement: this position was closed per live broker data, awaiting the broker statement for the closing trade. It is not an unrealized holding, and its realized gain is unknown until the statement is imported."
    );
  });
});

describe("a short pending lot", () => {
  it("a short option reports figure_kind short_sale_proceeds, no value, no gain", () => {
    const sec = seedOpt("ZQSO  270115P00020000", "2027-01-15");
    txn(sec, "2026-06-01", "SELL_TO_OPEN", 1, 5);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    seedPx(db, sec, "2026-10-23", 2);
    computeTaxLots(db);
    // Hand: one short lot, 1 contract, 500 of proceeds, closing_entry_missing.
    const r = lot("ZQSO  270115P00020000");
    expect(r).toMatchObject({
      quantity_remaining: 1,
      cost_basis: 500,
      current_value: null,
      unrealized_gain: null,
      position_side: "short",
      pending_statement: true,
      pending_statement_reason: "closing_entry_missing",
      figure_kind: "short_sale_proceeds",
    });
    expect(r.status_note).toContain(SHORT_PENDING_FIGURE_CHAT_NOTE);
  });

  it("control: the same short option still held is valued and keeps its plain short note", () => {
    const sec = seedOpt("ZQSH  270115P00020000", "2027-01-15");
    txn(sec, "2026-06-01", "SELL_TO_OPEN", 1, 5);
    seedHold(db, ACCT, sec, "2026-10-23", "tws", -1);
    seedPx(db, sec, "2026-10-23", 2);
    computeTaxLots(db);
    // Hand: held short, value 200, gain 500 - 200 = 300.
    const r = lot("ZQSH  270115P00020000");
    expect(r).toMatchObject({
      current_value: 200,
      unrealized_gain: 300,
      pending_statement: false,
      pending_statement_reason: null,
      figure_kind: "short_sale_proceeds",
      status_note: SHORT_LOT_CHAT_NOTE,
    });
  });
});

describe("R1 across the expiry boundary in chat", () => {
  // One long and one short option, both expiring 2026-11-20, both flat per
  // live data on 2026-11-10, both priced.
  function seedBoundary(): void {
    const long = seedOpt("ZQXL  261120C00030000", "2026-11-20");
    txn(long, "2026-09-01", "BUY_TO_OPEN", 1, 4);
    seedHold(db, ACCT, long, "2026-11-10", "live-zero");
    seedPx(db, long, "2026-11-10", 1);
    const short = seedOpt("ZQXS  261120P00030000", "2026-11-20");
    txn(short, "2026-09-01", "SELL_TO_OPEN", 1, 4);
    seedHold(db, ACCT, short, "2026-11-10", "live-zero");
    seedPx(db, short, "2026-11-10", 1);
    computeTaxLots(db);
  }

  it("the expiration day: pending, no value, no gain", () => {
    seedBoundary();
    vi.setSystemTime(new Date("2026-11-20T15:00:00Z")); // 10:00 Eastern, 2026-11-20
    for (const symbol of ["ZQXL  261120C00030000", "ZQXS  261120P00030000"]) {
      // Hand: pending awaiting_statement, unvalued.
      const r = lot(symbol);
      expect(r).toMatchObject({
        pending_statement: true,
        pending_statement_reason: "awaiting_statement",
        current_value: null,
        unrealized_gain: null,
      });
      expect(r.status_note).not.toMatch(/Expired option/);
    }
  });

  it("the next Eastern day: expired, not pending, still no value and no gain", () => {
    seedBoundary();
    vi.setSystemTime(new Date("2026-11-21T15:00:00Z")); // 10:00 Eastern, 2026-11-21
    for (const symbol of ["ZQXL  261120C00030000", "ZQXS  261120P00030000"]) {
      // Hand: expired awaiting its closing entry; never also pending.
      const r = lot(symbol);
      expect(r).toMatchObject({
        pending_statement: false,
        pending_statement_reason: null,
        current_value: null,
        unrealized_gain: null,
      });
      expect(r.status_note).toMatch(/Expired option: this contract is past expiration/);
    }
  });

  it("an expired option with a price and no flat evidence is unvalued too; a live one is valued (control)", () => {
    const expired = seedOpt("ZQEX  261016C00030000", "2026-10-16");
    txn(expired, "2026-09-01", "BUY_TO_OPEN", 1, 4);
    seedHold(db, ACCT, expired, "2026-10-15", "tws", 1);
    seedPx(db, expired, "2026-10-15", 2);
    const live = seedOpt("ZQLV  270115C00030000", "2027-01-15");
    txn(live, "2026-09-01", "BUY_TO_OPEN", 1, 4);
    seedHold(db, ACCT, live, "2026-10-23", "tws", 1);
    seedPx(db, live, "2026-10-23", 6);
    computeTaxLots(db);
    // Hand: the expired lot is expired awaiting close (unvalued); the live lot
    // is ordinary open, valued 600 against a 400 basis.
    expect(lot("ZQEX  261016C00030000")).toMatchObject({
      pending_statement: false,
      current_value: null,
      unrealized_gain: null,
    });
    expect(lot("ZQLV  270115C00030000")).toMatchObject({
      pending_statement: false,
      current_value: 600,
      unrealized_gain: 200,
    });
  });
});

describe("tool result hygiene", () => {
  it("no internal join keys leak on pending option and short rows", () => {
    const sec = seedSec(db, "ZQJK");
    txn(sec, "2026-05-01", "SHORT_SELL", 10, 100);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    const opt = seedOpt("ZQJO  270115C00010000", "2027-01-15");
    txn(opt, "2026-06-01", "BUY_TO_OPEN", 1, 3);
    seedHold(db, ACCT, opt, "2026-10-20", "live-zero");
    computeTaxLots(db);
    const rows = getTaxLotsForChat(db, { status: "open" });
    expect(rows).toHaveLength(2);
    for (const row of rows as unknown as Array<Record<string, unknown>>) {
      expect(row.pending_statement).toBe(true);
      expect(row).not.toHaveProperty("account_id");
      expect(row).not.toHaveProperty("security_id");
      expect(row).not.toHaveProperty("is_short");
    }
  });
});

describe("tool text and system prompt", () => {
  it("the tax-lot tool names the reason field, its three values and the figure kind", () => {
    const tool = CHAT_TOOLS.find((t) => t.name === "query_tax_lots")!;
    for (const needle of [
      "pending_statement_reason",
      "awaiting_statement",
      "closing_entry_missing",
      "resymbol_repair_pending",
      "figure_kind",
      "short_sale_proceeds",
    ]) {
      expect(tool.description).toContain(needle);
    }
    expect(tool.description).toMatch(/never call it closed/i);
  });

  it("the holdings tool says a re-symbolled option is never called closed", () => {
    const tool = CHAT_TOOLS.find((t) => t.name === "query_holdings")!;
    expect(tool.description).toMatch(/re-symbolled option is still held under its new contract; never call it closed/);
  });

  it("the system prompt covers options and shorts, each reason and the proceeds reading", () => {
    const prompt = buildSystemPrompt("## Portfolio Summary\n- Test data", "2026-10-26", "all");
    const line = prompt.split("\n").find((l) => l.includes("pending_statement = true"));
    expect(line).toBeDefined();
    expect(line).toMatch(/options/);
    expect(line).toMatch(/short/);
    for (const reason of ["awaiting_statement", "closing_entry_missing", "resymbol_repair_pending"]) {
      expect(line).toContain(reason);
    }
    expect(line).toMatch(/still held under the new contract \(never call it closed/);
    expect(line).toMatch(/short-sale proceeds/);
  });
});
