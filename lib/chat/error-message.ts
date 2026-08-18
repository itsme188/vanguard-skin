/**
 * Human-readable rendering of a failed chat send.
 *
 * The AI SDK's HttpChatTransport throws with the raw response BODY as
 * `error.message` (`throw new Error(await response.text())`), so whatever the
 * server wrote lands verbatim in the chat thread. With the #35 trust boundary
 * in front of /api/chat that body is the deny envelope
 * `{"success":false,"error":"unauthorized"}` — JSON rendered where the
 * assistant's answer belongs (QA chat--send-401-csrf-token-never-attached-
 * raw-envelope-rendered).
 *
 * Display-only: unwraps our `{success:false,error}` envelope and translates
 * the one deny reason a user can actually act on. Anything else passes
 * through unchanged so a real backend message is never swallowed.
 */

const GENERIC = "The chat request failed. Try again.";

const SESSION_EXPIRED =
  "Your session expired — reload the page to sign in again, then resend.";

export function humanizeChatError(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return GENERIC;

  let envelopeError: string | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      envelopeError = ((parsed as { error: string }).error).trim();
    }
  } catch {
    // Not JSON — a plain message (network failure, SDK text). Pass through.
  }

  if (envelopeError === null) return text;
  if (envelopeError.toLowerCase() === "unauthorized") return SESSION_EXPIRED;
  return envelopeError || GENERIC;
}
