/**
 * T-DISCLOSURE: three-way parity of the pending disclosure (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 12, moved here from Task 6 by ruling R10):
 *   1. the Tax Lots summary (`getTaxLotSummary(...).pendingStatement`),
 *   2. the reducer over the page's narrowed lot rows (the page builds its
 *      inputs from `getOpenTaxLots` exactly as below), and
 *   3. the chat summary's pending lines (`getPortfolioSummaryForChat`)
 * give the same rows, counts and figures, for the whole book and for one
 * account, and none carries a cross-side dollar sum. The expected rows are
 * written by hand from the shared seed's table.
 *
 * Also here (review additions):
 *   (a) the read model's hand-copied `open_figure` formula
 *       (lib/queries/pending-statement.ts, written out to avoid an import
 *       cycle) is pinned numerically to `remainingLotBasisSql()`
 *       (lib/queries/tax-lots.ts): long and short lots, capitalized fees,
 *       partial sales, a non-USD currency;
 *   (b) per lot, the Tax Lots rows and the chat tax-lot tool agree on the
 *       pending flag, the reason, the figure and the figure kind. The two
 *       figure-kind FIELDS differ on purpose and are not equated: Tax Lots'
 *       `pending_figure_kind` is null unless the lot is pending, while
 *       chat's `figure_kind` is set on every open lot (it also labels a held
 *       short's figure). The kind is compared for pending lots only.
 *
 * Synthetic symbols and small round numbers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";

const MAPPING = vi.hoisted(() => [
  {
    fromSymbol: "ZZRS  270115C00100000",
    toSymbol: "ZZRS  270115C00050000",
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

import { computeTaxLots } from "@/lib/compute/tax-lots";
import { formatUSD } from "@/lib/format";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import {
  reducePendingDisclosure,
  type PendingDisclosureInput,
  type PendingDisclosureRow,
} from "@/lib/queries/pending-statement-types";
import {
  getOpenTaxLots,
  getTaxLotSummary,
  isCurrencyConversionTaxLot,
  remainingLotBasisSql,
  type TaxLotWithSecurity,
} from "@/lib/queries/tax-lots";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { getTaxLotsForChat, type TaxLotResult } from "@/lib/queries/chat-tools";
import { buildSeed, insertSecurity, insertTxn, SEED_NOW, SEED_TODAY } from "../setup/pending-options-shorts-seed";
import { createPendingTestDb, seedHold } from "../setup/pending-statement-fixtures";

const OPTS = { today: SEED_TODAY };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SEED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Row = Pick<PendingDisclosureRow, "reason" | "side" | "positions" | "lots" | "figure" | "figureKind">;
const row = (
  reason: Row["reason"],
  side: Row["side"],
  positions: number,
  lots: number,
  figure: number
): Row => ({ reason, side, positions, lots, figure, figureKind: side === "short" ? "short_sale_proceeds" : "cost_basis" });

/** Hand-written from SEED_TABLE and the seed's ledger. */
const EXPECTED: Record<"book" | "ibkr" | "taxable", Row[]> = {
  book: [
    row("awaiting_statement", "long", 2, 2, 900), // ZZLC 400 + ZZUB 500
    row("awaiting_statement", "short", 2, 2, 800), // ZZSB 500 + ZZTD 300
    row("closing_entry_missing", "long", 1, 1, 600), // ZZLD
    row("closing_entry_missing", "short", 2, 2, 900), // ZZTC 500 + ZZSC 400
    row("resymbol_repair_pending", "long", 1, 1, 800), // ZZRS
  ],
  ibkr: [
    row("awaiting_statement", "long", 2, 2, 900),
    row("awaiting_statement", "short", 1, 1, 500),
    row("closing_entry_missing", "short", 1, 1, 500),
    row("resymbol_repair_pending", "long", 1, 1, 800),
  ],
  taxable: [
    row("awaiting_statement", "short", 1, 1, 300),
    row("closing_entry_missing", "long", 1, 1, 600),
    row("closing_entry_missing", "short", 1, 1, 400),
  ],
};

