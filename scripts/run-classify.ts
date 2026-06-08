// scripts/run-classify.ts
// Run: npx tsx scripts/run-classify.ts
import { db } from "@/lib/db";
import { classifySecurities, classifyUnresolvedWithClaude } from "@/lib/compute/classify-securities";
import { classifyFactors } from "@/lib/compute/classify-factors";

const base = classifySecurities(db);
console.log(`static: ${base.classified} classified, ${base.unresolved.length} unresolved`);
const ai = await classifyUnresolvedWithClaude(db, base.unresolved);
console.log(`AI fallback: ${ai.classified} classified, errors=${ai.errors.length}`);
const fac = await classifyFactors(db);
console.log(`factors: ${fac.classified} classified, ${fac.skipped} defaults, errors=${fac.errors.length}`);
