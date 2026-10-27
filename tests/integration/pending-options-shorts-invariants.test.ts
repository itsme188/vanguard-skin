/**
 * Cross-cutting invariants for pending option and short lots (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 12; rulings R1, R2, R4, R6, R7, R11, R13, R17; OPEN-10).
 *
 * Population rule (F6): the shared seed's expected state for every position
 * is written BY HAND (tests/setup/pending-options-shorts-seed.ts,
 * `SEED_TABLE`). Each test first checks the read model agrees with that
 * table, then uses the TABLE as its population, so a classifier that
 * wrongly leaves a lot valued fails the money identity instead of
 * redefining it.
 *
 * Synthetic symbols and small round numbers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";

// The seed's re-symbol mapping (synthetic; restated here because a mock
// factory cannot import the seed module).
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
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { removeOrphanedReconTombstones } from "@/lib/mutations/closed-equity";
import {
  getPendingStatementIndex,
  getPendingStatementPairs,
  type PendingStatementPair,
} from "@/lib/queries/pending-statement";
import {
  getExpiredOptionLotsAwaitingClose,
  getOpenTaxLots,
  getTaxLotSummary,
  type TaxLotWithSecurity,
} from "@/lib/queries/tax-lots";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { getClosedPerLiveDataForChat, getTaxLotsForChat } from "@/lib/queries/chat-tools";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import {
  applyMistypedOptionLegPlans,
  planDuplicateDeletions,
  planExpiredQtyFix,
  planOptionResymbols,
  planOptionSplits,
  planRetypes,
} from "@/scripts/repair-mistyped-option-legs";
import {
  buildSeed,
  insertPrice,
  insertSecurity,
  insertTxn,
  rawLots,
  rawUnrealized,
  remainingFigure,
  SEED_FIGURES,
  SEED_NOW,
  SEED_RESYMBOL_FROM,
  SEED_RESYMBOL_TO,
  SEED_TABLE,
  SEED_TODAY,
  type RawLot,
  type SeedRow,
} from "../setup/pending-options-shorts-seed";
import { createPendingTestDb, seedHold, seedImportSplit } from "../setup/pending-statement-fixtures";

const OPTS = { today: SEED_TODAY };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SEED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type LotState = "closed" | "expired" | "pending" | "open";

/** Every lot id in one disjoint bucket, read through the readers (never tax_lots flags alone). */
function readStates(db: Database.Database) {
  const open = getOpenTaxLots(db, undefined, OPTS);
  const expired = getExpiredOptionLotsAwaitingClose(db, OPTS);
  const closedIds = new Set(
    (db.prepare("SELECT id FROM tax_lots WHERE quantity_remaining = 0").all() as { id: number }[]).map((r) => r.id)
  );
  const byId = new Map<number, { state: LotState; row: TaxLotWithSecurity | null }>();
  const put = (id: number, state: LotState, row: TaxLotWithSecurity | null) => {
    if (byId.has(id)) throw new Error(`lot ${id} is in two buckets: ${byId.get(id)!.state} and ${state}`);
    byId.set(id, { state, row });
  };
  for (const id of closedIds) put(id, "closed", null);
  for (const l of expired) put(l.id, "expired", l);
  for (const l of open) put(l.id, l.pending_statement ? "pending" : "open", l);
  return { byId, open, expired };
}

function tableRowOf(lot: RawLot): SeedRow {
  const row = SEED_TABLE.find((r) => r.symbol === lot.symbol && r.account === lot.account_id);
  if (!row) throw new Error(`lot ${lot.id} (${lot.symbol}) is not in the hand table`);
  return row;
}

function expectedBucket(row: SeedRow): LotState {
  switch (row.state.kind) {
    case "open_priced":
    case "open_unpriced":
      return "open";
    default:
      return row.state.kind;
  }
}

