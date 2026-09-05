/**
 * Mac↔Worker parity for the live-claim filter. The Worker bundle cannot import
 * `lib/`, so `workers/cron/src/fallback-earnings.ts` carries its own copy of
 * LIVE_CLAIM_STATES. This test is what keeps the copy honest: it reads the
 * Worker source and asserts that BOTH values in lib/earnings/email-states.ts
 * appear in the Worker's declaration, and that neither candidate filter tests
 * the raw string 'in_progress' any more (which is how the copy drifted last
 * time — one filter fixed, one forgotten).
 *
 * It is a SOURCE read on purpose. The Worker is a separate vitest project with
 * its own tsconfig and its own suite; importing its module from here would
 * pull a Cloudflare-shaped bundle into the Node test run. Reading the text is
 * the same trick tests/repo/no-handrolled-*.test.ts use, and it is enough:
 * the thing that drifts is the literal, and the literal is what we read.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { LIVE_CLAIM_STATES, DELIVERY_UNKNOWN } from "@/lib/earnings/email-states";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(REPO_ROOT, "workers/cron/src/fallback-earnings.ts");

describe("Worker fallback-earnings mirrors the Mac's live-claim set", () => {
  const source = fs.readFileSync(SRC, "utf8");

  it("declares exactly the Mac's LIVE_CLAIM_STATES", () => {
    const decl = /const LIVE_CLAIM_STATES: readonly string\[\] = \[([^\]]*)\]/.exec(source);
    expect(decl, "the Worker must declare LIVE_CLAIM_STATES").toBeTruthy();
    const values = decl![1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(values).toEqual([...LIVE_CLAIM_STATES]);
  });

  it("both audit filters go through isLiveClaim, not a raw literal", () => {
    const filters = source.match(/\.filter\(\(r\) => [^)]*r\.error[^)]*\)/g) ?? [];
    expect(filters.length).toBe(2);
    for (const f of filters) {
      expect(f).toContain("isLiveClaim(r.error)");
      expect(f).not.toContain("in_progress");
      expect(f).not.toContain("sending");
    }
  });

  it("never treats delivery_unknown as a live claim", () => {
    // On either side. The Mac's own predicate is asserted here too, so a
    // future edit that moved delivery_unknown into LIVE_CLAIM_STATES would
    // fail in the main suite even before the Worker copy was touched.
    expect(source).not.toMatch(/LIVE_CLAIM_STATES[^\n]*delivery_unknown/);
    expect([...LIVE_CLAIM_STATES] as string[]).not.toContain(DELIVERY_UNKNOWN);
  });
});
