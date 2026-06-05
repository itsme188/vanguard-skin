"use client";

import { useState } from "react";

// ── Format definitions ──────────────────────────────────────────────

interface FormatSpec {
  key: string;
  label: string;
  header: string;
  columns: { name: string; required: boolean; description: string }[];
  constraints: string[];
  example: string;
}

const FORMATS: FormatSpec[] = [
  {
    key: "transactions",
    label: "Transactions",
    header:
      "account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes",
    columns: [
      { name: "account", required: true, description: "Account name (e.g., 'Vanguard Taxable', 'IBKR')" },
      { name: "trade_date", required: true, description: "Trade date (YYYY-MM-DD)" },
      { name: "settlement_date", required: false, description: "Settlement date (YYYY-MM-DD)" },
      { name: "type", required: true, description: "Transaction type, UPPERCASE — carries direction (BUY adds, SELL removes)" },
      { name: "symbol", required: true, description: "Ticker symbol (OCC format for options; use 'CASH' for WITHDRAWAL/DEPOSIT/FEE/COMMISSION/INTEREST rows that have no security)" },
      { name: "security_name", required: false, description: "Full security name" },
      { name: "security_type", required: false, description: "Stock, Bond, ETF, Option, Mutual Fund" },
      { name: "quantity", required: false, description: "Number of shares/units — ALWAYS POSITIVE (the type field carries direction)" },
      { name: "price", required: false, description: "Price per share" },
      { name: "amount", required: false, description: "Total dollar amount (signed — see TRANSFER + cash-flow rules below)" },
      { name: "fees", required: false, description: "Fees/commissions" },
      { name: "notes", required: false, description: "Free-text notes" },
    ],
    constraints: [
      "Transaction types (UPPERCASE): BUY, SELL, DIVIDEND, REINVESTMENT, INTEREST, TAX_WITHHELD, TRANSFER, TRANSFER_IN, TRANSFER_OUT, DEPOSIT, WITHDRAWAL, FEE, COMMISSION, BUY_TO_OPEN, SELL_TO_CLOSE, SELL_TO_OPEN, BUY_TO_CLOSE, BUY_TO_COVER, EXERCISED, ASSIGNED, EXPIRED, REDEMPTION, CORPORATE_ACTION, SPINOFF, MERGER, SPLIT",
      "QUANTITY IS ALWAYS POSITIVE. The type field (BUY/SELL/SELL_TO_CLOSE/EXERCISED/REDEMPTION/etc.) carries direction. Never emit a negative quantity. Sold 100 RSP → quantity=100, type=SELL.",
      "Account names must match the dashboard exactly. Use these mappings: 'Individual brokerage account' or 'Vanguard Individual Brokerage' → 'Vanguard Taxable'. 'Vanguard Roth IRA' is verbatim. 'IBKR' is verbatim.",
      "Cash-only rows (WITHDRAWAL, DEPOSIT, FEE, COMMISSION, INTEREST without a security) MUST use symbol 'CASH'. Blank symbol will be silently dropped.",
      "For DIVIDEND / INTEREST / TAX_WITHHELD income rows: leave `quantity` and `price` empty, put the income amount in the `amount` column (never in `fees`)",
      "For REINVESTMENT rows: populate both `quantity` + `price` (shares received at the reinvestment price) AND `amount` (total value reinvested)",
      "For TRANSFER rows (VMFXX money-market sweeps): `amount` is SIGNED. 'Sweep Into Settlement Fund' is positive (cash going in), 'Sweep Out Of Settlement Fund' is negative (cash coming out). Never leave all TRANSFER amounts positive — the sign tracks direction.",
      "For gifted or JOURNALED SHARES (shares moved between accounts/sub-accounts, not cash): use TRANSFER_IN (shares received) or TRANSFER_OUT (shares given/moved out). Put the share count in `quantity`, leave `price` empty, and set `amount` to 0 (no cash changes hands). Emit ONE row per journal line exactly as the statement lists them — multiple same-day, same-symbol transfers are expected and fine; do NOT merge or drop them.",
      "Options must use OCC format: AAPL  260320C00150000 (symbol padded to 6 chars, YYMMDD, C/P, strike x1000 padded to 8 digits)",
      "Symbol conventions (consistency across statements is critical — each variant creates a duplicate security row): for bonds incl. US Treasuries, use the 9-character CUSIP as the symbol (e.g., `912810SA7`, never the descriptive name like `U S TREASURY BOND 3 2/15/48`); for dual-class equities, use the SLASH form (e.g., `BRK/B`, `LBRD/A`, `LSXM/K`), never `BRK B`, `BRK.B`, or `BRKB`.",
      "Numbers: NO comma thousands separators (1234.56 ✓, 1,234.56 ✗). NO currency symbols ($, %, etc). Use `.` for decimals only. Negative numbers use a leading minus sign (-250.00). Commas inside numeric cells will silently truncate or skip the row.",
      "All dates: YYYY-MM-DD format",
      "Output the CSV directly with the header row first — do NOT prefix with comment lines like `# transactions.csv` or markdown fences. The file must start with the header row.",
    ],
    example:
      "Vanguard Taxable,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,1502.50,0,\nVanguard Taxable,2025-06-22,,SELL,AAPL,Apple Inc,Stock,10,155.50,1554.95,0.05,Closed position\nVanguard Taxable,2025-06-22,,SELL,AAPL,Apple Inc,Stock,5,156.10,780.45,0.05,Second fill same day\nVanguard Taxable,2025-06-20,,DIVIDEND,AAPL,Apple Inc,Stock,,,25.00,,Q2 dividend\nVanguard Taxable,2025-06-30,,INTEREST,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,12.45,,\nVanguard Taxable,2025-06-20,,REINVESTMENT,VTI,Vanguard Total Stock Market ETF,ETF,0.098,255.10,25.00,,Reinvested Q2 dividend\nVanguard Taxable,2025-07-15,,TAX_WITHHELD,VXUS,Vanguard Total International Stock ETF,ETF,,,-3.50,,Foreign withholding\nVanguard Taxable,2025-06-10,,TRANSFER,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,1000.00,,Sweep Into Settlement Fund\nVanguard Taxable,2025-06-12,,TRANSFER,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,-250.00,,Sweep Out Of Settlement Fund\nVanguard Taxable,2025-07-05,,WITHDRAWAL,CASH,,,,,-5000.00,,Wire transfer to checking\nVanguard Taxable,2025-07-08,,FEE,CASH,,,,,-3.50,,Margin interest\nVanguard Taxable,2025-07-10,,TRANSFER_IN,XMTR,Xometry Inc Cl A,Stock,100,,0,,Shares journaled in\nVanguard Taxable,2025-07-10,,TRANSFER_OUT,XMTR,Xometry Inc Cl A,Stock,100,,0,,Gifted shares (journal out, amount 0)",
  },
  {
    key: "holdings",
    label: "Holdings",
    header:
      "account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value",
    columns: [
      { name: "account", required: true, description: "Account name" },
      { name: "as_of_date", required: true, description: "Snapshot date (YYYY-MM-DD)" },
      { name: "symbol", required: true, description: "Ticker symbol" },
      { name: "security_name", required: false, description: "Full security name" },
      { name: "security_type", required: false, description: "Stock, Bond, ETF, Option, Mutual Fund" },
      { name: "quantity", required: true, description: "Number of shares/units" },
      { name: "cost_basis", required: false, description: "Total cost basis ($)" },
      { name: "market_value", required: false, description: "Current market value ($)" },
    ],
    constraints: [
      "One row per (account, symbol) per as_of_date",
      "Options must use OCC format for the symbol",
      "Symbol conventions (consistency across statements is critical — each variant creates a duplicate security row): for bonds incl. US Treasuries, use the 9-character CUSIP as the symbol (e.g., `912810SA7`, never the descriptive name); for dual-class equities, use the SLASH form (e.g., `BRK/B`, `LBRD/A`), never `BRK B`, `BRK.B`, or `BRKB`.",
      "Account names must match the dashboard exactly: 'Individual brokerage account' → 'Vanguard Taxable', 'Vanguard Roth IRA' verbatim, 'IBKR' verbatim",
      "Numbers: no commas, no currency symbols, decimals only with `.`. Quantity is the number of shares held (always positive).",
      "Output the CSV directly — do NOT prefix with `# filename.csv` comment lines or markdown fences.",
    ],
    example:
      "Vanguard Taxable,2025-06-30,AAPL,Apple Inc,Stock,100,15025.00,19500.00\nVanguard Taxable,2025-06-30,VTI,Vanguard Total Stock Market ETF,ETF,50,11250.00,12100.00",
  },
  {
    key: "prices",
    label: "Prices",
    header: "symbol,date,close_price",
    columns: [
      { name: "symbol", required: true, description: "Ticker symbol" },
      { name: "date", required: true, description: "Price date (YYYY-MM-DD)" },
      { name: "close_price", required: true, description: "Closing price ($)" },
    ],
    constraints: [
      "One row per (symbol, date)",
      "Used for daily valuations — TWS live prices take priority over these",
    ],
    example: "AAPL,2025-06-30,195.00\nVTI,2025-06-30,242.00",
  },
  {
    key: "snapshots",
    label: "Monthly Snapshots",
    header:
      "account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr",
    columns: [
      { name: "account", required: true, description: "Account name" },
      { name: "month_end_date", required: true, description: "Last day of month (YYYY-MM-DD)" },
      { name: "total_value", required: true, description: "End-of-month portfolio value ($)" },
      { name: "starting_value", required: false, description: "Start-of-month value ($)" },
      { name: "deposits_withdrawals", required: false, description: "Net cash flows ($)" },
      { name: "dividends", required: false, description: "Dividend income ($)" },
      { name: "interest", required: false, description: "Interest income ($)" },
      { name: "commissions", required: false, description: "Commissions paid ($)" },
      { name: "fees", required: false, description: "Fees paid ($)" },
      { name: "investment_gain", required: false, description: "Investment gain/loss ($)" },
      { name: "twr", required: false, description: "Time-weighted return (decimal, e.g., 0.05 = 5%)" },
    ],
    constraints: [
      "One row per (account, month_end_date)",
      "month_end_date should be the last calendar day of the month",
    ],
    example:
      "Vanguard Taxable,2025-06-30,250000,245000,2000,150,25,-15,-10,2850,0.0116",
  },
];

