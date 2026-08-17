/**
 * HTTP-boundary tests for the Task 12 donation-tracking routes:
 *   - GET  /api/donations                        (giving view assembly)
 *   - POST/DELETE /api/donations/:id/links        (confirm/undo leg link)
 *   - GET/POST    /api/donations/:id/lots         (drawer listing / assign)
 *   - POST /api/donations/:id/reverse             (mark reversed)
 *   - POST /api/donations/:id/resolve-security    (one-time symbol fix)
 *
 * Pattern copied from tests/api/corporate-actions-route.test.ts /
 * tests/api/levels-route.test.ts: mock @/lib/db with a hoisted in-memory
 * database, import the route module fresh per call, drive the exported
 * handlers directly with NextRequest + a resolved `params` promise.
 *
 * lib/compute/tax-lots is mocked so `computeTaxLots` can be made to throw
 * on demand (the recompute-failure feedback path) while `isLongTermHolding`
 * (used by lib/queries/giving-view.ts) stays the real implementation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { linkDonationLegs, assignDonationLots } from "@/lib/mutations/donation-links";
import { insertDonation } from "@/lib/mutations/donations";
import { computeTaxLots, isLongTermHolding } from "@/lib/compute/tax-lots";
import { getGivingView } from "@/lib/queries/giving-view";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/compute/tax-lots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/tax-lots")>();
  return { ...actual, computeTaxLots: vi.fn(actual.computeTaxLots) };
});

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.mocked(computeTaxLots).mockClear();
});

// ── Seeding helpers (migration 002 seeds accounts 'Vanguard Taxable',
// 'Vanguard Roth IRA', 'IBKR' — reuse 'IBKR') ──────────────────────────────

function ibkrAccountId(db: Database.Database): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
}

function seedSecurity(db: Database.Database, symbol: string, currency = "USD"): number {
  return db
    .prepare("INSERT INTO securities (symbol, currency) VALUES (?, ?)")
    .run(symbol, currency).lastInsertRowid as number;
}

let txnSeq = 0;
function insertTxn(
  db: Database.Database,
  accountId: number,
  secId: number,
  date: string,
  type: string,
  qty: number,
  price: number
): number {
  txnSeq++;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(accountId, secId, date, type, qty, price, qty * price, `txn-${txnSeq}`).lastInsertRowid as number;
}

let donationSeq = 0;
/** Seeds a stock donation + linked OUT leg (spec §7 confirmed half). */
function seedLinkedDonation(
  db: Database.Database,
  opts: { accountId: number; secId: number; date: string; quantity: number; fmvUsd?: number }
): { donationId: number; outTxnId: number } {
  donationSeq++;
  const outTxnId = insertTxn(db, opts.accountId, opts.secId, opts.date, "TRANSFER_OUT", opts.quantity, 0);
  const donationId = insertDonation(
    db,
    {
      sourceKey: `daf:donation:${donationSeq}`,
      kind: "stock",
      securityId: opts.secId,
      symbolRaw: "AAAA",
      quantity: opts.quantity,
      fmvUsd: opts.fmvUsd ?? 1000,
      unitValuation: null,
      createdDate: null,
      receivedDate: opts.date,
      completedDate: null,
      notes: null,
    },
    null
  );
  linkDonationLegs(db, { donationId, outTransactionId: outTxnId });
  return { donationId, outTxnId };
}

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function ctx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

// ── GET /api/donations ─────────────────────────────────────────────────────

