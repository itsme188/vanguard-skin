/**
 * API contract tests for the number-trust durable-fixes work (2026-08-23
 * spec, task 20 — Codex plan review #11: these invoke the ACTUAL route
 * handlers, not just the underlying compute/query functions, so a route
 * that forgets to thread a field through the envelope fails here even when
 * the lib function itself is correct.
 *
 * Pattern mirrors tests/api/levels-route.test.ts: a `vi.hoisted` mutable db
 * getter backs `@/lib/db`, a real in-memory SQLite instance (migrated via
 * runMigrations) is swapped in per test, and the route modules are imported
 * normally (vi.mock is hoisted above imports by Vitest).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import {
  stampTaxLotsConvention,
  stampBrokerAcceptance,
} from "@/lib/compute/tax-convention";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// /api/summary also calls getTwsStatus() — stub it so the route never
// touches a real TWS socket; unrelated to what this file verifies.
vi.mock("@/lib/tws/client", () => ({
  getTwsStatus: () => ({ state: "disconnected" as const }),
}));

import { GET as trustStateGET } from "@/app/api/analysis/trust-state/route";
import { GET as dataConfidenceGET } from "@/app/api/data-confidence/route";
import { GET as summaryGET } from "@/app/api/summary/route";
import { GET as taxReportGET } from "@/app/api/tax-report/route";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
});

// ── Seed helpers ─────────────────────────────────────────────────────

function seedAccount(name: string): number {
  return db
    .prepare("INSERT INTO accounts (name) VALUES (?)")
    .run(name).lastInsertRowid as number;
}

function seedSecurity(
  symbol: string,
  opts: { type?: string; fundCategory?: string } = {}
): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)"
    )
    .run(symbol, `${symbol} Corp`, opts.type ?? "Stock", opts.fundCategory ?? null)
    .lastInsertRowid as number;
}

/** Predicate-2 type-identity contradiction (bond type + equity-shaped
 *  fund_category), HELD — the cheapest fixture that trips a critical
 *  integrity hit (lib/compute/type-contradictions.ts's PREDICATE_2_SQL).
 *  Everything else about the account is seeded FRESH (today's price,
 *  today's holdings, a recent statement anchor, full valuation coverage)
 *  so the pre-cap weighted score lands "high" — otherwise the 5 weighted
 *  dimensions alone would already read "stale" (score <20) with no data at
 *  all, and the cap's monotonic-only rule (never promotes a level) would
 *  make "stale" indistinguishable from a capped "high"/"medium". Seeding a
 *  healthy base is what proves the cap — not the absence of other data —
 *  is what pins the level to "low". */
function seedCriticalIntegrityHit(): { accountId: number; securityId: number } {
  const today = new Date().toISOString().slice(0, 10);
  const accountId = seedAccount("Test Account");
  const securityId = seedSecurity("BADBOND", {
    type: "bond",
    fundCategory: "US Sector Equity Test",
  });
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)"
  ).run(accountId, securityId, 10, today);
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, 100, today);
  db.prepare(
    "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, 'canonical')"
  ).run(accountId, today, 1000);
  db.prepare(
    `INSERT INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
     VALUES (?, ?, 0, 1000, 1000, 1, 1)`
  ).run(accountId, today);
  return { accountId, securityId };
}

/** One closed, gain (never loss, to sidestep wash-sale heuristics), USD,
 *  long-term sale — enough for generateTaxReport's filingOnly query plus
 *  the filingReady account-universe query. */
function seedTaxSale(year: number): { accountId: number; securityId: number } {
  const accountId = seedAccount("Test Account");
  const securityId = seedSecurity("AAPL", { type: "Stock" });
  const saleTxnId = db
    .prepare(
      "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount) VALUES (?, ?, ?, 'SELL', ?, ?)"
    )
    .run(accountId, securityId, `${year}-06-15`, 10, 1500).lastInsertRowid as number;
  const taxLotId = db
    .prepare(
      `INSERT INTO tax_lots
         (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(accountId, securityId, `${year - 1}-01-10`, 100, 10, 0, 1000).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO tax_lot_sales
       (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(taxLotId, saleTxnId, 10, 150, 1500, 1000, 500, 1, 400, `${year}-06-15`);
  return { accountId, securityId };
}

/** Pure-Node recursive .ts/.tsx source scan (no shelling out to rg/grep —
 *  the harness's `rg`/`grep` are interactive-shell functions, not real
 *  binaries on PATH for a child process, so this stays portable). Mirrors
 *  `rg -n "<pattern>" app/ lib/ --type ts`. */
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".claude", ".git"]);

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every "path:line:content" hit for `pattern` across app/ and lib/, EXCLUDING
 *  hits that only appear after a `//` on their line (e.g. "renamed from X"). */
function nonCommentSourceHits(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const top of ["app", "lib"]) {
    const dir = path.resolve(process.cwd(), top);
    for (const file of collectSourceFiles(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const matchIdx = line.search(pattern);
        if (matchIdx === -1) return;
        const commentIdx = line.indexOf("//");
        if (commentIdx !== -1 && commentIdx < matchIdx) return; // comment-only hit
        hits.push(`${path.relative(process.cwd(), file)}:${i + 1}:${line.trim()}`);
      });
    }
  }
  return hits;
}

