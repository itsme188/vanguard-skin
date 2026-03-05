# Task 16: Polish + Integration Testing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Final polish pass for the v2 dashboard — integration tests, error boundaries, loading skeletons, empty states, responsive fixes, and real data verification.

**Architecture:** All changes are additive (new test file, new error boundary, new skeleton components) or minor edits to existing components. No schema changes, no new API routes.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, Vitest, better-sqlite3

---

## Task 16A: Integration Test

**Files:**
- Create: `tests/integration/full-import-flow.test.ts`

**Step 1: Write the integration test**

Create `tests/integration/full-import-flow.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport } from "@/lib/import/engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { getAccountSummaries, getPortfolioTotals } from "@/lib/queries/dashboard";
import { getAllAccounts } from "@/lib/queries/accounts";
import { getTaxLotSummary } from "@/lib/queries/tax-lots";
import fs from "node:fs";
import path from "node:path";

describe("full import flow integration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("imports IBKR activity CSV and creates transactions, securities, and snapshots", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");

    expect(parsed.sourceType).toBe("ibkr-activity");
    expect(parsed.transactions.length).toBeGreaterThan(0);
    expect(parsed.securities.length).toBeGreaterThan(0);
    expect(parsed.snapshots.length).toBe(1);

    const result = commitImport(db, parsed);
    expect(result.newTransactions).toBeGreaterThan(0);
    expect(result.newSecurities).toBeGreaterThan(0);
    expect(result.newSnapshots).toBe(1);

    // Verify data in DB
    const txnCount = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number }).c;
    expect(txnCount).toBe(result.newTransactions);

    const secCount = (db.prepare("SELECT COUNT(*) as c FROM securities").get() as { c: number }).c;
    expect(secCount).toBe(result.newSecurities);
  });

  it("imports Vanguard holdings CSV and creates holdings", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/vanguard-holdings-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "vanguard-holdings.csv");

    expect(parsed.sourceType).toBe("vanguard-holdings");
    expect(parsed.holdings.length).toBeGreaterThan(0);

    const result = commitImport(db, parsed);
    expect(result.newHoldings).toBeGreaterThan(0);

    const holdingCount = (db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number }).c;
    expect(holdingCount).toBe(result.newHoldings);
  });

  it("re-importing same data creates no duplicates (idempotency)", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");

    const first = commitImport(db, parsed);
    const second = commitImport(db, parsed);

    expect(second.newTransactions).toBe(0);
    expect(second.skippedDuplicates).toBeGreaterThan(0);

    const txnCount = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number }).c;
    expect(txnCount).toBe(first.newTransactions);
  });

  it("computes tax lots from imported transactions", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");
    commitImport(db, parsed);

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBeGreaterThan(0);

    const summary = getTaxLotSummary(db);
    expect(summary.totalOpenLots + summary.totalClosedSales).toBeGreaterThan(0);
  });

  it("computes daily valuations from imported data", async () => {
    // Need both holdings and prices
    const holdingsCsv = fs.readFileSync(
      path.join(__dirname, "../fixtures/vanguard-holdings-sample.csv"),
      "utf-8"
    );
    const holdingsParsed = await parseImport(holdingsCsv, "vanguard-holdings.csv");
    commitImport(db, holdingsParsed);

    // Vanguard holdings parser also generates prices
    const priceCount = (db.prepare("SELECT COUNT(*) as c FROM prices").get() as { c: number }).c;

    if (priceCount > 0) {
      const result = computeDailyValuations(db);
      expect(result.datesComputed).toBeGreaterThanOrEqual(0);
    }
  });

  it("dashboard queries return correct aggregates after import", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");
    commitImport(db, parsed);

    const accounts = getAllAccounts(db);
    expect(accounts).toHaveLength(3);

    const summaries = getAccountSummaries(db);
    expect(summaries).toHaveLength(3);

    // IBKR should have data now
    const ibkr = summaries.find((s) => s.name === "IBKR");
    expect(ibkr).toBeTruthy();
    expect(ibkr!.latestValue).toBeGreaterThan(0);

    const totals = getPortfolioTotals(db);
    expect(totals.snapshotCount).toBeGreaterThan(0);
    expect(totals.totalValue).toBeGreaterThan(0);
  });
});
```

**Step 2: Run the test**

Run: `npx vitest run tests/integration/full-import-flow.test.ts`
Expected: All 6 tests pass

**Step 3: Commit**

```bash
git add tests/integration/full-import-flow.test.ts
git commit -m "test: integration test for full import → compute → query pipeline"
```

