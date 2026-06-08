/**
 * One-off: re-normalize securities.sector to canonical GICS for existing rows.
 * Idempotent. Preserves raw vendor string into industry only when industry is empty.
 * Run: npx tsx scripts/backfill-sectors.ts
 */
import { db } from "@/lib/db";
import { normalizeSector } from "@/lib/securities/normalize-sector";

const rows = db.prepare("SELECT id, sector, industry FROM securities WHERE sector IS NOT NULL AND TRIM(sector) != ''")
  .all() as Array<{ id: number; sector: string; industry: string | null }>;
const update = db.prepare(`UPDATE securities SET sector = COALESCE(?, sector), industry = COALESCE(NULLIF(industry,''), ?) WHERE id = ?`);
let changed = 0, unchanged = 0, unmapped = 0;
const unmappedLabels = new Map<string, number>();
const run = db.transaction(() => {
  for (const r of rows) {
    const normalized = normalizeSector(r.sector);
    if (normalized === null) { unmapped++; unmappedLabels.set(r.sector, (unmappedLabels.get(r.sector) ?? 0) + 1); continue; }
    if (normalized === r.sector) { unchanged++; continue; }
    update.run(normalized, r.sector, r.id); changed++;
  }
});
run();
console.log(`Backfill complete: ${changed} rewritten, ${unchanged} already canonical, ${unmapped} unmapped.`);
if (unmappedLabels.size) {
  console.log("Unmapped labels (review — may need an alias in normalize-sector.ts):");
  for (const [label, n] of [...unmappedLabels.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× "${label}"`);
}
