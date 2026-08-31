# Reconciler Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make closed-position tombstones supersedable, batch-owned, and orphan-cleanable, surface reconcile failures at import time, and close the fail-open tax-invalidation holes around them.

**Architecture:** Tombstones (`recon:closed-equity:` holdings rows) become a derived layer with recorded provenance: an origin suffix (`:stmt`/`:live`) makes supersession directional (statement-wins preserved), batch ownership + origin-aware orphan cleanup make undo/restore correct, and every writer that can create/consume a tombstone or a synthetic-close price bumps the tax input generation (fail-closed, scoped so daily syncs never bump).

**Tech Stack:** TypeScript 5, better-sqlite3 (in-memory for tests), Vitest, Next.js 16 API routes, React 19.

**Spec:** `docs/superpowers/specs/2026-08-30-reconciler-hardening-design.md` (rev 4, 3× Codex-reviewed). Read it before implementing any task.

## Global Constraints

- All test/script runs: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <file>` (node@24 pin).
- Every DB function takes `db: Database.Database` (DI). Tests use `new Database(":memory:")` + `runMigrations(db)`.
- Never inline a source-class `LIKE` — use the `lib/db/holding-sources.ts` helpers.
- Committed tests use SYNTHETIC symbols/quantities only (repo is public).
- Commit messages: write to a temp file, `git commit -F <file>` (never inline `-m`).
- No schema migration — all columns exist (`holdings.import_batch_id`, `import_batches.summary`).
- The static guard `tests/repo/no-handrolled-latest-holdings.test.ts` polices all diffs — if it fires, fix the query shape, don't allowlist without justification.

## Task dependency graph (for parallel SDD)

```
Wave 1 (parallel): T1 (holding-sources helpers), T2 (price bump helper), T8 (ImportHistory UI)
Wave 2:            T3 (reconciler core) — needs T1
Wave 3 (parallel): T4 (engine commit/undo/route) — needs T1,T2,T3
                   T5 (Plaid writer)             — needs T1,T2,T3
                   T6 (TWS + IBKR writers)       — needs T2,T3
Wave 4:            T7 (recovery restore)         — needs T1,T3,T4 (T4 changes
                   deleteImportBatch semantics that import-undo-recovery.test.ts
                   exercises; T7 exclusively owns that test file)
Wave 5:            T9 (integration suite + docs) — needs T4–T7
Wave 6:            T10 (full suite + browser E2E) — needs all
```

No two tasks modify the same file. T4 owns `lib/import/engine.ts` + `lib/mutations/import-batches.ts` + `app/api/import/route.ts` entirely; `tests/api/import-undo-recovery.test.ts` belongs to T7 alone — T4 must not edit it (see T4 Step 4).

---

### Task 1: holding-sources — recon prefix, origin suffixes, overwritable-SQL helpers

**Files:**
- Modify: `lib/db/holding-sources.ts`
- Test: `tests/db/holding-sources.test.ts` (extend)

**Interfaces:**
- Consumes: existing `LIVE_HOLDING_SOURCE_PREFIXES`, `statementSourcedHoldingSql`.
- Produces (used by T3–T7):
  - `RECON_HOLDING_SOURCE_PREFIX = "recon:closed-equity:"`
  - `RECON_STMT_SUFFIX = ":stmt"`, `RECON_LIVE_SUFFIX = ":live"`
  - `statementOverwritableHoldingSql(col = "holdings.source_key"): string` — parenthesized OR-chain: live prefixes + ANY recon row.
  - `liveOverwritableHoldingSql(col = "holdings.source_key"): string` — live prefixes + only recon rows ending `:live`.

- [ ] **Step 1: Write the failing tests** — append to `tests/db/holding-sources.test.ts`:

```ts
import {
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_STMT_SUFFIX,
  RECON_LIVE_SUFFIX,
  statementOverwritableHoldingSql,
  liveOverwritableHoldingSql,
} from "@/lib/db/holding-sources";

describe("recon tombstone constants", () => {
  it("prefix and suffixes contain no LIKE wildcards or quotes", () => {
    for (const s of [RECON_HOLDING_SOURCE_PREFIX, RECON_STMT_SUFFIX, RECON_LIVE_SUFFIX]) {
      expect(s).not.toMatch(/[%_'"]/);
    }
    expect(RECON_HOLDING_SOURCE_PREFIX).toBe("recon:closed-equity:");
  });
});

describe("overwritable holding SQL", () => {
  // Behavioral pin via a real SQLite round-trip, not string equality.
  function matches(sql: string, sourceKey: string): boolean {
    const db = new Database(":memory:");
    try {
      return (
        db.prepare(`SELECT 1 AS hit WHERE ${sql.replace(/holdings\.source_key/g, "?")}`)
          // every occurrence binds the same value
          .get(...Array(sql.split("holdings.source_key").length - 1).fill(sourceKey)) != null
      );
    } finally {
      db.close();
    }
  }
  const stmtSql = statementOverwritableHoldingSql();
  const liveSql = liveOverwritableHoldingSql();

  it("statement writers may overwrite live rows and ANY tombstone", () => {
    for (const k of ["tws-1-2-2026-08-01", "plaid:1:2:2026-08-01",
      "recon:closed-equity:1:2:2026-08-01:stmt", "recon:closed-equity:1:2:2026-08-01:live",
      "recon:closed-equity:1:2:2026-08-01"]) {
      expect(matches(stmtSql, k)).toBe(true);
    }
    expect(matches(stmtSql, "canonical:hold:x")).toBe(false);
    expect(matches(stmtSql, "vanguard-pdf:holding:x")).toBe(false);
  });

  it("live writers may overwrite live rows and ONLY :live tombstones", () => {
    expect(matches(liveSql, "tws-1-2-2026-08-01")).toBe(true);
    expect(matches(liveSql, "plaid:1:2:2026-08-01")).toBe(true);
    expect(matches(liveSql, "recon:closed-equity:1:2:2026-08-01:live")).toBe(true);
    expect(matches(liveSql, "recon:closed-equity:1:2:2026-08-01:stmt")).toBe(false);
    // legacy unsuffixed = statement-grade (conservative)
    expect(matches(liveSql, "recon:closed-equity:1:2:2026-08-01")).toBe(false);
    expect(matches(liveSql, "canonical:hold:x")).toBe(false);
  });
});
```

(Import `Database from "better-sqlite3"` at top if the file doesn't already.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/holding-sources.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Implement** — in `lib/db/holding-sources.ts`, below the existing prefix lists:

```ts
/**
 * Engine-owned tombstone prefix (reconcileClosedEquityHoldings; always
 * quantity = 0). A tombstone is a DERIVED row, never authority: any real
 * row may supersede it, subject to the directional rules below. New
 * tombstones append an origin suffix recording the minting pass; legacy
 * rows have none and are treated as statement-grade (conservative).
 */
export const RECON_HOLDING_SOURCE_PREFIX = "recon:closed-equity:";
export const RECON_STMT_SUFFIX = ":stmt"; // minted by the statement pass
export const RECON_LIVE_SUFFIX = ":live"; // minted by the equity/option live passes

/**
 * SQL fragment: rows a STATEMENT-authority writer (import commit, recovery
 * restore) may overwrite in a same-slot upsert — live rows plus ANY
 * tombstone. Statement evidence outranks every tombstone origin.
 * Parenthesized; constants carry no wildcards/quotes (pinned by tests), so
 * direct interpolation stays safe in reused prepared statements.
 */
export function statementOverwritableHoldingSql(col = "holdings.source_key"): string {
  const live = LIVE_HOLDING_SOURCE_PREFIXES.map((p) => `${col} LIKE '${p}%'`);
  return `(${[...live, `${col} LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'`].join(" OR ")})`;
}

/**
 * SQL fragment: rows a LIVE writer (Plaid) may overwrite — live rows plus
 * only live-origin tombstones. A live row must never erase statement-derived
 * closure evidence: the statement pass's `latest < stmtDate` phantom test
 * cannot re-derive a tombstone masked by a same-date live row.
 */
export function liveOverwritableHoldingSql(col = "holdings.source_key"): string {
  const live = LIVE_HOLDING_SOURCE_PREFIXES.map((p) => `${col} LIKE '${p}%'`);
  return `(${[...live, `${col} LIKE '${RECON_HOLDING_SOURCE_PREFIX}%${RECON_LIVE_SUFFIX}'`].join(" OR ")})`;
}
```

Also update the file's header doc comment: the paragraph saying `recon:closed-equity:` lives "outside the taxonomy" stays true, but append one sentence: "Supersession of recon rows is directional — see statementOverwritableHoldingSql / liveOverwritableHoldingSql."

- [ ] **Step 4: Run to verify pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/holding-sources.test.ts tests/db/holding-sources-classify.test.ts`
Expected: PASS (classify test still green — `classifyHoldingSourceKey` untouched).

- [ ] **Step 5: Commit** — message: `feat(holdings): recon tombstone origin suffixes + directional overwritable-SQL helpers`

---

### Task 2: bumpIfPricesAffectSyntheticCloses helper

**Files:**
- Modify: `lib/compute/tax-convention.ts`
- Test: `tests/compute/tax-convention-price-bump.test.ts` (new)

**Interfaces:**
- Consumes: existing `bumpTaxGenerationIfPresent(db)`, `getTaxInputGeneration(db)` in the same file.
- Produces (used by T4, T5, T6): `bumpIfPricesAffectSyntheticCloses(db, pairs: { securityId: number; date: string }[]): boolean` — returns true when it bumped.

**Semantics (spec §4-Prices):** bump once when any pair's security is in tombstone state — some account's LATEST holdings row for it has `quantity = 0` — and the pair's date is at-or-before that zero date (capable of changing the `RECONCILE_CLOSE` selected price, which is the latest `prices` row `date <= zero_date`). Held securities (latest row non-zero) never bump.

- [ ] **Step 1: Write the failing tests** — `tests/compute/tax-convention-price-bump.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  bumpIfPricesAffectSyntheticCloses,
  getTaxInputGeneration,
} from "@/lib/compute/tax-convention";

let db: Database.Database;
let acctId: number;
let heldId: number;
let closedId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acctId = (db.prepare(`INSERT INTO accounts (name) VALUES ('T') RETURNING id`).get() as { id: number }).id;
  heldId = (db.prepare(`INSERT INTO securities (symbol, security_type) VALUES ('HELD', 'stock') RETURNING id`).get() as { id: number }).id;
  closedId = (db.prepare(`INSERT INTO securities (symbol, security_type) VALUES ('GONE', 'stock') RETURNING id`).get() as { id: number }).id;
  const ins = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?,?,?,?,?)`,
  );
  ins.run(acctId, heldId, 10, "2026-08-01", "canonical:hold:h1");
  ins.run(acctId, closedId, 5, "2026-07-01", "canonical:hold:c1");
  ins.run(acctId, closedId, 0, "2026-08-01", "recon:closed-equity:t:stmt"); // tombstone state
});

