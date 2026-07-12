import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";
import { setPlaidItem, setPlaidAccountMap, getPlaidConnection, getPlaidReauthAlertedAt } from "@/lib/queries/plaid-settings";
import type { PlaidClientConfig } from "@/lib/plaid/client";
import { todayET } from "@/lib/calendar/date-utils";
import { getSyncState } from "@/lib/tws/sync-state";

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
    // Pre-seed PRIM so it's an EXISTING security going into this sync —
    // only VWENX (and the folded VMFXX cash security, created inside
    // mapPlaidHoldings/upsertSecurity elsewhere) should land in
    // securitiesCreated for a brand-new symbol.
    upsertSecurity(db, { symbol: "PRIM", securityType: "Stock" });

    const r = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    expect(r).not.toBeNull();
    expect(r!.holdingsWritten).toBe(2); // PRIM + VWENX (VMFXX folded)
    // F4: brand-new symbol (VWENX) surfaces in securitiesCreated; the
    // pre-existing PRIM does not.
    expect(r!.securitiesCreated).toContain("VWENX");
    expect(r!.securitiesCreated).not.toContain("PRIM");
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

  it("does not wedge sync-state at 'syncing' when the write half throws", async () => {
    // The fetch half is already guarded (catch → setSyncError → rethrow).
    // The write half (writePlaidHoldings + the setPlaid* finalizers) was not
    // — a throw there left global sync-state stuck at "syncing" forever
    // (isSyncing() then null-gates every future call until process restart).
    //
    // Note on mechanism: the task's suggested trigger — pre-seeding a
    // security under a conflicting type so upsertSecurity's stock↔option
    // guard "throws" — does not actually throw in the current
    // implementation (lib/mutations/securities.ts logs a console.warn and
    // returns the existing id; verified no CHECK/NOT NULL constraint
    // backs it, so it degrades gracefully by design, not by accident). To
    // exercise a genuine, deterministic write-half failure instead, drop a
    // table `writePlaidHoldings` prepares a statement against
    // (monthly_snapshots) — SQLite throws "no such table" the moment the
    // write half runs, which is functionally identical to any other DB
    // error occurring mid-write for the purposes of this regression pin.
    db.exec(`DROP TABLE monthly_snapshots`);

    await expect(
      refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true }),
    ).rejects.toThrow();
    expect(getSyncState().status).toBe("error");

    // A subsequent call must not be null-gated by isSyncing() (which would
    // silently resolve null forever with the old bug) — it should attempt
    // the sync again and reject for the same underlying reason (the table
    // is still missing), proving the mutex was correctly released. Assert
    // via try/catch (rather than `.rejects`) so a regression to the old
    // null-gated behavior fails loudly as "resolved null" rather than as
    // an ambiguous matcher error.
    let secondOutcome: "resolved-null" | "resolved-value" | "rejected";
    try {
      const result = await refreshVanguardHoldingsFromPlaid(db, {
        cfg: stubCfg(holdingsJson()),
        now: NOW,
        force: true,
      });
      secondOutcome = result === null ? "resolved-null" : "resolved-value";
    } catch {
      secondOutcome = "rejected";
    }
    expect(secondOutcome).toBe("rejected");
  });

  it("resolves dotted share-class tickers onto existing slash-form securities (BRK.B → BRK/B, first live sync 2026-07-11)", async () => {
    // Statements store BRK/B; Plaid says BRK.B. Pre-fix the sync created a
    // duplicate BRK.B security and the closed-equity reconciler then wrote
    // phantom quantity=0 rows for the REAL BRK/B in both accounts.
    const brkSlashId = upsertSecurity(db, { symbol: "BRK/B", securityType: "Stock" });
    const resp = holdingsJson();
    resp.holdings.push({
      account_id: "pTax", security_id: "s-brk", quantity: 25,
      institution_price: 480, institution_value: 12000, institution_price_as_of: TODAY,
    });
    resp.securities.push({
      security_id: "s-brk", ticker_symbol: "BRK.B", cusip: null,
      name: "Berkshire Hathaway Class B", type: "equity", is_cash_equivalent: false,
    });

    const r = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(resp), now: NOW, force: true });

    // No duplicate security created…
    expect(db.prepare(`SELECT COUNT(*) AS c FROM securities WHERE symbol = 'BRK.B'`).get()).toEqual({ c: 0 });
    expect(r!.securitiesCreated).not.toContain("BRK.B");
    // …and the plaid holdings row landed on the existing BRK/B security.
    const row = db
      .prepare(`SELECT quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`)
      .get(taxableId, brkSlashId, TODAY) as { quantity: number } | undefined;
    expect(row?.quantity).toBe(25);
  });

  it("statement-wins: a vanguard-pdf holdings row survives a same-day plaid sync", async () => {
    const primId = upsertSecurity(db, { symbol: "PRIM", securityType: "Stock" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 999, NULL, ?, 'vanguard-pdf:test:1')`,
    ).run(taxableId, primId, TODAY);

    await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });

    const row = db
      .prepare(
        `SELECT quantity, source_key FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`,
      )
      .get(taxableId, primId, TODAY) as { quantity: number; source_key: string };
    expect(row.quantity).toBe(999);
    expect(row.source_key).toBe("vanguard-pdf:test:1");
  });

  it("statement-wins: a tws-sourced price row survives a same-day plaid sync", async () => {
    const vwenxId = upsertSecurity(db, { symbol: "VWENX", securityType: "Mutual Fund" });
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 111, 'tws')`,
    ).run(vwenxId, TODAY);

    await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });

    const row = db
      .prepare(`SELECT close_price, source FROM prices WHERE security_id = ? AND date = ?`)
      .get(vwenxId, TODAY) as { close_price: number; source: string };
    expect(row.close_price).toBe(111);
    expect(row.source).toBe("tws");
  });

  it("skips an account with zero mapped positions entirely — no holdings, no snapshot (F6)", async () => {
    // accountMap maps a second Plaid account ("pEmpty") that has a balance
    // in resp.accounts but NO holdings rows at all — zero mapped
    // positions. The zero-holdings guard in writePlaidHoldings must skip
    // that account entirely: no holdings written, no monthly_snapshots
    // row (which would otherwise misrepresent a real account as "$0,
    // fully liquidated"), and it must not count toward accountsSynced.
    const rothId = (
      db.prepare(`INSERT INTO accounts (name) VALUES ('Roth IRA') RETURNING id`).get() as {
        id: number;
      }
    ).id;
    setPlaidAccountMap(db, { pTax: taxableId, pEmpty: rothId });

    const base = holdingsJson();
    const json = {
      ...base,
      accounts: [
        ...base.accounts,
        {
          account_id: "pEmpty",
          name: "Roth IRA",
          mask: "2222",
          subtype: "ira",
          balances: { current: 50000, available: null },
        },
      ],
      // No holdings entries reference "pEmpty" — zero mapped positions.
    };

    const r = await refreshVanguardHoldingsFromPlaid(db, {
      cfg: stubCfg(json),
      now: NOW,
      force: true,
    });

    expect(r).not.toBeNull();
    // Only pTax counted — pEmpty (zero positions) is skipped entirely.
    expect(r!.accountsSynced).toBe(1);

    const holdingsCount = db
      .prepare(`SELECT COUNT(*) AS c FROM holdings WHERE account_id = ?`)
      .get(rothId) as { c: number };
    expect(holdingsCount.c).toBe(0);

    const snap = db
      .prepare(`SELECT COUNT(*) AS c FROM monthly_snapshots WHERE account_id = ?`)
      .get(rothId) as { c: number };
    expect(snap.c).toBe(0);
  });
});
