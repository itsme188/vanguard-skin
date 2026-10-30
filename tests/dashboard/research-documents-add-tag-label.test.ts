import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/ResearchDocumentsView.tsx"),
  "utf8",
);

describe("Documents add-tag input has an accessible name", () => {
  it("names the document in an aria-label on the input", () => {
    const at = anchorIndex(src, 'placeholder="add tag…"');
    const input = src.slice(src.lastIndexOf("<input", at), at + 200);
    expect(input).toContain("aria-label={`Add tag to ${docTitle}`}");
  });

  it("passes the document title into TagEditor", () => {
    const at = anchorIndex(src, "<TagEditor");
    const call = src.slice(at, src.indexOf("/>", at));
    expect(call).toContain("docTitle={");
  });
});
