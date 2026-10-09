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
