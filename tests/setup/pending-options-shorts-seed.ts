/**
 * The ONE shared seed for the cross-cutting pending-lot invariants (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 12, ruling R6). Every class (long option, short option, short stock,
 * long stock) in every state it can take, with each position's EXPECTED
 * state written BY HAND in `SEED_TABLE`. The tests first check the read
 * model agrees with the table, then use the TABLE (never the classifier) as
 * their population.
 *
 * Synthetic symbols and small round numbers only (the repo is public).
 * Ledger rows carry amount NULL, so the engine's dollars are
 * quantity x price (x 100 for an option), plus or minus the row's fees.
 *
 * The re-symbol position needs a synthetic mapping: every test file that
 * uses this seed declares
 *   vi.mock("@/lib/securities/option-resymbol-targets", ...)
 * with `SEED_RESYMBOL_FROM` -> `SEED_RESYMBOL_TO` (a factory cannot import
 * this module, so the two symbols are restated there).
 *
 * Accounts come from runMigrations' seed: 1 = Vanguard Taxable, 3 = IBKR.
 */
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import type { PendingReason, PendingSide } from "@/lib/queries/pending-statement-types";
import { createPendingTestDb, seedHold, type HoldingOrigin } from "./pending-statement-fixtures";

/** The Eastern day every seed test reads on (also the faked system day). */
export const SEED_TODAY = "2026-10-26";
/** Noon Eastern on SEED_TODAY (EDT, UTC-4). */
export const SEED_NOW = new Date("2026-10-26T16:00:00Z");

export const SEED_RESYMBOL_FROM = "ZZRS  270115C00100000";
export const SEED_RESYMBOL_TO = "ZZRS  270115C00050000";

export type SeedClass = "long_option" | "short_option" | "short_stock" | "long_stock";
export type SeedState =
  | { kind: "open_priced" }
  | { kind: "open_unpriced" }
  | { kind: "pending"; reason: PendingReason }
  | { kind: "expired" }
  | { kind: "closed" };

export interface SeedRow {
  symbol: string;
  account: number;
  cls: SeedClass;
  side: PendingSide;
  state: SeedState;
  /** Lots of this position in `tax_lots` (open or closed). */
  lots: number;
}

const P = (reason: PendingReason): SeedState => ({ kind: "pending", reason });

/**
 * The hand-written expected state of every position in the seed. Written
 * from the ledger and holdings below, NOT read from the classifier.
 */
export const SEED_TABLE: readonly SeedRow[] = [
  // ── Account 3 (IBKR) ──
  { symbol: "ZZLA  270115C00010000", account: 3, cls: "long_option", side: "long", state: { kind: "open_priced" }, lots: 1 },
  { symbol: "ZZLB  270115C00020000", account: 3, cls: "long_option", side: "long", state: { kind: "open_unpriced" }, lots: 1 },
  { symbol: "ZZLC  270115P00030000", account: 3, cls: "long_option", side: "long", state: P("awaiting_statement"), lots: 1 },
  { symbol: SEED_RESYMBOL_FROM, account: 3, cls: "long_option", side: "long", state: P("resymbol_repair_pending"), lots: 1 },
  { symbol: "ZZLE  260918C00010000", account: 3, cls: "long_option", side: "long", state: { kind: "expired" }, lots: 1 },
  { symbol: "ZZLX  270115C00040000", account: 3, cls: "long_option", side: "long", state: { kind: "closed" }, lots: 1 },
  { symbol: "ZZSA  270115P00010000", account: 3, cls: "short_option", side: "short", state: { kind: "open_priced" }, lots: 1 },
  { symbol: "ZZSB  270115P00020000", account: 3, cls: "short_option", side: "short", state: P("awaiting_statement"), lots: 1 },
  { symbol: "ZZSE  260918P00010000", account: 3, cls: "short_option", side: "short", state: { kind: "expired" }, lots: 1 },
  { symbol: "ZZSX  270115P00040000", account: 3, cls: "short_option", side: "short", state: { kind: "closed" }, lots: 1 },
  { symbol: "ZZTA", account: 3, cls: "short_stock", side: "short", state: { kind: "open_priced" }, lots: 1 },
  { symbol: "ZZTB", account: 3, cls: "short_stock", side: "short", state: { kind: "open_unpriced" }, lots: 1 },
  { symbol: "ZZTC", account: 3, cls: "short_stock", side: "short", state: P("closing_entry_missing"), lots: 1 },
  { symbol: "ZZTX", account: 3, cls: "short_stock", side: "short", state: { kind: "closed" }, lots: 1 },
  { symbol: "ZZUA", account: 3, cls: "long_stock", side: "long", state: { kind: "open_priced" }, lots: 1 },
  { symbol: "ZZUB", account: 3, cls: "long_stock", side: "long", state: P("awaiting_statement"), lots: 1 },
  { symbol: "ZZUX", account: 3, cls: "long_stock", side: "long", state: { kind: "closed" }, lots: 1 },
  { symbol: "ZZUS", account: 3, cls: "long_stock", side: "long", state: { kind: "closed" }, lots: 1 },
  { symbol: "ZZFX", account: 3, cls: "long_stock", side: "long", state: { kind: "open_priced" }, lots: 1 },
  // ── Account 1 (Vanguard Taxable) ──
  { symbol: "ZZLD  270115C00050000", account: 1, cls: "long_option", side: "long", state: P("closing_entry_missing"), lots: 1 },
  { symbol: "ZZSC  270115C00060000", account: 1, cls: "short_option", side: "short", state: P("closing_entry_missing"), lots: 1 },
  { symbol: "ZZTD", account: 1, cls: "short_stock", side: "short", state: P("awaiting_statement"), lots: 1 },
  { symbol: "ZZUC", account: 1, cls: "long_stock", side: "long", state: { kind: "open_unpriced" }, lots: 1 },
  { symbol: "ZZUD", account: 1, cls: "long_stock", side: "long", state: { kind: "open_priced" }, lots: 1 },
];

