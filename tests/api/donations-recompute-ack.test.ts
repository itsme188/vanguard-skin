/**
 * The disclose-and-confirm contract on every donation route that recomputes
 * the whole tax-lot ledger:
 *   - without the acknowledgement flag the route refuses (409 + a census of
 *     what a recompute would touch) and changes NOTHING;
 *   - with it, the mutation and the recompute run and the reported
 *     before/after counts equal what the database holds;
 *   - a recompute that throws half-way rolls back as a whole and is reported
 *     as saved-but-not-recomputed with an unchanged census.
 *
 * Real code path throughout: the real routes, the real mutations and the real
 * `computeTaxLots` on an in-memory database. The half-way failure is a real
 * SQLite trigger that aborts the engine's first sale insert, not a stand-in.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { linkDonationLegs } from "@/lib/mutations/donation-links";
import { insertDonation } from "@/lib/mutations/donations";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getLedgerCensus } from "@/lib/compute/donation-recompute";
import { getTaxConventionState, stampBrokerAcceptance } from "@/lib/compute/tax-convention";
import {
  LEDGER_RECOMPUTE_ACK_FIELD,
  LEDGER_RECOMPUTE_UNACKNOWLEDGED,
} from "@/lib/compute/donation-recompute-contract";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function accountId(db: Database.Database): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
}

function seedSecurity(db: Database.Database, symbol: string): number {
  return db.prepare("INSERT INTO securities (symbol, currency) VALUES (?, 'USD')").run(symbol)
    .lastInsertRowid as number;
}

let seq = 0;
function txn(
  db: Database.Database,
  acct: number,
  sec: number,
  date: string,
  type: string,
  qty: number,
  price: number
): number {
  seq++;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(acct, sec, date, type, qty, price, qty * price, `ack-txn-${seq}`).lastInsertRowid as number;
}

function donation(db: Database.Database, sec: number | null, date: string, quantity: number): number {
  seq++;
  return insertDonation(
    db,
    {
      sourceKey: `ack-don-${seq}`,
      kind: "stock",
      securityId: sec,
      symbolRaw: "ZZAA",
      quantity,
      fmvUsd: 2000,
      unitValuation: null,
      createdDate: null,
      receivedDate: date,
      completedDate: null,
      notes: null,
    },
    null
  );
}

/** A book with a real closed sale, an open lot and a linked, unassigned donation. */
function seedBook(db: Database.Database) {
  const acct = accountId(db);
  const sec = seedSecurity(db, "ZZAA");
  const other = seedSecurity(db, "ZZBB");
  const buyId = txn(db, acct, sec, "2026-01-05", "BUY", 100, 10);
  txn(db, acct, other, "2026-01-06", "BUY", 50, 20);
  txn(db, acct, other, "2026-02-06", "SELL", 20, 30);
  const outTxnId = txn(db, acct, sec, "2026-03-02", "TRANSFER_OUT", 40, 0);
  const donationId = donation(db, sec, "2026-03-02", 40);
  linkDonationLegs(db, { donationId, outTransactionId: outTxnId });
  computeTaxLots(db);
  return { acct, sec, other, buyId, outTxnId, donationId };
}

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

/** Every row of every table a donation route or the engine may write. */
function fingerprint(db: Database.Database): string {
  const tables = [
    "donations",
    "donation_leg_links",
    "donation_lots",
    "tax_lots",
    "tax_lot_sales",
    "transactions",
    "settings",
  ];
  return JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
}

function realCounts(db: Database.Database) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    closedSales: n("SELECT COUNT(*) AS n FROM tax_lot_sales"),
    openLots: n("SELECT COUNT(*) AS n FROM tax_lots WHERE quantity_remaining > 0"),
    engineCloses: n("SELECT COUNT(*) AS n FROM transactions WHERE type = 'RECONCILE_CLOSE'"),
  };
}

interface Refusal {
  success: boolean;
  error: string;
  code: string;
  data: { ledger: { closedSales: number; openLots: number; engineCloses: number }; acceptedTaxYearsAffected: number };
}

