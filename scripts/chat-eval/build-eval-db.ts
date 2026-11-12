/**
 * build-eval-db.ts: the synthetic database the chat golden evaluation runs on.
 *
 * Copies the demo database (`npm run seed:demo` writes data/demo.db) with
 * VACUUM INTO (the source is opened read-only), migrates the copy, and adds
 * the synthetic rows the golden questions need, dated relative to today
 * (Eastern):
 *   - the Roth account stamped tax-advantaged, with a losing lot (ROTHL);
 *   - a taxable losing lot that is a real harvest candidate (HRVST);
 *   - a pending-statement lot: a taxable loser whose newest holdings row is a
 *     live flat row with no statement behind it (PNDG);
 *   - a short stock in IBKR that rose today (SHRT);
 *   - a live AAPL call expiring in 20 days and an NVDA call that expired 10
 *     days ago (the demo's June 2026 options are expired as well);
 *   - a non-USD holding (KAIZN, priced in JPY, with a JPY rate on file);
 *   - a reinvested dividend pair (VTI, DIVIDEND + REINVESTMENT, same day);
 *   - margin interest paid in IBKR (a negative INTEREST row);
 *   - a Treasury bill maturing in 45 days;
 *   - a taxable gaining lot short of long-term (LTWT) for the wait question.
 * Then it recomputes tax lots and daily valuations with the repo's engines
 * and writes the eval marker and a manifest (symbols and dates only) into
 * `settings`, which run-golden.ts requires before it will run.
 *
 * Every figure is invented. Run from the repo root:
 *   npx tsx scripts/chat-eval/build-eval-db.ts [--from data/demo.db] [--out data/chat-eval/eval-v2.db] [--force]
 * The output path may not be named vanguard.db, and inside the repo it must
 * be git-ignored. The resolved paths are printed first.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../../lib/db/migrate";
import { upsertSecurity, type UpsertSecurityParams } from "../../lib/mutations/securities";
import { computeTaxLots } from "../../lib/compute/tax-lots";
import { computeDailyValuations } from "../../lib/compute/daily-valuation";
import { TAX_TREATMENTS, TAX_TREATMENT_LABELS } from "../../lib/compute/tax-treatment";
import { addDays, todayET } from "../../lib/calendar/date-utils";
import { isMarketClosed } from "../../lib/calendar/market-holidays";
import { isOptionLive } from "../../lib/compute/option-expiry";
import { isCashEquivalentSecurity } from "../../lib/compute/cash-equivalents";
import { getMarketSnapshot, type QuoteFetcher } from "../../lib/queries/market-snapshot";
import { EVAL_FIXTURE_VERSION, EVAL_MARKER_KEY, liveDbRefusal, resolvedDbPath } from "./db-guard";
import { outputPathRefusal } from "./output-guard";
import { EVAL_MANIFEST_KEY, type EvalManifest } from "./manifest";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function die(msg: string): never {
  console.error(`build-eval-db: ${msg}`);
  process.exit(1);
}

/** OCC option symbol: root padded to 6, YYMMDD, C/P, strike x1000 padded to 8. */
function occ(root: string, expiry: string, cp: "C" | "P", strike: number): string {
  const yymmdd = expiry.slice(2, 4) + expiry.slice(5, 7) + expiry.slice(8, 10);
  return `${root.padEnd(6, " ")}${yymmdd}${cp}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/** The trading day on or before `date` (weekends and NYSE holidays skipped). */
function tradingDayOnOrBefore(date: string): string {
  let d = date;
  for (let i = 0; i < 10; i++) {
    if (!isMarketClosed(d)) return d;
    d = addDays(d, -1);
  }
  return d;
}

/** Largest day-over-day change in an account's valuation series the builder accepts. */
export const MAX_DAY_OVER_DAY_CHANGE = 0.15;

export interface FixtureAssertion {
  ok: boolean;
  failures: string[];
}

/**
 * The builder's own checks; the build fails when any is violated.
 *  1. Every account's latest daily valuation prices every holding of its
 *     latest snapshot, and its holdings value equals the sum of those
 *     holdings' adjusted market value within a cent (total = holdings + cash).
 *  2. No day-over-day move in any account's valuation series beyond
 *     MAX_DAY_OVER_DAY_CHANGE (the fixture adds no external flows).
 *  3. Every closing transaction (SELL, SELL_TO_CLOSE, BUY_TO_COVER,
 *     BUY_TO_CLOSE, REDEMPTION, EXPIRED, EXERCISED, ASSIGNED) has its
 *     tax_lot_sales rows. Opening legs (SELL_TO_OPEN, SHORT_SELL) are not
 *     closes and are excluded by design.
 *  4. The market snapshot reads the local book (no outside quote source).
 */
export async function assertFixture(db: Database.Database, today: string): Promise<FixtureAssertion> {
  const failures: string[] = [];
  const accounts = db.prepare("SELECT id, name FROM accounts").all() as { id: number; name: string }[];
  for (const a of accounts) {
    const v = db
      .prepare(
        `SELECT valuation_date, holdings_value, cash_balance, total_value, holdings_count, priced_count
           FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date DESC LIMIT 1`,
      )
      .get(a.id) as
      | { valuation_date: string; holdings_value: number; cash_balance: number; total_value: number; holdings_count: number; priced_count: number }
      | undefined;
    if (!v) {
      failures.push(`${a.name}: no daily valuation`);
      continue;
    }
    const rows = db
      .prepare(
        `SELECT h.quantity, s.security_type, s.fund_category, COALESCE(s.multiplier, 1) AS multiplier,
                (SELECT p.close_price FROM prices p WHERE p.security_id = h.security_id AND p.date <= h.as_of_date
                  ORDER BY p.date DESC LIMIT 1) AS price,
                COALESCE(fx.usd_per_unit, 1) AS fx
           FROM holdings h
           JOIN securities s ON s.id = h.security_id
           LEFT JOIN fx_rates fx ON fx.currency = s.currency
          WHERE h.account_id = ? AND h.as_of_date = ? AND h.quantity != 0`,
      )
      .all(a.id, v.valuation_date) as {
      quantity: number;
      security_type: string | null;
      fund_category: string | null;
      multiplier: number;
      price: number | null;
      fx: number;
    }[];
    const nonCash = rows.filter((r) => !isCashEquivalentSecurity(r));
    if (v.priced_count !== v.holdings_count) failures.push(`${a.name}: ${v.priced_count} of ${v.holdings_count} holdings priced on ${v.valuation_date}`);
    if (v.holdings_count !== nonCash.length) failures.push(`${a.name}: valuation counts ${v.holdings_count} holdings, the snapshot has ${nonCash.length}`);
    const sum = nonCash.reduce((s, r) => {
      const mv = (r.security_type ?? "").toLowerCase() === "bond" ? (r.quantity * (r.price ?? 0)) / 100 : r.quantity * (r.price ?? 0) * r.multiplier;
      return s + mv * r.fx;
    }, 0);
    if (Math.abs(sum - v.holdings_value) > 0.01) {
      failures.push(`${a.name}: holdings value ${v.holdings_value.toFixed(2)} != sum of its holdings ${sum.toFixed(2)}`);
    }
    if (Math.abs(v.holdings_value + v.cash_balance - v.total_value) > 0.01) failures.push(`${a.name}: total != holdings + cash`);

    const series = db
      .prepare("SELECT valuation_date, total_value FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date")
      .all(a.id) as { valuation_date: string; total_value: number }[];
    for (let i = 2; i < series.length; i++) {
      const prev = series[i - 1].total_value;
      if (prev <= 0) continue;
      const change = Math.abs(series[i].total_value - prev) / prev;
      if (change > MAX_DAY_OVER_DAY_CHANGE) {
        failures.push(`${a.name}: ${(change * 100).toFixed(1)}% move ${series[i - 1].valuation_date} -> ${series[i].valuation_date}`);
      }
    }
  }
  const unmatched = db
    .prepare(
      `SELECT t.id, s.symbol, t.type, t.trade_date FROM transactions t JOIN securities s ON s.id = t.security_id
        WHERE UPPER(t.type) IN ('SELL', 'SELL_TO_CLOSE', 'BUY_TO_COVER', 'BUY_TO_CLOSE', 'REDEMPTION', 'EXPIRED', 'EXERCISED', 'ASSIGNED')
          AND NOT EXISTS (SELECT 1 FROM tax_lot_sales x WHERE x.sale_transaction_id = t.id)`,
    )
    .all() as { id: number; symbol: string; type: string; trade_date: string }[];
  for (const u of unmatched) failures.push(`closing ${u.type} ${u.symbol} ${u.trade_date} (txn ${u.id}) has no tax_lot_sales rows`);

  const snap = await localSnapshotCheck(db, today);
  if (snap) failures.push(snap);
  return { ok: failures.length === 0, failures };
}

/**
 * Why the app's market snapshot would NOT read this database locally, or
 * null when it does. Calls the app's own reader in process with a quote
 * fetcher that records and refuses every outside request.
 */
export async function localSnapshotCheck(db: Database.Database, today: string): Promise<string | null> {
  const asked: string[] = [];
  const fetchQuotes: QuoteFetcher = async (symbols) => {
    asked.push(...symbols);
    return null;
  };
  const snap = await getMarketSnapshot(db, { today, fetchQuotes });
  if (snap.source !== "local" || asked.length > 0) {
    return `the market snapshot would use source "${snap.source}"${asked.length ? ` and ask the outside quote source for ${asked.length} symbols` : ""}: ${snap.note}`;
  }
  return null;
}

export function buildEvalFixture(db: Database.Database, today: string): EvalManifest {
  // The market snapshot reads the local book when SPY has a CONSECUTIVE
  // trading-day pair (latest, prior) in `prices` and the latest is at most
  // MARKET_SNAPSHOT_STALE_DAYS (4) calendar days before today
  // (lib/queries/market-snapshot.ts, resolveTradingDayPair in
  // lib/digest/anomalies.ts); otherwise it falls back to live Yahoo quotes.
  // So every held name and the benchmarks get closes on the last two trading
  // days on or before the day the fixture is built for.
  const priceDay = tradingDayOnOrBefore(today);
  const prevDay = tradingDayOnOrBefore(addDays(priceDay, -1));
  // One name keeps an old (but still in the valuation window) price so the
  // data-confidence question has a real stale price to name.
  const staleDay = tradingDayOnOrBefore(addDays(priceDay, -6));

  const accounts = db.prepare("SELECT id, name FROM accounts").all() as { id: number; name: string }[];
  const byName = new Map(accounts.map((a) => [a.name, a.id]));
  const taxable = byName.get("Vanguard Taxable");
  const roth = byName.get("Vanguard Roth IRA");
  const ibkr = byName.get("IBKR");
  if (!taxable || !roth || !ibkr) throw new Error("the demo accounts (Vanguard Taxable, Vanguard Roth IRA, IBKR) are missing");

  // The Roth token comes from the single-source vocabulary, by its label.
  const rothTreatment = TAX_TREATMENTS.find((t) => TAX_TREATMENT_LABELS[t] === "Roth IRA");
  if (!rothTreatment) throw new Error("no Roth IRA tax treatment in lib/compute/tax-treatment.ts");
  db.prepare("UPDATE accounts SET tax_treatment = ? WHERE id = ?").run(rothTreatment, roth);

  // The demo seed writes SELL quantities negative; the app's convention
  // (lib/import/parsers/canonical-csv.ts) is a positive quantity with the type
  // carrying direction, and the lot engine matches only positive sells.
  db.prepare("UPDATE transactions SET quantity = ABS(quantity) WHERE UPPER(type) = 'SELL' AND quantity < 0").run();

  const batch = Number(
    db
      .prepare("INSERT INTO import_batches (filename, source_type, status, record_count, summary) VALUES (?, ?, ?, ?, ?)")
      .run("chat-eval-fixture", "demo", "completed", 0, "Synthetic rows for the chat golden evaluation").lastInsertRowid,
  );

  // The demo's last full snapshot date (every account has one there).
  // (A whole-table date, not "latest holdings": the fixture appends full snapshots after it.)
  const d0 = (db.prepare("SELECT as_of_date AS d FROM holdings ORDER BY as_of_date DESC LIMIT 1").get() as { d: string }).d;

  const liveExpiry = addDays(today, 20);
  const expiredExpiry = addDays(today, -10);
  const msftExpiry = addDays(today, 45);
  const billMaturity = addDays(today, 45);
  const ltwtAcquired = addDays(today, -300);
  const preD0 = addDays(d0, -20);

  const sec = (p: UpsertSecurityParams, currency = "USD", extra: { geography?: string; exchange?: string } = {}): number => {
    const id = upsertSecurity(db, p);
    db.prepare("UPDATE securities SET currency = ?, geography = COALESCE(?, geography), exchange = COALESCE(?, exchange) WHERE id = ?").run(
      currency,
      extra.geography ?? null,
      extra.exchange ?? null,
      id,
    );
    return id;
  };
  const optSec = (root: string, expiry: string, strike: number) =>
    sec({
      symbol: occ(root, expiry, "C", strike),
      name: `${root} ${expiry} $${strike} Call`,
      securityType: "option",
      assetClass: "equity",
      underlyingSymbol: root,
      strikePrice: strike,
      expirationDate: expiry,
      optionType: "CALL",
      multiplier: 100,
    });

  const ids = {
    ROTHL: sec({ symbol: "ROTHL", name: "Rothlake Industries", securityType: "stock", assetClass: "equity" }),
    HRVST: sec({ symbol: "HRVST", name: "Harvest Ridge Corp", securityType: "stock", assetClass: "equity" }),
    PNDG: sec({ symbol: "PNDG", name: "Pendleton Group", securityType: "stock", assetClass: "equity" }),
    SHRT: sec({ symbol: "SHRT", name: "Shortfield Labs", securityType: "stock", assetClass: "equity" }),
    KAIZN: sec(
      { symbol: "KAIZN", name: "Kaizen Motors (Tokyo listing)", securityType: "stock", assetClass: "equity" },
      "JPY",
      { geography: "International Developed", exchange: "TSE" },
    ),
    LTWT: sec({ symbol: "LTWT", name: "Longwait Partners", securityType: "stock", assetClass: "equity" }),
    BILL: sec({ symbol: "912797ZZ9", name: `US Treasury Bill ${billMaturity}`, securityType: "bond", assetClass: "fixed_income", maturityDate: billMaturity }),
    LIVEOPT: optSec("AAPL", liveExpiry, 260),
    DEADOPT: optSec("NVDA", expiredExpiry, 150),
    MSFTOPT: optSec("MSFT", msftExpiry, 480),
    SPY: sec({ symbol: "SPY", name: "SPDR S&P 500 ETF", securityType: "etf", assetClass: "equity" }),
    QQQ: sec({ symbol: "QQQ", name: "Invesco QQQ Trust", securityType: "etf", assetClass: "equity" }),
    DIA: sec({ symbol: "DIA", name: "SPDR Dow Jones Industrial Average ETF", securityType: "etf", assetClass: "equity" }),
  };
  const idOf = (symbol: string) => (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as { id: number } | undefined)?.id;
  const vti = idOf("VTI");
  const jnj = idOf("JNJ");
  if (!vti || !jnj) throw new Error("the demo VTI / JNJ securities are missing");

  db.prepare(
    `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.0066, ?, 'chat-eval')
     ON CONFLICT(currency) DO UPDATE SET usd_per_unit = excluded.usd_per_unit, as_of = excluded.as_of, source = excluded.source`,
  ).run(priceDay);

  const tx = db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key, import_batch_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  const t = (acct: number, secId: number | null, date: string, type: string, qty: number | null, amount: number, pps: number | null, notes: string | null = null) =>
    tx.run(acct, secId, date, type, qty, amount, pps, 0, `eval:${type}:${acct}:${secId ?? "cash"}:${date}:${n++}`, batch, notes);

  t(roth, ids.ROTHL, addDays(today, -200), "BUY", 50, -5000, 100);
  t(taxable, ids.HRVST, addDays(today, -150), "BUY", 40, -3200, 80);
  t(taxable, ids.PNDG, preD0, "BUY", 30, -2700, 90);
  t(ibkr, ids.SHRT, addDays(today, -40), "SHORT_SELL", 30, 1200, 40);
  // Native currency: 100 shares at JPY 2,300.
  t(ibkr, ids.KAIZN, addDays(today, -90), "BUY", 100, -230000, 2300);
  t(taxable, ids.LTWT, ltwtAcquired, "BUY", 60, -3000, 50);
  t(taxable, ids.BILL, addDays(today, -130), "BUY", 10000, -9890, 98.9);
  t(ibkr, ids.LIVEOPT, addDays(today, -30), "BUY_TO_OPEN", 2, -1000, 5);
  t(ibkr, ids.DEADOPT, preD0, "BUY_TO_OPEN", 1, -300, 3);
  t(ibkr, ids.MSFTOPT, addDays(today, -20), "BUY_TO_OPEN", 2, -1500, 7.5);
  const reinvestDate = addDays(today, -45);
  t(taxable, vti, reinvestDate, "DIVIDEND", null, 120, null);
  t(taxable, vti, reinvestDate, "REINVESTMENT", 0.4, -120, 300);
  t(ibkr, null, addDays(today, -20), "INTEREST", null, -35, null, "Margin interest (synthetic)");

  // ── Prices ─────────────────────────────────────────────────────
  const price = db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'demo')");
  const fixturePrices: [number, number, number][] = [
    // [security, previous close, latest close]
    [ids.ROTHL, 61, 60],
    [ids.HRVST, 51, 50],
    [ids.PNDG, 56, 55],
    [ids.SHRT, 44, 46],
    [ids.KAIZN, 2480, 2500],
    [ids.LTWT, 69, 70],
    [ids.BILL, 99.55, 99.6],
    [ids.LIVEOPT, 5.8, 6.1],
    [ids.MSFTOPT, 7.6, 8],
    [ids.SPY, 600, 606],
    [ids.QQQ, 520, 530],
    [ids.DIA, 440, 442],
  ];
  for (const [id, prev, close] of fixturePrices) {
    price.run(id, staleDay, prev);
    price.run(id, prevDay, prev);
    price.run(id, priceDay, close);
  }
  // The expired NVDA call is part of the demo's last snapshot, priced there.
  price.run(ids.DEADOPT, d0, 3);
  price.run(ids.PNDG, d0, 90);

  // ── Holdings: full snapshots ───────────────────────────────────
  // The valuation engine values an account on a date from the holdings rows
  // with EXACTLY that as_of_date (lib/compute/daily-valuation.ts), so a
  // partial today-dated set would value the whole account at those few
  // rows. Every new snapshot here therefore carries every open position.
  const hold = db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const h = (acct: number, secId: number, qty: number, basis: number, date: string, prefix = "canonical:hold:eval:") =>
    hold.run(acct, secId, qty, basis, date, `${prefix}${acct}:${secId}:${date}`, batch);

  // Added to the demo's last snapshot: positions opened before it.
  h(taxable, ids.PNDG, 30, 2700, d0);
  h(ibkr, ids.DEADOPT, 1, 300, d0);

  const carried = (acct: number, date: string) =>
    (
      db
        .prepare(
          `SELECT h.security_id, h.quantity, h.cost_basis, s.security_type, s.expiration_date
             FROM holdings h JOIN securities s ON s.id = h.security_id
            WHERE h.account_id = ? AND h.as_of_date = ? AND h.quantity != 0`,
        )
        .all(acct, d0) as { security_id: number; quantity: number; cost_basis: number | null; security_type: string | null; expiration_date: string | null }[]
    ).filter((r) => (r.security_type ?? "").toLowerCase() !== "option" || isOptionLive(r.expiration_date, date));

  const lastClose = db.prepare("SELECT close_price FROM prices WHERE security_id = ? AND date <= ? ORDER BY date DESC LIMIT 1");
  const fixtureIds = new Set(fixturePrices.map(([id]) => id));
  const newPositions: [number, number, number, number][] = [
    // [account, security, quantity, cost basis]
    [roth, ids.ROTHL, 50, 5000],
    [taxable, ids.HRVST, 40, 3200],
    [taxable, ids.LTWT, 60, 3000],
    [taxable, ids.BILL, 10000, 9890],
    [ibkr, ids.SHRT, -30, 1200],
    [ibkr, ids.KAIZN, 100, 230000],
    [ibkr, ids.LIVEOPT, 2, 1000],
    [ibkr, ids.MSFTOPT, 2, 1500],
  ];
  // Three full snapshots: the stale-price day (so that price day is a
  // complete valuation, not a cliff), the prior session and the latest.
  for (const date of [staleDay, prevDay, priceDay]) {
    for (const acct of [taxable, roth, ibkr]) {
      for (const r of carried(acct, date)) {
        if (r.security_id === ids.PNDG && date === priceDay) continue; // see the live flat row below
        h(acct, r.security_id, r.quantity, r.cost_basis ?? 0, date);
        if (fixtureIds.has(r.security_id)) continue;
        const close = (lastClose.get(r.security_id, d0) as { close_price: number } | undefined)?.close_price;
        if (close === undefined) continue;
        // JNJ keeps only its stale-day close: a real stale price, still inside the valuation window.
        if (r.security_id === jnj && date !== staleDay) continue;
        price.run(r.security_id, date, close);
      }
    }
    for (const [acct, id, qty, basis] of newPositions) h(acct, id, qty, basis, date);
  }
  // Pending: the statement rows show the shares (d0 and prevDay); the newest
  // row is a LIVE flat row with no statement behind it
  // (lib/queries/pending-statement.ts, awaiting_statement).
  h(taxable, ids.PNDG, 0, 0, priceDay, "plaid:eval:");

  computeTaxLots(db);
  computeDailyValuations(db);

  const manifest: EvalManifest = {
    version: EVAL_FIXTURE_VERSION,
    builtFor: today,
    priceDay,
    accounts: { taxable: "Vanguard Taxable", roth: "Vanguard Roth IRA", ibkr: "IBKR" },
    rothLoser: "ROTHL",
    harvestCandidate: "HRVST",
    pendingLot: "PNDG",
    short: "SHRT",
    foreign: { symbol: "KAIZN", currency: "JPY" },
    longTermWait: { symbol: "LTWT", acquired: ltwtAcquired },
    bill: { symbol: "912797ZZ9", maturity: billMaturity },
    liveOption: { symbol: occ("AAPL", liveExpiry, "C", 260), underlying: "AAPL", expiry: liveExpiry },
    expiredOption: { symbol: occ("NVDA", expiredExpiry, "C", 150), underlying: "NVDA", expiry: expiredExpiry },
    reinvestedDividend: { symbol: "VTI", date: reinvestDate },
    multiAccountName: "MSFT",
    multiAccountOption: { symbol: occ("MSFT", msftExpiry, "C", 480), expiry: msftExpiry },
    staleName: "JNJ",
    unknownTicker: "ZZZZ",
  };

  const setting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  setting.run(EVAL_MANIFEST_KEY, JSON.stringify(manifest));
  setting.run(EVAL_MARKER_KEY, EVAL_FIXTURE_VERSION);
  return manifest;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const from = arg(argv, "--from") ?? path.join("data", "demo.db");
  const out = arg(argv, "--out") ?? path.join("data", "chat-eval", "eval-v2.db");
  const force = argv.includes("--force");

  const fromRefusal = liveDbRefusal(from);
  if (fromRefusal) die(`source: ${fromRefusal}`);
  const outRefusal = liveDbRefusal(out) ?? outputPathRefusal(out);
  if (outRefusal) die(`output: ${outRefusal}`);

  const fromAbs = resolvedDbPath(from);
  const outAbs = resolvedDbPath(out);
  console.log(`source database: ${fromAbs}`);
  console.log(`eval database:   ${outAbs}`);

  if (!fs.existsSync(fromAbs)) die(`no such file ${fromAbs}; run \`npm run seed:demo\` first`);
  if (fs.existsSync(outAbs)) {
    if (!force) die(`${outAbs} exists; pass --force to replace it`);
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(outAbs + suffix, { force: true });
  }
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const src = new Database(fromAbs, { readonly: true, fileMustExist: true });
  try {
    const isDemo = src
      .prepare("SELECT 1 FROM import_batches WHERE source_type = 'demo' LIMIT 1")
      .get();
    if (!isDemo) die(`${fromAbs} does not look like the demo database (no 'demo' import batch)`);
    src.prepare("VACUUM INTO ?").run(outAbs);
  } finally {
    src.close();
  }

  const db = new Database(outAbs);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    runMigrations(db);
    const today = todayET();
    const manifest = db.transaction(() => buildEvalFixture(db, today))();
    const check = await assertFixture(db, today);
    if (!check.ok) {
      // A fixture that breaks its own checks would skew every answer: remove the marker so no run can use it.
      db.prepare("DELETE FROM settings WHERE key = ?").run(EVAL_MARKER_KEY);
      for (const f of check.failures) console.error(`  FAIL ${f}`);
      die(`the fixture failed ${check.failures.length} check(s); the eval marker was removed`);
    }
    console.log(`fixture built for ${manifest.builtFor} (prices dated ${manifest.priceDay}); checks passed; marker ${EVAL_MARKER_KEY}=${manifest.version}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && /build-eval-db\.ts$/.test(process.argv[1])) {
  main().catch((err) => die((err as Error)?.message ?? String(err)));
}
