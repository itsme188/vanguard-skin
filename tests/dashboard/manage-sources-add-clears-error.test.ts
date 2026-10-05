import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ManageSourcesModal.tsx"),
  "utf8"
);

function handlerBody(name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("useCallback(", start + 30);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("ManageSourcesModal add handlers clear the stale mutation error", () => {
  for (const name of ["handleAddManual", "handleAddDiscovered"]) {
    it(`${name} resets mutationError before the request`, () => {
      const body = handlerBody(name);
      const clear = body.search(/setMutationError\(\s*null\s*\)/);
      const fetchAt = body.indexOf("apiFetch(");
      expect(clear).toBeGreaterThan(-1);
      expect(clear).toBeLessThan(fetchAt);
    });
  }
});