// ── Prompt builder ──────────────────────────────────────────────────

function buildPromptBlock(spec: FormatSpec): string {
  const requiredCols = spec.columns
    .filter((c) => c.required)
    .map((c) => c.name);
  const optionalCols = spec.columns
    .filter((c) => !c.required)
    .map((c) => c.name);

  return `Convert the attached data into this CSV format for the Portfolio Desk dashboard.

CSV Type: ${spec.label}
Header: ${spec.header}

Required columns: ${requiredCols.join(", ")}
Optional columns: ${optionalCols.join(", ")}

Column descriptions:
${spec.columns.map((c) => `- ${c.name}: ${c.description}`).join("\n")}

Rules:
- All dates must be YYYY-MM-DD format
${spec.constraints.map((c) => `- ${c}`).join("\n")}

Example rows:
${spec.header}
${spec.example}

Output ONLY the CSV (header + data rows). No markdown, no explanation.`;
}

function buildAllFormatsPrompt(): string {
  return `Convert the attached financial data into standardized CSV files for the Portfolio Desk dashboard.
Produce separate CSV files for each data type found. Save each as a separate file (do not merge).
DO NOT prefix any file with a comment line like \`# transactions.csv\` — the file must start with the header row directly.

${FORMATS.map(
  (spec) => `--- ${spec.label.toUpperCase()} ---
Header: ${spec.header}
Columns: ${spec.columns.map((c) => `${c.name}${c.required ? " (required)" : ""}: ${c.description}`).join(" | ")}
Rules: ${spec.constraints.join(". ")}
Example:
${spec.header}
${spec.example}`
).join("\n\n")}

General rules:
- All dates: YYYY-MM-DD
- Transaction types must be UPPERCASE (BUY, SELL, DIVIDEND, REINVESTMENT, etc.)
- Quantity is ALWAYS POSITIVE — the type field carries direction (BUY adds, SELL/SELL_TO_CLOSE/EXERCISED/REDEMPTION removes). Never emit a negative quantity.
- Account names must match the dashboard exactly. Aliases: 'Individual brokerage account' / 'Vanguard Individual Brokerage' → 'Vanguard Taxable'. 'Vanguard Roth IRA' verbatim. 'IBKR' verbatim.
- Cash-only transaction rows (WITHDRAWAL, DEPOSIT, FEE, COMMISSION, INTEREST without a security) MUST use symbol 'CASH'. Blank symbol drops the row.
- Security types: Stock, Bond, ETF, Option, Mutual Fund
- Options: use OCC format (e.g., AAPL  260320C00150000)
- Symbol conventions (consistency across statements is critical — each variant creates a duplicate security row): for bonds incl. US Treasuries, use the 9-character CUSIP as the symbol (e.g., \`912810SA7\`, never the descriptive name like \`U S TREASURY BOND 3 2/15/48\`); for dual-class equities, use the SLASH form (e.g., \`BRK/B\`, \`LBRD/A\`, \`LSXM/K\`), never \`BRK B\`, \`BRK.B\`, or \`BRKB\`.
- Numbers: NO comma thousands separators (1234.56 ✓, 1,234.56 ✗), NO currency symbols, use \`.\` for decimals only. Negative numbers use a leading minus sign.
- Output ONLY the CSV files (header + data rows). NO markdown fences, NO comment lines, NO explanation prose.`;
}

