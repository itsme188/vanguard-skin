import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACK_FLAG, assertWriteAcknowledged } from "../../scripts/assign-donation-lots-by-method";

describe("donation scripts need an acknowledgement to write", () => {
  it("a dry run needs no flag", () => {
    expect(() => assertWriteAcknowledged(["node", "script"], false)).not.toThrow();
  });

  it("an apply without the flag is refused", () => {
    expect(() => assertWriteAcknowledged(["node", "script", "--apply"], true)).toThrow(
      /--acknowledge-repair/,
    );
  });

  it("an apply with the flag passes", () => {
    expect(() => assertWriteAcknowledged(["node", "script", "--apply", ACK_FLAG], true)).not.toThrow();
  });

  // Owner ruling 2026-10-08: the finished one-off that called runAssignment
  // without the acknowledgement was deleted. Any script that calls it must
  // check the acknowledgement itself.
  it("the one-off that bypassed the acknowledgement is gone", () => {
    expect(existsSync(join(process.cwd(), "scripts/finish-donations.ts"))).toBe(false);
  });

  it("every script that calls runAssignment checks the acknowledgement", () => {
    const dir = join(process.cwd(), "scripts");
    const callers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\brunAssignment\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(callers).toContain("assign-donation-lots-by-method.ts");
    for (const f of callers) {
      expect(readFileSync(join(dir, f), "utf8"), f).toContain("assertWriteAcknowledged(");
    }
  });
});