function accountName(db: Database.Database, id: number): string {
  return (db.prepare("SELECT name FROM accounts WHERE id = ?").get(id) as { name: string }).name;
}

/** The page's own construction (app/dashboard/tax-lots/page.tsx): narrowed capital lots → reducer inputs. */
function pageRows(lots: TaxLotWithSecurity[], account?: string): PendingDisclosureRow[] {
  const narrowed = account ? lots.filter((l) => l.account_name === account) : lots;
  const inputs: PendingDisclosureInput[] = narrowed
    .filter((l) => !isCurrencyConversionTaxLot(l))
    .filter((l) => l.pending_statement)
    .flatMap((l) =>
      l.pending_statement_reason
        ? [
            {
              account_id: l.account_id,
              security_id: l.security_id,
              is_short: l.is_short,
              reason: l.pending_statement_reason,
              lotCount: 1,
              figure: l.adjusted_cost_basis,
            },
          ]
        : []
    );
  return reducePendingDisclosure(inputs);
}

/** The chat summary's line for one reducer row (the words, then the figures). */
function expectedChatFragment(r: Row): string {
  const words = r.figureKind === "short_sale_proceeds" ? "short-sale proceeds" : "cost basis";
  return `${r.positions} (${r.lots} lot${r.lots === 1 ? "" : "s"}, ${words}: ${formatUSD(r.figure)})`;
}
const CHAT_LEAD: Record<Row["reason"], string> = {
  awaiting_statement: "- Positions closed per live data, awaiting broker statement",
  closing_entry_missing: "- Positions the broker statement shows closed but with no closing entry in the ledger",
  resymbol_repair_pending: "- Option positions renamed to a new contract after a split, ledger entries not yet moved",
};

function chatPendingLines(text: string): string[] {
  return text.split("\n").filter((l) => l.includes("not counted as open holdings or unrealized"));
}

function expectRows(got: readonly PendingDisclosureRow[], expected: Row[]) {
  expect(got.map((r) => [r.reason, r.side, r.positions, r.lots, r.figureKind])).toEqual(
    expected.map((r) => [r.reason, r.side, r.positions, r.lots, r.figureKind])
  );
  got.forEach((r, i) => expect(Math.abs(r.figure - expected[i].figure)).toBeLessThan(1e-9));
}

function expectChat(text: string, expected: Row[]) {
  const lines = chatPendingLines(text);
  expect(lines).toHaveLength(expected.length);
  expected.forEach((r, i) => {
    expect(lines[i].startsWith(CHAT_LEAD[r.reason])).toBe(true);
    expect(lines[i].includes("(short positions)")).toBe(r.side === "short");
    expect(lines[i]).toContain(expectedChatFragment(r));
  });
}

/** No field is a total, and no figure equals a long + short sum of one reason. */
function expectNoCrossSideSum(rows: readonly PendingDisclosureRow[]) {
  for (const r of rows) expect(Object.keys(r).sort()).toEqual(["figure", "figureKind", "lots", "positions", "reason", "side"]);
  for (const reason of new Set(rows.map((r) => r.reason))) {
    const long = rows.find((r) => r.reason === reason && r.side === "long");
    const short = rows.find((r) => r.reason === reason && r.side === "short");
    if (long && short) {
      for (const r of rows) expect(Math.abs(r.figure - (long.figure + short.figure))).toBeGreaterThan(1e-9);
    }
  }
}