describe("GET /api/donations", () => {
  it("returns the giving view assembly (years + reconciliation)", async () => {
    const db = hoisted.db;
    insertDonation(
      db,
      {
        sourceKey: "d1",
        kind: "cash",
        securityId: null,
        symbolRaw: null,
        quantity: null,
        fmvUsd: 500,
        unitValuation: null,
        createdDate: null,
        receivedDate: "2026-03-01",
        completedDate: null,
        notes: null,
      },
      null
    );

    const mod = await import("@/app/api/donations/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { years: { year: string; totalGiven: number }[]; reconciliation: unknown } };
    expect(body.success).toBe(true);
    expect(body.data.years).toHaveLength(1);
    expect(body.data.years[0].year).toBe("2026");
    expect(body.data.years[0].totalGiven).toBeCloseTo(500);
    expect(body.data.reconciliation).toBeDefined();
  });
});

// ── POST/DELETE /api/donations/:id/links ────────────────────────────────────

describe("POST /api/donations/:id/links", () => {
  it("happy path: confirms the OUT leg and recomputes", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    insertTxn(db, acct, sec, "2026-06-01", "BUY", 100, 400);
    const outTxnId = insertTxn(db, acct, sec, "2026-07-01", "TRANSFER_OUT", 40, 0);
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: sec, symbolRaw: "AAAA", quantity: 40,
        fmvUsd: 2000, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/links`, "POST", { outTransactionId: outTxnId }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { saved: boolean; recomputed: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(true);

    const linked = db
      .prepare("SELECT COUNT(*) AS n FROM donation_leg_links WHERE donation_id = ? AND role = 'out'")
      .get(donationId) as { n: number };
    expect(linked.n).toBe(1);
  });

  it("invariant violation -> 400 carrying the DonationLinkError message", async () => {
    const db = hoisted.db;
    const sec = seedSecurity(db, "AAAA");
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: sec, symbolRaw: "AAAA", quantity: 40,
        fmvUsd: 2000, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/links`, "POST", { outTransactionId: 999999 }),
      ctx(donationId)
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain(`donation ${donationId}`);
    expect(body.error).toContain("not found");
  });

  it("re-linking an already out-linked donation -> 409 (raw SqliteError translated)", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });
    // A second, itself-unlinked TRANSFER_OUT of the same qty/security — passes
    // linkDonationLegs' own "transaction already linked" guard (which only
    // checks the incoming transaction id) but collides with the donation's
    // partial-unique out-link index on insert.
    const secondOutTxnId = insertTxn(db, acct, sec, "2026-07-02", "TRANSFER_OUT", 40, 0);

    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/links`, "POST", { outTransactionId: secondOutTxnId }),
      ctx(donationId)
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("already linked");
  });

  it("recompute-failure path: saved:true, recomputed:false, recomputeError set (never a 500)", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const outTxnId = insertTxn(db, acct, sec, "2026-07-01", "TRANSFER_OUT", 40, 0);
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: sec, symbolRaw: "AAAA", quantity: 40,
        fmvUsd: 2000, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    vi.mocked(computeTaxLots).mockImplementationOnce(() => {
      throw new Error("recompute boom");
    });

    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/links`, "POST", { outTransactionId: outTxnId }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { saved: boolean; recomputed: boolean; recomputeError?: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(false);
    expect(body.data.recomputeError).toContain("recompute boom");

    // The link itself WAS saved despite the recompute failure.
    const linked = db
      .prepare("SELECT COUNT(*) AS n FROM donation_leg_links WHERE donation_id = ?")
      .get(donationId) as { n: number };
    expect(linked.n).toBeGreaterThan(0);
  });
});

describe("DELETE /api/donations/:id/links", () => {
  it("happy path: unlinks and recomputes", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });

    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.DELETE(
      jsonReq(`http://test/api/donations/${donationId}/links`, "DELETE"),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { saved: boolean; recomputed: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(true);

    const linked = db
      .prepare("SELECT COUNT(*) AS n FROM donation_leg_links WHERE donation_id = ?")
      .get(donationId) as { n: number };
    expect(linked.n).toBe(0);
  });
});

// ── GET/POST /api/donations/:id/lots ────────────────────────────────────────

