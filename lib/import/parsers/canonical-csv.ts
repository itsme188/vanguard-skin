import Papa from "papaparse";
import type {
  ParsedImportResult,
  ParsedTransaction,
  ParsedHolding,
  ParsedPrice,
  ParsedSnapshot,
  ParsedSecurity,
} from "../types";
import { resolveDescriptionToSymbol } from "../resolve-description";

type CanonicalType = "transactions" | "holdings" | "prices" | "snapshots";

// Reject comma-bearing numerics. The native parseFloat silently truncates them
// (parseFloat with "1,234.56" returns 1), which would corrupt comma-grouped
// amounts from a Co-Work session. Returning NaN here lets the existing isNaN()
// guards + validate.ts skip-with-warning behavior take over.
function parseStrictNumber(s: string | undefined): number {
  if (!s) return NaN;
  const trimmed = s.trim();
  if (!trimmed) return NaN;
  if (trimmed.includes(",")) return NaN;
  return parseFloat(trimmed);
}

function detectCanonicalType(firstLine: string): CanonicalType {
  if (firstLine.startsWith("account,trade_date,settlement_date,type,symbol"))
    return "transactions";
  if (firstLine.startsWith("account,as_of_date,symbol,security_name"))
    return "holdings";
  if (firstLine === "symbol,date,close_price") return "prices";
  if (firstLine.startsWith("account,month_end_date,total_value"))
    return "snapshots";
  throw new Error("Not a canonical CSV format");
}

// Strip leading `#` comment lines and blank lines so Co-Work output that prefixes
// each CSV with a filename comment (e.g. `# transactions.csv`) still parses.
function stripLeadingComments(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("#")) i++;
    else break;
  }
  return i === 0 ? content : lines.slice(i).join("\n");
}

// Round to integer cents to dodge float-formatting differences between JS and SQLite.
// Used in source_key so two same-day same-symbol same-type fills with different amounts
// don't collide (e.g., 400 RSP @ $78,466.98 + 100 RSP @ $19,664.09 on the same day).
function amountCents(amt: string | undefined): string {
  const n = parseStrictNumber(amt);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 100));
}

