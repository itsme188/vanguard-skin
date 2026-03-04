import type {
  ParsedImportResult,
  ParsedTransaction,
  ParsedSecurity,
  ParsedSnapshot,
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
    holdings: [],
    prices: [],
    snapshots,
    errors,
    warnings,
  };
}
