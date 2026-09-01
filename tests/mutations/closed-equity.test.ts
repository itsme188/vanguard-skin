import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  reconcileClosedEquityHoldings,
  zeroLatestSecurityIds,
  countReconRowsOnDate,
} from "@/lib/mutations/closed-equity";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function acct(name: string): number {
  return (
    db.prepare(
      `INSERT INTO accounts (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id`,
    ).get(name) as { id: number }
  ).id;
}
function sec(symbol: string, type = "stock"): number {
  return (
    db.prepare(
      `INSERT INTO securities (symbol, security_type) VALUES (?, ?) RETURNING id`,
    ).get(symbol, type) as { id: number }
  ).id;
}
/**
 * A money-market sweep fund, in the live-production shape documented in
 * lib/compute/cash-equivalents.ts: brokers call it a "Mutual Fund" and only
 * `fund_category = 'Cash Equivalent'` (signal 2) marks it as cash.
 */
function secCash(symbol: string): number {
  return (
    db.prepare(
      `INSERT INTO securities (symbol, security_type, fund_category) VALUES (?, 'Mutual Fund', 'Cash Equivalent') RETURNING id`,
    ).get(symbol) as { id: number }
  ).id;
}
function hold(a: number, s: number, qty: number, date: string, sourceKey?: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(a, s, qty, date, sourceKey ?? `seed:${a}:${s}:${date}`);
}
/** A statement-sourced holdings row (canonical:hold: is a STATEMENT prefix). */
function holdStmt(a: number, s: number, qty: number, date: string): void {
  hold(a, s, qty, date, `canonical:hold:${a}:${s}:${date}`);
}
/** A live (Plaid) holdings row — never statement authority. */
function holdLive(a: number, s: number, qty: number, date: string): void {
  hold(a, s, qty, date, `plaid:${a}:${s}:${date}`);
}
/** Positions the app renders as live, via the shared latest-holdings predicate. */
function livePositionIds(a: number): number[] {
  const sql = `SELECT h.security_id AS security_id FROM holdings h
                WHERE ${latestHoldingsPredicate({ accountFilter: "AND h.account_id = ?" })}`;
  return (db.prepare(sql).all(a) as { security_id: number }[]).map((r) => r.security_id);
}
function sourceKeyOf(a: number, s: number, date: string): string {
  return (
    db.prepare(
      `SELECT source_key FROM holdings WHERE account_id=? AND security_id=? AND as_of_date=?`,
    ).get(a, s, date) as { source_key: string }
  ).source_key;
}
function latestQty(a: number, s: number): { q: number; d: string } {
  return db.prepare(
    `SELECT quantity q, as_of_date d FROM holdings WHERE account_id=? AND security_id=? ORDER BY as_of_date DESC LIMIT 1`,
  ).get(a, s) as { q: number; d: string };
}

