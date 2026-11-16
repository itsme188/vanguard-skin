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
 * `SKILL.md` at any depth under `.claude/skills`. Comments are skipped in code
 * (`//` and block comments in TypeScript, `#` in shell and Python); markdown
 * is scanned in full.
 *
 * A hit is one of:
 *  - `VACUUM INTO <dest>`;
 *  - `.backup` as a method or sqlite3 CLI command (`.backup(dest)`, `.backup dest`);
 *  - `cp [flags] <src> <dest>` where the source names `vanguard.db`, or, in a
 *    shell or markdown file that names `vanguard.db` anywhere, any `cp`;
 *  - a `copyFile`/`copyFileSync`/`cpSync`/`cp` call in a file that names
 *    `vanguard.db` or a `db_?path` variable anywhere.
 *
 * A match is judged on its own DESTINATION argument only: a destination under
 * `/tmp/` is a throwaway rehearsal copy and passes. If the destination cannot
 * be isolated the hit counts (fail closed). Anything else needs an ALLOWED
 * entry: a written reason plus `only`, the substrings that identify the exact
 * allowed lines. A hit in an allowed file is dropped only when its line
 * contains one of them, so a NEW hand-rolled copy in that file still fails.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

interface Allowance {
  reason: string;
  /** Substrings; a hit is allowed only when its line contains one of these. */
  only: string[];
}

