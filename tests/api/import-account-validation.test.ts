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
import { computeTaxLots } from "@/lib/compute/tax-lots";

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
const CANONICAL_SNAPSHOT_HEADER =
  "account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr";

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

describe("POST /api/import?mode=preview — canonical monthly snapshot validation", () => {
  it("surfaces a percent-scale canonical twr as a skipped snapshot row", async () => {
    const csv = `${CANONICAL_SNAPSHOT_HEADER}
Vanguard Taxable,2026-08-31,100000,,,,,,,,5`;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("preview", [{ name: "snapshots.csv", content: csv }]));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    const fileResult = body.results[0];

    expect(fileResult.preview!.snapshotCount).toBe(0);
    expect(fileResult.skippedRows).toHaveLength(1);
    expect(fileResult.skippedRows![0].category).toBe("snapshot");
    expect(fileResult.skippedRows![0].reason).toContain("twr is a decimal");
  });
});

describe("POST /api/import?mode=commit — canonical monthly snapshot validation matches preview", () => {
  it("commits exactly the valid row of a file that also carries a percent-scale twr row", async () => {
    const csv = `${CANONICAL_SNAPSHOT_HEADER}
Vanguard Taxable,2026-08-31,100000,,,,,,,,5
Vanguard Taxable,2026-09-30,200000,,,,,,,,0.05`;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("commit", [{ name: "snapshots.csv", content: csv }]));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    expect(body.success).toBe(true);
    const fileResult = body.results[0];
    expect(fileResult.success).toBe(true);
    expect(fileResult.skippedRows).toHaveLength(1);
    expect(fileResult.skippedRows![0].category).toBe("snapshot");
    expect(fileResult.skippedRows![0].reason).toContain("+500%");

    const rows = hoisted.db
      .prepare(
        `SELECT a.name AS account, ms.month_end_date, ms.total_value, ms.twr
           FROM monthly_snapshots ms JOIN accounts a ON a.id = ms.account_id
          ORDER BY ms.month_end_date`,
      )
      .all();
    expect(rows).toEqual([
      { account: "Vanguard Taxable", month_end_date: "2026-09-30", total_value: 200000, twr: 0.05 },
    ]);
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

    // The excluded row's security (referenced by no kept row) is not upserted.
    const msft = hoisted.db
      .prepare("SELECT COUNT(*) AS c FROM securities WHERE symbol = 'MSFT'")
      .get() as { c: number };
    expect(msft.c).toBe(0);
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

/**
 * QA 2026-10-02: an all-unknown-account commit returned 200 with 0 records but
 * still wrote an empty import_batches row (Undo-able ghost in Import History)
 * and ran the whole post-commit pipeline — the tax-lot recompute deleted and
 * re-minted every engine-owned RECONCILE_CLOSE under new ids. Nothing to write
 * now means no batch and no pipeline; a file with a valid row is unchanged.
 */
describe("POST /api/import?mode=commit — nothing left to write after exclusion", () => {
  const UNKNOWN_ONLY = `${CANONICAL_TXN_HEADER}
Typo Account Q,2025-06-16,,BUY,ZZQB,Synthetic Beta Co,Stock,5,40.00,-200.00,0,
Typo Account Q,2025-06-17,,BUY,ZZQC,Synthetic Gamma Co,Stock,2,50.00,-100.00,0,`;
  const VALID_ONE = `${CANONICAL_TXN_HEADER}
Vanguard Taxable,2025-06-15,,BUY,ZZQD,Synthetic Delta Co,Stock,10,20.00,-200.00,0,`;

  /**
   * Seed a position the broker says is closed (latest holdings row qty 0) with
   * an open lot, then recompute so the engine mints a RECONCILE_CLOSE. Its id
   * changes on every recompute (delete + re-insert), which makes it a probe
   * for "did the post-commit pipeline run".
   */
  function seedReconcileClose(): void {
    const db = hoisted.db;
    const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Vanguard Taxable'").get() as { id: number }).id;
    const sec = Number(
      db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZQA', 'Synthetic Alpha Co', 'Stock')").run()
        .lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, is_external_flow, source_key)
       VALUES (?, ?, '2025-01-10', 'BUY', 10, 10, -100, 0, 0, 'seed:zzqa:buy')`,
    ).run(acct, sec);
    db.prepare(
      // Statement-grade key: only statement evidence mints a saved synthetic close.
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 0, '2025-03-31', 'canonical:hold:seed:zzqa')",
    ).run(acct, sec);
    computeTaxLots(db);
  }
  const reconcileCloseIds = () =>
    (hoisted.db.prepare("SELECT id FROM transactions WHERE type = 'RECONCILE_CLOSE' ORDER BY id").all() as { id: number }[]).map(
      (r) => r.id,
    );
  const batchCount = () =>
    (hoisted.db.prepare("SELECT COUNT(*) AS c FROM import_batches").get() as { c: number }).c;

  type CommitBody = ImportRouteResponse & {
    results: Array<{ batchId?: number | null; committed?: { newTransactions: number; totalRecords: number } }>;
    replay: unknown;
  };

  it("all rows unknown: 200, zero counts, skippedRows reported, NO import_batches row, pipeline not run", async () => {
    seedReconcileClose();
    const idsBefore = reconcileCloseIds();
    expect(idsBefore).toHaveLength(1);
    const batchesBefore = batchCount();
    const txnsBefore = (hoisted.db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("commit", [{ name: "unknown.csv", content: UNKNOWN_ONLY }]));

    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitBody;
    expect(body.success).toBe(true);
    const fr = body.results[0];
    expect(fr.success).toBe(true);
    expect(fr.batchId).toBeNull();
    expect(fr.committed!.totalRecords).toBe(0);
    expect(fr.skippedRows!).toHaveLength(2);
    expect(body.replay).toBeNull();

    expect(batchCount()).toBe(batchesBefore);
    expect(reconcileCloseIds()).toEqual(idsBefore);
    expect((hoisted.db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c).toBe(txnsBefore);
  });

  it("mixed file (one valid row): unchanged — batch created, pipeline runs", async () => {
    seedReconcileClose();
    const idsBefore = reconcileCloseIds();
    const batchesBefore = batchCount();
    const csv = `${VALID_ONE}
Typo Account Q,2025-06-16,,BUY,ZZQB,Synthetic Beta Co,Stock,5,40.00,-200.00,0,`;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("commit", [{ name: "mixed.csv", content: csv }]));
    const body = (await res.json()) as CommitBody;
    expect(typeof body.results[0].batchId).toBe("number");
    expect(body.results[0].skippedRows!).toHaveLength(1);
    expect(batchCount()).toBe(batchesBefore + 1);
    // The tax-lot recompute ran: the synthetic close was re-minted under a new id.
    expect(reconcileCloseIds()).toHaveLength(1);
    expect(reconcileCloseIds()).not.toEqual(idsBefore);
  });

  it("two files, one all-excluded: the other still commits and the pipeline runs once", async () => {
    seedReconcileClose();
    const idsBefore = reconcileCloseIds();
    const batchesBefore = batchCount();

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("commit", [
        { name: "unknown.csv", content: UNKNOWN_ONLY },
        { name: "valid.csv", content: VALID_ONE },
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitBody;
    expect(body.results).toHaveLength(2);
    expect(body.results[0].batchId).toBeNull();
    expect(body.results[0].skippedRows!).toHaveLength(2);
    expect(typeof body.results[1].batchId).toBe("number");
    expect(body.results[1].committed!.newTransactions).toBe(1);
    expect(batchCount()).toBe(batchesBefore + 1);
    expect(reconcileCloseIds()).not.toEqual(idsBefore);
  });
});
