/**
 * Task 4 (reconciler hardening, spec docs/superpowers/specs/2026-08-30-reconciler-hardening-design.md):
 * the import engine's half of the tombstone model.
 *
 * A tombstone (`recon:closed-equity:%`, always quantity 0) is a DERIVED row,
 * never authority. This file pins the four engine-side consequences of that:
 *
 *  1. SUPERSESSION — a corrected same-date statement re-import overwrites a
 *     tombstone at the same (account, security, date) slot, so a
 *     phantom-closed position can actually be restored (§2 of the spec).
 *  2. OWNERSHIP — tombstones minted by a commit's own post-commit reconcile
 *     carry that batch's `import_batch_id`, for the accounts THIS batch
 *     imported and no others, so `undoImport` can take them back out. The
 *     account set comes from `parsed.holdings`, not from rows stamped with the
 *     batch id — a fully-deduped retry stamps nothing yet still mints
 *     tombstones it must own.
 *  3. UNDO REBUILD — undo deletes owned tombstones, drops orphans whose
 *     justifying same-date snapshot went with the batch, and re-derives the
 *     ones that survive, all in one transaction.
 *  4. FAIL-CLOSED SURFACING — a failed post-commit sweep is reported in domain
 *     language (never raw error text) on the result AND persisted to
 *     `import_batches.summary`, while the import itself still succeeds; the
 *     route no longer mistakes such a warning for corporate-action evidence.
 *
 * Fixtures are synthetic canonical-CSV files driven through the real
 * `parseImport` → `commitImport` path (the idiom in tests/import/engine.test.ts
 * and tests/import/tax-generation-bumps.test.ts), against in-memory SQLite.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";

// ── module mocks ────────────────────────────────────────────────────────
// `hoisted` carries both the route's db handle and the fault-injection flags
// for the three post-commit sweeps (flags default off → real implementations).

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  reconcileThrows: false,
  expiredPurgeThrows: false,
  maturedPurgeThrows: false,
}));

/** Raw error text the sweeps throw — must never reach a user-facing warning. */
const RAW_ERROR = "SQLITE_BUSY: /Users/private/Desktop/vanguard.db is locked";

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/mutations/closed-equity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mutations/closed-equity")>();
  return {
    ...actual,
    reconcileClosedEquityHoldings: (
      ...args: Parameters<typeof actual.reconcileClosedEquityHoldings>
    ) => {
      if (hoisted.reconcileThrows) throw new Error(RAW_ERROR);
      return actual.reconcileClosedEquityHoldings(...args);
    },
  };
});

vi.mock("@/lib/mutations/expired-options", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mutations/expired-options")>();
  return {
    ...actual,
    purgeExpiredOptionHoldings: (
      ...args: Parameters<typeof actual.purgeExpiredOptionHoldings>
    ) => {
      if (hoisted.expiredPurgeThrows) throw new Error(RAW_ERROR);
      return actual.purgeExpiredOptionHoldings(...args);
    },
  };
});

vi.mock("@/lib/mutations/matured-bonds", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mutations/matured-bonds")>();
  return {
    ...actual,
    purgeMaturedBondHoldings: (
      ...args: Parameters<typeof actual.purgeMaturedBondHoldings>
    ) => {
      if (hoisted.maturedPurgeThrows) throw new Error(RAW_ERROR);
      return actual.purgeMaturedBondHoldings(...args);
    },
  };
});

// ── fixtures ────────────────────────────────────────────────────────────

const TAXABLE = "Vanguard Taxable"; // seeded by migration 002
const ROTH = "Vanguard Roth IRA";

/** Prior statement date, then the date the corrected/bad statements share. */
const D0 = "2026-05-31";
const D = "2026-06-30";

const HOLDINGS_HEADER =
  "account,as_of_date,symbol,security_name,security_type,quantity,cost_basis";

interface Pos {
  symbol: string;
  quantity: number;
}

const A: Pos = { symbol: "SYNA", quantity: 10 };
const B: Pos = { symbol: "SYNB", quantity: 20 };
const C: Pos = { symbol: "SYNC", quantity: 30 };

