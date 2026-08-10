# TWR December repair — data repair + headline disclosure

**Date:** 2026-08-10 · **Branch:** `twr-december-repair`

## Context

The Analysis `?view=performance` scope=all headline TWR is provably wrong (sits below every per-account row on 3Y/5Y/All — impossible for a value-weighted blend). Root cause (forensics 2026-08-10, statement-verified): the taxable account (`accounts.name = 'Vanguard Taxable'`, id 1 in the live DB) has FOUR poisoned December rows in `monthly_snapshots`, all from import batch 26 — an early draft of the canonical CSV carrying ANNUAL-summary rows in December month-end slots. The corrected CSV (batch 35) was imported 52 min later, but the deterministic source_key dedupe skipped the 4 existing December keys instead of updating them.

Poisoned rows (live DB, account_id=1) vs the canonical CSV (`~/Desktop/Trading - Local/dashboard_Vanguard_Brokerage_monthly_snapshots.csv`, verified against real Vanguard statement PDFs at all four year-ends):

| month_end_date | DB (wrong) | CSV (statement-verified correct) |
|---|---|---|
| 2022-12-31 | total 362408.31, starting 391746.97, deposits 118593.14, twr −0.312 | total 328285.46, starting 351126.94, deposits 0.0, twr −0.065052, investment_gain −22841.48 |
| 2023-12-31 | total 580250.40, starting 362408.31, deposits 124523.94, twr NULL | total 526157.97, starting 502253.87, deposits 0.0, twr 0.047594, investment_gain 23904.10 |
| 2024-12-31 | total 896634.19 (correct), starting 526157.97, deposits 255000.0, twr NULL | total 896634.19, starting 939820.98, deposits 0.0, twr −0.045952, investment_gain −43186.79 |
| 2025-12-31 | total 1290023.49 (correct), starting 896634.19, deposits 10000.0, twr NULL | total 1290023.49, starting 1344716.44, deposits −20000.0, twr −0.025799, investment_gain −34692.95 |

The Roth (account 2) December rows are healthy (batch 36, clean chain) — do not touch them.

Note: `lib/compute/twr.ts:440–476` already carries a December-annual-row FLOW-correction heuristic (triggers on >10% starting-value gap). It stays — after the data repair it goes inert (no gaps left), but it guards future annual-row imports. Do not remove it.

**User decisions (2026-08-10):** repair all 4 rows from the CSV as authority; headline stays Modified-Dietz-over-summed-values + a rendered `portfolioPartial` disclosure (weighted-blend rewrite rejected).

## Global Constraints

- Tests/scripts run with `PATH=/opt/homebrew/opt/node@20/bin:$PATH` prefix (`npx vitest run`, `npx tsx`) — shell-default Node 26 breaks better-sqlite3; NEVER `npm rebuild`.
- All DB functions take `db: Database.Database` (DI); tests use in-memory `:memory:` SQLite. Tests NEVER touch `data/vanguard.db` or the real CSV — fixture CSVs only.
- Repair-script conventions (model: `scripts/repair-ah-closes.ts` / `scripts/repair-split-prices.ts`): dry-run by default, `--apply` to write, print a per-row diff, take a DB backup to `data/backups/` before writing, idempotent (second run reports nothing to do), transaction with verification inside.
- NEVER hardcode financial figures in the repair script — the CSV is the authority, parsed at runtime. (The figures in this plan are for test fixtures and review verification only.)
- ET-anchor convention: user-facing "today" uses `todayET()` (`lib/date-utils`), never `new Date().toISOString().slice(0,10)`.
- Scope convention: multi-account scopes resolve via `resolveScope`, never `resolveScopeToSingleId` / first-id collapse.
- UI: no raw date strings without the existing view's formatting idiom; any new user-facing portfolio numbers go through `lib/privacy/components.tsx` (the disclosure caption and date windows contain no portfolio numbers).
- Commit messages via temp file + `git commit -F` (no inline `-m`).

## Task 1 — `scripts/repair-december-snapshots.ts` + tests

Repair script that fixes `monthly_snapshots` December rows poisoned by annual-summary drafts, using the canonical CSV as authority.

