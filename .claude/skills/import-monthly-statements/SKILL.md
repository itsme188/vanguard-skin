---
name: import-monthly-statements
description: Use when the user's monthly brokerage statements arrive and need importing into Portfolio Desk — Vanguard PDF statements (Taxable + Roth) and the IBKR activity CSV. Also use when reconciling a past statement import or debugging a month-end value mismatch. Default statement location is ~/Desktop/Trading - Local/.
---

# Import Monthly Statements

## Overview

Turn the three monthly statements (Vanguard Taxable PDF, Vanguard Roth PDF, IBKR activity CSV) into committed, penny-reconciled database records in one session — no Co-Work, no hand-fixing afterward.

**Core principle: this skill's mapping tables are the convention authority; the STATEMENT is ground truth for values.** The tables were derived from the DB's statement-import era (2026-04+) — when a doc example or a prior month's on-disk CSV disagrees with them, the table wins (those artifacts have specific known errors, called out below). When any reconciliation doesn't close to the penny, stop and investigate; never commit a file that doesn't tie out.

**Violating the letter of the gates is violating the spirit of the gates.** Every phase below ends in a check; a check that fails means STOP and report — not "close enough, continue."

## Phase 0 — Pre-flight (before touching anything)

1. **Back up the DB**: `cp data/vanguard.db "data/vanguard.db.pre-{YYYYMM}-import-$(date +%Y%m%d-%H%M%S).bak"` — print the path.
2. **Capture baseline** (read-only): per-account position counts at latest as_of_date, latest `monthly_snapshots` row per account (this gives you every `starting_value`), latest `prices` date.
3. **Locate inputs** in `~/Desktop/Trading - Local/` (or user-given paths): two Vanguard PDFs + one IBKR CSV.
4. **Confirm the app is running** (Electron :3099 or `npm run dev` :3000) — imports go through `POST /api/import` so post-commit hooks (tax lots, classification, daily valuations, purges) run automatically.

## Phase 1 — IBKR (native parser, first)

- Import the raw statement CSV **as-is** via the `ibkr-activity` parser. **Never** convert IBKR to canonical CSVs and never let another tool pre-process it — a "transactions-only" export discards the Open Positions + NAV sections the parser needs.
- Preview first: `curl -sf -X POST "http://localhost:3099/api/import?mode=preview" -F "files=@<file>"` — check detected format is `ibkr-activity`, counts look sane, warnings list is empty or explained.
- **Continuity gate**: the statement's Net Asset Value "Prior Total" must equal last month's IBKR `monthly_snapshots.total_value` in the DB to the penny. Mismatch → stop.
- New/absent sections (Stock Yield Enhancement Program, missing Deposits & Withdrawals on a no-flow month, Zero Hash) are normal — the parser is section-keyed. But if preview's trade/position counts look truncated vs the raw file, suspect a section-format change (May 2026 precedent: multi-block Change in NAV, optional Trades `Account` column).
- **Foreign-listed positions — symbol drift trap (June 2026 precedent):** the statement's symbol can differ from the TWS/Web-API symbol already in `securities` (statement `402340.KS` vs DB `402340`, currency KRW). The import then creates a **USD-defaulted duplicate** whose native price gets valued as dollars — a ₩1,697,000 close became a $16.9M position and a −$16.9M inferred-cash spike at the anchor date. After commit, check every new security the batch created against existing rows (`SELECT symbol,currency FROM securities WHERE currency!='USD'` + fuzzy symbol match); if a duplicate appeared, merge its transactions/holdings/prices into the existing row, delete the duplicate, recompute valuations.
- Commit (`?mode=commit`), record the batch id.

## Phase 2 — Vanguard PDFs → canonical CSVs

Extract text: `pdftotext -layout "<statement>.pdf" <scratch>/vb.txt` (statements are text-based; never eyeball-transcribe from rendered pages).

Build 4 CSVs per account (headers per `docs/canonical-csv-guide.md`). Write them to `~/Desktop/Trading - Local/canonical/{YYYY-MM}/` with names like `Vanguard_Roth_IRA_transactions_{YYYYMM}.csv` — **these exact files are what gets imported and what stays archived** (provenance: the files on disk must be the files in the DB).

