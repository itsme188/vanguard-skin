/**
 * lib/backup must import with relative paths only. Repair scripts are run with
 * tsx from a scratch folder outside the repo, where the `@/` alias does not
 * resolve ("Cannot find module '@/lib/...'").
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BACKUP_DIR = path.join(process.cwd(), "lib", "backup");
const ALIAS_IMPORT = /\b(?:import|export)\b[^;]*?\bfrom\s+["']@\//;

describe("lib/backup imports", () => {
  const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".ts"));

  it("finds the backup modules", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s uses no @/ alias imports", (file) => {
    const src = readFileSync(path.join(BACKUP_DIR, file), "utf8");
    expect(ALIAS_IMPORT.test(src), `${file} imports through the @/ alias`).toBe(false);
  });
});
