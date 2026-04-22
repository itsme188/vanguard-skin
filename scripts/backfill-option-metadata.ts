/**
 * Backfill underlying_symbol, option_type, strike_price, expiration_date
 * for option securities that were imported without structured metadata.
 *
 * 394 of 452 option rows are affected (as of 2026-04-23) because older
 * IBKR-activity imports didn't populate the 4 structured columns.
 *
 * Handles two symbol formats:
 *   IBKR human-readable:  "AAPL 21MAR25 150.0 C"
 *   OCC standard:         "AAPL  250321C00150000"
 *
 * Reuses the import-time parser for IBKR format and parses OCC format
 * directly. Direct UPDATE (not upsert) to avoid the type-conflict guard
 * in upsertSecurity() — we are only filling NULL columns, never changing
 * symbol or security_type.
 *
 * Usage:
 *   npx tsx scripts/backfill-option-metadata.ts [--dry-run]
 */

import Database from "better-sqlite3";
import { parseIBKROptionSymbol } from "../lib/import/parsers/ibkr-activity";
import { isOCCFormat } from "../lib/import/occ-symbol";

type ParsedOption = {
  underlyingSymbol: string;
  optionType: "CALL" | "PUT";
  strikePrice: number;
  expirationDate: string; // YYYY-MM-DD
};

function parseOCC(symbol: string): ParsedOption | null {
  if (!isOCCFormat(symbol)) return null;
  const underlying = symbol.slice(0, 6).trim();
  const yy = symbol.slice(6, 8);
  const mm = symbol.slice(8, 10);
  const dd = symbol.slice(10, 12);
  const cp = symbol.slice(12, 13);
  const strikeRaw = symbol.slice(13, 21);
  const strike = parseInt(strikeRaw, 10) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlyingSymbol: underlying,
    optionType: cp === "C" ? "CALL" : "PUT",
    strikePrice: strike,
    expirationDate: `20${yy}-${mm}-${dd}`,
  };
}

function parseIBKR(symbol: string): ParsedOption | null {
  const parsed = parseIBKROptionSymbol(symbol);
  if (!parsed) return null;
  return {
    underlyingSymbol: parsed.underlying,
    optionType: parsed.optionType,
    strikePrice: parsed.strike,
    expirationDate: parsed.expiry,
  };
}

// Vanguard-style: "AAPL 260116 C 150.00" — YYMMDD, then C/P, then strike.
function parseVanguardCompact(symbol: string): ParsedOption | null {
  const match = symbol.match(
    /^([A-Z][A-Z0-9.]{0,5})\s+(\d{2})(\d{2})(\d{2})\s+([CP])\s+([\d.]+)\s*$/,
  );
  if (!match) return null;
  const [, underlying, yy, mm, dd, cp, strikeStr] = match;
  const strike = parseFloat(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlyingSymbol: underlying,
    optionType: cp === "C" ? "CALL" : "PUT",
    strikePrice: strike,
    expirationDate: `20${yy}-${mm}-${dd}`,
  };
}

function parseOptionSymbol(symbol: string): ParsedOption | null {
  return (
    parseOCC(symbol) ?? parseIBKR(symbol) ?? parseVanguardCompact(symbol)
  );
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const dbPath = process.env.VANGUARD_DB_PATH ?? "data/vanguard.db";
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const rows = db
    .prepare(
      `SELECT id, symbol, multiplier
       FROM securities
       WHERE LOWER(security_type) = 'option'
         AND underlying_symbol IS NULL
       ORDER BY id`,
    )
    .all() as { id: number; symbol: string; multiplier: number | null }[];

  console.log(`Found ${rows.length} option securities needing backfill.`);
  console.log(`Dry run: ${dryRun}\n`);

  const update = db.prepare(
    `UPDATE securities
     SET underlying_symbol = ?,
         option_type = ?,
         strike_price = ?,
         expiration_date = ?,
         multiplier = COALESCE(multiplier, 100)
     WHERE id = ?`,
  );

  let backfilled = 0;
  const skipped: { id: number; symbol: string }[] = [];

  const commit = db.transaction(() => {
    for (const row of rows) {
      const parsed = parseOptionSymbol(row.symbol);
      if (!parsed) {
        skipped.push({ id: row.id, symbol: row.symbol });
        continue;
      }
      if (dryRun) {
        console.log(
          `  [dry-run] id=${row.id} "${row.symbol}" → ${parsed.underlyingSymbol} ${parsed.optionType} ${parsed.strikePrice} ${parsed.expirationDate}`,
        );
      } else {
        update.run(
          parsed.underlyingSymbol,
          parsed.optionType,
          parsed.strikePrice,
          parsed.expirationDate,
          row.id,
        );
      }
      backfilled++;
    }
  });

  commit();
  db.close();

  console.log("");
  console.log("Summary:");
  console.log(`  Total inspected:  ${rows.length}`);
  console.log(`  Backfilled:       ${backfilled}${dryRun ? " (dry-run, no writes)" : ""}`);
  console.log(`  Skipped (unparseable): ${skipped.length}`);
  if (skipped.length > 0) {
    console.log("\nUnparseable symbols:");
    for (const s of skipped) {
      console.log(`  id=${s.id} "${s.symbol}"`);
    }
  }
}

main();
