import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";
import { setPlaidItem, setPlaidAccountMap, getPlaidConnection, getPlaidReauthAlertedAt } from "@/lib/queries/plaid-settings";
import type { PlaidClientConfig } from "@/lib/plaid/client";
import { todayET } from "@/lib/calendar/date-utils";

// A weekday, non-holiday reference instant (Fri 2026-07-10 ~noon ET)
const NOW = new Date("2026-07-10T16:00:00.000Z");
const TODAY = todayET(NOW);

function holdingsJson() {
  return {
    accounts: [
      { account_id: "pTax", name: "Individual Brokerage", mask: "1111", subtype: "brokerage", balances: { current: 300000, available: null } },
    ],
    holdings: [
      { account_id: "pTax", security_id: "s1", quantity: 500, institution_price: 40, institution_value: 20000, institution_price_as_of: TODAY },
      { account_id: "pTax", security_id: "s2", quantity: 100, institution_price: 87.31, institution_value: 8731, institution_price_as_of: TODAY },
      { account_id: "pTax", security_id: "s3", quantity: 15000, institution_price: 1, institution_value: 15000, institution_price_as_of: TODAY },
    ],
    securities: [
      { security_id: "s1", ticker_symbol: "PRIM", cusip: null, name: "Primoris", type: "equity", is_cash_equivalent: false },
      { security_id: "s2", ticker_symbol: "VWENX", cusip: null, name: "Wellington", type: "mutual fund", is_cash_equivalent: false },
      { security_id: "s3", ticker_symbol: "VMFXX", cusip: null, name: "Money Market", type: "mutual fund", is_cash_equivalent: true },
    ],
  };
}

function stubCfg(json: unknown, status = 200): PlaidClientConfig {
  return {
    clientId: "cid",
    secret: "sec",
    env: "sandbox",
    redirectUri: "http://localhost:3099/dashboard/plaid-link",
    fetchImpl: (async () =>
      new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })) as typeof fetch,
  };
}

describe("refreshVanguardHoldingsFromPlaid", () => {
  let db: Database.Database;
  let taxableId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // "Vanguard Taxable" is already seeded by migration 002_seed_accounts.sql
    // — resolve the existing row (INSERT OR IGNORE) rather than inserting a
    // duplicate, which would violate accounts.name's UNIQUE constraint. Same
    // adaptation as tests/import/engine-plaid-guards.test.ts.
    db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
    taxableId = (
      db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as { id: number }
    ).id;
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: taxableId });
  });

  it("returns null when not connected", async () => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    runMigrations(fresh);
    const r = await refreshVanguardHoldingsFromPlaid(fresh, { cfg: stubCfg(holdingsJson()), now: NOW });
    expect(r).toBeNull();
  });

  it("writes holdings, cash snapshot, MF price; folds VMFXX to cash", async () => {
    const r = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    expect(r).not.toBeNull();
    expect(r!.holdingsWritten).toBe(2); // PRIM + VWENX (VMFXX folded)
    const holdings = db
      .prepare(
        `SELECT s.symbol, h.quantity, h.cost_basis, h.source_key FROM holdings h JOIN securities s ON s.id = h.security_id WHERE h.account_id = ? AND h.as_of_date = ?`,
      )
      .all(taxableId, TODAY) as { symbol: string; quantity: number; cost_basis: number | null; source_key: string }[];
    expect(holdings.map((h) => h.symbol).sort()).toEqual(["PRIM", "VWENX"]);
    expect(holdings.every((h) => h.cost_basis === null)).toBe(true);
    expect(holdings.every((h) => h.source_key.startsWith("plaid:"))).toBe(true);

    const snap = db
      .prepare(`SELECT total_value, cash_value, source FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?`)
      .get(taxableId, TODAY) as { total_value: number; cash_value: number; source: string };
    expect(snap).toEqual({ total_value: 300000, cash_value: 15000, source: "plaid" });

    const price = db
      .prepare(
        `SELECT p.close_price, p.source FROM prices p JOIN securities s ON s.id = p.security_id WHERE s.symbol = 'VWENX' AND p.date = ?`,
      )
      .get(TODAY) as { close_price: number; source: string };
    expect(price).toEqual({ close_price: 87.31, source: "plaid" });
  });

  it("never overwrites a statement-sourced snapshot", async () => {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, 111, 'vanguard-pdf')`,
    ).run(taxableId, TODAY);
    await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    const snap = db
      .prepare(`SELECT total_value, source FROM monthly_snapshots WHERE account_id = ?`)
      .get(taxableId) as { total_value: number; source: string };
    expect(snap.source).toBe("vanguard-pdf");
    expect(snap.total_value).toBe(111);
  });

  it("removes same-day plaid rows for positions gone from the pull (intraday round-trip)", async () => {
    const goneId = upsertSecurity(db, { symbol: "GONE", securityType: "Stock" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 10, NULL, ?, ?)`,
    ).run(taxableId, goneId, TODAY, `plaid:${taxableId}:${goneId}:${TODAY}`);
    const r = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    expect(r!.staleRemoved).toBe(1);
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM holdings WHERE security_id = ?`).get(goneId),
    ).toEqual({ c: 0 });
  });

  it("skips a second run the same ET day unless forced", async () => {
    await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    const second = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW });
    expect(second!.skippedReason).toBe("already_synced_today");
  });

  it("marks reauth_required + stamps alert on ITEM_LOGIN_REQUIRED", async () => {
    const errCfg = stubCfg(
      { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", error_message: "re-auth needed" },
      400,
    );
    await expect(
      refreshVanguardHoldingsFromPlaid(db, { cfg: errCfg, now: NOW, force: true }),
    ).rejects.toThrow();
    expect(getPlaidConnection(db).connectionStatus).toBe("reauth_required");
    expect(getPlaidReauthAlertedAt(db)).not.toBeNull();
  });
});