async function expectRefused(res: Response, db: Database.Database, before: string) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as Refusal;
  expect(body.success).toBe(false);
  expect(body.code).toBe(LEDGER_RECOMPUTE_UNACKNOWLEDGED);
  expect(body.error).toMatch(/entire tax-lot ledger/);
  expect(body.data.ledger).toEqual(realCounts(db));
  expect(body.data.acceptedTaxYearsAffected).toBe(0);
  // Nothing moved: not the mutation, not the ledger, not the tax generation.
  expect(fingerprint(db)).toBe(before);
}

describe("donation routes refuse to recompute without the acknowledgement", () => {
  it("POST lots: refused, nothing written, census returned", async () => {
    const db = hoisted.db;
    const { donationId, buyId } = seedBook(db);
    const before = fingerprint(db);
    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
      }),
      ctx(donationId)
    );
    await expectRefused(res, db, before);
    expect(realCounts(db).closedSales).toBe(1);
  });

  it("POST lots: a non-true flag (string, 1, null) is not an acknowledgement", async () => {
    const db = hoisted.db;
    const { donationId, buyId } = seedBook(db);
    const mod = await import("@/app/api/donations/[id]/lots/route");
    for (const flag of ["true", 1, null, false, {}]) {
      const before = fingerprint(db);
      const res = await mod.POST(
        req(`http://test/api/donations/${donationId}/lots`, "POST", {
          assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
          [LEDGER_RECOMPUTE_ACK_FIELD]: flag,
        }),
        ctx(donationId)
      );
      await expectRefused(res, db, before);
    }
  });

  it("POST links: refused, the leg stays unlinked", async () => {
    const db = hoisted.db;
    const { acct, sec } = seedBook(db);
    const outTxnId = txn(db, acct, sec, "2026-04-01", "TRANSFER_OUT", 10, 0);
    const donationId = donation(db, sec, "2026-04-01", 10);
    const before = fingerprint(db);
    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/links`, "POST", { outTransactionId: outTxnId }),
      ctx(donationId)
    );
    await expectRefused(res, db, before);
  });

  it("DELETE links: refused with no body, with an empty body and with a non-JSON body", async () => {
    const db = hoisted.db;
    const { donationId } = seedBook(db);
    const mod = await import("@/app/api/donations/[id]/links/route");
    const before = fingerprint(db);
    const url = `http://test/api/donations/${donationId}/links`;
    await expectRefused(await mod.DELETE(req(url, "DELETE"), ctx(donationId)), db, before);
    await expectRefused(await mod.DELETE(req(url, "DELETE", {}), ctx(donationId)), db, before);
    await expectRefused(
      await mod.DELETE(new NextRequest(url, { method: "DELETE", body: "not json" }), ctx(donationId)),
      db,
      before
    );
  });

  it("POST reverse: refused, the donation stays live", async () => {
    const db = hoisted.db;
    const { donationId } = seedBook(db);
    const before = fingerprint(db);
    const mod = await import("@/app/api/donations/[id]/reverse/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/reverse`, "POST", { reversedDate: "2026-05-01" }),
      ctx(donationId)
    );
    await expectRefused(res, db, before);
  });

  it("POST resolve-security: refused, the donation stays unresolved", async () => {
    const db = hoisted.db;
    const { sec } = seedBook(db);
    const donationId = donation(db, null, "2026-04-01", 10);
    const before = fingerprint(db);
    const mod = await import("@/app/api/donations/[id]/resolve-security/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/resolve-security`, "POST", { securityId: sec }),
      ctx(donationId)
    );
    await expectRefused(res, db, before);
  });

  it("a malformed request is still a 400, not a confirmation prompt", async () => {
    const db = hoisted.db;
    const { donationId } = seedBook(db);
    const lots = await import("@/app/api/donations/[id]/lots/route");
    const res = await lots.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", { assignments: "nope" }),
      ctx(donationId)
    );
    expect(res.status).toBe(400);
  });

  it("a JSON body that is not an object (null, a number, an array, text) is a 400 on every POST, never a crash", async () => {
    const db = hoisted.db;
    const { donationId } = seedBook(db);
    const before = fingerprint(db);
    const routes = [
      ["lots", await import("@/app/api/donations/[id]/lots/route")],
      ["links", await import("@/app/api/donations/[id]/links/route")],
      ["reverse", await import("@/app/api/donations/[id]/reverse/route")],
      ["resolve-security", await import("@/app/api/donations/[id]/resolve-security/route")],
    ] as const;
    for (const [name, mod] of routes) {
      for (const raw of ["null", "7", "[true]", '"text"', "not json", ""]) {
        const res = await mod.POST(
          new NextRequest(`http://test/api/donations/${donationId}/${name}`, { method: "POST", body: raw }),
          ctx(donationId)
        );
        expect(res.status, `${name} ${raw}`).toBe(400);
      }
    }
    expect(fingerprint(db)).toBe(before);
  });

  it("clearing assignments (an empty list) is gated like any other save", async () => {
    const db = hoisted.db;
    const { donationId, buyId } = seedBook(db);
    const mod = await import("@/app/api/donations/[id]/lots/route");
    await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    const before = fingerprint(db);
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", { assignments: [] }),
      ctx(donationId)
    );
    await expectRefused(res, db, before);
  });
});

