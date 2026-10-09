/**
 * The "read ▾" / "collapse ▴" toggle on the security page shows exactly one
 * label in each state.
 *
 * Browser finding: collapsed notes showed both labels. The shared
 * EXPANDER_CLASS carried `inline-block`, and the collapse label added
 * `hidden group-open:inline-block`: two display utilities of equal
 * specificity on one element, and `inline-block` came later in the built
 * stylesheet, so `hidden` lost. No DOM harness, so the class lists are pinned
 * from source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");

const DISPLAY = /^(hidden|block|inline|inline-block|inline-flex|flex|grid)$/;

function constant(name: string): string {
  const at = anchorIndex(src, `const ${name} =`);
  const m = src.slice(at).match(/=\s*"([^"]*)"/);
  if (!m) throw new Error(`${name}: no string literal`);
  return m[1];
}

/** The resolved class list of every span that renders `label`. */
function classLists(label: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp("<span className=\\{`([^`]*)`\\}>" + label + "</span>", "g");
  for (const m of src.matchAll(re)) {
    const resolved = m[1].replace(/\$\{([A-Z_]+)\}/g, (_, n: string) => constant(n));
    out.push(resolved.split(/\s+/).filter(Boolean));
  }
  return out;
}

describe("security page read / collapse toggle", () => {
  const read = classLists("read ▾");
  const collapse = classLists("collapse ▴");

  it("finds both toggles (transcripts and notes)", () => {
    expect(read).toHaveLength(2);
    expect(collapse).toHaveLength(2);
  });

  it("the collapse label has one unconditional display utility, and it is hidden", () => {
    for (const cls of collapse) {
      expect(cls.filter((c) => DISPLAY.test(c))).toEqual(["hidden"]);
      expect(cls).toContain("group-open:inline-block");
    }
  });

  it("the read label is shown when closed and hidden when open", () => {
    for (const cls of read) {
      expect(cls.filter((c) => DISPLAY.test(c))).toEqual(["inline-block"]);
      expect(cls).toContain("group-open:hidden");
    }
  });
});
