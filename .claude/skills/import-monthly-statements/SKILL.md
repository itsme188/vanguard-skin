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
- **Foreign-listed positions — symbol drift trap (June 2026 precedent):** the statement's symbol can differ from the TWS/Web-API symbol already in `securities` (statement `402340.KS` vs DB `402340`, currency KRW). The import then creates a **USD-defaulted duplicate** whose native price gets valued as dollars — a ₩1,697,000 close became a $16.9M position and a −$16.9M inferred-cash spike at the anchor date. After commit, check every new security the batch created against existing rows (`SELECT symbol,currency FROM securities WHERE currency!='USD'` + fuzzy symbol match); if a duplicate appeared, merge its transactions/holdings/prices into the existing row, delete the duplicate, recompute valuations. **(2026-07-05 fix)** `commitImport` (`lib/import/engine.ts::resolveIbkrExchangeSuffixedSymbols`) now normalizes known IBKR exchange suffixes (`.KS`, `.T`, `.TO`, `.L`, `.HK`, …) to the bare symbol unconditionally at commit time, so this specific dup can no longer occur on `ibkr-activity` imports — the trap note above stays for historical context / any suffix not yet in `IBKR_EXCHANGE_SUFFIXES`.
- **Non-USD cash-item rows (parser fixed 2026-09-03):** the Interest section prints one block per currency followed by IBKR's own `Total in USD` line; the parser converts non-USD Interest rows through that line and keeps the native figure in the note + source key (a ₩36,461.73 debit-interest row had imported as −$36,461.73 under the old code). The Dividends / Fees / Deposits & Withdrawals loops still store native amounts — if a preview figure looks like a foreign-currency magnitude, stop and check that section's currency column before committing.
- Commit (`?mode=commit`), record the batch id.

## Phase 2 — Vanguard PDFs → canonical CSVs

Extract text: `pdftotext -layout "<statement>.pdf" <scratch>/vb.txt` (statements are text-based; never eyeball-transcribe from rendered pages).

### Expanded statement details (July 2026 onward)

Vanguard's "Back by request: expanded statement details" change means EVERY monthly statement's holdings tables now carry the columns **[Unrealized Gains/Losses, Total Cost Basis, Quantity, Price, prior Balance, current Balance]** — cost basis is no longer quarter-end-only. Each holding also gets an `Est. annual income: $X; Est. yield: Y%` sub-line (skip these when parsing — they are informational, not data rows; EAI/EY are NOT stored anywhere) and each section a `Total Est. annual income …` footer line. Two EAI/EY disclosure pages were appended at the back. Consequences:

- **Extract `cost_basis` every month.** A `-` in the Total Cost Basis column (average-cost mutual funds like VSMAX/VVIAX, unavailable-basis rows like UBER) → leave the CSV cell blank, exactly as before.
- Free integrity check: statement `Unrealized G/L = current Balance − Total Cost Basis` per row — verify a few rows to confirm you're reading the right columns.
- **Missing statement cost basis (2026-10):** a statement can print a dash in both cost columns on EVERY row even though its cover page says cost basis is included. Do not carry the prior month's figures forward and never estimate. Fill from the broker's own lot-level cost basis report, under a strict test per position: the report's lots acquired on or before month-end must sum exactly to the month-end quantity, AND the report's total quantity must equal the month-end quantity plus the lots acquired after month-end. A row that fails, is not in the report, or has no cost printed there (shorts, non-covered positions) stays blank. Cross-check the filled rows against the prior month's printed basis for unchanged positions, and record in the gate report that the cost-basis spot check could not run against the statement.

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
| Share journal / gift (no cash) | TRANSFER_IN / TRANSFER_OUT | amount = transfer-date market value (positive) | one row per journal line, never merged; for a gift to a donor-advised fund (DAF) the amount is a stand-in until Phase 6 replaces it with the DAF's value |
| Stock Split (+N shares/contracts) | SPLIT | amount `0`, qty = additional units | on the POST-split symbol; VGT 2026-04 + CRWD-option 2026-07 precedents |
| Security Exchange (option exercised) | EXERCISED | amount `0`, qty = contracts | pairs with a normal Buy of the stock at strike; computeTaxLots rolls premium into stock basis |
| Expired (option) | EXPIRED | amount `0`, qty = abs(contracts) | note `Expired worthless` |
| CUSIP Change / name change (± same qty, $0) | **skip both rows** | — | same ticker in DB → pure no-op (XOM 2026-07 precedent); only record if the SYMBOL actually changes |
| ADR Custody Fee (−) | FEE | keep (negative) | symbol = the ADR's ticker, note names the fee |

