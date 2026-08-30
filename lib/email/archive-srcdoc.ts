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
 * Chosen over rewriting every `<a>` tag: `<base>` needs no HTML parsing, so
 * it cannot mangle an email body, and it covers every navigation-initiating
 * element — including ones a future email template introduces. It also
 * leaves `mailto:` links and href-less anchors byte-for-byte untouched.
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
 * Sandbox for an archived-email iframe.
 *
 * - `allow-same-origin` — the parent reads `contentDocument` to size the frame.
 *   Harmless without `allow-scripts`: a script-less document has nothing to
 *   exercise the origin with.
 * - `allow-popups` + `allow-popups-to-escape-sandbox` — a `_blank` link opens a
 *   REAL new tab. Without the escape flag the popup would inherit the sandbox
 *   (unique origin, no scripts) and the linked site would render broken.
 *
 * Deliberately absent: `allow-scripts` (project invariant — email HTML is
 * foreign markup), `allow-top-navigation*`, `allow-forms`, `allow-modals`.
 */
export const EMAIL_FRAME_SANDBOX =
  "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** Text of the document's head, or "" when there is no head element. */
function headRegion(html: string, openMatch: RegExpExecArray): string {
  const close = HEAD_CLOSE.exec(html);
  const start = openMatch.index + openMatch[0].length;
  return close && close.index > start ? html.slice(start, close.index) : html.slice(start);
}

/**
 * Make every link in `html` open OUTSIDE the frame, by giving the document a
 * default `_blank` target.
 *
 * Idempotent, and a no-op when the document already declares its own
 * `<base target>` in the head. A `<base>` planted in the email BODY does not
 * count: ours goes in the head, which is earlier in tree order, and the first
 * `<base target>` in tree order is the one that wins.
 */
export function withExternalLinkTarget(html: string): string {
  if (!html) return html;

  // Complete document with a head — the normal case (briefingToHtml output).
  const head = HEAD_OPEN.exec(html);
  if (head) {
    if (BASE_WITH_TARGET.test(headRegion(html, head))) return html;
    const at = head.index + head[0].length;
    return html.slice(0, at) + BASE_TARGET_TAG + html.slice(at);
  }

  // <html> but no <head> — the parser would synthesise one; do it explicitly
  // so the base lands above the body content.
  const htmlOpen = HTML_OPEN.exec(html);
  if (htmlOpen) {
    if (BASE_WITH_TARGET.test(html)) return html;
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + `<head>${BASE_TARGET_TAG}</head>` + html.slice(at);
  }

  // Bare fragment. Per the HTML spec the default target comes from the first
  // `<base>` with a target attribute in tree order, wherever it sits.
  if (BASE_WITH_TARGET.test(html)) return html;
  return BASE_TARGET_TAG + html;
}
