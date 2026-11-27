/**
 * scripts/audit-plaid-session-dating.ts and its gates
 * (lib/repair/plaid-session-dating-audit.ts), plan v4 D7 and OPEN-7.
 *
 * Synthetic fixture only: made-up securities (FAKE*), round invented numbers,
 * invented 2027 dates, a synthetic measured-set config. The fixture follows
 * the repair test's shape (tests/scripts/repair-plaid-session-dating.test.ts),
 * plus what G1 and G7 need: the funds FAKEF and FAKEG in every taxable Plaid
 * book, a Saturday statement (04-10), a bond and a money-market fund only the
 * statements list, a dividend reinvestment the statement shows before Plaid
 * does, and a fund whose Plaid quantity is short on every statement.
 *
 * The REAL repair (its command line, in-process) builds the manifest and the
 * after copy once; every test works on fresh copies of the three files and
 * breaks exactly what it names.
 *
 * Calendar (2027, Eastern daylight time, UTC-4):
 *   Wed 03-31 statement; Sat 04-03 closed-day go-live (duplicate of Mon 04-05);
 *   Mon 04-05, Tue 04-06 pre-open; Wed 04-07 read after the open (ruled drop);
 *   Thu 04-08, Fri 04-09 pre-open; Sat 04-10 statement; Mon 04-12, Thu 04-29
 *   pre-open; Fri 04-30 statement with a partial taxable Plaid book; Mon 05-03
 *   pre-open (lands on the 04-30 statement); Tue 05-04 pre-open.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { REMINT_ACTIONS, rowHash, type MeasuredSetConfig, type PlaidSessionDatingManifest } from "@/lib/repair/plaid-session-dating-plan";
import {
  CLOSURE_CHECK_ACTIONS,
  runPlaidSessionDatingAudit,
  type GateId,
  type GateResult,
} from "@/lib/repair/plaid-session-dating-audit";
import { undoImport } from "@/lib/import/engine";
import { main as repairMain } from "../../scripts/repair-plaid-session-dating";
import { main as auditMain } from "../../scripts/audit-plaid-session-dating";

// ── Fixture ──────────────────────────────────────────────────────────────

const PRE = (d: string) => `${d} 11:31:00`; // 07:31 EDT
const POST = (d: string) => `${d} 21:22:00`; // 17:22 EDT

const CONFIG: MeasuredSetConfig = {
  rows: [
    { accountRole: "both", runDay: "2027-04-03", class: "CLOSED_DAY", action: "DROP_DUPLICATE_SESSION" },
    { accountRole: "both", runDay: "2027-04-07", class: "POST_OPEN", action: "DROP_BY_RULING" },
    { accountRole: "taxable", runDay: "2027-04-30", class: "UNKNOWN", action: "DROP_PARTIAL_BOOK" },
  ],
  f2Since: "2027-04-08",
};

interface Ids {
  T: number;
  R: number;
  sec: Record<string, number>;
  batch: Record<string, number>;
}

interface Base {
  dir: string;
  before: string;
  after: string;
  manifest: string;
  config: string;
  ids: Ids;
}

let base: Base;

function insertSecurity(db: Database.Database, symbol: string, type: string, category: string | null = null): number {
  return Number(
    db.prepare(`INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)`).run(symbol, symbol, type, category)
      .lastInsertRowid,
  );
}

function buildBefore(dbPath: string, extra?: (db: Database.Database, ids: Ids) => void): Ids {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const acct = (name: string) => (db.prepare(`SELECT id FROM accounts WHERE name = ?`).get(name) as { id: number }).id;
  const T = acct("Vanguard Taxable");
  const R = acct("Vanguard Roth IRA");
  db.prepare(`UPDATE accounts SET tax_treatment = 'roth_ira' WHERE id = ?`).run(R);
  const sec: Record<string, number> = {};
  for (const s of ["FAKE1", "FAKE2", "FAKE3", "FAKE4", "FAKE5", "FAKE6", "FAKE7", "FAKE8", "FAKE9", "FAKEP"]) sec[s] = insertSecurity(db, s, "Stock");
  sec.FAKEQ = insertSecurity(db, "FAKEQ", "ETF");
  sec.FAKEF = insertSecurity(db, "FAKEF", "Mutual Fund");
  sec.FAKEG = insertSecurity(db, "FAKEG", "Mutual Fund");
  sec.FAKEB = insertSecurity(db, "FAKEB", "Bond");
  sec.FAKEM = insertSecurity(db, "FAKEM", "Mutual Fund", "Cash Equivalent");
  const batch: Record<string, number> = {};

  const holding = (acctId: number, sym: string, date: string, qty: number, key: string, batchId: number | null = null, cost: number | null = null) =>
    db
      .prepare(`INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, import_batch_id, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(acctId, sec[sym], qty, cost, date, batchId, key);
  const plaidRow = (a: number, sym: string, runDay: string, qty: number) => holding(a, sym, runDay, qty, `plaid:${a}:${sec[sym]}:${runDay}`);
  const tomb = (a: number, sym: string, date: string, suffix: "" | ":live" | ":stmt") =>
    holding(a, sym, date, 0, `recon:closed-equity:${a}:${sec[sym]}:${date}${suffix}`, null, 0);
  const snapshot = (a: number, date: string, total: number, cash: number | null, source: string, createdAt: string | null) =>
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      a,
      date,
      total,
      cash,
      source,
      createdAt,
    );
  const plaidBook = (a: number, runDay: string, createdAt: string, total: number, cash: number, rows: [string, number][]) => {
    snapshot(a, runDay, total, cash, "plaid", createdAt);
    for (const [sym, q] of rows) plaidRow(a, sym, runDay, q);
  };
  const price = (sym: string, date: string, close: number, source: string) =>
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)`).run(sec[sym], date, close, source);
  const txn = (a: number, sym: string, date: string, type: string, qty: number, amount: number, key: string, batchId: number | null = null) =>
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, import_batch_id, trade_date, type, quantity, amount, price_per_share, source_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a, sec[sym], batchId, date, type, qty, amount, 10, key);
  const statementBatch = (date: string, rows: { acct: number; name: string; sym: string; qty: number }[]) => {
    const id = Number(
      db.prepare(`INSERT INTO import_batches (filename, source_type, status) VALUES (?, 'vanguard-pdf', 'completed')`).run(`stmt-${date}.pdf`)
        .lastInsertRowid,
    );
    const parsed = {
      sourceType: "vanguard-pdf",
      holdings: rows.map((h) => ({ accountName: h.name, symbol: h.sym, quantity: h.qty, asOfDate: date, sourceKey: `vanguard-pdf:holding:${h.acct}:${h.sym}:${date}` })),
    };
    db.prepare(`INSERT INTO raw_imports (import_batch_id, raw_data) VALUES (?, ?)`).run(id, JSON.stringify(parsed));
    for (const h of rows) holding(h.acct, h.sym, date, h.qty, `vanguard-pdf:holding:${h.acct}:${h.sym}:${date}`, id, h.qty * 10);
    return id;
  };
  const TN = "Vanguard Taxable";
  const RN = "Vanguard Roth IRA";
  const tx = (sym: string, qty: number) => ({ acct: T, name: TN, sym, qty });
  const funds: [string, number][] = [["FAKEF", 10], ["FAKEG", 8]];
  // FAKE9 bought Tue 04-06 (its session's book is the ruled drop); FAKE8 bought
  // Thu 04-08 and shown by Plaid one book late. Both held from then on.
  const f9: [string, number][] = [["FAKE9", 6]];
  const f8: [string, number][] = [["FAKE8", 4], ["FAKE9", 6]];

  // 03-31 statement.
  batch.m1 = statementBatch("2027-03-31", [
    tx("FAKE1", 100), tx("FAKE2", 50), tx("FAKE3", 20), tx("FAKEF", 10), tx("FAKEG", 9), tx("FAKEB", 5), tx("FAKEM", 1000),
    { acct: R, name: RN, sym: "FAKE1", qty: 30 }, { acct: R, name: RN, sym: "FAKE4", qty: 5 },
  ]);
  snapshot(T, "2027-03-31", 10000, null, "vanguard-pdf", "2027-04-02 12:00:00");
  snapshot(R, "2027-03-31", 3000, null, "vanguard-pdf", "2027-04-02 12:00:00");

  // Sat 04-03 go-live and its twin Mon 04-05.
  plaidBook(T, "2027-04-03", "2027-04-03 15:00:00", 9000, 500, [["FAKE1", 100], ["FAKE2", 50], ...funds]);
  tomb(T, "FAKE3", "2027-04-03", ":live");
  plaidBook(R, "2027-04-03", "2027-04-03 15:00:00", 3000, 100, [["FAKE1", 30]]);
  tomb(R, "FAKE4", "2027-04-03", "");
  plaidBook(T, "2027-04-05", PRE("2027-04-05"), 9000, 500, [["FAKE1", 100], ["FAKE2", 50], ...funds]);
  plaidBook(R, "2027-04-05", PRE("2027-04-05"), 3000, 100, [["FAKE1", 30]]);
  plaidBook(T, "2027-04-06", PRE("2027-04-06"), 9100, 500, [["FAKE1", 100], ["FAKE2", 50], ...funds]);
  plaidBook(R, "2027-04-06", PRE("2027-04-06"), 3010, 100, [["FAKE1", 30]]);
  plaidBook(T, "2027-04-07", POST("2027-04-07"), 9200, 300, [["FAKE1", 120], ["FAKE2", 50], ...funds]);
  plaidBook(R, "2027-04-07", POST("2027-04-07"), 3020, 100, [["FAKE1", 30]]);
  plaidBook(T, "2027-04-08", PRE("2027-04-08"), 9300, 270, [["FAKE1", 120], ["FAKE2", 50], ["FAKE7", 3], ...funds, ...f9]);
  plaidBook(R, "2027-04-08", PRE("2027-04-08"), 3030, 100, [["FAKE1", 30]]);
  plaidBook(T, "2027-04-09", PRE("2027-04-09"), 9310, 270, [["FAKE1", 120], ["FAKE2", 50], ["FAKE7", 3], ...funds, ...f9]);
  plaidBook(R, "2027-04-09", PRE("2027-04-09"), 3040, 100, [["FAKE1", 35]]); // Roth bought 5 on 04-08
  // Sat 04-10 statement (taxable only; it holds the Fri 04-09 close).
  batch.m10 = statementBatch("2027-04-10", [
    tx("FAKE1", 120), tx("FAKE2", 50), tx("FAKEF", 10), tx("FAKEG", 9), tx("FAKEB", 5), tx("FAKEM", 1000), tx("FAKE8", 4), tx("FAKE9", 6),
  ]);
  snapshot(T, "2027-04-10", 9310, 270, "vanguard-pdf", "2027-04-12 12:00:00");
  plaidBook(T, "2027-04-12", PRE("2027-04-12"), 9320, 300, [["FAKE1", 120], ["FAKE2", 50], ...funds, ...f8]);
  tomb(T, "FAKE7", "2027-04-12", ":live");
  plaidBook(R, "2027-04-12", PRE("2027-04-12"), 3050, 100, [["FAKE1", 35]]);
  plaidBook(T, "2027-04-29", PRE("2027-04-29"), 9400, 200, [["FAKE1", 120], ["FAKE2", 50], ["FAKE5", 7], ["FAKE6", 4], ...funds, ...f8]);
  plaidBook(R, "2027-04-29", PRE("2027-04-29"), 3060, 100, [["FAKE1", 30]]);
  // Fri 04-30: partial taxable Plaid book, then the statement.
  plaidRow(T, "FAKE2", "2027-04-30", 50);
  plaidRow(T, "FAKE5", "2027-04-30", 0);
  batch.m2 = statementBatch("2027-04-30", [
    tx("FAKE1", 120), tx("FAKEF", 10.5), tx("FAKEG", 9), tx("FAKEB", 5), tx("FAKEM", 1000), tx("FAKE8", 4), tx("FAKE9", 6),
    { acct: R, name: RN, sym: "FAKE1", qty: 30 },
  ]);
  snapshot(T, "2027-04-30", 9500, 200, "vanguard-pdf", PRE("2027-04-30"));
  snapshot(R, "2027-04-30", 3070, null, "vanguard-pdf", "2027-05-05 12:00:00");
  tomb(T, "FAKE3", "2027-04-30", ":stmt");
  txn(T, "FAKE2", "2027-04-30", "SELL", 50, 500, "test:sell:fake2", batch.m2);
  txn(T, "FAKEF", "2027-04-30", "REINVESTMENT", 0.5, -6, "vanguard-pdf:txn:fakef-reinvest", batch.m2);
  txn(T, "FAKE1", "2027-04-07", "BUY", 20, -200, "test:buy:fake1");
  txn(T, "FAKE7", "2027-04-07", "BUY", 3, -30, "test:buy:fake7");
  txn(T, "FAKE7", "2027-04-09", "SELL", 3, 30, "test:sell:fake7");
  txn(T, "FAKE9", "2027-04-06", "BUY", 6, -60, "test:buy:fake9");
  txn(T, "FAKE8", "2027-04-08", "BUY", 4, -40, "test:buy:fake8");
  txn(R, "FAKE1", "2027-04-08", "BUY", 5, -50, "test:buy:roth-fake1");
  txn(R, "FAKE1", "2027-04-28", "SELL", 5, 50, "test:sell:roth-fake1");
  plaidBook(T, "2027-05-03", PRE("2027-05-03"), 9600, 900, [["FAKE1", 120], ["FAKE2", 50], ...funds, ...f8]);
  tomb(T, "FAKE5", "2027-05-03", ":live");
  tomb(T, "FAKE6", "2027-05-03", ":live");
  plaidBook(R, "2027-05-03", PRE("2027-05-03"), 3071, 100, [["FAKE1", 30]]);
  plaidBook(T, "2027-05-04", PRE("2027-05-04"), 9700, 1400, [["FAKE1", 120], ["FAKEF", 10.5], ["FAKEG", 8], ...f8]);
  tomb(T, "FAKE2", "2027-05-04", ":live");
  plaidBook(R, "2027-05-04", PRE("2027-05-04"), 3090, 100, [["FAKE1", 30]]);

  // Prices.
  price("FAKEF", "2027-03-31", 10.5, "vanguard-pdf");
  price("FAKEF", "2027-04-05", 11.0, "plaid");
  price("FAKEF", "2027-04-06", 11.1, "plaid");
  price("FAKEF", "2027-04-07", 11.2, "plaid");
  price("FAKEF", "2027-04-08", 11.25, "plaid"); // the 04-09 close
  price("FAKEF", "2027-04-10", 11.25, "vanguard-pdf"); // Saturday statement: the 04-09 close
  price("FAKEF", "2027-04-29", 11.9, "plaid");
  price("FAKEF", "2027-04-30", 11.9, "vanguard-pdf");
  price("FAKEP", "2027-04-03", 5.0, "plaid");
  price("FAKEP", "2027-04-06", 5.1, "plaid");
  price("FAKEP", "2027-04-05", 5.05, "tws");
  price("FAKEQ", "2027-04-08", 20.0, "plaid");
  price("FAKE1", "2027-04-30", 10, "vanguard-pdf");
  extra?.(db, { T, R, sec, batch });
  db.close();
  return { T, R, sec, batch };
}

let clock = 0;
function repairDeps(dir: string) {
  const logs: string[] = [];
  return {
    logs,
    d: {
      env: {},
      cwd: dir,
      log: (l: string) => logs.push(l),
      now: () => new Date(Date.UTC(2027, 5, 1, 12, 0, clock++)),
      openHolders: () => [] as number[],
      isLive: () => false,
    },
  };
}

function auditDeps(dir: string) {
  const logs: string[] = [];
  return { logs, d: { env: {}, cwd: dir, log: (l: string) => logs.push(l), now: () => new Date(Date.UTC(2027, 5, 2, 12, 0, clock++)) } };
}

/** Builds a before copy, runs the real repair (dry run, then apply) on an after copy. */
async function buildRepaired(prefix: string, extra?: (db: Database.Database, ids: Ids) => void): Promise<Base> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const before = path.join(dir, "before.db");
  const after = path.join(dir, "after.db");
  const ids = buildBefore(before, extra);
  fs.copyFileSync(before, after);
  const config = path.join(dir, "measured-set.json");
  fs.writeFileSync(config, JSON.stringify(CONFIG));
  const dry = repairDeps(dir);
  expect(await repairMain(["--db", after, "--config", config, "--out", path.join(dir, "out")], dry.d)).toBe(0);
  const manifestLine = dry.logs.find((l) => l.startsWith("Manifest: "));
  expect(manifestLine).toBeDefined();
  const manifest = (manifestLine as string).slice("Manifest: ".length);
  const m = JSON.parse(fs.readFileSync(manifest, "utf8")) as PlaidSessionDatingManifest;
  expect(m.counts.blocking).toBe(0);
  const apply = repairDeps(dir);
  expect(await repairMain(["--db", after, "--config", config, "--apply", "--manifest", manifest], apply.d)).toBe(0);
  return { dir, before, after, manifest, config, ids };
}

