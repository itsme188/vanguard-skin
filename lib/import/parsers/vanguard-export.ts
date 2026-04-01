import Papa from "papaparse";
import type {
  ParsedImportResult,
  ParsedHolding,
  ParsedTransaction,
  ParsedSecurity,
  ParsedPrice,
} from "../types";

// Vanguard direct-export CSV: combined holdings + transactions in one file.
// Section 1 (holdings): Account Number, Investment Name, Symbol, Shares, Share Price, Total Value
// Blank rows separate the sections.
// Section 2 (transactions): Account Number, Trade Date, Settlement Date, Transaction Type, ...

// Map Vanguard account numbers to our account names
const ACCOUNT_NUMBER_MAP: Record<string, string> = {
  "76501494": "Vanguard Taxable",
  "34133612": "Vanguard Roth IRA",
};

// Map Vanguard transaction types to our uppercase types
// Map Vanguard transaction types to our uppercase types.
// Sweep in/out are money market cash movements — skip them.
// Transfer (incoming)/(Outgoing) are internal settlement transfers — skip them.
const TXN_TYPE_MAP: Record<string, string | null> = {
  "Dividend": "DIVIDEND",
  "Reinvestment": "REINVESTMENT",
  "Buy": "BUY",
  "Sell": "SELL",
  "Buy to open": "BUY_TO_OPEN",
  "Sell to close": "SELL_TO_CLOSE",
  "Sell short": "SELL",
  "Buy to cover": "BUY",
  "Transfer (in)": "TRANSFER_IN",
  "Transfer (out)": "TRANSFER_OUT",
  "Transfer (incoming)": null, // internal settlement — skip
  "Transfer (Outgoing)": null, // internal settlement — skip
  "Sweep in": null,  // money market sweep — skip
  "Sweep out": null, // money market sweep — skip
  "Fee": "FEE",
  "Withholding": "TAX_WITHHELD",
  "Interest": "INTEREST",
  "Income": "DIVIDEND", // partnership/fund income distributions
  "Partnership": "DIVIDEND", // partnership distributions
  "Expired": "EXPIRED",
  "Exercised": "EXERCISED",
  "Assigned": "ASSIGNED",
};

function isOptionSymbol(symbol: string): boolean {
  // OCC-ish format: "ARKK 270115 P 100.00" or standard tickers with spaces + dates
  return /\d{6}\s+[CP]\s+\d/.test(symbol);
}

function deriveSecurityType(name: string, symbol: string): string {
  if (symbol === "null" || !symbol) return "Other";
  if (isOptionSymbol(symbol)) return "Option";
  if (name.includes("TREASURY") || name.includes("BOND")) return "Bond";
  if (name.includes("ETF") || name.includes("SPDR")) return "ETF";
  if (name.includes("MONEY MARKET") || symbol === "VMFXX") return "Money Market";
  if (name.includes("VANGUARD") && (name.includes("INDEX") || name.includes("INVESTOR") || name.includes("ADMIRAL")))
    return "Mutual Fund";
  return "Stock";
}

function parseOptionMetadata(symbol: string): Partial<ParsedSecurity> | null {
  // Parse OCC-ish format like "ARKK 270115 P 100.00"
  const match = symbol.match(/^(\w+)\s+(\d{6})\s+([CP])\s+([\d.]+)$/);
  if (!match) return null;

  const [, underlying, dateStr, optType, strike] = match;
  const year = 2000 + parseInt(dateStr.slice(0, 2));
  const month = dateStr.slice(2, 4);
  const day = dateStr.slice(4, 6);

  return {
    underlyingSymbol: underlying,
    optionType: optType === "C" ? "CALL" : "PUT",
    strikePrice: parseFloat(strike),
    expirationDate: `${year}-${month}-${day}`,
    multiplier: 100,
  };
}

