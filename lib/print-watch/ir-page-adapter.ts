/**
 * Stored per-company IR page (spec §4.2 "Stored IR page", slice B Task 12).
 *
 * The adapter READS the newsroom page the user stored for a symbol and hands
 * back candidate links; the CALLER fetches and ingests them and marks them
 * seen — caller-owns-seen, exactly as every v1 adapter works, so a link is
 * only ever "seen" once a durable row exists for it.
 *
 * Two filters, deliberately different in kind:
 *   - the earnings-headline pattern is a CODE CONSTANT (below). The desk
 *     never types a regex; a bad one would either swallow the print or drag
 *     every "Acme Names New CFO" post into the parser at 16:05.
 *   - `link_must_contain` is the user's own narrowing, applied as a LITERAL
 *     substring on the anchor text OR the href. Literal, never compiled: a
 *     stored "Q2 (2026)" must mean those characters, and a stray ".*" must
 *     match nothing rather than everything.
 *
 * M17 (fixed-host policy): a page can link anywhere, so `isAllowedIrLinkHost`
 * confines what we will FOLLOW to the IR host itself plus the four wire hosts
 * a company actually posts a release on. The caller passes the same predicate
 * to `hardenedFetchBytes` as `allowHost`, so the rule survives every redirect
 * hop too — a 302 off the allowlist is refused, not followed.
 */
import type { hardenedFetchBytes } from "./url-fetch";
import { decodeEntities } from "./representations";

export interface IrPageConfig {
  symbol: string;
  irPageUrl: string;
  linkMustContain: string | null;
}

/**
 * A period word AND results/earnings, in either order.
 *
 * Written as two lookaheads rather than an alternation so the two conditions
 * are independent of word order ("Q2 2026 Results" and "Results for the
 * Second Quarter" both pass) while still requiring BOTH — "…Second Quarter
 * Conference Call" and "…Names New CFO" fail, which is the whole point.
 *
 * ANCHORED at `^` (with no `m` flag) so a non-matching title is scanned ONCE.
 * Unanchored, a zero-width lookahead pair retries at every character, and each
 * retry re-scans the rest of the string — quadratic in the title length on a
 * page we do not control. The anchor costs nothing: the lookaheads already
 * scan the whole string from wherever they start.
 *
 * NO `g`/`y` flag: this is a shared module-level constant, and a sticky
 * `lastIndex` would make every other `.test()` on it lie.
 */
export const IR_PAGE_HEADLINE_RE =
  /^(?=[\s\S]*\b(quarter|fiscal|full[- ]year|q[1-4]|fy\s?\d{2,4})\b)(?=[\s\S]*\b(results|earnings)\b)/i;

/** An anchor whose visible text runs longer than this is a teaser blob or a
 *  nav dump, never a press-release headline — skipped before any matching. */
export const IR_PAGE_MAX_TITLE_CHARS = 2000;

/** The only OFF-IR-host hosts a release link may be followed to (M17). */
export const IR_PAGE_WIRE_HOSTS = [
  "businesswire.com",
  "globenewswire.com",
  "prnewswire.com",
  "sec.gov",
] as const;

export interface IrPageLink {
  link: string;
  title: string;
}

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Anchors on `html` that look like an earnings release, absolute-ized against
 * `baseUrl` (which must be the url the page was actually SERVED from — a
 * redirected newsroom resolves its relative links against the new path, not
 * the stored one) and de-duplicated by resolved URL.
 */
export function extractIrPageLinks(html: string, baseUrl: string, cfg: IrPageConfig): IrPageLink[] {
  const out: IrPageLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = m[1].trim();
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length > IR_PAGE_MAX_TITLE_CHARS) continue;
    // Literal substring, on the visible text OR the href — a company that
    // titles every release identically is still separable by URL path.
    if (cfg.linkMustContain && !title.includes(cfg.linkMustContain) && !href.includes(cfg.linkMustContain)) {
      continue;
    }
    if (!IR_PAGE_HEADLINE_RE.test(title)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      // A junk href ("http://[bad") is skipped, never thrown: one broken
      // anchor must not blind the whole poll.
      continue;
    }
    // `new URL` resolves `javascript:`/`mailto:`/`http:` hrefs perfectly
    // happily. The SSRF contract refuses every one of them at fetch time, so
    // returning them would only spend the caller's refusal budget on links
    // that can never be followed.
    if (resolved.protocol !== "https:") continue;
    const link = resolved.toString();
    if (seen.has(link)) continue;
    seen.add(link);
    out.push({ link, title });
  }
  return out;
}

/**
 * M17. True only for the IR host itself (exact match) and the four wire hosts
 * (exact, or any subdomain of them). `businesswire.com.evil.example` is NOT a
 * wire host — the check is a dot-anchored suffix, never a bare `includes`.
 */
export function isAllowedIrLinkHost(link: string, irHost: string): boolean {
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === irHost.trim().toLowerCase()) return true;
  return IR_PAGE_WIRE_HOSTS.some((wire) => host === wire || host.endsWith(`.${wire}`));
}

/**
 * Fetch the stored IR page once and report what is on it.
 *
 * `baseline: true`  — arm time: every allowed matching link is marked seen and
 *                     NOTHING is returned (they are last quarter's, by
 *                     definition of "before the window").
 * `baseline: false` — window time: allowed matching links the caller has not
 *                     seen are RETURNED UNMARKED. The caller marks each one
 *                     seen only after a durable outcome, so a link whose fetch
 *                     was refused is retried on the next poll instead of being
 *                     silently dropped.
 *
 * `fetchBytes` is the seam; the caller supplies the `allowHost` predicate by
 * wrapping it, so the page fetch and every link fetch share one policy.
 */
export async function pollIrPage(
  cfg: IrPageConfig,
  seen: Set<string>,
  fetchBytes: typeof hardenedFetchBytes,
  opts: { baseline: boolean },
): Promise<IrPageLink[]> {
  const page = await fetchBytes(cfg.irPageUrl, { label: "IR page" });
  const irHost = new URL(cfg.irPageUrl).hostname;
  const results: IrPageLink[] = [];
  for (const item of extractIrPageLinks(page.bytes.toString("utf8"), page.finalUrl, cfg)) {
    if (!isAllowedIrLinkHost(item.link, irHost)) continue;
    if (seen.has(item.link)) continue;
    if (opts.baseline) {
      seen.add(item.link);
      continue;
    }
    results.push(item);
  }
  return results;
}
