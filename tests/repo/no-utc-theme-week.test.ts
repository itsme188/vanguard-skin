import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

describe("macro-theme week key", () => {
  it("no file under app/api or lib derives a theme week from a UTC date", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const f of [...walk(join(root, "app/api")), ...walk(join(root, "lib"))]) {
      const src = readFileSync(f, "utf8");
      // narrative route (not a theme cache) is covered by its own owner
      if (/mondayOf\(\s*new Date\(\)\.toISOString\(\)/.test(src) && /MacroThemes|macro-themes|weekOf/.test(src) && !f.includes("analysis/narrative")) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
