/**
 * Database backups go through `takeBackup` (lib/backup/take-backup.ts), never
 * a hand-rolled copy (plan 2026-11-16-backup-retention).
 *
 * About 32 scripts each took their own full copy of the database before a
 * repair, three different ways, and nothing ever removed one. One of the ways
 * was a plain `cp` of a live WAL-mode database, which can miss writes still in
 * the `-wal` file. Backups now come from one helper that writes outside the
 * project folder and rolls old ones into a monthly archive.
 *
 * Scope: every file under scripts/, lib/ and electron/, `qa/*.sh`, and every
 * `.claude/skills/<name>/SKILL.md`. Whole-line comments in code are skipped
 * (prose that mentions a backup is not one); markdown is scanned in full. A hit is one of: `VACUUM INTO`, `.backup(`,
 * `copyFileSync(` on a statement that names `vanguard.db` or a `dbPath`
 * variable, or the text `cp data/vanguard.db`. A statement that writes to
 * `/tmp/` is a throwaway rehearsal copy, not a backup, so it is not a hit
 * (this is how "Rehearse first: sqlite3 <db> VACUUM INTO '/tmp/...'" help
 * text passes). Anything else needs an ALLOWED entry with a written reason.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Repo-relative path -> why a copy of the database is legitimate there. */
const ALLOWED = new Map<string, string>([
  ["lib/backup/take-backup.ts", "The shared helper itself: the one place a backup is written."],
  ["scripts/coord/sandbox.sh", "Working copy for the coordination sandbox, not a backup: a VACUUM INTO of a source database the script only reads; the sandbox removes it on teardown."],
  ["qa/sandbox.sh", "Working copy for the QA sandbox, not a backup: snapshots the live database to boot a throwaway app on it; the sandbox removes it on teardown."],
  ["scripts/chat-eval/build-eval-db.ts", "Builds an evaluation database from a read-only source; the output is a disposable test fixture, not a backup."],
  [".claude/skills/qa-fix-findings/SKILL.md", "Instructions for making a verification copy inside a throwaway fix worktree (never the live data folder); the worktree is deleted afterwards."],
  ["scripts/migrate-089-document-identity.ts", "Historical one-off, already executed; its --live gate checks for a backup under data/backups by design."],
  ["scripts/seed-demo.ts", "Only the `copyFileSync(DEMO_DB_PATH, PROD_DB_PATH)` that puts the demo database over the live path (not a backup). The safety copy before it goes through takeBackup. The guard allows per file, so a new hand-rolled backup added to this file would NOT be caught."],
]);

const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs|sh|py)$/;

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), accept, out);
    } else if (entry.isFile() && accept(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Repo-relative paths of every scanned file. */
function scannedFiles(): string[] {
  const abs: string[] = [];
  for (const d of ["scripts", "lib", "electron"]) abs.push(...walk(path.join(ROOT, d), (n) => CODE_EXT.test(n)));
  abs.push(...walk(path.join(ROOT, "qa"), (n) => n.endsWith(".sh")).filter((p) => path.dirname(p) === path.join(ROOT, "qa")));
  const skills = path.join(ROOT, ".claude", "skills");
  if (existsSync(skills)) {
    for (const d of readdirSync(skills)) {
      const p = path.join(skills, d, "SKILL.md");
      if (existsSync(p) && statSync(p).isFile()) abs.push(p);
    }
  }
  return abs.map((p) => path.relative(ROOT, p).split(path.sep).join("/")).sort();
}

const HIT = /VACUUM\s+INTO|\.backup\(|cp\s+data\/vanguard\.db/i;
const COPY_FILE = /copyFileSync\(/;
const NAMES_DB = /vanguard\.db|db_?path/i;
/** A whole-line comment in code: prose that talks about a backup is not a backup. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

/** A statement is the hit line plus following lines up to the first one ending in `;` (max 8). */
function statementAt(lines: string[], i: number): string {
  const parts: string[] = [];
  for (let j = i; j < Math.min(lines.length, i + 8); j++) {
    parts.push(lines[j]);
    if (/;\s*$/.test(lines[j])) break;
  }
  return parts.join("\n");
}

/** Returns "line N: text" for each hand-rolled backup in `src`. */
export function findHandRolledBackups(src: string, skipComments = true): string[] {
  const lines = src.split("\n");
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (skipComments && COMMENT_LINE.test(line)) return;
    const stmt = statementAt(lines, i);
    const matched =
      HIT.test(line) || (COPY_FILE.test(line) && NAMES_DB.test(stmt));
    if (!matched) return;
    if (/\/tmp\//.test(stmt)) return; // throwaway rehearsal copy
    hits.push(`line ${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  return hits;
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("no hand-rolled database backups", () => {
  it("scans the expected places", () => {
    const files = scannedFiles();
    expect(files).toContain("lib/backup/take-backup.ts");
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
    expect(files.some((f) => f.startsWith("electron/"))).toBe(true);
    expect(files.some((f) => /^qa\/[^/]+\.sh$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith("/SKILL.md"))).toBe(true);
  });

  it("no file outside ALLOWED copies the database by hand (use takeBackup)", () => {
    const offenders: string[] = [];
    for (const rel of scannedFiles()) {
      if (ALLOWED.has(rel)) continue;
      for (const h of findHandRolledBackups(read(rel), !rel.endsWith(".md"))) offenders.push(`${rel} ${h}`);
    }
    expect(
      offenders,
      "Hand-rolled database backup. Use takeBackup (lib/backup/take-backup.ts) or `npm run backup -- --purpose <slug>`.",
    ).toEqual([]);
  });

  it("every ALLOWED path exists and still contains a hit, so the list cannot rot", () => {
    const stale = [...ALLOWED.keys()].filter(
      (rel) => !existsSync(path.join(ROOT, rel)) || findHandRolledBackups(read(rel), !rel.endsWith(".md")).length === 0,
    );
    expect(stale).toEqual([]);
  });

  it("the detector catches each form and lets a /tmp rehearsal through", () => {
    expect(findHandRolledBackups('db.prepare("VACUUM INTO ?").run(p);')).toHaveLength(1);
    expect(findHandRolledBackups("db.backup(dest);")).toHaveLength(1);
    expect(findHandRolledBackups("fs.copyFileSync(dbPath, bak);")).toHaveLength(1);
    expect(findHandRolledBackups('fs.copyFileSync(path.join(d, "vanguard.db"), bak);')).toHaveLength(1);
    expect(findHandRolledBackups("cp data/vanguard.db x.bak")).toHaveLength(1);
    expect(findHandRolledBackups("fs.copyFileSync(PROD_DB_PATH, backup);")).toHaveLength(1);
    expect(findHandRolledBackups(" * takes a VACUUM INTO backup first")).toHaveLength(0);
    expect(findHandRolledBackups("fs.copyFileSync(src, dest);")).toHaveLength(0);
    expect(findHandRolledBackups("Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\"")).toHaveLength(0);
    expect(findHandRolledBackups("fs.copyFileSync(dbPath,\n  \"/tmp/x.db\");")).toHaveLength(0);
  });
});
