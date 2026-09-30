/**
 * Legacy internal marker once stored in research_article_securities.mention_context
 * for cloud-fetched articles. It is not newsletter text; never render it as an excerpt.
 */
export const MENTION_CONTEXT_PLACEHOLDER = "cloud-fetched mention";

/** The excerpt to show for a mention, or null when there is nothing real to quote. */
export function displayableMentionContext(ctx: string | null | undefined): string | null {
  if (ctx == null) return null;
  const t = ctx.trim();
  if (t === "" || t === MENTION_CONTEXT_PLACEHOLDER) return null;
  return t;
}