describe("the shared seed agrees with the hand table", () => {
  it("every position, its lot count, its bucket, its reason and its pricing match the table", () => {
    const { db } = buildSeed();
    const lots = rawLots(db);
    const { byId } = readStates(db);
    // Lot count per position = the table's.
    for (const row of SEED_TABLE) {
      const n = lots.filter((l) => l.symbol === row.symbol && l.account_id === row.account).length;
      expect([row.symbol, n]).toEqual([row.symbol, row.lots]);
    }
    expect(lots.length).toBe(SEED_TABLE.reduce((s, r) => s + r.lots, 0));
    for (const lot of lots) {
      const row = tableRowOf(lot);
      const got = byId.get(lot.id)!;
      expect([lot.symbol, got.state]).toEqual([lot.symbol, expectedBucket(row)]);
      expect([lot.symbol, lot.is_short === 1 ? "short" : "long"]).toEqual([lot.symbol, row.side]);
      if (row.state.kind === "pending") {
        expect([lot.symbol, got.row!.pending_statement_reason]).toEqual([lot.symbol, row.state.reason]);
      }
      if (row.state.kind === "open_priced") expect([lot.symbol, got.row!.current_price != null]).toEqual([lot.symbol, true]);
      if (row.state.kind === "open_unpriced") expect([lot.symbol, got.row!.current_price]).toEqual([lot.symbol, null]);
    }
  });

  it("the index lists exactly the table's pending positions, with their reasons", () => {
    const { db } = buildSeed();
    const listed = getPendingStatementPairs(db, undefined, OPTS)
      .map((p) => [p.account_id, p.symbol, p.side, p.reason])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const expected = SEED_TABLE.filter((r) => r.state.kind === "pending")
      .map((r) => [r.account, r.symbol, r.side, (r.state as { reason: string }).reason])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    expect(listed).toEqual(expected);
  });
});

describe("T-ONE-STATE: every lot is in exactly one of four disjoint states", () => {
  it("closed, expired awaiting close, pending (one reason), ordinary open; Σ = every lot; a partly sold lot is not closed", () => {
    const { db } = buildSeed();
    const lots = rawLots(db);
    const { byId } = readStates(db);
    const counts: Record<LotState, number> = { closed: 0, expired: 0, pending: 0, open: 0 };
    for (const lot of lots) {
      const row = tableRowOf(lot);
      counts[expectedBucket(row)] += 1;
    }
    // Hand counts from SEED_TABLE: 5 closed, 2 expired, 8 pending, 9 ordinary open.
    expect(counts).toEqual({ closed: 5, expired: 2, pending: 8, open: 9 });
    expect(counts.closed + counts.expired + counts.pending + counts.open).toBe(lots.length);
    expect(byId.size).toBe(lots.length);
    // Pending carries exactly one reason, and the others carry none.
    for (const { state, row } of byId.values()) {
      if (state === "pending") expect(row!.pending_statement_reason).not.toBeNull();
      if (state === "open" || state === "expired") expect(row!.pending_statement_reason).toBeNull();
      if (state === "expired") expect(row!.pending_statement).toBe(false);
    }
    // A partly sold lot (ZZLA, ZZUA) is ordinary open, not closed.
    for (const sym of ["ZZLA  270115C00010000", "ZZUA"]) {
      const lot = lots.find((l) => l.symbol === sym)!;
      expect(lot.quantity_remaining).toBeLessThan(lot.quantity_acquired);
      expect(byId.get(lot.id)!.state).toBe("open");
    }
  });
});

describe("T-QTY: quantity is conserved per (account, security, side)", () => {
  it("Σ quantity_remaining = Σ ordinary open + Σ pending + Σ expired (closed contribute 0), to 1e-9", () => {
    const { db } = buildSeed();
    const lots = rawLots(db);
    const { byId } = readStates(db);
    const key = (l: RawLot) => `${l.account_id}|${l.security_id}|${l.is_short}`;
    const stored = new Map<string, number>();
    const byState = new Map<string, number>();
    for (const l of lots) {
      stored.set(key(l), (stored.get(key(l)) ?? 0) + l.quantity_remaining);
      const s = byId.get(l.id)!;
      const q = s.state === "closed" ? 0 : s.row!.quantity_remaining;
      byState.set(key(l), (byState.get(key(l)) ?? 0) + q);
    }
    expect(stored.size).toBe(SEED_TABLE.length);
    for (const [k, v] of stored) expect(Math.abs((byState.get(k) ?? NaN) - v)).toBeLessThan(1e-9);
  });
});