interface Confirmed {
  success: boolean;
  data: {
    saved: boolean;
    recomputed: boolean;
    recomputeError?: string;
    ledger: {
      before: { closedSales: number; openLots: number; engineCloses: number };
      after: { closedSales: number; openLots: number; engineCloses: number };
      saleRowsAddedOrChanged: number;
      saleRowsRemovedOrChanged: number;
      openLotsChanged: number;
    };
  };
}

describe("an acknowledged donation mutation recomputes and reports what moved", () => {
  it("POST lots: counts before and after equal the database", async () => {
    const db = hoisted.db;
    const { donationId, buyId } = seedBook(db);
    const before = realCounts(db);
    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Confirmed;
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(true);
    expect(body.data.ledger.before).toEqual(before);
    expect(body.data.ledger.after).toEqual(realCounts(db));
    expect(body.data.ledger.after).toEqual(getLedgerCensus(db));
    // The one real sale is rebuilt identically: nothing about it changed.
    expect(body.data.ledger.saleRowsAddedOrChanged).toBe(0);
    expect(body.data.ledger.saleRowsRemovedOrChanged).toBe(0);
    const lot = db
      .prepare("SELECT quantity_remaining FROM tax_lots WHERE acquisition_transaction_id = ?")
      .get(buyId) as { quantity_remaining: number };
    expect(lot.quantity_remaining).toBeCloseTo(60);
  });

  it("reports a sale whose lot matching changed, and an open lot that closed", async () => {
    const db = hoisted.db;
    const acct = accountId(db);
    const sec = seedSecurity(db, "ZZCC");
    // Two lots; FIFO sells the first. Donating the WHOLE first lot ahead of
    // the sale moves the sale onto the second lot.
    const first = txn(db, acct, sec, "2026-01-05", "BUY", 10, 10);
    txn(db, acct, sec, "2026-01-20", "BUY", 10, 30);
    const outTxnId = txn(db, acct, sec, "2026-02-02", "TRANSFER_OUT", 10, 0);
    txn(db, acct, sec, "2026-03-02", "SELL", 10, 50);
    const donationId = donation(db, sec, "2026-02-02", 10);
    linkDonationLegs(db, { donationId, outTransactionId: outTxnId });
    computeTaxLots(db);
    expect(realCounts(db)).toEqual({ closedSales: 1, openLots: 1, engineCloses: 0 });

    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: first, quantity: 10 }],
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    const body = (await res.json()) as Confirmed;
    expect(body.data.recomputed).toBe(true);
    expect(body.data.ledger.before).toEqual({ closedSales: 1, openLots: 1, engineCloses: 0 });
    expect(body.data.ledger.after).toEqual(realCounts(db));
    expect(body.data.ledger.after.openLots).toBe(0);
    // Same row count, but the sale now closes a different lot at a different basis.
    expect(body.data.ledger.after.closedSales).toBe(1);
    expect(body.data.ledger.saleRowsAddedOrChanged).toBe(1);
    expect(body.data.ledger.saleRowsRemovedOrChanged).toBe(1);
  });

  it("DELETE links with the flag in the body unlinks and reports", async () => {
    const db = hoisted.db;
    const { donationId } = seedBook(db);
    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.DELETE(
      req(`http://test/api/donations/${donationId}/links`, "DELETE", { [LEDGER_RECOMPUTE_ACK_FIELD]: true }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Confirmed;
    expect(body.data.recomputed).toBe(true);
    expect(body.data.ledger.after).toEqual(realCounts(db));
    const links = db.prepare("SELECT COUNT(*) AS n FROM donation_leg_links").get() as { n: number };
    expect(links.n).toBe(0);
  });

  it("POST reverse and POST resolve-security run with the flag", async () => {
    const db = hoisted.db;
    const { donationId, sec } = seedBook(db);
    const reverse = await import("@/app/api/donations/[id]/reverse/route");
    const r1 = await reverse.POST(
      req(`http://test/api/donations/${donationId}/reverse`, "POST", {
        reversedDate: "2026-05-01",
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as Confirmed).data.ledger.after).toEqual(realCounts(db));

    const unresolved = donation(db, null, "2026-04-01", 10);
    const resolve = await import("@/app/api/donations/[id]/resolve-security/route");
    const r2 = await resolve.POST(
      req(`http://test/api/donations/${unresolved}/resolve-security`, "POST", {
        securityId: sec,
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(unresolved)
    );
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as Confirmed).data.ledger.after).toEqual(realCounts(db));
  });

  it("an empty book (no lots, no sales) reports zeros, not an error", async () => {
    const db = hoisted.db;
    const acct = accountId(db);
    const sec = seedSecurity(db, "ZZDD");
    const outTxnId = txn(db, acct, sec, "2026-04-01", "TRANSFER_OUT", 10, 0);
    const donationId = donation(db, sec, "2026-04-01", 10);
    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/links`, "POST", {
        outTransactionId: outTxnId,
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    const body = (await res.json()) as Confirmed;
    expect(body.data.recomputed).toBe(true);
    expect(body.data.ledger.before).toEqual({ closedSales: 0, openLots: 0, engineCloses: 0 });
    expect(body.data.ledger.after).toEqual({ closedSales: 0, openLots: 0, engineCloses: 0 });
  });

  it("an open SHORT lot counts as an open lot", async () => {
    const db = hoisted.db;
    const { acct, donationId, buyId } = seedBook(db);
    const shortSec = seedSecurity(db, "ZZEE");
    txn(db, acct, shortSec, "2026-01-10", "SHORT_SELL", 5, 40);
    computeTaxLots(db);
    const shortLots = db.prepare("SELECT COUNT(*) AS n FROM tax_lots WHERE is_short = 1").get() as { n: number };
    expect(shortLots.n).toBe(1);
    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    const body = (await res.json()) as Confirmed;
    expect(body.data.ledger.after).toEqual(realCounts(db));
    expect(body.data.ledger.after.openLots).toBe(3);
  });

  it("a second identical confirmed request is a clean no-op report", async () => {
    const db = hoisted.db;
    const { donationId, buyId } = seedBook(db);
    const mod = await import("@/app/api/donations/[id]/lots/route");
    const send = () =>
      mod.POST(
        req(`http://test/api/donations/${donationId}/lots`, "POST", {
          assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
          [LEDGER_RECOMPUTE_ACK_FIELD]: true,
        }),
        ctx(donationId)
      );
    await send();
    const second = (await (await send()).json()) as Confirmed;
    expect(second.data.recomputed).toBe(true);
    expect(second.data.ledger.before).toEqual(second.data.ledger.after);
    expect(second.data.ledger.saleRowsAddedOrChanged).toBe(0);
    expect(second.data.ledger.saleRowsRemovedOrChanged).toBe(0);
    const assigned = db.prepare("SELECT COUNT(*) AS n FROM donation_lots").get() as { n: number };
    expect(assigned.n).toBe(1);
  });
});