/** Repo-relative path -> why a copy of the database is legitimate there. */
const ALLOWED = new Map<string, Allowance>([
  ["lib/backup/take-backup.ts", { reason: "The shared helper itself: the one place a backup is written.", only: ['VACUUM INTO ?").run(partial)'] }],
  ["scripts/coord/sandbox.sh", { reason: "Working copy for the coordination sandbox, not a backup: a VACUUM INTO of a source database the script only reads; the sandbox removes it on teardown.", only: ['con.execute("VACUUM INTO ?", (dest,))'] }],
  ["qa/sandbox.sh", { reason: "Working copy for the QA sandbox, not a backup: snapshots the live database to boot a throwaway app on it; the sandbox removes it on teardown. The second line copies the sandbox's own boot log, not a database.", only: ["VACUUM INTO '$DB_COPY'", 'cp "$LOG_FILE"'] }],
  ["scripts/chat-eval/build-eval-db.ts", { reason: "Builds an evaluation database from a read-only source; the output is a disposable test fixture, not a backup.", only: ['src.prepare("VACUUM INTO ?").run(outAbs)'] }],
  [".claude/skills/qa-fix-findings/SKILL.md", { reason: "Instructions for making a verification copy inside a throwaway fix worktree (never the live data folder); the worktree is deleted afterwards.", only: ["VACUUM INTO '<worktree>/data/vanguard.db'", "VACUUM INTO '$WT/data/vanguard.db'"] }],
  ["scripts/seed-demo.ts", { reason: "The copy that puts the demo database over the live path (not a backup). The safety copy before it goes through takeBackup.", only: ["copyFileSync(DEMO_DB_PATH, PROD_DB_PATH)"] }],
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
  abs.push(...walk(path.join(ROOT, ".claude", "skills"), (n) => n === "SKILL.md"));
  return abs.map((p) => path.relative(ROOT, p).split(path.sep).join("/")).sort();
}

type Kind = "ts" | "sh" | "md";

function kindOf(rel: string): Kind {
  if (rel.endsWith(".md")) return "md";
  if (rel.endsWith(".sh") || rel.endsWith(".py")) return "sh";
  return "ts";
}

export interface Hit {
  line: number;
  text: string;
}

/** True when a destination argument is a throwaway copy under /tmp/. */
function isTmpDest(dest: string): boolean {
  return /^\s*["'`]?\s*(?:\/private)?\/tmp\//.test(dest);
}

/**
 * The top-level comma-separated arguments of a call whose "(" is at
 * `lines[i][open]`, following the call across up to 8 lines and ending at its
 * closing parenthesis. null when it never closes (the hit then counts).
 */
function callArgs(lines: string[], i: number, open: number): string[] | null {
  const args: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = "";
  for (let j = i; j < Math.min(lines.length, i + 8); j++) {
    const text = j === i ? lines[j].slice(open) : lines[j];
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (quote) {
        cur += ch;
        if (ch === "\\") cur += text[++k] ?? "";
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        cur += ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        if (depth > 1) cur += ch;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          args.push(cur);
          return args;
        }
        cur += ch;
      } else if (ch === "," && depth === 1) {
        args.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cur += "\n";
  }
  return null;
}

const NAMES_DB_ANYWHERE = /vanguard\.db|db_?path/i;
const SRC_NAMES_DB = /vanguard\.db/;

/** Every hand-rolled database copy in `src`, each match judged on its own destination. */
export function findHandRolledBackups(src: string, kind: Kind = "ts"): Hit[] {
  const lines = src.split("\n");
  const fileNamesDb = NAMES_DB_ANYWHERE.test(src);
  const fileNamesLiveDb = SRC_NAMES_DB.test(src);
  const hits: Hit[] = [];
  let inBlock = false;

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (kind === "ts") {
      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        return;
      }
      if (trimmed.startsWith("//")) return;
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlock = true;
        return;
      }
    } else if (kind === "sh" && trimmed.startsWith("#")) {
      return;
    }

    const add = (): void => {
      hits.push({ line: i + 1, text: trimmed.slice(0, 160) });
    };

    // VACUUM INTO <dest>
    for (const m of line.matchAll(/VACUUM\s+INTO\s+(?:'([^']*)'|"([^"]*)"|(\S+))/gi)) {
      if (!isTmpDest(m[1] ?? m[2] ?? m[3] ?? "")) add();
    }

    // .backup as a method (`db.backup(dest)`) or CLI command (`.backup dest`).
    // A trailing quote means a file suffix such as `".backup"`, not a call.
    for (const m of line.matchAll(/\.backup\b(?!["'`])\s*(\()?\s*([^,)\s"'`]*|"[^"]*"|'[^']*')/g)) {
      if (!isTmpDest(m[2] ?? "")) add();
    }

    // cp [flags] <src> <dest>
    for (const m of line.matchAll(/(?:^|[\s;&|(`"'])cp\s+((?:-\S+\s+)*)(\S+)\s+(\S+)/g)) {
      const names = SRC_NAMES_DB.test(m[2]) || (kind !== "ts" && fileNamesLiveDb);
      if (names && !isTmpDest(m[3])) add();
    }

    // copyFile / copyFileSync / cpSync / cp calls in a file that names the database.
    if (fileNamesDb) {
      for (const m of line.matchAll(/(?<![\w$])(?:[\w$.]*\.)?(?:copyFileSync|copyFile|cpSync|cp)\s*\(/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        const args = callArgs(lines, i, open);
        if (!args || args.length < 2 || !isTmpDest(args[1])) add();
      }
    }
  });
  return hits;
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** Hits in a repo file, before the allowlist is applied. */
function rawHits(rel: string): Hit[] {
  return findHandRolledBackups(read(rel), kindOf(rel));
}

function isAllowed(rel: string, hit: Hit): boolean {
  return (ALLOWED.get(rel)?.only ?? []).some((s) => hit.text.includes(s));
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

  it("no file copies the database by hand, except the ALLOWED lines (use takeBackup)", () => {
    const offenders: string[] = [];
    for (const rel of scannedFiles()) {
      for (const h of rawHits(rel)) {
        if (!isAllowed(rel, h)) offenders.push(`${rel} line ${h.line}: ${h.text}`);
      }
    }
    expect(
      offenders,
      "Hand-rolled database backup. Use takeBackup (lib/backup/take-backup.ts) or `npm run backup -- --purpose <slug>`.",
    ).toEqual([]);
  });

  it("every ALLOWED entry exists and each `only` substring still matches a hit, so the list cannot rot", () => {
    const stale: string[] = [];
    for (const [rel, allowance] of ALLOWED) {
      if (!existsSync(path.join(ROOT, rel))) {
        stale.push(`${rel} (missing)`);
        continue;
      }
      const hits = rawHits(rel);
      for (const s of allowance.only) {
        if (!hits.some((h) => h.text.includes(s))) stale.push(`${rel}: ${s}`);
      }
      if (allowance.only.length === 0) stale.push(`${rel}: no \`only\` substring`);
    }
    expect(stale).toEqual([]);
  });

  it("the detector catches each form", () => {
    const n = (src: string, kind: Kind = "ts"): number => findHandRolledBackups(src, kind).length;
    expect(n('db.prepare("VACUUM INTO ?").run(p);')).toBe(1);
    expect(n("db.backup(dest);")).toBe(1);
    expect(n('sqlite3 data/vanguard.db ".backup out.db"', "sh")).toBe(1);
    expect(n("fs.copyFileSync(dbPath, bak);")).toBe(1);
    expect(n('fs.copyFileSync(path.join(d, "vanguard.db"), bak);')).toBe(1);
    expect(n("fs.copyFileSync(PROD_DB_PATH, backup);")).toBe(1);
    expect(n("cp data/vanguard.db x.bak", "sh")).toBe(1);
    expect(n("cp -p data/vanguard.db x.bak", "sh")).toBe(1);
    expect(n("cp ./data/vanguard.db x.bak", "sh")).toBe(1);
    expect(n('DB="data/vanguard.db"\ncp "$DB" x.bak', "sh")).toBe(1);
    expect(n('const src = "data/vanguard.db";\nfs.copyFileSync(src, dest);')).toBe(1);
    expect(n('const dbFile = "data/vanguard.db";\nfs.copyFile(dbFile, dest, cb);')).toBe(1);
    expect(n('const live = "data/vanguard.db";\nfs.cpSync(live, dest);')).toBe(1);
    expect(n('const live = "data/vanguard.db";\nawait fs.promises.copyFile(live, dest);')).toBe(1);
    expect(n('const live = "data/vanguard.db";\nfs.copyFileSync(\n  live,\n  dest,\n);')).toBe(1);
  });

  it("the detector lets a /tmp rehearsal through and ignores comments and plain copies", () => {
    const n = (src: string, kind: Kind = "ts"): number => findHandRolledBackups(src, kind).length;
    expect(n("fs.copyFileSync(src, dest);")).toBe(0);
    expect(n("Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\"", "md")).toBe(0);
    expect(n('fs.copyFileSync(dbPath,\n  "/tmp/x.db");')).toBe(0);
    expect(n("cp data/vanguard.db /tmp/a", "sh")).toBe(0);
    expect(n('const f = "x.db.backup";')).toBe(0);
    expect(n(" * takes a VACUUM INTO backup first")).toBe(1);
    expect(n("/**\n * takes a VACUUM INTO backup first\n */")).toBe(0);
    expect(n("// VACUUM INTO 'x.db'")).toBe(0);
    expect(n("# cp data/vanguard.db x", "sh")).toBe(0);
  });

  it("a /tmp copy cannot hide a real one (same line, or elsewhere in the file)", () => {
    const n = (src: string, kind: Kind = "ts"): number => findHandRolledBackups(src, kind).length;
    expect(n("cp data/vanguard.db /tmp/a && cp data/vanguard.db data/b.bak", "sh")).toBe(1);
    expect(n("sqlite3 data/vanguard.db \"VACUUM INTO 'data/backups/x.db'\"\nrehearse into /tmp/y.db\n\nmore\n", "md")).toBe(1);
    expect(n("cp data/vanguard.db data/a.bak\ncp data/vanguard.db /tmp/b.bak", "sh")).toBe(1);
  });
});
