/**
 * Plaid session-dating repair: the read-only acceptance gates (plan v4, D7)
 * and the closure check of OPEN-7. The command line is
 * `scripts/audit-plaid-session-dating.ts`.
 *
 * Inputs: the database BEFORE the repair (a backup copy), the database AFTER
 * it, and the manifest the repair applied. Nothing here writes.
 *
 * Independence. The repair's planner and apply live in
 * `lib/repair/plaid-session-dating-plan.ts`. This module imports only its
 * types and the pure helpers `rowHash` and `classifyBookClass`. G5 replays the
 * manifest on the before copy with its own small interpreter (`replayHoldings`
 * below), never the repair's `applyManifestChanges`, so a fault in the apply
 * cannot hide itself.
 *
 * Every gate returns counts (safe for a console) and details (dates, ids,
 * ratios: private, for the report file only).
 *
 * Choices this module makes where the spec leaves room (each also printed in
 * the report header):
 *  - "Plaid-mapped account": an account with a Plaid snapshot or a `plaid:`
 *    holdings row in the before copy (the repair's own rule).
 *  - Plaid era: from previousTradingDay(first Plaid run day) to the newest
 *    holdings date on those accounts in either copy.
 *  - Closing ledger row (G1 PLAID_SALE_LAG): the plain type list SELL,
 *    SELL_TO_CLOSE, REDEMPTION, EXPIRED, EXERCISED, ASSIGNED, TRANSFER_OUT. The
 *    repair does not export its rule (it reads the lot engine's routing); this
 *    list is the audit's own.
 *  - G1 universe (planner change 2026-11-26): stock, ETF and mutual fund pairs
 *    that are not cash equivalents. Bonds, options and cash equivalents are
 *    counted as PLAID_NOT_COVERED and never fail.
 */

import type Database from "better-sqlite3";
import { isMarketClosed, nextTradingDay, previousTradingDay } from "@/lib/calendar/market-holidays";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { TAX_TREATMENT_LABELS, isTaxableAccount, isTaxTreatment } from "@/lib/compute/tax-treatment";
import {
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_STMT_SUFFIX,
  STATEMENT_HOLDING_SOURCE_PREFIXES,
} from "@/lib/db/holding-sources";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { getPlaidRepeatReads } from "@/lib/plaid/session-dating";
import { reinvestmentIsPurchase } from "@/lib/queries/income-sql";
import {
  classifyBookClass,
  rowHash,
  type ActionCode,
  type BookClass,
  type DbRow,
  type ManifestLine,
  type PlaidSessionDatingManifest,
} from "@/lib/repair/plaid-session-dating-plan";

// ── Constants ────────────────────────────────────────────────────────────

export const QUANTITY_TOLERANCE = 1e-6;
/** REINVEST_LAG: Plaid plus the reinvested shares must reach the statement within this many shares. */
export const REINVEST_TOLERANCE = 1e-3;
/** G1: the Roth Plaid total over the statement total must be within this of 1. */
export const ROTH_RATIO_TOLERANCE = 0.0005;
/** G7: relative tolerance between the price in force and the statement price. */
export const FUND_PRICE_TOLERANCE = 1e-6;
/** Diagnostics: a closed-day valuation step larger than this is listed. */
export const CLOSED_DAY_STEP_BP = 50;

/** Ledger types that record shares leaving a long position (G1 PLAID_SALE_LAG). */
export const CLOSING_LEDGER_TYPES: readonly string[] = [
  "SELL",
  "SELL_TO_CLOSE",
  "REDEMPTION",
  "EXPIRED",
  "EXERCISED",
  "ASSIGNED",
  "TRANSFER_OUT",
];
/** Ledger types that add shares to a long position (G1: a missing buy). */
const BUY_LEDGER_TYPES: readonly string[] = ["BUY", "BUY_TO_OPEN"];
/** Ledger type of a dividend reinvestment purchase (lib/queries/income-sql.ts). */
const REINVEST_LEDGER_TYPE = "REINVESTMENT";
/** Trades whose dates G2 traces. */
const TRADE_TYPES: readonly string[] = [
  "BUY",
  "SELL",
  "BUY_TO_OPEN",
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "SELL_TO_CLOSE",
  "SHORT_SELL",
  "BUY_TO_COVER",
];

/** Manifest actions whose zero row `--check-repair-closures` checks (OPEN-7). */
export const CLOSURE_CHECK_ACTIONS: readonly ActionCode[] = [
  "SURVIVOR_TO_ZERO",
  "ZERO_SURVIVOR_RELABEL",
  "TOMBSTONE_MOVE",
  "TOMBSTONE_KEEP_ON_STATEMENT_DATE",
];

/** Settings keys the apply may change (G4), each checked on its own. */
const SETTINGS_TAX_GEN = "tax_input_generation";
const SETTINGS_VERSION = "plaid_dating_version";
const SETTINGS_FIRST_SESSION = "plaid_dating_first_session";

/** Tables G4 conserves. `daily_valuations` is rebuilt by the apply, so it is not here. */
export const CONSERVED_TABLES = [
  "holdings",
  "prices",
  "monthly_snapshots",
  "transactions",
  "corporate_actions",
  "import_batches",
  "settings",
] as const;

const PLAID_KEY_PREFIX = "plaid:";
const NON_STATEMENT_PRICE_SOURCES = new Set(["plaid", "tws", "manual"]);
const NON_STATEMENT_SNAPSHOT_SOURCES = new Set(["plaid", "tws", "manual"]);
const COVERED_TYPES = new Set(["stock", "etf", "mutual fund", "mutual_fund"]);
const FUND_TYPES = new Set(["mutual fund", "mutual_fund"]);
const MAX_DETAIL = 200;

// ── Result types ─────────────────────────────────────────────────────────

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";

export interface GateResult {
  id: GateId;
  title: string;
  pass: boolean;
  /** Safe for the console: counts only. */
  counts: Record<string, number>;
  /** Private: dates, ids, ratios. Report file only. */
  details: string[];
}

export interface AuditResult {
  gates: GateResult[];
  /** Private diagnostics (report only). */
  diagnostics: string[];
  pass: boolean;
}

// ── Loading ──────────────────────────────────────────────────────────────

interface HRow {
  id: number;
  accountId: number;
  securityId: number;
  quantity: number;
  date: string;
  key: string | null;
  row: DbRow;
}

interface SecurityInfo {
  symbol: string;
  type: string | null;
  fundCategory: string | null;
}

interface Account {
  id: number;
  name: string;
  role: "taxable" | "roth" | null;
}

interface BeforeBook {
  accountId: number;
  runDay: string;
  snapshot: DbRow | null;
  /** security -> quantity of the book's `plaid:` rows. */
  plaid: Map<number, number>;
  /** Securities with a live (non-statement-grade) tombstone on the book. */
  tombstones: Set<number>;
  cls: BookClass;
}

interface Ctx {
  before: Database.Database;
  after: Database.Database;
  manifest: PlaidSessionDatingManifest;
  accounts: Account[];
  accountIds: number[];
  securities: Map<number, SecurityInfo>;
  beforeRows: HRow[];
  afterRows: HRow[];
  books: Map<string, BeforeBook>;
  booksByAccount: Map<number, BeforeBook[]>;
  eraStart: string | null;
  eraEnd: string | null;
  sessions: string[];
  beforeTimeline: Timeline;
  afterTimeline: Timeline;
}