describe("a recompute that throws half-way", () => {
  it("keeps the saved mutation, rolls the ledger back whole and says so", async () => {
    const db = hoisted.db;
    const { donationId, buyId } = seedBook(db);
    const before = realCounts(db);
    const lotsBefore = JSON.stringify(db.prepare("SELECT * FROM tax_lots ORDER BY id").all());
    const salesBefore = JSON.stringify(db.prepare("SELECT * FROM tax_lot_sales ORDER BY id").all());
    // The engine has already deleted every lot and sale when its first sale
    // insert hits this trigger.
    db.exec(
      `CREATE TRIGGER ack_boom BEFORE INSERT ON tax_lot_sales
       BEGIN SELECT RAISE(ABORT, 'engine boom'); END`
    );

    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Confirmed;
    expect(body.success).toBe(true);
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(false);
    expect(body.data.recomputeError).toContain("engine boom");
    expect(body.data.ledger.before).toEqual(before);
    expect(body.data.ledger.after).toEqual(before);
    expect(body.data.ledger.saleRowsAddedOrChanged).toBe(0);
    expect(body.data.ledger.saleRowsRemovedOrChanged).toBe(0);
    // The ledger is byte-for-byte what it was; the assignment itself is saved.
    expect(JSON.stringify(db.prepare("SELECT * FROM tax_lots ORDER BY id").all())).toBe(lotsBefore);
    expect(JSON.stringify(db.prepare("SELECT * FROM tax_lot_sales ORDER BY id").all())).toBe(salesBefore);
    const assigned = db.prepare("SELECT COUNT(*) AS n FROM donation_lots").get() as { n: number };
    expect(assigned.n).toBe(1);

    // A retry once the fault is gone recomputes normally.
    db.exec("DROP TRIGGER ack_boom");
    const retry = await mod.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(donationId)
    );
    expect(((await retry.json()) as Confirmed).data.recomputed).toBe(true);
  });
});

