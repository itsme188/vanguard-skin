import type Database from "better-sqlite3";

export function upsertSecurity(
  db: Database.Database,
  symbol: string,
  name?: string,
  securityType?: string,
  assetClass?: string
): number {
  const existing = db
    .prepare("SELECT id FROM securities WHERE symbol = ?")
    .get(symbol) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, ?, ?)")
    .run(symbol, name ?? null, securityType ?? null, assetClass ?? null);
  return result.lastInsertRowid as number;
}