describe("reconcileClosedEquityHoldings", () => {
  it("marks an equity absent from the latest snapshot flat (zero-row at snapshot date)", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const gone = sec("GONE");
    // prior snapshot 05-01: both held
    hold(a, held, 100, "2026-05-01");
    hold(a, gone, 50, "2026-05-01");
    // latest snapshot 06-02: only HELD present (GONE was sold → absent)
    hold(a, held, 100, "2026-06-02");

    const n = reconcileClosedEquityHoldings(db);
    expect(n).toBe(1);
    // GONE now has a zero-qty row dated to the latest snapshot
    const g = latestQty(a, gone);
    expect(g.q).toBe(0);
    expect(g.d).toBe("2026-06-02");
    // HELD untouched
    expect(latestQty(a, held).q).toBe(100);
  });

  it("does not touch a position present in the latest snapshot", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    hold(a, held, 100, "2026-05-01");
    hold(a, held, 120, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, held).q).toBe(120);
  });

  it("SHRINK GUARD: skips when the latest snapshot is <50% of the prior (partial/failed sync)", () => {
    const a = acct("IBKR");
    const ids = Array.from({ length: 10 }, (_, i) => sec(`S${i}`));
    // prior 05-01: all 10 held
    ids.forEach((s) => hold(a, s, 100, "2026-05-01"));
    // latest 06-02: only 2 present (looks like a broken/partial snapshot)
    hold(a, ids[0], 100, "2026-06-02");
    hold(a, ids[1], 100, "2026-06-02");

    expect(reconcileClosedEquityHoldings(db)).toBe(0); // refuse to wipe the other 8
    // the 8 absent ones are NOT zeroed — their latest stays the 05-01 row
    expect(latestQty(a, ids[5]).q).toBe(100);
    expect(latestQty(a, ids[5]).d).toBe("2026-05-01");
  });

  it("does NOT touch non-equity (options/bonds handled by sibling purges)", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const held2 = sec("HELD2");
    const opt = sec("OPT1", "option");
    const bond = sec("BOND1", "bond");
    // prior 05-01: 2 stocks + opt + bond (4). latest 06-02: both stocks (2) →
    // 2 of 4 is not below the 50% shrink floor, so reconciliation runs. The
    // bond is out of scope by type; the option survives on the EVIDENCE guard
    // (the latest snapshot reports no options at all, so this source is not
    // treated as an authority on the option book).
    hold(a, held, 100, "2026-05-01");
    hold(a, held2, 100, "2026-05-01");
    hold(a, opt, 5, "2026-05-01");
    hold(a, bond, 10, "2026-05-01");
    hold(a, held, 100, "2026-06-02");
    hold(a, held2, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(0); // opt + bond absent but not equities
    expect(latestQty(a, opt).q).toBe(5);
    expect(latestQty(a, bond).q).toBe(10);
  });

  it("is idempotent — a second run makes no further changes", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const gone = sec("GONE");
    hold(a, held, 100, "2026-05-01");
    hold(a, gone, 50, "2026-05-01");
    hold(a, held, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });

  it("treats ETF like stock", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const etf = sec("ARKK", "etf");
    hold(a, held, 100, "2026-05-01");
    hold(a, etf, 500, "2026-05-01");
    hold(a, held, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(latestQty(a, etf).q).toBe(0);
  });

  it("scopes to a single account when accountId is given", () => {
    const ibkr = acct("IBKR");
    const van = acct("Vanguard Taxable");
    const g1 = sec("GONE1");
    const g2 = sec("GONE2");
    const h1 = sec("HELD1");
    const h2 = sec("HELD2");
    // IBKR: GONE1 dropped from latest
    hold(ibkr, g1, 50, "2026-05-01"); hold(ibkr, h1, 100, "2026-05-01"); hold(ibkr, h1, 100, "2026-06-02");
    // Vanguard: GONE2 dropped from latest
    hold(van, g2, 50, "2026-05-01"); hold(van, h2, 100, "2026-05-01"); hold(van, h2, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db, { accountId: ibkr })).toBe(1);
    expect(latestQty(ibkr, g1).q).toBe(0);
    expect(latestQty(van, g2).q).toBe(50); // untouched — different account
  });

  it("no-ops on an account with only one snapshot (nothing absent)", () => {
    const a = acct("IBKR");
    const s1 = sec("A"); const s2 = sec("B");
    hold(a, s1, 100, "2026-06-02"); hold(a, s2, 50, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });
});

