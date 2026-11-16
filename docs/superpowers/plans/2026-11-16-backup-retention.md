# Backup Retention and Storage Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Database backups stop piling up: one shared helper writes them outside the project folder, older ones roll into a compressed archive automatically, and restores are tested.

**Architecture:** A small `lib/backup/` module owns where backups live, how one is taken, and how old ones roll into a monthly archive. Every script that copies the database calls it; a repo test blocks new hand-rolled copies. Part B (independent) trims build copies after a deploy and adds a storage report.

**Tech Stack:** TypeScript, better-sqlite3 (`VACUUM INTO`), Vitest, the system `tar` (bsdtar 3.5.3) and the `zstd` command-line tool (Homebrew, `/opt/homebrew/bin/zstd`). No new npm packages.

**Spec:** the "Decisions" section below. It records the owner's rulings of 2026-11-16; there is no separate spec file.

## Decisions (owner rulings, 2026-11-16)

1. Backups live **outside the project folder**, so app builds never copy them.
2. Rolling is **automatic**: each new backup of the live database triggers a roll. The newest **3** stay ready to use. Older ones go into that month's archive.
3. Rolling never loses a file. A loose backup is removed only after it is verified inside the archive.
4. **All** existing scripts move to the shared helper in this round.
5. The off-machine copy is a USB drive, unencrypted (owner's choice), refreshed by a manual command.
6. Nothing is scheduled. No launchd job is added by this plan.

## Background (measured 2026-11-16)

- About 32 scripts each took their own full copy of the database before a repair. No code ever removed one. 85 copies had reached 12.6 GiB.
- Consecutive backups are nearly identical. Packed together with zstd's long window (`--long=31`), all 85 came to about 106 MB. Packed one at a time, each is about 39 MB. So the archive must hold many backups in **one** compressed stream.
- Three copy methods were in use. The monthly import skill used a plain `cp` on a live WAL-mode database, which can miss writes still in the `-wal` file.
- The app build copies everything under the project root into `.next/standalone`. With backups inside `data/`, that meant a second full copy of every backup.
- A one-off archive from that day already exists: `data/backup-archives/portfolio-desk-backups-through-2026-11-16.tar.zst`, with a `.sha256` list and `HOW-TO-RESTORE.txt`. Three loose backups remain in `data/backups/`.

## Global Constraints

- Run every command from the repo root of the worktree. Tests: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <path>`.
- The worktree needs its own `node_modules`: run `npm ci` once before Task 1. This installs the locked packages only.
- No new npm dependencies.
- Never open, copy, or roll the live database in a test. Tests use `:memory:` databases and directories under `os.tmpdir()`, and always pass `env` explicitly.
- Never run `VACUUM`, a checkpoint, or any write against the live database as part of this work. `VACUUM INTO` reads only.
- Never add `outputFileTracingExcludes` to `next.config.ts` (see CLAUDE.md, Electron Build).
- The repo is public. No real figure, account identifier, or database content appears in code, tests, or docs.
- `rm -rf` only with absolute paths.
- Commit messages go in a temp file: `git commit -F <file>`.
- Backup file names keep the `pre-<purpose>-` prefix, so old and new names sort and read alike.
- Constant names used across tasks: `RECENT_BACKUPS_KEPT = 3`, `DEFAULT_BACKUP_DIRNAME = "portfolio-desk-backups"`, `ZSTD_LEVEL = 10`, `ZSTD_LONG = 31`.

## Review Focus

Conditions no happy-path test covers, most likely first. Each has a test in the task named.

1. **`zstd` is missing or not on `PATH`** (launchd and cron run with a bare `PATH`). The backup must still be taken; the roll is skipped with a one-line warning; no loose file is removed. (Task 3)
2. **A roll is interrupted** between writing the new archive and removing the loose file, or before the rename. The next roll must finish the job without duplicating a member or losing one, and must ignore a leftover `.new` file. (Task 3)
3. **The disk fills during `VACUUM INTO`.** The partial file is removed, `takeBackup` throws, and the calling script stops before it changes anything. (Task 2)
4. **The backup folder cannot be created or written.** `takeBackup` throws before the caller mutates the database. It never falls back to a folder inside the project. (Task 2)
5. **Two backups or two rolls at once** (two agents share this Mac). A name collision refuses and writes nothing; a second roll finds the lock held and skips. (Tasks 2 and 3)

Also pinned: a rehearsal copy is never rolled (Task 2); the USB drive is FAT32 with a 4 GB per-file cap (Task 4).

## File Structure

| File | Responsibility |
|---|---|
| `lib/backup/backup-home.ts` | Where backups live; file-name and stamp rules |
| `lib/backup/take-backup.ts` | Take one verified backup; log it; trigger the roll |
| `lib/backup/archive.ts` | Add files to a monthly archive; verify; read back one member |
| `lib/backup/roll.ts` | Decide what rolls; lock; call the archive; remove verified loose files |
| `lib/backup/storage-report.ts` | Pure size and threshold calculations (Part B) |
| `scripts/backup-db.ts` | Command: take a backup now |
| `scripts/backup-restore-test.ts` | Command: restore drill |
| `scripts/backup-usb-sync.ts` | Command: refresh the USB copy |
| `scripts/storage-report.ts` | Command: storage report and scratch trim (Part B) |
| `tests/backup/*.test.ts` | Unit tests for the module |
| `tests/repo/no-handrolled-db-backups.test.ts` | Guard against new hand-rolled copies |

Folder layout under the backup home:

```
~/portfolio-desk-backups/
  recent/            loose .db backups, at most 3 after a roll
  archives/          YYYY-MM.tar.zst + YYYY-MM.sha256, plus the legacy 2026-11-16 archive
  backup-log.jsonl   one line per backup taken
  HOW-TO-RESTORE.txt
```

---

# Part A: Backups

### Task 1: Backup home and naming

**Files:**
- Create: `lib/backup/backup-home.ts`
- Test: `tests/backup/backup-home.test.ts`

**Interfaces:**
- Consumes: `EnvLike`, `resolveDbPath` from `lib/db/db-path.ts`.
- Produces:
  - `RECENT_BACKUPS_KEPT = 3`, `DEFAULT_BACKUP_DIRNAME = "portfolio-desk-backups"`
  - `resolveBackupHome(env?: EnvLike, homeDir?: string): string` — `env.VANGUARD_BACKUP_DIR` if set, else `<homeDir>/portfolio-desk-backups`. `homeDir` defaults to `os.homedir()`.
  - `backupPaths(home: string): { recent: string; archives: string; log: string; rollLock: string }` — `recent/`, `archives/`, `backup-log.jsonl`, `.roll.lock`.
  - `backupStamp(now: Date): string` — Eastern wall clock, `YYYY-MM-DD_HH-MM-SS`. Move the body from `scripts/repair-option-exercise-basis.ts:493-507` unchanged.
  - `backupFileName(purpose: string, now: Date): string` — `pre-<purpose>-<stamp>.db`. A leading `pre-` in `purpose` is not doubled. `purpose` must match `/^[a-z0-9][a-z0-9-]*$/`; anything else throws.
  - `archiveMonth(fileName: string): string | null` — the `YYYY-MM` read from the stamp in a backup file name; `null` when the name carries no date.
  - `isLiveDatabase(dbPath: string, env?: EnvLike, cwd?: string): boolean` — true when `path.resolve(dbPath)` equals `path.resolve(resolveDbPath(env, cwd))`.

- [ ] **Step 1: Write the failing tests**

```ts
it("uses VANGUARD_BACKUP_DIR when set", () => {
  expect(resolveBackupHome({ VANGUARD_BACKUP_DIR: "/tmp/x" }, "/Users/u")).toBe("/tmp/x");
});
it("defaults to a folder in the home directory, never inside the project", () => {
  expect(resolveBackupHome({}, "/Users/u")).toBe("/Users/u/portfolio-desk-backups");
});
it("stamps in Eastern time", () => {
  expect(backupStamp(new Date("2026-11-16T15:27:57Z"))).toBe("2026-11-16_10-27-57");
});
it("names a backup and never doubles the prefix", () => {
  const now = new Date("2026-11-16T15:27:57Z");
  expect(backupFileName("etf-type-repair", now)).toBe("pre-etf-type-repair-2026-11-16_10-27-57.db");
  expect(backupFileName("pre-etf-type-repair", now)).toBe("pre-etf-type-repair-2026-11-16_10-27-57.db");
});
it("rejects a purpose that is not a plain slug", () => {
  expect(() => backupFileName("../x", new Date())).toThrow();
  expect(() => backupFileName("a b", new Date())).toThrow();
});
it("reads the archive month from old and new name styles", () => {
  expect(archiveMonth("pre-x-2026-11-16_10-27-57.db")).toBe("2026-11");
  expect(archiveMonth("pre-x-2026-10-27T03-54-23.369Z.db")).toBe("2026-10");
  expect(archiveMonth("rehearse-089.db")).toBeNull();
});
it("knows the live database from a copy", () => {
  const env = { VANGUARD_DB_DIR: "/d" };
  expect(isLiveDatabase("/d/vanguard.db", env, "/repo")).toBe(true);
  expect(isLiveDatabase("/tmp/rehearsal.db", env, "/repo")).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/backup/backup-home.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the functions above in `lib/backup/backup-home.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backup): backup home and naming rules`.

### Task 2: Take one verified backup

**Files:**
- Create: `lib/backup/take-backup.ts`
- Test: `tests/backup/take-backup.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `rollOldBackups` and `RollResult` from Task 3 (`lib/backup/roll.ts`). **Build Task 3 before this task.** The roll is still injectable so these tests can pass a spy.
- Produces:

```ts
export interface TakeBackupOptions {
  purpose: string;
  now?: Date;
  env?: EnvLike;
  cwd?: string;
  /** Required for a `:memory:` database; otherwise derived. */
  backupDir?: string;
  /** Script name for the log line. Defaults to path.basename(process.argv[1] ?? ""). */
  script?: string;
  /** Injected roll; defaults to rollOldBackups. Tests pass a spy. */
  roll?: (home: string) => Promise<RollResult> | RollResult;
  log?: (line: string) => void;
}
export interface BackupResult { path: string; sizeBytes: number; rolled: boolean }
export function takeBackup(db: Database.Database, opts: TakeBackupOptions): Promise<BackupResult>;
```

Rules the implementation must follow:
- Destination: `opts.backupDir` if given. Else, when `isLiveDatabase(db.name)`, `<home>/recent`. Else `<dirname(db.name)>/backups` (a rehearsal copy keeps its backups beside it).
- A `:memory:` database with no `backupDir` throws.
- If the target file exists, throw and write nothing. Never reuse an existing file.
- `VACUUM INTO ?` to `<target>.partial`, then open the result read-only and run `PRAGMA integrity_check`; on `ok`, rename to the target. On any failure, delete the `.partial` file and throw.
- Append one JSON line to `backup-log.jsonl` only for a backup in `<home>/recent`: `{ file, purpose, script, takenAt (ISO), sizeBytes, migrations }`, where `migrations` is `SELECT count(*) FROM schema_migrations` read from the new file (`null` if the table is absent).
- Call `roll(home)` only for a backup in `<home>/recent`. A roll that throws is caught: log `backup taken; roll skipped: <message>` and return `rolled: false`. A failed roll never fails the backup.

- [ ] **Step 1: Write the failing tests.** Each uses a `:memory:` or temp-file database and a temp home.

```ts
it("writes a valid database copy and returns its path and size");
it("refuses when the target already exists and writes nothing");            // Review Focus 5
it("throws for :memory: with no backupDir");
it("puts a live-database backup in <home>/recent and logs one line");
it("puts a rehearsal copy's backup beside the copy, logs nothing, never rolls");
it("removes the partial file and throws when VACUUM INTO fails");            // Review Focus 3: point backupDir at a path whose parent is a regular file
it("throws before returning when the home cannot be created");               // Review Focus 4: VANGUARD_BACKUP_DIR under a regular file
it("still returns the backup when the roll throws, with rolled false");      // Review Focus 1
```

For the "live database" cases, create a temp-file database at `<tmp>/vanguard.db` and pass `env: { VANGUARD_DB_DIR: <tmp>, VANGUARD_BACKUP_DIR: <tmp2> }`.

- [ ] **Step 2: Run** `npx vitest run tests/backup/take-backup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `takeBackup`.
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backup): takeBackup with integrity check and log`.

### Task 3: Monthly archive and automatic roll

**Files:**
- Create: `lib/backup/archive.ts`, `lib/backup/roll.ts`
- Test: `tests/backup/archive.test.ts`, `tests/backup/roll.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:

