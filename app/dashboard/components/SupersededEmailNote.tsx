"use client";

import type { SentEarningsEmail } from "@/lib/queries/earnings-emails";
import { Chip } from "./Chip";

/**
 * An earnings email sent for a calendar entry that a later reconcile replaced
 * (owner ruling 2026-10-06). The email stays in the archive; these two pieces
 * say that it is not the print's email and offer the one that is. One
 * implementation for both lists that show sent emails: the Alerts "Emails"
 * view and the Security Detail section.
 *
 * Symbols and dates are public market data, so nothing here needs a privacy
 * component.
 */

/** Which email the viewer should open. */
export type EmailViewTarget = Pick<SentEarningsEmail, "event_id" | "phase">;

/** The chip inside the row. Renders nothing for an ordinary email. */
export function SupersededEmailChip({ email }: { email: SentEarningsEmail }) {
  if (email.event_superseded !== 1) return null;
  return (
    <Chip tone="warn" size="xs">
      entry replaced
    </Chip>
  );
}

/**
 * The line under the row: always-visible words, never a hover-only hint, and
 * a SIBLING of the row button (a button inside a button is invalid markup).
 * Renders nothing for an ordinary email.
 */
export function SupersededEmailNote({
  email,
  onOpen,
  formatSentAt,
  className = "",
}: {
  email: SentEarningsEmail;
  onOpen: (target: EmailViewTarget) => void;
  formatSentAt: (sentAt: string) => string;
  className?: string;
}) {
  if (email.event_superseded !== 1) return null;
  const live = email.replacement;
  return (
    <p className={`text-[11px] text-ink-dim ${className}`}>
      The calendar entry this {email.phase} was sent for was later replaced.{" "}
      {live == null ? (
        <>No current entry for this report was found.</>
      ) : live.email_sent_at == null ? (
        <>
          The current entry reports {live.event_date}; no {email.phase} was sent for it.
        </>
      ) : (
        <button
          type="button"
          onClick={() => onOpen({ event_id: live.event_id, phase: email.phase })}
          className="underline underline-offset-2 text-ink hover:text-gold-ink transition-colors"
        >
          Open the {email.phase} for the current entry (reports {live.event_date}, sent{" "}
          {formatSentAt(live.email_sent_at)})
        </button>
      )}
    </p>
  );
}