describe("reconcileClosedEquityHoldings — options (live-snapshot pass, evidence-guarded)", () => {
  it("tombstones an option absent from the latest snapshot when that snapshot still reports options", () => {
    const a = acct("Vanguard Taxable");
    const eq = sec("VTI", "etf");
    const o1 = sec("O1", "option");
    const o2 = sec("O2", "option");
    const sold = sec("SOLD", "option");
    // prior 08-11: equity + 3 options
    hold(a, eq, 100, "2026-08-11");
    hold(a, o1, 5, "2026-08-11");
    hold(a, o2, 5, "2026-08-11");
    hold(a, sold, 5, "2026-08-11");
    // latest 08-20: equity + 2 options — SOLD was closed mid-month, no ledger row
    hold(a, eq, 100, "2026-08-20");
    hold(a, o1, 5, "2026-08-20");
    hold(a, o2, 5, "2026-08-20");

    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    const s = latestQty(a, sold);
    expect(s.q).toBe(0);
    expect(s.d).toBe("2026-08-20");
    expect(latestQty(a, o1).q).toBe(5);
    // the tombstone keeps the engine-owned recon prefix (holding-sources.ts)
    // and carries the :live suffix — this is the equity/option live pass.
    expect(sourceKeyOf(a, sold, "2026-08-20")).toBe(
      `recon:closed-equity:${a}:${sold}:2026-08-20:live`,
    );
    // and the position stops rendering as live
    expect(livePositionIds(a)).not.toContain(sold);
  });

  it("EVIDENCE GUARD: leaves options alone when the latest snapshot reports NO options", () => {
    const a = acct("Vanguard Roth");
    const eq = sec("VTI", "etf");
    const eq2 = sec("VXUS", "etf");
    const opt = sec("O1", "option");
    hold(a, eq, 100, "2026-08-11");
    hold(a, eq2, 100, "2026-08-11");
    hold(a, opt, 5, "2026-08-11");
    // latest 08-20 reports only equities — this source says nothing about options
    hold(a, eq, 100, "2026-08-20");
    hold(a, eq2, 100, "2026-08-20");

    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, opt).q).toBe(5);
    expect(livePositionIds(a)).toContain(opt);
  });

  it("never tombstones bonds / mutual funds, even when the snapshot reports options", () => {
    const a = acct("Vanguard Taxable");
    const eq = sec("VTI", "etf");
    const o1 = sec("O1", "option");
    const bond = sec("T 4.5 2027", "bond");
    const fund = sec("VHGEX", "mutual_fund");
    hold(a, eq, 100, "2026-08-11");
    hold(a, o1, 5, "2026-08-11");
    hold(a, bond, 10, "2026-08-11");
    hold(a, fund, 50, "2026-08-11");
    // latest 08-20 is a live (Plaid-shaped) book: equities + options only
    hold(a, eq, 100, "2026-08-20");
    hold(a, o1, 5, "2026-08-20");

    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, bond).q).toBe(10);
    expect(latestQty(a, fund).q).toBe(50);
  });

  it("PER-CLASS SHRINK GUARD: refuses an option book that lost more than half, equities untouched", () => {
    const a = acct("IBKR");
    const eqs = Array.from({ length: 10 }, (_, i) => sec(`E${i}`, "stock"));
    const opts = Array.from({ length: 10 }, (_, i) => sec(`O${i}`, "option"));
    eqs.forEach((s) => hold(a, s, 100, "2026-08-11"));
    opts.forEach((s) => hold(a, s, 5, "2026-08-11"));
    // latest: all 10 equities but only 2 options (12 of 20 clears the COMBINED
    // floor — only a per-class guard catches the collapsed option book)
    eqs.forEach((s) => hold(a, s, 100, "2026-08-20"));
    hold(a, opts[0], 5, "2026-08-20");
    hold(a, opts[1], 5, "2026-08-20");

    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, opts[5]).q).toBe(5);
    expect(latestQty(a, opts[5]).d).toBe("2026-08-11");
  });

  it("is idempotent for options — a second run inserts no further tombstone", () => {
    const a = acct("Vanguard Taxable");
    const o1 = sec("O1", "option");
    const sold = sec("SOLD", "option");
    hold(a, o1, 5, "2026-08-11");
    hold(a, sold, 5, "2026-08-11");
    hold(a, o1, 5, "2026-08-20");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    const rows = db.prepare(
      `SELECT COUNT(*) c FROM holdings WHERE account_id=? AND security_id=? AND quantity=0`,
    ).get(a, sold) as { c: number };
    expect(rows.c).toBe(1);
  });

  it("SELF-HEALS: a newer non-zero row after the tombstone makes the option live again", () => {
    const a = acct("Vanguard Taxable");
    const o1 = sec("O1", "option");
    const back = sec("BACK", "option");
    hold(a, o1, 5, "2026-08-11");
    hold(a, back, 5, "2026-08-11");
    hold(a, o1, 5, "2026-08-20");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(livePositionIds(a)).not.toContain(back);
    // re-opened (or the snapshot was simply wrong) — a newer real row wins
    hold(a, back, 3, "2026-08-25");
    hold(a, o1, 5, "2026-08-25");
    expect(livePositionIds(a)).toContain(back);
    expect(latestQty(a, back).q).toBe(3);
  });
});