describe("T-MONEY: the unrealized arithmetic over open lots is conserved", () => {
  it("Σ U over the table's ordinary-open priced lots = the Unrealized tile (hand figure)", () => {
    const { db } = buildSeed();
    const lots = rawLots(db);
    const tile = getTaxLotSummary(db, undefined, OPTS).totalUnrealizedGain;
    const sumFor = (pred: (r: SeedRow) => boolean) =>
      lots.filter((l) => pred(tableRowOf(l))).reduce((s, l) => s + (rawUnrealized(l) ?? 0), 0);
    const ordinaryPriced = sumFor((r) => r.state.kind === "open_priced");
    const pending = sumFor((r) => r.state.kind === "pending");
    const expired = sumFor((r) => r.state.kind === "expired");
    expect(ordinaryPriced).toBeCloseTo(SEED_FIGURES.unrealizedTile, 9);
    expect(pending).toBeCloseTo(SEED_FIGURES.pendingRawUnrealized, 9);
    expect(expired).toBeCloseTo(SEED_FIGURES.expiredRawUnrealized, 9);
    expect(tile).toBeCloseTo(SEED_FIGURES.unrealizedTile, 9);
    // Σ U over (ordinary ∪ pending ∪ expired, priced) = tile + pending + expired.
    const allPriced = lots
      .filter((l) => tableRowOf(l).state.kind !== "closed")
      .reduce((s, l) => s + (rawUnrealized(l) ?? 0), 0);
    expect(allPriced).toBeCloseTo(tile + pending + expired, 9);
  });

  it("no pending or expired lot carries a value or a gain in the read model (R1)", () => {
    const { db } = buildSeed();
    const { byId } = readStates(db);
    for (const { state, row } of byId.values()) {
      if (state === "pending" || state === "expired") {
        expect(row!.current_value).toBeNull();
        expect(row!.unrealized_gain).toBeNull();
      }
    }
  });

  it("realized totals equal a direct tax_lot_sales sum (hand figure)", () => {
    const { db } = buildSeed();
    const direct = (
      db
        .prepare(
          `SELECT SUM(tls.realized_gain_loss) AS g FROM tax_lot_sales tls
             JOIN tax_lots tl ON tl.id = tls.tax_lot_id JOIN securities s ON s.id = tl.security_id
            WHERE COALESCE(s.currency, 'USD') = 'USD'`
        )
        .get() as { g: number }
    ).g;
    expect(direct).toBeCloseTo(SEED_FIGURES.realized, 9);
    expect(getTaxLotSummary(db, undefined, OPTS).totalRealizedGain).toBeCloseTo(direct, 9);
  });

  it("the pending disclosure figure is Σ remaining basis or proceeds per (reason, side), never a term of the unrealized identity", () => {
    const { db } = buildSeed();
    const lots = rawLots(db);
    const expected = new Map<string, number>();
    for (const l of lots) {
      const r = tableRowOf(l);
      if (r.state.kind !== "pending") continue;
      const k = `${r.state.reason}|${r.side}`;
      expected.set(k, (expected.get(k) ?? 0) + remainingFigure(l));
    }
    const rows = getTaxLotSummary(db, undefined, OPTS).pendingStatement;
    expect(rows.map((r) => `${r.reason}|${r.side}`).sort()).toEqual([...expected.keys()].sort());
    for (const r of rows) expect(r.figure).toBeCloseTo(expected.get(`${r.reason}|${r.side}`)!, 9);
  });
});

// ── Digests with stable identities (T-NOWRITE, T-IDEMPOTENT) ──