// ── Component ───────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-HTTPS
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-raised border border-edge hover:bg-muted hover:border-edge-strong transition-colors"
      title={`Copy ${label} prompt to clipboard`}
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5 text-up" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          <span className="text-up">Copied!</span>
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5 text-ink-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
          </svg>
          <span className="text-ink-dim">Copy {label}</span>
        </>
      )}
    </button>
  );
}

function FormatSection({ spec }: { spec: FormatSpec }) {
  return (
    <details className="group rounded-lg border border-edge bg-canvas">
      <summary className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-raised/50 transition-colors">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-ink">{spec.label}</span>
          <span className="text-xs text-ink-faint font-mono">
            {spec.columns.length} columns
          </span>
        </div>
        <svg
          className="w-4 h-4 text-ink-faint transition-transform group-open:rotate-90"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </summary>

      <div className="px-4 pb-4 space-y-3 border-t border-edge">
        {/* Header row */}
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-ink-dim uppercase tracking-wide">
              Header
            </span>
            <CopyButton text={buildPromptBlock(spec)} label="prompt" />
          </div>
          <code className="block text-xs font-mono text-gold bg-raised rounded-md px-3 py-2 overflow-x-auto">
            {spec.header}
          </code>
        </div>

        {/* Column table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-faint text-left">
                <th className="py-1 pr-3 font-medium">Column</th>
                <th className="py-1 pr-3 font-medium">Req</th>
                <th className="py-1 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {spec.columns.map((col) => (
                <tr key={col.name} className="border-t border-edge/50">
                  <td className="py-1.5 pr-3 font-mono text-ink">{col.name}</td>
                  <td className="py-1.5 pr-3">
                    {col.required ? (
                      <span className="text-gold">yes</span>
                    ) : (
                      <span className="text-ink-faint">no</span>
                    )}
                  </td>
                  <td className="py-1.5 text-ink-dim">{col.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Constraints */}
        {spec.constraints.length > 0 && (
          <div>
            <span className="text-xs font-medium text-ink-dim uppercase tracking-wide">
              Rules
            </span>
            <ul className="mt-1 space-y-0.5">
              {spec.constraints.map((c, i) => (
                <li key={i} className="text-xs text-ink-dim">
                  <span className="text-ink-faint mr-1">-</span> {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Example */}
        <div>
          <span className="text-xs font-medium text-ink-dim uppercase tracking-wide">
            Example
          </span>
          <pre className="mt-1 text-xs font-mono text-ink-dim bg-raised rounded-md px-3 py-2 overflow-x-auto whitespace-pre">
{spec.header}
{spec.example}
          </pre>
        </div>
      </div>
    </details>
  );
}

export function CanonicalCsvGuide() {
  return (
    <details className="group rounded-xl border border-edge bg-panel">
      <summary className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-raised/30 transition-colors">
        <div className="flex items-center gap-3">
          <svg
            className="w-5 h-5 text-gold"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
            />
          </svg>
          <div>
            <span className="text-sm font-medium text-ink">
              CSV Format Guide
            </span>
            <span className="ml-2 text-xs text-ink-faint">
              Copy format instructions for Claude Code
            </span>
          </div>
        </div>
        <svg
          className="w-4 h-4 text-ink-faint transition-transform group-open:rotate-90"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </summary>

      <div className="px-5 pb-5 space-y-3 border-t border-edge">
        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-ink-dim">
            Use these formats to preprocess raw brokerage data in Claude Code before importing.
          </p>
          <CopyButton text={buildAllFormatsPrompt()} label="all formats" />
        </div>

        {FORMATS.map((spec) => (
          <FormatSection key={spec.key} spec={spec} />
        ))}
      </div>
    </details>
  );
}