describe("reconcileClosedEquityHoldings — statement pass (complete-book, any security type)", () => {
  it("tombstones a fully-sold mutual fund absent from the later statement, at the statement date", () => {
    const a = acct("Vanguard Taxable");
    const eq = sec("VTI", "etf");
    const bond = sec("T 4.5 2027", "bond");
    const f1 = sec("VHGEX", "mutual_fund");
    const f2 = sec("VIPSX", "mutual_fund");
    // April statement: everything
    holdStmt(a, eq, 100, "2026-04-30");
    holdStmt(a, bond, 10, "2026-04-30");
    holdStmt(a, f1, 50, "2026-04-30");
    holdStmt(a, f2, 30, "2026-04-30");
    // July statement: funds sold on 05-05, statement correctly omits them
    holdStmt(a, eq, 100, "2026-07-31");
    holdStmt(a, bond, 10, "2026-07-31");
    // Plaid keeps reporting the equity daily (never funds, never bonds)
    holdLive(a, eq, 100, "2026-08-20");

    expect(reconcileClosedEquityHoldings(db)).toBe(2);
    for (const f of [f1, f2]) {
      expect(latestQty(a, f).q).toBe(0);
      expect(latestQty(a, f).d).toBe("2026-07-31"); // the statement date, not today
      // :stmt suffix — this is the statement pass.
      expect(sourceKeyOf(a, f, "2026-07-31")).toBe(
        `recon:closed-equity:${a}:${f}:2026-07-31:stmt`,
      );
    }
    const live = livePositionIds(a);
    expect(live).not.toContain(f1);
    expect(live).not.toContain(f2);
    // the bond IS on the latest statement — untouched, still live
    expect(latestQty(a, bond).q).toBe(10);
    expect(live).toContain(bond);
  });

  it("is a no-op for an account with no statement-sourced rows at all (IBKR live-only)", () => {
    const a = acct("IBKR");
    const eq = sec("AAPL", "stock");
    const fund = sec("FUND", "mutual_fund");
    hold(a, eq, 100, "2026-08-01", `tws-${a}-${eq}-2026-08-01`);
    hold(a, fund, 10, "2026-08-01", `tws-${a}-${fund}-2026-08-01`);
    hold(a, eq, 100, "2026-08-20", `tws-${a}-${eq}-2026-08-20`);

    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, fund).q).toBe(10);
  });

  it("STATEMENT SHRINK GUARD: refuses an under-extracted statement (compared statement-to-statement)", () => {
    const a = acct("Vanguard Taxable");
    const eqs = Array.from({ length: 6 }, (_, i) => sec(`E${i}`, "etf"));
    const f1 = sec("VHGEX", "mutual_fund");
    const f2 = sec("VIPSX", "mutual_fund");
    // April statement: 6 equities + 2 funds
    eqs.forEach((s) => holdStmt(a, s, 100, "2026-04-30"));
    holdStmt(a, f1, 50, "2026-04-30");
    holdStmt(a, f2, 30, "2026-04-30");
    // July statement under-extracted: only 2 of 8 lines parsed
    holdStmt(a, eqs[0], 100, "2026-07-31");
    holdStmt(a, eqs[1], 100, "2026-07-31");
    // Plaid still reports all 6 equities daily, so the LIVE pass is healthy
    eqs.forEach((s) => holdLive(a, s, 100, "2026-08-20"));

    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, f1)).toEqual({ q: 50, d: "2026-04-30" });
    expect(latestQty(a, f2)).toEqual({ q: 30, d: "2026-04-30" });
  });

  it("statement pass is idempotent", () => {
    const a = acct("Vanguard Taxable");
    const eq = sec("VTI", "etf");
    const fund = sec("VHGEX", "mutual_fund");
    holdStmt(a, eq, 100, "2026-04-30");
    holdStmt(a, fund, 50, "2026-04-30");
    holdStmt(a, eq, 100, "2026-07-31");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    const rows = db.prepare(
      `SELECT COUNT(*) c FROM holdings WHERE account_id=? AND security_id=? AND quantity=0`,
    ).get(a, fund) as { c: number };
    expect(rows.c).toBe(1);
  });

  it("SELF-HEALS: a fund repurchased after the statement date stays live", () => {
    const a = acct("Vanguard Taxable");
    const eq = sec("VTI", "etf");
    const fund = sec("VHGEX", "mutual_fund");
    holdStmt(a, eq, 100, "2026-04-30");
    holdStmt(a, fund, 50, "2026-04-30");
    holdStmt(a, eq, 100, "2026-07-31");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    holdStmt(a, fund, 12, "2026-08-31");
    holdStmt(a, eq, 100, "2026-08-31");
    expect(livePositionIds(a)).toContain(fund);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });

  it("CASH-EQUIVALENT GUARD: does NOT tombstone a sweep fund folded into cash on a later statement", () => {
    // Codex-flagged case: a statement that folds the money-market sweep fund
    // into its cash balance instead of listing it as a holdings line looks,
    // to the statement pass, exactly like a sold mutual fund — absent from
    // the latest statement snapshot. But daily_valuations counts sweep funds
    // as CASH (isCashEquivalentSecurity), so tombstoning it here would zero
    // out the account's cash. The 50% shrink guard alone can't catch this —
    // one row disappearing from a large statement doesn't trip it.
    const a = acct("Vanguard Taxable");
    const eq = sec("VTI", "etf");
    const sweep = secCash("VMFXX");
    // April statement: equity + sweep fund listed as a holding
    holdStmt(a, eq, 100, "2026-04-30");
    holdStmt(a, sweep, 5000, "2026-04-30");
    // July statement: sweep fund folded into cash, no longer a holdings line
    holdStmt(a, eq, 100, "2026-07-31");

    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, sweep)).toEqual({ q: 5000, d: "2026-04-30" });
    expect(livePositionIds(a)).toContain(sweep);
  });

  it("still tombstones a sold (non-cash) mutual fund absent from the later statement, alongside an untouched sweep fund", () => {
    const a = acct("Vanguard Taxable");
    // Several always-held equities keep the statement-vs-prior-statement
    // shrink guard well clear of its 50% floor (dropping 2 of 6 rows, not 2
    // of 3) — isolating the assertion to the cash-equivalent filter itself.
    const eqs = Array.from({ length: 4 }, (_, i) => sec(`E${i}`, "etf"));
    const sweep = secCash("VMFXX");
    const fund = sec("VHGEX", "mutual_fund");
    eqs.forEach((s) => holdStmt(a, s, 100, "2026-04-30"));
    holdStmt(a, sweep, 5000, "2026-04-30");
    holdStmt(a, fund, 50, "2026-04-30");
    // July: sweep folded into cash AND the fund was actually sold
    eqs.forEach((s) => holdStmt(a, s, 100, "2026-07-31"));

    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(latestQty(a, fund)).toEqual({ q: 0, d: "2026-07-31" });
    expect(latestQty(a, sweep)).toEqual({ q: 5000, d: "2026-04-30" });
    expect(livePositionIds(a)).toContain(sweep);
  });
});