const gen = () => getTaxInputGeneration(db);

describe("bumpIfPricesAffectSyntheticCloses", () => {
  it("bumps for a price at-or-before a tombstoned security's zero date", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [{ securityId: closedId, date: "2026-07-15" }])).toBe(true);
    expect(gen()).toBe(before + 1);
  });
  it("bumps exactly once for many relevant pairs", () => {
    const before = gen();
    bumpIfPricesAffectSyntheticCloses(db, [
      { securityId: closedId, date: "2026-07-15" },
      { securityId: closedId, date: "2026-08-01" },
    ]);
    expect(gen()).toBe(before + 1);
  });
  it("does NOT bump for held securities (daily sync path)", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [{ securityId: heldId, date: "2026-08-30" }])).toBe(false);
    expect(gen()).toBe(before);
  });
  it("does NOT bump for a price AFTER the zero date", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [{ securityId: closedId, date: "2026-08-15" }])).toBe(false);
    expect(gen()).toBe(before);
  });
  it("no-ops on an empty pair list", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [])).toBe(false);
    expect(gen()).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/tax-convention-price-bump.test.ts`
Expected: FAIL — export not found.

- [ ] **Step 3: Implement** — append to `lib/compute/tax-convention.ts`:

```ts
/**
 * Fail-closed price invalidation for synthetic closes (spec 2026-08-30
 * reconciler-hardening §4). computeTaxLots' RECONCILE_CLOSE pass prices a
 * broker-closed position off the latest `prices` row at-or-before the
 * position's zero-quantity date — so a price write/delete in that window
 * changes realized tax output. Callers pass the (securityId, date) pairs
 * they mutated (capture BEFORE a delete); this bumps the generation once
 * when any pair can affect a synthetic close. Held securities (latest
 * holdings row non-zero) never match, so routine daily price syncs never
 * bump. Deliberately over-approximate: an older-than-selected price for a
 * tombstoned security still bumps — over-bump is fail-closed and cheap.
 */
export function bumpIfPricesAffectSyntheticCloses(
  db: Database.Database,
  pairs: { securityId: number; date: string }[],
): boolean {
  if (pairs.length === 0) return false;
  const stmt = db.prepare(
    `SELECT 1 AS hit FROM holdings h
      WHERE h.security_id = ? AND h.quantity = 0
        AND h.as_of_date >= ?
        AND h.as_of_date = (
          SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id)
      LIMIT 1`,
  );
  for (const p of pairs) {
    if (stmt.get(p.securityId, p.date) != null) {
      bumpTaxGenerationIfPresent(db);
      return true;
    }
  }
  return false;
}
```

(If `tax-convention.ts` lacks a `holdings` dependency note in its header, none is needed — it already runs against the app DB.)

- [ ] **Step 4: Run to verify pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/tax-convention-price-bump.test.ts tests/compute/ --silent 2>&1 | tail -5`
Expected: new file PASS; existing tax-convention tests still green.

- [ ] **Step 5: Commit** — `feat(tax): bumpIfPricesAffectSyntheticCloses — scoped price invalidation for RECONCILE_CLOSE inputs`

---

### Task 3: Reconciler core — ownership, origin suffix, transaction, bump, orphan cleanup, detection helpers

**Files:**
- Modify: `lib/mutations/closed-equity.ts`
- Test: `tests/mutations/closed-equity.test.ts` (extend) + `tests/mutations/closed-equity-orphans.test.ts` (new)

**Interfaces:**
- Consumes (T1): `RECON_HOLDING_SOURCE_PREFIX`, `RECON_STMT_SUFFIX`, `RECON_LIVE_SUFFIX`, `statementSourcedHoldingSql`.
- Produces (used by T4–T7):
  - `ReconcileClosedEquityOptions` gains `importBatchId?: number; ownedAccountIds?: number[]`.
  - `removeOrphanedReconTombstones(db, opts?: { accountIds?: number[] }): number`
  - `zeroLatestSecurityIds(db, accountId: number): Set<number>` — securities whose latest row for that account is quantity 0.
  - `countReconRowsOnDate(db, accountId: number, date: string): number`