function holdingsCsv(asOfDate: string, rows: Pos[], account = TAXABLE): string {
  return [
    HOLDINGS_HEADER,
    ...rows.map(
      (r) =>
        `${account},${asOfDate},${r.symbol},${r.symbol} Corp,Stock,${r.quantity},${r.quantity * 100}`,
    ),
  ].join("\n");
}

async function importHoldings(
  db: Database.Database,
  asOfDate: string,
  rows: Pos[],
  opts: { account?: string; filename?: string } = {},
) {
  const csv = holdingsCsv(asOfDate, rows, opts.account);
  const parsed = await parseImport(csv, opts.filename ?? `holdings-${asOfDate}.csv`);
  expect(parsed.sourceType).toBe("canonical-csv");
  return commitImport(db, parsed);
}

async function importPrices(
  db: Database.Database,
  rows: { symbol: string; date: string; close: number }[],
) {
  const csv = [
    "symbol,date,close_price",
    ...rows.map((r) => `${r.symbol},${r.date},${r.close}`),
  ].join("\n");
  const parsed = await parseImport(csv, "prices.csv");
  expect(parsed.sourceType).toBe("canonical-csv");
  return commitImport(db, parsed);
}

// ── read helpers ────────────────────────────────────────────────────────

interface HoldingRow {
  quantity: number;
  as_of_date: string;
  source_key: string;
  import_batch_id: number | null;
}

function holdingRow(
  db: Database.Database,
  symbol: string,
  date: string,
  account = TAXABLE,
): HoldingRow | undefined {
  return db
    .prepare(
      `SELECT h.quantity, h.as_of_date, h.source_key, h.import_batch_id
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts a ON a.id = h.account_id
        WHERE s.symbol = ? AND h.as_of_date = ? AND a.name = ?`,
    )
    .get(symbol, date, account) as HoldingRow | undefined;
}

function latestRow(
  db: Database.Database,
  symbol: string,
  account = TAXABLE,
): HoldingRow | undefined {
  return db
    .prepare(
      `SELECT h.quantity, h.as_of_date, h.source_key, h.import_batch_id
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts a ON a.id = h.account_id
        WHERE s.symbol = ? AND a.name = ?
        ORDER BY h.as_of_date DESC LIMIT 1`,
    )
    .get(symbol, account) as HoldingRow | undefined;
}

function reconRows(db: Database.Database): HoldingRow[] {
  return db
    .prepare(
      `SELECT quantity, as_of_date, source_key, import_batch_id
         FROM holdings WHERE source_key LIKE 'recon:closed-equity:%'
        ORDER BY id`,
    )
    .all() as HoldingRow[];
}

function batchSummary(db: Database.Database, batchId: number): string | null {
  return (
    db
      .prepare("SELECT summary FROM import_batches WHERE id = ?")
      .get(batchId) as { summary: string | null }
  ).summary;
}

function accountId(db: Database.Database, name: string): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }
  ).id;
}

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

/** Direct statement-prefixed holdings row (bypasses the import path). */
function seedHolding(
  db: Database.Database,
  acctId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    acctId,
    securityId,
    quantity,
    quantity * 100,
    asOfDate,
    `canonical:hold:seed:${acctId}:${securityId}:${asOfDate}`,
  );
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  hoisted.reconcileThrows = false;
  hoisted.expiredPurgeThrows = false;
  hoisted.maturedPurgeThrows = false;
});

// ── 1. same-date supersession ───────────────────────────────────────────

