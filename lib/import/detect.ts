import type { SourceType } from "./types";

export function detectSourceType(content: string, filename: string): SourceType {
  // PDF detection by magic bytes
  if (content.startsWith("%PDF")) {
    return "vanguard-pdf";
  }

  const lines = content.split("\n").slice(0, 5).map((l) => l.trim());
  const firstLine = lines[0] ?? "";

  // IBKR activity: starts with "Statement,Header,Field Name,Field Value"
  // Some newer IBKR exports have an account ID line before the header
  if (lines.some((l) => l.startsWith("Statement,Header,Field Name,Field Value"))) {
    return "ibkr-activity";
  }

  // IBKR holdings: header is "account,symbol,name,type,quantity,price,cost_basis,balance"
  if (firstLine.startsWith("account,symbol,name,type,quantity,price,cost_basis,balance")) {
    return "ibkr-holdings";
  }

  // Vanguard cost basis: header contains "cost_basis_method"
  if (firstLine.includes("cost_basis_method")) {
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

  return "unknown";
}
