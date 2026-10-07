/**
 * B33 — Research > Documents view (app/dashboard/components/ResearchDocumentsView.tsx).
 *
 * No DOM harness in this repo: the pure helpers are imported and exercised;
 * the wiring is pinned in source with `anchorIndex` so a vanished anchor
 * fails loudly. Synthetic symbols and tags only.
 *
 * [qa:research-documents--collapsed-row-stuck-extracting-full-text-no-refresh-regression-1]
 * [qa:research-documents-tags--over-40-char-tag-silently-discarded]
 * [qa:research-documents-tags--comma-not-split-mangled-single-tag]
 * [qa:research-documents-chips--symbols-not-links]
 * [qa:research-documents-cards--symbol-overflow-never-resolves]
 * [qa:research-documents--delete-button-15px-target-no-touch-extension]
 * [qa:research-documents-tags--7px-remove-target-no-touch-extension]
 * [qa:research-documents-upload--500-renders-raw-anthropic-envelope-regression-1]
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import {
  visibleDocumentSymbols,
  effectiveProcessingState,
  planTagAdd,
  tagAddProblem,
  DOCUMENT_TAG_MAX_LENGTH,
  DOCUMENT_TAG_MAX_COUNT,
} from "@/app/dashboard/components/ResearchDocumentsView";
import {
  normalizeTags,
  RESEARCH_TAG_MAX_LENGTH,
  RESEARCH_TAG_MAX_COUNT,
} from "@/lib/research-documents/extract";

const source = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ResearchDocumentsView.tsx"),
  "utf8",
);
const uploadZone = sliceBetween(source, "function UploadZone(", "// ─── Filters bar");
const tagEditor = sliceBetween(source, "function TagEditor({", "function DocumentRow({");
const documentRow = sliceBetween(source, "function DocumentRow({", "// ─── Main view");
const listView = source.slice(anchorIndex(source, "export function ResearchDocumentsView()"));

describe("stuck 'Extracting full text…' badge", () => {
  it("the list is re-read on a timer while any row is still extracting, open card or not", () => {
    expect(listView).toMatch(
      /const anyPendingBody = documents\.some\(\(d\) => d\.processing_state === "pending_body"\)/,
    );
    const effect = listView.slice(anchorIndex(listView, "if (!anyPendingBody) return;"));
    expect(effect).toMatch(/setInterval\(\(\) => \{\s*fetchDocuments\(\{ quiet: true \}\);\s*\}, PENDING_LIST_POLL_MS\)/);
    expect(effect).toMatch(/return \(\) => clearInterval\(interval\);\s*\}, \[anyPendingBody, fetchDocuments\]\)/);
    // The poll is not gated on a card being expanded.
    expect(listView).not.toMatch(/expanded/);
  });

  it("a background re-read does not put the list back into its loading state", () => {
    expect(listView).toMatch(/if \(!opts\?\.quiet\) setLoading\(true\)/);
    expect(listView).toMatch(/if \(!opts\?\.quiet\) setLoading\(false\)/);
  });

  it("the header badge follows the fresher of the list row and the open panel", () => {
    expect(effectiveProcessingState("pending_body", undefined)).toBe("pending_body");
    // The open panel's own poll saw it finish first.
    expect(effectiveProcessingState("pending_body", "ready")).toBe("ready");
    expect(effectiveProcessingState("pending_body", "failed")).toBe("failed");
    // The list poll saw it finish while a collapsed card held a stale detail.
    expect(effectiveProcessingState("ready", "pending_body")).toBe("ready");
    expect(effectiveProcessingState("failed", "pending_body")).toBe("failed");

    expect(documentRow).toMatch(/\{processingState === "pending_body" && \(/);
    expect(documentRow).toMatch(/\{processingState === "failed" && \(/);
    expect(documentRow).not.toMatch(/\{doc\.processing_state === "pending_body" && \(/);
  });

  it("a stale 'still extracting' detail is re-read once the list says the row is done", () => {
    const effect = sliceBetween(
      documentRow,
      'if (doc.processing_state === "pending_body") return;',
      "}, [doc.processing_state, detail?.processing_state]);",
    );
    expect(effect).toMatch(/if \(detail\?\.processing_state !== "pending_body"\) return;\s*fetchDetail\(\);/);
  });
});

describe("tag input", () => {
  it("limits mirror the server's", () => {
    expect(DOCUMENT_TAG_MAX_LENGTH).toBe(RESEARCH_TAG_MAX_LENGTH);
    expect(DOCUMENT_TAG_MAX_COUNT).toBe(RESEARCH_TAG_MAX_COUNT);
  });

  it("a comma separates tags", () => {
    const plan = planTagAdd(["macro"], "QA-Alpha,  qa-beta ,");
    expect(plan.next).toEqual(["macro", "qa-alpha", "qa-beta"]);
    expect(plan.added).toEqual(["qa-alpha", "qa-beta"]);
    expect(tagAddProblem(plan)).toBeNull();
    // What the client sends survives the server's normalization unchanged.
    expect(normalizeTags(plan.next)).toEqual(plan.next);
  });

  it("an entry over the length limit is held back and named, never silently dropped", () => {
    const long = "x".repeat(DOCUMENT_TAG_MAX_LENGTH + 33);
    const plan = planTagAdd(["macro"], `${long}, ok-tag`);
    expect(plan.next).toEqual(["macro", "ok-tag"]);
    expect(plan.tooLong).toEqual([long]);
    const problem = tagAddProblem(plan);
    expect(problem).toContain(`at most ${DOCUMENT_TAG_MAX_LENGTH} characters`);
    expect(problem).toContain("Not added");
    // An entry exactly at the limit is fine.
    const edge = "y".repeat(DOCUMENT_TAG_MAX_LENGTH);
    expect(planTagAdd([], edge).added).toEqual([edge]);
  });

  it("an entry past the per-document cap is held back and named", () => {
    const full = Array.from({ length: DOCUMENT_TAG_MAX_COUNT - 1 }, (_, i) => `t${i}`);
    const plan = planTagAdd(full, "fits, spills");
    expect(plan.added).toEqual(["fits"]);
    expect(plan.overCap).toEqual(["spills"]);
    expect(plan.next).toHaveLength(DOCUMENT_TAG_MAX_COUNT);
    expect(tagAddProblem(plan)).toContain(`at most ${DOCUMENT_TAG_MAX_COUNT} tags`);
  });

  it("a tag already on the document adds nothing", () => {
    const plan = planTagAdd(["macro"], "Macro, macro");
    expect(plan.added).toEqual([]);
    expect(plan.next).toEqual(["macro"]);
  });

  it("the editor uses the plan, keeps held-back text in the box, and explains a no-op", () => {
    const addTag = sliceBetween(tagEditor, "function addTag() {", "function removeTag(");
    expect(addTag).toMatch(/const plan = planTagAdd\(tags, input\)/);
    expect(addTag).toMatch(/setInput\(\[\.\.\.plan\.tooLong, \.\.\.plan\.overCap\]\.join\(", "\)\)/);
    expect(addTag).toMatch(/if \(plan\.added\.length === 0\) \{\s*setSaveError\(problem \?\? "That tag is already on this document\."\);\s*return;/);
    expect(addTag).toMatch(/commit\(plan\.next, problem\)/);
    // The old path cleared the box and sent the raw text whatever the server did with it.
    expect(addTag).not.toMatch(/setInput\(""\)/);
  });

  it("says so when the server keeps fewer tags than were sent", () => {
    const commit = sliceBetween(tagEditor, "const commit = useCallback(", "function addTag() {");
    expect(commit).toMatch(/if \(normalized\.length < next\.length && !heldBack\) \{\s*setSaveError\(/);
  });

  it("the remove control carries a touch extension and names its tag", () => {
    const remove = sliceBetween(tagEditor, "onClick={() => removeTag(t)}", "×");
    expect(remove).toContain("relative");
    expect(remove).toContain("pointer-coarse:after:absolute");
    expect(remove).toContain("pointer-coarse:after:content-['']");
    expect(remove).toMatch(/pointer-coarse:after:-inset-x-/);
    expect(remove).toContain("aria-label={`Remove tag ${t}`}");
  });
});

describe("symbol chips", () => {
  it("a collapsed card shows six symbols and counts the rest; an expanded card shows all", () => {
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
    expect(visibleDocumentSymbols(symbols, false)).toEqual({ shown: symbols.slice(0, 6), hidden: 2 });
    expect(visibleDocumentSymbols(symbols, true)).toEqual({ shown: symbols, hidden: 0 });
    expect(visibleDocumentSymbols(["AAA"], false)).toEqual({ shown: ["AAA"], hidden: 0 });
    expect(documentRow).toMatch(/visibleDocumentSymbols\(\s*symbols,\s*expanded,\s*\)/);
    expect(documentRow).toMatch(/\{hiddenSymbols > 0 && \(/);
  });

  it("a known symbol renders through SymbolLink; an unknown one stays plain text", () => {
    expect(source).toMatch(/import \{ SymbolLink \} from "\.\/SymbolLink";/);
    const chips = sliceBetween(documentRow, "{shownSymbols.map((s) => {", "{hiddenSymbols > 0 && (");
    expect(chips).toMatch(/const securityId = symbolMap\[s\.toUpperCase\(\)\];/);
    expect(chips).toMatch(/return securityId \? \(\s*<SymbolLink/);
    expect(chips).toMatch(/securityId=\{securityId\}\s*symbol=\{s\}/);
    expect(chips).toMatch(/\) : \(\s*<span key=/);
  });

  it("the links sit outside the toggle button (a link may not nest in a button)", () => {
    const buttonStart = anchorIndex(documentRow, "onClick={toggleExpanded}");
    const buttonEnd = anchorIndex(documentRow, "</button>", buttonStart);
    const chipsAt = anchorIndex(documentRow, "{shownSymbols.map((s) => {");
    expect(chipsAt).toBeGreaterThan(buttonEnd);
    // A click on a link must not also toggle the card.
    expect(documentRow).toMatch(/if \(\(e\.target as HTMLElement\)\.closest\("a"\)\) return;\s*toggleExpanded\(\);/);
  });

  it("the list hands each row the symbol map the API returned", () => {
    expect(listView).toMatch(/setSymbolMap\(data\.symbolMap \?\? \{\}\)/);
    expect(listView).toMatch(/symbolMap=\{symbolMap\}/);
  });
});

describe("delete control", () => {
  it("carries the touch extension and names the document", () => {
    const del = sliceBetween(documentRow, "onClick={handleDelete}", "Delete\n");
    expect(del).toContain("aria-label={`Delete document ${doc.title}`}");
    expect(del).toContain("relative");
    expect(del).toContain("pointer-coarse:after:absolute");
    expect(del).toContain("pointer-coarse:after:-inset-2");
    expect(del).toContain("pointer-coarse:after:content-['']");
  });

  it("the failed-extraction note no longer tells the user to re-upload over the entry", () => {
    expect(documentRow).not.toMatch(/re-upload the PDF to retry/);
    expect(documentRow).toMatch(/delete this entry and upload the PDF again/);
  });
});

describe("upload error", () => {
  it("renders a snippet block only for a snippet with content", () => {
    expect(uploadZone).toMatch(
      /typeof body\.snippet === "string" && body\.snippet\.trim\(\) \? body\.snippet : null/,
    );
  });
});