describe("T-DISCLOSURE: Tax Lots summary, the page reducer and the chat summary agree", () => {
  it("whole book: all three give the hand-written rows", () => {
    const { db } = buildSeed();
    const summary = getTaxLotSummary(db, undefined, OPTS).pendingStatement;
    const page = pageRows(getOpenTaxLots(db, undefined, OPTS));
    expectRows(summary, EXPECTED.book);
    expectRows(page, EXPECTED.book);
    expect(page).toEqual(summary);
    expectChat(getPortfolioSummaryForChat(db), EXPECTED.book);
    expectNoCrossSideSum(summary);
    expectNoCrossSideSum(page);
  });

  it.each([
    ["ibkr", 3],
    ["taxable", 1],
  ] as const)("one account (%s): the page's narrowed reducer and the chat summary give the hand-written rows", (key, id) => {
    const { db } = buildSeed();
    const name = accountName(db, id);
    const page = pageRows(getOpenTaxLots(db, undefined, OPTS), name);
    expectRows(page, EXPECTED[key]);
    expectChat(getPortfolioSummaryForChat(db, name), EXPECTED[key]);
    expectNoCrossSideSum(page);
  });

  it("the read model's own pairs reduce to the same rows (the index's figures are the lots' figures)", () => {
    const { db } = buildSeed();
    const fromPairs = reducePendingDisclosure(
      getPendingStatementPairs(db, undefined, OPTS).map((p) => ({
        account_id: p.account_id,
        security_id: p.security_id,
        is_short: p.side === "short" ? 1 : 0,
        reason: p.reason,
        lotCount: p.lot_count,
        figure: p.open_figure,
      }))
    );
    expectRows(fromPairs, EXPECTED.book);
  });
});

describe("(b) per lot: the Tax Lots rows and the chat tax-lot tool agree for pending lots", () => {
  it("pending flag, reason, figure and figure kind match; the two figure-kind fields are NOT equated for held lots", () => {
    const { db } = buildSeed();
    const tl = getOpenTaxLots(db, undefined, OPTS);
    const chat = getTaxLotsForChat(db, { status: "open", limit: 500 });
    const find = (l: TaxLotWithSecurity): TaxLotResult => {
      const hits = chat.filter(
        (c) =>
          c.account_name === l.account_name &&
          c.symbol === l.symbol &&
          c.acquisition_date === l.acquisition_date &&
          c.quantity_remaining === l.quantity_remaining
      );
      expect(hits).toHaveLength(1);
      return hits[0];
    };
    let pendingSeen = 0;
    let heldShortSeen = 0;
    for (const l of tl) {
      const c = find(l);
      expect([l.symbol, c.pending_statement]).toEqual([l.symbol, l.pending_statement]);
      expect([l.symbol, c.pending_statement_reason]).toEqual([l.symbol, l.pending_statement_reason]);
      expect(Math.abs(c.cost_basis - l.adjusted_cost_basis)).toBeLessThan(1e-9);
      if (l.pending_statement) {
        pendingSeen += 1;
        // Figure kind: compared for pending lots only.
        expect([l.symbol, c.figure_kind]).toEqual([l.symbol, l.pending_figure_kind]);
        expect([c.current_value, c.unrealized_gain, l.current_value, l.unrealized_gain]).toEqual([null, null, null, null]);
      } else {
        // Documented difference, not a parity: Tax Lots says nothing about a
        // held lot's figure kind; chat labels every open lot by its side.
        expect(l.pending_figure_kind).toBeNull();
        expect(c.figure_kind).toBe(l.is_short === 1 ? "short_sale_proceeds" : "cost_basis");
        if (l.is_short === 1) heldShortSeen += 1;
      }
    }
    expect(pendingSeen).toBe(8);
    expect(heldShortSeen).toBe(3); // ZZSA, ZZTA, ZZTB
  });
});

