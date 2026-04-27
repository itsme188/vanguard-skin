/**
 * Smoke-test for A2 (issuer-family combined positions in briefing).
 * Reads the live DB, builds combined-position rosters for week-of 2026-04-27,
 * and prints what each Mag-cap-tech earnings event will see — verifies
 * GOOGL earnings now rolls up the user's 65 sh GOOG common alongside the
 * GOOGL LEAP option.
 *
 * Run: npx tsx scripts/verify-a2-combined-positions.ts
 */
import Database from "better-sqlite3";
import {
  buildCurrentPrices,
  buildCombinedPositionsForEvents,
  formatCombinedPosition,
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
    `SELECT DISTINCT s.symbol FROM holdings h
     JOIN securities s ON s.id = h.security_id
     WHERE h.quantity > 0
       AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)`,
  )
  .all() as { symbol: string }[];

const expiringOptions = db
  .prepare(
    `SELECT s.symbol, s.underlying_symbol, s.expiration_date,
            s.option_type, s.strike_price,
            h.quantity, a.name AS account_name
     FROM holdings h JOIN securities s ON s.id = h.security_id JOIN accounts a ON a.id = h.account_id
     WHERE LOWER(s.security_type) = 'option' AND h.quantity != 0
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

const combined = buildCombinedPositionsForEvents(db, portfolioEarnings, currentPrices);

console.log(`# Earnings events with combined positions: ${combined.size}`);
console.log("");

for (const e of portfolioEarnings) {
  const cp = e.id != null ? combined.get(e.id) : undefined;
  if (!cp) continue;
  console.log(
    `${e.symbol} (${e.event_date}) — issuer family ${cp.family.join(" + ")}:`,
  );
  console.log(`  ${formatCombinedPosition(cp)}`);
  console.log("");
}

db.close();
