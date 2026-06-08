// scripts/refresh-etf-sector-weights.ts
// Run: npx tsx scripts/refresh-etf-sector-weights.ts
import { db } from "@/lib/db";
import { getHeldEtfSymbols } from "@/lib/queries/etf-weights";
import { refreshEtfWeights } from "@/lib/etf/sector-weights";

async function main() {
  const symbols = getHeldEtfSymbols(db);
  console.log(`Refreshing sector weights for ${symbols.length} held ETFs: ${symbols.join(", ")}`);
  await refreshEtfWeights(db, symbols);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
