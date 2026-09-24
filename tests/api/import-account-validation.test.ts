/**
 * QA finding import-preview--no-account-validation-500-on-commit (MEDIUM):
 * a CSV whose rows name a typo'd account ("Vangaurd Taxable") previewed
 * green with zero warnings and a live Import button, then `commitImport`
 * (lib/import/engine.ts getAccountId) threw `Unknown account: …` and the
 * commit 500'd.
 *
 * This pins the route-level fix: POST /api/import?mode=preview now resolves
 * every distinct accountName against `SELECT name FROM accounts` and
 * excludes unresolvable rows as skippedRows with a warning naming the
 * unknown account(s) and the valid set, so preview can no longer be green
 * when commit would fail. Harness mirrors
 * tests/api/import-corporate-actions-route.test.ts (hoisted in-memory db,
 * real POST handler, canonical-csv fixture built inline).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

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
  runMigrations(hoisted.db); // seeds accounts: IBKR, Vanguard Roth IRA, Vanguard Taxable
});

const CANONICAL_TXN_HEADER =
  "account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes";

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
    skippedRows?: Array<{ category: string; reason: string; symbol?: string }>;
    preview?: { transactionCount: number; [k: string]: unknown };
  }>;
}

describe("POST /api/import?mode=preview — account-name validation", () => {
  it("excludes a row naming an unknown (typo'd) account and reports skippedRows + a warning listing the valid set", async () => {
    const csv = `${CANONICAL_TXN_HEADER}
Vangaurd Taxable,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,-1502.50,4.95,`;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("preview", [{ name: "typo.csv", content: csv }]));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    expect(body.success).toBe(true);

    const fileResult = body.results[0];
    expect(fileResult.preview!.transactionCount).toBe(0);

    expect(fileResult.skippedRows).toBeDefined();
    expect(fileResult.skippedRows!.length).toBe(1);
    expect(fileResult.skippedRows![0].category).toBe("transaction");
    expect(fileResult.skippedRows![0].reason).toContain('Unknown account "Vangaurd Taxable"');

    const warningText = fileResult.warnings!.join("\n");
    expect(warningText).toContain("Unknown account(s):");
    expect(warningText).toContain("Vangaurd Taxable");
    expect(warningText).toContain("IBKR");
    expect(warningText).toContain("Vanguard Roth IRA");
    expect(warningText).toContain("Vanguard Taxable");
  });

  it("previews a row naming a real account cleanly, with no skippedRows or account warnings", async () => {
    const csv = `${CANONICAL_TXN_HEADER}
Vanguard Taxable,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,-1502.50,4.95,`;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("preview", [{ name: "clean.csv", content: csv }]));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    const fileResult = body.results[0];

    expect(fileResult.preview!.transactionCount).toBe(1);
    expect(fileResult.skippedRows).toBeUndefined();
    expect((fileResult.warnings ?? []).some((w) => w.includes("Unknown account"))).toBe(false);
  });
});

/**
 * QA regression import-preview--no-account-validation-500-on-commit-regression-1
 * (2026-09-24 sweep): the preview half above shipped in 19341671, but
 * `commitImport` re-validated WITHOUT the account list, so the rows preview
 * had promised to exclude reached `getAccountId` and the commit still 500'd
 * ("Unknown account: …"), rolling back the valid rows in the same file.
 * Commit must exclude exactly what preview excluded, report those rows, and
 * write the rest.
 */
describe("POST /api/import?mode=commit — account-name validation matches preview", () => {
  it("commits a mixed file: the valid row lands, the unknown-account row is reported as skipped, no 500", async () => {
    const csv = `${CANONICAL_TXN_HEADER}
Vanguard Taxable,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,-1502.50,4.95,
Fidelity Brokerage XYZ,2025-06-16,,BUY,MSFT,Microsoft Corp,Stock,5,400.00,-2000.00,0,`;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("commit", [{ name: "mixed.csv", content: csv }]));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse & {
      results: Array<{ committed?: { newTransactions: number } }>;
    };
    expect(body.success).toBe(true);
    const fileResult = body.results[0];
    expect(fileResult.success).toBe(true);
    expect(fileResult.committed!.newTransactions).toBe(1);

    expect(fileResult.skippedRows).toBeDefined();
    expect(fileResult.skippedRows!).toHaveLength(1);
    expect(fileResult.skippedRows![0].category).toBe("transaction");
    expect(fileResult.skippedRows![0].reason).toContain('Unknown account "Fidelity Brokerage XYZ"');

    const rows = hoisted.db
      .prepare("SELECT t.type, s.symbol FROM transactions t JOIN securities s ON s.id = t.security_id")
      .all() as Array<{ type: string; symbol: string }>;
    expect(rows).toEqual([{ type: "BUY", symbol: "AAPL" }]);
  });

  it("commits a file whose every row names an unknown account as a clean no-op (0 transactions), never a 500", async () => {
    const csv = `${CANONICAL_TXN_HEADER}
Fidelity Brokerage XYZ,2025-06-16,,BUY,MSFT,Microsoft Corp,Stock,5,400.00,-2000.00,0,`;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("commit", [{ name: "unknown.csv", content: csv }]));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse & {
      results: Array<{ committed?: { newTransactions: number } }>;
    };
    expect(body.success).toBe(true);
    expect(body.results[0].committed!.newTransactions).toBe(0);
    expect(body.results[0].skippedRows!).toHaveLength(1);
    const count = (hoisted.db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
