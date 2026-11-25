/**
 * The broker's market-data type is set in ONE place (Gains at risk step 3, D2):
 * `setMarketDataTypeCounted` in lib/tws/market-data-type.ts. The type belongs
 * to the whole broker connection and the helper's counter is how a quote sees
 * that someone else changed it mid-flight, so a direct `setMarketDataType(`
 * call anywhere else under lib/ or app/ would be invisible to it.
 *
 * Comment lines are skipped (a doc may name the broker method). The callers
 * that existed before step 3 are pinned too, so a swap cannot silently vanish.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const ALLOWED = "lib/tws/market-data-type.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

describe("one market-data-type setter", () => {
  it("T25 no setMarketDataType( call under lib/ or app/ outside lib/tws/market-data-type.ts", () => {
    const hits: string[] = [];
    for (const dir of ["lib", "app"]) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        if (rel === ALLOWED) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (!isCommentLine(line) && /\bsetMarketDataType\s*\(/.test(line)) hits.push(`${rel}:${i + 1}`);
          });
      }
    }
    expect(hits).toEqual([]);
    // The helper itself really is the one caller.
    expect(readFileSync(path.join(ROOT, ALLOWED), "utf8")).toMatch(/api\.setMarketDataType\(type\)/);
  });

  it("each of the four existing setters goes through the helper", () => {
    for (const rel of ["lib/tws/snapshot.ts", "lib/tws/atm-straddle.ts", "lib/tws/streaming.ts", "lib/tws/option-quote.ts"]) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, rel).toMatch(/setMarketDataTypeCounted\(api, MarketDataType\.DELAYED_FROZEN\)/);
      expect(src, rel).toMatch(/setMarketDataTypeCounted\(api, MarketDataType\.REALTIME\)/);
    }
  });
});