function stableRows(rows: Array<Record<string, unknown>>, key: (r: Record<string, unknown>) => string, drop: string[]) {
  return rows
    .map((r) => {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!drop.includes(k)) copy[k] = v;
      return [key(r), copy] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function ledgerDigest(db: Database.Database) {
  return JSON.stringify({
    transactions: stableRows(
      db.prepare("SELECT * FROM transactions").all() as Array<Record<string, unknown>>,
      (r) => String(r.source_key ?? `id:${r.id}`),
      ["id"]
    ),
    holdings: stableRows(
      db.prepare("SELECT * FROM holdings").all() as Array<Record<string, unknown>>,
      (r) => `${r.account_id}|${r.security_id}|${r.as_of_date}|${r.source_key}`,
      ["id"]
    ),
  });
}

function taxDigest(db: Database.Database) {
  const lots = db
    .prepare(
      `SELECT tl.*, t.source_key AS acq_key FROM tax_lots tl
         LEFT JOIN transactions t ON t.id = tl.acquisition_transaction_id`
    )
    .all() as Array<Record<string, unknown>>;
  const sales = db
    .prepare(
      `SELECT tls.*, ta.source_key AS acq_key, tl.acquisition_date AS acq_date, ts.source_key AS sale_key
         FROM tax_lot_sales tls
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id
         LEFT JOIN transactions ta ON ta.id = tl.acquisition_transaction_id
         JOIN transactions ts ON ts.id = tls.sale_transaction_id`
    )
    .all() as Array<Record<string, unknown>>;
  const reconcile = db
    .prepare("SELECT * FROM transactions WHERE type = 'RECONCILE_CLOSE'")
    .all() as Array<Record<string, unknown>>;
  const settings = db
    .prepare("SELECT key, value FROM settings WHERE key IN ('tax_input_generation', 'tax_lots_convention') ORDER BY key")
    .all();
  return JSON.stringify({
    lots: stableRows(lots, (r) => `${r.acq_key}|${r.acquisition_date}`, ["id", "acquisition_transaction_id"]),
    sales: stableRows(sales, (r) => `${r.acq_key}|${r.acq_date}|${r.sale_key}`, ["id", "tax_lot_id", "sale_transaction_id"]),
    reconcile: stableRows(reconcile, (r) => String(r.source_key), ["id"]),
    settings,
  });
}

describe("T-NOWRITE: every read function leaves the ledger, holdings and tax tables untouched", () => {
  it("digests before and after calling every reader are identical", () => {
    const { db } = buildSeed();
    const before = { ledger: ledgerDigest(db), tax: taxDigest(db) };
    getPendingStatementPairs(db, undefined, OPTS);
    getPendingStatementIndex(db, undefined, OPTS);
    getOpenTaxLots(db, undefined, OPTS);
    getExpiredOptionLotsAwaitingClose(db, OPTS);
    getTaxLotSummary(db, undefined, OPTS);
    getTaxLotSummary(db, 2026, OPTS);
    getPortfolioSummaryForChat(db);
    getPortfolioSummaryForChat(db, "IBKR");
    getTaxLotsForChat(db, { status: "open" });
    getTaxLotsForChat(db, { status: "closed" });
    getTaxLotsForChat(db, { status: "all" });
    for (const row of SEED_TABLE) getClosedPerLiveDataForChat(db, { symbol: row.symbol });
    runIntegrityChecks(db, OPTS);
    getDataConfidence(db, SEED_NOW);
    expect(ledgerDigest(db)).toBe(before.ledger);
    expect(taxDigest(db)).toBe(before.tax);
  });
});

describe("T-IDEMPOTENT: recomputing with pending option and short pairs seeded is stable", () => {
  it("two computeTaxLots runs give the same source_key-keyed digest", () => {
    const { db } = buildSeed();
    const first = taxDigest(db);
    computeTaxLots(db);
    expect(taxDigest(db)).toBe(first);
  });

  it("adding and removing :live tombstones changes neither tax_input_generation nor the digest", () => {
    const { db, secId } = buildSeed();
    const gen = getTaxInputGeneration(db);
    const digest = taxDigest(db);
    // Add: live tombstones on held option and short pairs (they turn pending).
    seedHold(db, 3, secId("ZZSA  270115P00010000"), "2026-10-21", "live-zero");
    seedHold(db, 3, secId("ZZTA"), "2026-10-21", "live-zero");
    expect(getTaxInputGeneration(db)).toBe(gen);
    computeTaxLots(db);
    expect(taxDigest(db)).toBe(digest);
    // Remove: the real cleanup path deletes every unjustified :live tombstone.
    const removed = removeOrphanedReconTombstones(db);
    expect(removed).toBeGreaterThan(0);
    expect(getTaxInputGeneration(db)).toBe(gen);
    computeTaxLots(db);
    expect(taxDigest(db)).toBe(digest);
  });
});

// ── T-ENDS: what ends pending, per class (R2, R11, R17) ──

interface ClassSpec {
  name: string;
  option: boolean;
  open: string;
  close: string;
  /** A same-side opening (E4). */
  reopen: string;
  /** An opening on the OTHER side (never ends pending). */
  opposite: string;
  /** The sign of a same-side holdings row (E3). */
  heldSign: 1 | -1;
  side: "long" | "short";
}

const CLASSES: ClassSpec[] = [
  { name: "long option", option: true, open: "BUY_TO_OPEN", close: "SELL_TO_CLOSE", reopen: "BUY_TO_OPEN", opposite: "SELL_TO_OPEN", heldSign: 1, side: "long" },
  { name: "short option", option: true, open: "SELL_TO_OPEN", close: "BUY_TO_CLOSE", reopen: "SELL_TO_OPEN", opposite: "BUY_TO_OPEN", heldSign: -1, side: "short" },
  { name: "short stock", option: false, open: "SHORT_SELL", close: "BUY_TO_COVER", reopen: "SHORT_SELL", opposite: "BUY", heldSign: -1, side: "short" },
];

/** One position of the class: 2 opened 06-01, a statement zero on 06-30, no closing entry. */
function endsFixture(c: ClassSpec, expiration = "2027-01-15") {
  const db = createPendingTestDb();
  const sec = insertSecurity(db, c.option ? "ZZEN  270115C00010000" : "ZZEN", {
    type: c.option ? "option" : "Stock",
    expiration,
  });
  insertTxn(db, 3, sec, "2026-06-01", c.open, 2, 5);
  seedHold(db, 3, sec, "2026-06-30", "stmt-zero");
  insertPrice(db, sec, "2026-10-23", 4);
  return { db, sec };
}

function sidePairs(db: Database.Database, today = SEED_TODAY): PendingStatementPair[] {
  return getPendingStatementPairs(db, undefined, { today });
}

describe("T-ENDS: endings and non-endings per class", () => {
  it.each(CLASSES)("$name: starts closing_entry_missing on its side", (c) => {
    const { db } = endsFixture(c);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.side, p.reason, p.flat_date, p.open_quantity])).toEqual([
      [c.side, "closing_entry_missing", "2026-06-30", 2],
    ]);
  });

  it.each(CLASSES)("$name: E1 a partial closing entry leaves the remainder pending; the full close ends it", (c) => {
    const { db, sec } = endsFixture(c);
    insertTxn(db, 3, sec, "2026-06-20", c.close, 1, 3);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.side, p.reason, p.open_quantity])).toEqual([[c.side, "closing_entry_missing", 1]]);
    insertTxn(db, 3, sec, "2026-06-25", c.close, 1, 3);
    computeTaxLots(db);
    expect(sidePairs(db)).toEqual([]);
  });

  it.each(CLASSES.filter((c) => c.option))("$name: E2 the day after expiration it leaves pending for the expired bucket", (c) => {
    const { db } = endsFixture(c, "2026-11-20");
    computeTaxLots(db);
    expect(sidePairs(db, "2026-11-20").map((p) => p.reason)).toEqual(["closing_entry_missing"]);
    expect(sidePairs(db, "2026-11-21")).toEqual([]);
    const expired = getExpiredOptionLotsAwaitingClose(db, { today: "2026-11-21" });
    expect(expired.map((l) => [l.expired_option, l.pending_statement, l.current_value, l.unrealized_gain])).toEqual([
      [true, false, null, null],
    ]);
  });

  it.each(CLASSES)("$name: E3 a newer non-zero holdings row on the lot's side ends it", (c) => {
    const { db, sec } = endsFixture(c);
    seedHold(db, 3, sec, "2026-07-15", "tws", 2 * c.heldSign);
    computeTaxLots(db);
    expect(sidePairs(db)).toEqual([]);
  });

  it.each(CLASSES)("$name: E3 a newer non-zero row on the OTHER side does not end it", (c) => {
    const { db, sec } = endsFixture(c);
    seedHold(db, 3, sec, "2026-07-15", "tws", -2 * c.heldSign);
    computeTaxLots(db);
    // The live row of the other sign is flat evidence for this side.
    expect(sidePairs(db).map((p) => [p.side, p.reason])).toEqual([[c.side, "closing_entry_missing"]]);
  });

  it.each(CLASSES)("$name: E4 a same-side reopening after the flat date ends it (results current)", (c) => {
    const { db, sec } = endsFixture(c);
    insertTxn(db, 3, sec, "2026-07-15", c.reopen, 1, 6);
    computeTaxLots(db);
    expect(sidePairs(db)).toEqual([]);
  });

  it.each(CLASSES)("$name: E4 boundary (R17): a reopening dated ON the flat date does not end it", (c) => {
    const { db, sec } = endsFixture(c);
    insertTxn(db, 3, sec, "2026-06-30", c.reopen, 1, 6);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.side, p.reason])).toEqual([[c.side, "closing_entry_missing"]]);
  });

  it.each(CLASSES)("$name: an import split after the flat date never ends it", (c) => {
    const { db, sec } = endsFixture(c);
    seedImportSplit(db, sec, "2026-07-15");
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.side, p.reason, p.open_quantity])).toEqual([[c.side, "closing_entry_missing", 4]]);
  });

  it.each(CLASSES)("$name: an opening on the opposite side never ends it", (c) => {
    const { db, sec } = endsFixture(c);
    insertTxn(db, 3, sec, "2026-07-15", c.opposite, 1, 6);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.side, p.reason])).toEqual([[c.side, "closing_entry_missing"]]);
  });

  it.each(CLASSES)("$name: TRANSFER_OUT never ends it (the engine does not replay it as a close)", (c) => {
    const { db, sec } = endsFixture(c);
    insertTxn(db, 3, sec, "2026-07-15", "TRANSFER_OUT", 2, 4);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.side, p.reason, p.open_quantity])).toEqual([[c.side, "closing_entry_missing", 2]]);
  });
});

