import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ManageSourcesModal.tsx"),
  "utf8"
);

function handlerBody(name: string): string {
  const start = anchorIndex(src, `const ${name} = useCallback(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("useCallback(", start + 30); // last handler has no successor
  return src.slice(start, next === -1 ? undefined : next);
}

describe("ManageSourcesModal add handlers clear the stale mutation error", () => {
  for (const name of ["handleAddManual", "handleAddDiscovered"]) {
    it(`${name} resets mutationError before the request`, () => {
      const body = handlerBody(name);
      const clear = body.search(/setMutationError\(\s*null\s*\)/);
      const fetchAt = anchorIndex(body, "apiFetch(");
      expect(clear).toBeGreaterThan(-1);
      expect(clear).toBeLessThan(fetchAt);
    });

    it(`${name} checks res.ok AND data.success and parses JSON defensively`, () => {
      const body = handlerBody(name);
      expect(body).toMatch(/res\.json\(\)\.catch\(\s*\(\)\s*=>\s*null\s*\)/);
      expect(body).toMatch(/res\.ok\s*&&\s*data\?\.success/);
      expect(body).toContain("The server returned an error (HTTP ${res.status})");
    });
  }
});

describe("ManageSourcesModal — no raw exception text, Escape closes", () => {
  it("never renders err.message or a bare 'network error'", () => {
    expect(src).not.toMatch(/err\.message\s*:/);
    expect(src).not.toMatch(/err instanceof Error \? err\.message/);
    expect(src).not.toContain('"network error"');
  });

  it("uses the shared mutation-result helpers", () => {
    expect(src).toMatch(/from "@\/lib\/ui\/mutation-result"/);
    expect(src).toContain("networkFailureMessage");
    expect(src).toContain("readMutationResult");
  });

  it("closes on Escape via a document keydown listener, deferring to the delete confirm", () => {
    expect(src).toMatch(/e\.key !== "Escape"/);
    expect(src).toMatch(/document\.addEventListener\("keydown"/);
    expect(src).toMatch(/document\.removeEventListener\("keydown"/);
    expect(src).toMatch(/pendingDeleteId !== null\) setPendingDeleteId\(null\);\s*else onClose\(\)/);
  });
});