describe("GET /api/donations/:id/lots", () => {
  it("happy path: lists open lots as of the donation's OUT-leg date", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const buyId = insertTxn(db, acct, sec, "2026-06-01", "BUY", 100, 400);
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40, fmvUsd: 2000 });
    computeTaxLots(db);

    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.GET(
      jsonReq(`http://test/api/donations/${donationId}/lots`, "GET"),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { lots: { acquisitionTransactionId: number; remainingAsOfDonationDate: number; suggested: boolean; currentlyAssignedQuantity: number }[] } };
    expect(body.success).toBe(true);
    expect(body.data.lots).toHaveLength(1);
    expect(body.data.lots[0].acquisitionTransactionId).toBe(buyId);
    expect(body.data.lots[0].remainingAsOfDonationDate).toBeCloseTo(100);
    expect(body.data.lots[0].suggested).toBe(true);
    // No assignments yet — currentlyAssignedQuantity is 0, not the suggested amount.
    expect(body.data.lots[0].currentlyAssignedQuantity).toBe(0);
  });

  it("reflects this donation's own current per-lot assignment (drawer pre-fill)", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const buyId = insertTxn(db, acct, sec, "2026-06-01", "BUY", 100, 400);
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40, fmvUsd: 2000 });
    computeTaxLots(db);

    const lotsMod = await import("@/app/api/donations/[id]/lots/route");
    const assignRes = await lotsMod.POST(
      jsonReq(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
      }),
      ctx(donationId)
    );
    expect(assignRes.status).toBe(200);

    const res = await lotsMod.GET(
      jsonReq(`http://test/api/donations/${donationId}/lots`, "GET"),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { lots: { acquisitionTransactionId: number; remainingAsOfDonationDate: number; currentlyAssignedQuantity: number }[] };
    };
    expect(body.data.lots).toHaveLength(1);
    // This donation's own claim is reported...
    expect(body.data.lots[0].currentlyAssignedQuantity).toBe(40);
    // ...but doesn't reduce its OWN remaining capacity (a lot's prior claim by
    // this same donation counts back toward available capacity — replace
    // semantics, same as assignDonationLots' own existingByTxn precedent).
    expect(body.data.lots[0].remainingAsOfDonationDate).toBeCloseTo(100);
  });

  it("no confirmed out link -> 400", async () => {
    const db = hoisted.db;
    const sec = seedSecurity(db, "AAAA");
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: sec, symbolRaw: "AAAA", quantity: 40,
        fmvUsd: 2000, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.GET(
      jsonReq(`http://test/api/donations/${donationId}/lots`, "GET"),
      ctx(donationId)
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain("no confirmed out link");
  });
});

describe("POST /api/donations/:id/lots", () => {
  it("happy path: assigns lots and recomputes with donationsConsumed", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const buyId = insertTxn(db, acct, sec, "2026-06-01", "BUY", 100, 400);
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });
    computeTaxLots(db);

    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
      }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { saved: boolean; recomputed: boolean; donationsConsumed?: number; replayWarnings?: string[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(true);
    expect(body.data.donationsConsumed).toBe(1);
    expect(body.data.replayWarnings).toEqual([]);

    const lot = db.prepare("SELECT quantity_remaining FROM tax_lots WHERE acquisition_transaction_id = ?").get(buyId) as { quantity_remaining: number };
    expect(lot.quantity_remaining).toBeCloseTo(60);
  });

  it("invariant violation -> 400 carrying the DonationLinkError message", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });
    computeTaxLots(db);

    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: 999999, quantity: 40 }],
      }),
      ctx(donationId)
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain(`donation ${donationId}`);
    expect(body.error).toContain("not found");
  });

  it("recompute-failure path: saved:true, recomputed:false, recomputeError set", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const buyId = insertTxn(db, acct, sec, "2026-06-01", "BUY", 100, 400);
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });
    computeTaxLots(db);

    vi.mocked(computeTaxLots).mockImplementationOnce(() => {
      throw new Error("recompute boom");
    });

    const mod = await import("@/app/api/donations/[id]/lots/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/lots`, "POST", {
        assignments: [{ acquisitionTransactionId: buyId, quantity: 40 }],
      }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { saved: boolean; recomputed: boolean; recomputeError?: string };
    };
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(false);
    expect(body.data.recomputeError).toContain("recompute boom");

    const assigned = db
      .prepare("SELECT COUNT(*) AS n FROM donation_lots WHERE donation_id = ?")
      .get(donationId) as { n: number };
    expect(assigned.n).toBe(1);
  });
});

// ── POST /api/donations/:id/reverse ─────────────────────────────────────────

