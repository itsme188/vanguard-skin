/**
 * Pure emptiness test for an article's AI enrichment. Plain module (no db, no
 * server imports) so the client Feeds view, the cloud reconcile, the repair
 * script and tests share one definition.
 *
 * Mirrors isEmptyEnrichmentResult in lib/gmail/process.ts: empty summary AND
 * no themes. The AND is deliberate; a terse genuine read may have zero themes
 * or (rarely) no summary, but both empty means the extraction produced nothing.
 */
export function isEmptyEnrichment(
  summary: string | null | undefined,
  keyThemes: readonly string[] | string | null | undefined,
): boolean {
  if ((summary ?? "").trim() !== "") return false;
  if (keyThemes == null) return true;
  if (Array.isArray(keyThemes)) return keyThemes.length === 0;
  if (typeof keyThemes === "string") {
    if (keyThemes.trim() === "") return true;
    try {
      const parsed: unknown = JSON.parse(keyThemes);
      return Array.isArray(parsed) && parsed.length === 0;
    } catch {
      // Malformed JSON is a different defect, not an empty enrichment.
      return false;
    }
  }
  return false;
}

/** Plain label for a card with no enrichment; null when it has one. */
export function emptyEnrichmentLabel(article: {
  summary: string | null | undefined;
  key_themes: readonly string[] | string | null | undefined;
  processed_at: string | null | undefined;
}): string | null {
  if (!isEmptyEnrichment(article.summary, article.key_themes)) return null;
  return article.processed_at == null ? "Enrichment pending" : "No summary yet";
}