const bk = (a: number, d: string) => `${a}|${d}`;
const pk = (a: number, s: number) => `${a}|${s}`;

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function isPlaidKey(key: string | null): boolean {
  return key?.startsWith(PLAID_KEY_PREFIX) ?? false;
}

function isReconKey(key: string | null): boolean {
  return key?.startsWith(RECON_HOLDING_SOURCE_PREFIX) ?? false;
}

function isStatementKey(key: string | null): boolean {
  return key !== null && STATEMENT_HOLDING_SOURCE_PREFIXES.some((p) => key.startsWith(p));
}

/** A recon row with statement authority: `:stmt`, or unsuffixed on a date with statement rows. */
function isLiveTombstone(h: HRow, statementDates: Set<string>): boolean {
  if (!isReconKey(h.key)) return false;
  const key = h.key as string;
  if (key.endsWith(RECON_STMT_SUFFIX)) return false;
  if (key.endsWith(":live")) return true;
  return !statementDates.has(bk(h.accountId, h.date));
}

function toHRow(row: DbRow): HRow {
  return {
    id: num(row.id),
    accountId: num(row.account_id),
    securityId: num(row.security_id),
    quantity: num(row.quantity),
    date: String(row.as_of_date),
    key: str(row.source_key),
    row,
  };
}

