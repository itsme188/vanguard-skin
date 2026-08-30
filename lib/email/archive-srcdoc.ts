/**
 * Safe framing of ARCHIVED email HTML (earnings emails, morning digest).
 *
 * Pure — no DOM, no DB. Shared by every modal that srcDoc's a stored email
 * into a sandboxed iframe.
 *
 * ## Why
 *
 * Deep-QA finding
 * `qa:earnings-email-viewer--source-link-navigates-sandboxed-iframe-to-third-party`:
 * source links in an archived email body (`<a href="https://www.investing.com/…">`)
 * carry no `target`, and a sandbox that grants neither `allow-popups` nor
 * `allow-top-navigation` cannot open a new context — so the click navigated
 * the IFRAME ITSELF. The modal body turned into a live third-party web page
 * sitting under the "Sent Jul 27" header: an outbound request to a third
 * party from inside the dashboard, dozens of "Blocked script execution"
 * console errors, and no way back except ✕.
 *
 * Nothing about the *sandbox* controls that. Navigating your own browsing
 * context is always allowed; `allow-top-navigation` only governs escaping to
 * the TOP frame. The only lever is the link's target — so we set the
 * document's default target instead of the sandbox.
 *
 * ## The fix
 *
 * A `<base target="_blank">` as the first child of `<head>`, plus a sandbox
 * that permits the resulting popup. Same shape NewsletterArticleFrame
 * already uses for the research reader; this module generalises it to
 * archived emails, which arrive as COMPLETE documents (briefingToHtml emits
 * `<!DOCTYPE html><html><head>…`) rather than fragments we compose a head
 * for.
 *
 * Chosen over rewriting every `<a>` tag: `<base target="_blank">` covers
 * every navigation-initiating element — including ones a future email
 * template introduces — without touching the body at all. It also leaves
 * `mailto:` links and href-less anchors byte-for-byte untouched.
 *
 * The one thing `<base target>` can't do on its own is override a target an
 * element already declares for ITSELF (`<a target="_self">`, and a `<base>`
 * the email already carries with its own target) — per the HTML spec a
 * per-element target always wins over the document default. Both of those
 * are foreign markup an incoming email can plant, and both reproduce the
 * same in-frame-navigation defect this module exists to close. So this
 * module also does a narrow, regex-based rewrite of exactly those hostile
 * `target` values (`_self`/`_parent`/`_top`, on `<base>`/`<a>`/`<area>`/
 * `<form>`) to `_blank` before applying the `<base>` fix above — still no
 * HTML parsing, and every other attribute and every non-hostile target
 * (`_blank`, a named target) is copied through untouched.
 *
 * Reverse-tabnabbing (`window.opener`) is not a gap here: every browser this
 * app runs in applies implicit `rel=noopener` to `target="_blank"`, and in
 * the packaged app Electron's `setWindowOpenHandler` denies window creation
 * outright and hands the URL to the system browser.
 */

/** The tag injected into the framed document's head. */
const BASE_TARGET_TAG = '<base target="_blank">';

/** A `<base>` that already declares a default target (an href-only base does not). */
const BASE_WITH_TARGET = /<base\b[^>]*\btarget\s*=/i;

const HEAD_OPEN = /<head\b[^>]*>/i;
const HEAD_CLOSE = /<\/head\s*>/i;
const HTML_OPEN = /<html\b[^>]*>/i;

/**
 * A `target` attribute value (quoted either way, or bare) that resolves to a
 * frame ancestor of the document itself. Exact match only — never a
 * substring, so `_topmost` or `myself` are left alone.
 */
const HOSTILE_TARGET_VALUE = /^(?:_self|_parent|_top)$/i;

/** `<base>`, `<a>`, `<area>`, `<form>` opening tags — the elements HTML gives a `target` attribute. */
const TARGETABLE_TAG_OPEN = /<(base|a|area|form)\b[^>]*>/gi;

/** A `target` attribute in any of the three legal syntaxes: `="x"`, `='x'`, `=x`. */
const TARGET_ATTR = /target\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Force a single tag's `target` attribute (if any) to `_blank`.
 *
 * `always` rewrites whatever value is present (used for `<base>`: any
 * default target other than `_blank` lets the framed document navigate
 * itself). Otherwise only a hostile value (`_self`/`_parent`/`_top`) is
 * rewritten — an anchor's own `_blank` or a named target is left untouched,
 * matching the project rule that this module never touches real popup
 * targets.
 */