⚠️ **BUY amounts are NEGATIVE** (statement-import convention, April 2026 onward). Three artifacts will try to talk you out of this — all are known-wrong:
- `docs/canonical-csv-guide.md`'s BUY example row shows a positive amount (contradicts its own "negative = outflow" prose);
- prior months' `dashboard_*_2026xx.csv` files in Trading - Local show positive BUYs (pre-correction Co-Work artifacts, NOT what was imported);
- an unfiltered DB query sums positive, because rows **before 2026-04** are the historical bulk backfill with the legacy positive convention (do not "fix" those), plus 6 known May-2026 stragglers.

Verify against the statement-import era only: `sqlite3 -readonly data/vanguard.db "SELECT COUNT(*), SUM(amount) FROM transactions WHERE type='BUY' AND trade_date >= '2026-04-01'"` → overwhelmingly negative.

Other row rules: quantity always positive; options in OCC format (`XLE   270617C00060000` — symbol padded to 6); bonds/Treasuries use 9-char CUSIP; dual-class uses slash form (`BRK/B`); dates YYYY-MM-DD with the year inferred from the statement period; account names `Vanguard Taxable` / `Vanguard Roth IRA` verbatim. **Before inventing any symbol, check `securities` for the existing row** — a new-symbol variant of a held position is convention drift, not a new security.

Bond trades with accrued interest: ONE BUY/SELL row, `amount` = the full cash including accrued, `price` = the clean price, note `Accrued interest X` (2025-05 precedent; the holdings cost basis printed for the bond is the clean figure). Known consequence, flagged 2026-09-03 and left unchanged: `computeTaxLots` takes lot dollars from `amount`, so bond bases and proceeds are dirty by the accrued leg (91282CKQ3 Aug-2026: engine −696.37 vs statement −530.54).

### Holdings, prices, snapshots

- **Holdings**: one row per position at month-end, **including `cost_basis`** — every monthly statement prints it since July 2026 (quarter-end only before that); do not leave the column blank like the old Co-Work files did. Merge cash/margin sub-account duplicate rows (VSMAX/VVIAX appear twice) into ONE row summing quantity + balances. Exclude unpriced DEAD rows (price `-`: Pershing SPARC rights, escrow, delisted ADRs) — the statement excludes them from totals too. **A LIVE option the statement prints without a price is different (2026-10): keep it in the holdings file at its quantity with market value 0, and write no price row.** A position absent from a statement snapshot is treated as closed by the reconciler, which mints an estimated close for a contract that is still open; market value 0 keeps the holdings-sum gate unchanged. Shorts import as negative quantity with the printed (negative) balance. For an option replaced by a split, add a **quantity-0 tombstone row for the OLD OCC symbol** (mv 0, cost_basis blank) — options have no snapshot-diff reconciler, so without it the pre-split contract lingers as a phantom until expiry (CRWD $470→$117.50 2026-07 precedent).
- **Margin credit is NOT a holding**: the statement's total account value = holdings + `Margin summary → margin credit`. The holdings-sum gate ties to (statement total − margin credit); the margin credit lands in inferred cash at the month-end anchor, where a residual roughly equal to it (± bond accrued interest and option-mark rounding) is CORRECT, not drift.
- **Prices**: month-end close per symbol from the holdings section.
- **Monthly snapshot** — construct, don't transcribe:

| Field | Source |
|---|---|
| total_value | statement ending value |
| starting_value | prior month's DB `monthly_snapshots.total_value` |
| deposits_withdrawals | sum of the month's DEPOSIT/WITHDRAWAL/external-flow rows (0 if none). **Cash only: never add the value of gifted or journaled shares** (2026-10) |
| dividends / interest | statement's month income summary; MUST equal the sum of extracted rows |
| commissions | per-trade "Commissions & fees" total, negative (pinned: trade charges → `commissions`, not `fees`) |
| fees | account-level/non-trade fees, negative |
| investment_gain | total_value − starting_value − deposits_withdrawals (pinned: Δ-value, includes retained income). Gift month (2026-10): also add back the month's gift value, so gifts are excluded from the gain |
| twr | investment_gain / starting_value when deposits_withdrawals = 0; otherwise Modified Dietz and say so. Gift month (2026-10): Modified Dietz with each gift as a dated outflow, even when deposits_withdrawals = 0 |

**Gift months (owner ruling 2026-10, first applied to September 2026):** shares given away are an external outflow, not an investment loss. `deposits_withdrawals` stays cash-only (daily cash stepping and the Modified Dietz cross-check read it as cash), so the ruling is carried by `twr` (time-weighted return) and `investment_gain`. In a gift month `total_value − starting_value − deposits_withdrawals` does NOT equal `investment_gain`; that is intended, not a transcription error. Use the DAF's gift values, which are only final after Phase 6, so expect to correct the snapshot there. Months before September 2026 were counted the old way and are not restated.

