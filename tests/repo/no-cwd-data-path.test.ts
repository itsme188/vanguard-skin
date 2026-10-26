/**
 * No cwd-anchored data folder under lib/ or app/.
 *
 * In the packaged Electron app the server's cwd is the read-only bundle
 * (.../Resources/standalone), which has no data/ folder. A path built from
 * process.cwd() + "data" silently misses the user's real data (the IBKR Web
 * API credentials were lost this way). Anchor on VANGUARD_DB_DIR instead, and
 * keep the cwd form only as the fallback behind it.
 *
 * A hit is a line that mentions process.cwd() and a "data" path segment
 * ("data" / 'data' / "data/..."), joined or resolved. Allowlisted files must
 * also mention VANGUARD_DB_DIR near the hit (within 3 lines).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** file (relative) -> reason. */
const ALLOWED: Record<string, string> = {
  "lib/db/db-path.ts": "the one resolver of the data dir; cwd is its documented last fallback",
  "lib/trade-review/generate.ts": "cwd/data only as the fallback behind VANGUARD_DB_DIR",
};

const CWD_DATA = /process\.cwd\(\)[^\n]*["'`]data["'`\/]|cwd\b[^\n]*path\.join\([^\n]*["'`]data["'`]/;

describe("no cwd-anchored data path", () => {
  it("lib/ and app/ never build <cwd>/data without the VANGUARD_DB_DIR anchor", () => {
    const bad: string[] = [];
    for (const top of ["lib", "app"]) {
      for (const file of sourceFiles(path.join(ROOT, top))) {
        const rel = path.relative(ROOT, file);
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          if (!CWD_DATA.test(line)) return;
          if (rel in ALLOWED) return;
          const near = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
          if (near.includes("VANGUARD_DB_DIR")) return;
          bad.push(`${rel}:${i + 1}: ${t}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });

  it("the allowlist names only files that exist", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(() => statSync(path.join(ROOT, rel)), rel).not.toThrow();
    }
  });
});
