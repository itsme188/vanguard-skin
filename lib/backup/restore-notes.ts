import fs from "node:fs";
import path from "node:path";

/** File name of the restore notes at the top of the backup home. */
export const RESTORE_NOTES_NAME = "HOW-TO-RESTORE.txt";

/** First line of the notes. Change it whenever the text below changes, so
 *  every backup home gets the new notes on its next live backup. */
export const RESTORE_NOTES_VERSION_LINE = "Portfolio Desk backups: how to restore (notes version 1, 2026-11-16)";

const RESTORE_NOTES = `${RESTORE_NOTES_VERSION_LINE}

WHAT IS IN THIS FOLDER
  recent/              the newest 3 backups, as plain SQLite files (pre-<purpose>-<date>_<time>.db)
  archives/            older backups, one archive per month: <YYYY-MM>.tar.zst
                       with a <YYYY-MM>.sha256 checksum list beside it
  backup-log.jsonl     one line per backup: file, purpose, script, time, size, source
  HOW-TO-RESTORE.txt   this file (rewritten automatically when the steps change)

A file in recent/ is ready to use as it is. A file in an archive must be
unpacked first.

LIST WHAT AN ARCHIVE HOLDS
  zstd -dc --long=31 archives/<YYYY-MM>.tar.zst | tar -tf -

UNPACK ONE BACKUP INTO A SCRATCH FOLDER
Never unpack or copy a backup straight over the live database.
  mkdir -p /tmp/restore
  zstd -dc --long=31 archives/<YYYY-MM>.tar.zst | tar -xf - -C /tmp/restore <member name>

--long=31 is REQUIRED. The archives are written with a long window; without
the flag zstd refuses to decode them.

CHECK THE UNPACKED COPY
  sqlite3 /tmp/restore/<member name> "PRAGMA integrity_check"
It must print exactly: ok
You can also compare its checksum with the line in <YYYY-MM>.sha256:
  shasum -a 256 /tmp/restore/<member name>

PUT IT IN PLACE (only after the check says ok)
  1. Quit every writer: the app, any dev server, any script.
  2. Move the old vanguard.db, vanguard.db-wal and vanguard.db-shm aside
     (rename them; do not delete them). The -wal and -shm files must go
     BEFORE the restored file is put in place, or SQLite would replay the old
     side file into the restored copy.
  3. Put the restored file in place as vanguard.db.
  4. Run: sqlite3 vanguard.db "PRAGMA integrity_check"   (must print ok)
  5. Start the app.

THE LEGACY ARCHIVE
If archives/ holds portfolio-desk-backups-through-2026-11-16.tar.zst, its
member names include folder parts (for example data/backups/<name>.db).
List it first and use the full member name exactly as listed.
`;

/**
 * Writes `<home>/HOW-TO-RESTORE.txt` when it is missing or its first line is
 * not the current version line. Current notes are left alone. Throws on a
 * write failure; the caller decides whether that matters.
 */
export function ensureRestoreNotes(home: string): void {
  const file = path.join(home, RESTORE_NOTES_NAME);
  let firstLine: string | null = null;
  try {
    firstLine = fs.readFileSync(file, "utf8").split("\n")[0];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (firstLine === RESTORE_NOTES_VERSION_LINE) return;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, RESTORE_NOTES);
}
