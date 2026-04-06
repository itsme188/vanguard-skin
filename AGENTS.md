# Vanguard Skin — Agent Instructions

## Converting Brokerage Data to Canonical CSV

When the user provides raw financial documents (PDFs, proprietary CSVs, screenshots, or pasted data from any brokerage), convert them into the standardized CSV formats described below. These CSVs can then be imported directly into the Vanguard Skin dashboard.

### Output Rules

- Output ONLY the CSV content (header + data rows)
- No markdown code fences, no explanations before/after
- If multiple CSV types are needed, output each with a clear filename comment: `# transactions-2025-06.csv`
- Use UTF-8 encoding
- All dates: YYYY-MM-DD format
- Transaction types: UPPERCASE only
- Numbers: no currency symbols, no commas, use `.` for decimals
- Account names: ask the user which account this data belongs to if not clear. Common names: `Vanguard Taxable`, `Vanguard IRA`, `IBKR`
- Options must use OCC format: symbol padded to 6 chars + YYMMDD + C/P + strike x1000 padded to 8 digits (e.g., `AAPL  260320C00150000`)

### Format 1: Transactions

```
account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes
```

Valid transaction types:
BUY, SELL, DIVIDEND, REINVESTMENT, INTEREST, TAX_WITHHELD, TRANSFER, TRANSFER_IN, TRANSFER_OUT, DEPOSIT, WITHDRAWAL, FEE, COMMISSION, BUY_TO_OPEN, SELL_TO_CLOSE, SELL_TO_OPEN, BUY_TO_CLOSE, BUY_TO_COVER, EXERCISED, ASSIGNED, EXPIRED, REDEMPTION, EXCHANGE, CORPORATE_ACTION, SPINOFF, MERGER, SPLIT, RETURN_OF_CAPITAL, SHORT_SELL

Security types: Stock, Bond, ETF, Option, Mutual Fund

### Format 2: Holdings

```
account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value
```

One row per (account, symbol) per as_of_date.

### Format 3: Prices

```
symbol,date,close_price
```

One row per (symbol, date).

### Format 4: Monthly Snapshots

```
account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr
```

month_end_date should be the last calendar day of the month. twr is a decimal (0.05 = 5%).

### Workflow

1. Identify what data is in the raw document (transactions? holdings? both?)
2. Ask the user for the account name if not obvious
3. Extract all data into the appropriate CSV format(s)
4. Verify completeness: count rows, sum dollar amounts, check for missing fields
5. Output the CSV(s)

### Common Source Formats

- **Vanguard PDF statements**: Contain holdings (positions table) and transactions (activity table). Extract both as separate CSVs. Holdings as_of_date = statement end date.
- **IBKR Activity Statements**: CSV with multiple sections (Trades, Dividends, Fees, Interest, etc.). Map each section to transaction types.
- **Vanguard ofxdownload.csv**: Direct export with combined holdings and transactions sections separated by blank lines.
- **Cost basis reports**: Usually holdings with cost_basis column. Map to Holdings CSV.
- **Monthly account summaries**: Map to Snapshots CSV. Starting/ending values, deposits/withdrawals, income.

### Full format specification

See `docs/canonical-csv-guide.md` for complete column descriptions, constraints, and examples.
