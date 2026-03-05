# Task 16: Polish + Integration Testing — Design

## Goal

Final polish pass for the v2 dashboard: integration tests, error boundaries, loading skeletons, empty states, responsive fixes, and real data verification.

## Sub-tasks

### 16A: Integration Test

Full-cycle test in `tests/integration/full-import-flow.test.ts`:

- Create `:memory:` DB, run migrations
- Import IBKR activity CSV fixture → verify transactions, securities, snapshots
- Import Vanguard holdings CSV fixture → verify holdings
- Run tax lot computation → verify `tax_lots` populated
- Run daily valuation computation → verify `daily_valuations` populated
- Query dashboard data (portfolio summary, account summaries) → verify aggregates
- Verify source_key idempotency (re-import = no duplicates)

### 16B: Error Boundary

- `app/dashboard/error.tsx` — Next.js error boundary with retry, styled to match design system
- Error handling on ReconciliationTable delete handler
- Form validation feedback on reconciliation form

### 16C: Loading Skeletons

- Reusable skeleton components (SkeletonCard, SkeletonChart, SkeletonTable)
- Suspense boundaries on Overview and Accounts pages
- Extract data-fetching into separate async components wrapped in Suspense
- Skeleton styling: `bg-muted animate-pulse rounded-xl`

### 16D: Empty States

- Shared `EmptyState` component: dashed border box + icon + message + optional CTA
- Replace `null` returns in: PerformanceMetrics, CombinedPortfolioChart, EquityCurveChart, ClosedSalesTable
- Consistent pattern across all tabs

### 16E: Responsive Fixes

- `overflow-x-auto` on ReconciliationTable and HoldingsTable
- Responsive chart heights: `h-[220px] sm:h-[280px] md:h-[320px]`
- ImportFlow dropzone: `p-6 sm:p-12`
- Standardize card padding to `p-5`
- Text label on ImportHistory undo button

### 16F: Real Data Smoke Test

- Import real files from `~/Desktop/Portfolio - Dashboard/data/`
- Verify all tabs render with actual data
- Run compute engines
- Manual visual verification of each tab