- [ ] **Step 1: Write the failing tests.** Extend `tests/mutations/closed-equity.test.ts` (reuse its `acct`/`sec` helpers; add imports):

```ts
import {
  removeOrphanedReconTombstones,
  zeroLatestSecurityIds,
  countReconRowsOnDate,
} from "@/lib/mutations/closed-equity";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

// NOTE: tests/mutations/closed-equity.test.ts ALREADY defines a `hold()`
// helper near line 41 — REUSE it, do not redefine (it won't compile twice in
// one scope). In the NEW file (closed-equity-orphans.test.ts) copy that
// helper along with acct()/sec().

describe("tombstone provenance + ownership", () => {
  it("statement-pass tombstones carry :stmt suffix; live-pass carry :live", () => {
    const a = acct("A1");
    const x = sec("XONE");
    const y = sec("YTWO", "etf");
    // statement book at D1 has both; statement book at D2 has only Y → X phantom (stmt pass)
    hold(a, x, 5, "2026-07-31", "canonical:hold:x1");
    hold(a, y, 5, "2026-07-31", "canonical:hold:y1");
    hold(a, y, 5, "2026-08-29", "canonical:hold:y2");
    reconcileClosedEquityHoldings(db);
    const tomb = db
      .prepare(`SELECT source_key FROM holdings WHERE quantity = 0 AND security_id = ?`)
      .get(x) as { source_key: string };
    expect(tomb.source_key.startsWith("recon:closed-equity:")).toBe(true);
    expect(tomb.source_key.endsWith(":stmt")).toBe(true);
  });

  it("stamps import_batch_id only for owned accounts", () => {
    const a1 = acct("A1");
    const a2 = acct("A2");
    const x = sec("XONE");
    const z = sec("ZTHR");
    const batchId = (
      db.prepare(`INSERT INTO import_batches (source_type) VALUES ('canonical-csv') RETURNING id`).get() as { id: number }
    ).id;
    // both accounts have a phantom vs their latest statement snapshots
    hold(a1, x, 5, "2026-07-31", "canonical:hold:1");
    hold(a1, sec("KEEP1"), 5, "2026-08-29", "canonical:hold:2");
    hold(a2, z, 5, "2026-07-31", "canonical:hold:3");
    hold(a2, sec("KEEP2"), 5, "2026-08-29", "canonical:hold:4");
    reconcileClosedEquityHoldings(db, { importBatchId: batchId, ownedAccountIds: [a1] });
    const owned = db.prepare(`SELECT import_batch_id FROM holdings WHERE quantity=0 AND account_id=?`).get(a1) as { import_batch_id: number | null };
    const unowned = db.prepare(`SELECT import_batch_id FROM holdings WHERE quantity=0 AND account_id=?`).get(a2) as { import_batch_id: number | null };
    expect(owned.import_batch_id).toBe(batchId);
    expect(unowned.import_batch_id).toBeNull();
  });

  it("bumps the tax generation when it marks anything, not when it marks nothing", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 5, "2026-07-31", "canonical:hold:1");
    hold(a, sec("KEEP1"), 5, "2026-08-29", "canonical:hold:2");
    const g0 = getTaxInputGeneration(db);
    expect(reconcileClosedEquityHoldings(db)).toBeGreaterThan(0);
    const g1 = getTaxInputGeneration(db);
    expect(g1).toBe(g0 + 1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0); // idempotent second run
    expect(getTaxInputGeneration(db)).toBe(g1);        // no bump on no-op
  });
});

describe("run atomicity", () => {
  it("a mid-run failure leaves zero tombstones from that run", () => {
    // The run is transactional (savepoint when nested): a throw after the
    // reconcile inside an outer transaction must roll its tombstones back.
    const a = acct("A1");
    hold(a, sec("XONE"), 5, "2026-07-31", "canonical:hold:1");
    hold(a, sec("KEEP1"), 5, "2026-08-29", "canonical:hold:2");
    expect(() =>
      db.transaction(() => {
        reconcileClosedEquityHoldings(db);
        throw new Error("injected");
      })(),
    ).toThrow("injected");
    expect(db.prepare(`SELECT COUNT(*) c FROM holdings WHERE quantity=0`).get()).toEqual({ c: 0 });
  });
});

describe("detection helpers", () => {
  it("zeroLatestSecurityIds returns securities whose latest row is quantity 0", () => {
    const a = acct("A1");
    const x = sec("XONE");
    const y = sec("YTWO");
    hold(a, x, 5, "2026-07-01", "canonical:hold:1");
    hold(a, x, 0, "2026-08-01", "recon:closed-equity:t1:stmt");
    hold(a, y, 5, "2026-08-01", "canonical:hold:2");
    const s = zeroLatestSecurityIds(db, a);
    expect(s.has(x)).toBe(true);
    expect(s.has(y)).toBe(false);
  });
  it("countReconRowsOnDate counts recon rows for (account, date)", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t1:live");
    hold(a, sec("YTWO"), 5, "2026-08-01", "canonical:hold:1");
    expect(countReconRowsOnDate(db, a, "2026-08-01")).toBe(1);
    expect(countReconRowsOnDate(db, a, "2026-08-02")).toBe(0);
  });
});
```

New file `tests/mutations/closed-equity-orphans.test.ts` (same beforeEach/acct/sec/hold idiom as above — copy the helpers):

```ts
describe("removeOrphanedReconTombstones", () => {
  it(":stmt tombstone requires surviving same-date STATEMENT row — same-date Plaid row is not evidence", () => {
    const a = acct("A1");
    const x = sec("XONE");
    hold(a, x, 0, "2026-08-01", "recon:closed-equity:t:stmt");
    hold(a, sec("OTHER"), 5, "2026-08-01", "plaid:1:9:2026-08-01"); // live row, same date
    expect(removeOrphanedReconTombstones(db)).toBe(1); // orphaned despite plaid row
  });
  it(":stmt tombstone survives while a same-date statement row exists", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t:stmt");
    hold(a, sec("OTHER"), 5, "2026-08-01", "canonical:hold:1");
    expect(removeOrphanedReconTombstones(db)).toBe(0);
  });
  it("legacy unsuffixed tombstone is statement-grade", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:1:2:2026-08-01");
    hold(a, sec("OTHER"), 5, "2026-08-01", "plaid:1:9:2026-08-01");
    expect(removeOrphanedReconTombstones(db)).toBe(1);
  });
  it(":live tombstone survives on ANY same-date non-recon row, orphans when none remains", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t:live");
    hold(a, sec("OTHER"), 5, "2026-08-01", "plaid:1:9:2026-08-01");
    expect(removeOrphanedReconTombstones(db)).toBe(0);
    db.prepare(`DELETE FROM holdings WHERE source_key = 'plaid:1:9:2026-08-01'`).run();
    expect(removeOrphanedReconTombstones(db)).toBe(1);
  });
  it("scopes to accountIds when given and bumps generation only when it deletes", () => {
    const a1 = acct("A1");
    const a2 = acct("A2");
    hold(a1, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t1:stmt"); // orphan
    hold(a2, sec("YTWO"), 0, "2026-08-01", "recon:closed-equity:t2:stmt"); // orphan, other account
    const g0 = getTaxInputGeneration(db);
    expect(removeOrphanedReconTombstones(db, { accountIds: [a1] })).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(g0 + 1);
    expect(db.prepare(`SELECT COUNT(*) c FROM holdings WHERE account_id=? AND quantity=0`).get(a2)).toEqual({ c: 1 });
    expect(removeOrphanedReconTombstones(db, { accountIds: [a1] })).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(g0 + 1); // no bump on no-op
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/mutations/closed-equity.test.ts tests/mutations/closed-equity-orphans.test.ts`
Expected: FAIL — new exports missing, suffix assertions fail.

