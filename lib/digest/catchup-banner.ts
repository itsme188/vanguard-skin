/**
 * What the digest catch-up banner should show. Pure and client-safe (no
 * database import) so the component and its tests share one rule.
 *
 * Order matters:
 *   1. before the scheduled time: nothing is late yet;
 *   2. a cloud attempt in flight: informational, no Send button;
 *   3. a confirmed cloud send, or a local send at or after the scheduled
 *      time: the digest went out;
 *   4. the scheduled run looked today and found nothing new: explain it,
 *      and offer no Send button (a send would skip for the same reason);
 *   5. otherwise the digest was missed.
 */
export type DigestBannerState = "hidden" | "cloud-sending" | "skipped-empty" | "not-sent";

export interface DigestBannerInput {
  now: Date;
  /** Today's scheduled send time. */
  scheduled: Date;
  /** Eastern calendar date, YYYY-MM-DD. */
  today: string;
  lastDigestSentAt: string | null;
  /** True when the status route reported a cloud marker for today. */
  cloudPresent: boolean;
  cloudVia: string | null;
  lastDigestSkip: { reason: string; date: string; at: string } | null;
}

export function decideDigestBanner(input: DigestBannerInput): DigestBannerState {
  const { now, scheduled } = input;
  if (now < scheduled) return "hidden";

  if (input.cloudPresent && input.cloudVia === "attempting") return "cloud-sending";
  if (input.cloudPresent && (input.cloudVia === "sent" || !input.cloudVia)) return "hidden";

  if (input.lastDigestSentAt) {
    const lastSent = new Date(input.lastDigestSentAt);
    // "Sent today" = sent at or after the scheduled trigger today. Tolerates
    // a late-night manual catch-up that landed before today's trigger.
    if (!(lastSent < scheduled)) return "hidden";
  }

  const skip = input.lastDigestSkip;
  if (skip && skip.date === input.today) {
    const skippedAt = new Date(skip.at).getTime();
    // A skip from before the scheduled time is an earlier hand-run send, not
    // the scheduled digest; it says nothing about whether the schedule ran.
    if (Number.isFinite(skippedAt) && skippedAt >= scheduled.getTime()) return "skipped-empty";
  }

  return "not-sent";
}
