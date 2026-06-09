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

// Standalone re-derivation: any held option still blank-sector whose underlying
// HAS a sector now (e.g. the underlying was classified after the link pass) gets
// its GICS sector filled. Runs over ALL blank-sector options, not just the
// newly-linked ones — captures underlyings classified in a later step.
const reDerived = db
  .prepare(
    `UPDATE securities AS o SET sector = (
       SELECT u.sector FROM securities u
       WHERE UPPER(u.symbol) = UPPER(o.underlying_symbol) AND u.sector IS NOT NULL AND TRIM(u.sector) != ''
       LIMIT 1
     )
     WHERE LOWER(o.security_type) = 'option'
       AND (o.sector IS NULL OR TRIM(o.sector) = '')
       AND o.underlying_symbol IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM securities u2
         WHERE UPPER(u2.symbol) = UPPER(o.underlying_symbol) AND u2.sector IS NOT NULL AND TRIM(u2.sector) != ''
       )`
  )
  .run();
console.log(`Re-derived sector for ${reDerived.changes} additional blank-sector options.`);