describe("T-XACCT (end to end): a closing entry booked in another account", () => {
  it("A's lot stays open, pending and unvalued; B's unmatched cover realizes nothing; one critical hit carrying the side", () => {
    const db = createPendingTestDb();
    const sec = insertSecurity(db, "ZZXX");
    const A = 3;
    const B = 1;
    insertTxn(db, A, sec, "2026-03-02", "SHORT_SELL", 100, 50);
    seedHold(db, A, sec, "2026-06-30", "stmt-zero");
    const cover = insertTxn(db, B, sec, "2026-05-10", "BUY_TO_COVER", 100, 40);
    insertPrice(db, sec, "2026-10-23", 45);
    computeTaxLots(db);

    const lots = getOpenTaxLots(db, undefined, OPTS);
    expect(lots.map((l) => [l.account_id, l.is_short, l.quantity_remaining, l.pending_statement_reason, l.current_value, l.unrealized_gain])).toEqual([
      [A, 1, 100, "closing_entry_missing", null, null],
    ]);
    const realizedFromCover = (
      db.prepare("SELECT COALESCE(SUM(realized_gain_loss), 0) AS g, COUNT(*) AS n FROM tax_lot_sales WHERE sale_transaction_id = ?").get(cover) as { g: number; n: number }
    );
    expect(realizedFromCover).toEqual({ g: 0, n: 0 });
    const { critical } = runIntegrityChecks(db, OPTS);
    const hits = critical.filter((h) => h.kind === "closing-entry-account-mismatch");
    expect(hits.map((h) => h.key)).toEqual([`closing-entry-account:${A}:${B}:${sec}:short`]);
  });
});