describe("same-date tombstone supersession", () => {
  it("a corrected same-date statement re-import restores a phantom-closed position", async () => {
    await importHoldings(db, D0, [A, B, C]);
    const bad = await importHoldings(db, D, [A, C]); // SYNB accidentally absent

    // Precondition: the bad import phantom-closed SYNB at D.
    const tomb = holdingRow(db, "SYNB", D)!;
    expect(tomb.quantity).toBe(0);
    expect(tomb.source_key.startsWith("recon:closed-equity:")).toBe(true);

    const fixed = await importHoldings(db, D, [A, B, C]); // corrected file

    const restored = holdingRow(db, "SYNB", D)!;
    expect(restored.quantity).toBe(20);
    expect(restored.source_key).toBe(`canonical:hold:${TAXABLE}:SYNB:${D}`);
    expect(restored.import_batch_id).toBe(fixed.batchId);
    // Counted as a real change, not swallowed as a duplicate.
    expect(fixed.newHoldings).toBe(1);
    expect(fixed.skippedDuplicates).toBe(2); // SYNA + SYNC unchanged statement rows
    expect(bad.batchId).not.toBe(fixed.batchId);
    // Supersession is in-place: no leftover tombstone anywhere.
    expect(reconRows(db)).toHaveLength(0);
  });

  it("a statement re-import never overwrites an existing statement row (statement-vs-statement preserved)", async () => {
    await importHoldings(db, D0, [A, B, C]);
    // Same date, same securities, different quantities → source_key collides
    // on the (account, security, date) slot; the existing statement row wins.
    const second = await importHoldings(db, D0, [
      { symbol: "SYNA", quantity: 999 },
      B,
      C,
    ]);
    expect(second.newHoldings).toBe(0);
    expect(holdingRow(db, "SYNA", D0)!.quantity).toBe(10);
  });
});

// ── 2. ownership wiring ─────────────────────────────────────────────────

describe("tombstone ownership", () => {
  it("post-commit reconcile stamps this batch's id on its own accounts' tombstones", async () => {
    await importHoldings(db, D0, [A, B, C]);
    const bad = await importHoldings(db, D, [A, C]);

    const tombs = reconRows(db);
    expect(tombs).toHaveLength(1);
    expect(tombs[0].quantity).toBe(0);
    expect(tombs[0].as_of_date).toBe(D);
    expect(tombs[0].import_batch_id).toBe(bad.batchId);
  });

  it("never stamps a tombstone for an account this batch did not import", async () => {
    // Roth's book is set up by direct SQL — no import batch of its own — so
    // the taxable import's (global) post-commit reconcile is what retires
    // SYNY. That tombstone belongs to no batch.
    const roth = accountId(db, ROTH);
    const x = seedSecurity(db, "SYNX");
    const y = seedSecurity(db, "SYNY");
    const z = seedSecurity(db, "SYNZ");
    seedHolding(db, roth, x, 5, D0);
    seedHolding(db, roth, y, 5, D0);
    seedHolding(db, roth, z, 5, D0);
    seedHolding(db, roth, x, 5, D);
    seedHolding(db, roth, z, 5, D);

    await importHoldings(db, D0, [A, B, C]);
    const bad = await importHoldings(db, D, [A, C]);

    const rothTomb = holdingRow(db, "SYNY", D, ROTH)!;
    expect(rothTomb.quantity).toBe(0);
    expect(rothTomb.source_key.startsWith("recon:closed-equity:")).toBe(true);
    expect(rothTomb.import_batch_id).toBeNull();
    // The importing account's own tombstone IS owned.
    expect(holdingRow(db, "SYNB", D)!.import_batch_id).toBe(bad.batchId);
  });

  it("a deduped retry still owns the tombstone it mints", async () => {
    await importHoldings(db, D0, [A, B, C]);
    await importHoldings(db, D, [A, C]);
    // Someone removed the tombstone (a manual repair, a partial restore…).
    db.prepare("DELETE FROM holdings WHERE source_key LIKE 'recon:closed-equity:%'").run();

    // Re-import the IDENTICAL file: every holdings row dedupes, so no row is
    // stamped with the retry batch id — ownership must come from
    // parsed.holdings' account names instead.
    const retry = await importHoldings(db, D, [A, C], { filename: "retry.csv" });
    expect(retry.newHoldings).toBe(0);
    expect(retry.skippedDuplicates).toBe(2);

    const tombs = reconRows(db);
    expect(tombs).toHaveLength(1);
    expect(tombs[0].import_batch_id).toBe(retry.batchId);
  });
});

// ── 3. undo rebuild ─────────────────────────────────────────────────────

