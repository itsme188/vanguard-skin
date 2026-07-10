# Plaid Live Vanguard Holdings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mid-month Vanguard position changes (buys/sells, cash) reach Portfolio Desk within a day via Plaid Investments, while monthly statements remain the authoritative ledger.

**Architecture:** A live-sync module (`lib/plaid/`) mirroring the IBKR Web API path (`lib/ibkr/refresh.ts`): fetch `/investments/holdings/get` daily, write holdings rows (`plaid:` source_keys) + a same-day `monthly_snapshots` row (`source='plaid'`) that statement imports later overwrite. A new shared `LIVE_SNAPSHOT_SOURCES` predicate replaces every scattered `source != 'tws'` comparison so `'plaid'` rows are excluded from historical math exactly like `'tws'` rows.

**Tech Stack:** Next.js 16 API routes, better-sqlite3, plain `fetch` to Plaid REST (NO npm SDK), Plaid Link via hosted script tag, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-plaid-vanguard-live-design.md`

## Global Constraints

- **No new npm dependencies.** Plaid REST via `fetch`; Link via `https://cdn.plaid.com/link/v2/stable/link-initialize.js` script tag.
- Every DB function takes `db: Database.Database` as first param. Reads in `lib/queries/`, writes in `lib/mutations/` (Plaid-specific settings helpers follow the `lib/queries/earnings-settings.ts` precedent: gets + sets in one queries file).
- Dates `YYYY-MM-DD`; "today" is always `todayET()` (`lib/calendar/date-utils.ts`), never a UTC slice.
- `security_type` comparisons are ALWAYS case-insensitive (`.toLowerCase()`).
- `cost_basis` from Plaid is **discarded** — holdings rows write `NULL` (readers COALESCE back to statement rows).
- Statement data always wins: Plaid writes must never overwrite a statement-sourced `holdings`/`monthly_snapshots`/`prices` row.
- Tests: in-memory SQLite via `new Database(":memory:")` + `db.pragma("foreign_keys = ON")` + `runMigrations(db)` (`@/lib/db/migrate`). Run with `npx vitest run <path>`.
- After the final task: full suite `npx vitest run` must pass AND `npx next build` must compile.
- Commit after every task (descriptive message; never push).

---

### Task 1: `LIVE_SNAPSHOT_SOURCES` predicate module + exclusion sweep + lint test

The complete inventory of `monthly_snapshots` source-exclusion sites was verified 2026-07-10. All live in 4 files. Every predicate becomes a call into one new module so `'plaid'` is excluded from historical math everywhere `'tws'` is.

**Files:**
- Create: `lib/db/live-sources.ts`
- Create: `tests/db/live-sources.test.ts`
- Modify: `lib/queries/dashboard.ts` (lines 52, 70, 96, 161, 201, 212, 231, 264)
- Modify: `lib/queries/data-confidence.ts` (line 239)
- Modify: `lib/compute/twr.ts` (lines 139, 154, 173, 265, 365, 380, 382, 414, 417, 443)
- Modify: `lib/compute/xirr.ts` (lines 241, 267, 288, 343, 347, 378, 502, 504, 513, 554, 579, 582, 605, 648, 650)

**Interfaces:**
- Produces: `LIVE_SNAPSHOT_SOURCES: readonly ["tws","plaid"]`, `excludeLiveSnapshotsSql(col = "source"): string`, `onlyLiveSnapshotsSql(col = "source"): string` — later tasks import these.

- [ ] **Step 1: Write the failing test**

Create `tests/db/live-sources.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  LIVE_SNAPSHOT_SOURCES,
  excludeLiveSnapshotsSql,
  onlyLiveSnapshotsSql,
} from "@/lib/db/live-sources";

describe("live-sources SQL fragments", () => {
  it("exposes tws and plaid as the live snapshot sources", () => {
    expect([...LIVE_SNAPSHOT_SOURCES]).toEqual(["tws", "plaid"]);
  });

  it("builds an exclusion predicate with default and aliased columns", () => {
    expect(excludeLiveSnapshotsSql()).toBe("source NOT IN ('tws','plaid')");
    expect(excludeLiveSnapshotsSql("ms.source")).toBe(
      "ms.source NOT IN ('tws','plaid')",
    );
  });

  it("builds an inclusion predicate", () => {
    expect(onlyLiveSnapshotsSql("ms.source")).toBe(
      "ms.source IN ('tws','plaid')",
    );
  });
});

describe("no raw != 'tws' predicates survive outside live-sources.ts", () => {
  // The invariant this pins: every monthly_snapshots historical read must
  // exclude ALL live sources, not just 'tws'. A raw `!= 'tws'` comparison
  // means someone bypassed the shared predicate and plaid rows would leak
  // into TWR/XIRR/chart/summary history.
  const ROOTS = ["lib", "app"];
  const ALLOWED = new Set([path.join("lib", "db", "live-sources.ts")]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(p, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(p);
      }
    }
    return out;
  }

  it("finds zero raw exclusion predicates", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED.has(file)) continue;
        const src = fs.readFileSync(file, "utf-8");
        if (/(!=|<>)\s*'tws'/.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/live-sources.test.ts`
Expected: FAIL — module `@/lib/db/live-sources` not found, and the lint test finds offenders in `lib/queries/dashboard.ts`, `lib/queries/data-confidence.ts`, `lib/compute/twr.ts`, `lib/compute/xirr.ts`.

- [ ] **Step 3: Create the module**

Create `lib/db/live-sources.ts`:

```ts
/**
 * Live broker-snapshot sources for `monthly_snapshots` rows.
 *
 * 'tws'   — TWS sync + IBKR Web API path (both stamp 'tws' deliberately)
 * 'plaid' — Plaid Investments daily Vanguard pull
 *
 * These rows are CURRENT-value snapshots, not month-end statements. Every
 * historical read (TWR, XIRR, chart, account summaries, data confidence)
 * must exclude them via excludeLiveSnapshotsSql(); surfaces that want the
 * live "current value" opt in via onlyLiveSnapshotsSql().
 *
 * A lint test (tests/db/live-sources.test.ts) rejects any raw `!= 'tws'`
 * comparison outside this file — never inline the source list.
 */
export const LIVE_SNAPSHOT_SOURCES = ["tws", "plaid"] as const;

const QUOTED = LIVE_SNAPSHOT_SOURCES.map((s) => `'${s}'`).join(",");

/** SQL fragment: row is a statement/historical snapshot (NOT live). */
export function excludeLiveSnapshotsSql(col = "source"): string {
  return `${col} NOT IN (${QUOTED})`;
}

/** SQL fragment: row is a live broker snapshot (tws or plaid). */
export function onlyLiveSnapshotsSql(col = "source"): string {
  return `${col} IN (${QUOTED})`;
}
```

- [ ] **Step 4: Sweep the four files**

Mechanical rule, applied at every listed line (all queries are template literals, so interpolation drops in directly):
- `source != 'tws'` → `${excludeLiveSnapshotsSql("source")}`
- `ms.source != 'tws'` → `${excludeLiveSnapshotsSql("ms.source")}` (same for `ms2.`, `p2.`)
- `WHERE source != 'tws'` → `WHERE ${excludeLiveSnapshotsSql("source")}`

Add to each modified file: `import { excludeLiveSnapshotsSql, onlyLiveSnapshotsSql } from "@/lib/db/live-sources";` (only the function(s) used — twr/xirr/data-confidence need only `excludeLiveSnapshotsSql`).

Representative edits, verbatim:

`lib/queries/dashboard.ts:52` (ranked_monthly CTE in `getAccountSummaries`):
```ts
// before
WHERE ms.source != 'tws'
// after
WHERE ${excludeLiveSnapshotsSql("ms.source")}
```

**Two INCLUSION sites flip to `onlyLiveSnapshotsSql` so Plaid live values surface as "current"** (this is what makes the feature visible on the dashboard):

`lib/queries/dashboard.ts:70` (latest_tws CTE):
```ts
// before
WHERE ms.source = 'tws'
// after
WHERE ${onlyLiveSnapshotsSql("ms.source")}
```

`lib/queries/dashboard.ts:212` (`getPortfolioTotals` live-inclusion branch):
```ts
// before
WHERE source = 'tws'
// after
WHERE ${onlyLiveSnapshotsSql("source")}
```

All remaining sites use the exclusion form. Complete site list (verified inventory — the lint test catches any missed):
- `lib/queries/dashboard.ts`: 52 (`ms.source`), 96 (`ms2.source`), 161 (`ms.source`), 201 (`source`), 231 (`ms2.source`), 264 (`source`) — plus the two inclusion flips at 70 and 212 above.
- `lib/queries/data-confidence.ts`: 239 (`source`).
- `lib/compute/twr.ts`: 139, 154, 173, 265, 365, 380, 382, 443 (`source`); 414 (`p2.source`); 417 (`ms.source`).
- `lib/compute/xirr.ts`: 241, 267, 288, 378, 502, 504, 513, 554, 605, 648, 650 (`source`); 343, 579 (`p2.source`); 347, 582 (`ms.source`).

Do NOT touch the write-guards `IN ('tws','manual')` in `lib/ibkr/refresh.ts:164` / `lib/tws/positions.ts:422` (Task 2 handles the engine guard; the live-path guards stay as-is) or the `prices`/`holdings` `'tws'` filters (`lib/tws/historical.ts:101`, `lib/import/engine.ts:391`).

- [ ] **Step 5: Run the new test + the affected suites**

Run: `npx vitest run tests/db/live-sources.test.ts tests/compute tests/queries`
Expected: ALL PASS. (No `'plaid'` rows exist yet, so `NOT IN ('tws','plaid')` is behavior-identical to `!= 'tws'` — any TWR/XIRR/dashboard test failure means a sweep edit broke SQL syntax.)

- [ ] **Step 6: Commit**

```bash
git add lib/db/live-sources.ts tests/db/live-sources.test.ts lib/queries/dashboard.ts lib/queries/data-confidence.ts lib/compute/twr.ts lib/compute/xirr.ts
git commit -m "feat(plaid): LIVE_SNAPSHOT_SOURCES predicate module + sweep of all source != 'tws' sites

~30 monthly_snapshots exclusion predicates across dashboard/data-confidence/
twr/xirr now go through one shared module; lint test rejects raw != 'tws'.
Behavior-identical until plaid rows exist."
```

---

### Task 2: Statement-wins guards learn about `plaid` (import engine)

**Files:**
- Modify: `lib/import/engine.ts:391` (holdings upsert WHERE), `lib/import/engine.ts:527` (snapshot upsert WHERE), `lib/import/engine.ts:456-475` (prices priority CASE — both arms)
- Test: `tests/import/engine-plaid-guards.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: engine behavior later tasks' E2E rely on — statement imports overwrite `plaid:` holdings rows, `source='plaid'` snapshot rows, and `source='plaid'` price rows (priority 3).

- [ ] **Step 1: Write the failing test**

Create `tests/import/engine-plaid-guards.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport } from "@/lib/import/engine";
import { upsertSecurity } from "@/lib/mutations/securities";

const fixturesDir = path.join(__dirname, "..", "fixtures");
const vanguardHoldingsCsv = fs.readFileSync(
  path.join(fixturesDir, "vanguard-holdings-sample.csv"),
  "utf-8",
);