- [ ] **Step 3: Implement in `lib/mutations/closed-equity.ts`:**

Imports to add:

```ts
import {
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_STMT_SUFFIX,
  RECON_LIVE_SUFFIX,
  statementSourcedHoldingSql,
} from "@/lib/db/holding-sources";
import { bumpTaxGenerationIfPresent } from "@/lib/compute/tax-convention";
```

(a) Options:

```ts
export interface ReconcileClosedEquityOptions {
  accountId?: number;
  shrinkFloor?: number;
  /**
   * Batch-ownership hygiene (spec §2): when set, tombstones minted for
   * accounts in `ownedAccountIds` are stamped with this batch id so
   * undoImport removes them. NEVER stamps other accounts' tombstones.
   */
  importBatchId?: number;
  ownedAccountIds?: number[];
}
```

(b) `insertZeroStmt` gains the batch column:

```ts
const insertZeroStmt = db.prepare(
  `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
   VALUES (?, ?, 0, 0, ?, ?, ?)`,
);
```

(c) `tombstone` gains an origin and applies ownership (replace existing fn; keep the doc comment, extend it with one line about the suffix):

```ts
const ownedAccounts = new Set(opts.ownedAccountIds ?? []);
const tombstone = (
  accountId: number,
  securityId: number,
  date: string,
  origin: typeof RECON_STMT_SUFFIX | typeof RECON_LIVE_SUFFIX,
): void => {
  const owned = opts.importBatchId != null && ownedAccounts.has(accountId);
  insertZeroStmt.run(
    accountId,
    securityId,
    date,
    `${RECON_HOLDING_SOURCE_PREFIX}${accountId}:${securityId}:${date}${origin}`,
    owned ? opts.importBatchId! : null,
  );
  marked++;
};
```

Pass-1 call sites use `tombstone(accountId, p.security_id, stmtDate, RECON_STMT_SUFFIX)`; passes 2/3 use `RECON_LIVE_SUFFIX`.

(d) Wrap the whole account loop + bump in a transaction. The function body after the prepared statements becomes:

```ts
let marked = 0;
// … tombstone(), passesShrinkGuard() defined here …
db.transaction(() => {
  for (const { id: accountId } of accounts) {
    // … existing pass 1 / 2 / 3 bodies unchanged except tombstone(origin) …
  }
  // Tombstone creation changes RECONCILE_CLOSE synthesis in computeTaxLots —
  // a tax event regardless of caller (spec §4). Inside the transaction so a
  // rollback takes the bump with it.
  if (marked > 0) bumpTaxGenerationIfPresent(db);
})();
return marked;
```

(e) Append the three new exports:

```ts
/**
 * Deletes recon tombstones whose justifying same-date evidence is gone
 * (spec §2, origin-aware): a tombstone's date IS its reference snapshot's
 * date, so validity requires a surviving same-(account, date) real row —
 * statement-sourced for `:stmt`/legacy tombstones (a same-date live row is
 * NOT statement evidence), any non-recon row for `:live`. History-preserving
 * by design: never a wholesale rebuild, which would re-land tombstones on
 * current reference dates and silently move historical close dates.
 * Bumps the tax generation when it deletes. Returns rows deleted.
 */
export function removeOrphanedReconTombstones(
  db: Database.Database,
  opts: { accountIds?: number[] } = {},
): number {
  const ids = opts.accountIds ?? [];
  const acctFilter = ids.length > 0 ? `AND account_id IN (${ids.map(() => "?").join(",")})` : "";
  return db.transaction(() => {
    const res = db
      .prepare(
        `DELETE FROM holdings
          WHERE source_key LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'
            ${acctFilter}
            AND CASE WHEN source_key LIKE '%${RECON_LIVE_SUFFIX}'
              THEN NOT EXISTS (
                SELECT 1 FROM holdings h2
                 WHERE h2.account_id = holdings.account_id
                   AND h2.as_of_date = holdings.as_of_date
                   AND h2.source_key NOT LIKE '${RECON_HOLDING_SOURCE_PREFIX}%')
              ELSE NOT EXISTS (
                SELECT 1 FROM holdings h2
                 WHERE h2.account_id = holdings.account_id
                   AND h2.as_of_date = holdings.as_of_date
                   AND ${statementSourcedHoldingSql("h2.source_key")})
            END`,
      )
      .run(...ids);
    if (res.changes > 0) bumpTaxGenerationIfPresent(db);
    return res.changes;
  })();
}

/**
 * Securities whose LATEST holdings row for `accountId` is quantity 0 — the
 * tombstone state computeTaxLots' RECONCILE_CLOSE pass keys on. Live
 * writers snapshot this BEFORE writing: a non-zero write for one of these
 * is a newer-date tombstone supersession (re-bought position) and must bump
 * the tax generation (spec §4).
 */
export function zeroLatestSecurityIds(db: Database.Database, accountId: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT h.security_id AS id FROM holdings h
        WHERE h.account_id = ? AND h.quantity = 0
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id)`,
    )
    .all(accountId) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

/** Recon tombstones for (account, date) — same-date supersession detection. */
export function countReconRowsOnDate(db: Database.Database, accountId: number, date: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM holdings
          WHERE account_id = ? AND as_of_date = ?
            AND source_key LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'`,
      )
      .get(accountId, date) as { c: number }
  ).c;
}
```

Also replace the old inline `recon:closed-equity:` template-literal in the tombstone with the constant (done in (c)) and update the header doc comment: add a "Tombstone model" paragraph pointing at the spec (supersedable/derived/origin-suffixed/batch-owned).

- [ ] **Step 4: Run to verify pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/mutations/closed-equity.test.ts tests/mutations/closed-equity-orphans.test.ts tests/compute/tax-lots-reconcile-close.test.ts`
Expected: all PASS (existing reconcile-close tests must still pass — the suffix changes source_keys but no consumer matches the full key; if one does, fix the TEST only if it hand-asserts exact keys).

- [ ] **Step 5: Commit** — `feat(reconciler): origin-suffixed batch-owned tombstones, atomic runs, orphan cleanup, tax bump`

---

### Task 4: Import engine — supersession, ownership wiring, warnings, undo rebuild, route evidence

**Files:**
- Modify: `lib/import/engine.ts`, `lib/mutations/import-batches.ts`, `app/api/import/route.ts`
- Test: `tests/import/engine-hardening.test.ts` (new), `tests/mutations/import-batches.test.ts` (extend)

**Interfaces:**
- Consumes: T1 `statementOverwritableHoldingSql`; T2 `bumpIfPricesAffectSyntheticCloses`; T3 options + `removeOrphanedReconTombstones` + `reconcileClosedEquityHoldings`.
- Produces: `CommitResult` gains `corporateActionWarningCount: number` (route + T9 rely on it). `deleteImportBatch` bumps on holdings deletions.

- [ ] **Step 1: Write the failing tests** — `tests/import/engine-hardening.test.ts`. Build DBs with `runMigrations`; drive imports through `commitImport` with a minimal parsed `canonical-csv`-shaped object (copy the construction idiom from `tests/import/engine.test.ts` — it already builds `ParsedResult` fixtures; reuse its helper if exported, else inline). Cases:

