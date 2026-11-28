/**
 * Owner-facing refusal text for a send with no recipient address.
 * Import-free on purpose: the senders in lib/digest and lib/earnings share it.
 * No env-var or parameter name belongs here; the text reaches a toast.
 */
export type NoRecipientKind = "earnings" | "briefing" | "evening" | "digest";

const NOUN: Record<NoRecipientKind, string> = {
  earnings: "earnings emails",
  briefing: "the briefing email",
  evening: "the evening email",
  digest: "the digest email",
};

export function noRecipientMessage(kind: NoRecipientKind): string {
  return `No recipient address is set for ${NOUN[kind]}, so nothing was sent.`;
}