describe("POST /api/donations/:id/reverse", () => {
  it("happy path: stamps reversed_date and recomputes", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });

    const mod = await import("@/app/api/donations/[id]/reverse/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/reverse`, "POST", { reversedDate: "2026-07-15" }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { saved: boolean; recomputed: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(true);

    const row = db.prepare("SELECT reversed_date FROM donations WHERE id = ?").get(donationId) as { reversed_date: string | null };
    expect(row.reversed_date).toBe("2026-07-15");
  });

  it("malformed date -> 400, mutation never called", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });

    const mod = await import("@/app/api/donations/[id]/reverse/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/reverse`, "POST", { reversedDate: "07-15-2026" }),
      ctx(donationId)
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain("YYYY-MM-DD");

    const row = db.prepare("SELECT reversed_date FROM donations WHERE id = ?").get(donationId) as { reversed_date: string | null };
    expect(row.reversed_date).toBeNull();
  });

  it("invariant violation (donation not found) -> 400", async () => {
    const mod = await import("@/app/api/donations/[id]/reverse/route");
    const res = await mod.POST(
      jsonReq("http://test/api/donations/999999/reverse", "POST", { reversedDate: "2026-07-15" }),
      ctx(999999)
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain("not found");
  });

  it("recompute-failure path: saved:true, recomputed:false, recomputeError set", async () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 40 });

    vi.mocked(computeTaxLots).mockImplementationOnce(() => {
      throw new Error("recompute boom");
    });

    const mod = await import("@/app/api/donations/[id]/reverse/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/reverse`, "POST", { reversedDate: "2026-07-15" }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { saved: boolean; recomputed: boolean; recomputeError?: string };
    };
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(false);
    expect(body.data.recomputeError).toContain("recompute boom");

    const row = db.prepare("SELECT reversed_date FROM donations WHERE id = ?").get(donationId) as { reversed_date: string | null };
    expect(row.reversed_date).toBe("2026-07-15");
  });
});

// ── POST /api/donations/:id/resolve-security ────────────────────────────────