function loadAccounts(db: Database.Database): Account[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.tax_treatment FROM accounts a
        WHERE EXISTS (SELECT 1 FROM monthly_snapshots ms WHERE ms.account_id = a.id AND ms.source = 'plaid')
           OR EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id AND h.source_key LIKE 'plaid:%')
        ORDER BY a.id`,
    )
    .all() as { id: number; name: string; tax_treatment: string | null }[];
  return rows.map((r) => {
    const t = (r.tax_treatment ?? "").trim().toLowerCase();
    const isRoth = isTaxTreatment(t) && TAX_TREATMENT_LABELS[t] === TAX_TREATMENT_LABELS.roth_ira;
    const role = isRoth ? "roth" : isTaxableAccount(r.tax_treatment) ? "taxable" : null;
    return { id: r.id, name: r.name, role };
  });
}

function loadHoldings(db: Database.Database, accountIds: number[]): HRow[] {
  if (accountIds.length === 0) return [];
  return (
    db.prepare(`SELECT * FROM holdings WHERE account_id IN (${accountIds.join(",")}) ORDER BY id`).all() as DbRow[]
  ).map(toHRow);
}

function loadSecurities(dbs: Database.Database[]): Map<number, SecurityInfo> {
  const out = new Map<number, SecurityInfo>();
  for (const db of dbs) {
    for (const s of db.prepare(`SELECT id, symbol, security_type, fund_category FROM securities`).all() as {
      id: number;
      symbol: string;
      security_type: string | null;
      fund_category: string | null;
    }[]) {
      if (!out.has(s.id)) out.set(s.id, { symbol: s.symbol, type: s.security_type, fundCategory: s.fund_category });
    }
  }
  return out;
}

/** Trading days from `start` to `end`, both included. */
export function tradingDaysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let d = isMarketClosed(start) ? nextTradingDay(start) : start;
  while (d <= end) {
    out.push(d);
    d = nextTradingDay(d);
  }
  return out;
}

// ── Per-pair timelines ───────────────────────────────────────────────────

/** Per (account, security): rows sorted by date. */
class Timeline {
  readonly byPair = new Map<string, HRow[]>();
  constructor(rows: HRow[]) {
    for (const r of rows) {
      const k = pk(r.accountId, r.securityId);
      const list = this.byPair.get(k) ?? [];
      list.push(r);
      this.byPair.set(k, list);
    }
    for (const list of this.byPair.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  }
  /** The row in force on `date` (the latest on or before it), or null. */
  rowAt(pair: string, date: string): HRow | null {
    const list = this.byPair.get(pair);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].date <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found < 0 ? null : list[found];
  }
  /** q(date): the per-pair latest quantity on or before `date`; no row reads 0. */
  q(pair: string, date: string): number {
    return this.rowAt(pair, date)?.quantity ?? 0;
  }
}

function sameQty(a: number, b: number, tol = QUANTITY_TOLERANCE): boolean {
  return Math.abs(a - b) <= tol;
}

// ── Context ──────────────────────────────────────────────────────────────

function buildContext(before: Database.Database, after: Database.Database, manifest: PlaidSessionDatingManifest): Ctx {
  const accounts = loadAccounts(before);
  const accountIds = accounts.map((a) => a.id);
  const beforeRows = loadHoldings(before, accountIds);
  const afterRows = loadHoldings(after, accountIds);
  const securities = loadSecurities([before, after]);

  const statementDates = new Set(beforeRows.filter((h) => isStatementKey(h.key)).map((h) => bk(h.accountId, h.date)));
  const books = new Map<string, BeforeBook>();
  const ensure = (a: number, d: string): BeforeBook => {
    let b = books.get(bk(a, d));
    if (!b) {
      b = { accountId: a, runDay: d, snapshot: null, plaid: new Map(), tombstones: new Set(), cls: "UNKNOWN" };
      books.set(bk(a, d), b);
    }
    return b;
  };
  if (accountIds.length > 0) {
    for (const s of before
      .prepare(`SELECT * FROM monthly_snapshots WHERE source = 'plaid' AND account_id IN (${accountIds.join(",")})`)
      .all() as DbRow[]) {
      ensure(num(s.account_id), String(s.month_end_date)).snapshot = s;
    }
  }
  for (const h of beforeRows) if (isPlaidKey(h.key)) ensure(h.accountId, h.date).plaid.set(h.securityId, h.quantity);
  for (const h of beforeRows) {
    const b = books.get(bk(h.accountId, h.date));
    if (b && isLiveTombstone(h, statementDates)) b.tombstones.add(h.securityId);
  }
  const booksByAccount = new Map<number, BeforeBook[]>();
  for (const b of books.values()) {
    b.cls = classifyBookClass(b.runDay, str(b.snapshot?.created_at), b.snapshot !== null);
    const list = booksByAccount.get(b.accountId) ?? [];
    list.push(b);
    booksByAccount.set(b.accountId, list);
  }
  for (const list of booksByAccount.values()) list.sort((a, b) => a.runDay.localeCompare(b.runDay));

  const runDays = [...books.values()].map((b) => b.runDay).sort();
  const eraStart = runDays.length > 0 ? previousTradingDay(runDays[0]) : null;
  const allDates = [...beforeRows, ...afterRows].map((h) => h.date).concat(runDays).sort();
  const eraEnd = allDates.length > 0 ? allDates[allDates.length - 1] : null;
  const sessions = eraStart && eraEnd ? tradingDaysBetween(eraStart, eraEnd) : [];

  return {
    before,
    after,
    manifest,
    accounts,
    accountIds,
    securities,
    beforeRows,
    afterRows,
    books,
    booksByAccount,
    eraStart,
    eraEnd,
    sessions,
    beforeTimeline: new Timeline(beforeRows),
    afterTimeline: new Timeline(afterRows),
  };
}

function capDetails(details: string[]): string[] {
  if (details.length <= MAX_DETAIL) return details;
  return [...details.slice(0, MAX_DETAIL), `... and ${details.length - MAX_DETAIL} more`];
}

function gate(id: GateId, title: string, pass: boolean, counts: Record<string, number>, details: string[]): GateResult {
  return { id, title, pass, counts, details: capDetails(details) };
}

// ── Ledger helpers ───────────────────────────────────────────────────────

interface LedgerRow {
  type: string;
  tradeDate: string;
  quantity: number | null;
  amount: number | null;
  sourceKey: string | null;
}

function ledgerFor(db: Database.Database): (accountId: number, securityId: number, after: string | null, onOrBefore: string) => LedgerRow[] {
  const stmt = db.prepare(
    `SELECT type, trade_date, quantity, amount, source_key FROM transactions
      WHERE account_id = ? AND security_id = ? AND trade_date > ? AND trade_date <= ?
      ORDER BY trade_date, id`,
  );
  return (accountId, securityId, after, onOrBefore) =>
    (stmt.all(accountId, securityId, after ?? "", onOrBefore) as {
      type: string;
      trade_date: string;
      quantity: number | null;
      amount: number | null;
      source_key: string | null;
    }[]).map((r) => ({
      type: r.type.trim().toUpperCase(),
      tradeDate: r.trade_date,
      quantity: r.quantity,
      amount: r.amount,
      sourceKey: r.source_key,
    }));
}

/** Signed reinvested shares of one REINVESTMENT row: a purchase adds, a reversal takes away. */
function reinvestedShares(r: LedgerRow): number {
  const q = Math.abs(r.quantity ?? 0);
  if (!r.amount) return 0;
  return reinvestmentIsPurchase(r.amount, r.sourceKey) ? q : -q;
}

// ── G1 Statement reconciliation ──────────────────────────────────────────

/** The close a statement dated M holds: M on a trading day, else previousTradingDay(M). */
export function statementSession(m: string): string {
  return isMarketClosed(m) ? previousTradingDay(m) : m;
}

function coverageClass(sec: SecurityInfo | undefined): string | null {
  if (!sec) return "unknown security";
  if (isCashEquivalentSecurity({ security_type: sec.type, fund_category: sec.fundCategory })) return "cash equivalent";
  const t = (sec.type ?? "").trim().toLowerCase();
  if (COVERED_TYPES.has(t)) return null;
  return t || "untyped";
}

function gateG1(ctx: Ctx): GateResult {
  const details: string[] = [];
  const counts: Record<string, number> = {
    accounts: 0,
    statementDates: 0,
    pairsCompared: 0,
    matched: 0,
    PLAID_NOT_COVERED: 0,
    PLAID_SALE_LAG: 0,
    REINVEST_LAG: 0,
    PLAID_PERSISTENT_GAP: 0,
    missingBuy: 0,
    unexplainedDifference: 0,
    noDescribingBook: 0,
    rothRatioFail: 0,
  };
  const ledger = ledgerFor(ctx.before);
  const notCovered = new Map<string, number>();
  if (!ctx.eraStart) {
    details.push("No Plaid books in the before copy: nothing to reconcile.");
    return gate("G1", "Statement reconciliation", true, counts, details);
  }

  for (const account of ctx.accounts) {
    const books = ctx.booksByAccount.get(account.id) ?? [];
    if (books.length === 0) continue;
    counts.accounts++;
    const lastRunDay = books[books.length - 1].runDay;
    const stmtRows = ctx.beforeRows.filter((h) => h.accountId === account.id && isStatementKey(h.key));
    const allDates = [...new Set(stmtRows.map((h) => h.date))].sort();

    interface Cmp {
      m: string;
      s: string;
      prior: string | null;
      plaid: number;
      stmt: number;
    }
    const byPair = new Map<number, Cmp[]>();
    const eraDates: { m: string; s: string; d: string; prior: string | null }[] = [];
    for (let i = 0; i < allDates.length; i++) {
      const m = allDates[i];
      const s = statementSession(m);
      const d = nextTradingDay(s);
      if (s < ctx.eraStart || d > lastRunDay) continue;
      eraDates.push({ m, s, d, prior: i > 0 ? allDates[i - 1] : null });
    }

    for (const { m, s, d, prior } of eraDates) {
      counts.statementDates++;
      const book = ctx.books.get(bk(account.id, d));
      if (!book || book.cls !== "PRE_OPEN") {
        counts.noDescribingBook++;
        details.push(
          `FAIL account ${account.id} statement ${m}: no PRE_OPEN book of run day ${d} describes the ${s} close (${book ? book.cls : "no book"})`,
        );
        continue;
      }
      const stmtQty = new Map<number, number>();
      for (const h of stmtRows) if (h.date === m) stmtQty.set(h.securityId, h.quantity);
      for (const secId of new Set([...stmtQty.keys(), ...book.plaid.keys()])) {
        const plaid = book.plaid.get(secId) ?? 0;
        const stmt = stmtQty.get(secId) ?? 0;
        const cls = coverageClass(ctx.securities.get(secId));
        if (cls !== null) {
          if (plaid !== 0 || stmt !== 0) {
            counts.PLAID_NOT_COVERED++;
            notCovered.set(cls, (notCovered.get(cls) ?? 0) + 1);
          }
          continue;
        }
        const list = byPair.get(secId) ?? [];
        list.push({ m, s, prior, plaid, stmt });
        byPair.set(secId, list);
      }

      // Totals.
      const stmtSnap = ctx.before
        .prepare(`SELECT total_value, source FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?`)
        .get(account.id, m) as { total_value: number; source: string | null } | undefined;
      const plaidTotal = book.snapshot ? num(book.snapshot.total_value) : null;
      const stmtTotal =
        stmtSnap && stmtSnap.source !== null && !NON_STATEMENT_SNAPSHOT_SOURCES.has(stmtSnap.source) ? stmtSnap.total_value : null;
      const ratio = plaidTotal !== null && stmtTotal ? plaidTotal / stmtTotal : null;
      if (account.role === "roth") {
        const ok = ratio !== null && Math.abs(ratio - 1) <= ROTH_RATIO_TOLERANCE;
        if (!ok) counts.rothRatioFail++;
        details.push(
          `${ok ? "ok  " : "FAIL"} account ${account.id} (Roth) statement ${m}: total ratio ${ratio === null ? "n/a (a total is missing)" : ratio.toFixed(6)} (gated within ${ROTH_RATIO_TOLERANCE})`,
        );
      } else {
        details.push(
          `info account ${account.id} (${account.role ?? "no role"}) statement ${m}: total ratio ${ratio === null ? "n/a" : ratio.toFixed(6)} (reported, not gated; OPEN-4)`,
        );
      }
    }

    // Classify each pair's differences.
    for (const [secId, list] of byPair) {
      const bothHeld = list.filter((c) => c.plaid !== 0 && c.stmt !== 0);
      const persistent = bothHeld.length >= 2 && bothHeld.every((c) => !sameQty(c.plaid, c.stmt));
      for (const c of list) {
        counts.pairsCompared++;
        if (sameQty(c.plaid, c.stmt)) {
          counts.matched++;
          continue;
        }
        const where = `account ${account.id} security ${secId} statement ${c.m} (close ${c.s}): plaid ${c.plaid} statement ${c.stmt}`;
        const rows = ledger(account.id, secId, c.prior, c.s);
        if (c.plaid > c.stmt && rows.some((r) => CLOSING_LEDGER_TYPES.includes(r.type))) {
          counts.PLAID_SALE_LAG++;
          details.push(`PLAID_SALE_LAG ${where}`);
          continue;
        }
        if (c.stmt > c.plaid) {
          const reinvest = rows.filter((r) => r.type === REINVEST_LEDGER_TYPE);
          if (reinvest.length > 0) {
            const shares = reinvest.reduce((acc, r) => acc + reinvestedShares(r), 0);
            if (sameQty(c.plaid + shares, c.stmt, REINVEST_TOLERANCE)) {
              counts.REINVEST_LAG++;
              details.push(`REINVEST_LAG ${where}; reinvested ${shares}`);
              continue;
            }
          }
          const bought = rows.filter((r) => BUY_LEDGER_TYPES.includes(r.type)).reduce((acc, r) => acc + Math.abs(r.quantity ?? 0), 0);
          if (bought > 0 && sameQty(c.plaid + bought, c.stmt, REINVEST_TOLERANCE)) {
            counts.missingBuy++;
            details.push(`FAIL missing buy: ${where}; bought ${bought} in the statement period`);
            continue;
          }
        }
        if (persistent) {
          counts.PLAID_PERSISTENT_GAP++;
          details.push(`PLAID_PERSISTENT_GAP (OPEN-4) ${where}`);
          continue;
        }
        counts.unexplainedDifference++;
        details.push(`FAIL difference: ${where}`);
      }
    }
  }
  for (const [cls, n] of [...notCovered].sort()) details.push(`PLAID_NOT_COVERED ${cls}: ${n} pair-date(s)`);
  const pass =
    counts.missingBuy === 0 && counts.unexplainedDifference === 0 && counts.noDescribingBook === 0 && counts.rothRatioFail === 0;
  return gate("G1", "Statement reconciliation", pass, counts, details);
}

// ── G2 Trade dates ───────────────────────────────────────────────────────

/**
 * G2 fails when fewer than this share of gated trades first show on their
 * trade date. A one-session dating error makes the share near zero (every
 * trade then shows one book late); the repaired real data measured 0.84, the
 * rest explained by dropped books and Plaid's own trade lag.
 */
export const G2_MIN_ON_TRADE_DATE_SHARE = 0.75;

export type TradeDateClass =
  | "ON_TRADE_DATE"
  /** No book on the trade date (it was dropped) and no book between it and the first showing. */
  | "SESSION_BOOK_DROPPED"
  /** A book on the trade date does not show the trade; the next book does (one book late). */
  | "PLAID_TRADE_LAG"
  /** At least one whole book between the trade date and the first showing. */
  | "LATE"
  /** The new quantity shows before the trade date. */
  | "EARLY"
  /** No session shows the new quantity. */
  | "NEVER_SHOWN";

const G2_CLASSES: readonly TradeDateClass[] = ["ON_TRADE_DATE", "SESSION_BOOK_DROPPED", "PLAID_TRADE_LAG", "LATE", "EARLY", "NEVER_SHOWN"];

/** Dates of the Plaid books and statement books per account in one copy. */
function bookDatesByAccount(rows: HRow[], db: Database.Database, accountIds: number[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const add = (a: number, d: string) => {
    const set = out.get(a) ?? new Set<string>();
    set.add(d);
    out.set(a, set);
  };
  for (const h of rows) if (isPlaidKey(h.key) || isStatementKey(h.key)) add(h.accountId, h.date);
  if (accountIds.length > 0) {
    for (const r of db
      .prepare(`SELECT account_id, month_end_date FROM monthly_snapshots WHERE source = 'plaid' AND account_id IN (${accountIds.join(",")})`)
      .all() as { account_id: number; month_end_date: string }[]) {
      add(r.account_id, r.month_end_date);
    }
  }
  return out;
}

/**
 * Classifies one trade on one copy: where the new quantity first shows,
 * against the book dates of that copy. The first showing is the date of the
 * row in force at the first session (after the last session that does not
 * hold the new quantity before the trade) that holds it.
 */
function classifyTradeDate(
  timeline: Timeline,
  sessions: string[],
  bookDates: Set<string>,
  pair: string,
  tradeDate: string,
  newQty: number,
): { cls: TradeDateClass; shown: string | null; lateBooks: number } {
  const expected = isMarketClosed(tradeDate) ? nextTradingDay(tradeDate) : tradeDate;
  const prior = sessions.filter((s) => s < expected);
  let startIdx = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (!sameQty(timeline.q(pair, prior[i]), newQty)) {
      startIdx = i + 1;
      break;
    }
  }
  let shown: string | null = null;
  for (let i = startIdx; i < sessions.length; i++) {
    if (sameQty(timeline.q(pair, sessions[i]), newQty)) {
      const row = timeline.rowAt(pair, sessions[i]);
      shown = row ? row.date : sessions[i];
      break;
    }
  }
  if (shown === null) return { cls: "NEVER_SHOWN", shown, lateBooks: 0 };
  if (shown < tradeDate) return { cls: "EARLY", shown, lateBooks: 0 };
  if (shown <= expected) return { cls: "ON_TRADE_DATE", shown, lateBooks: 0 };
  const lateBooks = [...bookDates].filter((d) => d > tradeDate && d < shown).length;
  if (lateBooks >= 1) return { cls: "LATE", shown, lateBooks };
  return { cls: bookDates.has(expected) ? "PLAID_TRADE_LAG" : "SESSION_BOOK_DROPPED", shown, lateBooks };
}

function gateG2(ctx: Ctx): GateResult {
  const details: string[] = [];
  const counts: Record<string, number> = { traced: 0, gated: 0, notGated: 0, notSeen: 0 };
  for (const c of G2_CLASSES) counts[c] = 0;
  counts.onTradeDatePct = 0;
  counts.beforeOnTradeDatePct = 0;
  if (!ctx.eraStart || !ctx.eraEnd || ctx.accountIds.length === 0) {
    return gate("G2", "Trade dates", true, counts, ["No Plaid era."]);
  }
  const trades = ctx.before
    .prepare(
      `SELECT account_id, security_id, trade_date, type FROM transactions
        WHERE account_id IN (${ctx.accountIds.join(",")}) AND trade_date >= ? AND trade_date <= ?
        ORDER BY trade_date, id`,
    )
    .all(ctx.eraStart, ctx.eraEnd) as { account_id: number; security_id: number; trade_date: string; type: string }[];
  const afterBooks = bookDatesByAccount(ctx.afterRows, ctx.after, ctx.accountIds);
  const beforeBooks = bookDatesByAccount(ctx.beforeRows, ctx.before, ctx.accountIds);
  let beforeOnDate = 0;
  for (const tr of trades) {
    if (!TRADE_TYPES.includes(tr.type.trim().toUpperCase())) continue;
    counts.traced++;
    const books = (ctx.booksByAccount.get(tr.account_id) ?? []).filter((b) => b.snapshot !== null);
    const qOf = (b: BeforeBook) => b.plaid.get(tr.security_id) ?? 0;
    const base = [...books].reverse().find((b) => b.runDay <= tr.trade_date && b.cls === "PRE_OPEN");
    const baseQty = base ? qOf(base) : 0;
    const first = books.find((b) => b.runDay > tr.trade_date && !sameQty(qOf(b), baseQty));
    const where = `account ${tr.account_id} security ${tr.security_id} ${tr.type} ${tr.trade_date}`;
    if (!first) {
      counts.notSeen++;
      details.push(`info ${where}: no later book shows a new quantity`);
      continue;
    }
    if (first.cls !== "PRE_OPEN") {
      counts.notGated++;
      details.push(`info ${where}: first book showing it is run day ${first.runDay} (${first.cls}); not gated`);
      continue;
    }
    counts.gated++;
    const newQty = qOf(first);
    const pair = pk(tr.account_id, tr.security_id);
    const r = classifyTradeDate(ctx.afterTimeline, ctx.sessions, afterBooks.get(tr.account_id) ?? new Set(), pair, tr.trade_date, newQty);
    counts[r.cls]++;
    const b = classifyTradeDate(ctx.beforeTimeline, ctx.sessions, beforeBooks.get(tr.account_id) ?? new Set(), pair, tr.trade_date, newQty);
    if (b.cls === "ON_TRADE_DATE") beforeOnDate++;
    if (r.cls !== "ON_TRADE_DATE") {
      const bad = r.cls === "LATE" || r.cls === "EARLY" || r.cls === "NEVER_SHOWN";
      details.push(
        `${bad ? "FAIL" : "info"} ${r.cls} ${where}: new quantity ${newQty} first shows on ${r.shown ?? "no date"} after the repair` +
          (r.cls === "LATE" ? ` (${r.lateBooks} book(s) in between)` : "") +
          `; before the repair: ${b.cls} on ${b.shown ?? "no date"}`,
      );
    }
  }
  const share = counts.gated > 0 ? counts.ON_TRADE_DATE / counts.gated : null;
  const beforeShare = counts.gated > 0 ? beforeOnDate / counts.gated : null;
  counts.onTradeDatePct = share === null ? 0 : Math.round(share * 100);
  counts.beforeOnTradeDatePct = beforeShare === null ? 0 : Math.round(beforeShare * 100);
  details.unshift(
    `On the trade date: after the repair ${share === null ? "n/a" : share.toFixed(3)}, before it ${beforeShare === null ? "n/a" : beforeShare.toFixed(3)} ` +
      `(gated within ${G2_MIN_ON_TRADE_DATE_SHARE} after the repair; the before figure is for contrast)`,
  );
  const shareOk = share === null || share >= G2_MIN_ON_TRADE_DATE_SHARE;
  if (!shareOk) details.push(`FAIL the on-trade-date share ${share?.toFixed(3)} is under ${G2_MIN_ON_TRADE_DATE_SHARE}`);
  const pass = counts.EARLY === 0 && counts.LATE === 0 && counts.NEVER_SHOWN === 0 && shareOk;
  return gate("G2", "Trade dates", pass, counts, details);
}

// ── G3 No statement rows and non-zero Plaid rows on one (account, date) ──

function gateG3(ctx: Ctx): GateResult {
  const details: string[] = [];
  const counts: Record<string, number> = { conflicts: 0, cashEquivalentListed: 0 };
  const stmtDates = new Set(ctx.afterRows.filter((h) => isStatementKey(h.key)).map((h) => bk(h.accountId, h.date)));
  for (const h of ctx.afterRows) {
    if (!isPlaidKey(h.key) || h.quantity === 0 || !stmtDates.has(bk(h.accountId, h.date))) continue;
    const sec = ctx.securities.get(h.securityId);
    if (sec && isCashEquivalentSecurity({ security_type: sec.type, fund_category: sec.fundCategory })) {
      counts.cashEquivalentListed++;
      details.push(`listed (cash equivalent) account ${h.accountId} security ${h.securityId} ${h.date}`);
      continue;
    }
    counts.conflicts++;
    details.push(`FAIL account ${h.accountId} ${h.date}: statement rows and a non-zero Plaid row (security ${h.securityId}, holdings #${h.id})`);
  }
  return gate("G3", "No statement and Plaid rows on one date", counts.conflicts === 0, counts, details);
}

