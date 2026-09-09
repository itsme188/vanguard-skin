/**
 * QA finding research-documents--collapsed-tag-count-stale-after-remove:
 * on /dashboard/research?view=documents, DocumentRow renders the collapsed
 * header chips and the "+N tags" overflow count from `parseSymbols(doc.tags)`
 * — the row object owned by the parent `documents` state. Adding or removing
 * a tag in the expanded editor PATCHed fine and updated the editor, but
 * `handleTagsChanged` only called `setDetail(...)`, so the parent row was
 * never patched: the header two lines above kept the old chips and the old
 * count until a full reload, showing two contradictory tag counts for one
 * document in a single viewport.
 *
 * Fix: DocumentRow forwards the new tag list to the parent via an
 * `onTagsChanged(docId, tags)` prop, and the parent patches the matching
 * entry in `documents` immutably (re-encoding the array into the JSON-string
 * shape `parseSymbols` reads).
 *
 * This repo has no @testing-library/react and no jsdom, so this follows the
 * source-scan precedent of tests/dashboard/data-health-view-scrollfade.test.ts
 * rather than rendering: it pins the wiring in source, plus a pure assertion
 * on the round-trip + the header's overflow arithmetic.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const VIEW_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ResearchDocumentsView.tsx",
);

const source = readFileSync(VIEW_PATH, "utf8");

/** Source slice from a function declaration to the start of the next one. */
function functionBody(src: string, declaration: string, endMarker: string): string {
  const startIdx = src.indexOf(declaration);
  if (startIdx === -1) {
    throw new Error(`declaration not found in ResearchDocumentsView.tsx: ${declaration}`);
  }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error(`end marker ${endMarker} not found after ${declaration}`);
  }
  return src.slice(startIdx, endIdx);
}

const documentRow = functionBody(
  source,
  "function DocumentRow({",
  "export function ResearchDocumentsView()",
);
const listView = functionBody(source, "export function ResearchDocumentsView()", "\n}\n");

describe("research documents: collapsed header tag count stays in sync with the editor", () => {
  it("DocumentRow takes an onTagsChanged callback carrying the document id", () => {
    const signature = documentRow.slice(0, documentRow.indexOf("}) {"));
    expect(signature).toMatch(/onTagsChanged,/);
    expect(documentRow).toMatch(
      /onTagsChanged:\s*\(\s*docId:\s*number\s*,\s*tags:\s*string\[\]\s*\)\s*=>\s*void/,
    );
  });

  it("DocumentRow's handleTagsChanged reaches the parent, not just local detail state", () => {
    const handler = functionBody(
      documentRow,
      "function handleTagsChanged(",
      "\n  return (",
    );
    expect(handler).toContain("onTagsChanged(doc.id,");
    // The expanded editor must still update too — both surfaces move together.
    expect(handler).toContain("setDetail(");
  });

  it("the list passes onTagsChanged down to every row", () => {
    expect(listView).toMatch(/<DocumentRow[\s\S]{0,200}onTagsChanged=\{/);
  });

  it("the list patches the matching document in state immutably, re-encoding tags", () => {
    expect(listView).toMatch(/setDocuments\(\s*\(prev\)\s*=>/);
    expect(listView).toMatch(/prev\.map\(/);
    expect(listView).toMatch(/d\.id === docId/);
    expect(listView).toMatch(/tags:\s*JSON\.stringify\(/);
    // No in-place mutation of the existing row object.
    expect(listView).not.toMatch(/\bdocuments\[[^\]]*\]\.tags\s*=/);
  });

  it("the collapsed header still reads its chips from the (now-patched) row tags", () => {
    expect(documentRow).toContain("const rowTags = parseSymbols(doc.tags)");
  });
});

describe("collapsed header tag arithmetic (pure)", () => {
  // Mirrors parseSymbols() in ResearchDocumentsView.tsx — module-private in a
  // "use client" component, so it is re-stated here and pinned by the
  // source-scan assertion below.
  function parseSymbolsLike(json: string | null): string[] {
    if (!json) return [];
    try {
      const arr = JSON.parse(json);
      return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return [];
    }
  }

  it("the mirrored parser matches the component's implementation", () => {
    expect(source).toContain("const arr = JSON.parse(json);");
    expect(source).toMatch(
      /Array\.isArray\(arr\)\s*\?\s*arr\.filter\(\(s\): s is string => typeof s === "string"\)\s*:\s*\[\]/,
    );
  });

  it("a 6-tag set written back by the parent reads back as 6 chips, i.e. '+1 tags'", () => {
    // The header shows this many chips inline before the "+N tags" overflow.
    const visibleMatch = source.match(/rowTags\.slice\(0,\s*(\d+)\)/);
    expect(visibleMatch).not.toBeNull();
    const visible = Number(visibleMatch![1]);
    expect(source).toContain(`+{rowTags.length - ${visible}} tags`);

    const editorTags = ["qaaa", "qbbb", "qccc", "qddd", "qeee", "qfff"];
    // What the parent stores after onTagsChanged(docId, editorTags):
    const patchedRowTags = JSON.stringify(editorTags);
    const headerTags = parseSymbolsLike(patchedRowTags);

    expect(headerTags).toEqual(editorTags);
    expect(headerTags.length).toBe(editorTags.length);
    expect(headerTags.length - visible).toBe(1);
  });

  it("removing a tag shrinks the header count to match the editor", () => {
    const afterRemove = ["qaaa", "qbbb", "qccc", "qddd", "qeee"];
    const headerTags = parseSymbolsLike(JSON.stringify(afterRemove));
    expect(headerTags.length).toBe(5);
    const visible = Number(source.match(/rowTags\.slice\(0,\s*(\d+)\)/)![1]);
    expect(headerTags.length > visible).toBe(false); // no "+N tags" chip left
  });
});
