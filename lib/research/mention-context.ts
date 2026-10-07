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

/**
 * An opaque run inside an excerpt: a tracking-pixel / redirect id that the
 * plain-text extraction of an email leaves in front of the prose, e.g.
 * "qA4...7FM ] Lots to get to". 28+ characters of the base64url alphabet with
 * an upper-case letter, a lower-case letter AND a digit is never an English
 * word or a ticker; the bracket debris right after it goes with it.
 */
const OPAQUE_TOKEN_RE = /[A-Za-z0-9_-]{28,}(?:\s*[\])]+)?/g;

function isOpaqueToken(run: string): boolean {
  const core = run.replace(/[\s\])]+$/, "");
  return /[a-z]/.test(core) && /[A-Z]/.test(core) && /\d/.test(core);
}

/** Remove tracking tokens from an excerpt; prose is left exactly as stored. */
export function stripOpaqueTokens(text: string): string {
  return text
    .replace(OPAQUE_TOKEN_RE, (run) => (isOpaqueToken(run) ? " " : run))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The excerpt to show for a mention, or null when there is nothing real to quote. */
export function displayableMentionContext(ctx: string | null | undefined): string | null {
  if (ctx == null) return null;
  const t = ctx.trim();
  if (t === "" || t === MENTION_CONTEXT_PLACEHOLDER) return null;
  if (t.startsWith(SUBJECT_BACKSTOP_CONTEXT_PREFIX)) return null;
  const cleaned = stripOpaqueTokens(t);
  return cleaned === "" ? null : cleaned;
}

/**
 * A mention_context is a false-positive URL-fragment when the extractor
 * matched the ticker inside anchor-text / asset paths (e.g.
 * "net/assets/images/resources//section1."). Dropping these surfaces only
 * the mentions that actually refer to the company.
 */
export function isUrlFragmentContext(ctx: string | null): boolean {
  if (!ctx) return false;
  const t = ctx.trim();
  if (/:\/\/|\/assets\/|<img|\.(png|jpg|jpeg|gif|css|svg|woff)/i.test(t)) return true;
  if (!/\s/.test(t) && /[/_]/.test(t)) return true;
  return false;
}

/**
 * True when the ticker appears only as a substring of a larger word in
 * the mention context / subject (e.g. "HOOD" inside "likelihood",
 * "NET" inside "internet").
 */
export function lacksWordBoundaryMatch(
  ticker: string,
  ctx: string | null,
  subject: string,
): boolean {
  if (!ctx) return false;
  const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  if (re.test(ctx)) return false;
  if (re.test(subject)) return false;
  return true;
}

/**
 * The mentions worth showing on a security hub. Both noise tests judge the
 * excerpt a reader would actually see: a legacy placeholder or a diagnostic
 * string is "no excerpt" (kept, title only) exactly like a NULL one — it is
 * not newsletter text, so it cannot fail a does-it-name-the-ticker test.
 */
export function filterHubMentions<T extends { mention_context: string | null; subject: string }>(
  ticker: string,
  mentions: T[],
): T[] {
  return mentions.filter((m) => {
    const excerpt = displayableMentionContext(m.mention_context);
    if (isUrlFragmentContext(excerpt)) return false;
    if (lacksWordBoundaryMatch(ticker, excerpt, m.subject)) return false;
    return true;
  });
}

/**
 * Section heading for the hub's mention list. `loaded` is how many rows the
 * page fetched (a small LIMIT, not the population), so it is never printed as
 * a total: the "· N" count appears only when the caller supplies the true
 * number of mentions on file.
 */
export function mentionsHeading(
  shown: number,
  total: number | null | undefined,
): { title: string; subtitle: string } {
  const known = typeof total === "number" && Number.isFinite(total) && total >= shown;
  if (!known) return { title: "Research Mentions", subtitle: `Latest ${shown}` };
  return {
    title: `Research Mentions · ${total}`,
    subtitle: shown < total ? `Showing ${shown} of ${total}` : `All ${total}`,
  };
}
