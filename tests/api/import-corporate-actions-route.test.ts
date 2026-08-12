/**
 * HTTP-boundary + composition tests for the corporate-action replay status
 * and preview surfaces added to POST /api/import (issue #37, Task 6).
 *
 * Contracts 2 (DELETE /api/corporate-actions -> 403 on an import-sourced
 * row) and 3 (POST /api/corporate-actions -> 409 on a (security, date)
 * collision) from the task brief are already pinned via the identical
 * route-handler harness in tests/api/corporate-actions-route.test.ts
 * (Task 3) — not duplicated here to avoid a second, redundant pin of the
 * same behavior through the same style of test.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport } from "@/lib/import/engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import type { ParsedImportResult } from "@/lib/import/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const CA_CSV = readFileSync(
  join(__dirname, "../fixtures/ibkr-corporate-actions.csv"),
  "utf-8",
);
const HOLDINGS_CSV = readFileSync(
  join(__dirname, "../fixtures/vanguard-holdings-sample.csv"),
  "utf-8",
);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol) VALUES (?)")
    .run(symbol).lastInsertRowid as number;
}

function ibkrAccountId(db: Database.Database): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as {
      id: number;
    }
  ).id;
}

function seedBuy(
  db: Database.Database,
  securityId: number,
  accountId: number,
  quantity: number,
  tradeDate: string,
): void {
  db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, 'BUY', ?, 100, ?, 0, ?)`,
  ).run(accountId, securityId, tradeDate, quantity, quantity * 100, `seed-buy-${securityId}`);
}

function importReq(
  mode: "preview" | "commit",
  files: { name: string; content: string }[],
): NextRequest {
  const fd = new FormData();
  for (const f of files) {
    fd.append("files", new File([f.content], f.name, { type: "text/csv" }));
  }
  return new NextRequest(`http://test/api/import?mode=${mode}`, {
    method: "POST",
    body: fd,
  });
}

interface ImportRouteResponse {
  success: boolean;
  results: Array<{
    filename: string;
    success: boolean;
    warnings?: string[];
    committed?: { newCorporateActions: number; [k: string]: unknown };
    preview?: {
      corporateActions: {
        count: number;
        sample: Array<{ symbol: string; description: string; effectiveDate: string }>;
      };
      [k: string]: unknown;
    };
  }>;
  replay: { status: "clean" | "mismatch" | "failed"; warnings: string[] } | null;
}

describe("CA-bearing commit -> synchronous replay status composition", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("mismatch replay surfaces warnings + persisted delta", () => {
    const parsed: ParsedImportResult = {
      sourceType: "ibkr-activity", sourceName: "t.csv",
      transactions: [], securities: [{ symbol: "AAAA", securityType: "Stock" }],
      holdings: [], prices: [], snapshots: [],
      corporateActions: [{
        accountName: "IBKR", symbol: "AAAA", actionType: "SPLIT",
        effectiveDate: "2026-07-01", ratioNumerator: 4, ratioDenominator: 1,
        quantityDelta: 300, sourceKey: "ibkr:ca:split:2026-07-01:AAAA:4:1",
      }],
      errors: [], warnings: [],
    };
    const res = commitImport(db, parsed);
    expect(res.newCorporateActions).toBe(1);
    const replay = computeTaxLots(db);            // no lots -> mismatch
    expect(replay.replayWarnings.length).toBeGreaterThan(0);
    const delta = (db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null }).reconcile_delta;
    expect(delta).toBeCloseTo(-300);
  });
});

describe("POST /api/import?mode=commit — corporate-action replay status", () => {
  it('reports "mismatch" and surfaces commit-time warnings when the ledger has no matching lots', async () => {
    seedSecurity(hoisted.db, "AAAA"); // known, but no tax lots -> the split's
    // implied delta (0) won't match the statement's quantityDelta (300).
    // BBBB / 402340 / GGGG stay unknown -> resolve-only skip + warnings.

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("commit", [{ name: "ibkr-corporate-actions.csv", content: CA_CSV }]),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    expect(body.success).toBe(true);

    expect(body.replay).not.toBeNull();
    expect(body.replay!.status).toBe("mismatch");
    expect(body.replay!.warnings.length).toBeGreaterThan(0);

    const fileResult = body.results[0];
    expect(fileResult.committed!.newCorporateActions).toBe(1); // AAAA only
    // Commit-time resolve-only-skip warnings (BBBB/402340/GGGG) must appear
    // in the response, not just live inside commitImport's return value.
    expect(fileResult.warnings!.join("\n")).toContain("BBBB");
    expect(fileResult.warnings!.join("\n")).toContain("no known security");

    const delta = (
      hoisted.db
        .prepare("SELECT reconcile_delta FROM corporate_actions WHERE security_id = (SELECT id FROM securities WHERE symbol='AAAA')")
        .get() as { reconcile_delta: number | null }
    ).reconcile_delta;
    expect(delta).toBeCloseTo(-300);
  });

  it('reports "clean" when the ledger-implied delta matches the statement exactly', async () => {
    const secId = seedSecurity(hoisted.db, "AAAA");
    const acctId = ibkrAccountId(hoisted.db);
    // 100 pre-split shares * (4 - 1) = 300, matching the fixture's quantityDelta.
    seedBuy(hoisted.db, secId, acctId, 100, "2026-06-01");

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("commit", [{ name: "ibkr-corporate-actions.csv", content: CA_CSV }]),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    expect(body.replay).not.toBeNull();
    expect(body.replay!.status).toBe("clean");
    expect(body.replay!.warnings).toEqual([]);
    expect(body.results[0].committed!.newCorporateActions).toBe(1);
  });

  it("is null when the request carries no corporate actions", async () => {
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("commit", [{ name: "vanguard-holdings-sample.csv", content: HOLDINGS_CSV }]),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    expect(body.success).toBe(true);
    expect(body.replay).toBeNull();
  });
});

describe("POST /api/import?mode=preview — corporate actions preview", () => {
  it("preview carries validated count + sample rows, and committing the same file yields the same count", async () => {
    // Pre-seed the securities the statement's actions reference so the
    // commit half of this test resolves cleanly (a "disposable staging"
    // DB used for both the preview and the follow-up commit call).
    seedSecurity(hoisted.db, "AAAA");
    seedSecurity(hoisted.db, "BBBB");
    seedSecurity(hoisted.db, "402340"); // exchange-suffix stripped at commit
    seedSecurity(hoisted.db, "GGGG");

    const mod = await import("@/app/api/import/route");

    const previewRes = await mod.POST(
      importReq("preview", [{ name: "ibkr-corporate-actions.csv", content: CA_CSV }]),
    );
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as ImportRouteResponse;
    const preview = previewBody.results[0].preview!;
    expect(preview.corporateActions.count).toBe(4); // AAAA, BBBB, 402340.KS, GGGG

    const aaaa = preview.corporateActions.sample.find((s) => s.symbol === "AAAA");
    expect(aaaa).toEqual({
      symbol: "AAAA",
      description: "4:1 split",
      effectiveDate: "2026-07-01",
    });

    // Parser-level warnings (merger/malformed/no-op rows the parser itself
    // excludes) still surface in preview.
    expect(previewBody.results[0].warnings!.join("\n")).toContain("CCCC");

    const commitRes = await mod.POST(
      importReq("commit", [{ name: "ibkr-corporate-actions.csv", content: CA_CSV }]),
    );
    expect(commitRes.status).toBe(200);
    const commitBody = (await commitRes.json()) as ImportRouteResponse;
    expect(commitBody.results[0].committed!.newCorporateActions).toBe(4);
  });
});
