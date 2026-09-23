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