// ── G4 Conservation ──────────────────────────────────────────────────────

function primaryKeyOf(db: Database.Database, table: string): string | null {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  const pkCols = cols.filter((c) => c.pk > 0);
  return pkCols.length === 1 ? pkCols[0].name : null;
}

function rowsByKey(db: Database.Database, table: string, key: string): Map<string, DbRow> {
  const out = new Map<string, DbRow>();
  for (const r of db.prepare(`SELECT * FROM ${table}`).all() as DbRow[]) out.set(String(r[key]), r);
  return out;
}

function gateG4(ctx: Ctx): GateResult {
  const details: string[] = [];
  const counts: Record<string, number> = { tablesChecked: 0, rowsChecked: 0, namedRowsChecked: 0, differences: 0 };
  const fail = (msg: string) => {
    counts.differences++;
    details.push(`FAIL ${msg}`);
  };
  const named = new Map<string, Map<string, ManifestLine>>();
  for (const l of ctx.manifest.lines) {
    if (!l.table || l.id === undefined) continue;
    const m = named.get(l.table) ?? new Map<string, ManifestLine>();
    if (m.has(String(l.id))) fail(`the manifest names ${l.table} #${l.id} more than once`);
    m.set(String(l.id), l);
    named.set(l.table, m);
  }

  for (const table of CONSERVED_TABLES) {
    const inBefore = tableExists(ctx.before, table);
    const inAfter = tableExists(ctx.after, table);
    if (!inBefore && !inAfter) continue;
    if (inBefore !== inAfter) {
      fail(`table ${table} exists in only one copy`);
      continue;
    }
    counts.tablesChecked++;
    const key = primaryKeyOf(ctx.before, table);
    if (key === null) {
      fail(`table ${table} has no single-column primary key`);
      continue;
    }
    const b = rowsByKey(ctx.before, table, key);
    const a = rowsByKey(ctx.after, table, key);
    const lines = named.get(table) ?? new Map<string, ManifestLine>();
    const exempt = table === "settings" ? new Set([SETTINGS_TAX_GEN, SETTINGS_VERSION, SETTINGS_FIRST_SESSION]) : new Set<string>();
    for (const k of new Set([...b.keys(), ...a.keys()])) {
      if (exempt.has(k)) continue;
      const line = lines.get(k);
      const br = b.get(k);
      const ar = a.get(k);
      if (line) {
        counts.namedRowsChecked++;
        if (!br) {
          fail(`${table} #${k} is named in the manifest but absent from the before copy`);
          continue;
        }
        if (line.hash && rowHash(br) !== line.hash) fail(`${table} #${k}: the before copy differs from the manifest's hash`);
        if (line.kind === "CHANGE") {
          if (line.old && rowHash(br) !== rowHash(line.old)) fail(`${table} #${k}: the before copy differs from the manifest's old row`);
          if (line.new === null || line.new === undefined) {
            if (ar) fail(`${table} #${k}: the manifest deletes it but the after copy still has it`);
          } else if (!ar) {
            fail(`${table} #${k}: missing from the after copy (expected the manifest's new row)`);
          } else if (rowHash(ar) !== rowHash(line.new)) {
            fail(`${table} #${k}: the after copy differs from the manifest's new row`);
          }
        } else if (!ar || rowHash(ar) !== rowHash(br)) {
          fail(`${table} #${k}: a ${line.kind} row changed`);
        }
        continue;
      }
      counts.rowsChecked++;
      if (br && !ar) fail(`${table} #${k}: deleted outside the manifest`);
      else if (!br && ar) fail(`${table} #${k}: added outside the manifest`);
      else if (br && ar && rowHash(br) !== rowHash(ar)) fail(`${table} #${k}: changed outside the manifest`);
    }
    if (table === "settings") {
      const gen = getTaxInputGeneration(ctx.after);
      if (gen !== ctx.manifest.predicted.taxInputGenerationAfter) {
        fail(`settings ${SETTINGS_TAX_GEN} is ${gen}, the manifest predicted ${ctx.manifest.predicted.taxInputGenerationAfter}`);
      }
      const version = a.get(SETTINGS_VERSION);
      if (!version || String(version.value) !== "2") fail(`settings ${SETTINGS_VERSION} is not 2`);
      if (a.has(SETTINGS_FIRST_SESSION)) fail(`settings ${SETTINGS_FIRST_SESSION} is still present`);
    }
  }
  return gate("G4", "Conservation", counts.differences === 0, counts, details);
}

