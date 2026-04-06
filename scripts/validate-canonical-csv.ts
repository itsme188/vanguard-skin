/**
 * Validate a canonical CSV file before importing into Vanguard Skin.
 *
 * Usage:
 *   npx tsx scripts/validate-canonical-csv.ts path/to/file.csv
 */

import fs from "fs";
import Papa from "papaparse";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const VALID_TRANSACTION_TYPES = new Set([
  "BUY", "SELL", "DIVIDEND", "REINVESTMENT", "INTEREST", "TAX_WITHHELD",
  "TRANSFER", "TRANSFER_IN", "TRANSFER_OUT", "DEPOSIT", "WITHDRAWAL",
  "FEE", "COMMISSION", "BUY_TO_OPEN", "SELL_TO_CLOSE", "SELL_TO_OPEN",
  "BUY_TO_CLOSE", "BUY_TO_COVER", "EXERCISED", "ASSIGNED", "EXPIRED",
  "REDEMPTION", "EXCHANGE", "CORPORATE_ACTION", "SPINOFF", "MERGER",
  "SPLIT", "RETURN_OF_CAPITAL", "SHORT_SELL",
]);

const VALID_SECURITY_TYPES = new Set([
  "Stock", "Bond", "ETF", "Option", "Mutual Fund",
]);

// ── Detect type from header ─────────────────────────────────────────

type CsvType = "transactions" | "holdings" | "prices" | "snapshots" | "unknown";

function detectType(firstLine: string): CsvType {
  if (firstLine.startsWith("account,trade_date,settlement_date,type,symbol")) return "transactions";
  if (firstLine.startsWith("account,as_of_date,symbol,security_name")) return "holdings";
  if (firstLine === "symbol,date,close_price") return "prices";
  if (firstLine.startsWith("account,month_end_date,total_value")) return "snapshots";
  return "unknown";
}

// ── Validators ──────────────────────────────────────────────────────

interface Issue {
  row: number;
  severity: "error" | "warning";
  message: string;
}

function validateDate(value: string, field: string, row: number): Issue | null {
  if (!DATE_REGEX.test(value)) {
    return { row, severity: "error", message: `${field}: invalid date format "${value}" (expected YYYY-MM-DD)` };
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return { row, severity: "error", message: `${field}: invalid calendar date "${value}"` };
  }
  return null;
}

function validateNumber(value: string, field: string, row: number): Issue | null {
  if (!value || value.trim() === "") return null; // optional
  if (isNaN(parseFloat(value))) {
    return { row, severity: "error", message: `${field}: not a valid number "${value}"` };
  }
  return null;
}