// ── 1. GET /api/analysis/trust-state ─────────────────────────────────

describe("GET /api/analysis/trust-state", () => {
  it("200s with {success,data}; crossCheckedThru + perAccountReconciliation[].band/bandHistory present", async () => {
    const acctId = seedAccount("Test Account");
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, 'canonical')"
    ).run(acctId, "2026-01-31", 10000);
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, 'canonical')"
    ).run(acctId, "2026-02-28", 10500);

    const res = await trustStateGET(
      new NextRequest("http://localhost/api/analysis/trust-state") as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty("crossCheckedThru");
    expect(Array.isArray(body.data.perAccountReconciliation)).toBe(true);
    expect(body.data.perAccountReconciliation.length).toBeGreaterThan(0);
    for (const row of body.data.perAccountReconciliation) {
      expect(row).toHaveProperty("band");
      expect(row).toHaveProperty("bandHistory");
      expect(Array.isArray(row.bandHistory)).toBe(true);
    }

    expect(JSON.stringify(body)).not.toContain("performanceReconciledThru");
  });

  it("has zero non-comment source references to the retired performanceReconciledThru/withinTolerance names", () => {
    const hits = nonCommentSourceHits(/performanceReconciledThru|withinTolerance/);
    expect(hits).toEqual([]);
  });
});

// ── 2. GET /api/data-confidence ───────────────────────────────────────

describe("GET /api/data-confidence", () => {
  it("envelope carries capReason/integrity/timingResidual; caps score <=45 and level low under a critical", async () => {
    seedCriticalIntegrityHit();

    const res = await dataConfidenceGET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty("capReason");
    expect(body.data.capReason).toBeTruthy();
    expect(body.data.integrity).toHaveProperty("critical");
    expect(body.data.integrity).toHaveProperty("warnings");
    expect(body.data.integrity.critical.length).toBeGreaterThan(0);
    expect(body.data).toHaveProperty("cashAccuracy.timingResidual");

    expect(body.data.overallScore).toBeLessThanOrEqual(45);
    expect(body.data.overallLevel).toBe("low");
  });
});

// ── 3. GET /api/summary ───────────────────────────────────────────────

describe("GET /api/summary", () => {
  it("confidenceScore equals the CAPPED getDataConfidence value under the same critical fixture", async () => {
    seedCriticalIntegrityHit();
    const expected = getDataConfidence(db);
    expect(expected.overallScore).toBeLessThanOrEqual(45); // sanity: fixture really trips the cap

    const res = await summaryGET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.confidenceScore).toBe(expected.overallScore);
    expect(body.confidenceLevel).toBe(expected.overallLevel);
    expect(body.confidenceScore).toBeLessThanOrEqual(45);
  });
});

// ── 4. GET /api/tax-report ────────────────────────────────────────────

describe("GET /api/tax-report", () => {
  const YEAR = 2026;

  it("filingReady is false pre-stamp in the JSON body", async () => {
    seedTaxSale(YEAR);

    const res = await taxReportGET(
      new NextRequest(`http://localhost/api/tax-report?year=${YEAR}`) as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.filingReady).toBe(false);
  });

  it.each(["csv", "txf"] as const)(
    "%s download Content-Disposition carries the NOT-FOR-FILING pre-stamp name, then the clean name once stamped",
    async (format) => {
      const { accountId } = seedTaxSale(YEAR);
      const expectedBase = format === "csv" ? `form-8949-${YEAR}` : `tax-report-${YEAR}`;

      const preRes = await taxReportGET(
        new NextRequest(`http://localhost/api/tax-report?year=${YEAR}&format=${format}`) as never
      );
      expect(preRes.status).toBe(200);
      const preDisposition = preRes.headers.get("Content-Disposition");
      expect(preDisposition).toContain(`${expectedBase}-NOT-FOR-FILING.${format}`);

      stampTaxLotsConvention(db);
      stampBrokerAcceptance(db, [{ accountId, taxYear: YEAR }]);

      const postRes = await taxReportGET(
        new NextRequest(`http://localhost/api/tax-report?year=${YEAR}&format=${format}`) as never
      );
      expect(postRes.status).toBe(200);
      const postDisposition = postRes.headers.get("Content-Disposition");
      expect(postDisposition).toContain(`${expectedBase}.${format}`);
      expect(postDisposition).not.toContain("NOT-FOR-FILING");

      const jsonRes = await taxReportGET(
        new NextRequest(`http://localhost/api/tax-report?year=${YEAR}`) as never
      );
      const jsonBody = await jsonRes.json();
      expect(jsonBody.data.filingReady).toBe(true);
    }
  );
});
