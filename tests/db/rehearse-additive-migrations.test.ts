import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { CODE_MIGRATIONS } from "@/lib/db/code-migrations";
import {
  rehearseAdditiveMigrations,
  isColumnAppend,
  splitTopLevelItems,
  stripSqlComments,
} from "@/scripts/rehearse-additive-migrations";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rehearse-additive-migrations-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A file-backed DB with every migration on disk applied (through 091 in
 *  this worktree — slice C's 090 is not on disk here). */
function buildFullyMigratedDb(filePath: string): void {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.close();
}

/** Rolls a fully-migrated DB back to "089 on disk" per the task recipe:
 *  drop 091's bookkeeping row and its two tables (SQLite drops a table's own
 *  indexes automatically). */
function rollBackTo089(filePath: string): void {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.exec(`DELETE FROM schema_migrations WHERE filename LIKE '091%'`);
  db.exec(`DROP TABLE print_watch_callouts`);
  db.exec(`DROP TABLE print_watch_reads`);
  db.close();
}

/** Seeds one row in a pre-existing table so the row-count-unchanged check is
 *  meaningful (synthetic identifiers only — never real tickers/positions). */
function seedCalendarEventRow(filePath: string): void {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.exec(
    `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
     VALUES ('manual', 'earnings', '2026-09-10', 'Synthetic Co', 'rehearse-test-seed-1', 'SYNCO')`,
  );
  db.close();
}

describe("rehearseAdditiveMigrations", () => {
  it("rehearses 091 cleanly on a DB rolled back to 089, with data preserved", async () => {
    const dbPath = path.join(tmpDir, "rehearse-089.db");
    buildFullyMigratedDb(dbPath);
    rollBackTo089(dbPath);
    seedCalendarEventRow(dbPath);

    const result = await rehearseAdditiveMigrations(dbPath);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pending).toEqual(["091_print_watch_first_pass.sql"]);
    expect(result.report).toContain("print_watch_reads");
    expect(result.report).toContain("print_watch_callouts");
    expect(result.report).toContain("RESULT: PASS");

    // The seeded row must still be there, untouched, after the rehearsal.
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT title FROM calendar_events WHERE source_key = ?`)
      .get("rehearse-test-seed-1") as { title: string } | undefined;
    db.close();
    expect(row?.title).toBe("Synthetic Co");
  });

  it("reports nothing pending on an already fully-migrated database", async () => {
    const dbPath = path.join(tmpDir, "rehearse-full.db");
    buildFullyMigratedDb(dbPath);

    const result = await rehearseAdditiveMigrations(dbPath);

    expect(result.ok).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.report).toContain("nothing pending");
  });

  it("refuses a path whose basename is vanguard.db, even on a harmless temp copy", async () => {
    const dbPath = path.join(tmpDir, "vanguard.db");
    buildFullyMigratedDb(dbPath);

    await expect(rehearseAdditiveMigrations(dbPath)).rejects.toThrow(/vanguard\.db/);
  });

  it("refuses a path that does not exist", async () => {
    const dbPath = path.join(tmpDir, "does-not-exist.db");

    await expect(rehearseAdditiveMigrations(dbPath)).rejects.toThrow(/no such file/);
  });

  it("refuses anything under the directory the app's own resolver points at (R-D23)", async () => {
    // The live location is READ FROM THE RESOLVER, never hardcoded — so point
    // the resolver at this temp directory and a copy inside it must be refused
    // exactly as the real data directory would be. `assertSafeTarget` reads
    // `process.env` through the resolver's default argument, so the env is set
    // and restored here rather than injected.
    const dbPath = path.join(tmpDir, "copy-inside-the-live-dir.db");
    buildFullyMigratedDb(dbPath);
    const savedDir = process.env.VANGUARD_DB_DIR;
    const savedPath = process.env.DATABASE_PATH;
    try {
      delete process.env.DATABASE_PATH;
      process.env.VANGUARD_DB_DIR = tmpDir;
      await expect(rehearseAdditiveMigrations(dbPath)).rejects.toThrow(/live database directory/);
    } finally {
      if (savedDir === undefined) delete process.env.VANGUARD_DB_DIR;
      else process.env.VANGUARD_DB_DIR = savedDir;
      if (savedPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = savedPath;
    }
  });

  it("PASSES an ALTER TABLE … ADD COLUMN, naming it a column-append (review M8, R-D30)", async () => {
    // "Additive" means the chain may CREATE and may APPEND columns, never
    // rewrite. The only lever a test has over the pending set is the
    // code-migration registry the runner and the script both read, so a
    // throwaway migration is registered here (and removed in `finally`) that
    // touches a table 091 never sees. Slice C's 090 may add columns at the
    // rebase, so this has to pass — visibly, with the table named.
    const dbPath = path.join(tmpDir, "rehearse-ddl-append.db");
    buildFullyMigratedDb(dbPath);
    const probe = "092_ddl_probe_not_a_real_migration.ts";
    CODE_MIGRATIONS[probe] = (db) => db.exec(`ALTER TABLE calendar_events ADD COLUMN qa_ddl_probe TEXT`);
    try {
      const result = await rehearseAdditiveMigrations(dbPath);
      expect(result.pending).toEqual([probe]);
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.report).toContain("[PASS] pre-existing table and index DDL additive (column-append: calendar_events)");
      expect(result.report).toContain("RESULT: PASS");
    } finally {
      delete CODE_MIGRATIONS[probe];
    }
  });

  it("FAILS when a pending migration rewrites a pre-existing index (review M8, R-D30)", async () => {
    // An index has no additive form: a definition that changed is a rewrite,
    // whatever route it took to get there.
    const dbPath = path.join(tmpDir, "rehearse-ddl-rewrite.db");
    buildFullyMigratedDb(dbPath);
    const probe = "092_ddl_probe_not_a_real_migration.ts";
    CODE_MIGRATIONS[probe] = (db) => {
      db.exec(`DROP INDEX idx_pw_documents_print`);
      db.exec(`CREATE INDEX idx_pw_documents_print ON print_watch_documents(kind)`);
    };
    try {
      const result = await rehearseAdditiveMigrations(dbPath);
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(['DDL changed for index "idx_pw_documents_print"']);
      expect(result.report).toContain("[FAIL] pre-existing table and index DDL additive");
      expect(result.report).toContain("RESULT: FAIL");
    } finally {
      delete CODE_MIGRATIONS[probe];
    }
  });
  // ─── R-E-C9: ADD COLUMN against a table with TRAILING CONSTRAINTS ────────
  // The 092 case, and the one the original prefix test got wrong.

  it("PASSES ADD COLUMN twice on a table whose body ends in a TABLE CONSTRAINT (the 092 case, R-E-C9)", async () => {
    // `earnings_emails` ends `…, error TEXT, UNIQUE(event_id, phase))`, so
    // SQLite splices an added column in BEFORE that constraint, not before the
    // closing paren. The original prefix test therefore reported this genuinely
    // additive migration as a REBUILD — the live-copy rehearsal of 092 failed
    // on exactly this. Two columns, because 092 adds two.
    //
    // REVERT isColumnAppend TO THE PREFIX TEST AND THIS TEST FAILS.
    const dbPath = path.join(tmpDir, "rehearse-ddl-constrained.db");
    buildFullyMigratedDb(dbPath);
    const probe = "092_ddl_probe_not_a_real_migration.ts";
    CODE_MIGRATIONS[probe] = (db) => {
      db.exec(`ALTER TABLE earnings_emails ADD COLUMN qa_probe_message_id TEXT`);
      db.exec(`ALTER TABLE earnings_emails ADD COLUMN qa_probe_response TEXT`);
    };
    try {
      const result = await rehearseAdditiveMigrations(dbPath);
      expect(result.pending).toEqual([probe]);
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.report).toContain(
        "[PASS] pre-existing table and index DDL additive (column-append: earnings_emails)",
      );
      expect(result.report).toContain("RESULT: PASS");
    } finally {
      delete CODE_MIGRATIONS[probe];
    }
  });

  it("FAILS when a pending migration RENAMES a pre-existing column (not additive)", async () => {
    // The item-list comparison must stay a real guard: a renamed column is an
    // edited item, not an inserted one.
    const dbPath = path.join(tmpDir, "rehearse-ddl-rename.db");
    buildFullyMigratedDb(dbPath);
    const probe = "092_ddl_probe_not_a_real_migration.ts";
    CODE_MIGRATIONS[probe] = (db) =>
      db.exec(`ALTER TABLE earnings_emails RENAME COLUMN ai_output_md TO qa_probe_renamed`);
    try {
      const result = await rehearseAdditiveMigrations(dbPath);
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(['DDL changed for table "earnings_emails"']);
      expect(result.report).toContain("RESULT: FAIL");
    } finally {
      delete CODE_MIGRATIONS[probe];
    }
  });

  // ─── isColumnAppend, directly (R-E-C9) ──────────────────────────────────

  describe("isColumnAppend", () => {
    // A table with BOTH hazards: a CHECK carrying a comma inside parens AND
    // trailing table constraints.
    const base =
      `CREATE TABLE t (\n` +
      `  id INTEGER PRIMARY KEY AUTOINCREMENT,\n` +
      `  kind TEXT NOT NULL CHECK (kind IN ('a', 'b')),\n` +
      `  price NUMERIC(10, 2),\n` +
      `  note TEXT,\n` +
      `  UNIQUE(id, kind)\n` +
      `)`;

    it("accepts a column inserted before the trailing table constraint", () => {
      const after = base.replace("  UNIQUE(id, kind)", "  extra TEXT,\n  UNIQUE(id, kind)");
      expect(isColumnAppend(base, after)).toBe(true);
    });

    it("accepts a column appended to a table with NO trailing constraint (today's case, unbroken)", () => {
      const plain = `CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)`;
      expect(isColumnAppend(plain, `CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, extra TEXT)`)).toBe(true);
    });

    it("REJECTS a column inserted BETWEEN two existing columns (review Important 2)", () => {
      // SQLite records the offset of the END of the last column definition
      // (`Table.addColOffset`) and splices an added column exactly there, so
      // `ALTER TABLE … ADD COLUMN` can never produce a mid-table column. Only a
      // table REBUILD can — and a rebuild is the class this check exists to
      // catch. The subsequence walk on its own ACCEPTS this shape; the
      // splice-point clause (`j !== lastColIdx + 1`) is what rejects it.
      //
      // DELETE THAT CLAUSE AND THIS TEST FAILS: `expected true to be false` on
      // the first assertion below.
      const mid = base.replace("  price NUMERIC(10, 2),", "  extra TEXT,\n  price NUMERIC(10, 2),");
      expect(isColumnAppend(base, mid)).toBe(false);

      // ...at the very front of the body, too.
      const front = base.replace(
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  extra TEXT,\n  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      );
      expect(isColumnAppend(base, front)).toBe(false);

      // ...and a legitimate trailing append alongside it does NOT launder the
      // mid-table one: ANY insertion before a surviving column definition is
      // enough to reject the whole change.
      const both = mid.replace("  UNIQUE(id, kind)", "  extra2 TEXT,\n  UNIQUE(id, kind)");
      expect(isColumnAppend(base, both)).toBe(false);
    });

    it("REJECTS a mid-table insertion on a table with NO trailing constraint either", () => {
      const plain = `CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)`;
      expect(
        isColumnAppend(plain, `CREATE TABLE t (id INTEGER PRIMARY KEY, extra TEXT, note TEXT)`),
      ).toBe(false);
      // The same column at the end is the real ADD COLUMN shape and still passes.
      expect(
        isColumnAppend(plain, `CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, extra TEXT)`),
      ).toBe(true);
    });

    it("REJECTS a column inserted AFTER a trailing TABLE CONSTRAINT (fix round 3)", () => {
      // SQLite splices an added column IMMEDIATELY after the last pre-existing
      // column definition — `Table.addColOffset` is that exact byte offset —
      // so in the rewritten DDL a column definition always PRECEDES the table
      // constraints. `…, UNIQUE(id, kind), extra TEXT)` is therefore a
      // hand-written rebuild's shape, not an append, even though `extra TEXT`
      // does sit after the last column definition.
      //
      // WIDEN THE POSITION TEST BACK TO `j <= lastColIdx` AND THIS TEST FAILS:
      // `expected true to be false` on the first assertion below.
      const trailing = base.replace("  UNIQUE(id, kind)", "  UNIQUE(id, kind),\n  extra TEXT");
      expect(isColumnAppend(base, trailing)).toBe(false);

      // ...and between two trailing table constraints is the same class.
      const twoConstraints = base.replace("  UNIQUE(id, kind)", "  UNIQUE(id, kind),\n  CHECK (price > 0)");
      const wedged = twoConstraints.replace("  CHECK (price > 0)", "  extra TEXT,\n  CHECK (price > 0)");
      expect(isColumnAppend(twoConstraints, wedged)).toBe(false);

      // ...while the SAME column one item earlier — immediately after `note
      // TEXT`, where SQLite actually writes it — is a genuine append. Both
      // sides of the boundary, so the test pins the splice point itself.
      const spliced = twoConstraints.replace("  UNIQUE(id, kind)", "  extra TEXT,\n  UNIQUE(id, kind)");
      expect(isColumnAppend(twoConstraints, spliced)).toBe(true);
    });

    it("REJECTS a rebuild that drops a CHECK", () => {
      const rebuilt = base.replace(" CHECK (kind IN ('a', 'b'))", "");
      expect(isColumnAppend(base, rebuilt)).toBe(false);
      // ...even when it also adds a column, which is the sneaky shape.
      expect(isColumnAppend(base, rebuilt.replace("  note TEXT,", "  note TEXT,\n  extra TEXT,"))).toBe(false);
    });

    it("REJECTS a rebuild that REORDERS two existing columns", () => {
      const reordered =
        `CREATE TABLE t (\n` +
        `  id INTEGER PRIMARY KEY AUTOINCREMENT,\n` +
        `  price NUMERIC(10, 2),\n` +
        `  kind TEXT NOT NULL CHECK (kind IN ('a', 'b')),\n` +
        `  note TEXT,\n` +
        `  UNIQUE(id, kind)\n` +
        `)`;
      expect(isColumnAppend(base, reordered)).toBe(false);
    });

    it("REJECTS a changed TABLE CONSTRAINT", () => {
      expect(isColumnAppend(base, base.replace("UNIQUE(id, kind)", "UNIQUE(id)"))).toBe(false);
    });

    it("REJECTS an INSERTED table constraint (ADD COLUMN cannot produce one)", () => {
      const after = base.replace("  UNIQUE(id, kind)", "  CHECK (price > 0),\n  UNIQUE(id, kind)");
      expect(isColumnAppend(base, after)).toBe(false);
    });

    it("REJECTS a dropped column, a renamed column, a renamed table and an unchanged body", () => {
      expect(isColumnAppend(base, base.replace("  note TEXT,\n", ""))).toBe(false);
      expect(isColumnAppend(base, base.replace("note TEXT", "notes TEXT"))).toBe(false);
      expect(isColumnAppend(base, base.replace("CREATE TABLE t (", "CREATE TABLE t2 ("))).toBe(false);
      expect(isColumnAppend(base, base)).toBe(false); // nothing added is not an append
    });

    it("REJECTS a changed trailing table option (WITHOUT ROWID / STRICT)", () => {
      const wr = `CREATE TABLE t (a TEXT, b TEXT, PRIMARY KEY (a)) WITHOUT ROWID`;
      expect(isColumnAppend(wr, `CREATE TABLE t (a TEXT, b TEXT, c TEXT, PRIMARY KEY (a)) WITHOUT ROWID`)).toBe(true);
      expect(isColumnAppend(wr, `CREATE TABLE t (a TEXT, b TEXT, c TEXT, PRIMARY KEY (a))`)).toBe(false);
    });

    it("is immune to `--` comments inside the stored DDL, apostrophes included", () => {
      // 19 real tables carry `--` notes inside CREATE TABLE; collapsing
      // whitespace would fold one over the rest of the body.
      const commented =
        `CREATE TABLE t (\n` +
        `  id INTEGER PRIMARY KEY, -- the desk's own id, don't reuse\n` +
        `  note TEXT,\n` +
        `  UNIQUE(id)\n` +
        `)`;
      const after = commented.replace("  UNIQUE(id)", "  extra TEXT,\n  UNIQUE(id)");
      expect(isColumnAppend(commented, after)).toBe(true);
      expect(isColumnAppend(commented, commented.replace("  note TEXT,\n", ""))).toBe(false);
    });
  });

  describe("splitTopLevelItems", () => {
    it("does not split a column definition on a comma nested in parens or quotes", () => {
      expect(
        splitTopLevelItems(
          `id INTEGER, kind TEXT CHECK (kind IN ('a', 'b')), price NUMERIC(10, 2), ref INTEGER REFERENCES t(a, b), UNIQUE(id, kind)`,
        ),
      ).toEqual([
        "id INTEGER",
        "kind TEXT CHECK (kind IN ('a', 'b'))",
        "price NUMERIC(10, 2)",
        "ref INTEGER REFERENCES t(a, b)",
        "UNIQUE(id, kind)",
      ]);
    });

    it("treats a comma inside a quoted default or a quoted identifier as text", () => {
      expect(splitTopLevelItems(`a TEXT DEFAULT 'x, y', "b, c" TEXT, [d, e] TEXT`)).toEqual([
        "a TEXT DEFAULT 'x, y'",
        '"b, c" TEXT',
        "[d, e] TEXT",
      ]);
    });
  });

  describe("stripSqlComments", () => {
    it("removes line and block comments but never touches quoted text", () => {
      expect(stripSqlComments(`a TEXT, -- don't split me\n b TEXT`).replace(/\s+/g, " ").trim()).toBe(
        "a TEXT, b TEXT",
      );
      expect(stripSqlComments(`a TEXT /* b TEXT */, c TEXT`).replace(/\s+/g, " ").trim()).toBe(
        "a TEXT , c TEXT",
      );
      expect(stripSqlComments(`a TEXT DEFAULT '-- not a comment'`)).toBe(
        `a TEXT DEFAULT '-- not a comment'`,
      );
    });
  });
});