describe("every route reaches its mutation only through the rehearse-or-apply gate", () => {
  it("no donation route calls a mutation outside the gate, or the recompute before the refusal", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { anchorIndex } = await import("../helpers/source-anchor");
    const base = path.join(process.cwd(), "app/api/donations/[id]");
    const handlers: [string, string, string][] = [
      ["lots/route.ts", "export async function POST", "assignDonationLots(db"],
      ["links/route.ts", "export async function POST", "linkDonationLegs(db"],
      ["links/route.ts", "export async function DELETE", "unlinkDonationLegs(db"],
      ["reverse/route.ts", "export async function POST", "markDonationReversed(db"],
      ["resolve-security/route.ts", "export async function POST", "resolveDonationSecurity(db"],
    ];
    for (const [file, handler, mutation] of handlers) {
      const src = fs.readFileSync(path.join(base, file), "utf8");
      const start = anchorIndex(src, handler, 0, `${file} handler`);
      const flag = anchorIndex(src, "const acknowledged = isLedgerRecomputeAcknowledged(body);", start, `${file} flag`);
      const gate = anchorIndex(src, "applyOrRehearse(db, acknowledged, () => {", flag, `${file} gate`);
      const mutate = anchorIndex(src, mutation, start, `${file} mutation`);
      const refusal = anchorIndex(src, "if (!acknowledged) return ledgerRecomputeRefusal(db,", gate, `${file} refusal`);
      const recompute = anchorIndex(src, "recomputeAfterDonationMutation(db", start, `${file} recompute`);
      // The mutation is the first statement inside the gate's callback...
      expect(src.slice(gate, mutate).trim(), `${file} ${handler}`).toBe("applyOrRehearse(db, acknowledged, () => {");
      // ...and the recompute is only reachable past the refusal.
      expect(mutate).toBeLessThan(refusal);
      expect(refusal).toBeLessThan(recompute);
      // The mutation is called exactly once per handler (one import + one call per mutation name).
      const calls = src.match(new RegExp(`\\b${mutation.replace("(", "\\(")}`, "g")) ?? [];
      expect(calls.length, `${file} ${mutation} calls`).toBe(1);
    }
  });
});

