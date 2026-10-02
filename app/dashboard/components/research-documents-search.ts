/**
 * Client-side search predicate for the Research → Documents list.
 *
 * QA (research-documents-search--ignores-tags-visible-tag-returns-no-documents-match):
 * the filter matched title / source / author / summary but not the tags the
 * row visibly renders, so searching a tag returned "No documents match".
 * Tags arrive as the JSON-string column (`parseSymbols` shape) and are
 * matched the same way — case-insensitive substring.
 */
export interface SearchableDocument {
  title: string;
  source?: string | null;
  author?: string | null;
  summary?: string | null;
  tags?: string | null;
}

function parseTagList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function documentMatchesSearch(doc: SearchableDocument, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(needle);
  return (
    has(doc.title) ||
    has(doc.source) ||
    has(doc.author) ||
    has(doc.summary) ||
    parseTagList(doc.tags).some((t) => t.toLowerCase().includes(needle))
  );
}