function validateTransactions(rows: Record<string, string>[]): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-indexed + header
    if (!row.account?.trim()) issues.push({ row: rowNum, severity: "error", message: "account: required field is empty" });
    if (!row.trade_date?.trim()) {
      issues.push({ row: rowNum, severity: "error", message: "trade_date: required field is empty" });
    } else {
      const dateIssue = validateDate(row.trade_date.trim(), "trade_date", rowNum);
      if (dateIssue) issues.push(dateIssue);
    }
    if (row.settlement_date?.trim()) {
      const dateIssue = validateDate(row.settlement_date.trim(), "settlement_date", rowNum);
      if (dateIssue) issues.push(dateIssue);
    }
    if (!row.symbol?.trim()) issues.push({ row: rowNum, severity: "error", message: "symbol: required field is empty" });
    const type = (row.type || "").toUpperCase().trim();
    if (!type) {
      issues.push({ row: rowNum, severity: "error", message: "type: required field is empty" });
    } else if (!VALID_TRANSACTION_TYPES.has(type)) {
      issues.push({ row: rowNum, severity: "warning", message: `type: unknown transaction type "${type}"` });
    } else if (row.type !== type) {
      issues.push({ row: rowNum, severity: "warning", message: `type: "${row.type}" should be uppercase "${type}"` });
    }
    if (row.security_type?.trim() && !VALID_SECURITY_TYPES.has(row.security_type.trim())) {
      issues.push({ row: rowNum, severity: "warning", message: `security_type: unknown type "${row.security_type.trim()}"` });
    }
    for (const field of ["quantity", "price", "amount", "fees"]) {
      const issue = validateNumber(row[field] || "", field, rowNum);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function validateHoldings(rows: Record<string, string>[]): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    if (!row.account?.trim()) issues.push({ row: rowNum, severity: "error", message: "account: required field is empty" });
    if (!row.as_of_date?.trim()) {
      issues.push({ row: rowNum, severity: "error", message: "as_of_date: required field is empty" });
    } else {
      const dateIssue = validateDate(row.as_of_date.trim(), "as_of_date", rowNum);
      if (dateIssue) issues.push(dateIssue);
    }
    if (!row.symbol?.trim()) issues.push({ row: rowNum, severity: "error", message: "symbol: required field is empty" });
    if (!row.quantity?.trim()) {
      issues.push({ row: rowNum, severity: "error", message: "quantity: required field is empty" });
    } else {
      const issue = validateNumber(row.quantity, "quantity", rowNum);
      if (issue) issues.push(issue);
    }
    for (const field of ["cost_basis", "market_value"]) {
      const issue = validateNumber(row[field] || "", field, rowNum);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function validatePrices(rows: Record<string, string>[]): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    if (!row.symbol?.trim()) issues.push({ row: rowNum, severity: "error", message: "symbol: required field is empty" });
    if (!row.date?.trim()) {
      issues.push({ row: rowNum, severity: "error", message: "date: required field is empty" });
    } else {
      const dateIssue = validateDate(row.date.trim(), "date", rowNum);
      if (dateIssue) issues.push(dateIssue);
    }
    if (!row.close_price?.trim()) {
      issues.push({ row: rowNum, severity: "error", message: "close_price: required field is empty" });
    } else {
      const issue = validateNumber(row.close_price, "close_price", rowNum);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function validateSnapshots(rows: Record<string, string>[]): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    if (!row.account?.trim()) issues.push({ row: rowNum, severity: "error", message: "account: required field is empty" });
    if (!row.month_end_date?.trim()) {
      issues.push({ row: rowNum, severity: "error", message: "month_end_date: required field is empty" });
    } else {
      const dateIssue = validateDate(row.month_end_date.trim(), "month_end_date", rowNum);
      if (dateIssue) issues.push(dateIssue);
    }
    if (!row.total_value?.trim()) {
      issues.push({ row: rowNum, severity: "error", message: "total_value: required field is empty" });
    } else {
      const issue = validateNumber(row.total_value, "total_value", rowNum);
      if (issue) issues.push(issue);
    }
    for (const field of ["starting_value", "deposits_withdrawals", "dividends", "interest", "commissions", "fees", "investment_gain", "twr"]) {
      const issue = validateNumber(row[field] || "", field, rowNum);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

// ── Main ────────────────────────────────────────────────────────────

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: npx tsx scripts/validate-canonical-csv.ts <path-to-csv>");
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const content = fs.readFileSync(filePath, "utf-8");
const firstLine = content.split("\n")[0]?.trim() ?? "";
const csvType = detectType(firstLine);

if (csvType === "unknown") {
  console.error("ERROR: Unrecognized CSV format. Header must match one of:");
  console.error("  Transactions: account,trade_date,settlement_date,type,symbol,...");
  console.error("  Holdings:     account,as_of_date,symbol,security_name,...");
  console.error("  Prices:       symbol,date,close_price");
  console.error("  Snapshots:    account,month_end_date,total_value,...");
  process.exit(1);
}

const parsed = Papa.parse<Record<string, string>>(content, {
  header: true,
  skipEmptyLines: true,
});

console.log(`\nFile: ${filePath}`);
console.log(`Type: ${csvType}`);
console.log(`Rows: ${parsed.data.length}`);

let issues: Issue[];
switch (csvType) {
  case "transactions": issues = validateTransactions(parsed.data); break;
  case "holdings": issues = validateHoldings(parsed.data); break;
  case "prices": issues = validatePrices(parsed.data); break;
  case "snapshots": issues = validateSnapshots(parsed.data); break;
}

const errors = issues.filter(i => i.severity === "error");
const warnings = issues.filter(i => i.severity === "warning");

if (errors.length === 0 && warnings.length === 0) {
  console.log("\n\x1b[32m✓ Valid — no issues found\x1b[0m\n");
  process.exit(0);
}

if (errors.length > 0) {
  console.log(`\n\x1b[31m✗ ${errors.length} error(s):\x1b[0m`);
  for (const e of errors.slice(0, 20)) {
    console.log(`  Row ${e.row}: ${e.message}`);
  }
  if (errors.length > 20) console.log(`  ...and ${errors.length - 20} more`);
}

if (warnings.length > 0) {
  console.log(`\n\x1b[33m⚠ ${warnings.length} warning(s):\x1b[0m`);
  for (const w of warnings.slice(0, 20)) {
    console.log(`  Row ${w.row}: ${w.message}`);
  }
  if (warnings.length > 20) console.log(`  ...and ${warnings.length - 20} more`);
}

console.log("");
process.exit(errors.length > 0 ? 1 : 0);