- CLI: `npx tsx scripts/repair-december-snapshots.ts [--apply] [--csv <path>] [--db <path>]`. Defaults: dry-run; CSV `~/Desktop/Trading - Local/dashboard_Vanguard_Brokerage_monthly_snapshots.csv`; DB `data/vanguard.db`.
- Parse the CSV (papaparse is in-repo; header row: `account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr`). Resolve `account` by exact `accounts.name` match; skip CSV accounts with no DB match (report them).
- **Audit phase (all rows):** compare every CSV row against the DB row for (account_id, month_end_date) on `total_value, starting_value, deposits_withdrawals, twr, investment_gain` (tolerance 0.005 for floats; NULL vs non-NULL counts as mismatch). Report ALL mismatches found.
- **Repair phase (December rows only):** rows with `month_end_date` matching `SUBSTR(month_end_date,6,2)='12'` AND mismatched get repaired on `--apply`: overwrite the five compared columns with CSV values, append to `notes` (preserving any existing note): `repaired <YYYY-MM-DD> from canonical CSV (annual-row defect, batch 26)`. Non-December mismatches are REPORT-ONLY — the script refuses to touch them (print that explicitly).
- Backup before apply: copy DB to `data/backups/pre-december-snapshot-repair-<todayET()>.db` (fail hard if copy fails). All writes in one transaction; after writing, re-read the four rows inside the transaction and verify they now match the CSV — mismatch → rollback with a clear message.
- Idempotent: second `--apply` run finds 0 December mismatches.
- Exit non-zero on: unreadable CSV, unknown account column values in December rows, verification failure.
- **Tests** (`tests/scripts/` or alongside existing repair-script test conventions — follow whatever `repair-ah-closes` / `repair-split-prices` tests do): in-memory DB seeded with the 4 poisoned rows + healthy neighbors + healthy Roth December rows; fixture CSV (temp file) carrying the correct values table above. Cases: dry-run reports exactly 4 December mismatches and writes nothing; apply repairs all 4 (values + note) and leaves Roth + non-December rows untouched; second apply reports 0; non-December mismatch is reported but never written; NULL-twr → value counts as mismatch and repairs.
- Do NOT run the script against the live DB — live application is a separate user-approved step after merge.

## Task 2 — headline disclosure + scope/window fixes in twr + PerformanceView

All in `lib/compute/twr.ts` + `app/dashboard/components/PerformanceView.tsx` + tests.

1. **`portfolioPartial` surfaced:** add `isPartial: boolean` to `PortfolioTwrResult` (twr.ts:23–30), set from the existing `portfolioPartial` local (computed at 479–541, currently dropped at the return on 569–576). Mirror the semantics of `TwrResult.isPartial`.
2. **Scope fix:** `PerformanceView.tsx:80` currently does `activeScope === "all" ? undefined : resolveScopeToSingleId(db, activeScope)`. Replace with `resolveScope` (see the file's own lines 160–169 for the established idiom). Extend `TwrOptions` with `accountIds?: number[]`; when present and length>1, the aggregate path filters its snapshot/flow queries to those accounts (add `AND account_id IN (...)` with proper placeholders) and `expected_accounts` counts only those accounts; when length===1 behave exactly as today's single `accountId`. `computeXirr`/`computeRiskMetrics` keep their current single-id signature — out of scope (latent until a 4th account, disclosed below). PerformanceView: length===1 → pass as `accountId`; length>1 → pass `accountIds`.
3. **Disclosure caption (b):** when `twrResult.isPartial` (aggregate) — render a small caption near the headline TWR: partial coverage, some months excluded from the chain. Match the view's existing caption/chip idiom (e.g. the reconciliation strip styling); no portfolio numbers in the text.
4. **Per-account windows (c):** each per-account row renders its own `startDate`–`endDate` window (data already on `TwrResult`) so a 31-month account next to a 55-month headline is visibly different. Use the view's existing date-formatting idiom; compact (e.g. "May 2023 – Aug 2026").
5. **ET-anchor fix (sibling, this file only):** `PerformanceView.tsx` `const today = new Date().toISOString().slice(0, 10)` → `todayET()`; same for `startDateForPeriod`'s use of `new Date(today)` derivations if they feed user-facing windows (keep the arithmetic, anchor the base date in ET).
- **Tests** (extend the existing twr test file): aggregate `isPartial=false` on a clean 3-account fixture; `isPartial=true` when one account's month is missing (present<expected skip) — assert the RETURNED flag, not just internal behavior; `accountIds:[a,b]` on a 3-account fixture equals the aggregate of a 2-account DB with the same rows (third account's data must not leak in); `accountIds` length-1 equals `accountId` behavior byte-for-byte.
- Component render tests are NOT required (no established RSC test harness) — caption/window rendering is verified by the controller via browser E2E after merge.

## Non-goals

- No weighted-blend headline (user-rejected).
- No changes to `computeXirr`/`computeRiskMetrics` signatures.
- No import-pipeline conflict-warning (filed as its own TODO item).
- No removal of the twr.ts:440–476 flow-correction heuristic.
- The repair script does not run against the live DB in this branch's work.

## Verification (controller, after both tasks)

Full suite `PATH=... npx vitest run`; `npx next build`; live repair with user present; browser E2E on `/dashboard/analysis?view=performance` for scope=all + per-account scopes across periods.
