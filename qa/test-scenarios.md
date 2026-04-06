# Vanguard Skin QA Test Scenarios

Fill in the `FILL_IN` placeholders with your expected values.
Values marked FILL_IN will be logged as SKIP (not FAIL) during QA runs.
Tolerances allow for normal market movement between QA runs.

---

## Page: Overview (`/dashboard`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | Checks for "Something went wrong" |
| Portfolio Value displayed | `FILL_IN` (e.g., "$1,234,567") | 2% | Market values drift daily |
| Account summary cards present | `FILL_IN` (e.g., 3) | exact | Number of account cards |
| TWR YTD displayed | `FILL_IN` (e.g., "+12.34%") | 0.5pp | Absolute percentage points |
| XIRR displayed | (presence check only) | - | Just verify it renders |
| Data freshness indicator visible | (presence check) | - | Health dot + dates |
| Portfolio chart rendered | (presence check) | - | Recharts container exists |
| Morning briefing section | (presence check) | - | Section heading exists |

---

## Page: Holdings (`/dashboard/holdings`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Position count | `FILL_IN` (e.g., 72) | exact | "N positions across all accounts" |
| Total portfolio value (footer) | `FILL_IN` (e.g., "$980,000") | 2% | tfoot total row |
| Holdings table has rows | (presence check) | - | tbody has > 0 tr elements |
| Symbol column uses monospace | (presence check) | - | font-mono class on first column |

---

## Page: Accounts (`/dashboard/accounts`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Account 1 name | `FILL_IN` (e.g., "Vanguard Taxable") | exact | |
| Account 1 value | `FILL_IN` (e.g., "$500,000") | 2% | |
| Account 2 name | `FILL_IN` | exact | |
| Account 2 value | `FILL_IN` | 2% | |
| Account 3 name | `FILL_IN` | exact | |
| Account 3 value | `FILL_IN` | 2% | |

---

## Page: Analysis (`/dashboard/analysis`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Allocation pie chart present | true | - | SVG/canvas element exists |
| Risk metrics section present | true | - | "Risk" heading or card |
| Factor analysis section present | true | - | "Factor" heading or card |
| Scenario modeling section present | true | - | "Scenario" heading or card |

---

## Page: Charts (`/dashboard/charts`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Chart canvas rendered | (presence check) | - | LightweightCharts container |
| Security selector present | (presence check) | - | Dropdown or picker |

---

## Page: Calendar (`/dashboard/calendar`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Week navigation present | (presence check) | - | Prev/Today/Next buttons |
| Calendar grid rendered | (presence check) | - | Day columns exist |

---

## Page: Research (`/dashboard/research`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| View toggle present | (presence check) | - | Notes / Trade Reviews / Feeds |

---

## Page: Import (`/dashboard/import`)

| Check | Expected Value | Tolerance | Notes |
|-------|---------------|-----------|-------|
| Page loads without error | (auto) | - | |
| Drop zone present | (presence check) | - | File upload area |
| Import history section | (presence check) | - | Past imports listed |

---

## How to Update Expected Values

1. Run `bash qa/run-qa.sh` once with the dev server running
2. Review `qa/qa-report.txt` — SKIP lines show extracted actual values
3. Copy actual values into `qa/expected-values.json`
4. Re-run to verify all checks pass

## Tolerance Notes

- **Currency tolerance (2%)**: Portfolio values change with markets. 2% accommodates ~1 day of normal movement.
- **Percentage point tolerance (0.5pp)**: TWR/XIRR drift slowly. 0.5pp covers rounding + small data changes.
- **Exact match**: Counts (positions, accounts) should not change without an import.