// ── G5 Per-pair history by replay ────────────────────────────────────────

/**
 * The audit's own interpreter: applies the manifest's holdings lines to the
 * before copy's rows in memory. A CHANGE line with a null new row deletes;
 * with a new row replaces the row by id; every other line keeps the row.
 * Returns the replayed rows and any line that does not match the before copy.
 */
export function replayHoldings(beforeRows: HRowLike[], manifest: PlaidSessionDatingManifest): { rows: DbRow[]; mismatches: string[] } {
  const byId = new Map<number, DbRow>();
  for (const r of beforeRows) byId.set(num(r.id), r);
  const mismatches: string[] = [];
  for (const l of manifest.lines) {
    if (l.table !== "holdings" || l.id === undefined) continue;
    const cur = byId.get(l.id);
    if (!cur) {
      mismatches.push(`holdings #${l.id} named by the manifest is not in the before copy`);
      continue;
    }
    if (l.hash && rowHash(cur) !== l.hash) mismatches.push(`holdings #${l.id} differs from the manifest's hash`);
    if (l.kind !== "CHANGE") continue;
    if (l.new === null || l.new === undefined) byId.delete(l.id);
    else byId.set(l.id, { ...l.new, id: l.id });
  }
  return { rows: [...byId.values()], mismatches };
}

