import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./db/migrate";

const dataDir = process.env.VANGUARD_DB_DIR || path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "vanguard.db");

fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

runMigrations(db);
