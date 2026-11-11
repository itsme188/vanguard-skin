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
 *   npx tsx scripts/chat-eval/build-eval-db.ts [--from data/demo.db] [--out data/chat-eval/eval.db] [--force]
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

/** The weekday on or before `date`. */
function weekdayOnOrBefore(date: string): string {
  let d = date;
  for (let i = 0; i < 7; i++) {
    const dow = new Date(d + "T12:00:00Z").getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDays(d, -1);
  }
  return d;
}

export function buildEvalFixture(db: Database.Database, today: string): EvalManifest {
  const priceDay = weekdayOnOrBefore(today);
  const prevDay = weekdayOnOrBefore(addDays(priceDay, -1));

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

  const batch = Number(
    db
      .prepare("INSERT INTO import_batches (filename, source_type, status, record_count, summary) VALUES (?, ?, ?, ?, ?)")
      .run("chat-eval-fixture", "demo", "completed", 0, "Synthetic rows for the chat golden evaluation").lastInsertRowid,
  );

  const liveExpiry = addDays(today, 20);
  const expiredExpiry = addDays(today, -10);
  const billMaturity = addDays(today, 45);
  const ltwtAcquired = addDays(today, -300);

  const sec = (p: UpsertSecurityParams, currency = "USD"): number => {
    const id = upsertSecurity(db, p);
    db.prepare("UPDATE securities SET currency = ? WHERE id = ?").run(currency, id);
    return id;
  };

  const ids = {
    ROTHL: sec({ symbol: "ROTHL", name: "Rothlake Industries", securityType: "stock", assetClass: "equity" }),
    HRVST: sec({ symbol: "HRVST", name: "Harvest Ridge Corp", securityType: "stock", assetClass: "equity" }),
    PNDG: sec({ symbol: "PNDG", name: "Pendleton Group", securityType: "stock", assetClass: "equity" }),
    SHRT: sec({ symbol: "SHRT", name: "Shortfield Labs", securityType: "stock", assetClass: "equity" }),
    KAIZN: sec({ symbol: "KAIZN", name: "Kaizen Motors (Tokyo listing)", securityType: "stock", assetClass: "equity" }, "JPY"),
    LTWT: sec({ symbol: "LTWT", name: "Longwait Partners", securityType: "stock", assetClass: "equity" }),
    BILL: sec({
      symbol: "912797ZZ9",
      name: `US Treasury Bill ${billMaturity}`,
      securityType: "bond",
      assetClass: "fixed_income",
      maturityDate: billMaturity,
    }),
    LIVEOPT: sec({
      symbol: occ("AAPL", liveExpiry, "C", 260),
      name: `AAPL ${liveExpiry} $260 Call`,
      securityType: "option",
      assetClass: "equity",
      underlyingSymbol: "AAPL",
      strikePrice: 260,
      expirationDate: liveExpiry,
      optionType: "CALL",
      multiplier: 100,
    }),
    DEADOPT: sec({
      symbol: occ("NVDA", expiredExpiry, "C", 150),
      name: `NVDA ${expiredExpiry} $150 Call`,
      securityType: "option",
      assetClass: "equity",
      underlyingSymbol: "NVDA",
      strikePrice: 150,
      expirationDate: expiredExpiry,
      optionType: "CALL",
      multiplier: 100,
    }),
  };
  const vti = (db.prepare("SELECT id FROM securities WHERE symbol = 'VTI'").get() as { id: number } | undefined)?.id;
  if (!vti) throw new Error("the demo VTI security is missing");

  db.prepare(
    `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.0066, ?, 'chat-eval')
     ON CONFLICT(currency) DO UPDATE SET usd_per_unit = excluded.usd_per_unit, as_of = excluded.as_of, source = excluded.source`,
  ).run(priceDay);

  const price = db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'demo')");
  const prices: [number, number, number][] = [
    // [security, previous close, today's close]
    [ids.ROTHL, 61, 60],
    [ids.HRVST, 51, 50],
    [ids.PNDG, 56, 55],
    [ids.SHRT, 44, 46],
    [ids.KAIZN, 2480, 2500],
    [ids.LTWT, 69, 70],
    [ids.BILL, 99.55, 99.6],
    [ids.LIVEOPT, 5.8, 6.1],
  ];
  for (const [id, prev, close] of prices) {
    price.run(id, prevDay, prev);
    price.run(id, priceDay, close);
  }
  price.run(ids.DEADOPT, addDays(expiredExpiry, -5), 0.4);

  const tx = db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key, import_batch_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  const t = (acct: number, secId: number | null, date: string, type: string, qty: number | null, amount: number, pps: number | null, notes: string | null = null) =>
    tx.run(acct, secId, date, type, qty, amount, pps, 0, `eval:${type}:${acct}:${secId ?? "cash"}:${date}:${n++}`, batch, notes);

  t(roth, ids.ROTHL, addDays(today, -200), "BUY", 50, -5000, 100);
  t(taxable, ids.HRVST, addDays(today, -150), "BUY", 40, -3200, 80);
  t(taxable, ids.PNDG, addDays(today, -120), "BUY", 30, -2700, 90);
  t(ibkr, ids.SHRT, addDays(today, -40), "SHORT_SELL", 30, 1200, 40);
  t(ibkr, ids.KAIZN, addDays(today, -90), "BUY", 100, -230000, 2300);
  t(taxable, ids.LTWT, ltwtAcquired, "BUY", 60, -3000, 50);
  t(taxable, ids.BILL, addDays(today, -130), "BUY", 10000, -9890, 98.9);
  t(ibkr, ids.LIVEOPT, addDays(today, -30), "BUY_TO_OPEN", 2, -1000, 5);
  t(ibkr, ids.DEADOPT, addDays(today, -60), "BUY_TO_OPEN", 1, -300, 3);
  const reinvestDate = addDays(today, -45);
  t(taxable, vti, reinvestDate, "DIVIDEND", null, 120, null);
  t(taxable, vti, reinvestDate, "REINVESTMENT", 0.4, -120, 300);
  t(ibkr, null, addDays(today, -20), "INTEREST", null, -35, null, "Margin interest (synthetic)");

  const hold = db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const h = (acct: number, secId: number, qty: number, basis: number, date: string, prefix = "canonical:hold:eval:") =>
    hold.run(acct, secId, qty, basis, date, `${prefix}${acct}:${secId}:${date}`, batch);

  h(roth, ids.ROTHL, 50, 5000, priceDay);
  h(taxable, ids.HRVST, 40, 3200, priceDay);
  // Pending: a statement row with the shares, then a newer LIVE flat row
  // with no statement behind it (lib/queries/pending-statement.ts).
  h(taxable, ids.PNDG, 30, 2700, addDays(today, -100));
  h(taxable, ids.PNDG, 0, 0, priceDay, "plaid:eval:");
  h(ibkr, ids.SHRT, -30, 1200, priceDay);
  h(ibkr, ids.KAIZN, 100, 230000, priceDay);
  h(taxable, ids.LTWT, 60, 3000, priceDay);
  h(taxable, ids.BILL, 10000, 9890, priceDay);
  h(ibkr, ids.LIVEOPT, 2, 1000, priceDay);
  h(ibkr, ids.DEADOPT, 1, 300, addDays(expiredExpiry, -5));

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
    unknownTicker: "ZZZZ",
  };

  const setting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  setting.run(EVAL_MANIFEST_KEY, JSON.stringify(manifest));
  setting.run(EVAL_MARKER_KEY, EVAL_FIXTURE_VERSION);
  return manifest;
}

function main(): void {
  const argv = process.argv.slice(2);
  const from = arg(argv, "--from") ?? path.join("data", "demo.db");
  const out = arg(argv, "--out") ?? path.join("data", "chat-eval", "eval.db");
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
    console.log(`fixture built for ${manifest.builtFor} (prices dated ${manifest.priceDay}); marker ${EVAL_MARKER_KEY}=${manifest.version}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && /build-eval-db\.ts$/.test(process.argv[1])) main();