/**
 * Hand-computed figures for the seed (USD), from the ledger below:
 *  - the Unrealized tile = Σ side-signed (value - remaining figure) over the
 *    ordinary-open PRICED lots: ZZLA +400, ZZSA +400, ZZTA +100, ZZUA +120,
 *    ZZFX +75, ZZUD -20;
 *  - the raw unrealized the pending lots would have carried: ZZLC +200,
 *    ZZRS +200, ZZSB +300, ZZTC -100, ZZUB +250, ZZLD -400, ZZSC +300,
 *    ZZTD +50;
 *  - the raw unrealized of the two expired options: ZZLE -195, ZZSE +190;
 *  - realized (all USD): ZZLA +100 (part sale), ZZLX +100, ZZSX +200,
 *    ZZTX +8, ZZUA +40 (part sale), ZZUX +20, ZZUS +15 (the engine's
 *    synthetic close at the statement-zero date's price).
 */
export const SEED_FIGURES = {
  unrealizedTile: 1075,
  pendingRawUnrealized: 800,
  expiredRawUnrealized: -5,
  realized: 483,
} as const;

export interface SeedDb {
  db: Database.Database;
  secId: (symbol: string) => number;
}

let seq = 0;

export function insertSecurity(
  db: Database.Database,
  symbol: string,
  opts: { type?: string; currency?: string; expiration?: string | null } = {}
): number {
  const type = opts.type ?? "Stock";
  const isOption = type.toLowerCase() === "option";
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, currency, multiplier, expiration_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        symbol,
        `${symbol} synthetic`,
        type,
        opts.currency ?? "USD",
        isOption ? 100 : null,
        isOption ? (opts.expiration ?? "2027-01-15") : null
      ).lastInsertRowid
  );
}

/** A ledger row with amount NULL (dollars = qty x price x multiplier, fees applied by the engine). */
export function insertTxn(
  db: Database.Database,
  account: number,
  sec: number,
  date: string,
  type: string,
  qty: number | null,
  price: number | null,
  opts: { fees?: number; notes?: string | null } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(account, sec, date, type, qty, price, opts.fees ?? 0, opts.notes ?? null, `pos12-${seq++}`).lastInsertRowid
  );
}

export function insertPrice(db: Database.Database, sec: number, date: string, price: number): void {
  db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(
    sec,
    date,
    price
  );
}

/**
 * Build the seed and run the engine once (which also stamps the convention
 * marker, so tax-lot results read current).
 */