describe("T-RESYMBOL (end to end): the repair seam and the label", () => {
  function plansFor(db: Database.Database) {
    const dups = planDuplicateDeletions(db);
    return {
      dups,
      retypes: planRetypes(db),
      expFix: planExpiredQtyFix(db),
      optSplits: planOptionSplits(db, dups.map((d) => d.deleteId)),
      resymbols: planOptionResymbols(db),
    };
  }

  /** The old-symbol leg in `account`, the replacement held there, the old pair flat in live data. */
  function resymbolFixture(account: number) {
    const db = createPendingTestDb();
    const from = insertSecurity(db, SEED_RESYMBOL_FROM, { type: "option" });
    const to = insertSecurity(db, SEED_RESYMBOL_TO, { type: "option" });
    insertTxn(db, account, from, "2026-05-01", "BUY_TO_OPEN", 1, 8);
    seedHold(db, account, from, "2026-10-20", "live-zero");
    seedHold(db, account, to, "2026-10-20", "tws", 2);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.account_id, p.symbol, p.reason])).toEqual([
      [account, SEED_RESYMBOL_FROM, "resymbol_repair_pending"],
    ]);
    return { db, from, to };
  }

  it("supported rows (the planner's account): after the seam and a recompute, no old-symbol open lot and no label", () => {
    const { db, from, to } = resymbolFixture(1);
    const plans = plansFor(db);
    expect(plans.resymbols.map((p) => p.action)).toEqual(["resymbol + normalize"]);
    applyMistypedOptionLegPlans(db, plans);
    computeTaxLots(db);
    const open = db
      .prepare("SELECT security_id, quantity_remaining FROM tax_lots WHERE quantity_remaining > 0 ORDER BY id")
      .all() as Array<{ security_id: number; quantity_remaining: number }>;
    expect(open).toEqual([{ security_id: to, quantity_remaining: 2 }]); // hand: 1 contract x ratio 2
    expect(open.some((l) => l.security_id === from)).toBe(false);
    expect(sidePairs(db)).toEqual([]);
  });

  it("unsupported rows (another account): the seam moves nothing and the label stays (R7)", () => {
    const { db } = resymbolFixture(3);
    const plans = plansFor(db);
    expect(plans.resymbols.map((p) => p.ok)).toEqual([false]);
    applyMistypedOptionLegPlans(db, plans);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.symbol, p.reason])).toEqual([[SEED_RESYMBOL_FROM, "resymbol_repair_pending"]]);
  });
});