beforeAll(async () => {
  base = await buildRepaired("plaid-audit-base-");
}, 60_000);

afterAll(() => {
  if (base) fs.rmSync(path.resolve(base.dir), { recursive: true, force: true });
});

// ── Workspace per test ───────────────────────────────────────────────────

interface Ws {
  dir: string;
  before: string;
  after: string;
  manifest: string;
}

const workspaces: string[] = [];

function ws(): Ws {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaid-audit-"));
  workspaces.push(dir);
  const w = { dir, before: path.join(dir, "before.db"), after: path.join(dir, "after.db"), manifest: path.join(dir, "manifest.json") };
  fs.copyFileSync(base.before, w.before);
  fs.copyFileSync(base.after, w.after);
  fs.copyFileSync(base.manifest, w.manifest);
  return w;
}

afterEach(() => {
  for (const d of workspaces.splice(0)) fs.rmSync(path.resolve(d), { recursive: true, force: true });
});

/** Runs `fn` on a writable connection to each named copy. */
function edit(paths: string[], fn: (db: Database.Database) => void): void {
  for (const p of paths) {
    const db = new Database(p);
    try {
      fn(db);
    } finally {
      db.close();
    }
  }
}

function readManifest(w: Ws): PlaidSessionDatingManifest {
  return JSON.parse(fs.readFileSync(w.manifest, "utf8")) as PlaidSessionDatingManifest;
}

