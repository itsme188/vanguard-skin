import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

export function getHeldEtfSymbols(db: Database.Database): string[] {
  // Use the canonical latest-holdings predicate (per-(account,security),
  // quantity != 0) rather than a global holdings join, so stale/closed ETF
  // rows don't surface. See lib/queries/latest-holdings.ts.
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE ${latestHoldingsPredicate({})}
         AND LOWER(s.security_type) IN ('etf','mutual fund')`
    )
    .all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

export function getEtfSectorWeights(db: Database.Database): Map<string, Array<{ sector: string; weight_pct: number }>> {
  const map = new Map<string, Array<{ sector: string; weight_pct: number }>>();
  let rows: Array<{ etf_symbol: string; sector: string; weight_pct: number }>;
  try {
    rows = db.prepare("SELECT etf_symbol, sector, weight_pct FROM etf_sector_weights").all() as typeof rows;
  } catch {
    // Hand-rolled test DBs may predate migration 059 — degrade to "no
    // look-through" (same precedent as getRiskFreeRate's missing-settings
    // fallback) rather than failing the whole compute.
    return map;
  }
  for (const r of rows) {
    if (!map.has(r.etf_symbol)) map.set(r.etf_symbol, []);
    map.get(r.etf_symbol)!.push({ sector: r.sector, weight_pct: r.weight_pct });
  }
  return map;
}
