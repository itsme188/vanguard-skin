import type { SourceType } from "./types";

export function detectSourceType(content: string, filename: string): SourceType {
  // PDF detection by magic bytes
  if (content.startsWith("%PDF")) {
    return "vanguard-pdf";
  }

  const lines = content.split("\n").slice(0, 10).map((l) => l.trim());
  const firstLine = lines[0] ?? "";
  // First non-comment, non-blank line — used for canonical-csv detection so that
  // Co-Work output preceded by `# filename.csv` headers still gets routed correctly.
  const firstContentLine =
    lines.find((l) => l !== "" && !l.startsWith("#")) ?? "";

  // IBKR activity: starts with "Statement,Header,Field Name,Field Value"
  // Some newer IBKR exports have an account ID line before the header
  if (lines.some((l) => l.startsWith("Statement,Header,Field Name,Field Value"))) {
    return "ibkr-activity";
  }

  // IBKR holdings: header is "account,symbol,name,type,quantity,price,cost_basis,balance"
  if (firstLine.startsWith("account,symbol,name,type,quantity,price,cost_basis,balance")) {
    return "ibkr-holdings";
  }

  // Vanguard direct-export: combined holdings + transactions CSV
  // Header: "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value"
  if (firstLine.startsWith("Account Number,Investment Name,Symbol,Shares,Share Price,Total Value")) {
    return "vanguard-export";
  }

  // Vanguard cost basis: old format has "cost_basis_method" in header;
  // new direct-export format has "Account,Symbol/CUSIP,Description,Position type" (may have preamble lines)
  if (firstLine.includes("cost_basis_method")) {
    return "vanguard-cost-basis";
  }
  if (lines.some((l) => l.startsWith("Account,Symbol/CUSIP,Description,Position type"))) {
    return "vanguard-cost-basis";
  }

  // Vanguard holdings: header is "symbol,name,type,price,quantity,value"
  if (firstLine === "symbol,name,type,price,quantity,value") {
    return "vanguard-holdings";
  }

  // Monthly values: header starts with "date,month,year"
  if (firstLine.startsWith("date,month,year")) {
    return "monthly-values";
  }

  // Factor CSV: header contains factor column names
  if (
    firstLine.includes("interest_rate_sensitive") ||
    firstLine.includes("tariff_exposure") ||
    firstLine.includes("ai_exposure")
  ) {
    return "factor-csv";
  }

  // Canonical CSV: 4 standardized formats produced by Claude Code preprocessing.
  // Tolerate leading `# filename.csv` comment lines (Co-Work emits these to label
  // multi-CSV chat responses) by checking against firstContentLine.
  if (firstContentLine.startsWith("account,trade_date,settlement_date,type,symbol")) {
    return "canonical-csv";
  }
  if (firstContentLine.startsWith("account,as_of_date,symbol,security_name")) {
    return "canonical-csv";
  }
  if (firstContentLine === "symbol,date,close_price") {
    return "canonical-csv";
  }
  if (firstContentLine.startsWith("account,month_end_date,total_value")) {
    return "canonical-csv";
  }

  return "unknown";
}