```ts
// archive.ts
export const ZSTD_LEVEL = 10;
export const ZSTD_LONG = 31;
export function findZstd(env?: EnvLike): string | null;   // PATH lookup, then /opt/homebrew/bin/zstd, then /usr/local/bin/zstd
export function readManifest(manifestPath: string): Map<string, string>;   // member name -> sha256
export function sha256File(filePath: string): Promise<string>;
/** Adds files to the archive (creating it if absent) and rewrites the manifest. Atomic: writes <archive>.new, verifies, renames. */
export function addToArchive(archivePath: string, manifestPath: string, files: string[], zstd: string): Promise<void>;
/** Writes one member to destPath. Throws if the member is not in the archive. */
export function extractMember(archivePath: string, member: string, destPath: string, zstd: string): Promise<void>;

// roll.ts
export interface RollResult { rolled: string[]; kept: string[]; skipped?: string }
export function rollOldBackups(home: string, opts?: { keep?: number; env?: EnvLike; now?: Date; log?: (l: string) => void }): Promise<RollResult>;
```

How `addToArchive` works (the tests fix the behavior; this fixes the method):
- Member names are bare file names. A manifest line is `<sha256>  <name>`.
- A file whose name and checksum are already in the manifest is skipped. Same name with a different checksum throws.
- Build `<archive>.new` as one zstd stream: the old archive's members first, then the new files. With an old archive:
  `zstd -dc --long=31 old | tar -cf - @- -C <dir> <names...> | zstd -10 -T0 --long=31 -o <archive>.new`
  Without one: `tar -cf - -C <dir> <names...> | zstd ...`. Always set `COPYFILE_DISABLE=1` and pass `--no-mac-metadata`, or macOS adds a `._` entry per file.
