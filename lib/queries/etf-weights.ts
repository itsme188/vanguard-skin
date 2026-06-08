import type Database from "better-sqlite3";

export function getHeldEtfSymbols(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT s.symbol FROM securities s
    JOIN holdings h ON h.security_id = s.id AND h.quantity != 0
    WHERE LOWER(s.security_type) IN ('etf','mutual fund')
  `).all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

export function getEtfSectorWeights(db: Database.Database): Map<string, Array<{ sector: string; weight_pct: number }>> {
  const rows = db.prepare("SELECT etf_symbol, sector, weight_pct FROM etf_sector_weights").all() as Array<{ etf_symbol: string; sector: string; weight_pct: number }>;
  const map = new Map<string, Array<{ sector: string; weight_pct: number }>>();
  for (const r of rows) {
    if (!map.has(r.etf_symbol)) map.set(r.etf_symbol, []);
    map.get(r.etf_symbol)!.push({ sector: r.sector, weight_pct: r.weight_pct });
  }
  return map;
}