function audit(w: Ws): Record<GateId, GateResult> {
  const before = new Database(w.before, { readonly: true });
  const after = new Database(w.after, { readonly: true });
  try {
    const r = runPlaidSessionDatingAudit(before, after, readManifest(w));
    return Object.fromEntries(r.gates.map((g) => [g.id, g])) as Record<GateId, GateResult>;
  } finally {
    before.close();
    after.close();
  }
}

function failing(g: Record<GateId, GateResult>): GateId[] {
  return (Object.keys(g) as GateId[]).filter((id) => !g[id].pass).sort();
}

const S = () => base.ids.sec;

function holdingId(db: Database.Database, acct: number, sym: string, date: string): number {
  return (db.prepare(`SELECT id FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`).get(acct, S()[sym], date) as { id: number }).id;
}

function fileHash(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// ── Every gate passes on the real repair ─────────────────────────────────

describe("the real repair passes every gate", () => {
  it("G1-G7 pass, with each listed G1 class present", () => {
    const w = ws();
    const g = audit(w);
    expect(failing(g)).toEqual([]);
    expect(g.G1.counts).toMatchObject({
      accounts: 2,
      statementDates: 3, // taxable 04-10 and 04-30, Roth 04-30 (03-31 is before the Plaid era)
      PLAID_SALE_LAG: 1,
      REINVEST_LAG: 1,
      PLAID_PERSISTENT_GAP: 2,
      PLAID_NOT_COVERED: 4, // the bond and the money-market fund on two statements
      missingBuy: 0,
      unexplainedDifference: 0,
      rothRatioFail: 0,
    });
    expect(g.G2.counts).toMatchObject({ gated: 8, ON_TRADE_DATE: 6, PLAID_TRADE_LAG: 1, SESSION_BOOK_DROPPED: 1, LATE: 0, EARLY: 0, onTradeDatePct: 75 });
    expect(g.G2.counts.beforeOnTradeDatePct).toBeLessThan(75);
    expect(g.G5.counts.closures).toBeGreaterThanOrEqual(6);
    expect(g.G5.counts.moveBookChecks).toBeGreaterThan(0);
    expect(g.G7.counts).toMatchObject({ funds: 1, statementPrices: 2, checks: 3, mismatches: 0 });
  });

  it("the command line prints counts only, writes the private report, exits 0, and writes no database", async () => {
    const w = ws();
    const hb = fileHash(w.before);
    const ha = fileHash(w.after);
    const { logs, d } = auditDeps(w.dir);
    const out = path.join(w.dir, "out");
    expect(await auditMain(["--before", w.before, "--after", w.after, "--manifest", w.manifest, "--out", out], d)).toBe(0);
    expect(logs[0]).toContain(`before: ${w.before}`);
    for (const id of ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]) expect(logs.some((l) => l.startsWith(`${id} PASS`))).toBe(true);
    const body = logs.filter((l) => /^G\d /.test(l)).join("\n");
    expect(body).not.toContain("FAKE");
    expect(body).not.toContain("Vanguard");
    expect(body).not.toMatch(/2027-\d\d-\d\d/);
    const report = fs.readdirSync(out).find((n) => n.startsWith("audit-"));
    expect(report).toBeDefined();
    const text = fs.readFileSync(path.join(out, report as string), "utf8");
    expect(text).toContain("PLAID_SALE_LAG");
    expect(text).toContain("REINVEST_LAG");
    expect(fileHash(w.before)).toBe(hb);
    expect(fileHash(w.after)).toBe(ha);
  });

  it("opens a WAL-mode copy without its shared-memory file and leaves it unchanged", async () => {
    const w = ws();
    edit([w.after], (db) => db.pragma("journal_mode = WAL"));
    expect(fs.existsSync(`${w.after}-shm`)).toBe(false);
    const h = fileHash(w.after);
    const { d } = auditDeps(w.dir);
    expect(await auditMain(["--before", w.before, "--after", w.after, "--manifest", w.manifest, "--out", path.join(w.dir, "out")], d)).toBe(0);
    expect(fileHash(w.after)).toBe(h);
  });

  it("refuses bad arguments", async () => {
    const w = ws();
    const { d } = auditDeps(w.dir);
    await expect(auditMain(["--before", w.before], d)).rejects.toThrow(/needs --before/);
    await expect(auditMain(["--db", w.after, "--manifest", w.manifest], d)).rejects.toThrow(/--db is only for/);
    await expect(auditMain(["--before", w.before, "--after", w.before, "--manifest", w.manifest], d)).rejects.toThrow(/same file/);
    await expect(auditMain(["--nope"], d)).rejects.toThrow(/unknown argument/);
  });
});