- `tar ... @-` (re-read an archive from standard input) is a bsdtar feature. If the round-trip test in Step 1 shows it does not work on this Mac's bsdtar 3.5.3, fall back to extracting the old archive into a temp folder under the archives directory and re-packing; the tests do not change.
- Verify before the rename: list `<archive>.new` (`zstd -dc --long=31 | tar -tf -`) and require the member list to equal old members plus new names, in order; then extract each **new** member to a temp file and require its checksum to equal the source file's. A full listing also proves the whole stream decompresses.
- Write `<manifest>.new`, then rename the archive, then the manifest. Remove temp files in a `finally`.

How `rollOldBackups` works:
- No `zstd`: return `{ rolled: [], kept: [...], skipped: "zstd not found" }` and remove nothing.
- Lock: `mkdir <home>/.roll.lock`. If it exists and is younger than 30 minutes, return `skipped: "another roll is running"`. If older, remove it and continue. Remove the lock in a `finally`.
- Candidates: `*.db` files in `recent/`, sorted by modified time. The newest `keep` (default `RECENT_BACKUPS_KEPT`) stay. The rest roll.
- Group the rest by `archiveMonth(name)`; a name with no date uses the month of its modified time. Call `addToArchive(<archives>/<YYYY-MM>.tar.zst, <archives>/<YYYY-MM>.sha256, files, zstd)` per month.
- After `addToArchive` returns for a month, remove each loose file whose checksum is now in that month's manifest. Remove any `-wal` and `-shm` side files with the same base name.
- Ignore files ending in `.new` or `.partial` older than 30 minutes by deleting them at the start of a roll.