## Phase 3 — Validation gates (all must pass before any commit)

1. `npx tsx scripts/validate-canonical-csv.ts <file>` on each CSV (structural).
2. **Trade cross-foot**: qty × price ∓ fees = amount, every trade row (bonds: qty × price ÷ 100 ± accrued). Tolerance = qty × 0.00005 × multiplier — statement prices print at 4 dp, so a 644.833-share sale legitimately lands 3¢ off (Aug-2026 LAND).
3. **Sweep reconciliation** (completeness proof): prior month's VMFXX balance + all signed canonical sweep/VMFXX-reinvest amounts = statement's ending sweep balance, to the penny. If it doesn't close, activity rows are missing or a sign is wrong.
4. **Holdings sum** = statement total account value, to the penny.
5. **Income tie-out**: sum of DIVIDEND rows = statement month dividends figure.
6. **Continuity**: starting_value = prior DB ending, all accounts.

## Phase 4 — Import

- **Auth against the packaged app (trust boundary #35):** mint a session with `npx tsx scripts/mint-qa-session.ts --db data/vanguard.db` (prints `VGS_SESSION` / `VGS_CSRF`); every curl needs `-b "vgs_session=$VGS_SESSION; vgs_csrf=$VGS_CSRF" -H "x-csrf-token: $VGS_CSRF"` AND, on POST/PUT, `-H "Origin: http://127.0.0.1:3099"` — without the Origin header a mutating call returns 401 `unauthorized` even with a valid session (GETs work without it). Revoke with `--revoke` when done.
- **The packaged app runs its BUNDLED parsers.** A parser fix in the repo is invisible to `POST /api/import` until the next `electron:deploy`; to import with the fixed code, run the route's exact lib sequence from a repo-root tsx script instead (`parseImport` → `commitImport` → `classifySecurities` → `computeTaxLots` → `computeDailyValuations`; open the DB with a `busy_timeout`) — 2026-09-03 IBKR precedent.
- Per account: preview → inspect (counts, zero unexplained warnings, **no unexpected new-security symbols** — a new symbol for an existing position means convention drift) → commit. Record batch ids for undo.
- **Commit calls can exceed curl's 2-minute default** — the post-commit hooks (tax lots, classification, daily valuations) run synchronously inside the request. Use `curl -m 570` (and a matching tool timeout). A timed-out curl does NOT mean a failed commit: check `import_batches` for the new batch ids before retrying — re-POSTing after a server-side success just no-ops on source keys, but you'd misread the run (July 2026: Roth commit landed fine behind a 2-min curl timeout).
- **A re-import of an already-imported monthly snapshot is skipped as a duplicate even when its figures changed (2026-10)**, and it leaves an empty batch behind. To correct a snapshot, undo that one batch with the two-step undo, then re-import: `DELETE /api/import?batchId=N` returns a confirm token and deletes nothing; repeat with `&confirm=TOKEN`. A recovery manifest is written to `data/undo-recovery/` first. Undo only the snapshot's own batch.
- The API route recomputes daily valuations post-commit. **If any step is ever done via script instead, call `computeDailyValuations(db)` explicitly** — `commitImport` alone does not.
- **The commit of a canonical HOLDINGS file runs the closed-position sweep itself (corrected 2026-10).** `canonical-csv` is still absent from the static `HOLDINGS_SNAPSHOT_SOURCES` list in `lib/import/engine.ts`, but `commitImport` runs the sweeps for any canonical batch whose parse carried holdings rows, and the statement-origin tombstones it mints for sold positions are owned by that batch. The September 2026 commit minted them with no manual step. Do NOT run a manual sweep by habit. Verify instead: every position sold in the month shows quantity 0 after the holdings commit, and the commit result carries no "closed-position reconcile failed" warning. Only if that check fails, run a tiny tsx script calling `reconcileClosedEquityHoldings(db)` then `computeDailyValuations(db)` (the June 2026 precedent, from before the commit did this).

## Phase 5 — Post-import reconciliation (the definition of done)

1. DB spot-checks: 3 new `monthly_snapshots` rows; sold positions show quantity 0; statement rows won over any same-date `tws-%` rows.
2. `npx tsx scripts/audit-twr-vs-statements.ts` — must pass.
3. Duplicate-security check: `scripts/merge-duplicate-securities.ts` only replays its known hardcoded pairs — the real drift gate is that every `newSecurities` count in the commit results is explained (genuinely new positions), plus the foreign-symbol check from Phase 1.
4. Daily-valuation sanity: no negative totals, no inferred-cash spike at the new month-end anchor (the option price-unit-drift signature).
5. Report a per-account reconciliation table (statement value vs DB value, delta) — zero delta on every account — plus batch ids and the backup path. (Write "zero delta", not a dollar-zero literal: `$0` collides with the skill runner's positional-arg substitution.)
6. **Last-trading-day-sale / Plaid trap**: a position fully sold on the month's last trading day is ABSENT from statement holdings (trade-date basis), so no statement row overwrites that morning's pre-sale Plaid row — the month-end daily valuation then carries a phantom position and inferred cash swings low by its value (HUN 2026-07: −$651 residual instead of +$9,758 margin credit). Check the anchor-date inferred cash against the margin credit; if off by ≈ one position's value, find the same-day `plaid:` holdings row and UPDATE its quantity to the trade-date-correct value, then recompute valuations. This is a direct database write outside the import API: get the owner's approval first, and confirm afterwards that the month-end total did not move and the cash/holdings split moved by exactly that position's value (2026-10).
7. **Unsettled activity section is imported THIS month, as its own file** (2026-09-03 correction: the August statement did NOT re-list July's nine unsettled trades — the old "they reappear as Completed transactions next month" assumption is wrong and left the HUN/LAND sells, PAYC/PCTY covers, four option closes and a T-note buy out of the ledger for a month; the engine papered over HUN with a synthesized `RECONCILE_CLOSE`). Transcribe every "Unsettled activity" row with trade_date = the printed trade date and settlement_date = the printed next-month settlement date into `Vanguard_<Account>_transactions_{YYYYMM}-unsettled.csv`, gate it with the rest, and import it before the month's main transactions file. Statement holdings already reflect these trades (trade-date basis); the sweep balance does not (they settle through the margin account next month) — both asymmetries are expected, and the sweep gate still closes without them.
8. **Prices are priority-merged, not statement-wins** (`lib/import/engine.ts` `insertPrice`: tws > ibkr > vanguard/plaid > canonical): month-end statement closes never replace same-date TWS marks, so expect `N duplicates skipped` on the holdings + prices commits and a residual in the anchor-day inferred cash equal to (TWS marks − statement marks) — 48/131 symbols differed >2% in Aug-2026, mostly option marks. The month-end TOTAL is anchored to the statement regardless: check `daily_valuations.total_value` on the month-end equals the statement to the penny.
9. **New money-market / sweep-class fund → add it to `lib/data/security-classifications.ts`** (mirror the VMFXX line; VUSXX 2026-08 precedent) and classify it live (`PUT /api/securities/classify` body `{security_id, fund_category: "Cash Equivalent", geography: "US"}`), then `POST /api/compute/valuations` — otherwise it counts as a holding and the anchor-day inferred cash is low by its whole value.

## Phase 6 — Gifts (when the month has share journals out to a DAF)

Run after Phase 5 closes. Every call below needs the Phase 4 session headers. Each donation edit ends in a whole-ledger tax-lot recompute: without `acknowledgeLedgerRecompute: true` in the body the route answers 409 `ledger_recompute_unacknowledged` and writes nothing. Read the counts in that 409, then repeat with the acknowledgement.

1. **Import the DAF contributions file.** Preview first: the count of NEW donations must equal the number of gifts in the month. Any other count → stop.
2. **Link each donation to its OUT leg**: `POST /api/donations/:id/links` with `outTransactionId` = the cash-sub-account TRANSFER_OUT row, `amountForOutLeg` = the DAF's value for that gift, and `acknowledgeLedgerRecompute: true`. This replaces the transcription's stand-in amount on the leg.
    - **The DAF values a stock gift at the mean of the day's high and low on the receipt date**, not the close. The close can differ by a few percent. The broker's gifted-shares summary uses the same method. The DAF value is the authority; do not "fix" it toward the close.
    - Check the receipt date against the broker's journal date. They were equal in 2026-09 (no transfer lag); a difference needs a look before linking.
3. **Recompute the month's `twr` and `investment_gain`** with the DAF values (the gift-month rule in Phase 2), fix the snapshot CSV on disk, and correct the stored snapshot by undo + re-import (the two-step undo in Phase 4). The archived file must be the file in the DB.
4. **Assign lots from the broker's gifted-shares summary** (per gift: date gifted, date acquired, method, quantity, cost, gift value): `POST /api/donations/:id/lots` with `assignments: [{ acquisitionTransactionId, quantity }]` and the acknowledgement. An empty `assignments` array clears a donation's lots. When reassigning across several gifts of one stock, clear first: a lot's capacity is shared, so the new assignment can be refused while another gift still holds the lot.
    - **Take the broker's lots as recorded, not its stated default method.** The broker did not follow its default method on every gift in 2026-09. Report any gifted lot that is short term to the owner: the deduction for short-term shares is normally limited to basis (a tax-preparer question).
    - **The gifted-shares summary PDF scrambles digits in extracted text** (its font maps each digit to another glyph). Decode by anchoring on known values (gift quantities and dates) and prove the decode with per-share cost ties, or read the figures from a rendered image. Never trust the raw extracted digits.
    - **Never run `scripts/assign-donation-lots-by-method.ts --apply`.** It has no database-path override, so it cannot be rehearsed on a copy, and it has no per-lot capacity check: its plan can put two gifts on one lot beyond that lot's size.
5. **Verify**: for each gifted stock, the app's open lots equal the broker's remaining lots by acquisition date and quantity. Also compare earlier gifts of the same stock against the summary; totals can be right while two gifts hold each other's lots.
6. Re-run Phase 5 steps 2, 4 and 5. The recompute must not have moved any month-end total.

## Red flags — STOP, you are about to repeat a past mistake

- "The guide's example shows BUY positive" / "last month's CSV on disk has positive BUYs" → both artifacts are known-wrong; the DB is the convention authority.
- "starting_value from the statement overview" on a quarter-end month → fake TWR; use the DB.
- "I'll convert the IBKR CSV to canonical format" → discards sections the native parser needs.
- "Sweep reconciliation is off by a few cents but everything else ties" → a sign or a missed row; find it.
- "The unsettled trades will reappear in next month's Completed section" → they don't (Aug-2026); import the unsettled section now as its own file.
- "Skip the backup, imports are idempotent" → source-key edge cases have caused silent loss four separate months; back up first.
- "Cost basis column is blank, like last month" → every statement (monthly since 2026-07, quarter-end before) prints it; extract it.
- "Holdings sum is ~$10k off the statement total" → you forgot the margin credit (subtract it from the statement total before comparing), OR a last-trading-day sale left a stale same-day Plaid holdings row (see Phase 5 step 6).
- "This option has no price, so I'll leave it out like the rights and escrow rows" → a LIVE option stays in at its quantity with market value 0 and no price row (2026-10); left out, the reconciler closes it.
- "The gift lowered the account, so the month's gain is lower" / "I'll put the gift value in deposits_withdrawals" → neither (2026-10). The field stays cash-only; the gift is a dated outflow in `twr` and is excluded from `investment_gain`.
- "The gift leg's amount is the day's close" → a stand-in only. The DAF's value (mean of the day's high and low) replaces it when the donation is linked.
- "The statement printed no cost basis, so I'll reuse last month's or estimate it" → fill only from the broker's lot report under the strict quantity test; otherwise blank (2026-10).
- "I'll re-import the corrected snapshot over the old one" → it is skipped as a duplicate. Undo that batch (two steps), then re-import.
- "The PDF text gives me the gifted lots' numbers" → that summary's digits are scrambled in extracted text; decode and verify, or read a rendered image.
- "`assign-donation-lots-by-method.ts --apply` will assign the gift lots" → never; assign from the broker's gifted-shares summary.
- "Run the manual closed-equity sweep after the holdings commit" → the commit already does it (2026-10); verify the tombstones first.
- Import commit before all Phase-3 gates pass → never.

## Quick reference

| Thing | Where |
|---|---|
| Statements | `~/Desktop/Trading - Local/` |
| Archived canonical CSVs | `~/Desktop/Trading - Local/canonical/{YYYY-MM}/` |
| Import API | `POST /api/import?mode=preview\|commit`, multipart field `files` — commit needs `curl -m 570` (sync post-commit hooks) + session cookies, `x-csrf-token`, and an `Origin` header (Phase 4) |
| Format spec | `docs/canonical-csv-guide.md` (BUY example sign is wrong — see table above) |
| Validators | `scripts/validate-canonical-csv.ts`, `scripts/audit-twr-vs-statements.ts`, `scripts/merge-duplicate-securities.ts` |
| Prior-month values | `monthly_snapshots` (never a statement's quarter-start column) |
| Batch undo | `DELETE /api/import?batchId=N`, then again with `&confirm=TOKEN`; manifest in `data/undo-recovery/` |
| Gift links / lots | `POST /api/donations/:id/links`, `POST /api/donations/:id/lots` (both need `acknowledgeLedgerRecompute: true`) — Phase 6 |