describe("statement-wins guards cover plaid rows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("statement holdings import overwrites a same-key plaid holdings row", async () => {
    const parsed = await parseImport(vanguardHoldingsCsv, "vanguard-holdings.csv");
    // Determine the account + first holding the fixture will write.
    const first = parsed.holdings[0];
    // Pre-seed the account + security + a plaid live row on the SAME
    // (account, security, as_of_date) the statement import will target.
    const acctId = db
      .prepare(`INSERT INTO accounts (name) VALUES (?)`)
      .run(first.accountName).lastInsertRowid as number;
    const secId = upsertSecurity(db, { symbol: first.symbol });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 999, NULL, ?, ?)`,
    ).run(acctId, secId, first.asOfDate, `plaid:${acctId}:${secId}:${first.asOfDate}`);

    commitImport(db, parsed);

    const row = db
      .prepare(
        `SELECT quantity, source_key FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`,
      )
      .get(acctId, secId, first.asOfDate) as { quantity: number; source_key: string };
    expect(row.quantity).toBe(first.quantity); // statement value, not 999
    expect(row.source_key.startsWith("plaid:")).toBe(false);
  });

  it("statement snapshot overwrites a plaid snapshot row; leaves statement rows intact", () => {
    const acctId = db
      .prepare(`INSERT INTO accounts (name) VALUES ('Vanguard Taxable')`)
      .run().lastInsertRowid as number;
    // Plaid live snapshot on a month-end date
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
       VALUES (?, '2026-07-31', 100000, 5000, 'plaid')`,
    ).run(acctId);
    // Replay the engine's exact conditional upsert as a statement import would
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (?, '2026-07-31', 123456, 'vanguard-pdf')
       ON CONFLICT(account_id, month_end_date) DO UPDATE SET
         total_value = excluded.total_value, source = excluded.source
       WHERE monthly_snapshots.source IN ('tws', 'manual', 'plaid')`,
    ).run(acctId);
    const row = db
      .prepare(`SELECT total_value, source FROM monthly_snapshots WHERE account_id = ?`)
      .get(acctId) as { total_value: number; source: string };
    expect(row.source).toBe("vanguard-pdf");
    expect(row.total_value).toBe(123456);
  });

  it("engine snapshot upsert WHERE clause includes plaid", () => {
    // Direct source-of-truth check on engine.ts so a regression can't hide
    // behind fixture accidents.
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "import", "engine.ts"), "utf-8");
    expect(src).toMatch(/monthly_snapshots\.source IN \('tws', 'manual', 'plaid'\)/);
    expect(src).toMatch(/holdings\.source_key LIKE 'tws-%' OR holdings\.source_key LIKE 'plaid:%'/);
    expect(src.match(/WHEN 'plaid' THEN 3/g)?.length).toBe(2); // both CASE arms
  });
});
```