- [ ] **Step 1: Write the failing tests.** Tests that need the real tools use `it.skipIf(findZstd() === null)`.

```ts
// archive.test.ts
it("round-trips: every member comes back byte-identical");
it("adding to an existing archive keeps the old members and adds the new ones");
it("skips a file already in the manifest with the same checksum");
it("throws on the same name with a different checksum and leaves the archive untouched");
it("writes no ._ metadata members");
it("leaves no .new or temp files behind on success or on failure");
it("three near-identical 5 MB files compress to less than twice one file's compressed size"); // proves the long window is on

// roll.test.ts
it("keeps the newest 3 and rolls the rest");
it("does nothing with 3 or fewer");
it("files each backup under its own month");
it("removes a loose file only after it is in the manifest");
it("is skipped, removing nothing, when zstd is not found");                          // Review Focus 1: env PATH empty, stub findZstd via opts.env
it("finishes an interrupted roll: file already archived, loose copy still present"); // Review Focus 2
it("ignores and cleans a stale .new file");                                          // Review Focus 2
it("skips when the lock is held and takes over a stale lock");                       // Review Focus 5
it("never touches a file outside <home>/recent");
```

- [ ] **Step 2: Run** `npx vitest run tests/backup`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `archive.ts`, then `roll.ts`. Use `child_process.spawn` with argument arrays, never a shell string.
- [ ] **Step 4: Run** again. Expected: PASS, with no test skipped on this Mac.
- [ ] **Step 5: Commit** `feat(backup): monthly archive and automatic roll`.