describe("tombstone provenance + ownership", () => {
  it("statement-pass tombstones carry :stmt suffix; live-pass carry :live", () => {
    const a = acct("A1");
    const x = sec("XONE");
    const y = sec("YTWO", "etf");
    const z = sec("ZFOUR", "etf");
    // statement book at D1 has X, Y, Z; statement book at D2 has only Y, Z → X
    // phantom (stmt pass, tombstoned :stmt).
    hold(a, x, 5, "2026-07-31", "canonical:hold:x1");
    hold(a, y, 5, "2026-07-31", "canonical:hold:y1");
    hold(a, z, 5, "2026-07-31", "canonical:hold:z1");
    hold(a, y, 5, "2026-08-29", "canonical:hold:y2");
    hold(a, z, 5, "2026-08-29", "canonical:hold:z2");
    // A later live (Plaid) snapshot on 08-30 reports only Y → Z is a phantom
    // under the live equity pass (Z was present on the latest statement, so
    // the statement pass alone never catches it — only the live pass does,
    // tombstoned :live).
    hold(a, y, 5, "2026-08-30", "plaid:1:9:2026-08-30");
    reconcileClosedEquityHoldings(db);
    const stmtTomb = db
      .prepare(`SELECT source_key FROM holdings WHERE quantity = 0 AND security_id = ?`)
      .get(x) as { source_key: string };
    expect(stmtTomb.source_key.startsWith("recon:closed-equity:")).toBe(true);
    expect(stmtTomb.source_key.endsWith(":stmt")).toBe(true);
    const liveTomb = db
      .prepare(`SELECT source_key FROM holdings WHERE quantity = 0 AND security_id = ?`)
      .get(z) as { source_key: string };
    expect(liveTomb.source_key.startsWith("recon:closed-equity:")).toBe(true);
    expect(liveTomb.source_key.endsWith(":live")).toBe(true);
  });

  it("stamps import_batch_id only for owned accounts", () => {
    const a1 = acct("A1");
    const a2 = acct("A2");
    const x = sec("XONE");
    const z = sec("ZTHR");
    const batchId = (
      db.prepare(`INSERT INTO import_batches (source_type) VALUES ('canonical-csv') RETURNING id`).get() as { id: number }
    ).id;
    // both accounts have a phantom vs their latest statement snapshots
    hold(a1, x, 5, "2026-07-31", "canonical:hold:1");
    hold(a1, sec("KEEP1"), 5, "2026-08-29", "canonical:hold:2");
    hold(a2, z, 5, "2026-07-31", "canonical:hold:3");
    hold(a2, sec("KEEP2"), 5, "2026-08-29", "canonical:hold:4");
    reconcileClosedEquityHoldings(db, { importBatchId: batchId, ownedAccountIds: [a1] });
    const owned = db.prepare(`SELECT import_batch_id FROM holdings WHERE quantity=0 AND account_id=?`).get(a1) as { import_batch_id: number | null };
    const unowned = db.prepare(`SELECT import_batch_id FROM holdings WHERE quantity=0 AND account_id=?`).get(a2) as { import_batch_id: number | null };
    expect(owned.import_batch_id).toBe(batchId);
    expect(unowned.import_batch_id).toBeNull();
  });

  it("ownedAccountIds without importBatchId never stamps (half-condition) and still reconciles", () => {
    // opts.importBatchId is the AND-partner of `ownedAccounts.has(accountId)`
    // in the tombstone closure — omitting it must leave every tombstone
    // unstamped, even for an account named in ownedAccountIds, and must not
    // throw despite ownedAccountIds being non-empty.
    const a1 = acct("A1");
    const x = sec("XONE");
    hold(a1, x, 5, "2026-07-31", "canonical:hold:1");
    hold(a1, sec("KEEP1"), 5, "2026-08-29", "canonical:hold:2");
    expect(() =>
      reconcileClosedEquityHoldings(db, { ownedAccountIds: [a1] }),
    ).not.toThrow();
    const tomb = db
      .prepare(`SELECT import_batch_id FROM holdings WHERE quantity=0 AND account_id=? AND security_id=?`)
      .get(a1, x) as { import_batch_id: number | null };
    expect(tomb.import_batch_id).toBeNull();
  });

  it("bumps the tax generation when it marks anything, not when it marks nothing", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 5, "2026-07-31", "canonical:hold:1");
    hold(a, sec("KEEP1"), 5, "2026-08-29", "canonical:hold:2");
    const g0 = getTaxInputGeneration(db);
    expect(reconcileClosedEquityHoldings(db)).toBeGreaterThan(0);
    const g1 = getTaxInputGeneration(db);
    expect(g1).toBe(g0 + 1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0); // idempotent second run
    expect(getTaxInputGeneration(db)).toBe(g1);        // no bump on no-op
  });
});

