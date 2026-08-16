import { describe, it, expect } from "vitest";
import { parsePorcelainZ } from "../../scripts/lib/git-changed";

const NUL = "\0";

describe("parsePorcelainZ", () => {
  it("parses staged, unstaged, and untracked records", () => {
    const raw = [`M  lib/compute/risk.ts`, ` M lib/queries/holdings.ts`, `?? tests/auth/login-page.test.ts`].join(NUL) + NUL;
    expect(parsePorcelainZ(raw)).toEqual([
      "lib/compute/risk.ts",
      "lib/queries/holdings.ts",
      "tests/auth/login-page.test.ts",
    ]);
  });

  it("takes the NEW path for renames and skips the original-path field", () => {
    const raw = `R  lib/new-name.ts${NUL}lib/old-name.ts${NUL}M  lib/other.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual(["lib/new-name.ts", "lib/other.ts"]);
  });

  it("handles paths with spaces (unquoted under -z)", () => {
    const raw = `?? docs/My Notes File.md${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual(["docs/My Notes File.md"]);
  });

  it("returns [] for empty output", () => {
    expect(parsePorcelainZ("")).toEqual([]);
  });

  it("dedupes a path that is both staged and unstaged", () => {
    const raw = `MM lib/compute/risk.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual(["lib/compute/risk.ts"]);
  });
});
