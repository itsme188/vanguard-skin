/**
 * QA finding: the AI Trade Grades block on the security detail page printed
 * per-trade AI prose (assessment / what worked / what didn't) in the clear
 * in privacy mode, while the P&L and Return cells were masked. The prose
 * carries return percentages and share-retention figures, so each value must
 * render inside <PrivateText>. No DOM harness in this repo, so this is a
 * source-scan test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const PAGE_PATH = path.join(
  process.cwd(),
  "app/dashboard/security/[id]/page.tsx",
);

describe("security page AI trade grades prose is private", () => {
  const src = readFileSync(PAGE_PATH, "utf8");

  for (const name of ["assessment", "whatWorked", "whatDidnt"]) {
    it(`renders {${name}} only inside <PrivateText>`, () => {
      const wrapped = new RegExp(
        `<PrivateText>\\s*\\{${name}\\}\\s*</PrivateText>`,
      );
      expect(src).toMatch(wrapped);
      const total = src.split(`{${name}}`).length - 1;
      const inside = src.match(new RegExp(wrapped.source, "g"))?.length ?? 0;
      expect(total).toBe(inside);
    });
  }
});
