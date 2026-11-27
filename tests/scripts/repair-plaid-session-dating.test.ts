/**
 * scripts/repair-plaid-session-dating.ts and its planner
 * (lib/repair/plaid-session-dating-plan.ts), plan v4 section D.
 *
 * Synthetic fixture only: made-up securities (FAKE*), round invented numbers,
 * invented 2027 dates, and a synthetic measured-set config. The database is a
 * migrated temp FILE (the script needs a path), removed after each test.
 *
 * Calendar used (2027, Eastern daylight time, UTC-4):
 *   Wed 03-31 statement; Sat 04-03 closed-day go-live (duplicate of Mon 04-05);
 *   Mon 04-05, Tue 04-06 pre-open; Wed 04-07 read after the open (ruled drop);
 *   Thu 04-08, Fri 04-09, Mon 04-12, Thu 04-29 pre-open; Fri 04-30 statement
 *   with a partial taxable Plaid book; Mon 05-03 pre-open (lands on the
 *   04-30 statement); Tue 05-04 pre-open.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  canonicalJson,
  classifyBookClass,
  planPlaidSessionDatingRepair,
  validateMeasuredSetConfig,
  type MeasuredSetConfig,
  type PlaidSessionDatingManifest,
} from "@/lib/repair/plaid-session-dating-plan";
import { main } from "../../scripts/repair-plaid-session-dating";
import { getDatingSettingsRaw } from "@/lib/plaid/session-dating";
import { isMarketClosed } from "@/lib/calendar/market-holidays";

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

interface Fx {
  db: Database.Database;
  dir: string;
  dbPath: string;
  T: number;
  R: number;
  sec: Record<string, number>;
  batch: Record<string, number>;
}

let fx: Fx;

function insertSecurity(db: Database.Database, symbol: string, type: string): number {
  return Number(db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)`).run(symbol, symbol, type).lastInsertRowid);
}

function holding(f: Fx, acct: number, sym: string, date: string, qty: number, key: string, batch: number | null = null, cost: number | null = null): number {
  return Number(
    f.db
      .prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, import_batch_id, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(acct, f.sec[sym], qty, cost, date, batch, key).lastInsertRowid,
  );
}

function plaidRow(f: Fx, acct: number, sym: string, runDay: string, qty: number): number {
  return holding(f, acct, sym, runDay, qty, `plaid:${acct}:${f.sec[sym]}:${runDay}`);
}

function tomb(f: Fx, acct: number, sym: string, date: string, suffix: "" | ":live" | ":stmt"): number {
  return holding(f, acct, sym, date, 0, `recon:closed-equity:${acct}:${f.sec[sym]}:${date}${suffix}`, null, 0);
}

function stmtRow(f: Fx, acct: number, sym: string, date: string, qty: number, batch: number): number {
  return holding(f, acct, sym, date, qty, `vanguard-pdf:holding:${acct}:${sym}:${date}`, batch, qty * 10);
}

function snapshot(f: Fx, acct: number, date: string, total: number, cash: number | null, source: string, createdAt: string | null): number {
  return Number(
    f.db
      .prepare(
        `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(acct, date, total, cash, source, createdAt).lastInsertRowid,
  );
}

function plaidBook(f: Fx, acct: number, runDay: string, createdAt: string, total: number, cash: number, rows: [string, number][]): void {
  snapshot(f, acct, runDay, total, cash, "plaid", createdAt);
  for (const [sym, q] of rows) plaidRow(f, acct, sym, runDay, q);
}

function price(f: Fx, sym: string, date: string, close: number, source: string): number {
  return Number(
    f.db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)`).run(f.sec[sym], date, close, source).lastInsertRowid,
  );
}

function txn(f: Fx, acct: number, sym: string, date: string, type: string, qty: number, px: number, batch: number | null = null): void {
  f.db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, import_batch_id, trade_date, type, quantity, amount, price_per_share, source_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(acct, f.sec[sym], batch, date, type, qty, qty * px, px, `test:${acct}:${sym}:${date}:${type}`);
}

function statementBatch(f: Fx, date: string, holdings: { acct: number; name: string; sym: string; qty: number }[]): number {
  const id = Number(
    f.db.prepare(`INSERT INTO import_batches (filename, source_type, status) VALUES (?, 'vanguard-pdf', 'completed')`).run(`stmt-${date}.pdf`).lastInsertRowid,
  );
  const parsed = {
    sourceType: "vanguard-pdf",
    holdings: holdings.map((h) => ({ accountName: h.name, symbol: h.sym, quantity: h.qty, asOfDate: date, sourceKey: `vanguard-pdf:holding:${h.acct}:${h.sym}:${date}` })),
  };
  f.db.prepare(`INSERT INTO raw_imports (import_batch_id, raw_data) VALUES (?, ?)`).run(id, JSON.stringify(parsed));
  for (const h of holdings) stmtRow(f, h.acct, h.sym, date, h.qty, id);
  return id;
}

function buildFixture(): Fx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaid-dating-"));
  const dbPath = path.join(dir, "fixture.db");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const acct = (name: string) => (db.prepare(`SELECT id FROM accounts WHERE name = ?`).get(name) as { id: number }).id;
  const T = acct("Vanguard Taxable");
  const R = acct("Vanguard Roth IRA");
  db.prepare(`UPDATE accounts SET tax_treatment = 'roth_ira' WHERE id = ?`).run(R);
  const sec: Record<string, number> = {};
  for (const s of ["FAKE1", "FAKE2", "FAKE3", "FAKE4", "FAKE5", "FAKE6", "FAKE7", "FAKEP"]) sec[s] = insertSecurity(db, s, "Stock");
  sec.FAKEQ = insertSecurity(db, "FAKEQ", "ETF");
  sec.FAKEF = insertSecurity(db, "FAKEF", "Mutual Fund");
  const f: Fx = { db, dir, dbPath, T, R, sec, batch: {} };

  // 03-31 statement (both accounts).
  f.batch.m1 = statementBatch(f, "2027-03-31", [
    { acct: T, name: "Vanguard Taxable", sym: "FAKE1", qty: 100 },
    { acct: T, name: "Vanguard Taxable", sym: "FAKE2", qty: 50 },
    { acct: T, name: "Vanguard Taxable", sym: "FAKE3", qty: 20 },
    { acct: T, name: "Vanguard Taxable", sym: "FAKEF", qty: 10 },
    { acct: R, name: "Vanguard Roth IRA", sym: "FAKE1", qty: 30 },
    { acct: R, name: "Vanguard Roth IRA", sym: "FAKE4", qty: 5 },
  ]);
  snapshot(f, T, "2027-03-31", 10000, null, "vanguard-pdf", "2027-04-02 12:00:00");
  snapshot(f, R, "2027-03-31", 3000, null, "vanguard-pdf", "2027-04-02 12:00:00");

  // Sat 04-03 go-live (closed day) and its twin Mon 04-05.
  plaidBook(f, T, "2027-04-03", "2027-04-03 15:00:00", 9000, 500, [["FAKE1", 100], ["FAKE2", 50]]);
  tomb(f, T, "FAKE3", "2027-04-03", ":live");
  plaidBook(f, R, "2027-04-03", "2027-04-03 15:00:00", 3000, 100, [["FAKE1", 30]]);
  tomb(f, R, "FAKE4", "2027-04-03", "");
  plaidBook(f, T, "2027-04-05", PRE("2027-04-05"), 9000, 500, [["FAKE1", 100], ["FAKE2", 50]]);
  plaidBook(f, R, "2027-04-05", PRE("2027-04-05"), 3000, 100, [["FAKE1", 30]]);
  // Tue 04-06.
  plaidBook(f, T, "2027-04-06", PRE("2027-04-06"), 9100, 500, [["FAKE1", 100], ["FAKE2", 50]]);
  plaidBook(f, R, "2027-04-06", PRE("2027-04-06"), 3010, 100, [["FAKE1", 30]]);
  // Wed 04-07, read after the open.
  plaidBook(f, T, "2027-04-07", POST("2027-04-07"), 9200, 300, [["FAKE1", 120], ["FAKE2", 50]]);
  plaidBook(f, R, "2027-04-07", POST("2027-04-07"), 3020, 100, [["FAKE1", 30]]);
  // Thu 04-08 / Fri 04-09 (FAKE7 bought 04-07) / Mon 04-12 (FAKE7 sold 04-09: its closure book).
  plaidBook(f, T, "2027-04-08", PRE("2027-04-08"), 9300, 270, [["FAKE1", 120], ["FAKE2", 50], ["FAKE7", 3]]);
  plaidBook(f, R, "2027-04-08", PRE("2027-04-08"), 3030, 100, [["FAKE1", 30]]);
  plaidBook(f, T, "2027-04-09", PRE("2027-04-09"), 9310, 270, [["FAKE1", 120], ["FAKE2", 50], ["FAKE7", 3]]);
  plaidBook(f, R, "2027-04-09", PRE("2027-04-09"), 3040, 100, [["FAKE1", 30]]);
  plaidBook(f, T, "2027-04-12", PRE("2027-04-12"), 9320, 300, [["FAKE1", 120], ["FAKE2", 50]]);
  tomb(f, T, "FAKE7", "2027-04-12", ":live");
  plaidBook(f, R, "2027-04-12", PRE("2027-04-12"), 3050, 100, [["FAKE1", 30]]);
  // Thu 04-29.
  plaidBook(f, T, "2027-04-29", PRE("2027-04-29"), 9400, 200, [["FAKE1", 120], ["FAKE2", 50], ["FAKE5", 7], ["FAKE6", 4]]);
  plaidBook(f, R, "2027-04-29", PRE("2027-04-29"), 3060, 100, [["FAKE1", 30]]);
  // Fri 04-30: taxable Plaid read, then the statement replaced the snapshot and the overlapping slots.
  plaidRow(f, T, "FAKE2", "2027-04-30", 50); // survivor, non-zero (sold 04-30)
  plaidRow(f, T, "FAKE5", "2027-04-30", 0); // survivor, zero
  f.batch.m2 = statementBatch(f, "2027-04-30", [
    { acct: T, name: "Vanguard Taxable", sym: "FAKE1", qty: 120 },
    { acct: T, name: "Vanguard Taxable", sym: "FAKEF", qty: 10 },
    { acct: R, name: "Vanguard Roth IRA", sym: "FAKE1", qty: 30 },
  ]);
  snapshot(f, T, "2027-04-30", 9500, 200, "vanguard-pdf", PRE("2027-04-30"));
  snapshot(f, R, "2027-04-30", 3070, null, "vanguard-pdf", "2027-05-05 12:00:00");
  tomb(f, T, "FAKE3", "2027-04-30", ":stmt");
  txn(f, T, "FAKE2", "2027-04-30", "SELL", 50, 10, f.batch.m2);
  txn(f, T, "FAKE1", "2027-04-07", "BUY", 20, 10);
  txn(f, T, "FAKE7", "2027-04-07", "BUY", 3, 10);
  txn(f, T, "FAKE7", "2027-04-09", "SELL", 3, 10);
  // Mon 05-03 lands on the 04-30 statement; FAKE2 still shown (Plaid lag).
  plaidBook(f, T, "2027-05-03", PRE("2027-05-03"), 9600, 900, [["FAKE1", 120], ["FAKE2", 50]]);
  tomb(f, T, "FAKE5", "2027-05-03", ":live"); // redundant: the 04-30 slot keeps the relabelled zero
  tomb(f, T, "FAKE6", "2027-05-03", ":live"); // kept on the statement date
  plaidBook(f, R, "2027-05-03", PRE("2027-05-03"), 3080, 100, [["FAKE1", 30]]);
  // Tue 05-04.
  plaidBook(f, T, "2027-05-04", PRE("2027-05-04"), 9700, 1400, [["FAKE1", 120]]);
  tomb(f, T, "FAKE2", "2027-05-04", ":live");
  plaidBook(f, R, "2027-05-04", PRE("2027-05-04"), 3090, 100, [["FAKE1", 30]]);

  // Prices.
  price(f, "FAKEF", "2027-03-31", 10.5, "vanguard-pdf");
  price(f, "FAKEF", "2027-04-05", 11.0, "plaid");
  price(f, "FAKEF", "2027-04-06", 11.1, "plaid");
  price(f, "FAKEF", "2027-04-07", 11.2, "plaid");
  price(f, "FAKEF", "2027-04-29", 11.9, "plaid");
  price(f, "FAKEF", "2027-04-30", 11.9, "vanguard-pdf");
  price(f, "FAKEP", "2027-04-03", 5.0, "plaid"); // a closed day: still deleted (P2)
  price(f, "FAKEP", "2027-04-06", 5.1, "plaid");
  price(f, "FAKEP", "2027-04-05", 5.05, "tws");
  price(f, "FAKEQ", "2027-04-08", 20.0, "plaid");
  price(f, "FAKE1", "2027-04-30", 10, "vanguard-pdf");
  return f;
}

function writeConfig(f: Fx, config: unknown = CONFIG): string {
  const p = path.join(f.dir, "measured-set.json");
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

function plan(f: Fx, config: MeasuredSetConfig = CONFIG) {
  return planPlaidSessionDatingRepair(f.db, { dbPath: f.dbPath, config, configSha256: "test" });
}

function bookAction(m: PlaidSessionDatingManifest, acct: number, runDay: string) {
  return m.books.find((b) => b.accountId === acct && b.runDay === runDay);
}

function lineFor(m: PlaidSessionDatingManifest, table: string, id: number) {
  return m.lines.find((l) => l.table === table && l.id === id);
}

function idOf(f: Fx, acct: number, sym: string, date: string): number {
  return (f.db.prepare(`SELECT id FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`).get(acct, f.sec[sym], date) as { id: number }).id;
}

function fileHash(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

let clock = 0;
function deps(f: Fx, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    logs,
    d: {
      env: {},
      cwd: f.dir,
      log: (l: string) => logs.push(l),
      now: () => new Date(Date.UTC(2027, 5, 1, 12, 0, clock++)),
      openHolders: () => [] as number[],
      isLive: () => false,
      ...extra,
    },
  };
}

async function dryRun(f: Fx, configPath: string): Promise<{ manifestPath: string; logs: string[] }> {
  f.db.close();
  const { logs, d } = deps(f);
  const code = await main(["--db", f.dbPath, "--config", configPath, "--out", path.join(f.dir, "out")], d);
  expect(code).toBe(0);
  const line = logs.find((l) => l.startsWith("Manifest: "));
  expect(line).toBeDefined();
  return { manifestPath: (line as string).slice("Manifest: ".length), logs };
}

function reopen(f: Fx): void {
  f.db = new Database(f.dbPath);
  f.db.pragma("foreign_keys = ON");
}

beforeEach(() => {
  fx = buildFixture();
});

afterEach(() => {
  try {
    if (fx.db.open) fx.db.close();
  } catch {
    // already closed
  }
  fs.rmSync(path.resolve(fx.dir), { recursive: true, force: true });
});

// ── Config validation ────────────────────────────────────────────────────

describe("validateMeasuredSetConfig", () => {
  it("accepts the synthetic config", () => {
    expect(validateMeasuredSetConfig(CONFIG)).toEqual(CONFIG);
  });

  it("refuses unknown fields, missing fields and bad values", () => {
    expect(() => validateMeasuredSetConfig({ ...CONFIG, extra: 1 })).toThrow(/unknown top-level field "extra"/);
    expect(() => validateMeasuredSetConfig({ rows: [] })).toThrow(/missing top-level field "f2Since"/);
    expect(() =>
      validateMeasuredSetConfig({ rows: [{ ...CONFIG.rows[0], note: "x" }], f2Since: "2027-04-08" }),
    ).toThrow(/unknown field "note"/);
    expect(() =>
      validateMeasuredSetConfig({ rows: [{ ...CONFIG.rows[0], accountRole: "ira" }], f2Since: "2027-04-08" }),
    ).toThrow(/accountRole/);
    expect(() =>
      validateMeasuredSetConfig({ rows: [{ ...CONFIG.rows[0], runDay: "2027-02-30" }], f2Since: "2027-04-08" }),
    ).toThrow(/runDay/);
    expect(() =>
      validateMeasuredSetConfig({ rows: [{ ...CONFIG.rows[0], class: "PRE_OPEN" }], f2Since: "2027-04-08" }),
    ).toThrow(/class/);
  });

  it("refuses an action paired with the wrong class", () => {
    expect(() =>
      validateMeasuredSetConfig({ rows: [{ ...CONFIG.rows[0], action: "DROP_BY_RULING" }], f2Since: "2027-04-08" }),
    ).toThrow(/applies only to class POST_OPEN/);
  });

  it("refuses duplicate rows, counting both as taxable and Roth", () => {
    expect(() =>
      validateMeasuredSetConfig({
        rows: [CONFIG.rows[0], { ...CONFIG.rows[0], accountRole: "roth" }],
        f2Since: "2027-04-08",
      }),
    ).toThrow(/duplicate of rows\[0\]/);
    expect(() =>
      validateMeasuredSetConfig({ rows: [CONFIG.rows[2], CONFIG.rows[2]], f2Since: "2027-04-08" }),
    ).toThrow(/duplicate/);
  });
});

// ── D0 classes ───────────────────────────────────────────────────────────

describe("classifyBookClass (D0)", () => {
  it("reads created_at as UTC and classifies on the Eastern day", () => {
    expect(classifyBookClass("2027-04-06", "2027-04-06 11:31:00", true)).toBe("PRE_OPEN"); // 07:31 EDT
    expect(classifyBookClass("2027-04-06", "2027-04-06 13:29:59", true)).toBe("PRE_OPEN"); // 09:29:59 EDT
    expect(classifyBookClass("2027-04-06", "2027-04-06 13:30:00", true)).toBe("POST_OPEN"); // 09:30 EDT
    expect(classifyBookClass("2027-04-06", "2027-04-06T21:22:00Z", true)).toBe("POST_OPEN");
  });

  it("a UTC time on the next calendar day that is still the same Eastern day", () => {
    // 01:30 UTC on 04-08 is 21:30 EDT on 04-07.
    expect(classifyBookClass("2027-04-07", "2027-04-08 01:30:00", true)).toBe("POST_OPEN");
    // In standard time (UTC-5): 04:30 UTC on 03-03 is 23:30 EST on 03-02.
    expect(classifyBookClass("2027-03-02", "2027-03-03 04:30:00", true)).toBe("POST_OPEN");
  });

  it("applies daylight saving on both sides of the change", () => {
    // Before the 2027-03-14 change, 07:31 EST is 12:31 UTC.
    expect(classifyBookClass("2027-03-12", "2027-03-12 12:31:00", true)).toBe("PRE_OPEN");
    expect(classifyBookClass("2027-03-12", "2027-03-12 14:31:00", true)).toBe("POST_OPEN"); // 09:31 EST
    // After it, 13:31 UTC is 09:31 EDT.
    expect(classifyBookClass("2027-03-15", "2027-03-15 13:31:00", true)).toBe("POST_OPEN");
    expect(classifyBookClass("2027-03-15", "2027-03-15 13:29:00", true)).toBe("PRE_OPEN");
  });

  it("CLOSED_DAY and UNKNOWN", () => {
    expect(classifyBookClass("2027-04-03", "2027-04-03 15:00:00", true)).toBe("CLOSED_DAY");
    expect(classifyBookClass("2027-04-03", null, false)).toBe("CLOSED_DAY");
    expect(classifyBookClass("2027-04-30", null, false)).toBe("UNKNOWN"); // no Plaid snapshot
    expect(classifyBookClass("2027-04-06", null, true)).toBe("UNKNOWN");
    expect(classifyBookClass("2027-04-06", "yesterday", true)).toBe("UNKNOWN");
    expect(classifyBookClass("2027-04-06", "2027-04-06 11:31", true)).toBe("UNKNOWN"); // no seconds: unreadable
    expect(classifyBookClass("2027-04-07", "2027-04-07 03:00:00", true)).toBe("UNKNOWN"); // 23:00 EDT on 04-06
  });
});

// ── The whole plan on the fixture ────────────────────────────────────────

describe("planner on the synthetic fixture", () => {
  it("decides every book as expected and blocks nothing", () => {
    const { manifest } = plan(fx);
    const { T, R } = fx;
    expect(manifest.counts.blocking).toBe(0);
    expect(manifest.datingState).toBe("legacy");
    for (const a of [T, R]) {
      expect(bookAction(manifest, a, "2027-04-03")).toMatchObject({ class: "CLOSED_DAY", action: "DROP_DUPLICATE_SESSION", keptTwinRunDay: "2027-04-05" });
      expect(bookAction(manifest, a, "2027-04-05")).toMatchObject({ class: "PRE_OPEN", action: "MOVE_BOOK", session: "2027-04-02" });
      expect(bookAction(manifest, a, "2027-04-07")).toMatchObject({ class: "POST_OPEN", action: "DROP_BY_RULING" });
      expect(bookAction(manifest, a, "2027-05-03")).toMatchObject({ action: "DROP_STATEMENT_TARGET", session: "2027-04-30" });
      expect(bookAction(manifest, a, "2027-05-04")).toMatchObject({ action: "MOVE_BOOK", session: "2027-05-03" });
    }
    expect(bookAction(manifest, T, "2027-04-30")).toMatchObject({ class: "UNKNOWN", action: "DROP_PARTIAL_BOOK" });
    expect(bookAction(manifest, R, "2027-04-30")).toBeUndefined();
  });

  it("D3: survivors, D4: tombstone cases, D5: price rules", () => {
    const { manifest, report } = plan(fx);
    const { T, R } = fx;
    // Survivors.
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE2", "2027-04-30"))).toMatchObject({ action: "SURVIVOR_TO_ZERO", kind: "CHANGE" });
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE5", "2027-04-30"))).toMatchObject({ action: "ZERO_SURVIVOR_RELABEL", kind: "CHANGE" });
    // Tombstones.
    const r4 = lineFor(manifest, "holdings", idOf(fx, R, "FAKE4", "2027-04-03"));
    expect(r4).toMatchObject({ action: "TOMBSTONE_MOVE" });
    expect(r4?.new?.source_key).toBe(`recon:closed-equity:${R}:${fx.sec.FAKE4}:2027-04-02:live`); // relabelled
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE3", "2027-04-03"))?.new?.as_of_date).toBe("2027-04-02");
    // Position book followed by its closure book: both move one session.
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE7", "2027-04-12"))?.new?.as_of_date).toBe("2027-04-09");
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE7", "2027-04-09"))?.new?.as_of_date).toBe("2027-04-08");
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE6", "2027-05-03"))).toMatchObject({ action: "TOMBSTONE_KEEP_ON_STATEMENT_DATE" });
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE5", "2027-05-03"))).toMatchObject({ action: "TOMBSTONE_REDUNDANT", new: null });
    expect(lineFor(manifest, "holdings", idOf(fx, T, "FAKE3", "2027-04-30"))).toMatchObject({ action: "TOMBSTONE_STATEMENT_GRADE", kind: "UNCHANGED" });
    // Prices.
    const pid = (sym: string, date: string) =>
      (fx.db.prepare(`SELECT id FROM prices WHERE security_id = ? AND date = ?`).get(fx.sec[sym], date) as { id: number }).id;
    expect(lineFor(manifest, "prices", pid("FAKEF", "2027-04-07"))?.new?.date).toBe("2027-04-08");
    expect(lineFor(manifest, "prices", pid("FAKEF", "2027-04-06"))?.new?.date).toBe("2027-04-07");
    expect(lineFor(manifest, "prices", pid("FAKEF", "2027-04-05"))?.new?.date).toBe("2027-04-06");
    expect(lineFor(manifest, "prices", pid("FAKEF", "2027-04-29"))).toMatchObject({ action: "PRICE_FUND_DROP_AUTHORITY", new: null });
    expect(lineFor(manifest, "prices", pid("FAKEP", "2027-04-03"))).toMatchObject({ action: "PRICE_NONFUND_LEGACY_DELETE" });
    expect(lineFor(manifest, "prices", pid("FAKEQ", "2027-04-08"))).toMatchObject({ action: "PRICE_F2_SESSION_DATED", kind: "UNCHANGED" });
    // Newest first: the shift lines for the fund run newest to oldest.
    const fundDates = manifest.lines
      .filter((l) => l.table === "prices" && l.old?.security_id === fx.sec.FAKEF && l.kind === "CHANGE")
      .map((l) => String(l.old?.date));
    expect(fundDates).toEqual([...fundDates].sort().reverse());
    // Report.
    expect(report.measuredSet.every((m) => m.found.every((x) => x.found))).toBe(true);
    expect(report.repeatReads.some((r) => r.runDay === "2027-04-05")).toBe(true);
    expect(report.census.length).toBeGreaterThan(0);
    expect(report.statementTargets.length).toBe(2);
    expect(manifest.predicted.bumpFires).toBe(false);
  });
});

// ── Dry run and apply through the command line ───────────────────────────

describe("dry run and apply", () => {
  it("dry run leaves the database file unchanged and prints counts only", async () => {
    const before = fileHash(fx.dbPath);
    const { logs, manifestPath } = await dryRun(fx, writeConfig(fx));
    expect(fileHash(fx.dbPath)).toBe(before);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.readdirSync(path.join(fx.dir, "out")).some((n) => n.startsWith("report-"))).toBe(true);
    expect(logs[0]).toContain(`db: ${fx.dbPath}`);
    const console = logs.join("\n");
    expect(console).not.toContain("Vanguard Taxable");
    expect(console).not.toContain("FAKE");
    expect(console).not.toMatch(/2027-0[345]-\d\d/);
    reopen(fx);
  });

  it("dry run on a WAL-mode database leaves the main file unchanged", async () => {
    fx.db.pragma("journal_mode = WAL");
    fx.db.close();
    reopen(fx);
    const before = fileHash(fx.dbPath);
    await dryRun(fx, writeConfig(fx));
    expect(fileHash(fx.dbPath)).toBe(before);
    reopen(fx);
  });

  it("--compare-to lists how a later plan differs from the rehearsal", async () => {
    const cfg = writeConfig(fx);
    const first = await dryRun(fx, cfg);
    // A new pre-open book after the rehearsal: an allowed difference.
    reopen(fx);
    plaidBook(fx, fx.T, "2027-05-05", PRE("2027-05-05"), 9800, 1400, [["FAKE1", 120]]);
    fx.db.close();
    const { logs, d } = deps(fx);
    await main(["--db", fx.dbPath, "--config", cfg, "--out", path.join(fx.dir, "out"), "--compare-to", first.manifestPath], d);
    expect(logs.join("\n")).toMatch(/2 allowed difference\(s\), 0 not allowed/);
    // A change to an old row is not allowed.
    reopen(fx);
    fx.db.prepare(`UPDATE monthly_snapshots SET total_value = 9101 WHERE account_id = ? AND month_end_date = '2027-04-06'`).run(fx.T);
    fx.db.close();
    const second = deps(fx);
    await main(["--db", fx.dbPath, "--config", cfg, "--out", path.join(fx.dir, "out"), "--compare-to", first.manifestPath], second.d);
    expect(second.logs.join("\n")).toMatch(/1 not allowed/);
    expect(second.logs.join("\n")).toMatch(/STOP/);
    reopen(fx);
  });

  it("refuses with no database named", async () => {
    await expect(main([], deps(fx).d)).rejects.toThrow(/No database named/);
  });

  it("applies the manifest, proves it, and lands every row on its session", async () => {
    const cfg = writeConfig(fx);
    const { manifestPath } = await dryRun(fx, cfg);
    const { logs, d } = deps(fx);
    const code = await main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], d);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("PRAGMA integrity_check: ok");
    expect(logs.some((l) => l.startsWith("Backup created at "))).toBe(true);
    reopen(fx);
    const { db, T, R, sec } = fx;
    const row = (acct: number, sym: string, date: string) =>
      db.prepare(`SELECT * FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`).get(acct, sec[sym], date) as
        | { quantity: number; source_key: string; import_batch_id: number | null }
        | undefined;
    expect(row(T, "FAKE1", "2027-04-02")).toMatchObject({ quantity: 100, source_key: `plaid:s:${T}:${sec.FAKE1}:2027-04-02` });
    expect(row(T, "FAKE1", "2027-04-07")).toMatchObject({ quantity: 120 });
    expect(row(T, "FAKE1", "2027-05-03")).toMatchObject({ quantity: 120 });
    expect(row(T, "FAKE2", "2027-04-30")).toMatchObject({ quantity: 0, source_key: `recon:closed-equity:${T}:${sec.FAKE2}:2027-04-30:live`, import_batch_id: null });
    expect(row(T, "FAKE5", "2027-04-30")?.source_key).toBe(`recon:closed-equity:${T}:${sec.FAKE5}:2027-04-30:live`);
    expect(row(T, "FAKE6", "2027-04-30")?.source_key).toBe(`recon:closed-equity:${T}:${sec.FAKE6}:2027-04-30:live`);
    expect(row(T, "FAKE5", "2027-05-03")).toBeUndefined();
    expect(row(T, "FAKE2", "2027-05-03")).toMatchObject({ quantity: 0 }); // the 05-04 closure, moved
    expect(row(R, "FAKE4", "2027-04-02")?.source_key).toMatch(/:live$/);
    // Snapshots.
    const snap = (acct: number, date: string) =>
      db.prepare(`SELECT * FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?`).get(acct, date) as
        | { source: string; created_at: string }
        | undefined;
    expect(snap(T, "2027-04-02")).toMatchObject({ source: "plaid", created_at: PRE("2027-04-05") }); // created_at kept
    expect(snap(T, "2027-04-03")).toBeUndefined();
    expect(snap(T, "2027-04-05")?.source).toBe("plaid"); // the 04-06 run-day book
    expect(snap(T, "2027-04-06")).toBeUndefined(); // the ruled drop: 04-06 carries the 04-05 book
    expect(snap(T, "2027-04-30")?.source).toBe("vanguard-pdf");
    // Prices.
    const px = (sym: string) =>
      db.prepare(`SELECT date, close_price, source FROM prices WHERE security_id = ? ORDER BY date`).all(sec[sym]);
    expect(px("FAKEF")).toEqual([
      { date: "2027-03-31", close_price: 10.5, source: "vanguard-pdf" },
      { date: "2027-04-06", close_price: 11.0, source: "plaid" },
      { date: "2027-04-07", close_price: 11.1, source: "plaid" },
      { date: "2027-04-08", close_price: 11.2, source: "plaid" },
      { date: "2027-04-30", close_price: 11.9, source: "vanguard-pdf" },
    ]);
    expect(px("FAKEP")).toEqual([{ date: "2027-04-05", close_price: 5.05, source: "tws" }]);
    expect(px("FAKEQ")).toEqual([{ date: "2027-04-08", close_price: 20.0, source: "plaid" }]);
    // Settings: repaired.
    expect(getDatingSettingsRaw(db)).toEqual({ version: "2", firstSession: null });
    expect((db.prepare(`SELECT COUNT(*) AS c FROM daily_valuations`).get() as { c: number }).c).toBeGreaterThan(0);
    // G3: no (account, date) with statement rows and a non-zero Plaid row.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM holdings p WHERE p.source_key LIKE 'plaid:%' AND p.quantity != 0
             AND EXISTS (SELECT 1 FROM holdings s WHERE s.account_id = p.account_id AND s.as_of_date = p.as_of_date AND s.source_key LIKE 'vanguard-pdf:%')`,
        )
        .get(),
    ).toEqual({ c: 0 });
    // G6: every Plaid row on a trading day; every Plaid holding key new-format.
    const plaidDates = db
      .prepare(
        `SELECT as_of_date AS d FROM holdings WHERE source_key LIKE 'plaid:%'
         UNION SELECT month_end_date FROM monthly_snapshots WHERE source = 'plaid'
         UNION SELECT date FROM prices WHERE source = 'plaid'`,
      )
      .all() as { d: string }[];
    expect(plaidDates.filter((r) => isMarketClosed(r.d))).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM holdings WHERE source_key LIKE 'plaid:%' AND source_key NOT LIKE 'plaid:s:%'`).get()).toEqual({ c: 0 });
    // A backup was written beside the copy.
    expect(fs.readdirSync(path.join(fx.dir, "backups")).some((n) => n.startsWith("pre-plaid-session-dating-"))).toBe(true);
  });

  it("refuses a second run", async () => {
    const cfg = writeConfig(fx);
    const { manifestPath } = await dryRun(fx, cfg);
    await main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx).d);
    await expect(main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx).d)).rejects.toThrow(
      /already repaired/,
    );
    // A new dry run sees the repaired state and plans nothing.
    const again = await dryRun(fx, cfg);
    const m = JSON.parse(fs.readFileSync(again.manifestPath, "utf8")) as PlaidSessionDatingManifest;
    expect(m.datingState).toBe("repaired");
    expect(m.lines).toEqual([]);
    reopen(fx);
  });

  it("refuses without a matching manifest", async () => {
    const cfg = writeConfig(fx);
    await expect(main(["--db", fx.dbPath, "--config", cfg, "--apply"], deps(fx).d)).rejects.toThrow(/needs --manifest/);
    const { manifestPath } = await dryRun(fx, cfg);
    // The database changes after the dry run: the recomputed plan differs.
    reopen(fx);
    price(fx, "FAKEP", "2027-04-07", 5.2, "plaid");
    fx.db.close();
    const before = fileHash(fx.dbPath);
    await expect(main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx).d)).rejects.toThrow(
      /recomputed plan differs/,
    );
    expect(fileHash(fx.dbPath)).toBe(before);
    // A different config is refused before anything else.
    const other = path.join(fx.dir, "other.json");
    fs.writeFileSync(other, JSON.stringify({ ...CONFIG, f2Since: "2027-04-09" }));
    await expect(main(["--db", fx.dbPath, "--config", other, "--apply", "--manifest", manifestPath], deps(fx).d)).rejects.toThrow(
      /config differs/,
    );
    reopen(fx);
  });

  it("refuses a manifest with an UNCLASSIFIED or BLOCK line", async () => {
    const cfg = writeConfig(fx);
    const { manifestPath } = await dryRun(fx, cfg);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PlaidSessionDatingManifest;
    const tampered = { ...m, lines: [...m.lines, { kind: "UNCLASSIFIED", action: "UNCLASSIFIED", rule: "none", table: "prices", id: 1 }] };
    const p1 = path.join(fx.dir, "tampered-unclassified.json");
    fs.writeFileSync(p1, JSON.stringify(tampered));
    await expect(main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", p1], deps(fx).d)).rejects.toThrow(/BLOCK or UNCLASSIFIED/);
    const blocked = { ...m, lines: [...m.lines, { kind: "BLOCK", action: "BLOCK", rule: "x", reason: "test" }] };
    const p2 = path.join(fx.dir, "tampered-block.json");
    fs.writeFileSync(p2, JSON.stringify(blocked));
    await expect(main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", p2], deps(fx).d)).rejects.toThrow(/BLOCK or UNCLASSIFIED/);
    reopen(fx);
  });

  it("refuses a measured-set row that is missing or extra", () => {
    const missing = plan(fx, { ...CONFIG, rows: [...CONFIG.rows, { accountRole: "roth", runDay: "2027-04-30", class: "UNKNOWN", action: "DROP_PARTIAL_BOOK" }] });
    expect(missing.manifest.lines.some((l) => l.action === "MEASURED_SET_ROW_MISSING")).toBe(true);
    expect(missing.manifest.counts.blocking).toBeGreaterThan(0);
    // A book with no config row (the ruled drop removed from the config): BLOCK.
    const extra = plan(fx, { ...CONFIG, rows: CONFIG.rows.filter((r) => r.action !== "DROP_BY_RULING") });
    expect(bookAction(extra.manifest, fx.T, "2027-04-07")).toMatchObject({ action: "BLOCK", reason: "POST_OPEN book not in the measured set" });
    expect(extra.manifest.counts.blocking).toBeGreaterThan(0);
  });

  it("refuses the live database without --live, and while another process holds the file", async () => {
    const cfg = writeConfig(fx);
    const { manifestPath } = await dryRun(fx, cfg);
    await expect(
      main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx, { isLive: () => true }).d),
    ).rejects.toThrow(/live database/);
    await expect(
      main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx, { openHolders: () => [4242] }).d),
    ).rejects.toThrow(/another process holds/);
    reopen(fx);
  });
});

// ── D3 / D4 requirements failing into BLOCK ──────────────────────────────

describe("requirements that block", () => {
  it("a survivor without a closing ledger row", () => {
    fx.db.prepare(`DELETE FROM transactions WHERE type = 'SELL' AND security_id = ?`).run(fx.sec.FAKE2);
    const { manifest } = plan(fx);
    expect(bookAction(manifest, fx.T, "2027-04-30")).toMatchObject({ action: "BLOCK", reason: "survivor without a closing ledger row in the statement period" });
  });

  it("a BUY_TO_COVER is not a long close, and a TRANSFER_OUT is", () => {
    fx.db.prepare(`UPDATE transactions SET type = 'BUY_TO_COVER' WHERE type = 'SELL' AND security_id = ?`).run(fx.sec.FAKE2);
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-30")?.action).toBe("BLOCK");
    fx.db.prepare(`UPDATE transactions SET type = 'TRANSFER_OUT' WHERE type = 'BUY_TO_COVER'`).run();
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-30")?.action).toBe("DROP_PARTIAL_BOOK");
  });

  it("a survivor on a statement book that is not proven full", () => {
    // The stored parse lists no holdings for the taxable account on the date.
    const parsed = { sourceType: "vanguard-pdf", holdings: [] };
    fx.db.prepare(`UPDATE raw_imports SET raw_data = ? WHERE import_batch_id = ?`).run(JSON.stringify(parsed), fx.batch.m2);
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-30")?.reason).toMatch(/not proven full/);
  });

  it("a survivor the stored parse lists", () => {
    const raw = JSON.parse(
      (fx.db.prepare(`SELECT raw_data FROM raw_imports WHERE import_batch_id = ?`).get(fx.batch.m2) as { raw_data: string }).raw_data,
    );
    raw.holdings.push({ accountName: "Vanguard Taxable", symbol: "FAKE2", quantity: 50, asOfDate: "2027-04-30", sourceKey: "x" });
    fx.db.prepare(`UPDATE raw_imports SET raw_data = ? WHERE import_batch_id = ?`).run(JSON.stringify(raw), fx.batch.m2);
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-30")?.reason).toBe("survivor: the statement lists it");
  });

  it("the shrink guard tripped", () => {
    // Prior statement grows to 6 rows: 2 rows on 04-30 is under half.
    stmtRow(fx, fx.T, "FAKE6", "2027-03-31", 4, fx.batch.m1);
    stmtRow(fx, fx.T, "FAKE7", "2027-03-31", 4, fx.batch.m1);
    stmtRow(fx, fx.T, "FAKEQ", "2027-03-31", 4, fx.batch.m1);
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-30")?.reason).toMatch(/shrink guard/);
  });

  it("a duplicate that is not identical", () => {
    fx.db.prepare(`UPDATE holdings SET quantity = 99 WHERE id = ?`).run(idOf(fx, fx.T, "FAKE1", "2027-04-03"));
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-03")).toMatchObject({ action: "BLOCK", reason: "duplicate not identical: positions differ from the kept twin" });
    fx.db.prepare(`UPDATE holdings SET quantity = 100 WHERE id = ?`).run(idOf(fx, fx.T, "FAKE1", "2027-04-03"));
    fx.db.prepare(`UPDATE monthly_snapshots SET cash_value = 501 WHERE account_id = ? AND month_end_date = '2027-04-03'`).run(fx.T);
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-03")?.reason).toMatch(/cash differs/);
  });

  it("a duplicate-book tombstone whose kept twin holds the same slot is redundant", () => {
    tomb(fx, fx.R, "FAKE4", "2027-04-05", ":live");
    const { manifest } = plan(fx);
    expect(manifest.counts.blocking).toBe(0);
    expect(lineFor(manifest, "holdings", idOf(fx, fx.R, "FAKE4", "2027-04-03"))).toMatchObject({ action: "TOMBSTONE_REDUNDANT", new: null });
    expect(lineFor(manifest, "holdings", idOf(fx, fx.R, "FAKE4", "2027-04-05"))?.new?.as_of_date).toBe("2027-04-02");
  });

  it("a tombstone on a ruled drop", () => {
    tomb(fx, fx.T, "FAKE3", "2027-04-07", ":live");
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-07")?.reason).toMatch(/tombstone on a ruled drop/);
  });

  it("a zero Plaid row recording a closure on a ruled drop blocks like a tombstone", () => {
    // FAKE2 is 50 in the 04-06 book; the 04-07 ruled-drop book reports it at 0.
    fx.db.prepare(`UPDATE holdings SET quantity = 0 WHERE id = ?`).run(idOf(fx, fx.T, "FAKE2", "2027-04-07"));
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-07")?.reason).toMatch(/zero Plaid row recording a closure on a ruled drop/);
  });

  it("a zero Plaid row on a ruled drop after a zero is not a closure", () => {
    plaidRow(fx, fx.T, "FAKE3", "2027-04-07", 0); // FAKE3's previous row is the 04-03 tombstone
    const { manifest } = plan(fx);
    expect(bookAction(manifest, fx.T, "2027-04-07")?.action).toBe("DROP_BY_RULING");
    expect(manifest.counts.blocking).toBe(0);
  });

  it("a duplicate-session zero row must be matched by the kept twin", () => {
    // Replace the tombstone with a zero Plaid row on the dropped twin only.
    fx.db.prepare(`DELETE FROM holdings WHERE id = ?`).run(idOf(fx, fx.T, "FAKE3", "2027-04-03"));
    plaidRow(fx, fx.T, "FAKE3", "2027-04-03", 0);
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-03")?.reason).toMatch(/positions differ from the kept twin/);
  });

  it("a closure zero on a book dropped onto a statement date that omits the name blocks", () => {
    plaidRow(fx, fx.T, "FAKE7", "2027-05-03", 0); // FAKE7's previous row is 3 (moved 04-09 book)
    fx.db.prepare(`DELETE FROM holdings WHERE id = ?`).run(idOf(fx, fx.T, "FAKE7", "2027-04-12"));
    expect(bookAction(plan(fx).manifest, fx.T, "2027-05-03")?.reason).toMatch(/closure would be lost/);
  });

  it("a tombstone moved to a statement date that holds the security non-zero", () => {
    fx.db.prepare(`DELETE FROM holdings WHERE id = ?`).run(idOf(fx, fx.T, "FAKE1", "2027-05-03"));
    tomb(fx, fx.T, "FAKE1", "2027-05-03", ":live");
    expect(bookAction(plan(fx).manifest, fx.T, "2027-05-03")?.reason).toMatch(/statement on the target date holds the security non-zero/);
  });

  it("a target session that holds a TWS book", () => {
    snapshot(fx, fx.T, "2027-04-28", 9000, 100, "tws", "2027-04-28 20:00:00");
    expect(bookAction(plan(fx).manifest, fx.T, "2027-04-29")?.reason).toMatch(/TWS or manual book/);
  });
});

// ── A statement dated on a closed day (Saturday month-end) ────────────────

describe("a weekend month-end statement", () => {
  // 2027-07-31 is a Saturday: the statement holds the close of Fri 07-30.
  function addWeekendMonth(f: Fx, mondayQty = 120): void {
    for (const [runDay, t] of [["2027-07-29", 9900], ["2027-07-30", 9910], ["2027-08-02", 9920], ["2027-08-03", 9930]] as const) {
      plaidBook(f, f.T, runDay, PRE(runDay), t, 1400, [["FAKE1", runDay === "2027-08-02" ? mondayQty : 120]]);
      plaidBook(f, f.R, runDay, PRE(runDay), 3100, 100, [["FAKE1", 30]]);
    }
    f.batch.m3 = statementBatch(f, "2027-07-31", [
      { acct: f.T, name: "Vanguard Taxable", sym: "FAKE1", qty: 120 },
      { acct: f.T, name: "Vanguard Taxable", sym: "FAKEF", qty: 10 },
      { acct: f.R, name: "Vanguard Roth IRA", sym: "FAKE1", qty: 30 },
    ]);
    snapshot(f, f.T, "2027-07-31", 9950, null, "vanguard-pdf", "2027-08-04 12:00:00");
    snapshot(f, f.R, "2027-07-31", 3100, null, "vanguard-pdf", "2027-08-04 12:00:00");
  }

  it("the Monday book moves onto the Friday the statement describes, and later books move normally", () => {
    addWeekendMonth(fx);
    const { manifest, report } = plan(fx);
    expect(manifest.counts.blocking).toBe(0);
    for (const a of [fx.T, fx.R]) {
      expect(bookAction(manifest, a, "2027-07-30")).toMatchObject({ action: "MOVE_BOOK", session: "2027-07-29" });
      expect(bookAction(manifest, a, "2027-08-02")).toMatchObject({ action: "MOVE_BOOK", session: "2027-07-30" });
      expect(bookAction(manifest, a, "2027-08-03")).toMatchObject({ action: "MOVE_BOOK", session: "2027-08-02" });
    }
    const w = report.weekendStatements.filter((x) => x.statementDate === "2027-07-31");
    expect(w.map((x) => x.accountId).sort()).toEqual([fx.T, fx.R].sort());
    // The fund is in the statement and not in the Plaid book: listed, not blocking.
    expect(w.find((x) => x.accountId === fx.R)?.differences).toEqual([]);
    expect(w.find((x) => x.accountId === fx.T)?.differences.map((d) => d.securityId)).toEqual([fx.sec.FAKEF]);
  });

  it("applies: the Plaid row sits on the Friday and the statement stays on the Saturday", async () => {
    addWeekendMonth(fx);
    const cfg = writeConfig(fx);
    const { manifestPath } = await dryRun(fx, cfg);
    expect(await main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx).d)).toBe(0);
    reopen(fx);
    const rows = fx.db
      .prepare(`SELECT as_of_date, source_key FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date BETWEEN '2027-07-28' AND '2027-08-03' ORDER BY as_of_date`)
      .all(fx.T, fx.sec.FAKE1) as { as_of_date: string; source_key: string }[];
    expect(rows.map((r) => r.as_of_date)).toEqual(["2027-07-28", "2027-07-29", "2027-07-30", "2027-07-31", "2027-08-02"]);
    expect(rows[3].source_key).toMatch(/^vanguard-pdf:/);
    expect(rows[2].source_key).toBe(`plaid:s:${fx.T}:${fx.sec.FAKE1}:2027-07-30`);
  });

  it("a moved book that differs from the weekend statement still moves and is listed as a mismatch", () => {
    addWeekendMonth(fx, 125); // no ledger row explains the 5 extra shares
    const { manifest, report } = plan(fx);
    expect(manifest.counts.blocking).toBe(0);
    expect(bookAction(manifest, fx.T, "2027-08-02")).toMatchObject({ action: "MOVE_BOOK", session: "2027-07-30" });
    const w = report.weekendStatements.find((x) => x.accountId === fx.T && x.statementDate === "2027-07-31");
    expect(w?.differences).toContainEqual({ securityId: fx.sec.FAKE1, plaid: 125, statement: 120, closingLedgerRow: false });
  });

  it("a non-statement row on the Saturday still blocks the move as a reorder", () => {
    addWeekendMonth(fx);
    holding(fx, fx.T, "FAKE7", "2027-07-31", 2, `tws-test:${fx.T}:FAKE7`);
    plaidRow(fx, fx.T, "FAKE7", "2027-08-02", 2);
    expect(bookAction(plan(fx).manifest, fx.T, "2027-08-02")?.reason).toBe("a move would reorder a position's history");
  });
});

// ── Prices ───────────────────────────────────────────────────────────────

describe("price rules", () => {
  it("P1 authority drop with unequal values blocks the whole security", () => {
    fx.db.prepare(`UPDATE prices SET close_price = 12.5 WHERE security_id = ? AND date = '2027-04-30'`).run(fx.sec.FAKEF);
    const { manifest } = plan(fx);
    const fund = manifest.lines.filter((l) => l.rule === `price:${fx.sec.FAKEF}`);
    expect(fund.length).toBe(4);
    expect(fund.every((l) => l.kind === "BLOCK")).toBe(true);
  });

  it("P1 authority drop within the relative tolerance passes", () => {
    fx.db.prepare(`UPDATE prices SET close_price = 11.9 * (1 + 5e-7) WHERE security_id = ? AND date = '2027-04-30'`).run(fx.sec.FAKEF);
    expect(plan(fx).manifest.counts.blocking).toBe(0);
  });

  it("P1 collision with a row that is not moving away", () => {
    // A new-format row (the security's first session is 04-08) cannot move.
    fx.db.prepare(`INSERT INTO settings (key, value) VALUES ('plaid_dating_first_session', ?)`).run(
      JSON.stringify({ accounts: {}, securities: { [fx.sec.FAKEF]: "2027-04-08" } }),
    );
    const newRow = price(fx, "FAKEF", "2027-04-08", 11.3, "plaid");
    const { manifest } = plan(fx);
    expect(manifest.datingState).toBe("mixed");
    const fund = manifest.lines.filter((l) => l.rule === `price:${fx.sec.FAKEF}`);
    expect(fund.find((l) => l.id === newRow)?.kind).toBe("IMMUTABLE_NEW_FORMAT");
    // The three legacy rows (before the first session) block; the 04-29 row is on or after it: new-format.
    expect(fund.filter((l) => l.kind === "BLOCK").length).toBe(3);
    expect(fund.filter((l) => l.kind === "IMMUTABLE_NEW_FORMAT").length).toBe(2);
  });

  it("P1 legacy fund row on a closed day blocks", () => {
    price(fx, "FAKEF", "2027-04-10", 11.25, "plaid");
    expect(plan(fx).manifest.lines.some((l) => l.rule === `price:${fx.sec.FAKEF}` && l.kind === "BLOCK")).toBe(true);
  });

  it("P2 without a broker price in the Plaid era blocks", () => {
    fx.db.prepare(`DELETE FROM prices WHERE security_id = ? AND source = 'tws'`).run(fx.sec.FAKEP);
    const l = plan(fx).manifest.lines.filter((x) => x.rule === `price:${fx.sec.FAKEP}`);
    expect(l.every((x) => x.kind === "BLOCK")).toBe(true);
  });

  it("P3 off a session date blocks", () => {
    const off = price(fx, "FAKEQ", "2027-04-13", 20.5, "plaid"); // no PRE_OPEN book of run day 04-14
    const lines = plan(fx).manifest.lines;
    expect(lines.find((x) => x.table === "prices" && x.id === off)?.kind).toBe("BLOCK");
  });

  it("price pairs bump the tax generation as predicted (on a WAL-mode file)", async () => {
    fx.db.pragma("journal_mode = WAL");
    // FAKEF sold: the 04-30 statement omits it and a statement-pass zero sits there.
    fx.db.prepare(`DELETE FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = '2027-04-30'`).run(fx.T, fx.sec.FAKEF);
    tomb(fx, fx.T, "FAKEF", "2027-04-30", ":stmt");
    stmtRow(fx, fx.T, "FAKEQ", "2027-04-30", 5, fx.batch.m2); // keeps the shrink guard passing
    const raw = JSON.parse(
      (fx.db.prepare(`SELECT raw_data FROM raw_imports WHERE import_batch_id = ?`).get(fx.batch.m2) as { raw_data: string }).raw_data,
    );
    raw.holdings = raw.holdings.filter((h: { symbol: string }) => h.symbol !== "FAKEF");
    raw.holdings.push({ accountName: "Vanguard Taxable", symbol: "FAKEQ", quantity: 5, asOfDate: "2027-04-30", sourceKey: "x" });
    fx.db.prepare(`UPDATE raw_imports SET raw_data = ? WHERE import_batch_id = ?`).run(JSON.stringify(raw), fx.batch.m2);
    expect(plan(fx).manifest.counts.blocking).toBe(0);
    fx.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_input_generation', '7')`).run();
    const cfg = writeConfig(fx);
    const { manifestPath } = await dryRun(fx, cfg);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PlaidSessionDatingManifest;
    expect(m.predicted.bumpFires).toBe(true);
    expect(m.predicted.taxInputGenerationAfter).toBe(8);
    await main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx).d);
    reopen(fx);
    expect(fx.db.prepare(`SELECT value FROM settings WHERE key = 'tax_input_generation'`).get()).toEqual({ value: "8" });
  });
});

// ── --remint-closures ────────────────────────────────────────────────────

describe("--remint-closures", () => {
  it("writes back only the missing zero rows of the manifest", async () => {
    const cfg = writeConfig(fx);
    const { manifestPath } = await dryRun(fx, cfg);
    // Before the repair: refused.
    await expect(main(["--db", fx.dbPath, "--remint-closures", "--manifest", manifestPath], deps(fx).d)).rejects.toThrow(/not repaired/);
    await main(["--db", fx.dbPath, "--config", cfg, "--apply", "--manifest", manifestPath], deps(fx).d);
    // An undo and restore lost the survivor's zero.
    reopen(fx);
    fx.db.prepare(`DELETE FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = '2027-04-30'`).run(fx.T, fx.sec.FAKE2);
    fx.db.close();
    const dry = deps(fx);
    expect(await main(["--db", fx.dbPath, "--remint-closures", "--manifest", manifestPath], dry.d)).toBe(0);
    expect(dry.logs.join("\n")).toMatch(/missing 1, conflicts 0/);
    const live = deps(fx, { isLive: () => true });
    await expect(main(["--db", fx.dbPath, "--remint-closures", "--apply", "--manifest", manifestPath], live.d)).rejects.toThrow(/live database/);
    const run = deps(fx);
    expect(await main(["--db", fx.dbPath, "--remint-closures", "--apply", "--manifest", manifestPath], run.d)).toBe(0);
    expect(run.logs.join("\n")).toMatch(/Re-minted 1 zero row/);
    reopen(fx);
    expect(
      fx.db
        .prepare(`SELECT quantity, source_key FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = '2027-04-30'`)
        .get(fx.T, fx.sec.FAKE2),
    ).toEqual({ quantity: 0, source_key: `recon:closed-equity:${fx.T}:${fx.sec.FAKE2}:2027-04-30:live` });
    fx.db.close();
    const again = deps(fx);
    await main(["--db", fx.dbPath, "--remint-closures", "--manifest", manifestPath], again.d);
    expect(again.logs.join("\n")).toMatch(/missing 0, conflicts 0/);
    reopen(fx);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────

describe("manifest binding", () => {
  it("is deterministic and binds the dating settings and the scope", () => {
    const a = plan(fx).manifest;
    const b = plan(fx).manifest;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(a.binding).toMatchObject({ datingVersion: null, datingFirstSession: null, configSha256: "test" });
    expect(a.binding.scopeSha256).toMatch(/^[0-9a-f]{64}$/);
    fx.db.prepare(`UPDATE prices SET close_price = 20.01 WHERE security_id = ?`).run(fx.sec.FAKEQ);
    expect(plan(fx).manifest.binding.scopeSha256).not.toBe(a.binding.scopeSha256);
  });
});
