/**
 * Pre-Claude email filter for Substack admin mail.
 *
 * Tier 5 D2: matches a small set of high-confidence noise patterns BEFORE the
 * fetched article reaches AI processing. Catches Substack onboarding /
 * billing / gift-subscription notifications that share the same sender
 * domain as legitimate research content (so a coarser sender-level filter
 * wouldn't work — we have to look at the subject line).
 *
 * Calibrated against 14 real noise rows in the production DB as of
 * 2026-05-11. The patterns are deliberately narrow — false-positives here
 * silently drop a real article (mitigation: the deferred D5 audit UI will
 * surface excluded rows so the user can flip them back).
 *
 * Returned `category` values:
 *   "receipt"  — Substack / Stripe / payment platform billing confirmation
 *   "welcome"  — first-touch onboarding from a publication
 *   "gift"     — third-party gifted-subscription notification
 *   "admin"    — password resets, unsubscribe confirmations, etc.
 */

export interface ShortCircuitMatch {
  excluded: true;
  category: "receipt" | "welcome" | "gift" | "admin";
  reason: string;
}

export interface ShortCircuitPass {
  excluded: false;
}

export type ShortCircuitResult = ShortCircuitMatch | ShortCircuitPass;

/** Trim leading "** " (Substack emphasis prefix) + collapse whitespace. */
function normalizeSubject(subject: string): string {
  return subject.replace(/^\*\*\s*/, "").trim();
}

/**
 * Pure check — exported for tests. Subject-only inspection; body is not
 * inspected because Substack receipts have legitimate-looking body content
 * (transaction details, amounts), and we want to keep the match deliberately
 * narrow.
 */
export function checkShortCircuit(subject: string): ShortCircuitResult {
  const s = normalizeSubject(subject);
  const lower = s.toLowerCase();

  // Substack payment receipt — both the "** Payment Receipt" and "Your payment
  // receipt from X #invoice-id" shapes. "payment receipt" is rare enough in
  // research content that a substring match is safe.
  if (lower.includes("payment receipt")) {
    return { excluded: true, category: "receipt", reason: `payment receipt: "${s.slice(0, 60)}"` };
  }

  // Substack welcome / onboarding — anchored to start-of-subject to avoid
  // matching legitimate content like "Welcome to the AI-bubble era".
  if (/^welcome to /i.test(s)) {
    return { excluded: true, category: "welcome", reason: `welcome: "${s.slice(0, 60)}"` };
  }

  // Gift subscriptions from another reader. "gifted you a subscription" /
  // "would like to give you a subscription" — both specific to the
  // Substack gift flow.
  if (lower.includes("gifted you a subscription") || lower.includes("would like to give you a subscription")) {
    return { excluded: true, category: "gift", reason: `gift subscription: "${s.slice(0, 60)}"` };
  }

  // Generic admin mail — kept narrow. Password resets and unsubscribe
  // confirmations are universal patterns that never carry portfolio content.
  if (/^(password reset|unsubscribe confirm|verify your account|email verification)/i.test(s)) {
    return { excluded: true, category: "admin", reason: `admin: "${s.slice(0, 60)}"` };
  }

  return { excluded: false };
}
