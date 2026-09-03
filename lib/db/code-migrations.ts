// Static registry of CODE migrations (`NNN_name.ts`, exporting `up(db)`).
//
// Why a registry and not readdirSync (plan M1): the packaged app copies only
// `*.sql` into the standalone tree (electron-builder.yml extraResources
// filter) and has no TypeScript loader, so a runtime import() of a .ts file
// would fail in production. A static import here compiles each migration
// into the server bundle. tests/db/code-migrations-registry.test.ts asserts
// this map and the files on disk agree.
import type Database from "better-sqlite3";

export type CodeMigration = (db: Database.Database) => void;

export const CODE_MIGRATIONS: Record<string, CodeMigration> = {};
