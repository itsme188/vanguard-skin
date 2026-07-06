/**
 * Reprocess the sector_etf_gaps backlog (2026-07-04 audit review minor).
 *
 * For each gap row: read the symbol's CURRENT securities.sector, resolve it
 * through resolveSectorEtf (now normalizer-defended). Rows that resolve are
 * stale — the sector was unmappable at enrichment time (pre-GICS-normalizer
 * spelling, or the SECTOR_TO_ETF "Health Care" key bug) but maps fine now.
 * Deleting them means future events for that symbol enrich with the ETF and
 * the data-health panel shows only GENUINE gaps.
 *
 * Historical events are NOT re-enriched: their reaction windows are long
 * past (Yahoo keeps ~10 days of 1-min bars) and enrichment is ADD-only.
 *
 * securities.symbol is UNIQUE, but a gap symbol can differ from the stored
 * securities symbol in ways UPPER() alone won't bridge (e.g. "GFL.TO" vs
 * "GFL" — a genuinely different string, not a case mismatch). The
 * correlated subquery below matches case-insensitively and, in case a
 * symbol ever has more than one non-option row, prefers one with a
 * non-null sector — it does not attempt suffix-stripping or fuzzy matching.
 *
 * Dry-run by default; pass --apply to delete.
 */
import Database from "better-sqlite3";
import { resolveSectorEtf } from "../lib/calendar/reaction-snapshot";

const db = new Database("data/vanguard.db");
const apply = process.argv.includes("--apply");

const gaps = db
  .prepare(
    `SELECT
       g.symbol,
       g.sector AS gap_sector,
       g.count,
       (
         SELECT s.sector
           FROM securities s
          WHERE UPPER(s.symbol) = UPPER(g.symbol)
            AND LOWER(COALESCE(s.security_type, '')) != 'option'
          ORDER BY (s.sector IS NOT NULL) DESC
          LIMIT 1
       ) AS current_sector
     FROM sector_etf_gaps g
     ORDER BY g.symbol, g.sector`,
  )
  .all() as Array<{ symbol: string; gap_sector: string | null; count: number; current_sector: string | null }>;

let resolvable = 0;
for (const g of gaps) {
  const etf = resolveSectorEtf("earnings", g.current_sector);
  const status = etf ? `RESOLVABLE → ${etf}` : "still unmapped";
  console.log(
    `${g.symbol.padEnd(8)} gap-sector=${String(g.gap_sector).padEnd(24)} current=${String(g.current_sector).padEnd(24)} ${status}`,
  );
  if (etf) {
    resolvable += 1;
    if (apply) {
      db.prepare(`DELETE FROM sector_etf_gaps WHERE symbol = ? AND ((sector IS NULL AND ? IS NULL) OR sector = ?)`)
        .run(g.symbol, g.gap_sector, g.gap_sector);
    }
  }
}
console.log(
  `\n${gaps.length} gap rows; ${resolvable} resolvable${apply ? " — DELETED" : " (dry run; pass --apply to delete)"}.`,
);
db.close();
