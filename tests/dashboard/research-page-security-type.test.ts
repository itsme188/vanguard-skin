import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

// The research page's securities feed moved into a shared query when the
// notes picker became two-tier (2026-10-08). The page still hands the same
// list to the transcript views, so the feed must keep selecting the type.
const page = readFileSync("app/dashboard/research/page.tsx", "utf8");
const query = readFileSync("lib/queries/note-security-picker.ts", "utf8");
const pickerTypes = readFileSync("lib/notes/security-picker.ts", "utf8");

describe("research page securities feed", () => {
  it("selects security_type so the transcript fetch wall can drop ETFs and funds", () => {
    const start = anchorIndex(query, "SELECT s.id, s.symbol, s.name");
    const select = query.slice(start, start + 120);
    expect(select).toContain("s.security_type");
    expect(pickerTypes).toContain("security_type?: string | null");
  });

  it("the page reads its securities from that one query", () => {
    expect(page).toContain("securities = getNotePickerSecurities(db);");
  });
});