---

## Task 16B: Error Boundary

**Files:**
- Create: `app/dashboard/error.tsx`
- Modify: `app/dashboard/components/ReconciliationTable.tsx:63-66` (add error handling to delete)

**Step 1: Create the error boundary**

Create `app/dashboard/error.tsx`:

```typescript
"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="rounded-xl border border-down/30 bg-down-tint p-8 max-w-md text-center">
        <div className="w-12 h-12 rounded-full bg-down/10 flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-6 h-6 text-down"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
        <h2 className="text-lg font-medium text-ink mb-2">
          Something went wrong
        </h2>
        <p className="text-sm text-ink-dim mb-6">
          {error.message || "An unexpected error occurred while loading this page."}
        </p>
        <button
          onClick={reset}
          className="px-5 py-2.5 rounded-lg bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-all"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Add error handling to ReconciliationTable delete**

In `app/dashboard/components/ReconciliationTable.tsx`, replace the `handleDelete` function (lines 63-66):

Old:
```typescript
  async function handleDelete(id: number) {
    await fetch(`/api/reconciliation?id=${id}`, { method: "DELETE" });
    router.refresh();
  }
```

New:
```typescript
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(id: number) {
    if (!confirm("Remove this checkpoint?")) return;
    try {
      const res = await fetch(`/api/reconciliation?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete checkpoint");
      setError(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }
```

Also add an error banner at the top of the JSX return (inside the outermost `<div>`):

```tsx
{error && (
  <div className="rounded-lg bg-down-tint border border-down/30 px-4 py-2 text-sm text-down flex items-center justify-between">
    <span>{error}</span>
    <button onClick={() => setError(null)} className="text-down hover:text-ink transition-colors ml-2">&times;</button>
  </div>
)}
```

**Step 3: Verify error boundary renders**

Run: `npx next build`
Expected: Clean build, error.tsx compiled

**Step 4: Commit**

```bash
git add app/dashboard/error.tsx app/dashboard/components/ReconciliationTable.tsx
git commit -m "feat: error boundary and improved error handling"
```

---

## Task 16C: Loading Skeletons

**Files:**
- Create: `app/dashboard/components/Skeletons.tsx`
- Create: `app/dashboard/loading.tsx`

**Step 1: Create reusable skeleton components**

Create `app/dashboard/components/Skeletons.tsx`:

```typescript
export function SkeletonPulse({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-muted animate-pulse rounded-lg ${className}`} />
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-5 space-y-3">
      <SkeletonPulse className="h-3 w-24" />
      <SkeletonPulse className="h-8 w-32" />
      <SkeletonPulse className="h-3 w-20" />
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <SkeletonPulse className="h-3 w-32 mb-4" />
      <div className="h-[280px] flex items-end gap-1 px-4">
        {Array.from({ length: 12 }, (_, i) => (
          <SkeletonPulse
            key={i}
            className="flex-1 rounded-t-sm"
            style={{ height: `${30 + Math.random() * 60}%` } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-edge overflow-hidden">
      <div className="border-b border-edge bg-panel px-4 py-2.5 flex gap-4">
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonPulse key={i} className="h-3 w-16" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-b border-edge last:border-0 px-4 py-3 flex gap-4">
          {Array.from({ length: 5 }, (_, j) => (
            <SkeletonPulse key={j} className="h-3 w-16" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonMetrics() {
  return (
    <div className="flex items-baseline gap-6">
      <div className="space-y-2">
        <SkeletonPulse className="h-2.5 w-20" />
        <SkeletonPulse className="h-10 w-40" />
      </div>
      <SkeletonPulse className="h-6 w-24" />
      <SkeletonPulse className="h-5 w-16 rounded" />
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <SkeletonMetrics />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonChart />
    </div>
  );
}
```

Note: The `SkeletonChart` needs inline style for random heights. Change the approach to use fixed heights instead:

```typescript
const BAR_HEIGHTS = [45, 65, 35, 80, 55, 70, 40, 90, 60, 50, 75, 85];

export function SkeletonChart() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <SkeletonPulse className="h-3 w-32 mb-4" />
      <div className="h-[280px] flex items-end gap-1 px-4">
        {BAR_HEIGHTS.map((h, i) => (
          <div key={i} className="flex-1 bg-muted animate-pulse rounded-t-sm" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Create dashboard loading page**

Create `app/dashboard/loading.tsx`:

```typescript
import { OverviewSkeleton } from "./components/Skeletons";

export default function DashboardLoading() {
  return <OverviewSkeleton />;
}
```

**Step 3: Verify it renders**

Run: `npx next build`
Expected: Clean build

**Step 4: Commit**

```bash
git add app/dashboard/components/Skeletons.tsx app/dashboard/loading.tsx
git commit -m "feat: loading skeletons for dashboard"
```

---

## Task 16D: Empty States

**Files:**
- Modify: `app/dashboard/components/TaxLotTables.tsx:103-106` (ClosedSalesTable)
- Modify: `app/dashboard/components/EquityCurveChart.tsx:31-42` (add empty check)
- Modify: `app/dashboard/components/HoldingsTable.tsx:36-38` (add overflow-x-auto)
- Modify: `app/dashboard/components/ImportHistory.tsx:31-36` (better empty state)

**Step 1: Fix ClosedSalesTable empty state**

In `app/dashboard/components/TaxLotTables.tsx`, replace lines 103-106:

Old:
```typescript
export function ClosedSalesTable({ sales }: { sales: TaxLotSaleWithDetails[] }) {
  if (sales.length === 0) {
    return null;
  }
```

New:
```typescript
export function ClosedSalesTable({ sales }: { sales: TaxLotSaleWithDetails[] }) {
  if (sales.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
        <p className="text-ink-faint text-sm">
          No closed sales yet. Sales will appear here when you sell positions.
        </p>
      </div>
    );
  }
```

**Step 2: Add empty check to EquityCurveChart**

In `app/dashboard/components/EquityCurveChart.tsx`, add empty check after line 37 (after `const data = ...`):

```typescript
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
        <p className="text-ink-faint text-sm">
          No snapshot data for this account yet. Import monthly statements to see the equity curve.
        </p>
      </div>
    );
  }
```

**Step 3: Improve ImportHistory empty state**

In `app/dashboard/components/ImportHistory.tsx`, replace lines 31-36:

Old:
```typescript
  if (batches.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-ink-faint text-sm">No imports yet</p>
      </div>
    );
  }
```

New:
```typescript
  if (batches.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-medium text-ink-dim mb-3">Import History</h3>
        <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
          <p className="text-ink-faint text-sm">
            No imports yet. Drop files above to get started.
          </p>
        </div>
      </div>
    );
  }
```

**Step 4: Run build to verify**

Run: `npx next build`
Expected: Clean build

**Step 5: Commit**

```bash
git add app/dashboard/components/TaxLotTables.tsx app/dashboard/components/EquityCurveChart.tsx app/dashboard/components/ImportHistory.tsx
git commit -m "feat: consistent empty states across all dashboard tabs"
```

---

## Task 16E: Responsive Fixes

**Files:**
- Modify: `app/dashboard/components/ReconciliationTable.tsx:154` (add overflow-x-auto)
- Modify: `app/dashboard/components/HoldingsTable.tsx:38` (add overflow-x-auto)
- Modify: `app/dashboard/components/ImportHistory.tsx:52` (add overflow-x-auto)
- Modify: `app/dashboard/components/CombinedPortfolioChart.tsx:48` (responsive height)
- Modify: `app/dashboard/components/EquityCurveChart.tsx:48` (responsive height)
- Modify: `app/dashboard/components/ImportFlow.tsx:150` (responsive padding)

**Step 1: Add overflow-x-auto to tables missing it**

In `app/dashboard/components/ReconciliationTable.tsx`, wrap the table (line 154-220) in `overflow-x-auto`:

Change line 154 from:
```html
<div className="rounded-xl border border-edge overflow-hidden">
```
To:
```html
<div className="rounded-xl border border-edge overflow-hidden overflow-x-auto">
```

In `app/dashboard/components/HoldingsTable.tsx`, change line 38 from:
```html
<div className="rounded-xl border border-edge overflow-hidden">
```
To:
```html
<div className="rounded-xl border border-edge overflow-hidden overflow-x-auto">
```

In `app/dashboard/components/ImportHistory.tsx`, change line 52 from:
```html
<div className="rounded-xl border border-edge overflow-hidden">
```
To:
```html
<div className="rounded-xl border border-edge overflow-hidden overflow-x-auto">
```

**Step 2: Responsive chart heights**

In `app/dashboard/components/CombinedPortfolioChart.tsx`, change line 48 from:
```html
<div className="h-[320px]">
```
To:
```html
<div className="h-[240px] sm:h-[280px] md:h-[320px]">
```

In `app/dashboard/components/EquityCurveChart.tsx`, change line 48 from:
```html
<div className="h-[280px]">
```
To:
```html
<div className="h-[220px] sm:h-[250px] md:h-[280px]">
```

**Step 3: Responsive ImportFlow dropzone padding**

In `app/dashboard/components/ImportFlow.tsx`, on line 150 change:
```
p-12
```
To:
```
p-6 sm:p-12
```

This appears in two places in the file (lines 150 and 306). Update both.

**Step 4: Add text label to ImportHistory undo button**

In `app/dashboard/components/ImportHistory.tsx`, replace the undo button content (lines 92-115). Change the button from icon-only to include text:

Replace:
```html
<button
  onClick={() => handleUndo(batch.id)}
  disabled={undoingId === batch.id}
  className="text-ink-faint hover:text-down transition-colors disabled:opacity-50"
  title="Undo import"
>
```

With:
```html
<button
  onClick={() => handleUndo(batch.id)}
  disabled={undoingId === batch.id}
  className="text-xs text-ink-faint hover:text-down transition-colors disabled:opacity-50"
>
```

And replace the SVG icon with text:

```tsx
{undoingId === batch.id ? (
  <div className="w-4 h-4 border-2 border-ink-faint border-t-transparent rounded-full animate-spin" />
) : (
  "Undo"
)}
```

**Step 5: Standardize card padding**

In `app/dashboard/components/ImportFlow.tsx`, change the two instances of `p-6` in the panel containers (lines 211 and 316) to `p-5` to match other cards.

**Step 6: Run build to verify**

Run: `npx next build`
Expected: Clean build

**Step 7: Commit**

```bash
git add app/dashboard/components/ReconciliationTable.tsx app/dashboard/components/HoldingsTable.tsx app/dashboard/components/ImportHistory.tsx app/dashboard/components/CombinedPortfolioChart.tsx app/dashboard/components/EquityCurveChart.tsx app/dashboard/components/ImportFlow.tsx
git commit -m "feat: responsive fixes and UI consistency"
```

---

## Task 16F: Real Data Smoke Test

**Files:** No code changes — this is manual verification.

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Import real IBKR files**

Navigate to `http://localhost:3000/dashboard/import`. Import files from `~/Desktop/Portfolio - Dashboard/data/ibkr/`:
- Start with one monthly activity CSV
- Then holdings CSV
- Then monthly values CSV

Verify: Preview shows correct counts → Import succeeds → Import History shows entries.

**Step 3: Import real Vanguard files**

Import from `~/Desktop/Portfolio - Dashboard/data/vanguard/`:
- Holdings CSV
- Cost basis CSV

Note: PDF import requires ANTHROPIC_API_KEY in `.env.local`. If available, test one PDF.

**Step 4: Verify Overview tab**

Navigate to `/dashboard`. Verify:
- PerformanceMetrics shows total portfolio value
- AccountSummaryCards show per-account values
- CombinedPortfolioChart renders stacked area chart

**Step 5: Verify Accounts tab**

Navigate to `/dashboard/accounts`. Verify:
- Account selector works
- Holdings table shows data
- Transaction history shows entries
- Equity curve renders (if snapshots exist)

**Step 6: Run compute engines**

Navigate to `/dashboard/tax-lots` and click "Recompute". Verify:
- Tax lot summary cards update
- Open lots table shows data
- Closed sales appear if any sells exist

**Step 7: Verify Reconciliation tab**

Navigate to `/dashboard/reconciliation`. Verify:
- Add checkpoint form works
- Table renders with correct formatting

**Step 8: Verify Chat tab**

Navigate to `/dashboard/chat`. Verify:
- Chat interface renders with suggestions
- If API key configured, test a question

**Step 9: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (89 existing + 6 new integration tests = ~95 total)

**Step 10: Run final build**

Run: `npx next build`
Expected: Clean build, all routes compile

**Step 11: Commit and push**

```bash
git add -A
git commit -m "feat: Task 16 complete — polish, integration tests, responsive fixes"
git push
```

---

## Build Order Summary

| Sub-task | What | Files | Est. Tests Added |
|----------|------|-------|-----------------|
| 16A | Integration test | 1 new | +6 |
| 16B | Error boundary | 1 new, 1 modified | 0 |
| 16C | Loading skeletons | 2 new | 0 |
| 16D | Empty states | 3 modified | 0 |
| 16E | Responsive fixes | 6 modified | 0 |
| 16F | Real data smoke test | Manual | 0 |

All sub-tasks are independent except 16F (which must be last). 16A-16E can be done in any order.