// ── G1 ───────────────────────────────────────────────────────────────────

describe("G1 statement reconciliation", () => {
  it("a Plaid sale lag passes with a closing ledger row and fails without one", () => {
    const w = ws();
    // Not a long close (it closes a short), so it explains nothing; it stays a traced trade for G2.
    edit([w.before, w.after], (db) => db.prepare(`UPDATE transactions SET type = 'BUY_TO_COVER' WHERE source_key = 'test:sell:fake2'`).run());
    const g = audit(w);
    expect(failing(g)).toEqual(["G1"]);
    expect(g.G1.counts).toMatchObject({ PLAID_SALE_LAG: 0, unexplainedDifference: 1 });
  });

  it("a buy missing from the Plaid book fails", () => {
    const w = ws();
    edit([w.before, w.after], (db) => {
      db.prepare(`UPDATE holdings SET quantity = 125 WHERE account_id = ? AND security_id = ? AND as_of_date = '2027-04-30'`).run(base.ids.T, S().FAKE1);
      db.prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key) VALUES (?, ?, '2027-04-29', 'BUY', 5, -50, 10, 'test:buy:late')`,
      ).run(base.ids.T, S().FAKE1);
    });
    const g = audit(w);
    expect(failing(g)).toEqual(["G1"]);
    expect(g.G1.counts.missingBuy).toBe(1);
  });

  it("a difference no class explains fails", () => {
    const w = ws();
    edit([w.before, w.after], (db) =>
      db.prepare(`UPDATE holdings SET quantity = 119 WHERE account_id = ? AND security_id = ? AND as_of_date = '2027-04-30'`).run(base.ids.T, S().FAKE1),
    );
    const g = audit(w);
    expect(failing(g)).toEqual(["G1"]);
    expect(g.G1.counts.unexplainedDifference).toBe(1);
  });

  it("a reinvestment whose ledger rows do not add up is not REINVEST_LAG", () => {
    const w = ws();
    edit([w.before, w.after], (db) => db.prepare(`UPDATE transactions SET quantity = 0.3 WHERE source_key = 'vanguard-pdf:txn:fakef-reinvest'`).run());
    const g = audit(w);
    expect(failing(g)).toEqual(["G1"]);
    expect(g.G1.counts).toMatchObject({ REINVEST_LAG: 0, unexplainedDifference: 1 });
  });

  it("a gap on only one of the statement dates is not PLAID_PERSISTENT_GAP", () => {
    const w = ws();
    edit([w.before, w.after], (db) =>
      db.prepare(`UPDATE holdings SET quantity = 8 WHERE account_id = ? AND security_id = ? AND as_of_date = '2027-04-10'`).run(base.ids.T, S().FAKEG),
    );
    const g = audit(w);
    expect(failing(g)).toEqual(["G1"]);
    expect(g.G1.counts).toMatchObject({ PLAID_PERSISTENT_GAP: 0, unexplainedDifference: 1 });
  });

  it("the Roth total ratio is gated; the taxable ratio is only reported", () => {
    const w = ws();
    edit([w.before, w.after], (db) =>
      db.prepare(`UPDATE monthly_snapshots SET total_value = 3500 WHERE account_id = ? AND month_end_date = '2027-04-30'`).run(base.ids.R),
    );
    let g = audit(w);
    expect(failing(g)).toEqual(["G1"]);
    expect(g.G1.counts.rothRatioFail).toBe(1);
    const w2 = ws();
    edit([w2.before, w2.after], (db) =>
      db.prepare(`UPDATE monthly_snapshots SET total_value = 12000 WHERE account_id = ? AND month_end_date = '2027-04-30'`).run(base.ids.T),
    );
    g = audit(w2);
    expect(failing(g)).toEqual([]);
  });
});

// ── G2-G7 ────────────────────────────────────────────────────────────────

describe("each other gate fails on a fixture built to break it", () => {
  it("G2: a trade that shows two books after its trade date (LATE)", () => {
    const w = ws();
    // The ledger says FAKE8 was bought on 04-07; the first repaired book showing it is 04-09, with the 04-08 book between.
    edit([w.before, w.after], (db) => db.prepare(`UPDATE transactions SET trade_date = '2027-04-07' WHERE source_key = 'test:buy:fake8'`).run());
    const g = audit(w);
    expect(failing(g)).toEqual(["G2"]);
    expect(g.G2.counts).toMatchObject({ LATE: 1, PLAID_TRADE_LAG: 0 });
  });

  it("G2: a trade that shows before its trade date (EARLY)", () => {
    const w = ws();
    // A broken after copy: FAKE8's first repaired row sits before the purchase.
    edit([w.after], (db) => db.prepare(`UPDATE holdings SET as_of_date = '2027-04-05' WHERE id = ?`).run(holdingId(db, base.ids.T, "FAKE8", "2027-04-09")));
    const g = audit(w);
    expect(g.G2.pass).toBe(false);
    expect(g.G2.counts.EARLY).toBe(1);
  });

  it("G2: the on-trade-date share under the floor fails with no LATE or EARLY trade", () => {
    const w = ws();
    // FAKE7 bought on 04-06 instead: its session book was dropped, so it is SESSION_BOOK_DROPPED (allowed), and 5 of 8 is under 0.75.
    edit([w.before, w.after], (db) => db.prepare(`UPDATE transactions SET trade_date = '2027-04-06' WHERE source_key = 'test:buy:fake7'`).run());
    const g = audit(w);
    expect(failing(g)).toEqual(["G2"]);
    expect(g.G2.counts).toMatchObject({ SESSION_BOOK_DROPPED: 2, LATE: 0, EARLY: 0, onTradeDatePct: 63 });
  });

  it("G3: a non-zero Plaid row on a statement date", () => {
    const w = ws();
    edit([w.before, w.after], (db) =>
      db
        .prepare(`INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 5, '2027-04-30', ?)`)
        .run(base.ids.T, S().FAKEQ, `plaid:s:${base.ids.T}:${S().FAKEQ}:2027-04-30`),
    );
    const g = audit(w);
    expect(failing(g)).toEqual(["G3"]);
    expect(g.G3.counts.conflicts).toBe(1);
  });

  it("G4: a touched row outside the manifest's scope", () => {
    const w = ws();
    edit([w.after], (db) => db.prepare(`UPDATE transactions SET amount = 31 WHERE source_key = 'test:sell:fake7'`).run());
    const g = audit(w);
    expect(failing(g)).toEqual(["G4"]);
    expect(g.G4.counts.differences).toBe(1);
  });

  it("G4: a tax generation other than the manifest's prediction, and a leftover dating map", () => {
    const w = ws();
    edit([w.after], (db) => {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_input_generation', '99')`).run();
      db.prepare(`INSERT INTO settings (key, value) VALUES ('plaid_dating_first_session', '{}')`).run();
    });
    const g = audit(w);
    expect(failing(g)).toEqual(["G4"]);
    expect(g.G4.counts.differences).toBe(2);
  });

  it("G5: a closure delayed by one session in both the manifest and the after copy", () => {
    const w = ws();
    const { T } = base.ids;
    const m = readManifest(w);
    const db0 = new Database(w.before, { readonly: true });
    const id = holdingId(db0, T, "FAKE3", "2027-04-03");
    db0.close();
    const line = m.lines.find((l) => l.table === "holdings" && l.id === id);
    expect(line).toMatchObject({ action: "TOMBSTONE_MOVE" });
    expect(line?.new?.as_of_date).toBe("2027-04-02");
    const key = `recon:closed-equity:${T}:${S().FAKE3}:2027-04-05:live`;
    line!.new = { ...line!.new!, as_of_date: "2027-04-05", source_key: key };
    fs.writeFileSync(w.manifest, JSON.stringify(m));
    edit([w.after], (db) => db.prepare(`UPDATE holdings SET as_of_date = '2027-04-05', source_key = ? WHERE id = ?`).run(key, id));
    const g = audit(w);
    // The after copy equals the (broken) manifest, so G4 and the plain replay agree;
    // the closure check (b) is what catches the delay.
    expect(failing(g)).toEqual(["G5"]);
    expect(g.G5.counts).toMatchObject({ replayMismatches: 0, closureFailures: 1 });
  });

  it("G5: an after copy that differs from the replayed manifest", () => {
    const w = ws();
    const { T } = base.ids;
    edit([w.after], (db) => {
      const id = holdingId(db, T, "FAKE7", "2027-04-09");
      db.prepare(`UPDATE holdings SET as_of_date = '2027-04-12' WHERE id = ?`).run(id);
    });
    const g = audit(w);
    expect(g.G5.pass).toBe(false);
    expect(g.G5.counts.replayMismatches).toBeGreaterThan(0);
    expect(g.G5.counts.closureFailures).toBe(1);
  });

  it("G6: a Plaid row on a closed day", () => {
    const w = ws();
    edit([w.before, w.after], (db) =>
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2027-04-10', 20.1, 'plaid')`).run(S().FAKEQ),
    );
    const g = audit(w);
    expect(failing(g)).toEqual(["G6"]);
    expect(g.G6.counts.onClosedDays).toBe(1);
  });

  it("G7: a shifted fund price that does not match the Saturday statement", () => {
    const w = ws();
    const m = readManifest(w);
    const line = m.lines.find((l) => l.table === "prices" && l.action === "PRICE_FUND_SHIFT" && l.old?.date === "2027-04-08");
    expect(line?.new?.date).toBe("2027-04-09");
    line!.new = { ...line!.new!, close_price: 11.5 };
    fs.writeFileSync(w.manifest, JSON.stringify(m));
    edit([w.after], (db) => db.prepare(`UPDATE prices SET close_price = 11.5 WHERE id = ?`).run(line!.id));
    const g = audit(w);
    expect(failing(g)).toEqual(["G7"]);
    expect(g.G7.counts.mismatches).toBe(1);
  });

  it("the command line exits 1 when a gate fails", async () => {
    const w = ws();
    edit([w.after], (db) => db.prepare(`UPDATE transactions SET amount = 31 WHERE source_key = 'test:sell:fake7'`).run());
    const { logs, d } = auditDeps(w.dir);
    expect(await auditMain(["--before", w.before, "--after", w.after, "--manifest", w.manifest, "--out", path.join(w.dir, "out")], d)).toBe(1);
    expect(logs.some((l) => l.startsWith("G4 FAIL"))).toBe(true);
    expect(logs.join("\n")).toMatch(/Gates failing: G4/);
  });
});