describe("run atomicity", () => {
  it("a mid-run failure leaves zero tombstones from that run (fault injected mid-run, no outer transaction)", () => {
    // Discriminating version: NO outer transaction wraps the call — the fault
    // is injected via a TEMP TRIGGER that aborts a specific INSERT partway
    // through the reconciler's own run. Single account, so pass ordering is
    // deterministic from the algorithm's structure (not from row-ordering of
    // a multi-account query): pass 1 (statement) tombstones GONE1 and
    // completes FIRST; pass 2 (live equity), which runs after pass 1 for the
    // same account, then tries to tombstone GONE2 — the trigger aborts that
    // insert. If reconcileClosedEquityHoldings did not wrap the whole run in
    // its own transaction, GONE1's already-committed tombstone from pass 1
    // would survive the throw (this is exactly what the removed non-
    // discriminating version of this test could not catch, since it wrapped
    // the call in the CALLER's own transaction, which rolls back regardless
    // of whether the function has an inner transaction of its own).
    const a = acct("A1");
    const gone1 = sec("GONE1");
    const keep1 = sec("KEEP1");
    const gone2 = sec("GONE2");
    // April statement: GONE1 + KEEP1. July statement: KEEP1 + GONE2 (GONE1
    // absent → pass-1 phantom, tombstoned first).
    hold(a, gone1, 5, "2026-07-31", "canonical:hold:1");
    hold(a, keep1, 5, "2026-07-31", "canonical:hold:2");
    hold(a, keep1, 5, "2026-08-29", "canonical:hold:3");
    hold(a, gone2, 5, "2026-08-29", "canonical:hold:4");
    // A later live snapshot reports only KEEP1 → GONE2 is a pass-2 (live
    // equity) phantom, tombstoned second (after pass 1 has already run).
    hold(a, keep1, 5, "2026-08-30", "plaid:1:9:2026-08-30");

    db.exec(
      `CREATE TEMP TRIGGER boom BEFORE INSERT ON holdings WHEN NEW.security_id = ${gone2} BEGIN SELECT RAISE(ABORT,'boom'); END`,
    );
    expect(() => reconcileClosedEquityHoldings(db)).toThrow();
    // GONE1's pass-1 tombstone must have rolled back along with the aborted
    // pass-2 insert — zero tombstones survive the failed run.
    expect(db.prepare(`SELECT COUNT(*) c FROM holdings WHERE quantity=0`).get()).toEqual({ c: 0 });
  });
});

describe("detection helpers", () => {
  it("zeroLatestSecurityIds returns securities whose latest row is quantity 0", () => {
    const a = acct("A1");
    const x = sec("XONE");
    const y = sec("YTWO");
    hold(a, x, 5, "2026-07-01", "canonical:hold:1");
    hold(a, x, 0, "2026-08-01", "recon:closed-equity:t1:stmt");
    hold(a, y, 5, "2026-08-01", "canonical:hold:2");
    const s = zeroLatestSecurityIds(db, a);
    expect(s.has(x)).toBe(true);
    expect(s.has(y)).toBe(false);
  });
  it("countReconRowsOnDate counts recon rows for (account, date)", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t1:live");
    hold(a, sec("YTWO"), 5, "2026-08-01", "canonical:hold:1");
    expect(countReconRowsOnDate(db, a, "2026-08-01")).toBe(1);
    expect(countReconRowsOnDate(db, a, "2026-08-02")).toBe(0);
  });
});