### Quarterly-statement rule (March / June / September / December)

Quarter-end statements are "quarter-to-date": the overview and holdings compare **quarter-start → quarter-end** (e.g. 03/31 → 06/30).

- The activity section is normally **month-only** — but PROVE it: check the earliest settlement date, and run the sweep reconciliation (below). If prior-month rows appear, they dedup against existing source keys; verify amounts match what was imported or they'll create duplicates.
- **NEVER transcribe the overview's starting value into `monthly_snapshots.starting_value`** — that's the quarter start and fabricates a fake 3-month gain in one month's TWR. starting_value ALWAYS comes from the prior month's DB row (Phase 0 baseline). On a monthly statement the printed beginning balance must EQUAL the DB value — if not, stop and investigate.

### Transaction sign + mapping table (authoritative)

The statement's amount column is already the signed cash effect for most rows — **keep the statement's sign** except the two flip cases:

| Statement row (sign as printed) | Canonical type | Amount rule | Notes |
|---|---|---|---|
| Buy / Buy to open (−) | BUY / BUY_TO_OPEN | keep (negative) | |
| Sell / Sell to close (+) | SELL / SELL_TO_CLOSE | keep (positive) | statement qty is negative → emit abs() |
| Dividend (+) | DIVIDEND | keep | qty/price empty |
| Reinvestment (−) | REINVESTMENT | **FLIP to positive** | populate qty + price + amount |
| Sweep in (−) | TRANSFER | **FLIP to positive**, note `Sweep Into Settlement Fund` | symbol `-` on statement → `VMFXX` |
| Sweep out (+) | TRANSFER | **FLIP to negative**, note `Sweep Out Of Settlement Fund` | symbol → `VMFXX` |
| Foreign Tax Withheld / FRGN-W/H (−) | TAX_WITHHELD | keep (negative) | symbol = the dividend's security, not CASH |
| Funds received / EFT (+) | DEPOSIT | keep | symbol `CASH` |
| Withdrawal (−) | WITHDRAWAL | keep | symbol `CASH` |
| Share journal / gift (no cash) | TRANSFER_IN / TRANSFER_OUT | amount `0` | one row per journal line, never merged |

⚠️ **BUY amounts are NEGATIVE** (statement-import convention, April 2026 onward). Three artifacts will try to talk you out of this — all are known-wrong:
- `docs/canonical-csv-guide.md`'s BUY example row shows a positive amount (contradicts its own "negative = outflow" prose);
- prior months' `dashboard_*_2026xx.csv` files in Trading - Local show positive BUYs (pre-correction Co-Work artifacts, NOT what was imported);
- an unfiltered DB query sums positive, because rows **before 2026-04** are the historical bulk backfill with the legacy positive convention (do not "fix" those), plus 6 known May-2026 stragglers.

Verify against the statement-import era only: `sqlite3 -readonly data/vanguard.db "SELECT COUNT(*), SUM(amount) FROM transactions WHERE type='BUY' AND trade_date >= '2026-04-01'"` → overwhelmingly negative.

Other row rules: quantity always positive; options in OCC format (`XLE   270617C00060000` — symbol padded to 6); bonds/Treasuries use 9-char CUSIP; dual-class uses slash form (`BRK/B`); dates YYYY-MM-DD with the year inferred from the statement period; account names `Vanguard Taxable` / `Vanguard Roth IRA` verbatim. **Before inventing any symbol, check `securities` for the existing row** — a new-symbol variant of a held position is convention drift, not a new security.

### Holdings, prices, snapshots

- **Holdings**: one row per position at month-end, **including `cost_basis`** — quarter-end statements print it; do not leave the column blank like the old Co-Work files did.
- **Prices**: month-end close per symbol from the holdings section.
- **Monthly snapshot** — construct, don't transcribe:

| Field | Source |
|---|---|
| total_value | statement ending value |
| starting_value | prior month's DB `monthly_snapshots.total_value` |
| deposits_withdrawals | sum of the month's DEPOSIT/WITHDRAWAL/external-flow rows (0 if none) |
| dividends / interest | statement's month income summary; MUST equal the sum of extracted rows |
| commissions | per-trade "Commissions & fees" total, negative (pinned: trade charges → `commissions`, not `fees`) |
| fees | account-level/non-trade fees, negative |
| investment_gain | total_value − starting_value − deposits_withdrawals (pinned: Δ-value, includes retained income) |
| twr | investment_gain / starting_value when deposits_withdrawals = 0; otherwise Modified Dietz and say so |

## Phase 3 — Validation gates (all must pass before any commit)

1. `npx tsx scripts/validate-canonical-csv.ts <file>` on each CSV (structural).
2. **Trade cross-foot**: qty × price ∓ fees = amount, every trade row.
3. **Sweep reconciliation** (completeness proof): prior month's VMFXX balance + all signed canonical sweep/VMFXX-reinvest amounts = statement's ending sweep balance, to the penny. If it doesn't close, activity rows are missing or a sign is wrong.
4. **Holdings sum** = statement total account value, to the penny.
5. **Income tie-out**: sum of DIVIDEND rows = statement month dividends figure.
6. **Continuity**: starting_value = prior DB ending, all accounts.

## Phase 4 — Import

- Per account: preview → inspect (counts, zero unexplained warnings, **no unexpected new-security symbols** — a new symbol for an existing position means convention drift) → commit. Record batch ids for undo.
- The API route recomputes daily valuations post-commit. **If any step is ever done via script instead, call `computeDailyValuations(db)` explicitly** — `commitImport` alone does not.
- **After committing canonical HOLDINGS files, run the closed-equity sweep explicitly** — `canonical-csv` is not in `HOLDINGS_SNAPSHOT_SOURCES` (`lib/import/engine.ts`), so positions sold during the month linger as phantoms at their last nonzero date until the next full TWS refresh. One-off: a tiny tsx script calling `reconcileClosedEquityHoldings(db)` then `computeDailyValuations(db)` (June 2026 precedent: zeroed sold Roth ACWV/EEMV).

## Phase 5 — Post-import reconciliation (the definition of done)

1. DB spot-checks: 3 new `monthly_snapshots` rows; sold positions show quantity 0; statement rows won over any same-date `tws-%` rows.
2. `npx tsx scripts/audit-twr-vs-statements.ts` — must pass.
3. Duplicate-security check: `scripts/merge-duplicate-securities.ts` only replays its known hardcoded pairs — the real drift gate is that every `newSecurities` count in the commit results is explained (genuinely new positions), plus the foreign-symbol check from Phase 1.
4. Daily-valuation sanity: no negative totals, no inferred-cash spike at the new month-end anchor (the option price-unit-drift signature).
5. Report a per-account reconciliation table (statement value vs DB value, delta) — zero delta on every account — plus batch ids and the backup path. (Write "zero delta", not a dollar-zero literal: `$0` collides with the skill runner's positional-arg substitution.)

## Red flags — STOP, you are about to repeat a past mistake

- "The guide's example shows BUY positive" / "last month's CSV on disk has positive BUYs" → both artifacts are known-wrong; the DB is the convention authority.
- "starting_value from the statement overview" on a quarter-end month → fake TWR; use the DB.
- "I'll convert the IBKR CSV to canonical format" → discards sections the native parser needs.
- "Sweep reconciliation is off by a few cents but everything else ties" → a sign or a missed row; find it.
- "Skip the backup, imports are idempotent" → source-key edge cases have caused silent loss four separate months; back up first.
- "Cost basis column is blank, like last month" → the statement prints it; extract it.
- Import commit before all Phase-3 gates pass → never.

## Quick reference

| Thing | Where |
|---|---|
| Statements | `~/Desktop/Trading - Local/` |
| Archived canonical CSVs | `~/Desktop/Trading - Local/canonical/{YYYY-MM}/` |
| Import API | `POST /api/import?mode=preview\|commit`, multipart field `files` |
| Format spec | `docs/canonical-csv-guide.md` (BUY example sign is wrong — see table above) |
| Validators | `scripts/validate-canonical-csv.ts`, `scripts/audit-twr-vs-statements.ts`, `scripts/merge-duplicate-securities.ts` |
| Prior-month values | `monthly_snapshots` (never a statement's quarter-start column) |