/** A holdings row as stored (all columns). */
export type HRowLike = DbRow;

const MOVING_BOOK_ACTIONS = new Set(["MOVE_BOOK", "DROP_STATEMENT_TARGET", "DROP_DUPLICATE_SESSION", "DROP_BY_RULING"]);

function gateG5(ctx: Ctx): GateResult {
  const details: string[] = [];
  const counts: Record<string, number> = {
    pairs: 0,
    sessions: ctx.sessions.length,
    replayMismatches: 0,
    manifestMismatches: 0,
    moveBookChecks: 0,
    moveBookFailures: 0,
    closures: 0,
    closureFailures: 0,
    reopenChecks: 0,
    reopenFailures: 0,
  };
  const { rows: replayRows, mismatches } = replayHoldings(
    ctx.beforeRows.map((h) => h.row),
    ctx.manifest,
  );
  counts.manifestMismatches = mismatches.length;
  for (const m of mismatches) details.push(`FAIL ${m}`);
  const replay = new Timeline(replayRows.filter((r) => ctx.accountIds.includes(num(r.account_id))).map(toHRow));
  const replayById = new Map(replayRows.map((r) => [num(r.id), r]));
  const after = ctx.afterTimeline;

  // Main check: q_after(s) = q_replay(s) on every session.
  const pairs = new Set([...replay.byPair.keys(), ...after.byPair.keys()]);
  counts.pairs = pairs.size;
  for (const pair of [...pairs].sort()) {
    let reported = 0;
    for (const s of ctx.sessions) {
      const qa = after.q(pair, s);
      const qr = replay.q(pair, s);
      if (!sameQty(qa, qr)) {
        counts.replayMismatches++;
        if (reported++ < 5) details.push(`FAIL pair ${pair} session ${s}: after ${qa}, replayed manifest ${qr}`);
      }
    }
  }

  // Book actions by (account, run day), and each holdings line's book.
  const bookAction = new Map<string, string>();
  for (const b of ctx.manifest.books) bookAction.set(bk(b.accountId, b.runDay), b.action);
  const lineById = new Map<number, ManifestLine>();
  for (const l of ctx.manifest.lines) if (l.table === "holdings" && l.id !== undefined) lineById.set(l.id, l);

  // (a) every MOVE_BOOK from d to t: q_after(t) = q_before(d) for the book's pairs.
  for (const b of ctx.manifest.books) {
    if (b.action !== "MOVE_BOOK") continue;
    const t = previousTradingDay(b.runDay);
    const book = ctx.books.get(bk(b.accountId, b.runDay));
    if (!book) {
      counts.moveBookFailures++;
      details.push(`FAIL (a) MOVE_BOOK ${b.accountId} ${b.runDay}: no such book in the before copy`);
      continue;
    }
    for (const secId of new Set([...book.plaid.keys(), ...book.tombstones])) {
      counts.moveBookChecks++;
      const pair = pk(b.accountId, secId);
      const qb = ctx.beforeTimeline.q(pair, b.runDay);
      const qa = after.q(pair, t);
      if (!sameQty(qa, qb)) {
        counts.moveBookFailures++;
        details.push(`FAIL (a) MOVE_BOOK ${b.accountId} ${b.runDay} -> ${t} security ${secId}: before ${qb}, after ${qa}`);
      }
    }
  }

  // (b) every closure in the before copy appears in the after copy on its expected date, never later.
  for (const [pair, list] of ctx.beforeTimeline.byPair) {
    for (let i = 1; i < list.length; i++) {
      const r = list[i];
      if (r.quantity !== 0 || list[i - 1].quantity === 0) continue;
      counts.closures++;
      const line = lineById.get(r.id);
      let expected = r.date;
      let how = "unchanged";
      if (line && line.rule.startsWith("book:")) {
        const [, acct, runDay] = line.rule.split(":");
        const action = bookAction.get(bk(Number(acct), runDay));
        if (action && MOVING_BOOK_ACTIONS.has(action)) {
          expected = previousTradingDay(runDay);
          how = `${action} / ${line.action}`;
        }
      }
      const qa = after.q(pair, expected);
      if (!sameQty(qa, 0)) {
        counts.closureFailures++;
        details.push(`FAIL (b) closure of pair ${pair} recorded on ${r.date} (#${r.id}, ${how}) does not read 0 on ${expected} after the repair (reads ${qa})`);
      }
    }
  }

  // (c) a pair that reads 0 on a statement date reads non-zero later only through a row both copies hold.
  const stmtDates = new Map<number, string[]>();
  for (const h of ctx.afterRows) {
    if (!isStatementKey(h.key)) continue;
    const list = stmtDates.get(h.accountId) ?? [];
    if (!list.includes(h.date)) list.push(h.date);
    stmtDates.set(h.accountId, list);
  }
  for (const pair of after.byPair.keys()) {
    const accountId = Number(pair.split("|")[0]);
    for (const m of stmtDates.get(accountId) ?? []) {
      if (!sameQty(after.q(pair, m), 0)) continue;
      const seen = new Set<number>();
      for (const s of ctx.sessions) {
        if (s <= m) continue;
        const row = after.rowAt(pair, s);
        if (!row || row.quantity === 0 || seen.has(row.id)) continue;
        seen.add(row.id);
        counts.reopenChecks++;
        const replayed = replayById.get(row.id);
        const inBefore = ctx.beforeRows.some((h) => h.id === row.id);
        if (!inBefore || !replayed || String(replayed.as_of_date) !== row.date || !sameQty(num(replayed.quantity), row.quantity)) {
          counts.reopenFailures++;
          details.push(`FAIL (c) pair ${pair} reads 0 on statement date ${m} but non-zero on ${s} through holdings #${row.id}, which the before copy (as moved) does not hold there`);
        }
      }
    }
  }

  const pass =
    counts.replayMismatches === 0 &&
    counts.manifestMismatches === 0 &&
    counts.moveBookFailures === 0 &&
    counts.closureFailures === 0 &&
    counts.reopenFailures === 0;
  return gate("G5", "Per-pair history by replay", pass, counts, details);
}

