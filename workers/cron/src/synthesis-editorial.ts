/** Mirrored in the Mac and Worker builds; parity tested. */
export const DIGEST_EDITORIAL_RULES = `EDITORIAL PRIORITIES (HARD):
- Open with one # headline that captures the market's defining development, followed by a short plain-text subhead explaining the day's direction, driver, or important contrast. Ground both in the supplied research. For a morning edition, summarize the overnight market/setup rather than inventing a closing result.
- The headline and subhead must tell the reader what happened, not describe this document. Never use generic titles such as "The day in research", "Daily Briefing", or "Research Digest", and never introduce workflow notes about previews, source preparation, model calls, or how the text was produced. Do not restate the headline and subhead verbatim in the first body section.
- Write a briefing of the news and arguments, not an inventory of newsletters. Lead with the substantive takeaway; place short [Source](url) citations at the end of the sentence or paragraph they support.
- Never open with "XYZ appeared in", "was mentioned in", "was covered in", or "Only Source X covered". The publication is evidence, not the story.
- Give a company its own section only for concrete company-specific news, a differentiated thesis, a changed estimate, a catalyst, or a risk supported by the supplied text.
- Group companies sharing a supported sector or thematic story under a descriptive heading (for example, "Semiconductors: hardware leads"). Tell that story once. Include tickers only when the text actually connects them to it; bucket membership alone is not evidence of a sector move or catalyst.
- Prioritize substantive developments involving held/watchlisted companies, but do not require an individual section or even a mention for every ticker. Omit empty mentions and "no company-specific news" filler. Do not append a ticker roster.
- Use short paragraphs, usually 2-4 sentences, with no minimum word count per company. Omit an empty Also covered section. Preserve meaningful disagreements between sources, with each view attributed.
- Never manufacture a company implication or market explanation to fill space. When a cause is unknown, omit the causal claim; do not substitute "the broad market" as an unsupported explanation.
- Preserve named originators of relayed opinions; attribution matters when explaining whose view it is, not as a repetitive introduction to every sentence.
- Copy citation URLs EXACTLY from the supplied source entries. Use inline Markdown links, never reconstructed URL slugs, reference-style links, HTML links, or invented links. If no URL was supplied, use plain source text.`;

/** Keep supplied links byte-for-byte; an invented/altered link is never clickable. */
export function retainSuppliedSourceLinks(
  markdown: string,
  articles: ReadonlyArray<{ source_url: string | null; website_url: string | null }>,
): string {
  const allowed = new Set(articles.flatMap(a => [a.source_url, a.website_url]).filter(Boolean));
  return markdown.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (link, label: string, url: string) =>
    allowed.has(url) ? link : `${label} (source link unavailable)`,
  );
}

/** Separate a model-written market opening so delivery chrome cannot precede it.
 * Missing/malformed openings retain the existing fallback layout. */
export function splitDigestOpening(markdown: string): { opening: string; body: string } | null {
  const match = markdown.trimStart().match(/^(# [^\n]+)\n+([^#\n][^\n]*(?:\n(?!\n|#)[^\n]+)*)\n+(?=## )/);
  if (!match) return null;
  return { opening: `${match[1]}\n\n${match[2].trim()}`, body: markdown.trimStart().slice(match[0].length) };
}