describe("validation comes before the confirm prompt", () => {
  it("a missing donation is a 400 on every route, with or without the flag, and nothing is written", async () => {
    const db = hoisted.db;
    const { sec, buyId } = seedBook(db);
    const before = fingerprint(db);
    const lots = await import("@/app/api/donations/[id]/lots/route");
    const links = await import("@/app/api/donations/[id]/links/route");
    const reverse = await import("@/app/api/donations/[id]/reverse/route");
    const resolve = await import("@/app/api/donations/[id]/resolve-security/route");
    const url = (name: string) => `http://test/api/donations/999999/${name}`;
    const calls: [string, () => Response | Promise<Response>][] = [
      ["lots", () => lots.POST(req(url("lots"), "POST", { assignments: [{ acquisitionTransactionId: buyId, quantity: 1 }] }), ctx(999999))],
      ["links POST", () => links.POST(req(url("links"), "POST", { outTransactionId: 1 }), ctx(999999))],
      ["links DELETE", () => links.DELETE(req(url("links"), "DELETE"), ctx(999999))],
      ["reverse", () => reverse.POST(req(url("reverse"), "POST", { reversedDate: "2026-05-01" }), ctx(999999))],
      ["resolve", () => resolve.POST(req(url("resolve-security"), "POST", { securityId: sec }), ctx(999999))],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      const body = (await res.json()) as { success: boolean; code?: string };
      expect(res.status, name).toBe(400);
      expect(body.code, name).toBeUndefined();
    }
    expect(fingerprint(db)).toBe(before);
  });

  it("a change that could not be saved is rejected with its own reason before any prompt", async () => {
    const db = hoisted.db;
    const { acct, sec, donationId, buyId } = seedBook(db);
    const before = fingerprint(db);
    const lots = await import("@/app/api/donations/[id]/lots/route");
    // An unknown lot, and more shares than the gift holds.
    for (const assignments of [
      [{ acquisitionTransactionId: 999999, quantity: 40 }],
      [{ acquisitionTransactionId: buyId, quantity: 41 }],
    ]) {
      const res = await lots.POST(req(`http://test/api/donations/${donationId}/lots`, "POST", { assignments }), ctx(donationId));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBeUndefined();
    }
    // Re-linking an already linked donation: the existing 409, not the prompt.
    const secondOut = txn(db, acct, sec, "2026-03-03", "TRANSFER_OUT", 40, 0);
    const beforeLink = fingerprint(db);
    const links = await import("@/app/api/donations/[id]/links/route");
    const res = await links.POST(
      req(`http://test/api/donations/${donationId}/links`, "POST", { outTransactionId: secondOut }),
      ctx(donationId)
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error: string };
    expect(body.code).toBeUndefined();
    expect(body.error).toContain("already linked");
    expect(fingerprint(db)).toBe(beforeLink);
    expect(beforeLink).not.toBe(before); // only the seeded second leg differs
  });
});

