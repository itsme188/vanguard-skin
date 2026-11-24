/**
 * Documents upload zone: a refused repeat upload says "delete that document
 * first". Once the owner deletes that very document, the sentence has been
 * followed and must not stay on screen. Any other upload error stays.
 *
 * No DOM harness in this repo: source pins on the wiring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "app/dashboard/components/ResearchDocumentsView.tsx"),
  "utf8",
);

function body(startMarker: string, endMarker: string): string {
  const a = source.indexOf(startMarker);
  const b = source.indexOf(endMarker, a + 1);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe("upload zone duplicate notice (source pin)", () => {
  const zone = body("function UploadZone(", "function handleDrop(");

  it("remembers which document a refused repeat upload pointed at", () => {
    expect(zone).toMatch(/setDuplicateOfId\(\s*typeof body\.existing_id === "number" \? body\.existing_id : null,?\s*\)/);
  });

  it("forgets it when a new upload starts", () => {
    const handle = zone.slice(zone.indexOf("async (file: File)"));
    expect(handle.slice(0, 200)).toContain("setDuplicateOfId(null)");
  });

  it("clears the notice only when the deleted document is the one it named", () => {
    expect(zone).toMatch(
      /if \(deletedDocumentId === null \|\| deletedDocumentId !== duplicateOfId\) return;\s*setError\(null\);\s*setDuplicateOfId\(null\);/,
    );
  });

  it("is told which document was deleted by the list", () => {
    expect(source).toMatch(/<UploadZone onUploadComplete=\{fetchDocuments\} deletedDocumentId=\{deletedDocumentId\} \/>/);
    expect(source).toMatch(/onDeleted=\{\(\) => \{\s*setDeletedDocumentId\(doc\.id\);\s*fetchDocuments\(\);\s*\}\}/);
  });
});
