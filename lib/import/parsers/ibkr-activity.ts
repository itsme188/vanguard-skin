import type {
  ParsedImportResult,
  ParsedTransaction,
  ParsedSecurity,
  ParsedSnapshot,
  ParsedHolding,
  ParsedPrice,
} from "../types";

interface CsvRow {
  section: string;
  discriminator: string;
  fields: string[];
}

function parseRawCsv(content: string): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    // Simple CSV split that handles quoted fields
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());

    if (fields.length >= 2) {
      rows.push({
        section: fields[0],
        discriminator: fields[1],
        fields: fields.slice(2),
      });
    }
  }
  return rows;
}

function getStatementPeriodEnd(rows: CsvRow[]): string {
  for (const row of rows) {
    if (row.section === "Statement" && row.fields[0] === "Period") {
      // "January 1, 2025 - January 31, 2025"
      const period = row.fields.slice(1).join(",").trim() || row.fields[0];
      const match = (row.fields[1] || row.fields[0]).match(
        /(\w+ \d+, \d{4})\s*$/
      );
      if (!match) {
        // Try the combined fields
        const combined = row.fields.join(",");
        const m2 = combined.match(/(\w+ \d+,\s*\d{4})\s*$/);
        if (m2) {
          return formatDate(m2[1]);
        }
        continue;
      }
      return formatDate(match[1]);
    }
  }
  return "";
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toISOString().slice(0, 10);
}

function parseDatetime(dt: string): string {
  // "2025-01-10, 10:30:00" → "2025-01-10"
  const match = dt.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : dt;
}

/**
 * Parse an IBKR option symbol/description into its components.
 * IBKR formats: "AAPL 21MAR25 150.0 C" or "SPY 17JAN25 580 P"
 * Also handles longer descriptions like "APPLOVIN CORP 21MAR25 135.0 C"
 */
export function parseIBKROptionSymbol(description: string): {
  underlying: string;
  strike: number;
  expiry: string;
  optionType: "CALL" | "PUT";
  occSymbol: string;
} | null {
  // Match pattern: <underlying> <DDMMMYY> <strike> <C|P>
  const match = description.match(
    /^(.+?)\s+(\d{2})([A-Z]{3})(\d{2})\s+([\d.]+)\s+([CP])\s*$/
  );
  if (!match) return null;

  const [, rawUnderlying, day, monthStr, year, strikeStr, cpFlag] = match;

  // The underlying might be a full name like "APPLOVIN CORP" — take just the first word
  // unless the symbol column has the real ticker. We'll use the full string for now
  // and let the caller override with the actual symbol column.
  const underlying = rawUnderlying.trim();

  const monthMap: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const month = monthMap[monthStr];
  if (!month) return null;

  const fullYear = `20${year}`;
  const expiry = `${fullYear}-${month}-${day}`;
  const strike = parseFloat(strikeStr);
  const optionType = cpFlag === "C" ? "CALL" as const : "PUT" as const;

  // Build OCC-style symbol: AAPL  250321C00150000
  const paddedUnderlying = underlying.slice(0, 6).padEnd(6, " ");
  const occDate = `${year}${month}${day}`;
  const occStrike = Math.round(strike * 1000).toString().padStart(8, "0");
  const occSymbol = `${paddedUnderlying}${occDate}${cpFlag}${occStrike}`;

  return { underlying, strike, expiry, optionType, occSymbol };
}