describe("a gift re-pointed to another lot is reported as a change", () => {
  it("60 shares moved from lot 1 to lot 2: every count is equal, two open lots changed", async () => {
    const db = hoisted.db;
    const acct = accountId(db);
    const sec = seedSecurity(db, "ZZFF");
    const lot1 = txn(db, acct, sec, "2026-01-05", "BUY", 100, 10);
    const lot2 = txn(db, acct, sec, "2026-01-20", "BUY", 100, 30);
    const outTxnId = txn(db, acct, sec, "2026-03-02", "TRANSFER_OUT", 60, 0);
    const donationId = donation(db, sec, "2026-03-02", 60);
    linkDonationLegs(db, { donationId, outTransactionId: outTxnId });
    computeTaxLots(db);
    const mod = await import("@/app/api/donations/[id]/lots/route");
    const save = async (lot: number) =>
      (await (
        await mod.POST(
          req(`http://test/api/donations/${donationId}/lots`, "POST", {
            assignments: [{ acquisitionTransactionId: lot, quantity: 60 }],
            [LEDGER_RECOMPUTE_ACK_FIELD]: true,
          }),
          ctx(donationId)
        )
      ).json()) as Confirmed;
    const remaining = () =>
      db.prepare("SELECT quantity_remaining AS q FROM tax_lots ORDER BY acquisition_date").all().map((r) => (r as { q: number }).q);

    const first = await save(lot1);
    expect(remaining()).toEqual([40, 100]);
    expect(first.data.ledger.openLotsChanged).toBe(1);

    const moved = await save(lot2);
    expect(remaining()).toEqual([100, 40]);
    expect(moved.data.recomputed).toBe(true);
    expect(moved.data.ledger.before).toEqual(moved.data.ledger.after);
    expect(moved.data.ledger.saleRowsAddedOrChanged).toBe(0);
    expect(moved.data.ledger.saleRowsRemovedOrChanged).toBe(0);
    expect(moved.data.ledger.openLotsChanged).toBe(2);

    // Saving the same thing again really is "nothing moved".
    const same = await save(lot2);
    expect(same.data.ledger.openLotsChanged).toBe(0);
  });
});

describe("accepted tax years", () => {
  it("the prompt counts them, a confirmed edit un-accepts them, and resolve-security does neither", async () => {
    const db = hoisted.db;
    const { acct, sec, donationId, buyId } = seedBook(db);
    const unresolved = donation(db, null, "2026-04-01", 10);
    stampBrokerAcceptance(db, [
      { accountId: acct, taxYear: 2025 },
      { accountId: acct, taxYear: 2026 },
    ]);
    expect(getTaxConventionState(db).acceptance.current).toBe(true);
    const before = fingerprint(db);

    const lots = await import("@/app/api/donations/[id]/lots/route");
    const resolve = await import("@/app/api/donations/[id]/resolve-security/route");
    const lotsBody = { assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }] };

    const asked = await lots.POST(req(`http://test/api/donations/${donationId}/lots`, "POST", lotsBody), ctx(donationId));
    expect(((await asked.json()) as Refusal).data.acceptedTaxYearsAffected).toBe(2);
    // The rehearsal bumped nothing: still accepted, nothing written.
    expect(fingerprint(db)).toBe(before);
    expect(getTaxConventionState(db).acceptance.current).toBe(true);

    // resolve-security does not move the tax input generation: no years at stake.
    const askedResolve = await resolve.POST(
      req(`http://test/api/donations/${unresolved}/resolve-security`, "POST", { securityId: sec }),
      ctx(unresolved)
    );
    expect(((await askedResolve.json()) as Refusal).data.acceptedTaxYearsAffected).toBe(0);
    const resolved = await resolve.POST(
      req(`http://test/api/donations/${unresolved}/resolve-security`, "POST", {
        securityId: sec,
        [LEDGER_RECOMPUTE_ACK_FIELD]: true,
      }),
      ctx(unresolved)
    );
    expect(resolved.status).toBe(200);
    expect(getTaxConventionState(db).acceptance.current).toBe(true);

    const saved = await lots.POST(
      req(`http://test/api/donations/${donationId}/lots`, "POST", { ...lotsBody, [LEDGER_RECOMPUTE_ACK_FIELD]: true }),
      ctx(donationId)
    );
    expect(saved.status).toBe(200);
    expect(getTaxConventionState(db).acceptance.current).toBe(false);
    // Nothing accepted any more: a later prompt has nothing to warn about.
    const later = await lots.POST(req(`http://test/api/donations/${donationId}/lots`, "POST", lotsBody), ctx(donationId));
    expect(((await later.json()) as Refusal).data.acceptedTaxYearsAffected).toBe(0);
  });
});
