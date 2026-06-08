/**
 * One-off: populate underlying_symbol on option rows where it's NULL, derived from
 * the OCC symbol via resolveHeldUnderlying (issuer-family aware). Also derives the
 * option's GICS sector from its underlying's normalized sector.
 * Run: npx tsx scripts/backfill-option-underlyings.ts
 */
import { db } from "@/lib/db";
import { resolveHeldUnderlying } from "@/lib/securities/resolve-underlying";

const opts = db
  .prepare(
    `SELECT id, symbol FROM securities
   WHERE LOWER(security_type) = 'option' AND (underlying_symbol IS NULL OR TRIM(underlying_symbol) = '')`
  )
  .all() as Array<{ id: number; symbol: string }>;

const setUnderlying = db.prepare(
  "UPDATE securities SET underlying_symbol = ? WHERE id = ?"
);
const deriveSector = db.prepare(
  `UPDATE securities SET sector = (
     SELECT u.sector FROM securities u WHERE UPPER(u.symbol) = UPPER(?) AND u.sector IS NOT NULL LIMIT 1
   ) WHERE id = ? AND (sector IS NULL OR TRIM(sector) = '')`
);

let linked = 0,
  sectored = 0,
  skipped = 0;
db.transaction(() => {
  for (const o of opts) {
    const underlying = resolveHeldUnderlying(db, o.symbol);
    if (!underlying) {
      skipped++;
      continue;
    }
    setUnderlying.run(underlying, o.id);
    linked++;
    if (deriveSector.run(underlying, o.id).changes > 0) sectored++;
  }
})();
console.log(
  `Option underlying backfill: ${linked} linked, ${sectored} sectors derived, ${skipped} skipped (non-OCC).`
);