export function parseIbkrActivity(
  content: string,
  filename: string
): ParsedImportResult {
  const rows = parseRawCsv(content);
  const periodEnd = getStatementPeriodEnd(rows);

  const transactions: ParsedTransaction[] = [];
  const securitiesMap = new Map<string, ParsedSecurity>();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Parse Change in NAV for snapshot
  let startingValue = 0;
  let markToMarket = 0;
  let dividends = 0;
  let interest = 0;
  let fees = 0;
  let commissions = 0;
  let depositsWithdrawals = 0;
  let endingValue = 0;
  let twr = 0;

  for (const row of rows) {
    if (row.section === "Change in NAV" && row.discriminator === "Data") {
      const fieldName = row.fields[0];
      const value = parseFloat(row.fields[1]);
      if (isNaN(value)) continue;

      switch (fieldName) {
        case "Starting Value":
          startingValue = value;
          break;
        case "Mark-to-Market":
          markToMarket = value;
          break;
        case "Dividends":
          dividends = value;
          break;
        case "Interest":
          interest = value;
          break;
        case "Other Fees":
          fees = value;
          break;
        case "Commissions":
          commissions = value;
          break;
        case "Deposits/Withdrawals":
          depositsWithdrawals = value;
          break;
        case "Ending Value":
          endingValue = value;
          break;
      }
    }

    // TWR from NAV section
    if (
      row.section === "Net Asset Value" &&
      row.discriminator === "Data" &&
      row.fields.length === 1
    ) {
      const pctMatch = row.fields[0].match(/([\d.]+)%/);
      if (pctMatch) {
        twr = parseFloat(pctMatch[1]);
      }
    }
  }

  // Parse Trades
  for (const row of rows) {
    if (
      row.section === "Trades" &&
      row.discriminator === "Data" &&
      row.fields[0] === "Order"
    ) {
      // fields: DataDiscriminator, Asset Category, Currency, Account, Symbol, Date/Time, Quantity, T. Price, C. Price, Proceeds, Comm/Fee, Basis, Realized P/L, MTM P/L, Code
      const assetCategory = row.fields[1];
      const symbol = row.fields[4];
      const dateTime = row.fields[5];
      const quantity = parseFloat(row.fields[6].replace(/,/g, ""));
      const tradePrice = parseFloat(row.fields[7]);
      const proceeds = parseFloat(row.fields[9]);
      const commFee = parseFloat(row.fields[10]);
      const tradeDate = parseDatetime(dateTime);

      if (isNaN(quantity) || !symbol) continue;

      const isBuy = quantity > 0;

      if (assetCategory === "Options") {
        // Parse option symbol to extract metadata
        const optionInfo = parseIBKROptionSymbol(symbol);
        const effectiveSymbol = optionInfo?.occSymbol ?? symbol;

        transactions.push({
          accountName: "IBKR",
          tradeDate,
          type: isBuy ? "BUY_TO_OPEN" : "SELL_TO_CLOSE",
          symbol: effectiveSymbol,
          quantity: Math.abs(quantity),
          amount: proceeds,
          pricePerShare: tradePrice,
          fees: Math.abs(commFee),
          sourceKey: `ibkr:trade:${tradeDate}:${effectiveSymbol}:${quantity}:${proceeds}`,
        });

        securitiesMap.set(effectiveSymbol, {
          symbol: effectiveSymbol,
          name: symbol,
          securityType: "option",
          underlyingSymbol: optionInfo?.underlying,
          strikePrice: optionInfo?.strike,
          expirationDate: optionInfo?.expiry,
          optionType: optionInfo?.optionType,
          multiplier: 100,
        });
      } else {
        transactions.push({
          accountName: "IBKR",
          tradeDate,
          type: isBuy ? "BUY" : "SELL",
          symbol,
          quantity: Math.abs(quantity),
          amount: proceeds,
          pricePerShare: tradePrice,
          fees: Math.abs(commFee),
          sourceKey: `ibkr:trade:${tradeDate}:${symbol}:${quantity}:${proceeds}`,
        });

        securitiesMap.set(symbol, {
          symbol,
          securityType: assetCategory === "Stocks" ? "Stock" : assetCategory,
        });
      }
    }
  }

  // Parse Dividends
  for (const row of rows) {
    if (
      row.section === "Dividends" &&
      row.discriminator === "Data" &&
      row.fields[0] !== "Total"
    ) {
      // fields: Currency, Account, Date, Description, Amount
      const date = row.fields[2];
      const description = row.fields[3];
      const amount = parseFloat(row.fields[4]);

      if (isNaN(amount) || row.fields[0] === "Total") continue;

      // Extract symbol from description like "AAPL(US0378331005) Cash Dividend..."
      const symbolMatch = description.match(/^(\w+)\(/);
      const symbol = symbolMatch ? symbolMatch[1] : undefined;

      if (symbol) {
        securitiesMap.set(symbol, { symbol });
      }

      transactions.push({
        accountName: "IBKR",
        tradeDate: date,
        type: "DIVIDEND",
        symbol,
        amount,
        sourceKey: `ibkr:div:${date}:${symbol || "unknown"}:${amount}`,
      });
    }
  }

  // Parse Interest
  for (const row of rows) {
    if (
      row.section === "Interest" &&
      row.discriminator === "Data" &&
      row.fields[0] !== "Total"
    ) {
      // fields: Currency, Account, Date, Description, Amount
      const currency = row.fields[0];
      const date = row.fields[2];
      const description = row.fields[3];
      const amount = parseFloat(row.fields[4]);

      if (isNaN(amount) || currency === "Total") continue;

      transactions.push({
        accountName: "IBKR",
        tradeDate: date,
        type: "INTEREST",
        amount,
        notes: description,
        sourceKey: `ibkr:int:${date}:${amount}:${description}`,
      });
    }
  }

  // Parse Fees
  for (const row of rows) {
    if (
      row.section === "Fees" &&
      row.discriminator === "Data" &&
      row.fields[0] !== "Total"
    ) {
      // fields: Subtitle, Currency, Account, Date, Description, Amount
      const date = row.fields[3];
      const description = row.fields[4];
      const amount = parseFloat(row.fields[5]);

      if (isNaN(amount)) continue;

      transactions.push({
        accountName: "IBKR",
        tradeDate: date,
        type: "FEE",
        amount,
        notes: description,
        sourceKey: `ibkr:fee:${date}:${amount}:${description}`,
      });
    }
  }

  // Parse Open Positions → holdings + prices
  const holdings: ParsedHolding[] = [];
  const prices: ParsedPrice[] = [];

  for (const row of rows) {
    if (
      row.section === "Open Positions" &&
      row.discriminator === "Data" &&
      row.fields[0] === "Summary"
    ) {
      // fields: DataDiscriminator, Asset Category, Currency, Symbol, Quantity, Mult, Cost Price, Cost Basis, Close Price, Value, Unrealized P/L, Code
      const assetCategory = row.fields[1];
      const symbol = row.fields[3];
      const quantity = parseFloat(row.fields[4]);
      const multiplier = parseInt(row.fields[5]) || 1;
      const costBasis = parseFloat(row.fields[7]);
      const closePrice = parseFloat(row.fields[8]);

      if (!symbol || isNaN(quantity)) continue;

      const isOption = assetCategory.includes("Options");
      let effectiveSymbol = symbol;

      if (isOption) {
        const optionInfo = parseIBKROptionSymbol(symbol);
        effectiveSymbol = optionInfo?.occSymbol ?? symbol;

        securitiesMap.set(effectiveSymbol, {
          symbol: effectiveSymbol,
          name: symbol,
          securityType: "option",
          underlyingSymbol: optionInfo?.underlying,
          strikePrice: optionInfo?.strike,
          expirationDate: optionInfo?.expiry,
          optionType: optionInfo?.optionType,
          multiplier,
        });
      } else {
        securitiesMap.set(symbol, {
          symbol,
          securityType: assetCategory === "Stocks" ? "Stock" : assetCategory,
        });
      }

      holdings.push({
        accountName: "IBKR",
        symbol: effectiveSymbol,
        securityName: isOption ? symbol : undefined,
        quantity,
        costBasis: isNaN(costBasis) ? undefined : costBasis,
        asOfDate: periodEnd,
        sourceKey: `ibkr:pos:${periodEnd}:${effectiveSymbol}`,
      });

      if (!isNaN(closePrice) && closePrice > 0) {
        prices.push({
          symbol: effectiveSymbol,
          date: periodEnd,
          closePrice,
          source: "ibkr-activity",
        });
      }
    }
  }

  // Build snapshot
  const snapshots: ParsedSnapshot[] = [];
  if (endingValue !== 0 && periodEnd) {
    snapshots.push({
      accountName: "IBKR",
      monthEndDate: periodEnd,
      totalValue: endingValue,
      source: "ibkr-activity",
      startingValue,
      markToMarket,
      depositsWithdrawals,
      dividends,
      interest,
      commissions,
      fees,
      twr,
    });
  }

  return {
    sourceType: "ibkr-activity",
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