```ts
// 1. Same-date correction supersedes a tombstone
it("a corrected same-date statement re-import restores a phantom-closed position", () => {
  // import A: holdings snapshot at D with SYNA only (SYNB accidentally absent)
  //   → prior holdings put SYNB at an earlier date → reconcile tombstones SYNB at D
  // import B: corrected file, same date D, includes SYNB
  // assert: SYNB's row at D has quantity > 0, statement source_key, batch B id
  // assert: commit B counted it as a new/updated holding, not skippedDuplicates-only
});

// 2. Ownership wiring: tombstones minted by the post-commit reconcile carry the batch id
it("post-commit reconcile stamps this batch's id on its own accounts' tombstones", () => {
  // import a holdings snapshot that omits a previously-held security
  // assert tombstone row import_batch_id === result.batchId
});

// 3. Undo rebuild
it("undoImport removes owned tombstones and re-derives surviving ones", () => {
  // batch A (good, earlier date), batch B (bad: drops SYNB → tombstone owned by B)
  // undoImport(db, B)
  // assert: B's tombstone gone; SYNB's latest row is its pre-B non-zero row
});
it("undo of a correcting batch re-derives the original tombstone at its original date", () => {
  // batch A at D omits SYNB (phantom close, tombstone at D owned by A)
  // batch B same date D includes SYNB (supersedes tombstone)
  // undoImport(db, B) → tombstone at D is back (re-derived from A's surviving snapshot)
});

// 4. Failure surfacing
it("a reconcile failure surfaces as a domain warning + summary marker, import still succeeds", () => {
  // vi.mock("@/lib/mutations/closed-equity") with reconcileClosedEquityHoldings throwing
  // assert result.warnings contains the closed-position line (no raw error text)
  // assert import_batches.summary LIKE '%reconcile failed%'
  // assert result.corporateActionWarningCount === 0
});

// 5. Generation bumps
it("bumps generation when newHoldings > 0 and not on a fully-deduped re-import", () => {
  // import once (bump expected), re-import identical file (no bump)
});

// 6. Ownership on deduped retry (Codex plan-review F4)
it("a deduped retry still owns tombstones it mints", () => {
  // import file → undo nothing; delete the tombstone manually; re-import the
  // IDENTICAL file (all rows dedupe) → reconcile re-mints the tombstone;
  // assert its import_batch_id === the RETRY batch id (from parsed.holdings
  // account resolution, not from upsert .changes)
});

// 7. NULL-batch tombstone survives an unrelated undo (spec §6)
it("a sync-minted (NULL-batch) tombstone survives another batch's undo when still justified", () => {
  // tombstone with import_batch_id NULL at a date whose real snapshot rows
  // belong to a DIFFERENT (surviving) batch; undo an unrelated batch
  // → tombstone still present
});

// 8. Route-level replay evidence (Codex plan-review F8) — in a route-shaped
// test (or unit test on the extracted predicate): a commit result with sweep
// warnings but corporateActionWarningCount 0 and newCorporateActions 0
// produces NO replay status object.
```

Write these as REAL tests (the sketch above shows intent; each needs the full parsed-object setup — model it on `tests/import/engine.test.ts`'s existing fixtures). Extend `tests/mutations/import-batches.test.ts`:

```ts
it("deleteImportBatch bumps the tax generation when it deletes holdings rows", () => {
  // batch with one holdings row, no transactions → delete → generation +1
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/engine-hardening.test.ts tests/mutations/import-batches.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

(a) **Upsert WHERE swap** (`engine.ts` ~:485): import `statementOverwritableHoldingSql` and replace the literal clause:

```ts
ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
  quantity = excluded.quantity,
  cost_basis = excluded.cost_basis,
  import_batch_id = excluded.import_batch_id,
  source_key = excluded.source_key
WHERE ${statementOverwritableHoldingSql()}
```

Keep the comment block above it; append: "Includes recon tombstones — statement evidence supersedes any tombstone at the same date (spec 2026-08-30)."

(b) **CA warning counter:** add `let corporateActionWarningCount = 0;` beside the other counters; increment at BOTH corporate-action warning pushes (~:441 "skipped: no known security" and ~:456 "conflict"). Add `corporateActionWarningCount` to the returned result object and to the `CommitResult` type.

(c) **Generation bump** (~:807):

```ts
if (newTransactions > 0 || newCorporateActions > 0 || newHoldings > 0) {
  bumpTaxGenerationIfPresent(db);
}
```

(Extend the comment: holdings rows feed RECONCILE_CLOSE synthesis.)

(d) **Post-commit sweeps** (~:877-914): add a helper before the sweep block and use it in all three catches:

```ts
const recordSweepFailure = (label: string, domainWarning: string, err: unknown): void => {
  console.error(`[commit] ${label} error:`, err instanceof Error ? err.message : err);
  // Stable domain language only — raw error text stays in the server log.
  result.warnings.push(domainWarning);
  db.prepare(
    `UPDATE import_batches SET summary = COALESCE(summary || '; ', '') || ? WHERE id = ?`,
  ).run(`${label} failed — retries next sync`, result.batchId);
};
```

Catch bodies become e.g.:

```ts
} catch (err) {
  recordSweepFailure(
    "closed-position reconcile",
    "Post-import closed-position reconcile failed — recently sold positions may still show as open. It will retry on the next sync.",
    err,
  );
}
```

(purge sweeps: labels "expired-option purge" / "matured-bond purge" with analogous domain lines: "…expired options may still show as open positions…" / "…matured bonds may still show as held…").

(e) **Ownership wiring** — the account set comes from `parsed.holdings` (spec §2), NOT from rows stamped with this batch id: on a fully-deduped retry every upsert no-ops (`import_batch_id` unchanged), but the reconcile still runs and any tombstone it mints must be owned so this batch's undo can remove it. Post-commit all account names resolve (the commit created them):

```ts
const ownedAccountIds =
  parsed.holdings.length === 0
    ? []
    : (
        db
          .prepare(
            `SELECT id FROM accounts WHERE name IN (${[...new Set(parsed.holdings.map((h) => h.accountName))].map(() => "?").join(",")})`,
          )
          .all(...new Set(parsed.holdings.map((h) => h.accountName))) as { id: number }[]
      ).map((r) => r.id);
const reconciled = reconcileClosedEquityHoldings(db, {
  importBatchId: result.batchId,
  ownedAccountIds,
});
```

(`batch` is out of scope post-transaction — always `result.batchId` here.)

(f) **Undo rebuild** (`undoImport`): capture-then-atomic-then-recompute. Price invalidation is NOT here — it lives inside `deleteImportBatch` (see (g)), which scripts call directly (`scripts/rebuild-ibkr-ledger.ts`), so a direct deletion must not be fail-open:

```ts
export function undoImport(db: Database.Database, batchId: number): void {
  const refs = batchDonationReferences(db, batchId);
  if (refs.links > 0 || refs.lots > 0) {
    throw new Error(donationReferenceRefusalMessage(refs));
  }
  // Capture BEFORE deletion: which accounts' tombstone evidence this undo can orphan.
  const affectedAccountIds = (
    db.prepare(`SELECT DISTINCT account_id AS id FROM holdings WHERE import_batch_id = ?`)
      .all(batchId) as { id: number }[]
  ).map((r) => r.id);
  // Deletion + tombstone rebuild are ONE transaction (spec §3): if the rebuild
  // fails, the undo refuses whole rather than leaving a half-consistent book.
  db.transaction(() => {
    deleteImportBatch(db, batchId);
    if (affectedAccountIds.length > 0) {
      removeOrphanedReconTombstones(db, { accountIds: affectedAccountIds });
      reconcileClosedEquityHoldings(db);
    }
  })();
  // Heavy recomputes stay best-effort (pre-existing decision: a recompute
  // failure must not un-delete the batch; the bumped generation keeps tax
  // fail-closed meanwhile).
  try { computeTaxLots(db); } catch (err) { console.error("[undo] Tax lot recompute failed:", err instanceof Error ? err.message : err); }
  try { computeDailyValuations(db); } catch (err) { console.error("[undo] Valuation recompute failed:", err instanceof Error ? err.message : err); }
}
```

(g) **`deleteImportBatch`** (`import-batches.ts`) — owns BOTH holdings and price invalidation so every caller (undoImport AND direct script callers) is covered, all inside its existing transaction:

```ts
// BEFORE the DELETE FROM prices line — capture what is about to vanish:
const deletedPricePairs = db
  .prepare(`SELECT security_id AS securityId, date FROM prices WHERE import_batch_id = ?`)
  .all(batchId) as { securityId: number; date: string }[];
