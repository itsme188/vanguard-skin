import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/research/page.tsx", "utf8");

describe("research page securities feed", () => {
  it("selects security_type so the transcript fetch wall can drop ETFs and funds", () => {
    const start = anchorIndex(src, "SELECT DISTINCT s.id, s.symbol, s.name");
    const select = src.slice(start, start + 120);
    expect(select).toContain("s.security_type");
    expect(src).toContain("security_type: string | null");
  });
});