// ── --check-repair-closures ──────────────────────────────────────────────

describe("--check-repair-closures", () => {
  it("checks the same actions the repair can re-mint", () => {
    expect([...CLOSURE_CHECK_ACTIONS].sort()).toEqual([...REMINT_ACTIONS].sort());
  });

  it("passes after the repair, fails after a statement batch undo, passes again after the re-mint (new row ids)", async () => {
    const w = ws();
    const run = async (args: string[] = []) => {
      const { logs, d } = auditDeps(w.dir);
      const code = await auditMain(["--check-repair-closures", "--db", w.after, "--manifest", w.manifest, "--out", path.join(w.dir, "out"), ...args], d);
      return { code, logs };
    };
    const first = await run();
    expect(first.code).toBe(0);
    expect(first.logs.join("\n")).toMatch(/missing 0, non-zero 0/);

    // Undo the 04-30 statement batch: its orphan cleanup removes the repaired zeros on 04-30.
    const { T } = base.ids;
    let oldId = 0;
    edit([w.after], (db) => {
      db.pragma("foreign_keys = ON");
      oldId = holdingId(db, T, "FAKE2", "2027-04-30");
      undoImport(db, base.ids.batch.m2);
    });
    const second = await run();
    expect(second.code).toBe(1);
    expect(second.logs.join("\n")).toMatch(/missing [1-9]/);
    expect(second.logs.join("\n")).toMatch(/--remint-closures/);

    // The repair's re-mint writes the zeros back as NEW rows; the check is keyed by slot, not id.
    const remint = repairDeps(w.dir);
    expect(await repairMain(["--db", w.after, "--remint-closures", "--apply", "--manifest", w.manifest], remint.d)).toBe(0);
    const third = await run();
    expect(third.code).toBe(0);
    edit([w.after], (db) => {
      expect(holdingId(db, T, "FAKE2", "2027-04-30")).not.toBe(oldId);
    });
  });

  it("a slot that holds a non-zero row fails, and the mode needs a database", async () => {
    const w = ws();
    edit([w.after], (db) => db.prepare(`UPDATE holdings SET quantity = 3 WHERE id = ?`).run(holdingId(db, base.ids.T, "FAKE6", "2027-04-30")));
    const { logs, d } = auditDeps(w.dir);
    expect(await auditMain(["--check-repair-closures", "--db", w.after, "--manifest", w.manifest, "--out", path.join(w.dir, "out")], d)).toBe(1);
    expect(logs.join("\n")).toMatch(/non-zero 1/);
    await expect(auditMain(["--check-repair-closures", "--manifest", w.manifest], auditDeps(w.dir).d)).rejects.toThrow(/needs --db/);
  });
});

