// Run: npx tsx scripts/classify-option-sectors.ts
import { db } from "@/lib/db";
import { classifyOptionSectors } from "@/lib/securities/classify-option-sectors";

async function main() {
  const res = await classifyOptionSectors(db);
  console.log(`Option-sector classify: ${res.classified} options sectored, errors=${res.errors.length}`);
  if (res.errors.length) console.log(res.errors.join("\n"));
}
main().catch((err) => { console.error(err); process.exit(1); });