// … existing deletes; capture holdings:
const holdingsDeleted = db.prepare("DELETE FROM holdings WHERE import_batch_id = ?").run(batchId);
// … at the existing bump-condition block, extend:
if (
  transactionsDeleted.changes > 0 ||
  corporateActionsDeleted.changes > 0 ||
  donationLinkLotCount > 0 ||
  holdingsDeleted.changes > 0 // holdings feed RECONCILE_CLOSE synthesis (spec §4)
) {
  bumpTaxGenerationIfPresent(db);
}
// Price rows feed the synthetic close's selected price — evaluated AFTER the
// holdings delete so tombstone state reflects the post-delete book:
bumpIfPricesAffectSyntheticCloses(db, deletedPricePairs);
```

(h) **Import price-commit invalidation** (spec §4 — the import's own `prices` writes, `engine.ts` ~:556): collect `{ securityId, date }` for every price upsert executed in the price-commit loop (step 4b/5) and call `bumpIfPricesAffectSyntheticCloses(db, pricePairs)` once, inside the commit transaction after the loop. (Statement price backfills for a sold-out security change its synthetic-close price.)

(i) **Route** (`app/api/import/route.ts` ~:243):

```ts
const hadCorporateActions = commitResultsRaw.some(
  (r) => (r.newCorporateActions ?? 0) > 0 || (r.corporateActionWarningCount ?? 0) > 0,
);
```

(Sweep warnings no longer masquerade as CA evidence.)

- [ ] **Step 4: Run to verify pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/ tests/mutations/import-batches.test.ts`
Expected: new tests PASS. Do NOT run or edit `tests/api/import-undo-recovery.test.ts` here — that file belongs exclusively to T7 (which depends on this task and will flip its "holdings/prices are not tax inputs" premise). It is EXPECTED to be red between T4 and T7; T7's Step 4 greens it.

- [ ] **Step 5: Commit** — `feat(import): tombstone supersession + ownership, undo rebuild, sweep-failure surfacing, holdings tax bump`

---

### Task 5: Plaid writer — directional supersession + transition bumps

