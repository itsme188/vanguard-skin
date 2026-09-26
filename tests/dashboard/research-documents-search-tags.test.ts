/**
 * QA finding research-documents-search--ignores-tags-visible-tag-returns-no-documents-match:
 * the Documents search box filtered client-side on title / source / author /
 * summary only, so typing a tag that is visibly rendered on a row returned
 * "No documents match". Fix: the predicate also matches the row's tags
 * (parsed from the JSON-string column via parseSymbols, case-insensitive
 * substring), and the predicate lives in an exported pure helper so it can
 * be asserted directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { documentMatchesSearch } from "@/app/dashboard/components/research-documents-search";

const VIEW_PATH = path.join(process.cwd(), "app/dashboard/components/ResearchDocumentsView.tsx");

describe("documentMatchesSearch", () => {
  const doc = {
    title: "Semis outlook",
    source: "Bank research",
    author: null,
    summary: "Capex cycle notes",
    tags: JSON.stringify(["memory", "HBM-supply"]),
  };
  it("matches a tag, case-insensitively, as a substring", () => {
    expect(documentMatchesSearch(doc, "memory")).toBe(true);
    expect(documentMatchesSearch(doc, "hbm")).toBe(true);
    expect(documentMatchesSearch(doc, "MEMORY")).toBe(true);
  });
  it("still matches title / source / author / summary", () => {
    expect(documentMatchesSearch(doc, "semis")).toBe(true);
    expect(documentMatchesSearch(doc, "bank")).toBe(true);
    expect(documentMatchesSearch(doc, "capex")).toBe(true);
    expect(documentMatchesSearch({ ...doc, author: "Jane" }, "jane")).toBe(true);
  });
  it("returns false when nothing matches and tolerates null / malformed tags", () => {
    expect(documentMatchesSearch(doc, "nvidia")).toBe(false);
    expect(documentMatchesSearch({ ...doc, tags: null }, "memory")).toBe(false);
    expect(documentMatchesSearch({ ...doc, tags: "{not json" }, "memory")).toBe(false);
  });
  it("an empty / whitespace needle matches everything", () => {
    expect(documentMatchesSearch(doc, "   ")).toBe(true);
  });
});

describe("ResearchDocumentsView wiring", () => {
  it("the client-side search filter goes through documentMatchesSearch", () => {
    const src = readFileSync(VIEW_PATH, "utf8");
    expect(src).toMatch(/documentMatchesSearch\(/);
    expect(src).not.toMatch(/d\.summary\?\.toLowerCase\(\)\.includes\(needle\)/);
  });
});
