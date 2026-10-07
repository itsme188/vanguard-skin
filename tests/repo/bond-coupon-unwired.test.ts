/**
 * lib/tws/bond-coupon.ts (the broker coupon assessment and the one writer of
 * securities.coupon_rate) is INTENTIONALLY not called by production code
 * (controller ruling 2026-10-07). The only route a bond takes to a
 * contract-details request today is a by-symbol lookup that can return
 * several issues, so storing "the" coupon from it could attach another bond's
 * coupon, and a stored coupon outranks the bond's name for good.
 *
 * This test keeps it unwired: any production file that starts importing the
 * module fails here. Wire it only after a contract-details request BY
 * CONTRACT ID has been proven against a real broker session (the module's
 * header lists what must be proven), and then replace this test with one
 * that allows exactly that caller.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");
const MODULE = "bond-coupon";
const MODULE_FILE = `lib/tws/${MODULE}.ts`;

const ROOTS: Array<[string, RegExp]> = [
  ["lib", /\.(ts|tsx)$/],
  ["app", /\.(ts|tsx)$/],
  ["scripts", /\.(ts|js|mjs)$/],
  ["electron", /\.(ts|js)$/],
  ["workers", /\.(ts|tsx|js)$/],
];

function walk(dir: string, re: RegExp, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
}

const IMPORT_RE = new RegExp(`(?:from|import|require)\\s*\\(?\\s*["'][^"']*/${MODULE}["']`);

function productionFiles(): string[] {
  const files: string[] = [];
  for (const [root, re] of ROOTS) walk(path.join(REPO, root), re, files);
  return files.map((f) => path.relative(REPO, f).split(path.sep).join("/"));
}

describe("the broker bond-coupon module is not wired into production code", () => {
  const files = productionFiles();

  it("the scan sees the module and the enrichment file (it is not silently empty)", () => {
    expect(files).toContain(MODULE_FILE);
    expect(files).toContain("lib/tws/contracts.ts");
    expect(IMPORT_RE.test(`import { x } from "./${MODULE}";`)).toBe(true);
    expect(IMPORT_RE.test(`import { x } from "@/lib/tws/${MODULE}";`)).toBe(true);
    expect(IMPORT_RE.test(`import { x } from "@/lib/bonds";`)).toBe(false);
  });

  it("no production file imports it", () => {
    const importers = files
      .filter((rel) => rel !== MODULE_FILE)
      .filter((rel) => IMPORT_RE.test(fs.readFileSync(path.join(REPO, rel), "utf-8")));
    expect(importers).toEqual([]);
  });

  it("nothing else in production code writes securities.coupon_rate with a value", () => {
    const writers = files
      .filter((rel) => rel !== MODULE_FILE)
      .filter((rel) => /SET\s+coupon_rate\s*=\s*\?|coupon_rate\s*=\s*@|coupon_rate\s*=\s*excluded/i.test(
        fs.readFileSync(path.join(REPO, rel), "utf-8"),
      ));
    expect(writers).toEqual([]);
  });

  it("the module says so itself", () => {
    const src = fs.readFileSync(path.join(REPO, MODULE_FILE), "utf-8");
    expect(src).toContain("INTENTIONALLY NOT CALLED YET");
    expect(src).toContain("BY CONTRACT ID");
  });
});