// ── G6 Trading days ──────────────────────────────────────────────────────

function gateG6(ctx: Ctx): GateResult {
  const details: string[] = [];
  const counts: Record<string, number> = { holdings: 0, snapshots: 0, prices: 0, onClosedDays: 0 };
  const check = (kind: "holdings" | "snapshots" | "prices", id: number, date: string) => {
    counts[kind]++;
    if (isMarketClosed(date)) {
      counts.onClosedDays++;
      details.push(`FAIL Plaid ${kind} #${id} dated ${date}, a closed day`);
    }
  };
  for (const r of ctx.after.prepare(`SELECT id, as_of_date FROM holdings WHERE source_key LIKE 'plaid:%'`).all() as { id: number; as_of_date: string }[]) {
    check("holdings", r.id, r.as_of_date);
  }
  for (const r of ctx.after.prepare(`SELECT id, month_end_date FROM monthly_snapshots WHERE source = 'plaid'`).all() as { id: number; month_end_date: string }[]) {
    check("snapshots", r.id, r.month_end_date);
  }
  for (const r of ctx.after.prepare(`SELECT id, date FROM prices WHERE source = 'plaid'`).all() as { id: number; date: string }[]) {
    check("prices", r.id, r.date);
  }
  return gate("G6", "Plaid rows on trading days", counts.onClosedDays === 0, counts, details);
}

// ── G7 Fund prices against statement prices ──────────────────────────────

