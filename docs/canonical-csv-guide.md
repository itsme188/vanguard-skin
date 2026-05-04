# Canonical CSV Format Guide

The Portfolio Desk dashboard accepts 4 standardized CSV formats for importing financial data. These are designed for preprocessing raw brokerage documents (PDFs, proprietary CSVs) into a consistent format using Claude Code or the batch script.

## Overview

| CSV Type | Purpose | Key Columns |
|----------|---------|-------------|
| **Transactions** | Buy/sell/dividend/fee history | account, trade_date, type, symbol, quantity, price, amount |
| **Holdings** | Point-in-time position snapshots | account, as_of_date, symbol, quantity, cost_basis, market_value |
| **Prices** | Daily closing prices | symbol, date, close_price |
| **Snapshots** | Monthly account-level totals | account, month_end_date, total_value |

## General Rules

- **Dates**: Always `YYYY-MM-DD` format
- **Transaction types**: Must be UPPERCASE (see full list below)
- **Quantity sign**: ALWAYS POSITIVE. The type field (BUY/SELL/SELL_TO_CLOSE/EXERCISED/REDEMPTION/etc.) carries direction. Never emit a negative quantity. (Pre-2026-05-04 the parser silently dropped negative-quantity rows; the canonical-csv parser now auto-normalizes to abs() with a warning, but emit positive in the first place.)
- **Cash-only rows**: WITHDRAWAL, DEPOSIT, FEE, COMMISSION, and standalone INTEREST rows that have no associated security MUST use symbol `CASH`. Blank-symbol rows are dropped.
- **Source-key uniqueness**: The parser builds dedup keys as `canonical:txn:{account}:{symbol}:{trade_date}:{type}:{cents}` where cents = `round(amount * 100)`. Same-day, same-symbol, same-type fills with different amounts (e.g., a 400-share SELL at $78,466.98 + a 100-share SELL at $19,664.09) get distinct keys and both land. Pre-2026-05-04 the formula omitted cents and split fills silently collided.
- **Security types**: `Stock`, `Bond`, `ETF`, `Option`, `Mutual Fund`
- **Options**: Use OCC format — symbol padded to 6 chars + `YYMMDD` + `C`/`P` + strike x1000 padded to 8 digits (e.g., `AAPL  260320C00150000`)
- **Numbers**: No currency symbols, no commas in numbers, use `.` for decimals
- **Account names**: Must match exactly what's in the dashboard. Common Vanguard PDF aliases: `Individual brokerage account` / `Vanguard Individual Brokerage` → `Vanguard Taxable`. `Vanguard Roth IRA` is verbatim. `IBKR` is verbatim.
- **No leading comment lines**: The file must start with the header row directly. Do NOT prefix with `# filename.csv` or markdown fences. (The parser does strip leading `#` lines defensively, but it's better to emit clean CSV.)
- **Encoding**: UTF-8
- **Deduplication**: Re-importing the same file is safe — deterministic source keys prevent duplicate records

---

## 1. Transactions CSV

**Header:**
```
account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes
```

| Column | Required | Type | Description |
|--------|----------|------|-------------|
| account | Yes | string | Account name (e.g., "Vanguard Taxable") |
| trade_date | Yes | date | Trade execution date (YYYY-MM-DD) |
| settlement_date | No | date | Settlement date (YYYY-MM-DD) |
| type | Yes | string | Transaction type (UPPERCASE, see list below). Carries direction — BUY adds to position, SELL/SELL_TO_CLOSE/EXERCISED/REDEMPTION removes |
| symbol | Yes | string | Ticker symbol (OCC format for options). Use `CASH` for cash-only rows (WITHDRAWAL, DEPOSIT, FEE, COMMISSION, INTEREST without a security) |
| security_name | No | string | Full security name |
| security_type | No | string | Stock, Bond, ETF, Option, Mutual Fund |
| quantity | No | number | Shares/units — ALWAYS POSITIVE. The type field carries direction. |
| price | No | number | Price per share ($) |
| amount | No | number | Total dollar amount (positive = inflow, negative = outflow) |
| fees | No | number | Fees and commissions ($) |
| notes | No | string | Free-text notes |

**Valid transaction types:**
```
BUY, SELL, DIVIDEND, REINVESTMENT, INTEREST, TAX_WITHHELD,
TRANSFER, TRANSFER_IN, TRANSFER_OUT, DEPOSIT, WITHDRAWAL,
FEE, COMMISSION, BUY_TO_OPEN, SELL_TO_CLOSE, SELL_TO_OPEN,
BUY_TO_CLOSE, BUY_TO_COVER, EXERCISED, ASSIGNED, EXPIRED,
REDEMPTION, EXCHANGE, CORPORATE_ACTION, SPINOFF, MERGER,
SPLIT, RETURN_OF_CAPITAL, SHORT_SELL
```

**Income-row placement rule:** For `DIVIDEND`, `INTEREST`, and `TAX_WITHHELD` rows, leave `quantity` and `price` empty and put the cash amount in the `amount` column — never in `fees`. For `REINVESTMENT` rows, populate both `quantity`/`price` (shares received at the reinvestment price) **and** `amount` (total value reinvested).

**TRANSFER sign rule:** For Vanguard `TRANSFER` rows (VMFXX money-market sweeps), `amount` is **signed**: "Sweep Into Settlement Fund" is positive (cash entering VMFXX), "Sweep Out Of Settlement Fund" is negative (cash leaving VMFXX to settle a trade). The direction is already in the notes column — mirror it in the sign.

**Example:**
```csv
account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes
Vanguard Taxable,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,1502.50,4.95,
Vanguard Taxable,2025-06-20,,DIVIDEND,AAPL,Apple Inc,Stock,,,25.00,,Q2 dividend
Vanguard Taxable,2025-06-30,,INTEREST,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,12.45,,
Vanguard Taxable,2025-06-20,,REINVESTMENT,VTI,Vanguard Total Stock Market ETF,ETF,0.098,255.10,25.00,,Reinvested Q2 dividend
Vanguard Taxable,2025-07-15,,TAX_WITHHELD,VXUS,Vanguard Total International Stock ETF,ETF,,,-3.50,,Foreign withholding
Vanguard Taxable,2025-06-10,,TRANSFER,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,1000.00,,Sweep Into Settlement Fund
Vanguard Taxable,2025-06-12,,TRANSFER,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,-250.00,,Sweep Out Of Settlement Fund
IBKR,2025-06-18,2025-06-20,SELL,VTI,Vanguard Total Stock Market ETF,ETF,20,242.50,4850.00,1.00,Rebalancing
```

---

## 2. Holdings CSV

**Header:**
```
account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value
```

| Column | Required | Type | Description |
|--------|----------|------|-------------|
| account | Yes | string | Account name |
| as_of_date | Yes | date | Snapshot date (YYYY-MM-DD) |
| symbol | Yes | string | Ticker symbol |
| security_name | No | string | Full security name |
| security_type | No | string | Stock, Bond, ETF, Option, Mutual Fund |
| quantity | Yes | number | Number of shares/units held |
| cost_basis | No | number | Total cost basis ($) |
| market_value | No | number | Current market value ($) |

**Example:**
```csv
account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value
Vanguard Taxable,2025-06-30,AAPL,Apple Inc,Stock,100,15025.00,19500.00
Vanguard Taxable,2025-06-30,VTI,Vanguard Total Stock Market ETF,ETF,50,11250.00,12100.00
IBKR,2025-06-30,SPY,SPDR S&P 500 ETF,ETF,200,92000.00,96400.00
```

---

## 3. Prices CSV

**Header:**
```
symbol,date,close_price
```

| Column | Required | Type | Description |
|--------|----------|------|-------------|
| symbol | Yes | string | Ticker symbol |
| date | Yes | date | Price date (YYYY-MM-DD) |
| close_price | Yes | number | Closing price ($) |

Note: These prices have the lowest priority in the system. Live TWS prices, IBKR statement prices, and Vanguard statement prices all take precedence.

**Example:**
```csv
symbol,date,close_price
AAPL,2025-06-30,195.00
AAPL,2025-06-29,193.50
VTI,2025-06-30,242.00
SPY,2025-06-30,482.00
```

---

## 4. Monthly Snapshots CSV

**Header:**
```
account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr
```

| Column | Required | Type | Description |
|--------|----------|------|-------------|
| account | Yes | string | Account name |
| month_end_date | Yes | date | Last day of month (YYYY-MM-DD) |
| total_value | Yes | number | End-of-month portfolio value ($) |
| starting_value | No | number | Start-of-month value ($) |
| deposits_withdrawals | No | number | Net cash flows ($) |
| dividends | No | number | Dividend income ($) |
| interest | No | number | Interest income ($) |
| commissions | No | number | Commissions paid ($, negative) |
| fees | No | number | Fees paid ($, negative) |
| investment_gain | No | number | Investment gain/loss ($) |
| twr | No | number | Time-weighted return (decimal, e.g., 0.05 = 5%) |

**Example:**
```csv
account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr
Vanguard Taxable,2025-06-30,250000,245000,2000,150,25,-15,-10,2850,0.0116
IBKR,2025-06-30,300000,295000,0,200,50,-25,-5,4780,0.0162
```

---

## File Organization

For historical data, organize files by year and account:

```
data/canonical/
  2024/
    vanguard-taxable/
      transactions-2024.csv
      holdings-2024-12.csv
    ibkr/
      transactions-2024.csv
      holdings-2024-12.csv
  2025/
    vanguard-taxable/
      transactions-2025-01.csv
      transactions-2025-02.csv
      ...
      holdings-2025-06.csv
```

## Validation

Run the validation script before importing:
```bash
npx tsx scripts/validate-canonical-csv.ts path/to/file.csv
```

This checks headers, date formats, transaction types, required fields, and number formats.
