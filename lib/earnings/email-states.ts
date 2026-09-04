/**
 * The five values `earnings_emails.error` can hold — the SINGLE source of
 * truth for what each one means (live print v2 slice E, migration 092;
 * contract docs/superpowers/plans/2026-09-04-live-print-v2-outputs-contract.md §1).
 *
 * | value                | meaning                                          | live claim? | blocks an automatic resend? |
 * |----------------------|--------------------------------------------------|-------------|------------------------------|
 * | NULL                 | sent locally, provider accepted, row committed    | no          | yes                          |
 * | 'in_progress'        | claimed; composing                                | yes         | no                           |
 * | 'sending'            | provider call in flight                           | yes         | no                           |
 * | 'sent-by-cloud'      | the Worker fallback delivered it                  | no          | yes                          |
 * | 'delivery_unknown'   | terminal; the provider's answer was never learned | no          | yes (manual reconcile only)  |
 * | any other string     | legacy failure text                               | no          | yes                          |
 *
 * `error` is NOT a failure flag. Never write `error IS NOT NULL` to mean
 * "this send failed" — three of the five values are perfectly healthy.
 *
 * TWO DELIVERED QUESTIONS, deliberately kept apart. `isDelivered` answers
 * "should a chip say sent?" and admits legacy failure text, because a
 * persistent non-sentinel row means a send that the sweep never released —
 * that is the mapping `getEmailStatesForEvents` has always used.
 * `isDeliveredStrict` (and its SQL twin `deliveredSql`) answers "did an email
 * definitely go out?" and admits only NULL and the two delivered sentinels —
 * that is the rule `lib/earnings/wrap.ts`, `lib/earnings/debrief.ts` and
 * `lib/earnings/event-merge.ts` have always used. Do not merge them.
 *
 * THIS MODULE HAS NO IMPORTS, on purpose: the Mac's queries, the mutations,
 * the send service and (after slice F) a browser-bundled chip all need it, so
 * it must never drag a server dependency across a boundary.
 * `tests/repo/no-handrolled-email-states.test.ts` fails on any of these string
 * literals appearing anywhere else under `lib/**` or `app/**`.
 */

export const IN_PROGRESS = "in_progress";
export const SENDING = "sending";
export const SENT_BY_CLOUD = "sent-by-cloud";
export const DELIVERY_UNKNOWN = "delivery_unknown";

/** A row a live process owns. Never delivered; never taken over by a claim
 *  (`sending` is the reaper's alone — a message may be on the wire). */
export const LIVE_CLAIM_STATES = [IN_PROGRESS, SENDING] as const;

/** Terminal values that mean "an email exists for this (event, phase)". */
export const DELIVERED_SENTINELS = [SENT_BY_CLOUD, DELIVERY_UNKNOWN] as const;

export type DeliveryStateWord = "sent" | "sent-by-cloud" | "in-flight" | "delivery-unknown";

export function isLiveClaim(error: string | null): boolean {
  return error !== null && (LIVE_CLAIM_STATES as readonly string[]).includes(error);
}

export function isDelivered(error: string | null): boolean {
  return !isLiveClaim(error);
}

export function isDeliveredStrict(error: string | null): boolean {
  return error === null || (DELIVERED_SENTINELS as readonly string[]).includes(error);
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(",");
}

/** `(<col> IS NULL OR <col> NOT IN ('in_progress','sending'))` */
export function notLiveClaimSql(col: string): string {
  return `(${col} IS NULL OR ${col} NOT IN (${quoteList(LIVE_CLAIM_STATES)}))`;
}

/** `(<col> IS NULL OR <col> IN ('sent-by-cloud','delivery_unknown'))` */
export function deliveredSql(col: string): string {
  return `(${col} IS NULL OR ${col} IN (${quoteList(DELIVERED_SENTINELS)}))`;
}

export function sendStateFor(error: string | null): DeliveryStateWord {
  if (isLiveClaim(error)) return "in-flight";
  if (error === SENT_BY_CLOUD) return "sent-by-cloud";
  if (error === DELIVERY_UNKNOWN) return "delivery-unknown";
  return "sent";
}

export function sentByFor(error: string | null): "local" | "cloud" {
  return error === SENT_BY_CLOUD ? "cloud" : "local";
}