function gateG7(ctx: Ctx): GateResult {
  const details: string[] = [];
  const counts: Record<string, number> = { funds: 0, statementPrices: 0, checks: 0, mismatches: 0 };
  const funds = (
    ctx.before.prepare(`SELECT DISTINCT security_id AS id FROM prices WHERE source = 'plaid'`).all() as { id: number }[]
  )
    .map((r) => r.id)
    .filter((id) => FUND_TYPES.has((ctx.securities.get(id)?.type ?? "").trim().toLowerCase()))
    .sort((a, b) => a - b);
  counts.funds = funds.length;
  const inForce = ctx.after.prepare(
    `SELECT date, close_price, source FROM prices WHERE security_id = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
  );
  for (const id of funds) {
    const stmtPrices = (
      ctx.before.prepare(`SELECT date, close_price, source FROM prices WHERE security_id = ? AND date >= ? ORDER BY date`).all(
        id,
        ctx.eraStart ?? "",
      ) as { date: string; close_price: number; source: string | null }[]
    ).filter((p) => p.source !== null && !NON_STATEMENT_PRICE_SOURCES.has(p.source));
    for (const p of stmtPrices) {
      counts.statementPrices++;
      const dates = [p.date];
      if (isMarketClosed(p.date)) dates.push(previousTradingDay(p.date));
      for (const d of dates) {
        counts.checks++;
        const f = inForce.get(id, d) as { date: string; close_price: number; source: string | null } | undefined;
        const rel = f ? Math.abs(f.close_price - p.close_price) / Math.max(Math.abs(p.close_price), Number.MIN_VALUE) : Infinity;
        if (!(rel <= FUND_PRICE_TOLERANCE)) {
          counts.mismatches++;
          details.push(
            `FAIL fund ${id} statement ${p.date} price ${p.close_price}: in force on ${d} after the repair is ${f ? `${f.close_price} (${f.source ?? "no source"}, dated ${f.date})` : "nothing"}`,
          );
        }
      }
    }
  }
  const nothingChecked = funds.length > 0 && counts.checks === 0;
  if (nothingChecked) details.push("FAIL funds have Plaid prices but no statement price in the Plaid era was found to check");
  return gate("G7", "Fund prices against statements", counts.mismatches === 0 && !nothingChecked, counts, details);
}

// ── Diagnostics (report only) ────────────────────────────────────────────

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function accountDiagnostics(db: Database.Database, label: string, accountId: number, eraStart: string): string[] {
  const out: string[] = [];
  if (!tableExists(db, "daily_valuations")) return [`  ${label}: no daily_valuations table`];
  const vals = db
    .prepare(`SELECT valuation_date AS d, total_value AS v FROM daily_valuations WHERE account_id = ? AND valuation_date >= ? ORDER BY valuation_date`)
    .all(accountId, eraStart) as { d: string; v: number }[];
  if (vals.length < 3) return [`  ${label}: fewer than 3 daily valuations in the Plaid era`];
  const spy = new Map<string, number>();
  if (tableExists(db, "benchmark_prices")) {
    for (const r of db.prepare(`SELECT date, close_price FROM benchmark_prices WHERE symbol = 'SPY' AND date >= ?`).all(previousTradingDay(eraStart)) as {
      date: string;
      close_price: number;
    }[]) {
      spy.set(r.date, r.close_price);
    }
  }
  const spyDates = [...spy.keys()].sort();
  const spyRet = new Map<string, number>();
  for (let i = 1; i < spyDates.length; i++) spyRet.set(spyDates[i], Math.log(spy.get(spyDates[i])! / spy.get(spyDates[i - 1])!));
  const sameX: number[] = [];
  const sameY: number[] = [];
  const priorX: number[] = [];
  const priorY: number[] = [];
  let closedSteps = 0;
  for (let i = 1; i < vals.length; i++) {
    const prev = vals[i - 1].v;
    if (!(prev > 0) || !(vals[i].v > 0)) continue;
    const r = Math.log(vals[i].v / prev);
    if (isMarketClosed(vals[i].d) && Math.abs(r) * 1e4 > CLOSED_DAY_STEP_BP) {
      closedSteps++;
      out.push(`  ${label}: closed-day step on ${vals[i].d}: ${(r * 1e4).toFixed(1)} bp`);
    }
    const same = spyRet.get(vals[i].d);
    if (same !== undefined) {
      sameX.push(r);
      sameY.push(same);
    }
    const prior = spyRet.get(previousTradingDay(vals[i].d));
    if (prior !== undefined) {
      priorX.push(r);
      priorY.push(prior);
    }
  }
  const beta = (() => {
    const n = sameX.length;
    if (n < 3) return null;
    const mx = sameX.reduce((a, b) => a + b, 0) / n;
    const my = sameY.reduce((a, b) => a + b, 0) / n;
    let cov = 0;
    let v = 0;
    for (let i = 0; i < n; i++) {
      cov += (sameX[i] - mx) * (sameY[i] - my);
      v += (sameY[i] - my) ** 2;
    }
    return v > 0 ? cov / v : null;
  })();
  const fmt = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  out.unshift(
    `  ${label}: correlation with SPY same day ${fmt(pearson(sameX, sameY))} (${sameX.length} days), prior day ${fmt(
      pearson(priorX, priorY),
    )} (${priorX.length} days); beta (same day, not flow-adjusted) ${fmt(beta)}; closed-day steps over ${CLOSED_DAY_STEP_BP} bp: ${closedSteps}`,
  );
  return out;
}

function riskVolatility(db: Database.Database, accountId: number): string {
  try {
    const m = computeRiskMetrics(db, { accountId });
    return m.volatility === null ? "n/a" : m.volatility.toFixed(4);
  } catch (err) {
    return `not computed (${err instanceof Error ? err.message : String(err)})`;
  }
}

function diagnostics(ctx: Ctx): string[] {
  const out: string[] = [];
  if (!ctx.eraStart) return ["No Plaid era: no diagnostics."];
  for (const a of ctx.accounts) {
    out.push(`Account ${a.id} (${a.role ?? "no role"}):`);
    out.push(...accountDiagnostics(ctx.before, "before", a.id, ctx.eraStart));
    out.push(...accountDiagnostics(ctx.after, "after", a.id, ctx.eraStart));
    out.push(`  annualised volatility (computeRiskMetrics): before ${riskVolatility(ctx.before, a.id)}, after ${riskVolatility(ctx.after, a.id)}`);
  }
  out.push("Repeat reads in the manifest (REPEAT_READ, listed only):");
  const repeats = ctx.manifest.lines.filter((l) => l.action === "REPEAT_READ");
  if (repeats.length === 0) out.push("  none");
  for (const l of repeats) out.push(`  ${l.rule}: ${l.reason ?? ""}`);
  try {
    const now = getPlaidRepeatReads(ctx.after);
    out.push(`Repeat-read check on the after copy (two newest books): ${now.length === 0 ? "none" : now.map((r) => `${r.accountId} ${r.previousSession}->${r.session}`).join(", ")}`);
  } catch (err) {
    out.push(`Repeat-read check on the after copy: not run (${err instanceof Error ? err.message : String(err)})`);
  }
  out.push("Not computed here: the monthly index against statement TWR (use the Performance view on the after copy).");
  return out;
}

// ── Entry points ─────────────────────────────────────────────────────────

/** Runs G1-G7 and the diagnostics. Read-only on both databases. */
export function runPlaidSessionDatingAudit(
  before: Database.Database,
  after: Database.Database,
  manifest: PlaidSessionDatingManifest,
): AuditResult {
  const ctx = buildContext(before, after, manifest);
  const gates = [gateG1(ctx), gateG2(ctx), gateG3(ctx), gateG4(ctx), gateG5(ctx), gateG6(ctx), gateG7(ctx)];
  const diag = diagnostics(ctx);
  return { gates, diagnostics: diag, pass: gates.every((g) => g.pass) };
}

export interface ClosureCheckResult {
  checked: number;
  present: number;
  /** Slot empty: the zero is gone. */
  missing: number;
  /** Slot holds a non-zero row: the closure is gone too. */
  nonZero: number;
  details: string[];
}

/**
 * OPEN-7 check: every zero row the manifest wrote (SURVIVOR_TO_ZERO,
 * ZERO_SURVIVOR_RELABEL, moved and kept tombstones) still exists with
 * quantity 0 on its planned date. Keyed by (account, security, date), never
 * by row id, so a restore's new ids do not matter. Read-only.
 */
export function checkRepairClosures(db: Database.Database, manifest: PlaidSessionDatingManifest): ClosureCheckResult {
  const slot = db.prepare(`SELECT id, quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`);
  const out: ClosureCheckResult = { checked: 0, present: 0, missing: 0, nonZero: 0, details: [] };
  for (const l of manifest.lines) {
    if (l.kind !== "CHANGE" || l.table !== "holdings" || !l.new || !CLOSURE_CHECK_ACTIONS.includes(l.action)) continue;
    const a = num(l.new.account_id);
    const s = num(l.new.security_id);
    const d = String(l.new.as_of_date);
    out.checked++;
    const rows = slot.all(a, s, d) as { id: number; quantity: number }[];
    if (rows.length === 0) {
      out.missing++;
      out.details.push(`MISSING ${l.action} account ${a} security ${s} ${d}`);
    } else if (rows.some((r) => r.quantity !== 0)) {
      out.nonZero++;
      out.details.push(`NON-ZERO ${l.action} account ${a} security ${s} ${d} (holdings #${rows.map((r) => r.id).join(",")})`);
    } else {
      out.present++;
    }
  }
  return out;
}

/** The private report text. */
export function formatAuditReport(result: AuditResult, header: string[]): string {
  const out: string[] = ["Plaid session-dating audit (PRIVATE: dates, ids and ratios)", ...header, ""];
  out.push(
    "Rules chosen by the audit: Plaid-mapped account = a Plaid snapshot or plaid: holdings row in the before copy; " +
      "Plaid era = previousTradingDay(first Plaid run day) to the newest holdings date; closing ledger types = " +
      `${CLOSING_LEDGER_TYPES.join(", ")}; G1 universe = stock, ETF and mutual fund, not cash equivalents.`,
  );
  out.push("");
  for (const g of result.gates) {
    out.push(`${g.id} ${g.title}: ${g.pass ? "PASS" : "FAIL"}`);
    out.push(`  counts: ${Object.entries(g.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const d of g.details) out.push(`  ${d}`);
    out.push("");
  }
  out.push("Diagnostics (not gated):");
  for (const d of result.diagnostics) out.push(d);
  return `${out.join("\n")}\n`;
}
