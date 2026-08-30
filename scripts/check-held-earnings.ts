import Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";

const db = new Database("data/vanguard.db", { readonly: true });

const earningsSymbols = ["ET","OCUL","SHOP","ALAB","PRIM","CLH","DIS","ESTA","OSCR","UBER","APP","UUUU","LQDT","SPHR","U","MELI","MP","NET","REAL","RKT"];

console.log("Earnings → held positions roll-up:\n");
const heldEarnings: string[] = [];

for (const sym of earningsSymbols) {
  const family = issuerSiblings(sym);
  const placeholders = family.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.name AS account_name, s.symbol, s.security_type, s.underlying_symbol, h.quantity
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE (UPPER(s.symbol) IN (${placeholders})
           OR UPPER(COALESCE(s.underlying_symbol, '')) IN (${placeholders}))
         AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id)
         AND h.quantity != 0`
    )
    .all(...family, ...family) as Array<{
    account_name: string;
    symbol: string;
    security_type: string;
    underlying_symbol: string | null;
    quantity: number;
  }>;
  if (rows.length === 0) continue;
  heldEarnings.push(sym);
  console.log(`${sym}:`);
  for (const r of rows) {
    console.log(`  [${r.account_name}] ${r.symbol} (${r.security_type}) qty=${r.quantity}`);
  }
  console.log("");
}

console.log("Held names with earnings this week:", heldEarnings.join(", "));
console.log("Other earnings (watchlist or no position):", earningsSymbols.filter((s) => !heldEarnings.includes(s)).join(", "));

db.close();