describe("undoImport tombstone rebuild", () => {
  it("removes owned tombstones and leaves the prior non-zero row latest again", async () => {
    await importHoldings(db, D0, [A, B, C]);
    const bad = await importHoldings(db, D, [A, C]);
    expect(reconRows(db)).toHaveLength(1);

    undoImport(db, bad.batchId);

    expect(reconRows(db)).toHaveLength(0);
    const latest = latestRow(db, "SYNB")!;
    expect(latest.as_of_date).toBe(D0);
    expect(latest.quantity).toBe(20);
  });

  it("removes a NULL-batch tombstone orphaned by the undo of its justifying snapshot", async () => {
    await importHoldings(db, D0, [A, B, C]);
    const bad = await importHoldings(db, D, [A, C]);
    // Pretend the tombstone was minted by a sync, not by this batch.
    db.prepare(
      "UPDATE holdings SET import_batch_id = NULL WHERE source_key LIKE 'recon:closed-equity:%'",
    ).run();

    undoImport(db, bad.batchId);

    // Its same-date statement evidence went with the batch → orphan → gone.
    expect(reconRows(db)).toHaveLength(0);
    expect(latestRow(db, "SYNB")!.as_of_date).toBe(D0);
  });

  it("undo of a correcting batch re-derives the original tombstone at its original date", async () => {
    await importHoldings(db, D0, [A, B, C]);
    const bad = await importHoldings(db, D, [A, C]);
    const fixed = await importHoldings(db, D, [A, B, C]);
    expect(reconRows(db)).toHaveLength(0);

    undoImport(db, fixed.batchId);

    const tomb = holdingRow(db, "SYNB", D)!;
    expect(tomb.quantity).toBe(0);
    expect(tomb.source_key.startsWith("recon:closed-equity:")).toBe(true);
    expect(tomb.source_key.endsWith(":stmt")).toBe(true);
    // Re-derived by the unowned sweep, not restored with a batch stamp.
    expect(tomb.import_batch_id).toBeNull();
    // The bad batch's own snapshot rows are untouched by the undo.
    expect(holdingRow(db, "SYNA", D)!.import_batch_id).toBe(bad.batchId);
  });

  it("a sync-minted (NULL-batch) tombstone survives an unrelated account's undo", async () => {
    await importHoldings(db, D0, [A, B, C]);
    await importHoldings(db, D, [A, C]);
    db.prepare("DELETE FROM holdings WHERE source_key LIKE 'recon:closed-equity:%'").run();
    // Re-mint it the way a sync would: unowned.
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(reconRows(db)[0].import_batch_id).toBeNull();

    // An unrelated batch in a DIFFERENT account.
    const other = await importHoldings(
      db,
      D,
      [{ symbol: "SYNX", quantity: 5 }, { symbol: "SYNZ", quantity: 5 }],
      { account: ROTH, filename: "roth.csv" },
    );
    undoImport(db, other.batchId);

    const tomb = holdingRow(db, "SYNB", D)!;
    expect(tomb).toBeDefined();
    expect(tomb.quantity).toBe(0);
    expect(tomb.import_batch_id).toBeNull();
  });
});

// ── 4. sweep-failure surfacing ──────────────────────────────────────────

describe("post-commit sweep failures", () => {
  it("a reconcile failure surfaces as a domain warning + summary marker, import still succeeds", async () => {
    await importHoldings(db, D0, [A, B, C]);
    hoisted.reconcileThrows = true;

    const res = await importHoldings(db, D, [A, C]);

    expect(res.newHoldings).toBe(2); // the import itself committed
    const joined = res.warnings.join("\n");
    expect(joined).toContain("closed-position reconcile failed");
    expect(joined).toContain("next sync");
    // Stable domain language only — the raw exception stays in the server log.
    expect(joined).not.toContain("SQLITE_BUSY");
    expect(joined).not.toContain("/Users/");
    expect(batchSummary(db, res.batchId)).toContain("reconcile failed");
    // A sweep warning is NOT corporate-action evidence.
    expect(res.corporateActionWarningCount).toBe(0);
    expect(reconRows(db)).toHaveLength(0);
  });

  it("an expired-option purge failure surfaces the same way", async () => {
    hoisted.expiredPurgeThrows = true;
    const res = await importHoldings(db, D0, [A, B, C]);

    const joined = res.warnings.join("\n");
    expect(joined).toContain("expired-option purge failed");
    expect(joined).not.toContain("SQLITE_BUSY");
    expect(batchSummary(db, res.batchId)).toContain("expired-option purge failed");
  });

  it("a matured-bond purge failure surfaces the same way", async () => {
    hoisted.maturedPurgeThrows = true;
    const res = await importHoldings(db, D0, [A, B, C]);

    const joined = res.warnings.join("\n");
    expect(joined).toContain("matured-bond purge failed");
    expect(joined).not.toContain("SQLITE_BUSY");
    expect(batchSummary(db, res.batchId)).toContain("matured-bond purge failed");
  });

  it("a clean import carries no sweep warnings and no summary marker", async () => {
    const res = await importHoldings(db, D0, [A, B, C]);
    expect(res.warnings).toEqual([]);
    expect(batchSummary(db, res.batchId)).not.toContain("failed");
  });
});