export function parseVanguardExport(
  content: string,
  filename: string
): ParsedImportResult {
  const holdings: ParsedHolding[] = [];
  const transactions: ParsedTransaction[] = [];
  const securitiesMap = new Map<string, ParsedSecurity>();
  const pricesMap = new Map<string, ParsedPrice>();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Split file into sections separated by blank rows
  const lines = content.split("\n");
  let holdingsLines: string[] = [];
  let transactionLines: string[] = [];
  let inTransactions = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect transaction section header
    if (line.startsWith("Account Number,Trade Date,Settlement Date")) {
      inTransactions = true;
      transactionLines.push(line); // This is the header
      continue;
    }

    if (!inTransactions) {
      if (line && !line.startsWith(",")) {
        holdingsLines.push(line);
      }
    } else {
      if (line && !line.startsWith(",")) {
        transactionLines.push(line);
      }
    }
  }

  // Parse holdings section
  const today = new Date().toISOString().slice(0, 10);
  const holdingsCsv = "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value\n" + holdingsLines.join("\n");
  const parsedHoldings = Papa.parse<Record<string, string>>(holdingsCsv, {
    header: true,
    skipEmptyLines: true,
  });

  for (const row of parsedHoldings.data) {
    const acctNum = row["Account Number"]?.trim();
    const name = row["Investment Name"]?.trim();
    const symbol = row["Symbol"]?.trim();
    const shares = parseFloat(row["Shares"]);
    const price = parseFloat(row["Share Price"]);
    const value = parseFloat(row["Total Value"]);

    if (!acctNum || isNaN(shares)) continue;

    const accountName = ACCOUNT_NUMBER_MAP[acctNum] || `Vanguard ${acctNum}`;
    const effectiveSymbol = (!symbol || symbol === "null") ? `CUSIP:${name?.slice(0, 20)}` : symbol;

    holdings.push({
      accountName,
      symbol: effectiveSymbol,
      securityName: name,
      quantity: shares,
      marketValue: isNaN(value) ? undefined : value,
      asOfDate: today,
      sourceKey: `vanguard-export:holding:${accountName}:${effectiveSymbol}:${today}`,
    });

    const secType = deriveSecurityType(name || "", effectiveSymbol);
    const secData: ParsedSecurity = {
      symbol: effectiveSymbol,
      name: name,
      securityType: secType,
    };

    // Add option metadata if applicable
    if (secType === "Option") {
      const optMeta = parseOptionMetadata(effectiveSymbol);
      if (optMeta) Object.assign(secData, optMeta);
    }

    securitiesMap.set(effectiveSymbol, secData);

    if (!isNaN(price) && price > 0) {
      pricesMap.set(effectiveSymbol, {
        symbol: effectiveSymbol,
        date: today,
        closePrice: price,
        source: "vanguard-export",
      });
    }
  }

  // Parse transactions section
  if (transactionLines.length > 1) {
    const txnCsv = transactionLines.join("\n");
    const parsedTxns = Papa.parse<Record<string, string>>(txnCsv, {
      header: true,
      skipEmptyLines: true,
    });

    for (const row of parsedTxns.data) {
      const acctNum = row["Account Number"]?.trim();
      const tradeDate = row["Trade Date"]?.trim();
      const settlementDate = row["Settlement Date"]?.trim();
      const txnType = row["Transaction Type"]?.trim();
      const name = row["Investment Name"]?.trim();
      const symbol = row["Symbol"]?.trim();
      const shares = parseFloat(row["Shares"]);
      const price = parseFloat(row["Share Price"]);
      const principal = parseFloat(row["Principal Amount"]);
      const fees = parseFloat(row["Commissions and Fees"]);
      const netAmount = parseFloat(row["Net Amount"]);

      if (!acctNum || !tradeDate || !txnType) continue;

      const accountName = ACCOUNT_NUMBER_MAP[acctNum] || `Vanguard ${acctNum}`;
      const mappedType = TXN_TYPE_MAP[txnType];
      if (mappedType === undefined) {
        warnings.push(`Unknown transaction type: "${txnType}" on ${tradeDate}`);
        continue;
      }
      if (mappedType === null) {
        // Explicitly skipped type (sweeps, internal transfers)
        continue;
      }

      const effectiveSymbol = (!symbol || symbol === "null") ? undefined : symbol;

      // Register security if we have a symbol
      if (effectiveSymbol && !securitiesMap.has(effectiveSymbol)) {
        const secType = deriveSecurityType(name || "", effectiveSymbol);
        const secData: ParsedSecurity = {
          symbol: effectiveSymbol,
          name: name,
          securityType: secType,
        };
        if (secType === "Option") {
          const optMeta = parseOptionMetadata(effectiveSymbol);
          if (optMeta) Object.assign(secData, optMeta);
        }
        securitiesMap.set(effectiveSymbol, secData);
      }

      // Use net amount as the transaction amount
      const amount = isNaN(netAmount) ? (isNaN(principal) ? undefined : principal) : netAmount;

      transactions.push({
        accountName,
        tradeDate,
        settlementDate: settlementDate || undefined,
        type: mappedType,
        symbol: effectiveSymbol,
        securityName: name || undefined,
        quantity: isNaN(shares) ? undefined : Math.abs(shares),
        amount,
        pricePerShare: isNaN(price) ? undefined : price,
        fees: isNaN(fees) ? undefined : Math.abs(fees),
        sourceKey: `vanguard-export:txn:${accountName}:${tradeDate}:${effectiveSymbol ?? "cash"}:${mappedType.toLowerCase()}:${amount}`,
      });
    }
  }

  return {
    sourceType: "vanguard-export",
    sourceName: filename,
    transactions,
    securities: Array.from(securitiesMap.values()),
    holdings,
    prices: Array.from(pricesMap.values()),
    snapshots: [],
    errors,
    warnings,
  };
}
