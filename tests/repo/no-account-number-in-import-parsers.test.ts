import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// The repo is public. A brokerage account number must never be written into
// source. The Vanguard map lives in a private file; see
// lib/import/vanguard-account-names.ts.
// Allowed exceptions (file path -> reason): none.
const ALLOWED: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

describe("no account number in lib/import", () => {
  const root = process.cwd();
  const files = walk(join(root, "lib/import")).filter((f) => !(f.replace(root + "/", "") in ALLOWED));

  it("has no quoted 8+ digit string used as an object key", () => {
    const offenders = files.filter((f) => /["']\d{8,}["']\s*:/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("does not bring back ACCOUNT_NUMBER_MAP", () => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("ACCOUNT_NUMBER_MAP"));
    expect(offenders).toEqual([]);
  });
});
