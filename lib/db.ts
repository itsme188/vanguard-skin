import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./db/migrate";

// DATABASE_PATH wins (full path to a .db file). Falls back to
// VANGUARD_DB_DIR/vanguard.db for back-compat. Lets a worktree point at the
// main repo's live DB without copying — `DATABASE_PATH=$HOME/code/vanguard-skin/data/vanguard.db npm run dev`.
const dbPath = process.env.DATABASE_PATH
  || path.join(process.env.VANGUARD_DB_DIR || path.join(process.cwd(), "data"), "vanguard.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("wal_checkpoint(TRUNCATE)");

runMigrations(db);