export function buildSeed(): SeedDb {
  const db = createPendingTestDb();
  const ids = new Map<string, number>();
  const sec = (symbol: string, opts: Parameters<typeof insertSecurity>[2] = {}) => {
    const id = insertSecurity(db, symbol, opts);
    ids.set(symbol, id);
    return id;
  };
  const opt = (symbol: string, expiration = "2027-01-15") => sec(symbol, { type: "option", expiration });
  const t = (a: number, s: number, d: string, type: string, q: number | null, p: number | null) =>
    insertTxn(db, a, s, d, type, q, p);
  const h = (a: number, s: number, d: string, origin: HoldingOrigin, q = 0) => seedHold(db, a, s, d, origin, q);
  const px = (s: number, p: number, d = "2026-10-23") => insertPrice(db, s, d, p);

  db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('CAD', 0.75, '2026-10-23', 'test')").run();

  // ── Account 3: long options ──
  let s = opt("ZZLA  270115C00010000"); // partly sold, still held: open, priced
  t(3, s, "2026-06-01", "BUY_TO_OPEN", 3, 3);
  t(3, s, "2026-07-01", "SELL_TO_CLOSE", 1, 4);
  h(3, s, "2026-09-30", "stmt", 2);
  px(s, 5);
  s = opt("ZZLB  270115C00020000"); // held, no price: open, unpriced
  t(3, s, "2026-06-01", "BUY_TO_OPEN", 1, 2);
  h(3, s, "2026-10-20", "tws", 1);
  s = opt("ZZLC  270115P00030000"); // statement held, then live zero: awaiting statement
  t(3, s, "2026-06-01", "BUY_TO_OPEN", 1, 4);
  h(3, s, "2026-06-30", "stmt", 1);
  h(3, s, "2026-10-20", "live-zero");
  px(s, 6);
  s = opt(SEED_RESYMBOL_FROM); // old symbol flat, replacement held in the same account
  t(3, s, "2026-05-01", "BUY_TO_OPEN", 1, 8);
  h(3, s, "2026-10-20", "live-zero");
  px(s, 10);
  const replacement = opt(SEED_RESYMBOL_TO);
  h(3, replacement, "2026-10-20", "tws", 2);
  s = opt("ZZLE  260918C00010000", "2026-09-18"); // past expiration, no closing entry
  t(3, s, "2026-06-01", "BUY_TO_OPEN", 1, 2);
  h(3, s, "2026-08-31", "stmt", 1);
  px(s, 0.05, "2026-09-17");
  s = opt("ZZLX  270115C00040000"); // closed round trip
  t(3, s, "2026-06-01", "BUY_TO_OPEN", 1, 2);
  t(3, s, "2026-07-01", "SELL_TO_CLOSE", 1, 3);

  // ── Account 3: short options ──
  s = opt("ZZSA  270115P00010000");
  t(3, s, "2026-06-01", "SELL_TO_OPEN", 2, 3);
  h(3, s, "2026-09-30", "stmt", -2);
  px(s, 1);
  s = opt("ZZSB  270115P00020000");
  t(3, s, "2026-06-01", "SELL_TO_OPEN", 1, 5);
  h(3, s, "2026-09-15", "tws", -1);
  h(3, s, "2026-10-20", "live-zero");
  px(s, 2);
  s = opt("ZZSE  260918P00010000", "2026-09-18");
  t(3, s, "2026-06-01", "SELL_TO_OPEN", 1, 2);
  h(3, s, "2026-08-31", "stmt", -1);
  px(s, 0.1, "2026-09-17");
  s = opt("ZZSX  270115P00040000");
  t(3, s, "2026-06-01", "SELL_TO_OPEN", 1, 3);
  t(3, s, "2026-07-01", "BUY_TO_CLOSE", 1, 1);

  // ── Account 3: short stock ──
  s = sec("ZZTA");
  t(3, s, "2026-06-01", "SHORT_SELL", 10, 50);
  h(3, s, "2026-09-30", "stmt", -10);
  px(s, 40);
  s = sec("ZZTB");
  t(3, s, "2026-06-01", "SHORT_SELL", 5, 20);
  h(3, s, "2026-10-20", "tws", -5);
  s = sec("ZZTC"); // statement zero, no cover imported
  t(3, s, "2026-06-01", "SHORT_SELL", 10, 50);
  h(3, s, "2026-09-30", "stmt-zero");
  px(s, 60);
  s = sec("ZZTX");
  t(3, s, "2026-06-01", "SHORT_SELL", 4, 10);
  t(3, s, "2026-07-01", "BUY_TO_COVER", 4, 8);

  // ── Account 3: long stock ──
  s = sec("ZZUA"); // partly sold, statement agrees
  t(3, s, "2026-06-01", "BUY", 10, 100);
  t(3, s, "2026-07-01", "SELL", 4, 110);
  h(3, s, "2026-09-30", "stmt", 6);
  px(s, 120);
  s = sec("ZZUB"); // live zero after the statement: awaiting
  t(3, s, "2026-06-01", "BUY", 5, 100);
  h(3, s, "2026-06-30", "stmt", 5);
  h(3, s, "2026-10-10", "live-zero");
  px(s, 150);
  s = sec("ZZUX");
  t(3, s, "2026-06-01", "BUY", 4, 10);
  t(3, s, "2026-07-01", "SELL", 4, 15);
  s = sec("ZZUS"); // statement zero: the engine's synthetic close
  t(3, s, "2026-06-01", "BUY", 3, 20);
  h(3, s, "2026-09-30", "stmt-zero");
  px(s, 25, "2026-09-30");
  s = sec("ZZFX", { currency: "CAD" }); // non-USD, held
  t(3, s, "2026-06-01", "BUY", 10, 100);
  h(3, s, "2026-09-30", "stmt", 10);
  px(s, 110);

  // ── Account 1 ──
  s = opt("ZZLD  270115C00050000");
  t(1, s, "2026-06-01", "BUY_TO_OPEN", 2, 3);
  h(1, s, "2026-09-30", "stmt-zero");
  px(s, 1);
  s = opt("ZZSC  270115C00060000");
  t(1, s, "2026-06-01", "SELL_TO_OPEN", 1, 4);
  h(1, s, "2026-09-30", "stmt-zero");
  px(s, 1);
  s = sec("ZZTD");
  t(1, s, "2026-06-01", "SHORT_SELL", 10, 30);
  h(1, s, "2026-10-20", "live-zero");
  px(s, 25);
  s = sec("ZZUC");
  t(1, s, "2026-06-01", "BUY", 10, 50);
  h(1, s, "2026-09-30", "stmt", 10);
  s = sec("ZZUD");
  t(1, s, "2026-06-01", "BUY", 2, 100);
  h(1, s, "2026-09-30", "stmt", 2);
  px(s, 90);

  computeTaxLots(db);

  return {
    db,
    secId: (symbol: string) => {
      const id = ids.get(symbol);
      if (id == null) throw new Error(`seed has no security ${symbol}`);
      return id;
    },
  };
}

