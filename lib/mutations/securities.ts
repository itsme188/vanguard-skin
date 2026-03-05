import type Database from "better-sqlite3";

export function upsertSecurity(
  db: Database.Database,
  symbol: string,
  name?: string,
  securityType?: string,
  assetClass?: string
): number {
  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, asset_class)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       name = COALESCE(excluded.name, securities.name),
       security_type = COALESCE(excluded.security_type, securities.security_type),
       asset_class = COALESCE(excluded.asset_class, securities.asset_class)`
  ).run(symbol, name ?? null, securityType ?? null, assetClass ?? null);

  const row = db
    .prepare("SELECT id FROM securities WHERE symbol = ?")
    .get(symbol) as { id: number };
  return row.id;
}