describe("POST /api/donations/:id/resolve-security", () => {
  it("happy path: sets security_id when it was NULL", async () => {
    const db = hoisted.db;
    const sec = seedSecurity(db, "ZZZZ");
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: null, symbolRaw: "ZZZZ", quantity: 10,
        fmvUsd: 500, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    const mod = await import("@/app/api/donations/[id]/resolve-security/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/resolve-security`, "POST", { securityId: sec }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { saved: boolean; recomputed: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.saved).toBe(true);

    const row = db.prepare("SELECT security_id FROM donations WHERE id = ?").get(donationId) as { security_id: number };
    expect(row.security_id).toBe(sec);
  });

  it("invariant violation -> 400 (non-USD security)", async () => {
    const db = hoisted.db;
    const sec = seedSecurity(db, "EEEE", "EUR");
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: null, symbolRaw: "EEEE", quantity: 10,
        fmvUsd: 500, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    const mod = await import("@/app/api/donations/[id]/resolve-security/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/resolve-security`, "POST", { securityId: sec }),
      ctx(donationId)
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain("not USD-denominated");
  });

  it("already-resolved donation -> 409", async () => {
    const db = hoisted.db;
    const sec = seedSecurity(db, "AAAA");
    const otherSec = seedSecurity(db, "BBBB");
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: sec, symbolRaw: "AAAA", quantity: 10,
        fmvUsd: 500, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    const mod = await import("@/app/api/donations/[id]/resolve-security/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/resolve-security`, "POST", { securityId: otherSec }),
      ctx(donationId)
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain("already resolved");
  });

  it("recompute-failure path: saved:true, recomputed:false, recomputeError set", async () => {
    const db = hoisted.db;
    const sec = seedSecurity(db, "ZZZZ");
    const donationId = insertDonation(
      db,
      {
        sourceKey: "d1", kind: "stock", securityId: null, symbolRaw: "ZZZZ", quantity: 10,
        fmvUsd: 500, unitValuation: null, createdDate: null, receivedDate: "2026-07-01",
        completedDate: null, notes: null,
      },
      null
    );

    vi.mocked(computeTaxLots).mockImplementationOnce(() => {
      throw new Error("recompute boom");
    });

    const mod = await import("@/app/api/donations/[id]/resolve-security/route");
    const res = await mod.POST(
      jsonReq(`http://test/api/donations/${donationId}/resolve-security`, "POST", { securityId: sec }),
      ctx(donationId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { saved: boolean; recomputed: boolean; recomputeError?: string };
    };
    expect(body.data.saved).toBe(true);
    expect(body.data.recomputed).toBe(false);
    expect(body.data.recomputeError).toContain("recompute boom");

    const row = db.prepare("SELECT security_id FROM donations WHERE id = ?").get(donationId) as { security_id: number };
    expect(row.security_id).toBe(sec);
  });
});

// ── getGivingView ────────────────────────────────────────────────────────

describe("getGivingView", () => {
  it("LT/ST boundary: exactly 365 days is short-term, 366 days is long-term", () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    // OUT leg on 2026-07-01. 2025-07-01 -> 2026-07-01 = 365 days (ST).
    // 2025-06-30 -> 2026-07-01 = 366 days (LT). Neither year spans Feb 29
    // (2026 is not a leap year), so the day counts are exact.
    const stBuy = insertTxn(db, acct, sec, "2025-07-01", "BUY", 10, 100);
    const ltBuy = insertTxn(db, acct, sec, "2025-06-30", "BUY", 10, 100);
    expect(isLongTermHolding("2025-07-01", "2026-07-01")).toBe(false);
    expect(isLongTermHolding("2025-06-30", "2026-07-01")).toBe(true);

    const { donationId } = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 20, fmvUsd: 4000 });
    computeTaxLots(db);
    assignDonationLots(db, donationId, [
      { acquisitionTransactionId: stBuy, quantity: 10 },
      { acquisitionTransactionId: ltBuy, quantity: 10 },
    ]);
    computeTaxLots(db);

    const view = getGivingView(db);
    const year = view.years.find((y) => y.year === "2026")!;
    const gd = year.donations.find((d) => d.donation.id === donationId)!;
    expect(gd.shortTermQuantity).toBeCloseTo(10);
    expect(gd.longTermQuantity).toBeCloseTo(10);
    expect(gd.basis).toBeCloseTo(2000); // 20 shares x $100 cost
    expect(gd.gainAvoided).toBeCloseTo(2000); // 4000 fmv - 2000 basis
  });

  it("year gainAvoided is null when any stock donation in the year lacks assignments; per-row values stay correct", () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const buyId = insertTxn(db, acct, sec, "2026-01-01", "BUY", 100, 50);
    const assigned = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-06-01", quantity: 30, fmvUsd: 3000 });
    computeTaxLots(db);
    assignDonationLots(db, assigned.donationId, [{ acquisitionTransactionId: buyId, quantity: 30 }]);
    computeTaxLots(db);
    // Second donation in the same year, linked but never assigned (pending-lots).
    const pending = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-07-01", quantity: 10, fmvUsd: 800 });
    computeTaxLots(db);

    const view = getGivingView(db);
    const year = view.years.find((y) => y.year === "2026")!;
    expect(year.gainAvoided).toBeNull();

    const assignedRow = year.donations.find((d) => d.donation.id === assigned.donationId)!;
    expect(assignedRow.basis).toBeCloseTo(1500); // 30 x $50
    expect(assignedRow.gainAvoided).toBeCloseTo(1500); // 3000 - 1500
    expect(assignedRow.status).toBe("received"); // completed_date never set by seedLinkedDonation

    const pendingRow = year.donations.find((d) => d.donation.id === pending.donationId)!;
    expect(pendingRow.needsLots).toBe(true);
    expect(pendingRow.basis).toBeNull();
    expect(pendingRow.gainAvoided).toBeNull();
    expect(pendingRow.status).toBe("pending-lots");

    // totals aren't polluted by the null per-row values.
    expect(year.totalGiven).toBeCloseTo(3800);
    expect(year.stockGiven).toBeCloseTo(3800);
  });

  it("reversed donations are excluded from every yearly total but stay in the donations list", () => {
    const db = hoisted.db;
    const acct = ibkrAccountId(db);
    const sec = seedSecurity(db, "AAAA");
    const active = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-05-01", quantity: 5, fmvUsd: 500 });
    const reversed = seedLinkedDonation(db, { accountId: acct, secId: sec, date: "2026-05-02", quantity: 5, fmvUsd: 100000 });
    db.prepare("UPDATE donations SET reversed_date = ? WHERE id = ?").run("2026-05-10", reversed.donationId);

    const view = getGivingView(db);
    const year = view.years.find((y) => y.year === "2026")!;
    expect(year.totalGiven).toBeCloseTo(500);
    expect(year.stockGiven).toBeCloseTo(500);
    expect(year.donations).toHaveLength(2);
    // seedLinkedDonation links the OUT leg but never assigns lots, so this
    // donation is "pending-lots" (stock, linked, no assignments) — not
    // "received" — and its non-null status confirms it's genuinely unaffected
    // by the sibling reversed donation.
    const activeRow = year.donations.find((d) => d.donation.id === active.donationId)!;
    expect(activeRow.status).toBe("pending-lots");
    const reversedRow = year.donations.find((d) => d.donation.id === reversed.donationId)!;
    expect(reversedRow.status).toBe("reversed");
  });
});
