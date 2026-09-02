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
import { parseOCCSymbol } from "@/lib/import/occ-symbol";

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
// Takes the already-parsed (and, for txn rows, already sign-normalized) number so the
// key reflects the normalized value, not the raw CSV text.
function amountCents(amt: number | undefined): string {
  if (amt == null || !Number.isFinite(amt)) return "0";
  return String(Math.round(amt * 100));
}

// Post-2026-04-01 statement-import era: canonical-csv amount is the SIGNED CASH EFFECT
// (docs/reference/conventions-detail.md). BUY-family rows must be negative (cash out),
// SELL-family rows must be positive (cash in). Pre-2026-04 rows are legacy-positive by
// design and must never be touched.
const SIGNED_CASH_EFFECT_ERA_START = "2026-04-01";
const BUY_FAMILY_TYPES = new Set([
  "BUY",
  "BUY_TO_OPEN",
  "BUY_TO_CLOSE",
  "BUY_TO_COVER",
]);
const SELL_FAMILY_TYPES = new Set(["SELL", "SELL_TO_CLOSE", "SELL_TO_OPEN"]);

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Mirrors the negative-quantity auto-normalization below: if a Co-Work session emits a
// BUY-family amount as positive or a SELL-family amount as negative on/after the
// signed-cash-effect era start, flip the sign and warn. Scope is intentionally narrow —
// TRANSFER (sweep sign is directional), DIVIDEND/INTEREST/FEE/TAX_WITHHELD etc. (a
// negative value there can be a legitimate reversal), zero/null/NaN amounts, and
// pre-era or malformed trade_dates are never touched.
function normalizeSignedAmount(
  type: string,
  tradeDate: string,
  rawAmount: number | undefined,
  symbol: string,
  warnings: string[]
): number | undefined {
  if (
    rawAmount == null ||
    !Number.isFinite(rawAmount) ||
    rawAmount === 0 ||
    !isYmd(tradeDate) ||
    tradeDate < SIGNED_CASH_EFFECT_ERA_START
  ) {
    return rawAmount;
  }
  let flipped: number | undefined;
  if (BUY_FAMILY_TYPES.has(type) && rawAmount > 0) {
    flipped = -Math.abs(rawAmount);
  } else if (SELL_FAMILY_TYPES.has(type) && rawAmount < 0) {
    flipped = Math.abs(rawAmount);
  }
  if (flipped == null) return rawAmount;
  warnings.push(
    `Transaction ${symbol} ${tradeDate} ${type}: amount ${rawAmount} normalized to ${flipped} (post-2026-04 signed-cash-effect convention)`
  );
  return flipped;
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
  // Tracks how many times each base transaction source_key has appeared in THIS
  // file, so genuine same-key duplicates (e.g. two zero-amount share-gift
  // journals on the same day for the same symbol — amount-cents is 0 for both,
  // so :cents can't separate them) get a stable disambiguating suffix instead
  // of one being silently dropped by INSERT OR IGNORE.
  const txnKeyCounts = new Map<string, number>();

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
        if (!symbol || !row.trade_date) {
          // Silent before this fix: neither the resolvable-security_name
          // branch above (which does warn) nor this one told the preview a
          // row existed and was dropped — a symbol+security_name-both-blank
          // row, or a row with an otherwise-valid symbol but a blank
          // trade_date, just vanished with no skip signal.
          warnings.push(
            !symbol
              ? "Skipped transaction: blank symbol"
              : `Skipped transaction ${symbol}: blank trade_date`
          );
          continue;
        }
        const tradeDateTrimmed = row.trade_date.trim();
        const type = (row.type || "").toUpperCase().trim();
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
        // Sign-normalize BEFORE deriving source_key so the key's cents segment
        // reflects the corrected amount — this is what makes a wrong-sign row and a
        // subsequently-corrected re-transcription dedup to the SAME key instead of
        // importing as a duplicate.
        const rawAmount = row.amount ? parseStrictNumber(row.amount) : undefined;
        const normalizedAmount = normalizeSignedAmount(
          type,
          tradeDateTrimmed,
          rawAmount,
          symbol,
          warnings
        );
        // Source key includes integer-cents amount so split fills (same day, same
        // symbol, same type, different amounts) don't collide.
        const baseSourceKey = `canonical:txn:${row.account?.trim()}:${symbol}:${tradeDateTrimmed}:${(row.type || "").trim()}:${amountCents(normalizedAmount)}`;
        // Disambiguate genuine duplicates that share an identical natural key AND
        // amount — e.g. two zero-amount share-gift / sub-account journal transfers
        // on the same day for the same symbol. The first keeps the bare key (so
        // already-imported rows stay idempotent on re-import); the Nth gets a
        // ":#N" suffix. Order-stable within a file, so re-import remains a no-op.
        const seen = (txnKeyCounts.get(baseSourceKey) ?? 0) + 1;
        txnKeyCounts.set(baseSourceKey, seen);
        const sourceKey =
          seen === 1 ? baseSourceKey : `${baseSourceKey}:#${seen}`;
        transactions.push({
          accountName: row.account?.trim() || "Unknown",
          tradeDate: tradeDateTrimmed,
          settlementDate: row.settlement_date?.trim() || undefined,
          type,
          symbol,
          securityName: row.security_name?.trim() || undefined,
          quantity: normalizedQty,
          pricePerShare: row.price ? parseStrictNumber(row.price) : undefined,
          amount: normalizedAmount,
          fees: row.fees ? parseStrictNumber(row.fees) : undefined,
          notes: row.notes?.trim() || undefined,
          sourceKey,
        });
        if (!securitiesMap.has(symbol)) {
          const occParsed = parseOCCSymbol(symbol);
          securitiesMap.set(symbol, {
            symbol,
            name: row.security_name?.trim(),
            securityType: row.security_type?.trim() || undefined,
            ...(occParsed
              ? {
                  underlyingSymbol: occParsed.underlying,
                  strikePrice: occParsed.strike,
                  expirationDate: occParsed.expirationDate,
                  optionType: occParsed.optionType,
                }
              : {}),
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
          const occParsed = parseOCCSymbol(symbol);
          securitiesMap.set(symbol, {
            symbol,
            name: row.security_name?.trim(),
            securityType: row.security_type?.trim() || undefined,
            ...(occParsed
              ? {
                  underlyingSymbol: occParsed.underlying,
                  strikePrice: occParsed.strike,
                  expirationDate: occParsed.expirationDate,
                  optionType: occParsed.optionType,
                }
              : {}),
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
    corporateActions: [],
    errors,
    warnings,
  };
}
