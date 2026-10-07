/**
 * HTTP-boundary tests for POST/DELETE
 * /api/donations/lots/:acquisitionTransactionId/basis-verified (owner request
 * 2026-10-07): the real handlers on an in-memory database built from the real
 * migrations. Only the db singleton is replaced, as in
 * tests/api/donations-routes.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { getGivingView } from "@/lib/queries/giving-view";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { bumpTaxInputGeneration } from "@/lib/compute/tax-convention";
import { classifyRoute, listRouteHandlers } from "@/lib/auth/route-policy";
import { seedFlaggedGift, seedTxn } from "../helpers/giving-basis-fixture";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const ROUTE_PATH = "/api/donations/lots/[acquisitionTransactionId]/basis-verified";
const ROUTE_FILE = path.resolve(
  __dirname,
  "../../app/api/donations/lots/[acquisitionTransactionId]/basis-verified/route.ts"
);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

const ctx = (id: number | string) => ({ params: Promise.resolve({ acquisitionTransactionId: String(id) }) });
const url = (id: number | string) => `http://localhost/api/donations/lots/${id}/basis-verified`;

async function post(id: number | string, body: unknown, raw = false) {
  const { POST } = await import("@/app/api/donations/lots/[acquisitionTransactionId]/basis-verified/route");
  const res = await POST(
    new NextRequest(url(id), { method: "POST", body: raw ? (body as string) : JSON.stringify(body) }),
    ctx(id)
  );
  return { status: res.status, json: await res.json() };
}

async function del(id: number | string) {
  const { DELETE } = await import("@/app/api/donations/lots/[acquisitionTransactionId]/basis-verified/route");
  const res = await DELETE(new NextRequest(url(id), { method: "DELETE" }), ctx(id));
  return { status: res.status, json: await res.json() };
}

const markers = () =>
  (hoisted.db.prepare("SELECT COUNT(*) AS c FROM lot_basis_verifications").get() as { c: number }).c;

const leftOut = () => getGivingView(hoisted.db).years[0].gainAvoidedRowsLeftOut;

describe("POST basis-verified", () => {
  it("marks the lot with no ledger-recompute acknowledgement, and the gift rejoins the total", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    expect(leftOut()).toBe(1);
    const generation = hoisted.db.prepare("SELECT value FROM settings WHERE key = 'tax_input_generation'").get();

    const out = await post(bad.lotTxn, { sourceNote: "  synthetic source, 2020  " });
    expect(out.status).toBe(200);
    expect(out.json.success).toBe(true);
    expect(out.json.data).toMatchObject({
      verified: true,
      acquisitionTransactionId: bad.lotTxn,
      sourceNote: "synthetic source, 2020",
    });
    expect(out.json.data.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(markers()).toBe(1);
    expect(leftOut()).toBe(0);
    // No tax input moved.
    expect(hoisted.db.prepare("SELECT value FROM settings WHERE key = 'tax_input_generation'").get()).toEqual(
      generation
    );
  });

  it("400 for an id that is not a positive whole number", async () => {
    for (const id of ["abc", "0", "-3", "1.5", "7x", ""]) {
      const out = await post(id, { sourceNote: "synthetic source" });
      expect(out.status, `id ${JSON.stringify(id)}`).toBe(400);
      expect(out.json.success).toBe(false);
      expect(typeof out.json.error).toBe("string");
    }
    expect(markers()).toBe(0);
  });

  it("400 for a body that is not JSON, not an object, or has a bad note", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    expect((await post(bad.lotTxn, "not json", true)).status).toBe(400);
    for (const body of [null, 7, "text", [], {}, { sourceNote: 7 }, { sourceNote: "" }, { sourceNote: "   " }]) {
      const out = await post(bad.lotTxn, body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.json.success).toBe(false);
    }
    const tooLong = await post(bad.lotTxn, { sourceNote: "x".repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.error).toContain("200");
    expect(markers()).toBe(0);
    expect((await post(bad.lotTxn, { sourceNote: "x".repeat(200) })).status).toBe(200);
  });

  it("404 for a transaction that does not exist", async () => {
    const out = await post(999999, { sourceNote: "synthetic source" });
    expect(out.status).toBe(404);
    expect(out.json.success).toBe(false);
  });

  it("409 with a plain message for a transaction no donation draws on", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    const lonely = seedTxn(hoisted.db, bad.sec, "2012-01-10", "TRANSFER_IN", 100, 0.01);
    const out = await post(lonely, { sourceNote: "synthetic source" });
    expect(out.status).toBe(409);
    expect(out.json.success).toBe(false);
    expect(out.json.error).toMatch(/no donation draws on/i);
    // Not the recompute refusal: there is nothing to confirm.
    expect(out.json.code).toBeUndefined();

    const outLeg = (
      hoisted.db.prepare("SELECT id FROM transactions WHERE type = 'TRANSFER_OUT'").get() as { id: number }
    ).id;
    const notALot = await post(outLeg, { sourceNote: "synthetic source" });
    expect(notALot.status).toBe(409);
    expect(markers()).toBe(0);
  });

  it("409 with a plain message while the tax-lot ledger is waiting on a recompute; nothing is written", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    bumpTaxInputGeneration(hoisted.db);
    const out = await post(bad.lotTxn, { sourceNote: "synthetic source" });
    expect(out.status).toBe(409);
    expect(out.json).toEqual({
      success: false,
      error:
        "The tax-lot ledger is waiting on a recompute, so the basis shown may be out of date. Run Recompute on the Tax Lots page, then verify.",
    });
    expect(markers()).toBe(0);
    expect(leftOut()).toBe(1);

    computeTaxLots(hoisted.db);
    expect((await post(bad.lotTxn, { sourceNote: "synthetic source" })).status).toBe(200);
    // Undo is never blocked: it only removes a note.
    bumpTaxInputGeneration(hoisted.db);
    expect(await del(bad.lotTxn)).toEqual({ status: 200, json: { success: true, data: { removed: true } } });
  });

  it("marking twice keeps one marker and takes the newer note", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    await post(bad.lotTxn, { sourceNote: "first" });
    const out = await post(bad.lotTxn, { sourceNote: "second" });
    expect(out.status).toBe(200);
    expect(markers()).toBe(1);
    expect(
      hoisted.db.prepare("SELECT source_note FROM lot_basis_verifications").get()
    ).toEqual({ source_note: "second" });
  });
});

describe("DELETE basis-verified", () => {
  it("removes the marker and the gift is left out again", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    await post(bad.lotTxn, { sourceNote: "synthetic source" });
    const out = await del(bad.lotTxn);
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ success: true, data: { removed: true } });
    expect(markers()).toBe(0);
    expect(leftOut()).toBe(1);
  });

  it("a missing marker is a 200 that says nothing was removed", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    expect(await del(bad.lotTxn)).toEqual({ status: 200, json: { success: true, data: { removed: false } } });
    expect(await del(999999)).toEqual({ status: 200, json: { success: true, data: { removed: false } } });
  });

  it("400 for a bad id", async () => {
    for (const id of ["abc", "0", "-3", "1.5"]) {
      expect((await del(id)).status, `id ${id}`).toBe(400);
    }
  });
});

describe("the route's place in the trust boundary", () => {
  it("is a human route for both methods (session and CSRF, never a service credential)", () => {
    const mine = listRouteHandlers().filter((h) => h.pathname === ROUTE_PATH);
    expect(mine.map((h) => h.method).sort()).toEqual(["DELETE", "POST"]);
    for (const h of mine) expect(classifyRoute(h.method, h.pathname)).toBe("human");
    // The same class as its sibling donation write routes.
    expect(classifyRoute("POST", "/api/donations/[id]/lots")).toBe("human");
  });

  it("asks for no ledger-recompute acknowledgement and never recomputes", () => {
    expect(existsSync(ROUTE_FILE)).toBe(true);
    const src = readFileSync(ROUTE_FILE, "utf8");
    expect(src).toContain("NO ledger-recompute acknowledgement");
    const code = src.slice(src.indexOf("*/"));
    expect(code).not.toContain("donation-recompute");
    expect(code).not.toContain("computeTaxLots");
    expect(code).not.toContain("acknowledgeLedgerRecompute");
    expect(code).not.toContain("bumpTax");
  });
});