// ── A closure a ruled drop would lose ────────────────────────────────────

describe("G5 (b) catches a closure lost on a ruled drop", () => {
  it("a zero Plaid row (not a tombstone) deleted with a DROP_BY_RULING book", () => {
    // Reported to the planner from the first build; the repair now blocks this
    // case itself. The audit must still catch it on its own, so the manifest is
    // edited here rather than produced by the repair: in the before copy FAKE2
    // reads 0 in the ruled 04-07 book (a Plaid row of quantity 0, after 50 in
    // the 04-06 book), and the manifest deletes that row with its book. The
    // repaired history then holds FAKE2 on 04-06 with no closure.
    const w = ws();
    let id = 0;
    let row: Record<string, string | number | null> = {};
    edit([w.before], (db) => {
      id = holdingId(db, base.ids.T, "FAKE2", "2027-04-07");
      db.prepare(`UPDATE holdings SET quantity = 0 WHERE id = ?`).run(id);
      row = db.prepare(`SELECT * FROM holdings WHERE id = ?`).get(id) as typeof row;
    });
    const m = readManifest(w);
    const line = m.lines.find((l) => l.table === "holdings" && l.id === id);
    expect(line).toMatchObject({ action: "DROP_BY_RULING", kind: "CHANGE", new: null });
    line!.old = row;
    line!.hash = rowHash(row);
    fs.writeFileSync(w.manifest, JSON.stringify(m));
    const g = audit(w);
    expect(failing(g)).toEqual(["G5"]);
    expect(g.G5.counts).toMatchObject({ closureFailures: 1, replayMismatches: 0, manifestMismatches: 0 });
  });
});