function forceTargetBlank(tag: string, always: boolean): string {
  return tag.replace(TARGET_ATTR, (full, dq: string, sq: string, uq: string) => {
    const value = dq ?? sq ?? uq ?? "";
    if (always || HOSTILE_TARGET_VALUE.test(value)) {
      return 'target="_blank"';
    }
    return full;
  });
}

/**
 * Neutralise every existing `target` that would otherwise let the framed
 * document navigate ITSELF instead of opening a new context:
 *
 * - A `<base target>` already present is rewritten to `_blank` (any prior
 *   value) rather than left alone — a stray `<base target="_self">`, or any
 *   non-`_blank` value, was previously returned byte-for-byte unchanged.
 * - An `<a>`/`<area>`/`<form>` with its OWN `target="_self"|"_parent"|"_top"`
 *   is rewritten too: a per-element target always overrides `<base target>`
 *   per the HTML spec, so leaving those alone reproduced the same in-frame
 *   navigation even after `<base target="_blank">` was injected.
 *
 * Regex-based and conservative, like the rest of this module: only the
 * `target` attribute's value is touched, everything else in the tag is
 * copied through verbatim.
 */
function neutralizeHostileTargets(html: string): string {
  return html.replace(TARGETABLE_TAG_OPEN, (tag, tagName: string) =>
    forceTargetBlank(tag, tagName.toLowerCase() === "base"),
  );
}

/**
 * Sandbox for an archived-email iframe.
 *
 * - `allow-popups` + `allow-popups-to-escape-sandbox` — a `_blank` link opens a
 *   REAL new tab. Without the escape flag the popup would inherit the sandbox
 *   (unique origin, no scripts) and the linked site would render broken.
 *
 * Deliberately absent: `allow-same-origin` — neither viewer that uses this
 * sandbox reads `contentDocument` (EarningsEmailViewer and DigestEmailViewer
 * both use a fixed `75dvh`/`75vh` frame height; only NewsletterArticleFrame
 * measures the document to autosize, and it carries its own separate sandbox
 * literal for exactly that reason). Also absent: `allow-scripts` (project
 * invariant — email HTML is foreign markup), `allow-top-navigation*`,
 * `allow-forms`, `allow-modals`.
 */
export const EMAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/** Text of the document's head, or "" when there is no head element. */
function headRegion(html: string, openMatch: RegExpExecArray): string {
  const close = HEAD_CLOSE.exec(html);
  const start = openMatch.index + openMatch[0].length;
  return close && close.index > start ? html.slice(start, close.index) : html.slice(start);
}

/**
 * Make every link in `html` open OUTSIDE the frame, by giving the document a
 * default `_blank` target — and neutralising any explicit target (on
 * `<base>`, or on an individual `<a>`/`<area>`/`<form>`) that would
 * otherwise override that default and navigate the frame itself.
 *
 * Idempotent. When the document already declares its own `<base target>` in
 * the head, that target's value is rewritten to `_blank` in place rather
 * than a new `<base>` being inserted — a `<base>` planted in the email BODY
 * does not count: ours (or the rewritten one) is in the head, which is
 * earlier in tree order, and the first `<base target>` in tree order is the
 * one that wins.
 */
export function withExternalLinkTarget(html: string): string {
  if (!html) return html;

  const out = neutralizeHostileTargets(html);

  // Complete document with a head — the normal case (briefingToHtml output).
  const head = HEAD_OPEN.exec(out);
  if (head) {
    if (BASE_WITH_TARGET.test(headRegion(out, head))) return out;
    const at = head.index + head[0].length;
    return out.slice(0, at) + BASE_TARGET_TAG + out.slice(at);
  }

  // <html> but no <head> — the parser would synthesise one; do it explicitly
  // so the base lands above the body content.
  const htmlOpen = HTML_OPEN.exec(out);
  if (htmlOpen) {
    if (BASE_WITH_TARGET.test(out)) return out;
    const at = htmlOpen.index + htmlOpen[0].length;
    return out.slice(0, at) + `<head>${BASE_TARGET_TAG}</head>` + out.slice(at);
  }

  // Bare fragment. Per the HTML spec the default target comes from the first
  // `<base>` with a target attribute in tree order, wherever it sits.
  if (BASE_WITH_TARGET.test(out)) return out;
  return BASE_TARGET_TAG + out;
}
