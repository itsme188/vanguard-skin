import type Database from "better-sqlite3";
import type { Account } from "@/lib/types";

export function getAllAccounts(db: Database.Database): Account[] {
  return db.prepare("SELECT id, name FROM accounts ORDER BY id").all() as Account[];
}

export function getAccountByName(db: Database.Database, name: string): Account | null {
  return (db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(name) as Account) ?? null;
}

export function getAccountById(db: Database.Database, id: number): Account | null {
  return (db.prepare("SELECT id, name FROM accounts WHERE id = ?").get(id) as Account) ?? null;
}
