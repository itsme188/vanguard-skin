/**
 * Plaid minors (backlog unit U22).
 *
 * 1. The manual sync route used one message for three different causes
 *    (credentials not set, not connected, a sync already running). The cause
 *    is now named: `plaidRefreshBlocker` is the single gate the refresh and
 *    the route both read, `plaidSyncUnavailableMessage` is the copy.
 * 2. A Plaid sync is a LIVE snapshot. It must leave statement-sourced bonds,
 *    funds and options exactly as the statement left them, mint no tombstone
 *    and no synthetic close a statement did not justify, and never move the
 *    tax-input generation. The last test pins that through the whole
 *    orchestrator, so a cleanup added to the Plaid path later has to answer
 *    to it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  refreshVanguardHoldingsFromPlaid,
  plaidRefreshBlocker,
  plaidSyncUnavailableMessage,
} from "@/lib/plaid/refresh";
import { setPlaidItem, setPlaidAccountMap } from "@/lib/queries/plaid-settings";
import type { PlaidClientConfig } from "@/lib/plaid/client";
import { todayET } from "@/lib/calendar/date-utils";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { RECON_HOLDING_SOURCE_PREFIX } from "@/lib/db/holding-sources";
import { setSyncPhase, setSyncError } from "@/lib/tws/sync-state";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// A weekday, non-holiday reference instant (Fri 2026-07-10 ~noon ET).
const NOW = new Date("2026-07-10T16:00:00.000Z");
const TODAY = todayET(NOW);
const STATEMENT_DATE = "2026-05-29";

function stubCfg(json: unknown): PlaidClientConfig {
  return {
    clientId: "cid",
    secret: "sec",
    env: "sandbox",
    redirectUri: null,
    fetchImpl: (async () =>
      new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  };
}

let db: Database.Database;
let taxableId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  taxableId = (
    db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as { id: number }
  ).id;
  // Release the module-level sync mutex a previous test may have left set.
  setSyncError("test reset");
});

describe("plaidRefreshBlocker — names why a Plaid sync cannot run", () => {
  it("credentials not set", () => {
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: taxableId });
    expect(plaidRefreshBlocker(db, null)).toBe("not_configured");
  });

  it("no Plaid item connected", () => {
    expect(plaidRefreshBlocker(db, stubCfg({}))).toBe("not_connected");
  });

  it("connected but no account mapped", () => {
    setPlaidItem(db, "access-1", "item-1");
    expect(plaidRefreshBlocker(db, stubCfg({}))).toBe("no_account_mapped");
  });

  it("another sync holds the mutex", () => {
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: taxableId });
    setSyncPhase("positions");
    try {
      expect(plaidRefreshBlocker(db, stubCfg({}))).toBe("sync_in_progress");
    } finally {
      setSyncError("test reset");
    }
  });

  it("nothing in the way", () => {
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: taxableId });
    expect(plaidRefreshBlocker(db, stubCfg({}))).toBeNull();
  });

  it("the refresh returns null for exactly the cases the blocker names", async () => {
    // not configured
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: taxableId });
    expect(await refreshVanguardHoldingsFromPlaid(db, { cfg: null, now: NOW, force: true })).toBeNull();
    // sync in progress
    setSyncPhase("positions");
    try {
      expect(
        await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg({}), now: NOW, force: true }),
      ).toBeNull();
    } finally {
      setSyncError("test reset");
    }
  });
});

describe("plaidSyncUnavailableMessage — one cause per message", () => {
  it("names the not-configured cause and the two settings to add", () => {
    const msg = plaidSyncUnavailableMessage("not_configured");
    expect(msg).toContain("PLAID_CLIENT_ID");
    expect(msg).toContain("PLAID_SECRET");
    expect(msg).not.toMatch(/already running/i);
  });

  it("each cause gets its own sentence, none blames two things", () => {
    const all = [
      plaidSyncUnavailableMessage("not_configured"),
      plaidSyncUnavailableMessage("not_connected"),
      plaidSyncUnavailableMessage("no_account_mapped"),
      plaidSyncUnavailableMessage("sync_in_progress"),
      plaidSyncUnavailableMessage(null),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(plaidSyncUnavailableMessage("not_connected")).toMatch(/not connected/i);
    expect(plaidSyncUnavailableMessage("not_connected")).not.toMatch(/already running/i);
    expect(plaidSyncUnavailableMessage("no_account_mapped")).toMatch(/mapp/i);
    expect(plaidSyncUnavailableMessage("sync_in_progress")).toMatch(/already running/i);
    expect(plaidSyncUnavailableMessage("sync_in_progress")).not.toMatch(/not connected/i);
    for (const m of all) expect(m.length).toBeGreaterThan(20);
  });

  it("the sync route builds its null message from the blocker, not a catch-all", () => {
    const src = readFileSync("app/api/plaid/sync/route.ts", "utf8");
    const nullBranch = anchorIndex(src, "result === null");
    const call = anchorIndex(src, "plaidSyncUnavailableMessage(plaidRefreshBlocker(db))", nullBranch);
    expect(call).toBeGreaterThan(nullBranch);
    expect(src).not.toContain("or a sync is already running");
  });
});

describe("a Plaid sync leaves the statement book alone", () => {
  function security(
    symbol: string,
    type: string,
    extra: { maturity?: string; expiration?: string; underlying?: string } = {},
  ): number {
    const id = Number(
      db
        .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)`)
        .run(symbol, symbol, type).lastInsertRowid,
    );
    if (extra.maturity) {
      db.prepare(`UPDATE securities SET maturity_date = ? WHERE id = ?`).run(extra.maturity, id);
    }
    if (extra.expiration) {
      db.prepare(
        `UPDATE securities SET expiration_date = ?, underlying_symbol = ?, option_type = 'PUT', strike_price = 10 WHERE id = ?`,
      ).run(extra.expiration, extra.underlying ?? null, id);
    }
    return id;
  }

  function statementHolding(securityId: number, quantity: number): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      taxableId,
      securityId,
      quantity,
      1000,
      STATEMENT_DATE,
      `vanguard-pdf:holding:${taxableId}:${securityId}:${STATEMENT_DATE}`,
    );
  }

  function statementRows(): unknown[] {
    return db
      .prepare(
        `SELECT account_id, security_id, quantity, cost_basis, as_of_date, source_key
           FROM holdings WHERE source_key LIKE 'vanguard-pdf:holding:%'
          ORDER BY security_id, as_of_date`,
      )
      .all();
  }

  it("bonds, funds and an expired option keep their statement rows; no tombstone, no synthetic close, no generation bump", async () => {
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: taxableId });

    // The statement book (synthetic): one stock Plaid also reports, a live
    // bond, a bill that has since matured, a mutual fund and an option that
    // has since expired. Plaid reports none of the last four.
    const stock = security("AAA", "Stock");
    const bond = security("BBB1", "Bond", { maturity: "2030-01-15" });
    const maturedBill = security("BBB2", "Bond", { maturity: "2026-06-15" });
    const fund = security("FFFAX", "Mutual Fund");
    const expiredOption = security("AAA   260619P00010000", "Option", {
      expiration: "2026-06-19",
      underlying: "AAA",
    });
    statementHolding(stock, 100);
    statementHolding(bond, 5000);
    statementHolding(maturedBill, 3000);
    statementHolding(fund, 250);
    statementHolding(expiredOption, 2);
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
       VALUES (?, ?, 50000, 1000, 'statement')`,
    ).run(taxableId, STATEMENT_DATE);

    const before = statementRows();
    expect(before).toHaveLength(5);
    const generationBefore = getTaxInputGeneration(db);

    const json = {
      accounts: [
        { account_id: "pTax", name: "Individual Brokerage", mask: "0000", subtype: "brokerage", balances: { current: 60000, available: null } },
      ],
      holdings: [
        { account_id: "pTax", security_id: "s1", quantity: 100, institution_price: 40, institution_value: 4000, institution_price_as_of: TODAY },
        { account_id: "pTax", security_id: "s2", quantity: 30, institution_price: 20, institution_value: 600, institution_price_as_of: TODAY },
      ],
      securities: [
        { security_id: "s1", ticker_symbol: "AAA", cusip: null, name: "AAA", type: "equity", is_cash_equivalent: false },
        { security_id: "s2", ticker_symbol: "ZZZ", cusip: null, name: "ZZZ", type: "equity", is_cash_equivalent: false },
      ],
    };

    const r = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(json), now: NOW, force: true });
    expect(r).not.toBeNull();
    expect(r!.holdingsWritten).toBe(2);

    // Every statement row is byte-identical: nothing deleted, nothing edited.
    expect(statementRows()).toEqual(before);

    // The only new holdings rows are the two Plaid stock rows.
    const added = db
      .prepare(
        `SELECT s.symbol, h.quantity, h.source_key FROM holdings h
           JOIN securities s ON s.id = h.security_id
          WHERE h.source_key NOT LIKE 'vanguard-pdf:holding:%' ORDER BY s.symbol`,
      )
      .all() as { symbol: string; quantity: number; source_key: string }[];
    expect(added.map((a) => a.symbol)).toEqual(["AAA", "ZZZ"]);
    expect(added.every((a) => a.source_key.startsWith("plaid:"))).toBe(true);

    // No tombstone of any origin, and no zero row on a bond, fund or option.
    const tombstones = db
      .prepare(`SELECT COUNT(*) AS n FROM holdings WHERE source_key LIKE ? OR quantity = 0`)
      .get(`${RECON_HOLDING_SOURCE_PREFIX}%`) as { n: number };
    expect(tombstones.n).toBe(0);

    // No synthetic close and no realized sale came out of a live snapshot.
    const closes = db
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE type = 'RECONCILE_CLOSE'`)
      .get() as { n: number };
    expect(closes.n).toBe(0);
    const sales = db.prepare(`SELECT COUNT(*) AS n FROM tax_lot_sales`).get() as { n: number };
    expect(sales.n).toBe(0);

    // A live-only write is not a tax input.
    expect(getTaxInputGeneration(db)).toBe(generationBefore);

    // The statement snapshot row is still the statement's.
    const snap = db
      .prepare(`SELECT total_value, source FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?`)
      .get(taxableId, STATEMENT_DATE) as { total_value: number; source: string };
    expect(snap).toEqual({ total_value: 50000, source: "statement" });
  });
});