**Files:**
- Modify: `lib/plaid/refresh.ts`
- Test: `tests/plaid/refresh-hardening.test.ts` (new; follow the existing plaid test file's mock idiom — find it via `ls tests/plaid/`)

**Interfaces:**
- Consumes: T1 `liveOverwritableHoldingSql`; T3 `zeroLatestSecurityIds`, `countReconRowsOnDate`; T2 `bumpIfPricesAffectSyntheticCloses`.
- Produces: no new exports — behavior only.

- [ ] **Step 1: Write the failing tests.** Drive `commitPlaidMapResult` (the exported writer that takes `db, mapped, accountMap, today` — check exact export name at the top of `refresh.ts`; the function at :49 is the one whose body starts `const upsertHolding =`). Cases:

```ts
it("plaid supersedes a same-date :live tombstone", () => {
  // seed: security X held earlier; :live tombstone at TODAY for X
  // mapped positions include X, quantity 4
  // assert X's row at TODAY: quantity 4, source_key plaid:%, and generation bumped once
});
it("plaid does NOT supersede a same-date :stmt tombstone", () => {
  // same but :stmt tombstone → row stays quantity 0 recon:%; no bump from supersession
});
it("plaid bumps on newer-date supersession (re-bought position)", () => {
  // X's latest row is a tombstone at D-5; plaid writes X non-zero at TODAY
  // → generation bumped once
});
it("routine plaid sync (no tombstoned securities touched) does not bump", () => {
  // held-only book, no recon rows → generation unchanged
});
it("plaid does NOT supersede a legacy unsuffixed tombstone (statement-grade), and does not bump", () => {
  // same-date legacy tombstone (no :stmt/:live suffix) → row stays recon:%, no bump
});
it("a throw inside the per-account transaction rolls back writes AND bump together", () => {
  // inject a throw after the holdings writes (e.g. mock reconcileClosedEquityHoldings
  // to throw) → holdings unchanged, generation unchanged
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement in `refresh.ts`:**

(a) Upsert WHERE (:68) → `WHERE ${liveOverwritableHoldingSql()}` (import from holding-sources; extend the adjacent comment: live rows may claim live rows and live-origin tombstones only).

(b) Per-account block (the `for (const [plaidAccountId, localAccountId] …)` body): wrap the DB-mutation portion in a transaction and detect both transitions:

```ts
db.transaction(() => {
  const zeroLatest = zeroLatestSecurityIds(db, localAccountId);
  const reconBefore = countReconRowsOnDate(db, localAccountId, today);
  let newerDateSupersession = false;
  for (const p of positions) {
    // … existing upsertSecurity/upsertHolding body unchanged …
    // Only when the upsert ACTUALLY changed a row (res.changes > 0): a write
    // blocked by a same-date :stmt tombstone changed nothing and must not
    // bump (Codex plan-review F5 — the precedence test would fail otherwise).
    if (res.changes > 0 && p.quantity !== 0 && zeroLatest.has(securityId)) {
      newerDateSupersession = true;
    }
  }
  // … existing removeStaleSameDayTwsHoldings / snapshot / price writes,
  //     collecting pricePairs: {securityId, date} for every upsertPrice.run …
  const reconAfter = countReconRowsOnDate(db, localAccountId, today);
  // Tombstone consumption is a RECONCILE_CLOSE input change (spec §4):
  // same-date (recon rows replaced today) or newer-date (re-bought position).
  if (reconAfter < reconBefore || newerDateSupersession) bumpTaxGenerationIfPresent(db);
  bumpIfPricesAffectSyntheticCloses(db, pricePairs);
  reconcileClosedEquityHoldings(db, { accountId: localAccountId });
})();
```

The existing `reconcileClosedEquityHoldings` call at the end of the block moves inside the transaction (it nests as a savepoint). Keep all existing behavior/counters intact.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/plaid/`
Expected: PASS, existing plaid tests green.

- [ ] **Step 5: Commit** — `feat(plaid): directional tombstone supersession + scoped tax bumps in one transaction`

---

### Task 6: TWS + IBKR fallback writers — transition + price bumps

**Files:**
- Modify: `lib/tws/positions.ts`, `lib/tws/snapshot.ts`, `lib/ibkr/refresh.ts`
- Test: `tests/tws/positions-hardening.test.ts` (new), extend the ibkr refresh test (find via `grep -rln writeIbkrHoldings tests/`)

**Interfaces:**
- Consumes: T3 `zeroLatestSecurityIds`, `countReconRowsOnDate`; T2 `bumpIfPricesAffectSyntheticCloses`.
- Produces: behavior only. NOTE: TWS holdings stay `INSERT OR REPLACE` (spec non-goal) — only the bumps are added.

- [ ] **Step 1: Write the failing tests.** For `lib/tws/positions.ts`, test the DB-commit phase (mock/skip the IB connection — follow the existing tests' pattern for `syncPortfolio`'s commit internals; if the commit phase isn't separately callable, test via `writeIbkrHoldings` for the shared semantics and cover TWS through T9's integration suite — decide by reading the existing tws tests first). Required cases (on whichever writer is directly drivable — `writeIbkrHoldings(db, snapshot, { asOfDate })` is pure DB and takes an injected db, so at minimum cover it fully):

```ts
it("writeIbkrHoldings bumps on newer-date tombstone supersession (re-bought)", () => {});
it("writeIbkrHoldings same-date REPLACE of a tombstone bumps", () => {});
it("routine writeIbkrHoldings with held-only book does not bump", () => {});
it("tombstone-state price write through the writer bumps via bumpIfPricesAffectSyntheticCloses", () => {
  // ISOLATION (Codex plan-review F8): the snapshot's HOLDINGS must be
  // held-only (no transition bump possible) while a DIFFERENT, tombstoned
  // security receives the price write — so a bump proves the PRICE path,
  // not the holding-transition path.
});
it("a throw inside the writer's transaction rolls back writes AND bump together", () => {});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Same recipe as Plaid. **Atomicity rule (spec §4, Codex plan-review F3): the pre-state reads (`zeroLatestSecurityIds`, `countReconRowsOnDate`), ALL the writes, the transition detection, and the bump go inside ONE `db.transaction` per writer** — never read pre-state outside the transaction and never pair the bump with only the last write. For async fetch paths: collect fetched results into an array first, then execute one synchronous write+detect+bump transaction at the end.

- `lib/ibkr/refresh.ts` (`writeIbkrHoldings`, transaction at ~:131): move `zeroLatest`/`reconBefore` computation INSIDE the transaction at its top; inside the loop set `newerDateSupersession` when a non-zero write hits `zeroLatest`; collect `pricePairs` for every `upsertPrice.run(securityId, today, …)`; before the transaction ends: `if (reconAfter < reconBefore || newerDateSupersession) bumpTaxGenerationIfPresent(db);` + `bumpIfPricesAffectSyntheticCloses(db, pricePairs)`. (`INSERT OR REPLACE` consumes a same-date tombstone by replacing it — `reconAfter < reconBefore` catches it.) ALSO: the quote-enrichment price write later in this file (~:358) collects its own pairs and bumps in its own write transaction.
- `lib/tws/positions.ts` (commit phase inside `db.transaction` at ~:270): identical treatment (per synced account; the loop already knows `accountId` per position — build a `Map<accountId, Set<securityId>>` of zeroLatest plus per-account reconBefore at the TOP of the transaction from the accounts present in `positions`).
- **Every remaining runtime `prices` writer** (spec §4 requires full enumeration; Codex plan-review F1 found these): start from `grep -rn "INTO prices" lib/` and cover each hit —
  - `lib/tws/snapshot.ts` (~:137): results are collected async per security; restructure the final persistence so accumulated rows are written AND `bumpIfPricesAffectSyntheticCloses(db, pairs)` runs in one synchronous `db.transaction` at the end (do not rework the fetch/streaming structure — only the DB-write tail).
  - `lib/tws/historical.ts` (~:95): same — collect written `(securityId, date)` pairs, one transaction for writes + bump.
  - `lib/tws/streaming.ts` (~:265): same treatment for its price persistence point.
  - Any additional hit the grep reveals gets the same two lines; list them in the commit message.

- [ ] **Step 4: Run to verify pass** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/tws/ tests/ibkr/ 2>/dev/null || PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/` (narrow to whichever dirs exist).

- [ ] **Step 5: Commit** — `feat(tws,ibkr): tombstone-supersession + synthetic-close price tax bumps`

---

### Task 7: Recovery restore — helper parity, tombstone skip, rebuild, bump rule

**Files:**
- Modify: `lib/import/recovery.ts`
- Test: `tests/api/import-undo-recovery.test.ts` (extend/adjust)

**Interfaces:**
- Consumes: T1 `statementOverwritableHoldingSql`, `RECON_HOLDING_SOURCE_PREFIX`; T3 `removeOrphanedReconTombstones`, `reconcileClosedEquityHoldings`. **Depends on T4** (its `deleteImportBatch` bump changes what this task's test file asserts — T7 exclusively owns `tests/api/import-undo-recovery.test.ts`, including flipping the old "holdings/prices are not tax inputs" premise that T4's changes turned red).
- Produces: behavior only.

- [ ] **Step 1: Write the failing tests** (extend `tests/api/import-undo-recovery.test.ts`):

```ts
it("restore overwrites a tombstone occupying a manifested statement row's slot", () => {
  // undo a batch, mint a tombstone at the same (account, security, date) slot,
  // restore → the statement row wins (quantity > 0, statement source_key)
});
it("restore never re-inserts recon manifest rows; re-reconcile re-derives justified ones", () => {
  // manifest containing a batch-owned tombstone row (captured pre-undo):
  // after restore, no holdings row with that recon source_key was inserted by the
  // restore loop itself; if still justified, an equivalent tombstone exists via re-derivation
});
it("restore bumps the generation when the manifest carries holdings or prices", () => {
  // flips the old "not a tax input" premise — cite spec §3/§4 in a comment
});
it("double restore corrupts no uniquely-keyed table", () => {
  // run restoreImportBatch twice; row counts of holdings/prices/transactions unchanged
  // (raw_imports duplication is pre-existing and out of scope — do not assert it)
});
```

Delete/rewrite the existing assertion that a holdings/prices-only restore does NOT bump (the spec inverts it deliberately).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement in `recovery.ts`:**

(a) Replace `LIVE_HOLDING_GUARD` with the shared helper — delete the local const and use `statementOverwritableHoldingSql("holdings.source_key")` in the `holdings` restoreSpec's WHERE. Update the parity comment: "Parity with commitImport is now by construction — both call statementOverwritableHoldingSql."

(b) In the per-table restore loop (~:546), skip tombstones:

```ts
for (const row of manifest.payload.tables[table]) {
  // Tombstones are DERIVED rows (spec §3): never restored from a manifest —
  // the post-restore reconcile re-derives any still-justified ones. Filtering
  // at restore time (not capture) keeps stored checksums valid.
  if (
    table === "holdings" &&
    typeof (row as Record<string, unknown>).source_key === "string" &&
    ((row as Record<string, unknown>).source_key as string).startsWith(RECON_HOLDING_SOURCE_PREFIX)
  ) {
    continue;
  }
  insertCapturedRow(db, table, stripRowId(row), spec);
  n++;
}
```

(c) Extend the bump condition (~:591) and add the rebuild, still inside the existing `db.transaction`:

```ts
const holdingsOrPricesRestored =
  (manifest.payload.tables.holdings?.length ?? 0) > 0 ||
  (manifest.payload.tables.prices?.length ?? 0) > 0;
if (
  restored.transactions > 0 ||
  restored.corporate_actions > 0 ||
  donationsRestored > 0 ||
  restored.donation_leg_links > 0 ||
  restored.donation_lots > 0 ||
  holdingsOrPricesRestored // spec §3: holdings/prices ARE tax inputs (RECONCILE_CLOSE)
) {
  bumpTaxGenerationIfPresent(db);
}
// Tombstone rebuild (spec §3): restored real rows may re-justify or orphan
// tombstones; re-derive rather than trust the pre-undo state.
const restoredAccountIds = [
  ...new Set(
    (manifest.payload.tables.holdings ?? []).map((r) => (r as { account_id: number }).account_id),
  ),
];
if (restoredAccountIds.length > 0) {
  removeOrphanedReconTombstones(db, { accountIds: restoredAccountIds });
  reconcileClosedEquityHoldings(db);
}
```

- [ ] **Step 4: Run to verify pass** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/api/import-undo-recovery.test.ts`

- [ ] **Step 5: Commit** — `feat(recovery): shared supersession guard, tombstone-skip restore, rebuild + fail-closed bump`

---

### Task 8: ImportHistory — render the batch summary line

**Files:**
- Modify: `app/dashboard/components/ImportHistory.tsx`
- Test: none new (pure presentational addition of an existing field; T10's E2E covers it visually)

**Interfaces:** consumes `batch.summary` (already on `ImportBatch`, `lib/types.ts:59`). No dependencies on other tasks.

- [ ] **Step 1: Implement.** In the File `<td>` (~:129-134), render the summary as a sub-line so persisted sweep-failure markers are visible (R2-F6):

```tsx
<td className="px-4 py-3 text-ink" title={batch.filename ?? undefined}>
  {batch.filename ?? "—"}
  {batch.summary && (
    <div className="text-xs text-ink-faint truncate max-w-[26rem]" title={batch.summary}>
      {batch.summary}
    </div>
  )}
</td>
```

(Contrast rule: `text-xs` on `text-ink-faint` is the established muted-metadata idiom in this table — matches the Date cell.)

- [ ] **Step 2: Verify** — `npx next build` type-checks the component (or rely on `verify:changed`); visual check lands in T10.

- [ ] **Step 3: Commit** — `feat(import-ui): show batch summary line in Import History`

---

### Task 9: Integration suite + docs

**Files:**
- Create: `tests/integration/reconciler-hardening.test.ts`
- Modify: `docs/plans/TODO.md` (close line-80 item; move to the closed section per file convention), `docs/DECISIONS.md` (one entry), `CLAUDE.md` (extend the per-pair-latest invariant bullet with one sentence: tombstones are origin-suffixed, batch-owned, orphan-cleaned — see spec)

**Interfaces:** consumes everything from T1–T7.

- [ ] **Step 1: Write the integration tests** (in-memory DB, full pipeline through `commitImport`/`undoImport`/`restoreImportBatch`/`computeTaxLots`):

```ts
it("RECONCILE_CLOSE lifecycle: appears on tombstone, disappears on supersession", () => {
  // open lots + tombstone → computeTaxLots creates RECONCILE_CLOSE synthetic sale
  // corrected re-import restores the position → recompute → synthetic sale gone
});
it("newer-date re-buy removes the synthetic close and the live-writer bump covers it", () => {
  // tombstone in place, RECONCILE_CLOSE exists → plaid-style non-zero write at a newer date
  // → recompute → synthetic gone; generation bumped by the writer
});
it("filing-readiness STATE (not just the counter) goes pending on tombstone events", () => {
  // stamp acceptance via stampTaxLotsConvention/stampBrokerAcceptance
  // → reconcile mints a tombstone → getTaxConventionState reports pending/stale
});
it("bad-A → corrected-B → undo-B: A's tombstone re-derived at A's original date", () => {});
it("undo rolls back whole when the rebuild fails (fault injection)", () => {
  // vi.spyOn/mock removeOrphanedReconTombstones to throw inside undoImport's transaction
  // → batch still present, holdings unchanged
});
it("cross-account: batch touching account 1 never owns account 2's tombstones", () => {});
```

- [ ] **Step 2: Run** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/integration/reconciler-hardening.test.ts` until green.

- [ ] **Step 3: Docs.** TODO: mark line-80 item closed with merge reference; add one-line entries for anything discovered-but-deferred during implementation. DECISIONS.md entry: tombstone model (derived layer, origin suffix, directional supersession, coarse fail-closed generation doctrine) with spec path.

- [ ] **Step 4: Commit** — `test(integration): reconciler-hardening lifecycle suite + docs close-out`

---

### Task 10: Full verification + browser E2E

**Files:** none (verification only; fixes go through the owning task's files).

- [ ] **Step 1:** `npm run verify:changed` — fix anything it flags.
- [ ] **Step 2:** Full suite: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` — report count; 0 real failures required (known flakes: env-key tests without `.env.local`, eslint-subprocess timeout under load — re-run in isolation before ruling a failure a flake).
- [ ] **Step 3:** `npx next build` compiles.
- [ ] **Step 4: Browser E2E** (agent-browser on a sandbox: DB COPY of `data/vanguard.db`, secretless `env -i` per the 2026-08-30 pattern, spare port e.g. :3095, minted session via the `scripts/mint-qa-session` idiom). Two ISOLATED scenarios, run sequentially, each starting from a fresh DB copy. Fixtures: write these two synthetic canonical CSVs to the scratchpad first (schema: whatever `lib/import/parsers/canonical-csv.ts` expects — read its header row contract; the point is one file whose holdings block OMITS `SYNQQ` and one that includes it, both dated the same synthetic month-end, e.g. `2026-08-29`, with two synthetic tickers `SYNAA`/`SYNQQ` seeded as prior holdings via a first import of a base fixture that carries both):
  1. **Corrected re-import:** import base fixture (both tickers held) → import the OMITTING fixture (same date) → Accounts no longer lists SYNQQ (tombstoned) → import the CORRECTED fixture → SYNQQ reappears on Accounts.
  2. **Bad-import → undo:** fresh DB copy; import base fixture → import the omitting fixture → Import History: undo that batch → SYNQQ back on Accounts; the undone-adjacent batch rows render their summary sub-line (T8's UI change) — verify the summary line is visible on any batch that has one.
- [ ] **Step 5:** Report results; per repo rules do NOT commit if anything fails, and ask the user before merging/pushing.

---

## Self-review notes (already applied)

- Plan rev 2 folds in the Codex plan-review round (9 findings): full price-writer enumeration (T6), price invalidation moved into `deleteImportBatch` (T4g), ownership from `parsed.holdings` (T4e), one-transaction writer atomicity (T6), Plaid `res.changes` guard (T5), T7 now depends on T4 and solely owns `import-undo-recovery.test.ts`, `hold()` reuse (T3), negative/fault tests added (T3,T4,T5,T6), concrete E2E fixtures/sequencing (T10).
- Spec coverage: §1→T1; §2→T3; §3→T4(f)+T7; §4→T2,T4,T5,T6,T7; §5→T4(b,d,i)+T8; §6→per-task tests+T9+T10; non-goals honored (no TWS REPLACE change, no backfill, no retry UI).
- Type consistency: `corporateActionWarningCount` (T4 produces, route consumes); `zeroLatestSecurityIds`/`countReconRowsOnDate` (T3 produces; T5/T6 consume); helper names `statementOverwritableHoldingSql`/`liveOverwritableHoldingSql` used identically in T1/T4/T5/T7.
- T4 Step 1's test sketches are intent summaries; the implementer writes them as full tests modeled on `tests/import/engine.test.ts` fixtures — the assertions listed are the required behavior, not optional.