### Task 4: Commands

**Files:**
- Create: `scripts/backup-db.ts`, `scripts/backup-restore-test.ts`, `scripts/backup-usb-sync.ts`
- Modify: `package.json` scripts block (add three lines)
- Test: `tests/scripts/backup-commands.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces these `package.json` scripts:
  - `"backup": "tsx scripts/backup-db.ts"` — `npm run backup -- --purpose <slug> [--db <path>]`. Opens the database **read-only**, calls `takeBackup`, prints the path. With no `--db` it uses `resolveDbPath()`.
  - `"backup:restore-test": "tsx scripts/backup-restore-test.ts"` — picks the newest member of the newest archive (falls back to the newest file in `recent/`), extracts it to a temp folder, checks its checksum against the manifest, runs `PRAGMA integrity_check`, prints table count and `schema_migrations` count, deletes the temp copy, exits 0 on success and 1 on any failure.
  - `"backup:usb": "tsx scripts/backup-usb-sync.ts"` — `npm run backup:usb -- --volume "/Volumes/<name>"`. Copies every file in `archives/` plus `HOW-TO-RESTORE.txt` into `<volume>/Portfolio Desk Backups/` when missing or different, verifies each copy by checksum, writes `<home>/.usb-last-sync` holding the ISO time. Never deletes anything on the drive. No default volume: with no `--volume` it lists mounted volumes and exits 2.
- Each script exports its core as a function taking injected paths so the test never touches the real home or a real drive: `runRestoreTest(home, zstd)`, `syncToVolume(home, volumeDir)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("restore test passes on a good archive and reports counts");
it("restore test fails with exit data when a member's checksum does not match the manifest");
it("usb sync copies new archives and verifies them");
it("usb sync skips a file that is already identical");
it("usb sync refuses a file larger than 4 GB with a message naming FAT32");   // stub the size check: syncToVolume takes a maxFileBytes option, default 4 * 1024**3 - 1
it("usb sync refuses a volume folder that does not exist");
```

- [ ] **Step 2: Run** `npx vitest run tests/scripts/backup-commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three scripts and add the `package.json` lines.
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backup): backup, restore-test and usb commands`.

### Task 5: Move every script to the helper

Four groups with no shared files. They may run as parallel subagents after Task 2 lands. Each group ends with its own test run and commit.

The change is the same everywhere: delete the script's own backup code and call `await takeBackup(db, { purpose: "<slug>" })`, printing the returned path where the script printed one before. Keep each script's existing rule for **when** it backs up (most do so only on `--apply`). Where a script must stay synchronous, make its `main` async rather than adding a sync variant of the helper.

Purpose slugs are the old name without its stamp, for example `pre-ah-close-repair`, `pre-etf-type-repair`, `vanguard-pre-v2-recompute` becomes `pre-v2-recompute`.

**Group 5a — importers of `ensureBackup`** (`scripts/rebuild-ibkr-ledger.ts:233-247` and its 12 importers):
`repair-ah-closes.ts`, `repair-split-basis-2024-year-end.ts`, `repair-reconcile-stripped-actuals.ts`, `repair-roth-december-snapshots.ts`, `repair-december-snapshots.ts`, `repair-earnings-preview-audit.ts`, `backfill-prices-from-ohlcv.ts`, `repair-security-type-corruption.ts`, `repair-gift-month-returns.ts`, `repair-closed-day-tws-rows.ts`, `repair-fred-revision-second-date-rows.ts`, `repair-duplicate-option-securities.ts`.
- Remove `ensureBackup` and `assertValidBackupFile` from `rebuild-ibkr-ledger.ts`. Its "reuse today's valid file" behavior goes away on purpose: stamps are now to the second, so a dry run followed by an apply takes two backups, and the roll absorbs the extra one. Update `tests/scripts/rebuild-ibkr-ledger.test.ts` to match.

**Group 5b — `takeFreshBackup`:** `repair-ibkr-mixed-trade-splits.ts`, `repair-option-exercise-basis.ts`.
- Remove `backupStamp`, `backupPathFor`, `takeFreshBackup` from both. Update `tests/scripts/repair-option-exercise-basis.test.ts` and `tests/scripts/repair-ibkr-mixed-trade-splits.test.ts`; stamp tests now live in Task 1.

**Group 5c — local `backupDatabase()` or inline `VACUUM INTO`:**
`repair-mistyped-option-legs.ts`, `repair-split-basis-audit.ts`, `repair-goog-presplit-basis.ts`, `repair-smh-presplit-basis.ts`, `repair-etf-types.ts`, `repair-confirmed-donation-leg-amounts.ts`, `repair-requeue-failed-enrichment.ts`, `repair-buy-sign-post-april.ts`, `assign-donation-lots-by-method.ts`, `repair-option-attached-levels.ts`, `repair-inkind-transfer-fmv.ts`, `repair-inkind-transfer-lots.ts`, `repair-missing-external-flows.ts`, `repair-empty-enrichments.ts`, `repair-donated-lot-basis.ts`.

**Group 5d — the three that wrote elsewhere:**
- `recompute-tax-lots-v2.ts:259-268` (better-sqlite3 `.backup()`),
- `backfill-ibkr-trade-direction.ts:40-42` (wrote `*.before-direction-<ms>.bak` straight into `data/`),
- `oneoff-funda-bogeys-2026-11-04.ts:103-104` (wrote `*.pre-funda-oneoff-*.bak` into `data/`).

Out of scope, and listed in Task 6's allowlist with the reason: sandbox and evaluation copies (`scripts/coord/sandbox.sh`, `qa/sandbox.sh`, `scripts/chat-eval/build-eval-db.ts`, `scripts/seed-demo.ts`, the `qa-fix-findings` skill). They are working copies, not backups, and each already cleans up after itself.

Do not change what any script repairs. Do not change how a script picks its database (`REPAIR_DB_PATH`, `--db`); `tests/repo/repair-scripts-rehearsable.test.ts` must still pass unchanged.

For each group:
- [ ] **Step 1:** Update the tests that pin the old backup functions (named above) to expect `takeBackup` behavior; where a script had no backup test, add none.
- [ ] **Step 2:** Run `npx vitest run tests/scripts`. Expected: the edited tests FAIL.
- [ ] **Step 3:** Make the replacement in each file of the group.
- [ ] **Step 4:** Run `npx vitest run tests/scripts tests/repo/repair-scripts-rehearsable.test.ts` and `npx tsc --noEmit`. Expected: PASS, no type errors.
- [ ] **Step 5:** Commit `refactor(scripts): group 5x uses the shared backup helper`.

### Task 6: Guard test and written rules

**Files:**
- Create: `tests/repo/no-handrolled-db-backups.test.ts`
- Modify: `.claude/skills/import-monthly-statements/SKILL.md:18`, `docs/reference/earnings-pipeline.md:1088-1089`, `CLAUDE.md` (Safety Rules), `docs/DECISIONS.md` (new entry), `docs/reference/data-integrity.md` (new short section)

**Interfaces:**
- Consumes: the finished Task 5.
- Produces: a failing suite whenever a file under `scripts/`, `lib/`, `electron/`, `qa/*.sh`, or `.claude/skills/**/SKILL.md` contains `VACUUM INTO`, `.backup(`, `copyFileSync(` on a line that also names `vanguard.db` or a `dbPath` variable, or the text `cp data/vanguard.db`, unless the file is in `ALLOWED` with a written reason.

- [ ] **Step 1: Write the guard test.** Follow the shape of `tests/repo/repair-scripts-rehearsable.test.ts`. `ALLOWED` is a `Map<string, string>` of repo-relative path to reason, holding `lib/backup/take-backup.ts` and the five out-of-scope files from Task 5. Add a second test: every `ALLOWED` path exists and still contains a match (so the list cannot rot).
- [ ] **Step 2: Run** `npx vitest run tests/repo/no-handrolled-db-backups.test.ts`. Expected: FAIL on `SKILL.md:18` and the earnings-pipeline runbook lines if those live in a scanned path; otherwise PASS already.
- [ ] **Step 3: Change the written instructions.**
  - Import skill Phase 0, step 1 becomes: `npm run backup -- --purpose pre-{YYYYMM}-import` — print the path.
  - `earnings-pipeline.md` §Print-watch 089 runbook: the backup line becomes `npm run backup -- --purpose pre-089`. The rehearsal copy line stays, pointed at a path outside `data/`.
  - `CLAUDE.md` Safety Rules, one new bullet: "Database backups go through `takeBackup` (`lib/backup/`) or `npm run backup -- --purpose <slug>`. Never `cp` the live database and never write a copy under `data/`. Backups live in `~/portfolio-desk-backups`; the newest 3 stay loose and older ones roll into a monthly archive. Guard: `tests/repo/no-handrolled-db-backups.test.ts`."
  - `docs/DECISIONS.md`: a dated entry with the six rulings from this plan's Decisions section and the measured reason (one stream of many backups compresses about 99%).
  - `docs/reference/data-integrity.md`: a short "Backups and restore" section — where backups live, the three commands, the restore steps, and "run `npm run backup:restore-test` after any month in which backups rolled".
- [ ] **Step 4: Run** `bash scripts/verify.sh changed --base main`. Expected: PASS.
- [ ] **Step 5: Commit** `test(repo): guard against hand-rolled database backups; docs`.

### Task 7: Move today's files into the new home (owner go-ahead required)

This step changes files on the owner's machine, outside the repo. Do it only after the branch has landed on `main` and the owner says to proceed. It needs no deploy: the packaged app takes no backups.

- [ ] **Step 0:** Record the starting state before moving anything: run `npm run storage:report` and `npm run backup:restore-test`, and keep both outputs.
- [ ] **Step 1:** List the REAL current contents of `data/backups/` and `data/backup-archives/` at that moment (`ls -la` on both; more files may have appeared since this plan was written) and show the owner that exact list.
- [ ] **Step 2:** Create `~/portfolio-desk-backups/recent` and `~/portfolio-desk-backups/archives`. Copy the loose backups into `recent/`, and the legacy archive and its `.sha256` into `archives/`. Use `cp -pX`: the roll and the restore drill rank files by modified time, and without `-p` the copied legacy files would look newest (the loose ones in copy order, and the legacy archive newer than any monthly one). Do not copy the legacy `HOW-TO-RESTORE.txt`: the code now writes the current one at the home's top level on the next live backup (Step 6).
- [ ] **Step 3:** Verify every copy by checksum against its source.
- [ ] **Step 4:** Run `npm run backup:restore-test`. Expected: exit 0.
- [ ] **Step 5:** With the owner's confirmation of the list, remove the originals from `data/backups/` and `data/backup-archives/`, then the two empty folders.
- [ ] **Step 6:** Run `npm run backup -- --purpose pre-retention-cutover` once. Expected: a fourth file appears in `recent/`, then the roll leaves 3 and creates `archives/2026-11.tar.zst`.
- [ ] **Step 7:** With the USB drive connected, run `npm run backup:usb -- --volume "/Volumes/<name>"`. Expected: the new monthly archive is copied and verified.

---

# Part B: Build copies and visibility

Independent of Part A. It can be built in parallel or later.

### Task 8: Remove build copies after a successful deploy

**Files:**
- Modify: `scripts/coord/deploy.sh` (one new function, one call after the post-verify succeeds), `electron-builder.yml:33-34` (stale comment)
- Test: `tests/coord/deploy-standalone-cleanup.test.ts`

**Interfaces:**
- Produces: `cleanup_standalone_copies()` in `deploy.sh`.

Rules:
- It runs only after pack, gate, install, and post-verify have all succeeded. A failed deploy leaves `.next/standalone` whole for diagnosis.
- It removes exactly two folders: `$MAIN_CHECKOUT/.next/standalone/data` and `$MAIN_CHECKOUT/.next/standalone/qa`.
- Before each removal it resolves the real path and requires it to start with the real path of `$MAIN_CHECKOUT/.next/standalone/`. A symlink pointing elsewhere is refused and logged.
- A missing folder is logged and skipped. A removal error is logged as a warning and never changes the deploy's exit code.
- It runs while the `deploy` lock is still held.
- `electron-builder.yml`: reword the comment that calls `outputFileTracingExcludes` "the first layer". The filter in that file plus `scripts/verify-bundle.js` are the only layers.

- [ ] **Step 1: Write the failing tests** using the existing `PD_DEPLOY_CHAIN_DIR` seam (stub `pack.sh`, `gate.sh`, `install.sh`), as the other `tests/coord` deploy tests do.

```ts
it("removes .next/standalone/data and qa after a successful deploy");
it("leaves both folders when the gate fails");
it("leaves both folders when install fails");
it("refuses a data folder that is a symlink to somewhere outside standalone");
it("a removal error is a warning and the deploy still exits 0");
it("never touches the project's own data folder");
```

- [ ] **Step 2: Run** `npx vitest run tests/coord/deploy-standalone-cleanup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the function and its one call.
- [ ] **Step 4: Run** `npx vitest run tests/coord`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): remove build copies of data and qa after a good deploy`.

### Task 9: Storage report

**Files:**
- Create: `lib/backup/storage-report.ts`, `scripts/storage-report.ts`
- Modify: `package.json` (`"storage:report": "tsx scripts/storage-report.ts"`), `.claude/session-end.md` (one line: run the report and mention a warning)
- Test: `tests/backup/storage-report.test.ts`

**Interfaces:**
- Produces:

```ts
export const LOW_FREE_SPACE_BYTES = 25 * 1024 ** 3;
export const SCRATCH_MAX_AGE_DAYS = 7;
export const USB_STALE_DAYS = 35;
export interface CategorySize { name: string; path: string; bytes: number }
export interface TrimCandidate { path: string; bytes: number; ageDays: number }
export interface StorageReport {
  freeBytes: number; lowFreeSpace: boolean;
  categories: CategorySize[];
  trimCandidates: TrimCandidate[];
  usbLastSync: string | null; usbStale: boolean;
}
export function buildStorageReport(input: { repoRoot: string; backupHome: string; freeBytes: number; now: Date }): StorageReport;
export function trimScratch(candidates: TrimCandidate[], repoRoot: string): { removed: number; bytes: number };
```

- Categories: backup home, `data`, `.next`, `dist`, `qa/findings`, `qa/tmp`, `.playwright-mcp`, and each sibling worktree's `node_modules` and `.next` (from `git worktree list`).
- Trim candidates: files older than `SCRATCH_MAX_AGE_DAYS` under `qa/tmp` and `.playwright-mcp` only.
- The command prints the report and changes nothing. `--trim-scratch` removes the trim candidates; `trimScratch` refuses any path that does not resolve under `<repoRoot>/qa/tmp` or `<repoRoot>/.playwright-mcp`.
- `usbStale` is true when `.usb-last-sync` is missing or older than `USB_STALE_DAYS`.

- [ ] **Step 1: Write the failing tests**

```ts
it("flags low free space under 25 GiB and not at 25 GiB");
it("lists only files older than 7 days as trim candidates, and only in the two scratch folders");
it("trimScratch refuses a path outside the two scratch folders");
it("reports the usb copy as stale when the marker is missing or older than 35 days");
it("sizes a category that does not exist as 0 without throwing");
```

- [ ] **Step 2: Run** `npx vitest run tests/backup/storage-report.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(storage): storage report and scratch trim command`.

---

## Finishing

- [ ] `bash scripts/verify.sh full --base main` and `npx tsc --noEmit`. Report the test count and result.
- [ ] `npx next build` in the worktree (seat a migrated database copy in the worktree's `data/` first; see CLAUDE.md, Dev Server Gotchas).
- [ ] Land under the `integration` lock per `docs/reference/coordination.md`. No app deploy is needed for Part A. Task 8 takes effect at the next `npm run deploy`; check afterward that `.next/standalone/data` is gone and the installed app still answers on port 3099.
- [ ] Task 7, with the owner's go-ahead.

## What this plan does not do

- It adds no schedule. Backups are taken when a script or a person takes one.
- It does not change what any repair script repairs, or how one picks its database.
- It does not touch QA evidence under `qa/findings`; no retention period has been ruled.
- It does not encrypt the archive or send it anywhere.
- It does not retire any worktree.
