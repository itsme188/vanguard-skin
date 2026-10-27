/**
 * Expiry versus pending (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 12, rulings R1 and D3; spec
 * docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md
 * §4, §5 "expired beats pending", §7):
 *  - T-NO-DOUBLE-FLAG (all readers): on the expiration day an option can be
 *    pending; from the next Eastern day it is expired, never pending, and
 *    every expired row carries no value and no gain.
 *  - T-PURGE-PLAID / T-PURGE-WIDE: neither purge path ever turns a pending
 *    or expired lot back into an open, valued one; the wide path's first
 *    deleting moment is already past the Eastern expiry.
 * Synthetic symbols and small round numbers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { purgeExpiredOptionHoldings } from "@/lib/mutations/expired-options";
import { getPendingStatementIndex, getPendingStatementPairs } from "@/lib/queries/pending-statement";
import {
  getExpiredOptionLotsAwaitingClose,
  getOpenTaxLots,
  getTaxLotSummary,
} from "@/lib/queries/tax-lots";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { getClosedPerLiveDataForChat, getTaxLotsForChat } from "@/lib/queries/chat-tools";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import { insertPrice, insertSecurity, insertTxn } from "../setup/pending-options-shorts-seed";
import { createPendingTestDb, seedHold, type HoldingOrigin } from "../setup/pending-statement-fixtures";

const EXPIRATION = "2026-10-16";
const EXP_DAY = { today: "2026-10-16", now: new Date("2026-10-16T16:00:00Z") }; // noon Eastern (EDT)
const NEXT_DAY = { today: "2026-10-17", now: new Date("2026-10-17T16:00:00Z") };

const PENDING_KINDS = new Set(["statement-lag", "closing-entry-missing", "resymbol-repair-pending"]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("T-NO-DOUBLE-FLAG (all readers): expired beats pending, from the next Eastern day", () => {
  let db: Database.Database;
  const symbols: string[] = [];

  /** Long and short options, each with a live zero, a statement zero, or both as the newest rows. */
  beforeEach(() => {
    db = createPendingTestDb();
    symbols.length = 0;
    const evidence: Array<[string, HoldingOrigin[]]> = [
      ["A", ["live-zero"]],
      ["B", ["stmt-zero"]],
      ["C", ["stmt-zero", "live-zero"]],
    ];
    for (const [side, openType] of [
      ["L", "BUY_TO_OPEN"],
      ["S", "SELL_TO_OPEN"],
    ] as const) {
      for (const [tag, origins] of evidence) {
        const symbol = `ZZD${side}${tag}  261016C00010000`;
        symbols.push(symbol);
        const sec = insertSecurity(db, symbol, { type: "option", expiration: EXPIRATION });
        insertTxn(db, 3, sec, "2026-06-01", openType, 1, 2);
        // Held per live data first (the chat tool reports the last non-zero row).
        seedHold(db, 3, sec, "2026-09-15", "tws", side === "L" ? 1 : -1);
        origins.forEach((o, i) => seedHold(db, 3, sec, i === 0 && o === "stmt-zero" ? "2026-09-30" : "2026-10-10", o));
        insertPrice(db, sec, "2026-10-15", 0.5);
      }
    }
    computeTaxLots(db);
  });

  function readAll(day: typeof EXP_DAY) {
    vi.setSystemTime(day.now);
    const opts = { today: day.today };
    return {
      pairs: getPendingStatementPairs(db, undefined, opts),
      index: getPendingStatementIndex(db, undefined, opts),
      open: getOpenTaxLots(db, undefined, opts),
      expired: getExpiredOptionLotsAwaitingClose(db, opts),
      summary: getTaxLotSummary(db, undefined, opts),
      chatLots: getTaxLotsForChat(db, { status: "open" }),
      chatSummary: getPortfolioSummaryForChat(db),
      closedPerLive: symbols.flatMap((symbol) => getClosedPerLiveDataForChat(db, { symbol })),
      integrity: runIntegrityChecks(db, opts),
      confidence: getDataConfidence(db, day.now),
    };
  }

  it("on the expiration day: all six are pending (live, statement, both), none expired", () => {
    const r = readAll(EXP_DAY);
    expect(r.pairs.map((p) => [p.symbol.slice(0, 5), p.side, p.reason])).toEqual([
      ["ZZDLA", "long", "awaiting_statement"],
      ["ZZDLB", "long", "closing_entry_missing"],
      ["ZZDLC", "long", "closing_entry_missing"],
      ["ZZDSA", "short", "awaiting_statement"],
      ["ZZDSB", "short", "closing_entry_missing"],
      ["ZZDSC", "short", "closing_entry_missing"],
    ]);
    expect(r.expired).toEqual([]);
    expect(r.open.map((l) => [l.pending_statement, l.expired_option, l.current_value, l.unrealized_gain])).toEqual(
      Array(6).fill([true, false, null, null])
    );
    expect(r.chatLots.map((l) => [l.pending_statement, l.current_value, l.unrealized_gain])).toEqual(Array(6).fill([true, null, null]));
    expect(r.summary.expiredOptionLotsAwaitingClose).toBe(0);
    expect(r.summary.pendingStatement.reduce((s, row) => s + row.lots, 0)).toBe(6);
    expect(r.chatSummary).toContain("awaiting broker statement");
    expect(r.closedPerLive.map((c) => c.symbol.slice(0, 5)).sort()).toEqual(["ZZDLA", "ZZDSA"]);
    expect(r.integrity.warnings.some((w) => w.kind != null && PENDING_KINDS.has(w.kind))).toBe(true);
  });

  it("on the next Eastern day: none is pending anywhere; all six are expired with no value and no gain", () => {
    const r = readAll(NEXT_DAY);
    expect(r.pairs).toEqual([]);
    expect(r.index.pairs).toEqual([]);
    for (const l of [...r.open, ...r.expired]) expect(l.pending_statement && l.expired_option).toBe(false);
    expect(r.open).toEqual([]);
    expect(r.expired.map((l) => [l.expired_option, l.pending_statement, l.pending_statement_reason, l.current_value, l.unrealized_gain])).toEqual(
      Array(6).fill([true, false, null, null, null])
    );
    for (const l of r.expired) expect(r.index.reasonFor(l)).toBeNull();
    // Chat: not pending, the expired note, and no value or gain.
    expect(r.chatLots).toHaveLength(6);
    for (const l of r.chatLots) {
      expect([l.pending_statement, l.pending_statement_reason, l.current_value, l.unrealized_gain]).toEqual([false, null, null, null]);
      expect(l.status_note).toContain("Expired option");
    }
    expect(r.summary.pendingStatement).toEqual([]);
    expect(r.summary.expiredOptionLotsAwaitingClose).toBe(6);
    expect(r.chatSummary).not.toContain("awaiting broker statement");
    expect(r.chatSummary).not.toContain("no closing entry in the ledger");
    expect(r.closedPerLive).toEqual([]);
    const pendingHits = [...r.integrity.warnings, ...r.integrity.critical].filter((w) => w.kind != null && PENDING_KINDS.has(w.kind));
    expect(pendingHits).toEqual([]);
    const confHits = [...r.confidence.integrity.warnings, ...r.confidence.integrity.critical].filter(
      (w) => w.kind != null && PENDING_KINDS.has(w.kind)
    );
    expect(confHits).toEqual([]);
  });
});