// ── 5. tax generation bumps ─────────────────────────────────────────────

describe("tax input generation", () => {
  it("bumps when an import writes holdings, and not on a fully-deduped re-import", async () => {
    const before = getTaxInputGeneration(db);

    const first = await importHoldings(db, D0, [A, B, C]);
    expect(first.newHoldings).toBe(3);
    expect(first.newTransactions).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(before + 1);

    const again = await importHoldings(db, D0, [A, B, C], { filename: "again.csv" });
    expect(again.newHoldings).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("bumps when an imported price can change a tombstoned security's synthetic close", async () => {
    await importHoldings(db, D0, [A, B, C]);
    await importHoldings(db, D, [A, C]); // SYNB tombstoned at D
    const before = getTaxInputGeneration(db);

    const res = await importPrices(db, [
      { symbol: "SYNB", date: "2026-06-15", close: 12.5 },
    ]);

    expect(res.newPrices).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("does not bump for a still-held security's price", async () => {
    await importHoldings(db, D0, [A, B, C]);
    await importHoldings(db, D, [A, C]);
    const before = getTaxInputGeneration(db);

    const res = await importPrices(db, [
      { symbol: "SYNA", date: "2026-06-15", close: 12.5 },
    ]);

    expect(res.newPrices).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(before);
  });
});

// ── 6. route replay evidence ────────────────────────────────────────────

const CA_CSV = fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "ibkr-corporate-actions.csv"),
  "utf-8",
);

interface ImportRouteResponse {
  success: boolean;
  results: Array<{
    filename: string;
    success: boolean;
    warnings?: string[];
    committed?: { newCorporateActions: number; [k: string]: unknown };
  }>;
  replay: { status: "clean" | "mismatch" | "failed"; warnings: string[] } | null;
}

function importReq(files: { name: string; content: string }[]): NextRequest {
  const fd = new FormData();
  for (const f of files) {
    fd.append("files", new File([f.content], f.name, { type: "text/csv" }));
  }
  return new NextRequest("http://test/api/import?mode=commit", {
    method: "POST",
    body: fd,
  });
}

describe("POST /api/import — corporate-action replay evidence", () => {
  it("sweep warnings alone do not produce a replay status", async () => {
    await importHoldings(hoisted.db, D0, [A, B, C]);
    hoisted.reconcileThrows = true;

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq([{ name: "holdings.csv", content: holdingsCsv(D, [A, C]) }]),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    expect(body.success).toBe(true);
    expect(body.results[0].warnings!.join("\n")).toContain(
      "closed-position reconcile failed",
    );
    expect(body.results[0].committed!.newCorporateActions).toBe(0);
    // The sweep warning is not corporate-action evidence → no replay object.
    expect(body.replay).toBeNull();
  });

  it("a commit-time corporate-action warning still produces a replay status", async () => {
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq([{ name: "ibkr-corporate-actions.csv", content: CA_CSV }]),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportRouteResponse;
    // Every symbol is unknown → 0 committed actions, but real CA warnings.
    expect(body.results[0].committed!.newCorporateActions).toBe(0);
    expect(body.results[0].warnings!.join("\n")).toContain("no known security");
    expect(body.replay).not.toBeNull();
  });
});
