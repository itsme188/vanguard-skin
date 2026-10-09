// Significant Moves card, scoped (owner ruling 2026-10-08): the coverage line
// counts the same accounts and the same current long book the engine
// evaluates, for whatever scope the page hands the card.
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/db", () => ({ db: {} }));

import { runMigrations } from "@/lib/db/migrate";
import { computeAnomalies } from "@/lib/digest/anomalies";
import { upsertBeta } from "@/lib/mutations/security-betas";
import { loadCoverage, scopeAccountIds } from "@/app/dashboard/components/SignificantMovesCard";

const PAIR = { prior: "2026-05-07", latest: "2026-05-08" };

let db: Database.Database;
let vanguard: number;
let ibkr: number;

function account(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function security(symbol: string, opts: { beta?: boolean; move?: number } = {}): number {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'vanguard')").run(id, PAIR.prior);
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'vanguard')").run(
    id,
    PAIR.latest,
    100 + (opts.move ?? 0),
  );
  if (opts.beta !== false) upsertBeta(db, { securityId: id, lookbackDays: 60, beta: 1.0, residualStd: 1.0 });
  return id;
}

function hold(accountId: number, securityId: number, quantity = 100, date = PAIR.latest): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, quantity, date, `test:${accountId}:${securityId}:${date}`);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vanguard = account("Vanguard Taxable");
  ibkr = account("IBKR Margin");
  security("SPY");

  hold(vanguard, security("ZZA", { move: 10 }));
  hold(vanguard, security("ZZB"));
  hold(ibkr, security("ZZC", { move: 10 }));
  hold(ibkr, security("ZZD", { beta: false }));
  // A position closed since: last real row superseded by a zero-quantity row.
  const closed = security("ZZE", { move: 10 });
  hold(ibkr, closed, 100, "2026-04-30");
  hold(ibkr, closed, 0, PAIR.latest);
});

describe("loadCoverage follows the scope", () => {
  it("counts only the scope's accounts", () => {
    expect(loadCoverage(db, PAIR, [vanguard])).toEqual({
      total: 2,
      evaluated: 2,
      missingBeta: 0,
      missingCloses: 0,
    });
    expect(loadCoverage(db, PAIR, [ibkr])).toEqual({
      total: 2,
      evaluated: 1,
      missingBeta: 1,
      missingCloses: 0,
    });
  });

  it("a multi-account scope counts every account, not the first id", () => {
    expect(loadCoverage(db, PAIR, [vanguard, ibkr]).total).toBe(4);
    expect(loadCoverage(db, PAIR, [ibkr, vanguard]).total).toBe(4);
  });

  it("an empty scope counts nothing", () => {
    expect(loadCoverage(db, PAIR, [])).toEqual({ total: 0, evaluated: 0, missingBeta: 0, missingCloses: 0 });
  });

  it("the coverage always accounts for the flags the engine returns for the same scope", () => {
    for (const ids of [[vanguard], [ibkr], [vanguard, ibkr]]) {
      const flags = computeAnomalies(db, { accountIds: ids });
      const coverage = loadCoverage(db, PAIR, ids);
      expect(flags.length).toBeGreaterThan(0);
      expect(coverage.evaluated).toBeGreaterThanOrEqual(flags.length);
      // The closed position is in neither.
      expect(flags.map((f) => f.symbol)).not.toContain("ZZE");
    }
  });
});

describe("loadCoverage counts the universe the engine checks (isMoverSecurityType)", () => {
  function typed(symbol: string, securityType: string | null): number {
    const id = security(symbol, { move: 10 });
    db.prepare("UPDATE securities SET security_type = ? WHERE id = ?").run(securityType, id);
    return id;
  }

  it("an option, a bond and an untyped row are in neither count", () => {
    const before = loadCoverage(db, PAIR, [vanguard]);
    // Each has a cached beta and both closes: only its type keeps it out.
    hold(vanguard, typed("ZZOPT", "option"));
    hold(vanguard, typed("ZZBND", "bond"));
    hold(vanguard, typed("ZZNUL", null));
    hold(vanguard, typed("ZZODD", "warrant-like"));
    expect(loadCoverage(db, PAIR, [vanguard])).toEqual(before);

    // The engine names none of them either.
    const symbols = computeAnomalies(db, { accountIds: [vanguard] }).map((f) => f.symbol);
    expect(symbols).toEqual(["ZZA"]);
  });

  it("the missing-beta and missing-closes counts leave them out too", () => {
    const optionNoBeta = typed("ZZOPT", "Option");
    db.prepare("DELETE FROM security_betas WHERE security_id = ?").run(optionNoBeta);
    hold(vanguard, optionNoBeta);
    const bondNoClose = typed("ZZBND", "Bond");
    db.prepare("DELETE FROM prices WHERE security_id = ? AND date = ?").run(bondNoClose, PAIR.latest);
    hold(vanguard, bondNoClose);
    expect(loadCoverage(db, PAIR, [vanguard])).toEqual({
      total: 2,
      evaluated: 2,
      missingBeta: 0,
      missingCloses: 0,
    });
  });

  it("every equity-like type the engine keeps is counted, in any letter case", () => {
    hold(vanguard, typed("ZZETF", "ETF"));
    hold(vanguard, typed("ZZMF", "Mutual Fund"));
    hold(vanguard, typed("ZZCS", "Common Stock"));
    const coverage = loadCoverage(db, PAIR, [vanguard]);
    expect(coverage.total).toBe(5);
    expect(coverage.evaluated).toBe(5);
    const flagged = computeAnomalies(db, { accountIds: [vanguard] }).map((f) => f.symbol).sort();
    expect(flagged).toEqual(["ZZA", "ZZCS", "ZZETF", "ZZMF"]);
  });

  it("one security held in two accounts is still one holding", () => {
    const shared = typed("ZZSH", "stock");
    hold(vanguard, shared);
    hold(ibkr, shared);
    expect(loadCoverage(db, PAIR, [vanguard, ibkr]).total).toBe(5);
  });
});

describe("scopeAccountIds", () => {
  it("passes a resolved scope through untouched", () => {
    expect(scopeAccountIds(db, [ibkr])).toEqual([ibkr]);
    expect(scopeAccountIds(db, [])).toEqual([]);
  });

  it("no ids means all accounts: every account id, so the engine never falls back to Vanguard-only", () => {
    const all = (db.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(scopeAccountIds(db, undefined)).toEqual(all);
    expect(all).toContain(ibkr);
    expect(
      computeAnomalies(db, { accountIds: scopeAccountIds(db, undefined) }).map((f) => f.symbol).sort(),
    ).toEqual(["ZZA", "ZZC"]);
  });
});
