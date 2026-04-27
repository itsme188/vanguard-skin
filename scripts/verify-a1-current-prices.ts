/**
 * Smoke-test for A1 (current-prices in briefing prompt).
 * Reads the live DB, builds the currentPrices map for week-of 2026-04-27,
 * and prints what the briefing prompt would contain — verifies that TER
 * (the user-spotted miss in the 2026-04-26 briefing) now has a price.
 *
 * Run: npx tsx scripts/verify-a1-current-prices.ts
 */
import Database from "better-sqlite3";
import {
  buildCurrentPrices,
  formatCurrentPricesBlock,
} from "@/lib/calendar/briefing";
import { getEventsByWeek } from "@/lib/queries/calendar";

const db = new Database("data/vanguard.db", { readonly: true });

const events = getEventsByWeek(db, "2026-04-27");
const portfolioEarnings = events.filter(
  (e) => e.source === "finnhub" && e.event_type === "earnings",
);
const wshEarnings = events.filter(
  (e) => e.source === "wsh" && e.event_type === "earnings",
);

const holdings = db
  .prepare(
    `SELECT DISTINCT s.symbol, s.name, s.security_type, s.sector
     FROM holdings h
     JOIN securities s ON s.id = h.security_id
     WHERE h.quantity > 0
       AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)
     ORDER BY s.symbol`,
  )
  .all() as {
  symbol: string;
  name: string | null;
  security_type: string | null;
  sector: string | null;
}[];

const expiringOptions = db
  .prepare(
    `SELECT s.symbol, s.underlying_symbol, s.expiration_date,
            s.option_type, s.strike_price,
            h.quantity, a.name AS account_name
     FROM holdings h
     JOIN securities s ON s.id = h.security_id
     JOIN accounts a ON a.id = h.account_id
     WHERE LOWER(s.security_type) = 'option'
       AND h.quantity != 0
       AND s.expiration_date BETWEEN '2026-04-27' AND '2026-05-03'
       AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)`,
  )
  .all() as {
  symbol: string;
  underlying_symbol: string | null;
  expiration_date: string;
  option_type: string | null;
  strike_price: number | null;
  quantity: number;
  account_name: string;
}[];

const currentPrices = buildCurrentPrices(db, {
  holdings,
  expiringOptions,
  portfolioEarnings,
  wshEarnings,
});

console.log(`# Symbols priced: ${currentPrices.size}`);
console.log("");
console.log("# TER (the user-spotted regression):");
const ter = currentPrices.get("TER");
console.log(
  ter
    ? `  TER: $${ter.close.toFixed(2)} (${ter.date}) — strike on user's LEAP is $180`
    : "  TER: NOT FOUND (regression)",
);
console.log("");
console.log("# First 5 rows of holdings list:");
const firstFive = holdings.slice(0, 5).map((h) => {
  const p = currentPrices.get(h.symbol);
  const priceSuffix = p
    ? ` — last $${p.close.toFixed(2)} (${p.date})`
    : ` — no recent price`;
  return `${h.symbol} (${h.name ?? "unknown"}, ${h.sector ?? "N/A"})${priceSuffix}`;
});
firstFive.forEach((line) => console.log(`  ${line}`));
console.log("");
console.log("# First 15 rows of currentPricesBlock:");
const blockRows = formatCurrentPricesBlock(currentPrices).split("\n").slice(0, 15);
blockRows.forEach((line) => console.log(`  ${line}`));
console.log(`  ... and ${currentPrices.size - 15} more`);

db.close();