Note: before running, verify the parsed-holding field names (`accountName`, `asOfDate`, `quantity`) against the actual `ParsedImportResult` holdings type in `lib/import/engine.ts` / `lib/types.ts` and adjust the test's property access to match — the shape was not verified when this plan was written.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/import/engine-plaid-guards.test.ts`
Expected: FAIL — holdings row keeps quantity 999 (guard doesn't match `plaid:` keys) and the source-scan assertions fail.

- [ ] **Step 3: Make the three engine edits**

`lib/import/engine.ts:391` — holdings upsert guard:
```sql
-- before
      WHERE holdings.source_key LIKE 'tws-%'
-- after
      WHERE holdings.source_key LIKE 'tws-%' OR holdings.source_key LIKE 'plaid:%'
```

`lib/import/engine.ts:527` — snapshot upsert guard:
```sql
-- before
      WHERE monthly_snapshots.source IN ('tws', 'manual')
-- after
      WHERE monthly_snapshots.source IN ('tws', 'manual', 'plaid')
```

`lib/import/engine.ts` prices priority CASE (~456-475) — add to BOTH arms, after the `vanguard-holdings` line:
```sql
        WHEN 'vanguard-holdings' THEN 3
        WHEN 'plaid' THEN 3
```
(`plaid` at tier 3: a statement-derived Vanguard price (3 ≤ 3) reclaims a plaid price; tws/ibkr beat it; it never beats them.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/import/engine-plaid-guards.test.ts tests/import/engine.test.ts`
Expected: ALL PASS (existing engine tests unaffected — guards only widen the overwrite set for rows that don't exist in those tests).

- [ ] **Step 5: Commit**

```bash
git add lib/import/engine.ts tests/import/engine-plaid-guards.test.ts
git commit -m "feat(plaid): statement-wins guards cover plaid rows (holdings, snapshots, prices tier 3)"
```

---

### Task 3: Generalize same-day stale-holdings cleanup to a source-key prefix

**Files:**
- Modify: `lib/mutations/same-day-tws-holdings.ts`
- Test: `tests/mutations/same-day-tws-holdings.test.ts` (extend existing file if present at that path; create otherwise — check `ls tests/mutations/` first)

**Interfaces:**
- Consumes: existing `RemoveStaleSameDayTwsHoldingsOptions`.
- Produces: `removeStaleSameDayTwsHoldings(db, opts)` accepts optional `sourceKeyLike?: string` (default `'tws-%'`). Task 8 calls it with `sourceKeyLike: 'plaid:%'`.

- [ ] **Step 1: Write the failing test** (add to the existing test file for this mutation, or create):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { removeStaleSameDayTwsHoldings } from "@/lib/mutations/same-day-tws-holdings";

describe("removeStaleSameDayTwsHoldings with plaid prefix", () => {
  let db: Database.Database;
  let acctId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    acctId = db.prepare(`INSERT INTO accounts (name) VALUES ('Vanguard Taxable')`).run()
      .lastInsertRowid as number;
  });

  function seed(symbol: string, prefix: string): number {
    const secId = upsertSecurity(db, { symbol });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 10, NULL, '2026-07-10', ?)`,
    ).run(acctId, secId, `${prefix}${acctId}:${secId}:2026-07-10`);
    return secId;
  }

  it("removes stale plaid rows, leaves tws + statement rows alone", () => {
    const kept = seed("AAA", "plaid:");
    const stale = seed("BBB", "plaid:");
    const twsSec = upsertSecurity(db, { symbol: "CCC" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 5, NULL, '2026-07-10', ?)`,
    ).run(acctId, twsSec, `tws-${acctId}-${twsSec}-2026-07-10`);

    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: acctId,
      asOfDate: "2026-07-10",
      syncedSecurityIds: [kept],
      sourceKeyLike: "plaid:%",
    });
    expect(result.deleted).toBe(1);
    const remaining = db
      .prepare(`SELECT security_id FROM holdings WHERE account_id = ? ORDER BY security_id`)
      .all(acctId) as { security_id: number }[];
    expect(remaining.map((r) => r.security_id)).toEqual([kept, twsSec].sort((a, b) => a - b));
    expect(remaining.map((r) => r.security_id)).not.toContain(stale);
  });

  it("defaults to tws-% when sourceKeyLike omitted (back-compat)", () => {
    const plaidSec = seed("DDD", "plaid:");
    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: acctId,
      asOfDate: "2026-07-10",
      syncedSecurityIds: [999999],
    });
    // No tws rows exist → nothing counted, nothing deleted, plaid untouched
    expect(result.deleted).toBe(0);
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM holdings WHERE security_id = ?`).get(plaidSec),
    ).toEqual({ c: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mutations/same-day-tws-holdings.test.ts`
Expected: FAIL — TypeScript/`sourceKeyLike` unknown option (or SQL still hardcodes `tws-%`).

- [ ] **Step 3: Implement**

In `lib/mutations/same-day-tws-holdings.ts`: add `sourceKeyLike?: string` to `RemoveStaleSameDayTwsHoldingsOptions`; at the top of the function add `const prefix = opts.sourceKeyLike ?? "tws-%";`; replace both hardcoded `source_key LIKE 'tws-%'` occurrences with `source_key LIKE ?` and thread `prefix` as the bind param (COUNT query: `.get(opts.accountId, opts.asOfDate, prefix)`; DELETE: `.run(opts.accountId, opts.asOfDate, prefix, ...opts.syncedSecurityIds)` — note the DELETE's placeholder order: put the `LIKE ?` before the `NOT IN` list so binds stay positional).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mutations tests/tws`
Expected: ALL PASS (existing TWS-path callers unaffected — default preserves behavior).

- [ ] **Step 5: Commit**

```bash
git add lib/mutations/same-day-tws-holdings.ts tests/mutations/same-day-tws-holdings.test.ts
git commit -m "feat(plaid): source-key-prefix param on same-day stale holdings cleanup"
```

---

### Task 4: Widen sync-state `lastSyncVia` + TwsStatus labels

**Files:**
- Modify: `lib/tws/sync-state.ts` (SyncState interface line ~40, `setSyncComplete` signature line ~83)
- Modify: `app/dashboard/components/TwsStatus.tsx` (lines 104-110, 565-567)

**Interfaces:**
- Produces: `setSyncComplete(result, via: "tws" | "ibkr-webapi" | "plaid")` — Task 8 passes `"plaid"`.

- [ ] **Step 1: Widen the union in `lib/tws/sync-state.ts`**

```ts
// SyncState interface:
lastSyncVia: "tws" | "ibkr-webapi" | "plaid" | null;
// setSyncComplete:
export function setSyncComplete(
  result: AutoRefreshResult,
  via: "tws" | "ibkr-webapi" | "plaid" = "tws",
): void {
```

- [ ] **Step 2: TwsStatus labels**

At `TwsStatus.tsx:104-110`, widen the disconnected-path chip:
```tsx
{syncState?.lastSyncAt &&
  (syncState.lastSyncVia === "ibkr-webapi" || syncState.lastSyncVia === "plaid") &&
  status.state !== "connected" && (
    <span className="text-ink-faint">
      · {syncState.lastSyncVia === "plaid" ? "Plaid" : "Web API"} synced{" "}
      {formatTimeSince(syncState.lastSyncAt)}
    </span>
  )}
```

At `TwsStatus.tsx:565-567`:
```tsx
{syncState.lastSyncVia === "ibkr-webapi"
  ? " · via IBKR Web API (TWS offline)"
  : syncState.lastSyncVia === "plaid"
    ? " · via Plaid (Vanguard)"
    : ""}
```

- [ ] **Step 3: Verify compile + suite**

Run: `npx vitest run tests/tws && npx tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 4: Commit**

```bash
git add lib/tws/sync-state.ts app/dashboard/components/TwsStatus.tsx
git commit -m "feat(plaid): 'plaid' lastSyncVia variant + status labels"
```

---

### Task 5: Plaid settings helpers (`settings` table)

**Files:**
- Create: `lib/queries/plaid-settings.ts`
- Test: `tests/queries/plaid-settings.test.ts`

**Interfaces:**
- Produces (all take `db: Database.Database` first):
  - `getPlaidConnection(db): PlaidConnection` where `PlaidConnection = { accessToken: string | null; itemId: string | null; accountMap: Record<string, number>; connectionStatus: "ok" | "reauth_required" | "disconnected"; lastSyncAt: string | null; plaidAccounts: PlaidAccountInfo[] }` and `PlaidAccountInfo = { id: string; name: string; mask: string | null; subtype: string | null }`
  - `setPlaidItem(db, accessToken: string, itemId: string): void` (also sets connectionStatus "ok")
  - `setPlaidAccountMap(db, map: Record<string, number>): void`
  - `setPlaidAccountsCache(db, accounts: PlaidAccountInfo[]): void`
  - `setPlaidConnectionStatus(db, status: "ok" | "reauth_required"): void`
  - `setPlaidLastSyncAt(db, iso: string): void`
  - `getPlaidReauthAlertedAt(db): string | null` / `setPlaidReauthAlertedAt(db, iso: string | null): void`
- Settings keys: `plaid_access_token`, `plaid_item_id`, `plaid_account_map` (JSON), `plaid_accounts_cache` (JSON), `plaid_connection_status`, `plaid_last_sync_at`, `plaid_reauth_alerted_at`.

- [ ] **Step 1: Write the failing test**

Create `tests/queries/plaid-settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getPlaidConnection,
  setPlaidItem,
  setPlaidAccountMap,
  setPlaidAccountsCache,
  setPlaidConnectionStatus,
  setPlaidLastSyncAt,
  getPlaidReauthAlertedAt,
  setPlaidReauthAlertedAt,
} from "@/lib/queries/plaid-settings";

describe("plaid settings helpers", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns disconnected defaults when nothing stored", () => {
    const c = getPlaidConnection(db);
    expect(c).toEqual({
      accessToken: null,
      itemId: null,
      accountMap: {},
      connectionStatus: "disconnected",
      lastSyncAt: null,
      plaidAccounts: [],
    });
  });

  it("round-trips item, map, cache, status, lastSync", () => {
    setPlaidItem(db, "access-sandbox-123", "item-9");
    setPlaidAccountMap(db, { plaidA: 1, plaidB: 2 });
    setPlaidAccountsCache(db, [
      { id: "plaidA", name: "Brokerage", mask: "1234", subtype: "brokerage" },
    ]);
    setPlaidLastSyncAt(db, "2026-07-10T12:00:00.000Z");
    const c = getPlaidConnection(db);
    expect(c.accessToken).toBe("access-sandbox-123");
    expect(c.itemId).toBe("item-9");
    expect(c.accountMap).toEqual({ plaidA: 1, plaidB: 2 });
    expect(c.plaidAccounts[0].name).toBe("Brokerage");
    expect(c.connectionStatus).toBe("ok");
    expect(c.lastSyncAt).toBe("2026-07-10T12:00:00.000Z");
    setPlaidConnectionStatus(db, "reauth_required");
    expect(getPlaidConnection(db).connectionStatus).toBe("reauth_required");
  });

  it("tolerates malformed JSON map (falls back to empty)", () => {
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('plaid_account_map', 'not-json', datetime('now'))`,
    ).run();
    expect(getPlaidConnection(db).accountMap).toEqual({});
  });

  it("reauth alert stamp round-trips and clears", () => {
    expect(getPlaidReauthAlertedAt(db)).toBeNull();
    setPlaidReauthAlertedAt(db, "2026-07-10T13:00:00.000Z");
    expect(getPlaidReauthAlertedAt(db)).toBe("2026-07-10T13:00:00.000Z");
    setPlaidReauthAlertedAt(db, null);
    expect(getPlaidReauthAlertedAt(db)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/queries/plaid-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/queries/plaid-settings.ts`**

```ts
import type Database from "better-sqlite3";

// Plaid connection state lives in the SQLite `settings` table (runtime-
// obtained by the web app; DB is local + gitignored). Static creds
// (PLAID_CLIENT_ID/SECRET) come from env — see lib/plaid/client.ts.
const KEY_ACCESS_TOKEN = "plaid_access_token";
const KEY_ITEM_ID = "plaid_item_id";
const KEY_ACCOUNT_MAP = "plaid_account_map";
const KEY_ACCOUNTS_CACHE = "plaid_accounts_cache";
const KEY_CONNECTION_STATUS = "plaid_connection_status";
const KEY_LAST_SYNC_AT = "plaid_last_sync_at";
const KEY_REAUTH_ALERTED_AT = "plaid_reauth_alerted_at";

export interface PlaidAccountInfo {
  id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
}

export interface PlaidConnection {
  accessToken: string | null;
  itemId: string | null;
  accountMap: Record<string, number>;
  connectionStatus: "ok" | "reauth_required" | "disconnected";
  lastSyncAt: string | null;
  plaidAccounts: PlaidAccountInfo[];
}

function getValue(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setValue(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
  ).run(key, value);
}

function deleteValue(db: Database.Database, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getPlaidConnection(db: Database.Database): PlaidConnection {
  const accessToken = getValue(db, KEY_ACCESS_TOKEN);
  const rawStatus = getValue(db, KEY_CONNECTION_STATUS);
  const map = parseJson<Record<string, number>>(getValue(db, KEY_ACCOUNT_MAP), {});
  return {
    accessToken,
    itemId: getValue(db, KEY_ITEM_ID),
    accountMap: typeof map === "object" && map !== null && !Array.isArray(map) ? map : {},
    connectionStatus: !accessToken
      ? "disconnected"
      : rawStatus === "reauth_required"
        ? "reauth_required"
        : "ok",
    lastSyncAt: getValue(db, KEY_LAST_SYNC_AT),
    plaidAccounts: parseJson<PlaidAccountInfo[]>(getValue(db, KEY_ACCOUNTS_CACHE), []),
  };
}

export function setPlaidItem(db: Database.Database, accessToken: string, itemId: string): void {
  setValue(db, KEY_ACCESS_TOKEN, accessToken);
  setValue(db, KEY_ITEM_ID, itemId);
  setValue(db, KEY_CONNECTION_STATUS, "ok");
}

export function setPlaidAccountMap(db: Database.Database, map: Record<string, number>): void {
  setValue(db, KEY_ACCOUNT_MAP, JSON.stringify(map));
}

export function setPlaidAccountsCache(db: Database.Database, accounts: PlaidAccountInfo[]): void {
  setValue(db, KEY_ACCOUNTS_CACHE, JSON.stringify(accounts));
}

export function setPlaidConnectionStatus(
  db: Database.Database,
  status: "ok" | "reauth_required",
): void {
  setValue(db, KEY_CONNECTION_STATUS, status);
}

export function setPlaidLastSyncAt(db: Database.Database, iso: string): void {
  setValue(db, KEY_LAST_SYNC_AT, iso);
}

export function getPlaidReauthAlertedAt(db: Database.Database): string | null {
  return getValue(db, KEY_REAUTH_ALERTED_AT);
}

export function setPlaidReauthAlertedAt(db: Database.Database, iso: string | null): void {
  if (iso === null) deleteValue(db, KEY_REAUTH_ALERTED_AT);
  else setValue(db, KEY_REAUTH_ALERTED_AT, iso);
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/queries/plaid-settings.test.ts` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/queries/plaid-settings.ts tests/queries/plaid-settings.test.ts
git commit -m "feat(plaid): settings-table connection helpers (token, map, status, stamps)"
```

---

### Task 6: Plaid REST client (`fetch`-based, DI)

**Files:**
- Create: `lib/plaid/client.ts`
- Test: `tests/plaid/client.test.ts`

**Interfaces:**
- Produces:
  - `PlaidClientConfig = { clientId: string; secret: string; env: "sandbox" | "production"; redirectUri: string; fetchImpl?: typeof fetch }`
  - `loadPlaidConfig(): PlaidClientConfig | null` — from `process.env.PLAID_CLIENT_ID/PLAID_SECRET/PLAID_ENV/PLAID_REDIRECT_URI`; null when clientId or secret missing; env defaults `"production"`, redirectUri defaults `"http://localhost:3099/dashboard/plaid-link"`.
  - `class PlaidApiError extends Error { errorCode: string; errorType: string }`
  - `createLinkToken(cfg, opts?: { accessToken?: string }): Promise<string>` — update/reauth mode when accessToken given.
  - `exchangePublicToken(cfg, publicToken: string): Promise<{ accessToken: string; itemId: string }>`
  - `getInvestmentsHoldings(cfg, accessToken: string): Promise<PlaidHoldingsResponse>`
  - Types: `PlaidHoldingsResponse = { accounts: PlaidAccount[]; holdings: PlaidHolding[]; securities: PlaidSecurity[] }`; `PlaidAccount = { account_id: string; name: string; mask: string | null; subtype: string | null; balances: { current: number | null; available: number | null } }`; `PlaidHolding = { account_id: string; security_id: string; quantity: number; institution_price: number | null; institution_value: number | null; institution_price_as_of: string | null }`; `PlaidSecurity = { security_id: string; ticker_symbol: string | null; cusip: string | null; name: string | null; type: string | null; is_cash_equivalent: boolean | null; option_contract?: { contract_type: "call" | "put"; expiration_date: string; strike_price: number; underlying_security_ticker: string | null } | null }`.

- [ ] **Step 1: Write the failing test**

Create `tests/plaid/client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createLinkToken,
  exchangePublicToken,
  getInvestmentsHoldings,
  PlaidApiError,
  type PlaidClientConfig,
} from "@/lib/plaid/client";

function stubFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function cfg(fetchImpl: typeof fetch): PlaidClientConfig {
  return {
    clientId: "cid",
    secret: "sec",
    env: "sandbox",
    redirectUri: "http://localhost:3099/dashboard/plaid-link",
    fetchImpl,
  };
}

describe("plaid client", () => {
  it("createLinkToken posts investments product + redirect_uri and returns token", async () => {
    const { impl, calls } = stubFetch([{ json: { link_token: "link-abc" } }]);
    const token = await createLinkToken(cfg(impl));
    expect(token).toBe("link-abc");
    expect(calls[0].url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(calls[0].body.client_id).toBe("cid");
    expect(calls[0].body.secret).toBe("sec");
    expect(calls[0].body.products).toEqual(["investments"]);
    expect(calls[0].body.country_codes).toEqual(["US"]);
    expect(calls[0].body.redirect_uri).toBe("http://localhost:3099/dashboard/plaid-link");
  });

  it("createLinkToken in reauth mode passes access_token and omits products", async () => {
    const { impl, calls } = stubFetch([{ json: { link_token: "link-re" } }]);
    await createLinkToken(cfg(impl), { accessToken: "access-1" });
    expect(calls[0].body.access_token).toBe("access-1");
    expect(calls[0].body.products).toBeUndefined();
  });

  it("exchangePublicToken returns accessToken + itemId", async () => {
    const { impl } = stubFetch([{ json: { access_token: "access-x", item_id: "item-x" } }]);
    const r = await exchangePublicToken(cfg(impl), "public-1");
    expect(r).toEqual({ accessToken: "access-x", itemId: "item-x" });
  });

  it("getInvestmentsHoldings returns the typed payload", async () => {
    const payload = { accounts: [], holdings: [], securities: [] };
    const { impl, calls } = stubFetch([{ json: payload }]);
    const r = await getInvestmentsHoldings(cfg(impl), "access-x");
    expect(r).toEqual(payload);
    expect(calls[0].url).toBe("https://sandbox.plaid.com/investments/holdings/get");
    expect(calls[0].body.access_token).toBe("access-x");
  });

  it("maps Plaid error bodies to PlaidApiError with error_code", async () => {
    const { impl } = stubFetch([
      {
        status: 400,
        json: { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", error_message: "re-auth" },
      },
    ]);
    await expect(getInvestmentsHoldings(cfg(impl), "access-x")).rejects.toThrowError(PlaidApiError);
    try {
      await getInvestmentsHoldings(cfg(impl), "access-x");
    } catch (e) {
      expect((e as PlaidApiError).errorCode).toBe("ITEM_LOGIN_REQUIRED");
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/plaid/client.test.ts` — Expected: FAIL (module not found)

- [ ] **Step 3: Implement `lib/plaid/client.ts`**

```ts
// Plain-fetch Plaid REST client. Deliberately NO npm SDK: keeps the
// dependency surface flat and matches the Worker-mirror convention
// (any future cloud path must be fetch-based anyway).
export interface PlaidClientConfig {
  clientId: string;
  secret: string;
  env: "sandbox" | "production";
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

const HOSTS: Record<PlaidClientConfig["env"], string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export function loadPlaidConfig(): PlaidClientConfig | null {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) return null;
  const env = process.env.PLAID_ENV === "sandbox" ? "sandbox" : "production";
  return {
    clientId,
    secret,
    env,
    redirectUri:
      process.env.PLAID_REDIRECT_URI ?? "http://localhost:3099/dashboard/plaid-link",
  };
}

export class PlaidApiError extends Error {
  errorCode: string;
  errorType: string;
  constructor(message: string, errorCode: string, errorType: string) {
    super(message);
    this.name = "PlaidApiError";
    this.errorCode = errorCode;
    this.errorType = errorType;
  }
}

async function plaidPost<T>(
  cfg: PlaidClientConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${HOSTS[cfg.env]}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof json.error_code === "string") {
    throw new PlaidApiError(
      String(json.error_message ?? `Plaid ${path} failed (HTTP ${res.status})`),
      String(json.error_code ?? `HTTP_${res.status}`),
      String(json.error_type ?? "UNKNOWN"),
    );
  }
  return json as T;
}

export async function createLinkToken(
  cfg: PlaidClientConfig,
  opts: { accessToken?: string } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    client_name: "Portfolio Desk",
    user: { client_user_id: "vanguard-skin-local" },
    country_codes: ["US"],
    language: "en",
    redirect_uri: cfg.redirectUri,
  };
  if (opts.accessToken) {
    body.access_token = opts.accessToken; // Link update mode (re-auth)
  } else {
    body.products = ["investments"];
  }
  const r = await plaidPost<{ link_token: string }>(cfg, "/link/token/create", body);
  return r.link_token;
}

export async function exchangePublicToken(
  cfg: PlaidClientConfig,
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const r = await plaidPost<{ access_token: string; item_id: string }>(
    cfg,
    "/item/public_token/exchange",
    { public_token: publicToken },
  );
  return { accessToken: r.access_token, itemId: r.item_id };
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
  balances: { current: number | null; available: number | null };
}

export interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number | null;
  institution_value: number | null;
  institution_price_as_of: string | null;
}

export interface PlaidSecurity {
  security_id: string;
  ticker_symbol: string | null;
  cusip: string | null;
  name: string | null;
  type: string | null;
  is_cash_equivalent: boolean | null;
  option_contract?: {
    contract_type: "call" | "put";
    expiration_date: string;
    strike_price: number;
    underlying_security_ticker: string | null;
  } | null;
}

export interface PlaidHoldingsResponse {
  accounts: PlaidAccount[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
}

export async function getInvestmentsHoldings(
  cfg: PlaidClientConfig,
  accessToken: string,
): Promise<PlaidHoldingsResponse> {
  return plaidPost<PlaidHoldingsResponse>(cfg, "/investments/holdings/get", {
    access_token: accessToken,
  });
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/plaid/client.test.ts` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/plaid/client.ts tests/plaid/client.test.ts
git commit -m "feat(plaid): fetch-based REST client (link token, exchange, holdings) with DI"
```

---

### Task 7: Pure holdings mapper + account auto-matcher

**Files:**
- Create: `lib/plaid/map-holdings.ts`
- Create: `lib/plaid/map-accounts.ts`
- Test: `tests/plaid/map-holdings.test.ts`, `tests/plaid/map-accounts.test.ts`

**Interfaces:**
- Consumes: `PlaidHoldingsResponse`, `PlaidAccount`, `PlaidSecurity` from Task 6; `ensureOCCSymbol` (`lib/import/occ-symbol.ts`); `isGarbageSymbol` (`lib/import/validate.ts`).
- Produces:
  - `mapPlaidHoldings(resp: PlaidHoldingsResponse): PlaidMapResult` where `PlaidMapResult = { positions: MappedPlaidPosition[]; cashByAccount: Record<string, number>; totalByAccount: Record<string, number | null>; unmatched: UnmatchedPlaidSecurity[]; mutualFundPrices: MutualFundPrice[] }`; `MappedPlaidPosition = { plaidAccountId: string; symbol: string; name: string | null; securityType: string; quantity: number; underlyingSymbol?: string; strikePrice?: number; expirationDate?: string; optionType?: "CALL" | "PUT" }`; `UnmatchedPlaidSecurity = { name: string | null; reason: string }`; `MutualFundPrice = { plaidAccountId: string; symbol: string; price: number; asOf: string | null }`.
  - `proposeAccountMap(plaidAccounts: PlaidAccount[], localAccounts: { id: number; name: string }[]): Record<string, number>`

Mapping rules (mirror of the spec + statement-import conventions):
- Security lookup key: trimmed `ticker_symbol`; when null/empty, fall back to `cusip` (bonds store CUSIP as `securities.symbol` in this codebase); when both missing or `isGarbageSymbol` rejects → `unmatched` with reason, never guessed.
- `is_cash_equivalent === true` OR ticker `VMFXX` → fold `institution_value` into `cashByAccount`, no position.
- `type === "derivative"` with `option_contract` → OCC symbol via `ensureOCCSymbol(ticker ?? underlying, underlying, expiration, contract_type.toUpperCase(), strike)`, securityType `"Option"`; derivative WITHOUT contract metadata → unmatched (`"derivative without option_contract"`).
- Plaid `type` → DB securityType map: `equity`→`Stock`, `etf`→`ETF`, `mutual fund`→`Mutual Fund`, `fixed income`→`Bond`, `derivative`→`Option`, `cash`→cash-fold; unknown types pass through capitalized-first-letter (upsertSecurity normalizes at the write boundary anyway).
- `quantity === 0` → skip (matches IBKR path).
- `mutualFundPrices`: for mapped positions with plaid type `mutual fund` and non-null `institution_price`.
- `totalByAccount`: `balances.current` per account (null preserved).
- `proposeAccountMap`: a plaid account whose `name`/`subtype` contains "roth" (case-insensitive) maps to the local account whose name contains "roth"; every other plaid account maps to the local account whose name contains "vanguard" but NOT "roth" (resolveScope disjointness rule). Plaid accounts with no local match are omitted.

- [ ] **Step 1: Write the failing tests**

Create `tests/plaid/map-holdings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapPlaidHoldings } from "@/lib/plaid/map-holdings";
import type { PlaidHoldingsResponse } from "@/lib/plaid/client";

function baseResp(): PlaidHoldingsResponse {
  return {
    accounts: [
      {
        account_id: "acctA",
        name: "Brokerage",
        mask: "1234",
        subtype: "brokerage",
        balances: { current: 250000, available: null },
      },
    ],
    holdings: [
      { account_id: "acctA", security_id: "s-eq", quantity: 100, institution_price: 50, institution_value: 5000, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-mf", quantity: 200, institution_price: 87.31, institution_value: 17462, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-mm", quantity: 12000, institution_price: 1, institution_value: 12000, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-opt", quantity: 2, institution_price: 11.2, institution_value: 2240, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-bond", quantity: 10000, institution_price: 0.98, institution_value: 9800, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-junk", quantity: 5, institution_price: 1, institution_value: 5, institution_price_as_of: null },
      { account_id: "acctA", security_id: "s-zero", quantity: 0, institution_price: 10, institution_value: 0, institution_price_as_of: null },
    ],
    securities: [
      { security_id: "s-eq", ticker_symbol: "PRIM", cusip: "74164F103", name: "Primoris", type: "equity", is_cash_equivalent: false },
      { security_id: "s-mf", ticker_symbol: "VWENX", cusip: null, name: "Wellington Admiral", type: "mutual fund", is_cash_equivalent: false },
      { security_id: "s-mm", ticker_symbol: "VMFXX", cusip: null, name: "Federal Money Market", type: "mutual fund", is_cash_equivalent: true },
      {
        security_id: "s-opt", ticker_symbol: null, cusip: null, name: "TER Mar 2027 Call", type: "derivative", is_cash_equivalent: false,
        option_contract: { contract_type: "call", expiration_date: "2027-03-19", strike_price: 100, underlying_security_ticker: "TER" },
      },
      { security_id: "s-bond", ticker_symbol: null, cusip: "912797GD5", name: "US T-Bill", type: "fixed income", is_cash_equivalent: false },
      { security_id: "s-junk", ticker_symbol: null, cusip: null, name: "Mystery Asset", type: "other", is_cash_equivalent: false },
      { security_id: "s-zero", ticker_symbol: "GONE", cusip: null, name: "Closed", type: "equity", is_cash_equivalent: false },
    ],
  };
}

describe("mapPlaidHoldings", () => {
  it("maps equity/mf/option/bond, folds cash, skips zero-qty, reports unmatched", () => {
    const r = mapPlaidHoldings(baseResp());
    const symbols = r.positions.map((p) => p.symbol);
    expect(symbols).toContain("PRIM");
    expect(symbols).toContain("VWENX");
    expect(symbols).toContain("912797GD5"); // CUSIP-as-symbol bond
    expect(symbols).not.toContain("VMFXX"); // folded into cash
    expect(symbols).not.toContain("GONE"); // zero quantity skipped
    expect(r.cashByAccount.acctA).toBe(12000);
    expect(r.totalByAccount.acctA).toBe(250000);
    expect(r.unmatched).toEqual([{ name: "Mystery Asset", reason: "no ticker or cusip" }]);
  });

  it("builds OCC symbols for options with contract metadata", () => {
    const r = mapPlaidHoldings(baseResp());
    const opt = r.positions.find((p) => p.securityType === "Option");
    expect(opt).toBeDefined();
    expect(opt!.symbol).toBe("TER   270319C00100000");
    expect(opt!.underlyingSymbol).toBe("TER");
    expect(opt!.optionType).toBe("CALL");
    expect(opt!.strikePrice).toBe(100);
    expect(opt!.expirationDate).toBe("2027-03-19");
  });

  it("collects mutual-fund prices only", () => {
    const r = mapPlaidHoldings(baseResp());
    expect(r.mutualFundPrices).toEqual([
      { plaidAccountId: "acctA", symbol: "VWENX", price: 87.31, asOf: "2026-07-09" },
    ]);
  });
});
```

Create `tests/plaid/map-accounts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { proposeAccountMap } from "@/lib/plaid/map-accounts";
import type { PlaidAccount } from "@/lib/plaid/client";

function pa(id: string, name: string, subtype: string | null): PlaidAccount {
  return { account_id: id, name, mask: null, subtype, balances: { current: null, available: null } };
}

describe("proposeAccountMap", () => {
  const locals = [
    { id: 1, name: "Vanguard Taxable" },
    { id: 2, name: "Vanguard Roth IRA" },
    { id: 3, name: "IBKR" },
  ];

  it("maps roth plaid account to local roth, brokerage to vanguard non-roth", () => {
    const map = proposeAccountMap(
      [pa("pA", "Roth IRA Brokerage", "roth"), pa("pB", "Individual Brokerage", "brokerage")],
      locals,
    );
    expect(map).toEqual({ pA: 2, pB: 1 });
  });

  it("omits plaid accounts with no local match", () => {
    const map = proposeAccountMap([pa("pC", "529 Plan", "529")], [{ id: 3, name: "IBKR" }]);
    expect(map).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/plaid` — Expected: FAIL (modules not found). Note: if the OCC symbol assertion value is wrong, check `ensureOCCSymbol`'s actual padding output in `lib/import/occ-symbol.ts` (OCC format: 6-char left-justified underlying + YYMMDD + C/P + 8-digit strike×1000) and correct the expected string to match the real formatter before implementing.

- [ ] **Step 3: Implement**

`lib/plaid/map-accounts.ts`:

```ts
import type { PlaidAccount } from "./client";

// Auto-match Plaid accounts to local accounts rows. Mirrors resolveScope's
// disjointness rule: "vanguard" means vanguard-and-NOT-roth.
export function proposeAccountMap(
  plaidAccounts: PlaidAccount[],
  localAccounts: { id: number; name: string }[],
): Record<string, number> {
  const rothLocal = localAccounts.find((a) => a.name.toLowerCase().includes("roth"));
  const vanguardLocal = localAccounts.find((a) => {
    const n = a.name.toLowerCase();
    return n.includes("vanguard") && !n.includes("roth");
  });
  const map: Record<string, number> = {};
  for (const pa of plaidAccounts) {
    const label = `${pa.name} ${pa.subtype ?? ""}`.toLowerCase();
    const target = label.includes("roth") ? rothLocal : vanguardLocal;
    if (target) map[pa.account_id] = target.id;
  }
  return map;
}
```

`lib/plaid/map-holdings.ts`:

```ts
import { ensureOCCSymbol } from "@/lib/import/occ-symbol";
import { isGarbageSymbol } from "@/lib/import/validate";
import type { PlaidHoldingsResponse, PlaidSecurity } from "./client";

export interface MappedPlaidPosition {
  plaidAccountId: string;
  symbol: string;
  name: string | null;
  securityType: string;
  quantity: number;
  underlyingSymbol?: string;
  strikePrice?: number;
  expirationDate?: string;
  optionType?: "CALL" | "PUT";
}

export interface UnmatchedPlaidSecurity {
  name: string | null;
  reason: string;
}

export interface MutualFundPrice {
  plaidAccountId: string;
  symbol: string;
  price: number;
  asOf: string | null;
}

export interface PlaidMapResult {
  positions: MappedPlaidPosition[];
  cashByAccount: Record<string, number>;
  totalByAccount: Record<string, number | null>;
  unmatched: UnmatchedPlaidSecurity[];
  mutualFundPrices: MutualFundPrice[];
}

const TYPE_MAP: Record<string, string> = {
  equity: "Stock",
  etf: "ETF",
  "mutual fund": "Mutual Fund",
  "fixed income": "Bond",
  derivative: "Option",
};

function resolveSymbol(sec: PlaidSecurity): { symbol: string } | { reason: string } {
  const ticker = sec.ticker_symbol?.trim();
  if (ticker && !isGarbageSymbol(ticker)) return { symbol: ticker };
  const cusip = sec.cusip?.trim();
  // Bonds store CUSIP as securities.symbol in this codebase.
  if (cusip && !isGarbageSymbol(cusip)) return { symbol: cusip };
  return { reason: ticker || cusip ? "garbage symbol" : "no ticker or cusip" };
}

export function mapPlaidHoldings(resp: PlaidHoldingsResponse): PlaidMapResult {
  const secById = new Map(resp.securities.map((s) => [s.security_id, s]));
  const result: PlaidMapResult = {
    positions: [],
    cashByAccount: {},
    totalByAccount: {},
    unmatched: [],
    mutualFundPrices: [],
  };
  for (const a of resp.accounts) result.totalByAccount[a.account_id] = a.balances.current;

  for (const h of resp.holdings) {
    if (h.quantity === 0) continue;
    const sec = secById.get(h.security_id);
    if (!sec) {
      result.unmatched.push({ name: h.security_id, reason: "security not in response" });
      continue;
    }
    const plaidType = (sec.type ?? "").toLowerCase();

    // Settlement fund / cash equivalents fold into cash, never a position.
    if (sec.is_cash_equivalent === true || sec.ticker_symbol?.trim() === "VMFXX") {
      if (h.institution_value != null) {
        result.cashByAccount[h.account_id] =
          (result.cashByAccount[h.account_id] ?? 0) + h.institution_value;
      }
      continue;
    }

    if (plaidType === "derivative") {
      const oc = sec.option_contract;
      if (!oc) {
        result.unmatched.push({ name: sec.name, reason: "derivative without option_contract" });
        continue;
      }
      const underlying = oc.underlying_security_ticker?.trim() || undefined;
      const optionType = oc.contract_type.toUpperCase() as "CALL" | "PUT";
      const symbol = ensureOCCSymbol(
        sec.ticker_symbol?.trim() || underlying || "",
        underlying,
        oc.expiration_date,
        optionType,
        oc.strike_price,
      );
      if (!symbol || isGarbageSymbol(symbol)) {
        result.unmatched.push({ name: sec.name, reason: "option missing OCC inputs" });
        continue;
      }
      result.positions.push({
        plaidAccountId: h.account_id,
        symbol,
        name: sec.name,
        securityType: "Option",
        quantity: h.quantity,
        underlyingSymbol: underlying,
        strikePrice: oc.strike_price,
        expirationDate: oc.expiration_date,
        optionType,
      });
      continue;
    }

    const resolved = resolveSymbol(sec);
    if ("reason" in resolved) {
      result.unmatched.push({ name: sec.name, reason: resolved.reason });
      continue;
    }
    const securityType =
      TYPE_MAP[plaidType] ?? (plaidType ? plaidType[0].toUpperCase() + plaidType.slice(1) : "Stock");
    result.positions.push({
      plaidAccountId: h.account_id,
      symbol: resolved.symbol,
      name: sec.name,
      securityType,
      quantity: h.quantity,
    });
    if (plaidType === "mutual fund" && h.institution_price != null) {
      result.mutualFundPrices.push({
        plaidAccountId: h.account_id,
        symbol: resolved.symbol,
        price: h.institution_price,
        asOf: h.institution_price_as_of,
      });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/plaid` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/plaid/map-holdings.ts lib/plaid/map-accounts.ts tests/plaid/map-holdings.test.ts tests/plaid/map-accounts.test.ts
git commit -m "feat(plaid): pure holdings mapper (OCC options, CUSIP bonds, cash fold) + account auto-matcher"
```

---

### Task 8: Sync orchestrator `refreshVanguardHoldingsFromPlaid`

**Files:**
- Create: `lib/plaid/refresh.ts`
- Test: `tests/plaid/refresh.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7 outputs; `todayET` (`lib/calendar/date-utils.ts`); `isMarketClosed` (`lib/calendar/market-holidays.ts`); `upsertSecurity` (`lib/mutations/securities.ts`); `reconcileClosedEquityHoldings` (`lib/mutations/closed-equity.ts`); `computeDailyValuations` (`lib/compute/daily-valuation.ts`); `isSyncing/setSyncPhase/setSyncComplete/setSyncError` (`lib/tws/sync-state.ts`); `sendPushover` (`lib/alerts/notify-pushover.ts`).
- Produces:
  - `refreshVanguardHoldingsFromPlaid(db, opts?: { cfg?: PlaidClientConfig | null; force?: boolean; now?: Date }): Promise<PlaidRefreshResult | null>` — `null` = unconfigured / not connected / sync in progress.
  - `PlaidRefreshResult = { skippedReason: "market_closed" | "already_synced_today" | null; accountsSynced: number; holdingsWritten: number; pricesWritten: number; staleRemoved: number; unmatched: UnmatchedPlaidSecurity[] }`
  - Exported for tests: `writePlaidHoldings(db, mapped: PlaidMapResult, accountMap: Record<string, number>, today: string): { accountsSynced: number; holdingsWritten: number; pricesWritten: number; staleRemoved: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/plaid/refresh.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";
import { setPlaidItem, setPlaidAccountMap, getPlaidConnection, getPlaidReauthAlertedAt } from "@/lib/queries/plaid-settings";
import type { PlaidClientConfig } from "@/lib/plaid/client";
import { todayET } from "@/lib/calendar/date-utils";

// A weekday, non-holiday reference instant (Fri 2026-07-10 ~noon ET)
const NOW = new Date("2026-07-10T16:00:00.000Z");
const TODAY = todayET(NOW);

function holdingsJson() {
  return {
    accounts: [
      { account_id: "pTax", name: "Individual Brokerage", mask: "1111", subtype: "brokerage", balances: { current: 300000, available: null } },
    ],
    holdings: [
      { account_id: "pTax", security_id: "s1", quantity: 500, institution_price: 40, institution_value: 20000, institution_price_as_of: TODAY },
      { account_id: "pTax", security_id: "s2", quantity: 100, institution_price: 87.31, institution_value: 8731, institution_price_as_of: TODAY },
      { account_id: "pTax", security_id: "s3", quantity: 15000, institution_price: 1, institution_value: 15000, institution_price_as_of: TODAY },
    ],
    securities: [
      { security_id: "s1", ticker_symbol: "PRIM", cusip: null, name: "Primoris", type: "equity", is_cash_equivalent: false },
      { security_id: "s2", ticker_symbol: "VWENX", cusip: null, name: "Wellington", type: "mutual fund", is_cash_equivalent: false },
      { security_id: "s3", ticker_symbol: "VMFXX", cusip: null, name: "Money Market", type: "mutual fund", is_cash_equivalent: true },
    ],
  };
}

function stubCfg(json: unknown, status = 200): PlaidClientConfig {
  return {
    clientId: "cid",
    secret: "sec",
    env: "sandbox",
    redirectUri: "http://localhost:3099/dashboard/plaid-link",
    fetchImpl: (async () =>
      new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })) as typeof fetch,
  };
}

describe("refreshVanguardHoldingsFromPlaid", () => {
  let db: Database.Database;
  let taxableId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    taxableId = db.prepare(`INSERT INTO accounts (name) VALUES ('Vanguard Taxable')`).run()
      .lastInsertRowid as number;
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: taxableId });
  });

  it("returns null when not connected", async () => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    runMigrations(fresh);
    const r = await refreshVanguardHoldingsFromPlaid(fresh, { cfg: stubCfg(holdingsJson()), now: NOW });
    expect(r).toBeNull();
  });

  it("writes holdings, cash snapshot, MF price; folds VMFXX to cash", async () => {
    const r = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    expect(r).not.toBeNull();
    expect(r!.holdingsWritten).toBe(2); // PRIM + VWENX (VMFXX folded)
    const holdings = db
      .prepare(
        `SELECT s.symbol, h.quantity, h.cost_basis, h.source_key FROM holdings h JOIN securities s ON s.id = h.security_id WHERE h.account_id = ? AND h.as_of_date = ?`,
      )
      .all(taxableId, TODAY) as { symbol: string; quantity: number; cost_basis: number | null; source_key: string }[];
    expect(holdings.map((h) => h.symbol).sort()).toEqual(["PRIM", "VWENX"]);
    expect(holdings.every((h) => h.cost_basis === null)).toBe(true);
    expect(holdings.every((h) => h.source_key.startsWith("plaid:"))).toBe(true);

    const snap = db
      .prepare(`SELECT total_value, cash_value, source FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?`)
      .get(taxableId, TODAY) as { total_value: number; cash_value: number; source: string };
    expect(snap).toEqual({ total_value: 300000, cash_value: 15000, source: "plaid" });

    const price = db
      .prepare(
        `SELECT p.close_price, p.source FROM prices p JOIN securities s ON s.id = p.security_id WHERE s.symbol = 'VWENX' AND p.date = ?`,
      )
      .get(TODAY) as { close_price: number; source: string };
    expect(price).toEqual({ close_price: 87.31, source: "plaid" });
  });

  it("never overwrites a statement-sourced snapshot", async () => {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, 111, 'vanguard-pdf')`,
    ).run(taxableId, TODAY);
    await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    const snap = db
      .prepare(`SELECT total_value, source FROM monthly_snapshots WHERE account_id = ?`)
      .get(taxableId) as { total_value: number; source: string };
    expect(snap.source).toBe("vanguard-pdf");
    expect(snap.total_value).toBe(111);
  });

  it("removes same-day plaid rows for positions gone from the pull (intraday round-trip)", async () => {
    const goneId = upsertSecurity(db, { symbol: "GONE", securityType: "Stock" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 10, NULL, ?, ?)`,
    ).run(taxableId, goneId, TODAY, `plaid:${taxableId}:${goneId}:${TODAY}`);
    const r = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    expect(r!.staleRemoved).toBe(1);
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM holdings WHERE security_id = ?`).get(goneId),
    ).toEqual({ c: 0 });
  });

  it("skips a second run the same ET day unless forced", async () => {
    await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW, force: true });
    const second = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(holdingsJson()), now: NOW });
    expect(second!.skippedReason).toBe("already_synced_today");
  });

  it("marks reauth_required + stamps alert on ITEM_LOGIN_REQUIRED", async () => {
    const errCfg = stubCfg(
      { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", error_message: "re-auth needed" },
      400,
    );
    await expect(
      refreshVanguardHoldingsFromPlaid(db, { cfg: errCfg, now: NOW, force: true }),
    ).rejects.toThrow();
    expect(getPlaidConnection(db).connectionStatus).toBe("reauth_required");
    expect(getPlaidReauthAlertedAt(db)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/plaid/refresh.test.ts` — Expected: FAIL (module not found)

- [ ] **Step 3: Implement `lib/plaid/refresh.ts`**

```ts
import type Database from "better-sqlite3";
import {
  getInvestmentsHoldings,
  loadPlaidConfig,
  PlaidApiError,
  type PlaidClientConfig,
} from "./client";
import { mapPlaidHoldings, type PlaidMapResult, type UnmatchedPlaidSecurity } from "./map-holdings";
import {
  getPlaidConnection,
  getPlaidReauthAlertedAt,
  setPlaidConnectionStatus,
  setPlaidLastSyncAt,
  setPlaidReauthAlertedAt,
} from "@/lib/queries/plaid-settings";
import { upsertSecurity } from "@/lib/mutations/securities";
import { removeStaleSameDayTwsHoldings } from "@/lib/mutations/same-day-tws-holdings";
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import { isSyncing, setSyncComplete, setSyncError, setSyncPhase } from "@/lib/tws/sync-state";
import { sendPushover } from "@/lib/alerts/notify-pushover";

export interface PlaidRefreshResult {
  skippedReason: "market_closed" | "already_synced_today" | null;
  accountsSynced: number;
  holdingsWritten: number;
  pricesWritten: number;
  staleRemoved: number;
  unmatched: UnmatchedPlaidSecurity[];
}

const EMPTY: Omit<PlaidRefreshResult, "skippedReason"> = {
  accountsSynced: 0,
  holdingsWritten: 0,
  pricesWritten: 0,
  staleRemoved: 0,
  unmatched: [],
};

/**
 * The DB half — exported for tests. Mirrors writeIbkrHoldings but with
 * 'plaid' provenance: conditional upserts that can never claim a
 * statement row, source='plaid' live snapshot, MF-only prices.
 */
export function writePlaidHoldings(
  db: Database.Database,
  mapped: PlaidMapResult,
  accountMap: Record<string, number>,
  today: string,
): { accountsSynced: number; holdingsWritten: number; pricesWritten: number; staleRemoved: number } {
  const upsertHolding = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
       quantity = excluded.quantity,
       cost_basis = excluded.cost_basis,
       source_key = excluded.source_key
     WHERE holdings.source_key LIKE 'tws-%' OR holdings.source_key LIKE 'plaid:%'`,
  );
  const upsertSnapshot = db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
     VALUES (?, ?, ?, ?, 'plaid')
     ON CONFLICT(account_id, month_end_date) DO UPDATE SET
       total_value = excluded.total_value,
       cash_value = excluded.cash_value,
       source = excluded.source
     WHERE monthly_snapshots.source IN ('tws', 'manual', 'plaid')`,
  );
  // Prices: plaid may only claim plaid/manual rows — tws + statement prices win.
  const upsertPrice = db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source)
     VALUES (?, ?, ?, 'plaid')
     ON CONFLICT(security_id, date) DO UPDATE SET
       close_price = excluded.close_price,
       source = excluded.source
     WHERE prices.source IN ('plaid', 'manual')`,
  );

  let accountsSynced = 0;
  let holdingsWritten = 0;
  let pricesWritten = 0;
  let staleRemoved = 0;

  for (const [plaidAccountId, localAccountId] of Object.entries(accountMap)) {
    const positions = mapped.positions.filter((p) => p.plaidAccountId === plaidAccountId);
    // Zero-holdings guard: a partial/failed Plaid response must never
    // look like "everything sold" — skip the account entirely.
    if (positions.length === 0) continue;
    accountsSynced++;

    const syncedSecurityIds: number[] = [];
    for (const p of positions) {
      const securityId = upsertSecurity(db, {
        symbol: p.symbol,
        name: p.name ?? undefined,
        securityType: p.securityType,
        underlyingSymbol: p.underlyingSymbol,
        strikePrice: p.strikePrice,
        expirationDate: p.expirationDate,
        optionType: p.optionType,
      });
      syncedSecurityIds.push(securityId);
      const res = upsertHolding.run(
        localAccountId,
        securityId,
        p.quantity,
        today,
        `plaid:${localAccountId}:${securityId}:${today}`,
      );
      if (res.changes > 0) holdingsWritten++;
    }

    const stale = removeStaleSameDayTwsHoldings(db, {
      accountId: localAccountId,
      asOfDate: today,
      syncedSecurityIds,
      sourceKeyLike: "plaid:%",
    });
    staleRemoved += stale.deleted;

    const total = mapped.totalByAccount[plaidAccountId];
    if (total != null) {
      upsertSnapshot.run(
        localAccountId,
        today,
        total,
        mapped.cashByAccount[plaidAccountId] ?? null,
      );
    }

    for (const mf of mapped.mutualFundPrices.filter((m) => m.plaidAccountId === plaidAccountId)) {
      const sec = db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(mf.symbol) as
        | { id: number }
        | undefined;
      if (!sec) continue;
      const res = upsertPrice.run(sec.id, mf.asOf ?? today, mf.price);
      if (res.changes > 0) pricesWritten++;
    }

    // Snapshot-diff closure sweep: equities absent from today's full book
    // get quantity=0 rows (non-destructive, shrink-guarded).
    reconcileClosedEquityHoldings(db, { accountId: localAccountId });
  }

  return { accountsSynced, holdingsWritten, pricesWritten, staleRemoved };
}

export async function refreshVanguardHoldingsFromPlaid(
  db: Database.Database,
  opts: { cfg?: PlaidClientConfig | null; force?: boolean; now?: Date } = {},
): Promise<PlaidRefreshResult | null> {
  const cfg = opts.cfg !== undefined ? opts.cfg : loadPlaidConfig();
  if (!cfg) return null;
  const conn = getPlaidConnection(db);
  if (!conn.accessToken || Object.keys(conn.accountMap).length === 0) return null;
  if (isSyncing()) {
    console.log("[plaid] refresh skipped — a sync is already in progress");
    return null;
  }

  const today = todayET(opts.now);
  if (!opts.force && isMarketClosed(today)) {
    return { ...EMPTY, skippedReason: "market_closed" };
  }
  if (!opts.force && conn.lastSyncAt && todayET(new Date(conn.lastSyncAt)) === today) {
    return { ...EMPTY, skippedReason: "already_synced_today" };
  }

  const startTime = Date.now();
  setSyncPhase("positions");

  let mapped: PlaidMapResult;
  try {
    const resp = await getInvestmentsHoldings(cfg, conn.accessToken);
    mapped = mapPlaidHoldings(resp);
  } catch (err) {
    if (err instanceof PlaidApiError && err.errorCode === "ITEM_LOGIN_REQUIRED") {
      setPlaidConnectionStatus(db, "reauth_required");
      // Stamp BEFORE push so a Pushover failure can't cause repeat alerts.
      if (!getPlaidReauthAlertedAt(db)) {
        setPlaidReauthAlertedAt(db, new Date().toISOString());
        void sendPushover({
          title: "Plaid: Vanguard re-auth required",
          message:
            "The Plaid connection to Vanguard needs to be re-authenticated. Open Settings → Vanguard Live (Plaid) → Reconnect.",
        }).catch(() => {});
      }
    }
    setSyncError(err instanceof Error ? err.message : "Plaid refresh failed");
    throw err;
  }

  setSyncPhase("valuations");
  const written = writePlaidHoldings(db, mapped, conn.accountMap, today);
  try {
    computeDailyValuations(db);
  } catch {
    // Non-critical (mirrors the TWS + IBKR paths).
  }

  setPlaidLastSyncAt(db, new Date().toISOString());
  setPlaidConnectionStatus(db, "ok");
  setPlaidReauthAlertedAt(db, null);

  setSyncComplete(
    {
      positionsSynced: written.holdingsWritten,
      securitiesEnriched: 0,
      pricesUpdated: written.pricesWritten,
      valuationsRecomputed: true,
      benchmarksSynced: 0,
      alertsFired: 0,
      errors: mapped.unmatched.map((u) => `unmatched: ${u.name ?? "?"} (${u.reason})`),
      durationMs: Date.now() - startTime,
    },
    "plaid",
  );

  return { ...written, skippedReason: null, unmatched: mapped.unmatched };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/plaid` — Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add lib/plaid/refresh.ts tests/plaid/refresh.test.ts
git commit -m "feat(plaid): sync orchestrator — holdings/cash/MF-price writes, reauth handling, sync-state via 'plaid'"
```

---

### Task 9: API routes (link-token, exchange, settings, sync, cron)

**Files:**
- Create: `app/api/plaid/link-token/route.ts`
- Create: `app/api/plaid/exchange/route.ts`
- Create: `app/api/settings/plaid/route.ts`
- Create: `app/api/plaid/sync/route.ts`
- Create: `app/api/cron/plaid-sync/route.ts`
- Create: `lib/queries/plaid-settings-payload.ts` (payload builder, testable)
- Test: `tests/queries/plaid-settings-payload.test.ts` + add a shape assertion to `tests/contracts/api-component-contracts.test.ts`

**Interfaces:**
- Consumes: Tasks 5-8. `getAllAccounts` (`lib/queries/accounts.ts`), `getDb` — check how other routes obtain the db singleton (`import { getDb } from "@/lib/db"` pattern — verify the exact export name in `lib/db.ts` before writing; every other API route shows it).
- Produces:
  - `POST /api/plaid/link-token` → `{ success: true, linkToken }` (body `{ mode?: "reauth" }` — reauth passes stored accessToken → Link update mode); 400 when env unconfigured, 400 when reauth requested with no stored token.
  - `POST /api/plaid/exchange` body `{ publicToken }` → stores item, fetches holdings once to cache accounts, auto-proposes + stores account map, returns `{ success: true, plaidAccounts, accountMap }`.
  - `GET /api/settings/plaid` → `buildPlaidSettingsPayload(db)`; `PATCH` body `{ accountMap }` validates every value is an existing account id, saves, returns fresh payload.
  - `POST /api/plaid/sync` (in-app, no auth — same as `/api/tws/auto-refresh`) → `{ success: true, ...result }` / `{ success: false, error }` (500).
  - `POST /api/cron/plaid-sync` (X-Cron-Secret, timingSafeEqual pattern from `app/api/cron/research-sync/route.ts`) → same body, but calls refresh WITHOUT `force` so market-closed/already-synced gates apply.
  - `buildPlaidSettingsPayload(db): PlaidSettingsPayload = { configured: boolean; connected: boolean; connectionStatus: string; lastSyncAt: string | null; plaidAccounts: PlaidAccountInfo[]; accountMap: Record<string, number>; localAccounts: { id: number; name: string }[] }` (`configured` = `loadPlaidConfig() !== null`).

- [ ] **Step 1: Write the failing payload test**

Create `tests/queries/plaid-settings-payload.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildPlaidSettingsPayload } from "@/lib/queries/plaid-settings-payload";
import { setPlaidItem, setPlaidAccountsCache } from "@/lib/queries/plaid-settings";

describe("buildPlaidSettingsPayload", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(`INSERT INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  });

  it("reports disconnected shape with local accounts", () => {
    const p = buildPlaidSettingsPayload(db);
    expect(p.connected).toBe(false);
    expect(p.connectionStatus).toBe("disconnected");
    expect(p.localAccounts.length).toBe(1);
    expect(p.localAccounts[0]).toHaveProperty("id");
    expect(p.localAccounts[0]).toHaveProperty("name");
    expect(p.accountMap).toEqual({});
    expect(p.plaidAccounts).toEqual([]);
    expect(typeof p.configured).toBe("boolean");
  });

  it("reports connected shape", () => {
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountsCache(db, [{ id: "pA", name: "Brokerage", mask: null, subtype: null }]);
    const p = buildPlaidSettingsPayload(db);
    expect(p.connected).toBe(true);
    expect(p.plaidAccounts[0].name).toBe("Brokerage");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/queries/plaid-settings-payload.test.ts` — FAIL (module not found)

- [ ] **Step 3: Implement payload builder `lib/queries/plaid-settings-payload.ts`**

```ts
import type Database from "better-sqlite3";
import { loadPlaidConfig } from "@/lib/plaid/client";
import { getPlaidConnection, type PlaidAccountInfo } from "./plaid-settings";
import { getAllAccounts } from "./accounts";

export interface PlaidSettingsPayload {
  configured: boolean;
  connected: boolean;
  connectionStatus: "ok" | "reauth_required" | "disconnected";
  lastSyncAt: string | null;
  plaidAccounts: PlaidAccountInfo[];
  accountMap: Record<string, number>;
  localAccounts: { id: number; name: string }[];
}

export function buildPlaidSettingsPayload(db: Database.Database): PlaidSettingsPayload {
  const conn = getPlaidConnection(db);
  return {
    configured: loadPlaidConfig() !== null,
    connected: conn.accessToken !== null,
    connectionStatus: conn.connectionStatus,
    lastSyncAt: conn.lastSyncAt,
    plaidAccounts: conn.plaidAccounts,
    accountMap: conn.accountMap,
    localAccounts: getAllAccounts(db).map((a) => ({ id: a.id, name: a.name })),
  };
}
```

- [ ] **Step 4: Implement the five routes**

Before writing, open ONE existing route (e.g. `app/api/settings/earnings/route.ts`) to copy the exact db-singleton import used across routes, and `app/api/cron/research-sync/route.ts` for the `constantTimeEqual` helper. Routes (using `getDb` as the placeholder for the verified import):

`app/api/plaid/link-token/route.ts`:
```ts
import { getDb } from "@/lib/db";
import { createLinkToken, loadPlaidConfig } from "@/lib/plaid/client";
import { getPlaidConnection } from "@/lib/queries/plaid-settings";

export async function POST(request: Request) {
  const cfg = loadPlaidConfig();
  if (!cfg) {
    return Response.json(
      { success: false, error: "Plaid not configured — set PLAID_CLIENT_ID and PLAID_SECRET." },
      { status: 400 },
    );
  }
  let mode: string | undefined;
  try {
    mode = ((await request.json()) as { mode?: string }).mode;
  } catch {
    // empty body is fine
  }
  try {
    let accessToken: string | undefined;
    if (mode === "reauth") {
      const conn = getPlaidConnection(getDb());
      if (!conn.accessToken) {
        return Response.json(
          { success: false, error: "No existing Plaid connection to re-authenticate." },
          { status: 400 },
        );
      }
      accessToken = conn.accessToken;
    }
    const linkToken = await createLinkToken(cfg, { accessToken });
    return Response.json({ success: true, linkToken });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "link token failed" },
      { status: 500 },
    );
  }
}
```

`app/api/plaid/exchange/route.ts`:
```ts
import { getDb } from "@/lib/db";
import {
  exchangePublicToken,
  getInvestmentsHoldings,
  loadPlaidConfig,
} from "@/lib/plaid/client";
import { proposeAccountMap } from "@/lib/plaid/map-accounts";
import {
  setPlaidAccountMap,
  setPlaidAccountsCache,
  setPlaidItem,
} from "@/lib/queries/plaid-settings";
import { getAllAccounts } from "@/lib/queries/accounts";

export async function POST(request: Request) {
  const cfg = loadPlaidConfig();
  if (!cfg) {
    return Response.json({ success: false, error: "Plaid not configured." }, { status: 400 });
  }
  const { publicToken } = (await request.json()) as { publicToken?: string };
  if (!publicToken) {
    return Response.json({ success: false, error: "publicToken required" }, { status: 400 });
  }
  try {
    const db = getDb();
    const { accessToken, itemId } = await exchangePublicToken(cfg, publicToken);
    setPlaidItem(db, accessToken, itemId);
    const holdings = await getInvestmentsHoldings(cfg, accessToken);
    const plaidAccounts = holdings.accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask,
      subtype: a.subtype,
    }));
    setPlaidAccountsCache(db, plaidAccounts);
    const accountMap = proposeAccountMap(holdings.accounts, getAllAccounts(db));
    setPlaidAccountMap(db, accountMap);
    return Response.json({ success: true, plaidAccounts, accountMap });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "exchange failed" },
      { status: 500 },
    );
  }
}
```

`app/api/settings/plaid/route.ts`:
```ts
import { getDb } from "@/lib/db";
import { buildPlaidSettingsPayload } from "@/lib/queries/plaid-settings-payload";
import { setPlaidAccountMap } from "@/lib/queries/plaid-settings";
import { getAllAccounts } from "@/lib/queries/accounts";

export async function GET() {
  return Response.json(buildPlaidSettingsPayload(getDb()));
}

export async function PATCH(request: Request) {
  const db = getDb();
  const { accountMap } = (await request.json()) as { accountMap?: Record<string, number> };
  if (!accountMap || typeof accountMap !== "object" || Array.isArray(accountMap)) {
    return Response.json({ success: false, error: "accountMap object required" }, { status: 400 });
  }
  const validIds = new Set(getAllAccounts(db).map((a) => a.id));
  for (const [plaidId, localId] of Object.entries(accountMap)) {
    if (!validIds.has(localId)) {
      return Response.json(
        { success: false, error: `Unknown local account id ${localId} for ${plaidId}` },
        { status: 400 },
      );
    }
  }
  setPlaidAccountMap(db, accountMap);
  return Response.json({ success: true, ...buildPlaidSettingsPayload(db) });
}
```

`app/api/plaid/sync/route.ts` (in-app manual — forced):
```ts
import { getDb } from "@/lib/db";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";

export async function POST() {
  try {
    const result = await refreshVanguardHoldingsFromPlaid(getDb(), { force: true });
    if (result === null) {
      return Response.json({
        success: false,
        error:
          "Plaid is not connected — open Settings → Vanguard Live (Plaid) to connect, or a sync is already running.",
      });
    }
    return Response.json({ success: true, ...result });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Plaid sync failed" },
      { status: 500 },
    );
  }
}
```

`app/api/cron/plaid-sync/route.ts` (launchd — NOT forced; copy `constantTimeEqual` from the research-sync route):
```ts
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: Request) {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    return Response.json(
      { error: "Server not configured: CRON_SHARED_SECRET missing." },
      { status: 500 },
    );
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await refreshVanguardHoldingsFromPlaid(getDb());
    return Response.json({ success: true, result });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Plaid sync failed" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 5: Add contract-test entry**

In `tests/contracts/api-component-contracts.test.ts`, follow the file's existing pattern to assert `buildPlaidSettingsPayload` returns the keys `PlaidSection` consumes: `configured, connected, connectionStatus, lastSyncAt, plaidAccounts, accountMap, localAccounts`.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/queries/plaid-settings-payload.test.ts tests/contracts && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add app/api/plaid app/api/settings/plaid app/api/cron/plaid-sync lib/queries/plaid-settings-payload.ts tests/queries/plaid-settings-payload.test.ts tests/contracts/api-component-contracts.test.ts
git commit -m "feat(plaid): API routes — link-token, exchange, settings, in-app sync, cron sync"
```

---

### Task 10: Connect page + Settings section + Accounts sync button

**Files:**
- Create: `app/dashboard/plaid-link/page.tsx`
- Create: `app/dashboard/components/PlaidSection.tsx`
- Create: `app/dashboard/components/PlaidSyncButton.tsx`
- Modify: `app/dashboard/components/SettingsModal.tsx` (slot PlaidSection after AiModelsSection, same `!unavailableReason` + divider pattern at lines ~357-380)
- Modify: `app/dashboard/accounts/page.tsx` (render `<PlaidSyncButton />` next to the `<h2>Holdings</h2>` at line ~56)

Key implementation notes (follow existing component idioms — `"use client"`, self-contained fetch, inline error text like `EarningsEmailsSection`):

**`app/dashboard/plaid-link/page.tsx`** — client component handling both first-connect and the OAuth round-trip:
- Loads `https://cdn.plaid.com/link/v2/stable/link-initialize.js` via a dynamically injected `<script>` tag in `useEffect` (guard: skip if `window.Plaid` exists). Declare `declare global { interface Window { Plaid?: { create: (opts: Record<string, unknown>) => { open: () => void } } } }`.
- On mount: if `window.location.search` contains `oauth_state_id` → this is the return leg of Vanguard OAuth: read the link token from `localStorage.getItem("vgs:plaidLinkToken")` and call `window.Plaid.create({ token, receivedRedirectUri: window.location.href, onSuccess, onExit })` then `.open()`.
- Otherwise: `POST /api/plaid/link-token` (body `{}` or `{ mode: "reauth" }` when the page URL has `?mode=reauth`), store the returned token in `localStorage.setItem("vgs:plaidLinkToken", token)`, then `Plaid.create({ token, onSuccess, onExit }).open()`.
- `onSuccess(public_token)` → `POST /api/plaid/exchange { publicToken }` → on success render: "Connected — N Vanguard account(s) found and mapped. Review the mapping in Settings → Vanguard Live (Plaid)." plus a link back to `/dashboard/today`. On reauth mode, skip exchange (update-mode Link needs no new token) and just render "Re-authenticated."
- `onExit(err)` → render the Plaid error message inline; never silent.
- `export const dynamic = "force-dynamic"` is NOT needed (no DB load), but the page must be wrapped in `<Suspense>` if it calls `useSearchParams()` — use `window.location.search` inside `useEffect` instead to avoid the constraint.

**`app/dashboard/components/PlaidSection.tsx`** — Settings section, `EarningsEmailsSection` idioms:
- GET `/api/settings/plaid` on mount → payload state.
- Renders: connection status line (`disconnected` / `ok · last synced X` / `reauth_required` in `text-down`), a "Connect Vanguard" (or "Reconnect") link — `<a href="/dashboard/plaid-link" target="_blank" rel="noreferrer">` (append `?mode=reauth` when reauth_required) — a per-Plaid-account `<select>` of `localAccounts` for the mapping with a Save button (PATCH `{ accountMap }`), and a "Sync Vanguard now" button.
- Sync button (honest feedback): POST `/api/plaid/sync`; on `data.success` show inline: `"Synced N holdings across M account(s)"` plus, when `data.unmatched?.length`, `"Unmatched: <names + reasons>"`; on `success: false` show `data.error` verbatim (it explains not-connected/in-progress no-ops); on network throw show "Failed to connect to server".
- When `!payload.configured`: render only "Plaid credentials not set — add PLAID_CLIENT_ID / PLAID_SECRET to .env.local or settings.json." (no buttons).

**`app/dashboard/components/PlaidSyncButton.tsx`** — small client button for the Accounts page using `useToast()` (`RecomputeButton` pattern): POST `/api/plaid/sync`; success toast `"Vanguard synced — N holdings updated"`; `success:false` → error toast with `data.error`; catch → "Failed to connect to server". Label: "Sync Vanguard (Plaid)". Render nothing while loading state is idle-hidden? No — always render; the route explains not-connected.

- [ ] **Step 1: Implement the three components + two modifications** (code per notes above)
- [ ] **Step 2: Verify build**

Run: `npx next build`
Expected: compiles clean (catches Suspense/useSearchParams and server/client boundary mistakes).

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/plaid-link app/dashboard/components/PlaidSection.tsx app/dashboard/components/PlaidSyncButton.tsx app/dashboard/components/SettingsModal.tsx app/dashboard/accounts/page.tsx
git commit -m "feat(plaid): Link connect page, Settings section (mapping + sync), Accounts sync button"
```

---

### Task 11: Electron env threading for PLAID_* keys

**Files:**
- Modify: `electron/settings-store.ts` (AppSettings + ENV_TO_SETTING + getSanitizedSettings)
- Modify: `lib/settings/file-store.ts` (lockstep AppSettings + sanitized copies — header comment in the file mandates parity)
- Modify: `electron/main.ts` (env injection in `startServer()`)

The standard 4-touchpoint pattern (precedent: `pushoverAppToken`):

- [ ] **Step 1: AppSettings fields** (BOTH `electron/settings-store.ts` and `lib/settings/file-store.ts`):
```ts
  plaidClientId?: string;
  plaidSecret?: string;
  plaidEnv?: string;
  plaidRedirectUri?: string;
```

- [ ] **Step 2: ENV_TO_SETTING rows** (settings-store.ts):
```ts
  ["PLAID_CLIENT_ID", "plaidClientId"],
  ["PLAID_SECRET", "plaidSecret"],
  ["PLAID_ENV", "plaidEnv"],
  ["PLAID_REDIRECT_URI", "plaidRedirectUri"],
```

- [ ] **Step 3: getSanitizedSettings** (both files): `plaidSecret` masked (`"***" + slice(-4)` pattern); `plaidClientId`, `plaidEnv`, `plaidRedirectUri` pass through plain.

- [ ] **Step 4: main.ts injection**:
```ts
if (settings.plaidClientId) env.PLAID_CLIENT_ID = settings.plaidClientId;
if (settings.plaidSecret) env.PLAID_SECRET = settings.plaidSecret;
if (settings.plaidEnv) env.PLAID_ENV = settings.plaidEnv;
if (settings.plaidRedirectUri) env.PLAID_REDIRECT_URI = settings.plaidRedirectUri;
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean (electron has its own tsconfig — run `npm run electron:compile` if that script exists, else `npx tsc -p electron` — check package.json scripts).

- [ ] **Step 6: Commit**

```bash
git add electron/settings-store.ts lib/settings/file-store.ts electron/main.ts
git commit -m "feat(plaid): thread PLAID_* env vars through Electron settings (4 touchpoints)"
```

---

### Task 12: launchd daily tick (script + plist)

**Files:**
- Create: `scripts/run-plaid-sync.sh` (executable)
- Create: `docs/launchd/com.vanguard-skin.plaid-sync.plist`

- [ ] **Step 1: Script** — `scripts/run-plaid-sync.sh`:

```bash
#!/bin/bash
# Daily Plaid → Vanguard holdings sync. Fires on the first tick inside the
# 07:30 ET weekday window (after Plaid's overnight Vanguard re-scrape,
# before the 8:45 digest). The route itself dedupes (once per ET day) and
# skips market holidays, so the ≤2 ticks a 10-min window allows are safe.
source /Users/Yitzi/code/vanguard-skin/scripts/lib/et-gate.sh
if ! in_et_window "1,2,3,4,5" 7 30; then
  exit 0
fi

ENV_FILE=/Users/Yitzi/code/vanguard-skin/.env.local
SECRET=$(grep '^CRON_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2-)
HEADERS=(-H "Content-Type: application/json")
if [ -n "$SECRET" ]; then
  HEADERS+=(-H "X-Cron-Secret: $SECRET")
fi

for url in "http://localhost:3099/api/cron/plaid-sync" "http://localhost:3000/api/cron/plaid-sync"; do
  response=$(curl -sS --max-time 180 -w $'\n%{http_code}' -X POST "${HEADERS[@]}" -d '{}' "$url" 2>&1)
  code=$(echo "$response" | tail -1)
  if [ "$code" = "200" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync OK via $url: $(echo "$response" | head -1)"
    exit 0
  fi
done
echo "$(date '+%Y-%m-%d %H:%M:%S') plaid-sync failed on both ports: $response"
exit 1
```

`chmod +x scripts/run-plaid-sync.sh`

- [ ] **Step 2: Plist** — `docs/launchd/com.vanguard-skin.plaid-sync.plist` (StartInterval pattern — NEVER StartCalendarInterval):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vanguard-skin.plaid-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/Yitzi/code/vanguard-skin/scripts/run-plaid-sync.sh</string>
  </array>
  <key>StandardErrorPath</key>
  <string>/Users/Yitzi/Library/Logs/vanguard-plaid-sync.log</string>
  <key>StandardOutPath</key>
  <string>/Users/Yitzi/Library/Logs/vanguard-plaid-sync.log</string>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

- [ ] **Step 3: Validate + install**

```bash
plutil -lint docs/launchd/com.vanguard-skin.plaid-sync.plist
cp docs/launchd/com.vanguard-skin.plaid-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vanguard-skin.plaid-sync.plist
```
Expected: `OK`, no launchctl error. (The tick no-ops harmlessly until Plaid is connected.)

- [ ] **Step 4: Commit**

```bash
git add scripts/run-plaid-sync.sh docs/launchd/com.vanguard-skin.plaid-sync.plist
git commit -m "feat(plaid): daily 07:30 ET launchd tick (et-gate self-gated, route-side dedup)"
```

---

### Task 13: Docs, full suite, build

**Files:**
- Modify: `CLAUDE.md` (project) — add to **API Pattern**: the five new routes (one line each, matching existing style); add a **Conventions** bullet: "**Live snapshot sources are single-sourced**: `lib/db/live-sources.ts::LIVE_SNAPSHOT_SOURCES = ('tws','plaid')` — every monthly_snapshots historical read excludes live rows via `excludeLiveSnapshotsSql()`; a lint test rejects raw `!= 'tws'`. Plaid path: `lib/plaid/refresh.ts` mirrors the IBKR Web API path (holdings `plaid:` source_keys, `source='plaid'` snapshot + MF prices at priority tier 3, cost_basis NULL, statement always wins)."
- Modify: `.env.local` documentation only if an `.env.example` exists (check; if not, skip — the CLAUDE.md entry covers it).

- [ ] **Step 1: Write the CLAUDE.md additions** (per above)
- [ ] **Step 2: Full suite** — Run: `npx vitest run` — Expected: ALL PASS (3300+ tests). Report the count.
- [ ] **Step 3: Build** — Run: `npx next build` — Expected: clean compile.
- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(plaid): CLAUDE.md conventions + API pattern entries for Plaid live sync"
```

---

## Post-implementation (manual, user-involved — not agent tasks)

1. **User**: create Plaid account at dashboard.plaid.com → Trial/production access → copy client_id + secret into `.env.local` (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production`) → register `http://localhost:3099/dashboard/plaid-link` as an Allowed redirect URI in Plaid dashboard → API → Allowed redirect URIs.
2. **Sandbox E2E first**: set `PLAID_ENV=sandbox`, connect the Sandbox test institution via `/dashboard/plaid-link`, run "Sync Vanguard now", verify DB rows (`holdings` with `plaid:` keys, `monthly_snapshots` source='plaid') — sandbox data maps to no real accounts so expect unmatched/auto-map gaps; this validates the flow, not the data.
3. **Live connect**: flip to `PLAID_ENV=production`, connect real Vanguard via OAuth, confirm account mapping (Taxable + Roth), sync, verify Accounts tab + Today view show current values.
4. Verify the launchd tick the next weekday morning (`~/Library/Logs/vanguard-plaid-sync.log`).
