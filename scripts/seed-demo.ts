/**
 * seed-demo.ts — Populate a fresh SQLite database with realistic demo data.
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts            # creates data/demo.db
 *   npx tsx scripts/seed-demo.ts --replace   # also copies to data/vanguard.db
 *
 * The generated data is fictional but plausible — three brokerage accounts
 * with ~15 securities, 6 months of price history, transactions, and events.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "../lib/db/migrate";
import { upsertSecurity } from "../lib/mutations/securities";
import { computeTaxLots } from "../lib/compute/tax-lots";
import { computeDailyValuations } from "../lib/compute/daily-valuation";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data");
const DEMO_DB_PATH = path.join(DATA_DIR, "demo.db");
const PROD_DB_PATH = path.join(DATA_DIR, "vanguard.db");
const REPLACE = process.argv.includes("--replace");

// Date range: 6 months of history
const START_DATE = "2025-10-01";
const END_DATE = "2026-03-27";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate weekdays between start and end (inclusive). */
function weekdays(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + "T12:00:00Z");
  const last = new Date(end + "T12:00:00Z");
  while (cur <= last) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** Last day of a given month. */
function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

/** Simple seeded pseudo-random number generator (mulberry32). */
function createRng(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = createRng(42);

/** Random number between min and max. */
function rand(min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Round to 2 decimal places. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format date as YYYY-MM-DD. */
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Demo securities data
// ---------------------------------------------------------------------------

interface DemoSecurity {
  symbol: string;
  name: string;
  securityType: string;
  assetClass: string;
  basePrice: number; // starting price ~Oct 2025
  volatility: number; // daily return std dev
  drift: number; // daily return mean
  // Option fields
  underlyingSymbol?: string;
  strikePrice?: number;
  expirationDate?: string;
  optionType?: "CALL" | "PUT";
  multiplier?: number;
  // Bond fields
  maturityDate?: string;
}

const SECURITIES: DemoSecurity[] = [
  // Large-cap stocks
  { symbol: "AAPL", name: "Apple Inc.", securityType: "stock", assetClass: "equity", basePrice: 228, volatility: 0.015, drift: 0.0003 },
  { symbol: "MSFT", name: "Microsoft Corp.", securityType: "stock", assetClass: "equity", basePrice: 420, volatility: 0.014, drift: 0.0003 },
  { symbol: "GOOGL", name: "Alphabet Inc.", securityType: "stock", assetClass: "equity", basePrice: 168, volatility: 0.016, drift: 0.0002 },
  { symbol: "AMZN", name: "Amazon.com Inc.", securityType: "stock", assetClass: "equity", basePrice: 196, volatility: 0.017, drift: 0.0003 },
  { symbol: "NVDA", name: "NVIDIA Corp.", securityType: "stock", assetClass: "equity", basePrice: 138, volatility: 0.025, drift: 0.0005 },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", securityType: "stock", assetClass: "equity", basePrice: 230, volatility: 0.012, drift: 0.0002 },
  { symbol: "JNJ", name: "Johnson & Johnson", securityType: "stock", assetClass: "equity", basePrice: 160, volatility: 0.008, drift: 0.0001 },
  { symbol: "TSLA", name: "Tesla Inc.", securityType: "stock", assetClass: "equity", basePrice: 265, volatility: 0.030, drift: 0.0004 },
  // ETFs
  { symbol: "VTI", name: "Vanguard Total Stock Market ETF", securityType: "etf", assetClass: "equity", basePrice: 282, volatility: 0.010, drift: 0.0002 },
  { symbol: "VXUS", name: "Vanguard Total International Stock ETF", securityType: "etf", assetClass: "equity", basePrice: 58, volatility: 0.011, drift: 0.0001 },
  { symbol: "BND", name: "Vanguard Total Bond Market ETF", securityType: "etf", assetClass: "fixed_income", basePrice: 72, volatility: 0.003, drift: 0.00005 },
  // Money market
  { symbol: "VMFXX", name: "Vanguard Federal Money Market Fund", securityType: "fund", assetClass: "cash_equivalent", basePrice: 1.00, volatility: 0, drift: 0 },
  // Option (OCC format: symbol padded to 6, YYMMDD, C/P, strike * 1000 padded to 8)
  {
    symbol: "AAPL  260619C00250000", name: "AAPL Jun 2026 $250 Call",
    securityType: "option", assetClass: "equity",
    basePrice: 12.50, volatility: 0.04, drift: 0.001,
    underlyingSymbol: "AAPL", strikePrice: 250, expirationDate: "2026-06-19",
    optionType: "CALL", multiplier: 100,
  },
  // Put option
  {
    symbol: "TSLA  260619P00200000", name: "TSLA Jun 2026 $200 Put",
    securityType: "option", assetClass: "equity",
    basePrice: 8.50, volatility: 0.05, drift: -0.002,
    underlyingSymbol: "TSLA", strikePrice: 200, expirationDate: "2026-06-19",
    optionType: "PUT", multiplier: 100,
  },
  // Short call for covered call (MSFT)
  {
    symbol: "MSFT  260619C00450000", name: "MSFT Jun 2026 $450 Call",
    securityType: "option", assetClass: "equity",
    basePrice: 6.00, volatility: 0.035, drift: -0.001,
    underlyingSymbol: "MSFT", strikePrice: 450, expirationDate: "2026-06-19",
    optionType: "CALL", multiplier: 100,
  },
  // Closed option (expired worthless)
  {
    symbol: "NVDA  260221C00180000", name: "NVDA Feb 2026 $180 Call",
    securityType: "option", assetClass: "equity",
    basePrice: 4.00, volatility: 0.06, drift: -0.003,
    underlyingSymbol: "NVDA", strikePrice: 180, expirationDate: "2026-02-21",
    optionType: "CALL", multiplier: 100,
  },
  // Bond (US Treasury 10-Year Note)
  {
    symbol: "912828ZQ7", name: "US Treasury Note 2.875% 2032",
    securityType: "bond", assetClass: "fixed_income",
    basePrice: 94.50, volatility: 0.003, drift: 0.0001,
    maturityDate: "2032-05-15",
  },
];

// ---------------------------------------------------------------------------
// Account allocations (security symbol -> quantity per account)
// ---------------------------------------------------------------------------

interface AccountAllocation {
  [symbol: string]: { qty: number; costBasis: number };
}

const TAXABLE_HOLDINGS: AccountAllocation = {
  VTI: { qty: 350, costBasis: 87500 },
  BND: { qty: 400, costBasis: 28800 },
  VMFXX: { qty: 25000, costBasis: 25000 },
  AAPL: { qty: 120, costBasis: 21600 },
  MSFT: { qty: 80, costBasis: 30400 },
  GOOGL: { qty: 150, costBasis: 22500 },
};

const ROTH_HOLDINGS: AccountAllocation = {
  VXUS: { qty: 800, costBasis: 42400 },
  VTI: { qty: 200, costBasis: 50000 },
  BND: { qty: 300, costBasis: 21600 },
  AMZN: { qty: 70, costBasis: 12600 },
  NVDA: { qty: 100, costBasis: 11000 },
};

const IBKR_HOLDINGS: AccountAllocation = {
  JPM: { qty: 60, costBasis: 12600 },
  JNJ: { qty: 80, costBasis: 12000 },
  TSLA: { qty: 40, costBasis: 9200 },
  MSFT: { qty: 100, costBasis: 40000 }, // stock for covered call pair
  "AAPL  260619C00250000": { qty: 5, costBasis: 5500 },
  "TSLA  260619P00200000": { qty: 3, costBasis: 2550 }, // long put
  "MSFT  260619C00450000": { qty: -1, costBasis: 0 }, // short call (covered)
  "NVDA  260221C00180000": { qty: 0, costBasis: 0 }, // bought Nov, expired Feb
  // Bond quantity is FACE VALUE in dollars (par convention — valuation divides by 100)
  "912828ZQ7": { qty: 50000, costBasis: 47250 },
};

// ---------------------------------------------------------------------------
// Price generation (deterministic random walk)
// ---------------------------------------------------------------------------

function generatePrices(sec: DemoSecurity, dates: string[]): Map<string, number> {
  const prices = new Map<string, number>();
  let price = sec.basePrice;
  for (const date of dates) {
    if (sec.volatility === 0) {
      // Money market: always $1.00
      prices.set(date, sec.basePrice);
    } else {
      const dailyReturn = sec.drift + sec.volatility * (rng() + rng() + rng() - 1.5) * 0.8165;
      price = r2(price * (1 + dailyReturn));
      if (price < 0.01) price = 0.01;
      prices.set(date, price);
    }
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("Vanguard Skin — Demo Data Seed");
  console.log("==============================\n");

  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Remove old demo.db if it exists
  if (fs.existsSync(DEMO_DB_PATH)) {
    fs.unlinkSync(DEMO_DB_PATH);
  }

  // Create fresh database
  const db = new Database(DEMO_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  console.log("Database created and migrations applied.");

  // ------------------------------------------------------------------
  // 1. Accounts (already seeded by migration 002)
  // ------------------------------------------------------------------
  const accounts = db.prepare("SELECT id, name FROM accounts").all() as { id: number; name: string }[];
  const accountMap = new Map(accounts.map((a) => [a.name, a.id]));
  const taxableId = accountMap.get("Vanguard Taxable")!;
  const rothId = accountMap.get("Vanguard Roth IRA")!;
  const ibkrId = accountMap.get("IBKR")!;
  console.log(`Accounts: ${accounts.map((a) => `${a.name} (#${a.id})`).join(", ")}`);

  // ------------------------------------------------------------------
  // 2. Import batch
  // ------------------------------------------------------------------
  const batchStmt = db.prepare(
    "INSERT INTO import_batches (filename, source_type, status, record_count, summary) VALUES (?, ?, ?, ?, ?)"
  );
  const batchResult = batchStmt.run("demo-seed", "demo", "completed", 0, "Demo data for screenshots");
  const batchId = batchResult.lastInsertRowid as number;

  // ------------------------------------------------------------------
  // 3. Securities
  // ------------------------------------------------------------------
  const securityIdMap = new Map<string, number>();
  for (const sec of SECURITIES) {
    const id = upsertSecurity(db, {
      symbol: sec.symbol,
      name: sec.name,
      securityType: sec.securityType,
      assetClass: sec.assetClass,
      underlyingSymbol: sec.underlyingSymbol,
      strikePrice: sec.strikePrice,
      expirationDate: sec.expirationDate,
      optionType: sec.optionType,
      multiplier: sec.multiplier,
      maturityDate: sec.maturityDate,
    });
    securityIdMap.set(sec.symbol, id);
  }
  console.log(`Securities: ${securityIdMap.size} created.`);

  // ------------------------------------------------------------------
  // 4. Generate prices for all trading days
  // ------------------------------------------------------------------
  const tradingDays = weekdays(START_DATE, END_DATE);
  const allPrices = new Map<string, Map<string, number>>();
  for (const sec of SECURITIES) {
    allPrices.set(sec.symbol, generatePrices(sec, tradingDays));
  }

  // Insert prices into prices table
  const priceStmt = db.prepare(
    "INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'demo')"
  );
  const insertPrices = db.transaction(() => {
    let count = 0;
    for (const [symbol, prices] of allPrices) {
      const secId = securityIdMap.get(symbol)!;
      for (const [date, price] of prices) {
        priceStmt.run(secId, date, price);
        count++;
      }
    }
    return count;
  });
  const priceCount = insertPrices();
  console.log(`Prices: ${priceCount} records inserted.`);

  // ------------------------------------------------------------------
  // 5. Transactions (BUYs for initial positions, plus a few sells and dividends)
  // ------------------------------------------------------------------
  const txStmt = db.prepare(`
    INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key, import_batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let txCount = 0;

  function insertBuy(accountId: number, symbol: string, qty: number, costBasis: number, date: string) {
    const secId = securityIdMap.get(symbol)!;
    const pps = r2(costBasis / qty);
    txStmt.run(accountId, secId, date, "BUY", qty, -costBasis, pps, 0, `demo-buy-${accountId}-${symbol}-${date}`, batchId);
    txCount++;
  }

  function insertSell(accountId: number, symbol: string, qty: number, price: number, date: string) {
    const secId = securityIdMap.get(symbol)!;
    const proceeds = r2(qty * price);
    txStmt.run(accountId, secId, date, "SELL", -qty, proceeds, price, 4.95, `demo-sell-${accountId}-${symbol}-${date}`, batchId);
    txCount++;
  }

  function insertDividend(accountId: number, symbol: string, amount: number, date: string) {
    const secId = securityIdMap.get(symbol)!;
    txStmt.run(accountId, secId, date, "DIVIDEND", null, amount, null, 0, `demo-div-${accountId}-${symbol}-${date}`, batchId);
    txCount++;
  }

  function insertOptionTx(accountId: number, symbol: string, type: string, qty: number, price: number, date: string) {
    const secId = securityIdMap.get(symbol)!;
    const amount = type.startsWith("SELL") ? r2(qty * price * 100) : -r2(qty * price * 100);
    txStmt.run(accountId, secId, date, type, qty, amount, price, 1.30, `demo-opt-${accountId}-${symbol}-${type}-${date}`, batchId);
    txCount++;
  }

  db.transaction(() => {
    // Initial buys (early October 2025)
    for (const [symbol, h] of Object.entries(TAXABLE_HOLDINGS)) {
      insertBuy(taxableId, symbol, h.qty, h.costBasis, "2025-10-01");
    }
    for (const [symbol, h] of Object.entries(ROTH_HOLDINGS)) {
      insertBuy(rothId, symbol, h.qty, h.costBasis, "2025-10-01");
    }
    for (const [symbol, h] of Object.entries(IBKR_HOLDINGS)) {
      // Skip options — they get proper BUY_TO_OPEN/SELL_TO_OPEN below
      const sec = SECURITIES.find((s) => s.symbol === symbol);
      if (sec?.securityType === "option") continue;
      if (h.qty <= 0) continue; // skip zero/negative qty
      insertBuy(ibkrId, symbol, h.qty, h.costBasis, "2025-10-01");
    }

    // Some sells mid-period
    insertSell(taxableId, "GOOGL", 30, 175.40, "2025-12-15");
    insertSell(ibkrId, "TSLA", 10, 280.00, "2026-01-10");
    insertSell(taxableId, "AAPL", 20, 235.60, "2026-02-20");

    // Dividends (quarterly-ish)
    insertDividend(taxableId, "VTI", 520.00, "2025-12-20");
    insertDividend(taxableId, "BND", 180.00, "2025-12-20");
    insertDividend(rothId, "VXUS", 340.00, "2025-12-20");
    insertDividend(rothId, "VTI", 298.00, "2025-12-20");
    insertDividend(ibkrId, "JPM", 78.00, "2025-12-20");
    insertDividend(ibkrId, "JNJ", 76.80, "2025-12-20");

    insertDividend(taxableId, "VTI", 540.00, "2026-03-21");
    insertDividend(taxableId, "BND", 185.00, "2026-03-21");
    insertDividend(rothId, "VXUS", 350.00, "2026-03-21");
    insertDividend(rothId, "VTI", 305.00, "2026-03-21");
    insertDividend(ibkrId, "JPM", 80.00, "2026-03-21");
    insertDividend(ibkrId, "JNJ", 78.40, "2026-03-21");

    // Option transactions
    // Buy AAPL calls (already in IBKR holdings as initial buy)
    insertOptionTx(ibkrId, "AAPL  260619C00250000", "BUY_TO_OPEN", 5, 11.00, "2025-10-01");

    // Buy TSLA puts
    insertOptionTx(ibkrId, "TSLA  260619P00200000", "BUY_TO_OPEN", 3, 8.50, "2025-11-15");

    // Sell MSFT covered call (SELL_TO_OPEN)
    insertOptionTx(ibkrId, "MSFT  260619C00450000", "SELL_TO_OPEN", 1, 6.00, "2025-12-01");

    // Buy NVDA call (then it expires worthless in Feb)
    insertOptionTx(ibkrId, "NVDA  260221C00180000", "BUY_TO_OPEN", 2, 4.00, "2025-11-01");
    insertOptionTx(ibkrId, "NVDA  260221C00180000", "EXPIRED", 2, 0, "2026-02-21");

    // Close 2 AAPL calls for profit (SELL_TO_CLOSE)
    insertOptionTx(ibkrId, "AAPL  260619C00250000", "SELL_TO_CLOSE", 2, 15.80, "2026-02-10");
  })();
  console.log(`Transactions: ${txCount} records inserted.`);

  // ------------------------------------------------------------------
  // 6. Holdings snapshots (monthly)
  // ------------------------------------------------------------------
  const holdingStmt = db.prepare(`
    INSERT OR IGNORE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Generate month-end dates
  const monthEnds = [
    lastDayOfMonth(2025, 10), // Oct 2025
    lastDayOfMonth(2025, 11), // Nov 2025
    lastDayOfMonth(2025, 12), // Dec 2025
    lastDayOfMonth(2026, 1),  // Jan 2026
    lastDayOfMonth(2026, 2),  // Feb 2026
    "2026-03-27",             // Latest snapshot (today-ish)
  ];

  function insertHoldings(
    accountId: number,
    holdings: AccountAllocation,
    asOfDate: string,
    adjustments: Record<string, number> = {}
  ) {
    for (const [symbol, h] of Object.entries(holdings)) {
      const adjQty = adjustments[symbol] ?? 0;
      const qty = h.qty + adjQty;
      if (qty === 0) continue; // skip zero-quantity positions
      const secId = securityIdMap.get(symbol)!;
      const adjCostBasis = h.qty !== 0 ? r2(h.costBasis * (qty / h.qty)) : 0;
      holdingStmt.run(
        accountId, secId, qty, adjCostBasis, asOfDate,
        `demo-hold-${accountId}-${symbol}-${asOfDate}`, batchId
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let holdingCount: any = 0;
  db.transaction(() => {
    for (const date of monthEnds) {
      // Taxable: sold 30 GOOGL in Dec, 20 AAPL in Feb
      const taxAdj: Record<string, number> = {};
      if (date >= "2025-12-15") taxAdj["GOOGL"] = -30;
      if (date >= "2026-02-20") taxAdj["AAPL"] = -20;
      insertHoldings(taxableId, TAXABLE_HOLDINGS, date, taxAdj);

      // Roth: no sells
      insertHoldings(rothId, ROTH_HOLDINGS, date);

      // IBKR: sold 10 TSLA in Jan, closed 2 AAPL calls in Feb, NVDA call expired in Feb
      const ibkrAdj: Record<string, number> = {};
      if (date >= "2026-01-10") ibkrAdj["TSLA"] = -10;
      if (date >= "2026-02-10") ibkrAdj["AAPL  260619C00250000"] = -2;
      // NVDA call: bought Nov 1, expired Feb 21
      if (date >= "2025-11-01" && date < "2026-02-21") ibkrAdj["NVDA  260221C00180000"] = 2; // add 2 contracts
      // After expiry, qty goes back to base (0) — no adjustment needed
      insertHoldings(ibkrId, IBKR_HOLDINGS, date, ibkrAdj);
    }
    holdingCount = db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number };
  })();
  console.log(`Holdings: ${(holdingCount as { c: number }).c} snapshot records.`);

  // ------------------------------------------------------------------
  // 7. Monthly snapshots (anchors for daily valuation cash calculation)
  // ------------------------------------------------------------------
  const snapshotStmt = db.prepare(`
    INSERT OR IGNORE INTO monthly_snapshots (account_id, month_end_date, total_value, source, import_batch_id)
    VALUES (?, ?, ?, 'demo', ?)
  `);

  // Approximate total values per account (holdings value + cash)
  function accountTotalValue(holdings: AccountAllocation, date: string, adjustments: Record<string, number> = {}): number {
    let total = 0;
    for (const [symbol, h] of Object.entries(holdings)) {
      const adjQty = adjustments[symbol] ?? 0;
      const qty = h.qty + adjQty;
      if (qty <= 0) continue;
      const sec = SECURITIES.find((s) => s.symbol === symbol)!;
      const priceMap = allPrices.get(symbol)!;
      // Find closest price on or before this date
      let price = sec.basePrice;
      const sorted = [...priceMap.entries()].filter(([d]) => d <= date).sort(([a], [b]) => b.localeCompare(a));
      if (sorted.length > 0) price = sorted[0][1];

      if (sec.securityType === "bond") {
        total += (qty * price) / 100;
      } else if (sec.multiplier) {
        total += qty * price * sec.multiplier;
      } else {
        total += qty * price;
      }
    }
    return total;
  }

  db.transaction(() => {
    for (const date of monthEnds) {
      const taxAdj: Record<string, number> = {};
      if (date >= "2025-12-15") taxAdj["GOOGL"] = -30;
      if (date >= "2026-02-20") taxAdj["AAPL"] = -20;

      const ibkrAdj: Record<string, number> = {};
      if (date >= "2026-01-10") ibkrAdj["TSLA"] = -10;

      // Add ~5% cash buffer on top of holdings value
      const taxVal = r2(accountTotalValue(TAXABLE_HOLDINGS, date, taxAdj) * 1.05);
      const rothVal = r2(accountTotalValue(ROTH_HOLDINGS, date) * 1.04);
      const ibkrVal = r2(accountTotalValue(IBKR_HOLDINGS, date, ibkrAdj) * 1.08);

      snapshotStmt.run(taxableId, date, taxVal, batchId);
      snapshotStmt.run(rothId, date, rothVal, batchId);
      snapshotStmt.run(ibkrId, date, ibkrVal, batchId);
    }
  })();
  console.log(`Monthly snapshots: ${monthEnds.length * 3} records.`);

  // ------------------------------------------------------------------
  // 8. OHLCV bars for charting (AAPL, MSFT, VTI)
  // ------------------------------------------------------------------
  const ohlcvStmt = db.prepare(`
    INSERT OR IGNORE INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
    VALUES (?, ?, '1 day', ?, ?, ?, ?, ?)
  `);

  const chartSymbols = ["AAPL", "MSFT", "VTI"];
  let ohlcvCount = 0;
  db.transaction(() => {
    for (const symbol of chartSymbols) {
      const secId = securityIdMap.get(symbol)!;
      const prices = allPrices.get(symbol)!;
      for (const [date, close] of prices) {
        const open = r2(close * (1 + (rng() - 0.5) * 0.01));
        const high = r2(Math.max(open, close) * (1 + rng() * 0.015));
        const low = r2(Math.min(open, close) * (1 - rng() * 0.015));
        const volume = Math.floor(rand(5_000_000, 80_000_000));
        ohlcvStmt.run(secId, date, open, high, low, close, volume);
        ohlcvCount++;
      }
    }
  })();
  console.log(`OHLCV bars: ${ohlcvCount} records for ${chartSymbols.join(", ")}.`);

  // Set ib_con_id for chartable securities so the Charts tab recognizes them
  const ibConIds: Record<string, number> = {
    AAPL: 265598,
    MSFT: 272093,
    VTI: 75834657,
  };
  const setConIdStmt = db.prepare(
    "UPDATE securities SET ib_con_id = ? WHERE symbol = ?"
  );
  for (const [symbol, conId] of Object.entries(ibConIds)) {
    setConIdStmt.run(conId, symbol);
  }
  console.log(`IB contract IDs: set for ${Object.keys(ibConIds).join(", ")}.`);

  // ------------------------------------------------------------------
  // 9. Benchmark prices (SPY for comparison chart)
  // ------------------------------------------------------------------
  const benchStmt = db.prepare(
    "INSERT OR IGNORE INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'demo')"
  );

  let benchPrice = 575; // SPY ~Oct 2025
  let benchCount = 0;
  db.transaction(() => {
    for (const date of tradingDays) {
      const dailyReturn = 0.0002 + 0.010 * (rng() + rng() + rng() - 1.5) * 0.8165;
      benchPrice = r2(benchPrice * (1 + dailyReturn));
      benchStmt.run("SPY", date, benchPrice);
      benchCount++;
    }
  })();
  console.log(`Benchmark prices: ${benchCount} SPY records.`);

  // ------------------------------------------------------------------
  // 10. Calendar events (a few upcoming)
  // ------------------------------------------------------------------
  const eventStmt = db.prepare(`
    INSERT OR IGNORE INTO calendar_events
      (source, event_type, event_date, event_time, title, description, security_id, symbol, expected_impact, source_key, week_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const mondayOf = (d: string) => {
    const dt = new Date(d + "T12:00:00Z");
    const day = dt.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    dt.setUTCDate(dt.getUTCDate() + diff);
    return fmt(dt);
  };

  db.transaction(() => {
    // Company events
    const events = [
      { type: "earnings", date: "2026-04-01", time: "AMC", symbol: "AAPL", title: "Apple Q2 2026 Earnings", desc: "Apple Inc. fiscal Q2 2026 earnings call. Consensus EPS: $2.35." },
      { type: "earnings", date: "2026-04-03", time: "AMC", symbol: "MSFT", title: "Microsoft Q3 FY2026 Earnings", desc: "Microsoft Corp. Q3 fiscal year 2026 earnings. Focus on AI revenue growth." },
      { type: "analyst_meeting", date: "2026-04-02", time: null, symbol: "NVDA", title: "NVIDIA Investor Day", desc: "Annual investor day presentation covering next-gen GPU roadmap." },
    ];
    for (const e of events) {
      const secId = securityIdMap.get(e.symbol) ?? null;
      eventStmt.run("wsh", e.type, e.date, e.time, e.title, e.desc, secId, e.symbol, null, `demo-${e.type}-${e.symbol}-${e.date}`, mondayOf(e.date));
    }

    // Macro events
    const macros = [
      { type: "fomc", date: "2026-03-31", title: "FOMC Rate Decision", desc: "Federal Reserve interest rate decision and press conference. Market expects hold at 4.25-4.50%.", impact: "high" },
      { type: "cpi", date: "2026-04-10", title: "CPI Report (March)", desc: "Consumer Price Index for March 2026. Consensus: 2.8% YoY.", impact: "high" },
      { type: "jobs", date: "2026-04-04", title: "Nonfarm Payrolls (March)", desc: "March 2026 employment report. Consensus: +185K jobs, 3.9% unemployment.", impact: "high" },
    ];
    for (const m of macros) {
      eventStmt.run("claude_macro", m.type, m.date, null, m.title, m.desc, null, null, m.impact, `demo-macro-${m.type}-${m.date}`, mondayOf(m.date));
    }
  })();
  console.log("Calendar events: 6 records (3 company, 3 macro).");

  // ------------------------------------------------------------------
  // 11. Security factors (for Analysis tab heatmap)
  // ------------------------------------------------------------------
  const factorStmt = db.prepare(`
    INSERT OR REPLACE INTO security_factors
      (security_id, interest_rate_sensitive, growth_vs_value, cyclical, international_exposure,
       ai_exposure, tariff_exposure, regulatory_risk, factor_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo')
  `);

  db.transaction(() => {
    const factors: Record<string, string[]> = {
      // [rate, growth/value, cyclical, intl, ai, tariff, regulatory]
      AAPL: ["Moderate", "Growth", "Moderate", "High", "Moderate", "High", "Moderate"],
      MSFT: ["Moderate", "Growth", "Low", "High", "Very High", "Low", "Moderate"],
      GOOGL: ["Low", "Growth", "Moderate", "High", "Very High", "Low", "High"],
      AMZN: ["Moderate", "Growth", "Moderate", "High", "High", "Moderate", "High"],
      NVDA: ["Low", "Growth", "High", "High", "Very High", "High", "Moderate"],
      JPM: ["Very High", "Value", "High", "High", "Moderate", "Low", "Very High"],
      JNJ: ["Low", "Value", "Low", "High", "Low", "Moderate", "Very High"],
      TSLA: ["Moderate", "Growth", "High", "High", "High", "Very High", "Moderate"],
      VTI: ["Moderate", "Blend", "Moderate", "Low", "Moderate", "Moderate", "Moderate"],
      VXUS: ["Moderate", "Blend", "Moderate", "Very High", "Low", "High", "Moderate"],
      BND: ["Very High", "N/A", "Low", "Low", "N/A", "N/A", "Low"],
    };

    for (const [symbol, f] of Object.entries(factors)) {
      const secId = securityIdMap.get(symbol);
      if (secId) factorStmt.run(secId, f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
    }
  })();
  console.log("Security factors: 11 records.");

  // ------------------------------------------------------------------
  // 12. Compute derived data
  // ------------------------------------------------------------------
  console.log("\nComputing derived data...");

  const taxResult = computeTaxLots(db);
  console.log(`Tax lots: ${taxResult.lotsCreated} lots, ${taxResult.salesProcessed} sales processed.`);

  const valResult = computeDailyValuations(db);
  console.log(`Daily valuations: ${valResult.datesComputed} date/account records across ${valResult.accountsProcessed} accounts.`);

  // ------------------------------------------------------------------
  // 13. Update import batch record count
  // ------------------------------------------------------------------
  const totalRecords = db.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number };
  db.prepare("UPDATE import_batches SET record_count = ? WHERE id = ?").run(totalRecords.c, batchId);

  // ------------------------------------------------------------------
  // 14. Optionally copy to production location
  // ------------------------------------------------------------------
  db.close();

  if (REPLACE) {
    if (fs.existsSync(PROD_DB_PATH)) {
      const backup = PROD_DB_PATH + ".backup";
      fs.copyFileSync(PROD_DB_PATH, backup);
      console.log(`\nBacked up existing database to ${path.basename(backup)}`);
    }
    fs.copyFileSync(DEMO_DB_PATH, PROD_DB_PATH);
    console.log(`Copied demo.db -> vanguard.db`);
  }

  console.log(`\nDone! Demo database at: ${DEMO_DB_PATH}`);
  if (!REPLACE) {
    console.log("Run with --replace to also copy to data/vanguard.db");
  }
}

main();