describe("KNOWN LIMITATION for Part 2 (OPEN-10), pinned as CURRENT behaviour, not desired behaviour", () => {
  it("an orphan short proven flat by a statement, then a same-side round trip (SHORT_SELL 10 + BUY_TO_COVER 10): the side stops being pending and the orphan's 10 read open and valued until the next flat row", () => {
    const db = createPendingTestDb();
    const sec = insertSecurity(db, "ZZOT");
    insertTxn(db, 3, sec, "2026-06-01", "SHORT_SELL", 10, 50); // the orphan: its cover was never imported
    seedHold(db, 3, sec, "2026-06-30", "stmt-zero");
    insertPrice(db, sec, "2026-10-23", 45);
    computeTaxLots(db);
    expect(sidePairs(db).map((p) => [p.side, p.reason])).toEqual([["short", "closing_entry_missing"]]);

    // A later round trip on the same side. FIFO: the cover closes the OLDER
    // (orphan) lot, so the 10 still open sit on the 07-15 lot.
    insertTxn(db, 3, sec, "2026-07-15", "SHORT_SELL", 10, 40);
    insertTxn(db, 3, sec, "2026-07-20", "BUY_TO_COVER", 10, 38);
    computeTaxLots(db);
    expect(
      db.prepare("SELECT acquisition_date, quantity_remaining FROM tax_lots WHERE security_id = ? ORDER BY id").all(sec)
    ).toEqual([
      { acquisition_date: "2026-06-01", quantity_remaining: 0 },
      { acquisition_date: "2026-07-15", quantity_remaining: 10 },
    ]);
    // CURRENT behaviour (the limitation): the same-side reopening (E4) ends
    // pending for the whole side, so the orphaned quantity reads valued.
    expect(sidePairs(db)).toEqual([]);
    const [lot] = getOpenTaxLots(db, undefined, OPTS);
    // Hand: 10 short at 45 = 450 to cover; proceeds 10 x 40 = 400; gain -(450 - 400) = -50.
    expect([lot.pending_statement, lot.current_value, lot.unrealized_gain]).toEqual([false, 450, -50]);

    // ... until the next flat row: a newer statement zero makes it pending again.
    seedHold(db, 3, sec, "2026-08-31", "stmt-zero");
    expect(sidePairs(db).map((p) => [p.side, p.reason, p.flat_date])).toEqual([["short", "closing_entry_missing", "2026-08-31"]]);
  });
});

