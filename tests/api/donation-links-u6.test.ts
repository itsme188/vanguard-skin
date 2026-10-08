import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { insertDonation } from "@/lib/mutations/donations";
import { LEDGER_RECOMPUTE_ACK_FIELD } from "@/lib/compute/donation-recompute-contract";

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

function req(body: unknown): NextRequest {
  return new NextRequest("http://test/api/donations/1/links", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/donations/:id/links amountForOutLeg", () => {
  it("stamps a zero-amount OUT leg from the donation's recorded fair value", async () => {
    const db = hoisted.db;
    const sec = db.prepare("INSERT INTO securities (symbol, currency) VALUES ('ZZLK', 'USD')").run().lastInsertRowid as number;
    const out = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
         VALUES (1, ?, '2026-03-01', 'TRANSFER_OUT', 10, 0, 'link-u6-out')`,
      )
      .run(sec).lastInsertRowid as number;
    const donationId = insertDonation(
      db,
      {
        sourceKey: "link-u6-donation",
        kind: "stock",
        securityId: sec,
        symbolRaw: "ZZLK",
        quantity: 10,
        fmvUsd: 1000,
        unitValuation: null,
        createdDate: null,
        receivedDate: "2026-03-01",
        completedDate: null,
        notes: null,
      },
      null,
    );
    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      req({ outTransactionId: out, [LEDGER_RECOMPUTE_ACK_FIELD]: true }),
      { params: Promise.resolve({ id: String(donationId) }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect((db.prepare("SELECT COUNT(*) AS n FROM donation_leg_links").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT amount FROM transactions WHERE id = ?").get(out) as { amount: number }).amount).toBe(1000);
  });

  it("rejects a supplied amountForOutLeg that is not a finite positive number", async () => {
    const db = hoisted.db;
    const sec = db.prepare("INSERT INTO securities (symbol, currency) VALUES ('ZZLN', 'USD')").run().lastInsertRowid as number;
    const out = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
         VALUES (1, ?, '2026-03-01', 'TRANSFER_OUT', 10, 0, 'link-u6-out-invalid')`,
      )
      .run(sec).lastInsertRowid as number;
    const donationId = insertDonation(
      db,
      {
        sourceKey: "link-u6-donation-invalid",
        kind: "stock",
        securityId: sec,
        symbolRaw: "ZZLN",
        quantity: 10,
        fmvUsd: 1000,
        unitValuation: null,
        createdDate: null,
        receivedDate: "2026-03-01",
        completedDate: null,
        notes: null,
      },
      null,
    );
    const mod = await import("@/app/api/donations/[id]/links/route");
    const res = await mod.POST(
      req({ outTransactionId: out, amountForOutLeg: 0, [LEDGER_RECOMPUTE_ACK_FIELD]: true }),
      { params: Promise.resolve({ id: String(donationId) }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: "amountForOutLeg must be a positive number" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM donation_leg_links").get() as { n: number }).n).toBe(0);
  });
});