/** Raw tax_lots rows with what the hand-formula needs (never the read model). */
export interface RawLot {
  id: number;
  account_id: number;
  security_id: number;
  symbol: string;
  is_short: number;
  quantity_acquired: number;
  quantity_remaining: number;
  cost_basis: number;
  security_type: string;
  multiplier: number;
  fx: number;
  price: number | null;
}

export function rawLots(db: Database.Database): RawLot[] {
  return db
    .prepare(
      `SELECT tl.id, tl.account_id, tl.security_id, s.symbol, tl.is_short,
              tl.quantity_acquired, tl.quantity_remaining, tl.cost_basis,
              LOWER(COALESCE(s.security_type, '')) AS security_type,
              COALESCE(s.multiplier, 1) AS multiplier,
              COALESCE(fx.usd_per_unit, 1) AS fx,
              (SELECT p.close_price FROM prices p WHERE p.security_id = tl.security_id
                ORDER BY p.date DESC LIMIT 1) AS price
         FROM tax_lots tl
         JOIN securities s ON s.id = tl.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
        ORDER BY tl.id`
    )
    .all() as RawLot[];
}

/** The still-open share of a lot's stored dollars, USD (written out by hand). */
export function remainingFigure(l: RawLot): number {
  return l.quantity_acquired !== 0 ? (l.cost_basis * l.quantity_remaining) / l.quantity_acquired * l.fx : 0;
}

/** Side-signed (value - remaining figure) from raw rows; null when unpriced. Stocks and options only. */
export function rawUnrealized(l: RawLot): number | null {
  if (l.price == null) return null;
  const value = l.quantity_remaining * l.price * (l.security_type === "option" ? l.multiplier : 1) * l.fx;
  const sign = l.is_short === 1 ? -1 : 1;
  return sign * (value - remainingFigure(l));
}
