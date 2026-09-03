import type {
  ParsedImportResult,
  ParsedTransaction,
  ParsedSecurity,
  ParsedSnapshot,
  ParsedHolding,
  ParsedPrice,
  ParsedCorporateAction,
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

  // Tracks how many times each base source_key has appeared in THIS file, so
  // two genuinely identical fills (same date/symbol/qty/proceeds — annual
  // statements with 1,736 trade rows raise the odds) get a stable
  // disambiguating suffix instead of the second silently dropping at commit
  // via INSERT OR IGNORE. Mirrors the canonical-csv `:#N` convention: the
  // first occurrence keeps the bare key (idempotent with historical imports),
  // the Nth identical key gets `:#N` appended (N starting at 2).
  const seenKeys = new Map<string, number>();
  const uniqueKey = (base: string): string => {
    const n = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, n);
    return n === 1 ? base : `${base}:#${n}`;
  };

  // Parse Change in NAV for snapshot
  let startingValue = 0;
  let markToMarket = 0;
  let dividends = 0;
  let interest = 0;
  let fees = 0;
  let commissions = 0;
  let depositsWithdrawals: number | undefined = undefined;
  let endingValue = 0;
  let twr: number | undefined = undefined;
  // Some statements (multi-currency / securities-lending accounts) emit a SECOND
  // zeroed "Change in NAV" block + a "0%" TWR after the real primary-account block
  // (a base-currency/segment summary). The loop must capture ONLY the first block —
  // otherwise the zero block overwrites the real ending value to 0 and the snapshot
  // is silently dropped by the `endingValue !== 0` guard below.
  let sawEndingValue = false;

  for (const row of rows) {
    if (
      row.section === "Change in NAV" &&
      row.discriminator === "Data" &&
      !sawEndingValue
    ) {
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
        case "Deposits & Withdrawals":
          depositsWithdrawals = value;
          break;
        case "Ending Value":
          endingValue = value;
          sawEndingValue = true; // first block complete — ignore any later blocks
          break;
      }
    }

    // TWR from NAV section — first (primary-account) value wins; a later
    // base-currency segment reports "0%" and must not overwrite it.
    if (
      row.section === "Net Asset Value" &&
      row.discriminator === "Data" &&
      row.fields.length === 1 &&
      twr === undefined
    ) {
      const pctMatch = row.fields[0].match(/(-?[\d.]+)%/);
      if (pctMatch) {
        twr = parseFloat(pctMatch[1]);
      }
    }
  }

  // Parse Trades.
  // Column positions are read by NAME from the Trades header row, not hardcoded:
  // IBKR omits the "Account" column on single-account statements (present on
  // consolidated/multi-currency ones), which shifts every later column by one.
  // A hardcoded layout silently misaligns symbol↔date↔quantity and validation
  // then rejects every trade. The `?? <legacy index>` fallbacks reproduce the
  // old with-Account layout if a header is somehow missing.
  const tradesHeader = rows.find(
    (r) => r.section === "Trades" && r.discriminator === "Header"
  );
  const tCol: Record<string, number> = {};
  tradesHeader?.fields.forEach((name, i) => {
    tCol[name] = i;
  });
  const idxAsset = tCol["Asset Category"] ?? 1;
  const idxSymbol = tCol["Symbol"] ?? 4;
  const idxDateTime = tCol["Date/Time"] ?? 5;
  const idxQty = tCol["Quantity"] ?? 6;
  const idxPrice = tCol["T. Price"] ?? 7;
  const idxProceeds = tCol["Proceeds"] ?? 9;
  const idxComm = tCol["Comm/Fee"] ?? 10;

  for (const row of rows) {
    if (
      row.section === "Trades" &&
      row.discriminator === "Data" &&
      row.fields[0] === "Order"
    ) {
      const assetCategory = row.fields[idxAsset];
      const symbol = row.fields[idxSymbol];
      const dateTime = row.fields[idxDateTime];
      const quantity = parseFloat((row.fields[idxQty] ?? "").replace(/,/g, ""));
      const tradePrice = parseFloat(row.fields[idxPrice]);
      const proceeds = parseFloat(row.fields[idxProceeds]);
      const commFee = parseFloat(row.fields[idxComm]);
      const tradeDate = parseDatetime(dateTime);

      if (isNaN(quantity) || !symbol) continue;

      const isBuy = quantity > 0;

      // Real statements label option trades "Equity and Index Options" —
      // match by substring like the Open Positions section does, never by
      // strict equality (a strict check sent every option trade down the
      // stock branch in the April + May 2026 imports).
      if (assetCategory.includes("Options")) {
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
          sourceKey: uniqueKey(
            `ibkr:trade:${tradeDate}:${effectiveSymbol}:${quantity}:${proceeds}`
          ),
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
          sourceKey: uniqueKey(
            `ibkr:trade:${tradeDate}:${symbol}:${quantity}:${proceeds}`
          ),
        });

        securitiesMap.set(symbol, {
          symbol,
          securityType: assetCategory === "Stocks" ? "Stock" : assetCategory,
        });
      }
    }
  }

  // Parse Transfers (ACATS in-kind security legs). The Jan-2024 Robinhood
  // ACATS positions were invisible to the old canonical backfill — every
  // subsequent sale of those shares overshot the ledger (2026-08-03 audit).
  // Cash legs already arrive via Deposits & Withdrawals; only security rows
  // (Asset Category "Stocks") are transactions here. Basis: transfer-date
  // market value / qty — refined for the 4 known ACATS positions by
  // scripts/repair-acats-opening-lots.ts (worksheet-verified original lots).
  const xferHeader = rows.find(
    (r) => r.section === "Transfers" && r.discriminator === "Header"
  );
  const xCol: Record<string, number> = {};
  xferHeader?.fields.forEach((name, i) => {
    xCol[name] = i;
  });
  for (const row of rows) {
    if (row.section !== "Transfers" || row.discriminator !== "Data") continue;
    const assetCategory = row.fields[xCol["Asset Category"] ?? 0];
    if (assetCategory !== "Stocks") {
      // "Cash" legs already arrive via Deposits & Withdrawals, and the
      // section's own "Total" row is expected — both stay silent. Any OTHER
      // Asset Category (e.g. an Options or Bonds ACATS leg) has no in-kind
      // transfer handling in this parser and would otherwise be silently
      // dropped — warn so a future non-stock transfer leg is noticed
      // instead of vanishing without a trace.
      if (assetCategory && assetCategory !== "Cash" && assetCategory !== "Total") {
        const symbolForWarning = row.fields[xCol["Symbol"] ?? 3];
        warnings.push(
          `Transfers: skipped "${assetCategory}" leg` +
            (symbolForWarning ? ` (symbol ${symbolForWarning})` : "") +
            ` — only Stocks transfers are converted to TRANSFER_IN/TRANSFER_OUT`
        );
      }
      continue; // skips Total + Cash rows (and now-warned other categories)
    }
    const symbol = row.fields[xCol["Symbol"] ?? 3];
    const date = row.fields[xCol["Date"] ?? 4];
    const direction = row.fields[xCol["Direction"] ?? 6];
    const qty = Math.abs(
      parseFloat((row.fields[xCol["Qty"] ?? 9] ?? "").replace(/,/g, ""))
    );
    const marketValue = Math.abs(
      parseFloat((row.fields[xCol["Market Value"] ?? 11] ?? "").replace(/,/g, ""))
    );
    if (!symbol || !date || isNaN(qty) || qty === 0) continue;

    transactions.push({
      accountName: "IBKR",
      tradeDate: date,
      type: direction === "Out" ? "TRANSFER_OUT" : "TRANSFER_IN",
      symbol,
      quantity: qty,
      amount: marketValue,
      pricePerShare: isNaN(marketValue) ? undefined : marketValue / qty,
      fees: 0,
      sourceKey: uniqueKey(`ibkr:xfer:${date}:${symbol}:${qty}:${direction}`),
    });
    securitiesMap.set(symbol, { symbol, securityType: "Stock" });
  }

  // Parse Corporate Actions (splits/reverse splits only — spec 2026-08-11).
  // Columns by header name (single-account statements omit "Account").
  // The ratio lives in the description text; Quantity is the share DELTA
  // (reconciliation evidence, never the booking truth).
  const isRealIsoDate = (s: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };
  const corporateActions: ParsedCorporateAction[] = [];
  const caHeader = rows.find(
    (r) => r.section === "Corporate Actions" && r.discriminator === "Header"
  );
  const cCol: Record<string, number> = {};
  caHeader?.fields.forEach((name, i) => {
    cCol[name] = i;
  });
  for (const row of rows) {
    if (row.section !== "Corporate Actions" || row.discriminator !== "Data") continue;
    const assetCategory = row.fields[cCol["Asset Category"] ?? 0];
    if (assetCategory === "Total" || !assetCategory) continue;
    const description = row.fields[cCol["Description"] ?? 5] ?? "";
    if (assetCategory !== "Stocks") {
      warnings.push(
        `Corporate Actions: unsupported action skipped (non-stock ${assetCategory}) — "${description}"`
      );
      continue;
    }
    // Symbol = everything before the first "(" — dotted/suffixed symbols survive.
    const symMatch = description.match(/^([^(]+)\(/);
    const symbol = symMatch ? symMatch[1].trim() : "";
    const ratioMatch = description.match(/\bSplit (\d+) for (\d+)\b/);
    const dateStr = parseDatetime(row.fields[cCol["Date/Time"] ?? 4] ?? "");
    const qtyRaw = parseFloat((row.fields[cCol["Quantity"] ?? 6] ?? "").replace(/,/g, ""));
    if (!symbol || !ratioMatch || !isRealIsoDate(dateStr)) {
      warnings.push(`Corporate Actions: unsupported action skipped — "${description}"`);
      continue;
    }
    const num = parseInt(ratioMatch[1], 10);
    const den = parseInt(ratioMatch[2], 10);
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0 || num === den) {
      // num === den (1-for-1) is a no-op that would still create a row — skip loudly.
      warnings.push(`Corporate Actions: unsupported action skipped (ratio) — "${description}"`);
      continue;
    }
    corporateActions.push({
      accountName: "IBKR",
      symbol,
      actionType: num > den ? "SPLIT" : "REVERSE_SPLIT",
      effectiveDate: dateStr,
      ratioNumerator: num,
      ratioDenominator: den,
      quantityDelta: Number.isFinite(qtyRaw) ? qtyRaw : null,
      sourceKey: `ibkr:ca:split:${dateStr}:${symbol}:${num}:${den}`,
    });
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

  // Parse Interest — one block per currency: the native rows, a "Total" line
  // in that currency, then IBKR's own "Total in USD" conversion of the block.
  // The USD block ends with the grand "Total Interest in USD" line instead.
  // Non-USD rows are stored in USD, scaled by the block's Total-in-USD ratio
  // (2026-09-03: a KRW 36,461.73 debit-interest row had landed as -$36,461.73).
  // The source key keeps the printed native figure so a re-import of an older
  // statement dedupes against the row it already wrote.
  {
    type NativeInterestRow = {
      currency: string;
      date: string;
      description: string;
      amount: number;
    };
    let block: NativeInterestRow[] = [];
    let blockNativeTotal: number | null = null;

    const emit = (r: NativeInterestRow, usdAmount: number, converted: boolean) => {
      transactions.push({
        accountName: "IBKR",
        tradeDate: r.date,
        type: "INTEREST",
        amount: usdAmount,
        notes: converted
          ? `${r.description} (${r.currency} ${r.amount} converted at IBKR's Total-in-USD rate)`
          : r.description,
        sourceKey: `ibkr:int:${r.date}:${r.amount}:${r.description}`,
      });
    };

    const flush = (usdTotal: number | null) => {
      if (block.length === 0) return;
      const currency = block[0].currency;
      const nativeTotal =
        blockNativeTotal ?? block.reduce((sum, r) => sum + r.amount, 0);
      if (currency === "USD") {
        for (const r of block) emit(r, r.amount, false);
      } else if (usdTotal == null) {
        warnings.push(
          `Interest: skipped ${block.length} ${currency} row(s) (native total ${nativeTotal}) — ` +
            `no "Total in USD" line follows the block, so they cannot be converted`
        );
      } else {
        const ratio = nativeTotal === 0 ? 0 : usdTotal / nativeTotal;
        for (const r of block) emit(r, r.amount * ratio, true);
      }
      block = [];
      blockNativeTotal = null;
    };

    for (const row of rows) {
      if (row.section !== "Interest" || row.discriminator !== "Data") continue;
      // fields: Currency, Account, Date, Description, Amount
      const label = row.fields[0];
      const amount = parseFloat(row.fields[4]);

      if (label === "Total") {
        if (!isNaN(amount)) blockNativeTotal = amount;
        continue;
      }
      if (label === "Total in USD") {
        flush(isNaN(amount) ? null : amount);
        continue;
      }
      if (/^Total\b/.test(label)) {
        // "Total Interest in USD" — the grand total across currencies, not a
        // per-block conversion: closes a USD block, never scales one.
        flush(null);
        continue;
      }

      const currency = label;
      const date = row.fields[2];
      const description = row.fields[3];
      if (isNaN(amount)) continue;

      // A currency change without an intervening "Total in USD" line means
      // the previous block never got its conversion — flush it (warns if
      // non-USD) before starting the new one.
      if (block.length > 0 && block[0].currency !== currency) flush(null);
      block.push({ currency, date, description, amount });
    }
    flush(null);
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

  // Parse Deposits & Withdrawals as external flow transactions
  for (const row of rows) {
    if (
      (row.section === "Deposits & Withdrawals" ||
        row.section === "Deposits/Withdrawals") &&
      row.discriminator === "Data" &&
      row.fields[0] !== "Total"
    ) {
      // fields: Currency, Account, Settle Date, Description, Amount
      const currency = row.fields[0];
      const date = row.fields[2];
      const description = row.fields[3];
      const amount = parseFloat(row.fields[4]);

      if (isNaN(amount) || currency === "Total") continue;

      transactions.push({
        accountName: "IBKR",
        tradeDate: date,
        type: amount >= 0 ? "DEPOSIT" : "WITHDRAWAL",
        amount,
        isExternalFlow: true,
        notes: description,
        sourceKey: `ibkr:dw:${date}:${amount}:${description}`,
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
    corporateActions,
    errors,
    warnings,
  };
}
