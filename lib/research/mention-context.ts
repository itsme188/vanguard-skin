/**
 * Legacy internal marker once stored in research_article_securities.mention_context
 * for cloud-fetched articles. It is not newsletter text; never render it as an excerpt.
 */
export const MENTION_CONTEXT_PLACEHOLDER = "cloud-fetched mention";

/**
 * Diagnostic prefix written when a held ticker was linked only because the
 * subject line named it (reconcile-cloud-fetched.ts). It records WHY the link
 * exists; it is not a sentence from the newsletter, so it never renders as one.
 */
export const SUBJECT_BACKSTOP_CONTEXT_PREFIX = "Subject-line backstop match:";

/** The excerpt to show for a mention, or null when there is nothing real to quote. */
export function displayableMentionContext(ctx: string | null | undefined): string | null {
  if (ctx == null) return null;
  const t = ctx.trim();
  if (t === "" || t === MENTION_CONTEXT_PLACEHOLDER) return null;
  if (t.startsWith(SUBJECT_BACKSTOP_CONTEXT_PREFIX)) return null;
  return t;
}