describe("T-STOCK-UNCHANGED: the long-stock fixtures keep their pre-change values through the new API", () => {
  /** [name, build, expected pending rows as [symbol, reason, flat_date, open_quantity, open_figure]] */
  type Expect = Array<[string, string, string, number, number]>;
  const cases: Array<[string, (db: Database.Database) => void, Expect]> = [
    [
      "a :live tombstone after a statement row (pending-statement.test.ts PNDA)",
      (db) => {
        const s = insertSecurity(db, "PNDA");
        insertTxn(db, 3, s, "2026-06-01", "BUY", 10, 100);
        seedHold(db, 3, s, "2026-06-30", "stmt", 10);
        seedHold(db, 3, s, "2026-07-10", "live-zero");
      },
      [["PNDA", "awaiting_statement", "2026-07-10", 10, 1000]],
    ],
    [
      "only the still-open share of each lot (PNDD)",
      (db) => {
        const s = insertSecurity(db, "PNDD");
        insertTxn(db, 3, s, "2026-05-01", "BUY", 10, 100);
        insertTxn(db, 3, s, "2026-05-02", "BUY", 10, 200);
        insertTxn(db, 3, s, "2026-05-10", "SELL", 15, 150);
        seedHold(db, 3, s, "2026-07-10", "live-zero");
      },
      [["PNDD", "awaiting_statement", "2026-07-10", 5, 1000]],
    ],
    [
      "statement zero under a newer live zero is never pending (STMA)",
      (db) => {
        const s = insertSecurity(db, "STMA");
        insertTxn(db, 3, s, "2026-06-01", "BUY", 10, 100);
        seedHold(db, 3, s, "2026-06-30", "stmt-zero");
        insertTxn(db, 3, s, "2026-07-05", "BUY", 3, 100);
        seedHold(db, 3, s, "2026-07-10", "live-zero");
      },
      [],
    ],
    [
      "a statement-flat pair the engine closes is not pending (STMC)",
      (db) => {
        const s = insertSecurity(db, "STMC");
        insertTxn(db, 3, s, "2026-06-01", "BUY", 10, 100);
        seedHold(db, 3, s, "2026-06-30", "stmt-zero");
        insertPrice(db, s, "2026-06-30", 110);
      },
      [],
    ],
    [
      "a split after the live zero skips the pair (SPLT)",
      (db) => {
        const s = insertSecurity(db, "SPLT");
        insertTxn(db, 3, s, "2026-06-01", "BUY", 10, 100);
        seedHold(db, 3, s, "2026-07-10", "live-zero");
        seedImportSplit(db, s, "2026-07-20");
      },
      [],
    ],
    [
      "a later imported fill after the live zero skips the pair (LATE)",
      (db) => {
        const s = insertSecurity(db, "LATE");
        insertTxn(db, 3, s, "2026-06-01", "BUY", 10, 100);
        seedHold(db, 3, s, "2026-07-10", "live-zero");
        insertTxn(db, 3, s, "2026-07-15", "BUY", 1, 100);
      },
      [],
    ],
  ];

  it.each(cases)("%s", (_name, build, expected) => {
    const db = createPendingTestDb();
    build(db);
    computeTaxLots(db);
    const rows = getPendingStatementPairs(db, undefined, OPTS);
    expect(rows.map((p) => [p.symbol, p.reason, p.flat_date, p.open_quantity, Math.round(p.open_figure * 1e6) / 1e6])).toEqual(expected);
    for (const p of rows) expect([p.side, p.figure_kind]).toEqual(["long", "cost_basis"]);
  });

  it("the Tax Lots summary keeps its long-stock figures (tax-lots-pending-statement.test.ts fixture)", () => {
    const db = createPendingTestDb();
    const held = insertSecurity(db, "HELDX");
    insertTxn(db, 3, held, "2026-05-01", "BUY", 10, 100);
    seedHold(db, 3, held, "2026-07-10", "stmt", 10);
    insertPrice(db, held, "2026-07-10", 120);
    const pending = insertSecurity(db, "PENDX");
    insertTxn(db, 3, pending, "2026-05-01", "BUY", 5, 100);
    insertTxn(db, 3, pending, "2026-05-02", "BUY", 5, 100);
    seedHold(db, 3, pending, "2026-07-10", "live-zero");
    insertPrice(db, pending, "2026-07-10", 150);
    const pending2 = insertSecurity(db, "PENDY");
    insertTxn(db, 1, pending2, "2026-05-01", "BUY", 2, 50);
    seedHold(db, 1, pending2, "2026-07-11", "plaid", 0);
    insertPrice(db, pending2, "2026-07-11", 40);
    computeTaxLots(db);
    const s = getTaxLotSummary(db, undefined, OPTS);
    expect(s.totalUnrealizedGain).toBeCloseTo(200, 6);
    expect(s.pendingStatement).toHaveLength(1);
    expect(s.pendingStatement[0]).toMatchObject({ reason: "awaiting_statement", side: "long", positions: 2, lots: 3, figureKind: "cost_basis" });
    expect(s.pendingStatement[0].figure).toBeCloseTo(1100, 6);
  });
});