export function parseCanonicalCsv(
  content: string,
  filename: string
): ParsedImportResult {
  const stripped = stripLeadingComments(content);
  const firstLine = stripped.split("\n")[0]?.trim() ?? "";
  const csvType = detectCanonicalType(firstLine);

  const parsed = Papa.parse<Record<string, string>>(stripped, {
    header: true,
    skipEmptyLines: true,
  });

  const errors: string[] = [];
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  const holdings: ParsedHolding[] = [];
  const prices: ParsedPrice[] = [];
  const snapshots: ParsedSnapshot[] = [];
  const securitiesMap = new Map<string, ParsedSecurity>();

  for (const err of parsed.errors) {
    errors.push(`CSV parse error at row ${err.row}: ${err.message}`);
  }

  for (const row of parsed.data) {
    switch (csvType) {
      case "transactions": {
        let symbol = row.symbol?.trim();
        if (!symbol && row.security_name?.trim()) {
          const resolved = resolveDescriptionToSymbol(row.security_name.trim());
          if (resolved) {
            symbol = resolved.symbol;
            if (!securitiesMap.has(symbol)) {
              securitiesMap.set(symbol, {
                symbol,
                name: row.security_name.trim(),
                securityType: resolved.securityType,
                underlyingSymbol: resolved.underlyingSymbol,
                strikePrice: resolved.strikePrice,
                expirationDate: resolved.expirationDate,
                optionType: resolved.optionType,
                multiplier: resolved.multiplier,
              });
            }
          } else {
            warnings.push(
              `Skipped transaction: blank symbol, couldn't resolve from "${row.security_name.trim()}"`
            );
            continue;
          }
        }
        if (!symbol || !row.trade_date) continue;
        // Canonical convention: quantity is always positive, type carries direction
        // (BUY adds, SELL/SELL_TO_CLOSE/EXERCISED/etc. removes). If a Co-Work session
        // emits negative quantity, normalize to abs and warn so the user sees it.
        const rawQty = row.quantity ? parseStrictNumber(row.quantity) : undefined;
        let normalizedQty = rawQty;
        if (rawQty != null && Number.isFinite(rawQty) && rawQty < 0) {
          normalizedQty = Math.abs(rawQty);
          warnings.push(
            `Transaction ${symbol} ${row.trade_date.trim()} ${row.type}: negative quantity ${rawQty} normalized to ${normalizedQty} (canonical convention: type carries direction)`
          );
        }
        transactions.push({
          accountName: row.account?.trim() || "Unknown",
          tradeDate: row.trade_date.trim(),
          settlementDate: row.settlement_date?.trim() || undefined,
          type: (row.type || "").toUpperCase().trim(),
          symbol,
          securityName: row.security_name?.trim() || undefined,
          quantity: normalizedQty,
          pricePerShare: row.price ? parseStrictNumber(row.price) : undefined,
          amount: row.amount ? parseStrictNumber(row.amount) : undefined,
          fees: row.fees ? parseStrictNumber(row.fees) : undefined,
          notes: row.notes?.trim() || undefined,
          // Source key includes integer-cents amount so split fills (same day, same
          // symbol, same type, different amounts) don't collide.
          sourceKey: `canonical:txn:${row.account?.trim()}:${symbol}:${row.trade_date.trim()}:${(row.type || "").trim()}:${amountCents(row.amount)}`,
        });
        if (!securitiesMap.has(symbol)) {
          securitiesMap.set(symbol, {
            symbol,
            name: row.security_name?.trim(),
            securityType: row.security_type?.trim() || undefined,
          });
        }
        break;
      }

      case "holdings": {
        let symbol = row.symbol?.trim();
        if (!symbol && row.security_name?.trim()) {
          const resolved = resolveDescriptionToSymbol(row.security_name.trim());
          if (resolved) {
            symbol = resolved.symbol;
            if (!securitiesMap.has(symbol)) {
              securitiesMap.set(symbol, {
                symbol,
                name: row.security_name.trim(),
                securityType: resolved.securityType,
                underlyingSymbol: resolved.underlyingSymbol,
                strikePrice: resolved.strikePrice,
                expirationDate: resolved.expirationDate,
                optionType: resolved.optionType,
                multiplier: resolved.multiplier,
              });
            }
          } else {
            warnings.push(
              `Skipped holding: blank symbol, couldn't resolve from "${row.security_name.trim()}"`
            );
            continue;
          }
        }
        if (!symbol || !row.as_of_date) continue;
        const quantity = parseStrictNumber(row.quantity);
        if (isNaN(quantity)) continue;
        holdings.push({
          accountName: row.account?.trim() || "Unknown",
          symbol,
          securityName: row.security_name?.trim() || undefined,
          quantity,
          costBasis: row.cost_basis ? parseStrictNumber(row.cost_basis) : undefined,
          marketValue: row.market_value
            ? parseStrictNumber(row.market_value)
            : undefined,
          asOfDate: row.as_of_date.trim(),
          sourceKey: `canonical:hold:${row.account?.trim()}:${symbol}:${row.as_of_date.trim()}`,
        });
        if (!securitiesMap.has(symbol)) {
          securitiesMap.set(symbol, {
            symbol,
            name: row.security_name?.trim(),
            securityType: row.security_type?.trim() || undefined,
          });
        }
        break;
      }

      case "prices": {
        const symbol = row.symbol?.trim();
        if (!symbol || !row.date || !row.close_price) continue;
        const closePrice = parseStrictNumber(row.close_price);
        if (isNaN(closePrice)) continue;
        prices.push({
          symbol,
          date: row.date.trim(),
          closePrice,
          source: "canonical",
        });
        if (!securitiesMap.has(symbol)) {
          securitiesMap.set(symbol, { symbol });
        }
        break;
      }

      case "snapshots": {
        if (!row.account || !row.month_end_date || !row.total_value) continue;
        const totalValue = parseStrictNumber(row.total_value);
        if (isNaN(totalValue)) continue;
        snapshots.push({
          accountName: row.account.trim(),
          monthEndDate: row.month_end_date.trim(),
          totalValue,
          source: "canonical",
          startingValue: row.starting_value
            ? parseStrictNumber(row.starting_value)
            : undefined,
          depositsWithdrawals: row.deposits_withdrawals
            ? parseStrictNumber(row.deposits_withdrawals)
            : undefined,
          dividends: row.dividends ? parseStrictNumber(row.dividends) : undefined,
          interest: row.interest ? parseStrictNumber(row.interest) : undefined,
          commissions: row.commissions
            ? parseStrictNumber(row.commissions)
            : undefined,
          fees: row.fees ? parseStrictNumber(row.fees) : undefined,
          investmentGain: row.investment_gain
            ? parseStrictNumber(row.investment_gain)
            : undefined,
          twr: row.twr ? parseStrictNumber(row.twr) : undefined,
        });
        break;
      }
    }
  }

  return {
    sourceType: "canonical-csv",
    sourceName: filename,
    transactions,
    securities: Array.from(securitiesMap.values()),
    holdings,
    prices,
    snapshots,
    errors,
    warnings,
  };
}
