import type Database from "better-sqlite3";
import type { Security } from "@/lib/types";

export function getAllSecurities(db: Database.Database): Security[] {
  return db.prepare("SELECT * FROM securities ORDER BY symbol").all() as Security[];
}

export function getSecurityBySymbol(db: Database.Database, symbol: string): Security | null {
  return (db.prepare("SELECT * FROM securities WHERE symbol = ?").get(symbol) as Security) ?? null;
}

export function getSecurityById(db: Database.Database, id: number): Security | null {
  return (db.prepare("SELECT * FROM securities WHERE id = ?").get(id) as Security) ?? null;
}
