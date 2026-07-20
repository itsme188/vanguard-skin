# Vanguard Skin QA Test Scenarios

Fill in the `FILL_IN` placeholders with your expected values.
Values marked FILL_IN will be logged as SKIP (not FAIL) during QA runs.
Tolerances allow for normal market movement between QA runs.

> Rewritten 2026-07-20 against the 6-tab IA (Today | Accounts | Analysis |
> Research | Charts | Import). The pre-redesign Overview / Holdings /
> Calendar pages are redirect stubs now — checks target the real
> destinations. Text checks lowercase `innerText` before matching because
> CSS `text-transform: uppercase` labels read as all-caps at runtime.

---

## Page: Today (`/dashboard/today` — default landing)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | Checks for "Something went wrong" |
| Portfolio Value | from `expected-values.json` | 10% | Read from `GET /api/summary` `totalValue` (Electron-tray contract, redesign-proof) — NOT scraped from the DOM |
| Account count | e.g., 3 | exact | "N accounts · as of …" text in the portfolio hero strip |
| Data confidence indicator | (presence check) | - | `button[title^="Data confidence"]` — popover button, not the old data-health anchor |
| IBKR today block | (presence check) | - | `h2` "IBKR today" — Today-specific content (Today renders no chart by design) |

---

## Page: Cross-account Holdings (`/dashboard/accounts?id=all#holdings`)

`/dashboard/holdings` is a redirect stub to this URL — QA navigates the destination directly.

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Position count | e.g., 155 | 20% | "N positions across all accounts" |
| Total value (footer) | from `expected-values.json` | 10% | tfoot total row |
| Holdings table has rows | (presence check) | - | tbody has > 0 tr elements |

---

## Page: Accounts (`/dashboard/accounts`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Account tabs listed | (informational) | - | Names/values logged, not asserted |

---

## Page: Analysis — Performance view (`/dashboard/analysis?view=performance`)

Server-rendered; TWR / XIRR / drawdown / Sharpe KPIs live here post-redesign.

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Risk metrics present | (presence check) | - | "drawdown" + "sharpe" in lowercased innerText |
| TWR | e.g., "+18.12%" | 5pp | KPI strip; relocated from the old Overview check |
| XIRR present | (informational) | - | Requires cash-flow data |

---

## Page: Analysis — Diagnostics view (`/dashboard/analysis?view=diagnostics`)

Factor + scenario cards are client components, but their section HEADINGS
render immediately post-hydration (even while fetches load) — stable smoke targets.

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Factor analysis section | (presence check) | - | "Quantitative Factor Analysis" heading |
| Scenario modeling section | (presence check) | - | "Scenario Modeling" heading |

---

## Page: Charts (`/dashboard/charts`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Chart canvas rendered | (presence check) | - | LightweightCharts container |

---

## Page: Week Ahead (`/dashboard/today?view=week-ahead`)

`/dashboard/calendar` is a redirect stub to this URL — QA navigates the destination directly.

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Week-ahead view rendered | (presence check) | - | "week ahead" eyebrow (lowercased) OR an `h1` with a date range ("Jul 20 – Jul 26, 2026"); first `h1` is the header wordmark, so all h1s are scanned |

---

## Page: Research (`/dashboard/research`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| View toggle present | (presence check) | - | Notes / Feeds / Documents |

---

## Page: Import (`/dashboard/import`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Drop zone present | (presence check) | - | File upload area |

---

## How to Update Expected Values

1. Run `bash qa/run-qa.sh` once with the app running on :3099
2. Review `qa/qa-report.txt` — SKIP lines show extracted actual values
3. Copy actual values into `qa/expected-values.json`
4. Re-run to verify all checks pass

Passing value checks auto-update their expected value (drift re-baselining).

## Tolerance Notes

- **Currency tolerance (10%)**: Portfolio values change with markets; the nightly run re-baselines on PASS, so tolerance only needs to cover a few days of drift plus intraday movement.
- **Percentage point tolerance (5pp)**: TWR drifts with markets; re-baselined on PASS.
- **Exact match**: Counts (accounts) should not change without an account change.
