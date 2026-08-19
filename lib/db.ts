import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./db/migrate";
import { resolveDbPath } from "./db/db-path";
import { setFeatureModelOverrideSource } from "./ai/override-source";
import { getFeatureModelOverrides } from "./queries/ai-model-overrides";
import { setModelCatalogSource } from "./ai/catalog-source";
import { getModelCatalog } from "./ai/model-catalog";

// DATABASE_PATH wins (full path to a .db file). Falls back to
// VANGUARD_DB_DIR/vanguard.db for back-compat. Lets a worktree point at the
// main repo's live DB without copying — `DATABASE_PATH=$HOME/code/vanguard-skin/data/vanguard.db npm run dev`.
// The resolution itself lives in db/db-path.ts so DB sidecars (e.g. the
// import-undo recovery manifests) can land next to the database without
// importing this module and opening the file as a side effect.
const dbPath = resolveDbPath();

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("wal_checkpoint(TRUNCATE)");

runMigrations(db);

// Wire the per-feature AI model override reader (Settings → AI Models) into
// the resolver. Registered here — not imported from lib/ai/models.ts — so
// importing the resolver never opens the SQLite file as a side effect
// (in-memory test DBs / Workers fall back to FEATURE_MODELS silently).
setFeatureModelOverrideSource(() => getFeatureModelOverrides(db));
setModelCatalogSource(() => getModelCatalog(db));