describe("T-PURGE: no purge path returns an expired lot to open and valued", () => {
  let db: Database.Database;
  let sec: number;

  /** Account 1: statement row then a live (plaid) zero; account 3 holds the same contract in live data. */
  beforeEach(() => {
    db = createPendingTestDb();
    sec = insertSecurity(db, "ZZPG  261016C00010000", { type: "option", expiration: EXPIRATION });
    insertTxn(db, 1, sec, "2026-06-01", "BUY_TO_OPEN", 1, 2);
    insertTxn(db, 3, sec, "2026-06-01", "BUY_TO_OPEN", 1, 2);
    seedHold(db, 1, sec, "2026-09-30", "stmt", 1);
    seedHold(db, 1, sec, "2026-10-10", "plaid", 0);
    seedHold(db, 3, sec, "2026-10-10", "tws", 1);
    insertPrice(db, sec, "2026-10-15", 0.5);
    computeTaxLots(db);
  });

  function holdingsRows() {
    return db
      .prepare("SELECT account_id, as_of_date, quantity FROM holdings WHERE security_id = ? ORDER BY account_id, as_of_date")
      .all(sec);
  }

  /** Every lot of the contract reads expired, awaiting close: not open, not valued, not pending. */
  function expectExpiredAwaitingClose(today?: string) {
    const opts = today ? { today } : undefined;
    expect(getOpenTaxLots(db, undefined, opts)).toEqual([]);
    expect(getPendingStatementPairs(db, undefined, opts ?? {})).toEqual([]);
    expect(
      getExpiredOptionLotsAwaitingClose(db, opts)
        .map((l) => [l.account_id, l.expired_option, l.pending_statement, l.current_value, l.unrealized_gain])
        .sort((a, b) => Number(a[0]) - Number(b[0]))
    ).toEqual([
      [1, true, false, null, null],
      [3, true, false, null, null],
    ]);
  }

  it("T-PURGE-PLAID: scoped, live-only, one-account purge after expiry plus the grace day; same state before and after", () => {
    const today = "2026-10-18";
    vi.setSystemTime(new Date("2026-10-18T16:00:00Z"));
    expectExpiredAwaitingClose(today);
    const deleted = purgeExpiredOptionHoldings(db, 1, { accountId: 1, liveOnly: true, today });
    expect(deleted).toBe(1);
    // Account 1's statement row and account 3's row are untouched.
    expect(holdingsRows()).toEqual([
      { account_id: 1, as_of_date: "2026-09-30", quantity: 1 },
      { account_id: 3, as_of_date: "2026-10-10", quantity: 1 },
    ]);
    expectExpiredAwaitingClose(today);
  });

  it("T-PURGE-WIDE: the no-options purge removes every row (statement rows too) and the lots still read expired", () => {
    vi.setSystemTime(new Date("2026-10-18T16:00:00Z"));
    expect(purgeExpiredOptionHoldings(db)).toBe(3);
    expect(holdingsRows()).toEqual([]);
    expectExpiredAwaitingClose();
  });

  it("T-PURGE-WIDE boundary: the first moment the wide purge deletes, the lots are already expired by the Eastern day", () => {
    // 23:59 Eastern on 10-17 (UTC 03:59 on 10-18): the grace day is not over, nothing is deleted.
    vi.setSystemTime(new Date("2026-10-18T03:59:00Z"));
    expect(purgeExpiredOptionHoldings(db)).toBe(0);
    // Already expired on that Eastern day (the expired bucket is expiration < today).
    expectExpiredAwaitingClose();
    // 00:00:30 Eastern on 10-18: the purge deletes, and the lots read expired.
    vi.setSystemTime(new Date("2026-10-18T04:00:30Z"));
    expect(purgeExpiredOptionHoldings(db)).toBe(3);
    expectExpiredAwaitingClose();
  });
});