describe("(a) open_figure is pinned to remainingLotBasisSql (the hand-copied formula)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createPendingTestDb();
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('CAD', 0.75, '2026-10-23', 'test')").run();
    const t = (a: number, s: number, d: string, type: string, q: number, p: number, fees: number) =>
      insertTxn(db, a, s, d, type, q, p, { fees });

    // Long stock, USD: two buys with fees, a sale that takes all of the first and 2 of the second.
    let s = insertSecurity(db, "ZZQL");
    t(3, s, "2026-06-01", "BUY", 10, 100, 5);
    t(3, s, "2026-06-02", "BUY", 5, 120, 3);
    t(3, s, "2026-06-10", "SELL", 12, 130, 2);
    seedHold(db, 3, s, "2026-07-10", "live-zero");
    // Short stock, USD: fees net out of the stored proceeds; a partial cover.
    s = insertSecurity(db, "ZZQS");
    t(3, s, "2026-06-01", "SHORT_SELL", 10, 50, 5);
    t(3, s, "2026-06-10", "BUY_TO_COVER", 4, 40, 1);
    seedHold(db, 3, s, "2026-07-10", "live-zero");
    // Long stock, CAD: fees, a partial sale.
    s = insertSecurity(db, "ZZQC", { currency: "CAD" });
    t(3, s, "2026-06-01", "BUY", 10, 100, 4);
    t(3, s, "2026-06-10", "SELL", 3, 110, 0);
    seedHold(db, 3, s, "2026-07-10", "live-zero");
    // Short option, CAD: fees, a partial close; statement zero.
    s = insertSecurity(db, "ZZQO  270115P00010000", { type: "option", currency: "CAD" });
    t(3, s, "2026-06-01", "SELL_TO_OPEN", 3, 2, 1.5);
    t(3, s, "2026-06-10", "BUY_TO_CLOSE", 1, 1, 0.5);
    seedHold(db, 3, s, "2026-06-30", "stmt-zero");
    // Long option, USD: fees, a partial close; statement zero.
    s = insertSecurity(db, "ZZQP  270115C00010000", { type: "option" });
    t(3, s, "2026-06-01", "BUY_TO_OPEN", 2, 3, 1);
    t(3, s, "2026-06-10", "SELL_TO_CLOSE", 1, 4, 0);
    seedHold(db, 3, s, "2026-06-30", "stmt-zero");
    computeTaxLots(db);
  });

  it("every pending side's open_figure equals Σ remainingLotBasisSql() over its open lots, to 1e-9, and the hand figures", () => {
    const pairs = getPendingStatementPairs(db, undefined, OPTS);
    const viaShared = db.prepare(
      `SELECT COALESCE(SUM(${remainingLotBasisSql()}), 0) AS f
         FROM tax_lots tl
         JOIN securities s ON s.id = tl.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
        WHERE tl.account_id = ? AND tl.security_id = ? AND tl.quantity_remaining > 0
          AND (CASE WHEN COALESCE(tl.is_short, 0) != 0 THEN 1 ELSE 0 END) = ?`
    );
    // Hand: ZZQL 3/5 of (600 + 3) = 361.8; ZZQS 6/10 of (500 - 5) = 297;
    // ZZQC 7/10 of (1000 + 4) CAD x 0.75 = 527.1; ZZQO 2/3 of (600 - 1.5) CAD x 0.75 = 299.25;
    // ZZQP 1/2 of (600 + 1) = 300.5.
    const hand: Record<string, [string, number]> = {
      ZZQL: ["long", 361.8],
      ZZQS: ["short", 297],
      ZZQC: ["long", 527.1],
      "ZZQO  270115P00010000": ["short", 299.25],
      "ZZQP  270115C00010000": ["long", 300.5],
    };
    expect(pairs.map((p) => p.symbol).sort()).toEqual(Object.keys(hand).sort());
    for (const p of pairs) {
      const shared = (viaShared.get(p.account_id, p.security_id, p.side === "short" ? 1 : 0) as { f: number }).f;
      expect([p.symbol, Math.abs(p.open_figure - shared) < 1e-9]).toEqual([p.symbol, true]);
      expect([p.symbol, p.side]).toEqual([p.symbol, hand[p.symbol][0]]);
      expect(Math.abs(p.open_figure - hand[p.symbol][1])).toBeLessThan(1e-9);
    }
  });
});
