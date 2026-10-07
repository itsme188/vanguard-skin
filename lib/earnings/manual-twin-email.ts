// Mac source of the "two hand-entered rows, one email" rule. The Worker
// carries a hand copy at workers/cron/src/manual-twin-email.ts that must stay
// byte-identical below this header (it cannot cross the Next.js path-alias
// boundary); workers/cron/test/manual-twin-email-parity.test.ts pins it.
// Change both files together.

/**
 * With two hand-entered earnings rows for one company, which one gets email?
 *
 * The reconciler keeps BOTH rows visible when a company has two hand-entered
 * earnings dates (owner ruling 2026-10-06: choosing between two dates the
 * user typed is the user's call). Every email finder used to rely on "one
 * live row per print", so two live rows meant two previews and a second
 * recap. Owner ruling 2026-10-07: THE EARLIER DATE COUNTS for email. The
 * later row is ignored by every email finder and marked as such in the Hub
 * until the user deletes one of the two.
 *
 * Scope: live (not superseded) earnings rows with `source = 'manual'` only.
 * A vendor row is never ignored by this rule and never makes a hand-entered
 * row ignored.
 */

/**
 * Two hand-entered rows of one issuer family this many days apart or closer
 * are the same reporting event entered twice. Same span as the reconciler's
 * CLUSTER_PROXIMITY_DAYS (lib/calendar/reconcile-earnings-dates.ts), which is
 * what leaves the two rows live side by side in the first place. Rows further
 * apart are different quarters and each gets its own email.
 */
export const MANUAL_TWIN_EMAIL_WINDOW_DAYS = 14;

/** The fields the rule reads; every calendar row shape has them. */
export interface ManualTwinRow {
  id: number;
  symbol?: string | null;
  event_date: string;
  source: string;
  event_type?: string | null;
  superseded?: unknown;
}

/** Where email goes instead, for a row the rule ignores. */
export interface EmailFollowsEarlierRow {
  emailRowId: number;
  emailRowDate: string;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(date + "T00:00:00Z") / 86_400_000);
}

/**
 * Returns the rows email IGNORES, keyed by row id, each with the earlier row
 * email follows instead. A row absent from the map is unaffected.
 *
 * Per issuer family, the live hand-entered rows are ordered by date (a tie
 * is broken by the lower id) and chained: a row within the window of the row
 * before it joins that row's group. The first row of a group is the email
 * row; every other row of the group is ignored.
 *
 * `siblingsOf` is the issuer-family lookup (`issuerSiblings`), passed in so
 * this file imports nothing and stays identical on the Mac and the Worker.
 */
export function emailIgnoredManualTwins(
  rows: readonly ManualTwinRow[],
  siblingsOf: (symbol: string) => readonly string[],
): Map<number, EmailFollowsEarlierRow> {
  const byFamily = new Map<string, ManualTwinRow[]>();
  for (const r of rows) {
    if (r.source !== "manual") continue;
    if (r.superseded) continue;
    if (r.event_type != null && r.event_type !== "earnings") continue;
    if (!r.symbol) continue;
    const key = siblingsOf(r.symbol.toUpperCase())
      .map((s) => s.toUpperCase())
      .sort()
      .join(",");
    const list = byFamily.get(key);
    if (list) list.push(r);
    else byFamily.set(key, [r]);
  }

  const ignored = new Map<number, EmailFollowsEarlierRow>();
  for (const family of byFamily.values()) {
    if (family.length < 2) continue;
    const ordered = [...family].sort(
      (a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id,
    );
    let emailRow = ordered[0];
    let previous = ordered[0];
    for (const r of ordered.slice(1)) {
      if (dayNumber(r.event_date) - dayNumber(previous.event_date) <= MANUAL_TWIN_EMAIL_WINDOW_DAYS) {
        ignored.set(r.id, { emailRowId: emailRow.id, emailRowDate: emailRow.event_date });
      } else {
        emailRow = r;
      }
      previous = r;
    }
  }
  return ignored;
}
