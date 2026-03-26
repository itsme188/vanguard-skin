#!/usr/bin/env npx tsx
/**
 * Re-extract holdings from all Vanguard brokerage PDFs using the improved
 * focused extraction prompt. Replaces existing holdings + prices for each
 * account+date while preserving monthly snapshots and transactions.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/reimport-holdings.ts
 *
 * Options:
 *   --dry-run     Parse PDFs but don't write to DB (still costs API credits)
 *   --file=NAME   Process only a specific PDF filename
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { extractHoldingsFromPdf, parseClaudePdfResponse } from "@/lib/import/parsers/vanguard-pdf";
import { upsertSecurity } from "@/lib/mutations/securities";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

// ── Config ──────────────────────────────────────────────────────────

const PDF_DIR = "/Users/Yitzi/Desktop/Portfolio - Dashboard/data/vanguard";

// All brokerage PDFs to re-import (in chronological order)
const BROKERAGE_PDFS = [
  "01-2025 brokerage.pdf",
  "02-2025 brokerage.pdf",
  "03-2025 brokerage.pdf",
  "04-2025 brokerage.pdf",
  "05-2025 brokerage.pdf",
  "06-2025 brokerage.pdf",
  "07-2025 brokerage.pdf",
  "08-2025 brokerage.pdf",
  "09-2025 brokerage.pdf",
  "10-2025 brokerage.pdf",
  "11-2025 brokerage.pdf",
  "12-2025 brokerage.pdf",
  "2026-01 Vanguard Brokerage statement.pdf",
  "2026-02 Vanguard Brokerage statement.pdf",
];

// ── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileArg = args.find(a => a.startsWith("--file="))?.split("=")[1];

// ── Main ────────────────────────────────────────────────────────────

interface MonthResult {
  filename: string;
  date: string;
  oldCount: number;
  newCount: number;
  totalValue: number;
  holdingsSum: number;
  coveragePct: number;
  status: "ok" | "improved" | "worse" | "error";
}

async function main() {
  // Open DB
  const dbPath = path.join(process.cwd(), "data", "vanguard.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const pdfsToProcess = fileArg
    ? BROKERAGE_PDFS.filter(f => f.includes(fileArg))
    : BROKERAGE_PDFS;

  if (pdfsToProcess.length === 0) {
    console.error(`No matching PDFs found for: ${fileArg}`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Vanguard Holdings Re-Extraction`);
  console.log(`  ${pdfsToProcess.length} PDFs to process${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`${"=".repeat(70)}\n`);

  const results: MonthResult[] = [];

  for (const filename of pdfsToProcess) {
    const pdfPath = path.join(PDF_DIR, filename);
    if (!fs.existsSync(pdfPath)) {
      console.error(`  SKIP: ${filename} — file not found`);
      results.push({
        filename, date: "?", oldCount: 0, newCount: 0,
        totalValue: 0, holdingsSum: 0, coveragePct: 0, status: "error",
      });
      continue;
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  Processing: ${filename}`);
    console.log(`${"─".repeat(60)}`);

    try {
      const pdfBuffer = fs.readFileSync(pdfPath);

      // Extract holdings using improved multi-attempt extraction
      const response = await extractHoldingsFromPdf(pdfBuffer);
      const parsed = parseClaudePdfResponse(response, filename);

      const statementDate = parsed.snapshots[0]?.monthEndDate;
      const accountName = parsed.snapshots[0]?.accountName;
      const totalValue = response.total_value;
      const holdingsSum = response.holdings.reduce((s, h) => s + (h.value || 0), 0);
      const coveragePct = totalValue > 0 ? (holdingsSum / totalValue) * 100 : 0;

      if (!statementDate || !accountName) {
        console.error(`  ERROR: Could not determine statement date or account name`);
        results.push({
          filename, date: statementDate ?? "?", oldCount: 0, newCount: parsed.holdings.length,
          totalValue, holdingsSum, coveragePct, status: "error",
        });
        continue;
      }

      // Look up account ID
      const accountRow = db
        .prepare("SELECT id FROM accounts WHERE name = ?")
        .get(accountName) as { id: number } | undefined;

      if (!accountRow) {
        console.error(`  ERROR: Unknown account "${accountName}"`);
        results.push({
          filename, date: statementDate, oldCount: 0, newCount: parsed.holdings.length,
          totalValue, holdingsSum, coveragePct, status: "error",
        });
        continue;
      }

      const accountId = accountRow.id;

      // Count existing holdings for comparison
      const oldCount = (db
        .prepare("SELECT COUNT(*) as c FROM holdings WHERE account_id = ? AND as_of_date = ?")
        .get(accountId, statementDate) as { c: number }).c;

      console.log(`  Date: ${statementDate}  Account: ${accountName} (id=${accountId})`);
      console.log(`  Old holdings: ${oldCount}  New holdings: ${parsed.holdings.length}`);
      console.log(`  Coverage: $${holdingsSum.toLocaleString()} / $${totalValue.toLocaleString()} = ${coveragePct.toFixed(1)}%`);

      const status = parsed.holdings.length > oldCount ? "improved"
        : parsed.holdings.length === oldCount ? "ok"
        : "worse";

      results.push({
        filename, date: statementDate, oldCount,
        newCount: parsed.holdings.length,
        totalValue, holdingsSum, coveragePct, status,
      });

      if (dryRun) {
        console.log(`  DRY RUN — skipping DB writes`);
        continue;
      }

      if (parsed.holdings.length < oldCount) {
        console.log(`  WARNING: New extraction has FEWER holdings (${parsed.holdings.length} < ${oldCount}). Skipping.`);
        continue;
      }

      // Write to DB in a transaction
      db.transaction(() => {
        // Delete old holdings for this account+date
        const deleted = db
          .prepare("DELETE FROM holdings WHERE account_id = ? AND as_of_date = ?")
          .run(accountId, statementDate);
        console.log(`  Deleted ${deleted.changes} old holdings`);

        // Delete old vanguard-pdf prices for this date
        // (Only delete prices that came from vanguard-pdf imports for this date)
        const deletedPrices = db
          .prepare("DELETE FROM prices WHERE date = ? AND source = 'vanguard-pdf'")
          .run(statementDate);
        console.log(`  Deleted ${deletedPrices.changes} old prices for ${statementDate}`);

        // Upsert securities
        const securityIdMap = new Map<string, number>();
        for (const sec of parsed.securities) {
          const secId = upsertSecurity(db, {
            symbol: sec.symbol,
            name: sec.name,
            securityType: sec.securityType,
            underlyingSymbol: sec.underlyingSymbol,
            strikePrice: sec.strikePrice,
            expirationDate: sec.expirationDate,
            optionType: sec.optionType,
            multiplier: sec.multiplier,
            maturityDate: sec.maturityDate,
          });
          securityIdMap.set(sec.symbol, secId);
        }

        // Insert new holdings
        const insertHolding = db.prepare(`
          INSERT OR REPLACE INTO holdings
            (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        let insertedHoldings = 0;
        for (const h of parsed.holdings) {
          let secId = securityIdMap.get(h.symbol);
          if (!secId) {
            secId = upsertSecurity(db, h.symbol);
            securityIdMap.set(h.symbol, secId);
          }

          insertHolding.run(
            accountId, secId, h.quantity,
            h.costBasis ?? null, h.asOfDate,
            h.sourceKey
          );
          insertedHoldings++;
        }

        // Insert new prices
        const insertPrice = db.prepare(`
          INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
          VALUES (?, ?, ?, 'vanguard-pdf')
        `);

        let insertedPrices = 0;
        for (const p of parsed.prices) {
          let secId = securityIdMap.get(p.symbol);
          if (!secId) {
            secId = upsertSecurity(db, p.symbol);
            securityIdMap.set(p.symbol, secId);
          }

          insertPrice.run(secId, p.date, p.closePrice);
          insertedPrices++;
        }

        console.log(`  Inserted ${insertedHoldings} holdings, ${insertedPrices} prices`);
      })();

    } catch (err) {
      console.error(`  ERROR: ${err}`);
      results.push({
        filename, date: "?", oldCount: 0, newCount: 0,
        totalValue: 0, holdingsSum: 0, coveragePct: 0, status: "error",
      });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  SUMMARY`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  Date         Old   New   Coverage   Status`);
  console.log(`  ${"-".repeat(50)}`);

  for (const r of results) {
    const marker = r.status === "improved" ? "+" :
      r.status === "worse" ? "!" :
      r.status === "error" ? "X" : " ";
    console.log(
      `  ${r.date.padEnd(12)} ${String(r.oldCount).padEnd(5)} ${String(r.newCount).padEnd(5)} ${r.coveragePct.toFixed(0).padStart(3)}%       ${marker} ${r.status}`
    );
  }

  const improved = results.filter(r => r.status === "improved").length;
  const errors = results.filter(r => r.status === "error").length;
  console.log(`\n  ${improved} improved, ${errors} errors, ${results.length - improved - errors} unchanged`);

  // ── Recompute daily valuations ──────────────────────────────────────

  if (!dryRun && improved > 0) {
    console.log(`\n  Recomputing daily valuations...`);
    const valResult = computeDailyValuations(db);
    console.log(`  Computed ${valResult.datesComputed} dates for ${valResult.accountsProcessed} accounts`);
  }

  console.log(`\n  Done.`);
  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
